import { PrismaClient, StripeMoneyOut } from "../../generated/prisma/client";
import type { MoneyOutBucket, MoneyOutCategory, MoneyOutRow } from "./moneyOutTaxonomy";
import type { MoneySegments } from "./segments";
import { RATES_SAMPLED_AT, usdMinorOf } from "./fx";

// Every read excludes retired rows, and this is the one place that says so.
//
// A retired row is one superseded by a better measurement of the same money —
// currently only the per-coupon discount ESTIMATES replaced by invoice-derived
// actuals. It is kept for the audit trail and must count towards nothing, so
// missing this filter on a single query silently doubles a concession total.
const LIVE = { retiredAt: null } as const;

// The frozen USD conversion for a row being written. Converted once, with the
// rate and the table revision stored alongside, so a later revision of fx.ts
// restates nothing that has already happened. A currency with no rate gets
// nulls and charts as absent rather than as zero.
function usdColumns(row: Pick<MoneyOutRow, "amountMinor" | "feeMinor" | "netMinor" | "currency">) {
  const amount = usdMinorOf(row.amountMinor, row.currency);
  if (!amount) return { usdMinor: null, feeUsdMinor: null, netUsdMinor: null, fxRate: null, fxRatesAt: null };
  return {
    usdMinor: amount.usdMinor,
    feeUsdMinor: usdMinorOf(row.feeMinor, row.currency)?.usdMinor ?? 0,
    netUsdMinor: usdMinorOf(row.netMinor, row.currency)?.usdMinor ?? amount.usdMinor,
    fxRate: amount.rate,
    fxRatesAt: RATES_SAMPLED_AT,
  };
}

// The segment axes flattened into their own columns. Kept as columns rather
// than a JSON blob so Postgres can group by them directly — the Discord and
// dashboard panels answer "refunds by plan" from here, without Influx.
function segmentColumns(segments: MoneySegments | null | undefined) {
  const s = segments ?? {};
  return {
    planTier: s.planTier ?? null,
    planPeriod: s.planPeriod ?? null,
    cardBrand: s.cardBrand ?? null,
    cardFunding: s.cardFunding ?? null,
    cardCountry: s.cardCountry ?? null,
    refundReason: s.refundReason ?? null,
    refundKind: s.refundKind ?? null,
    chargeAge: s.chargeAge ?? null,
    tenure: s.tenure ?? null,
    networkReason: s.networkReason ?? null,
    surface: s.surface ?? null,
  };
}

// Columns a later, better-informed pass may fill in but must never blank out —
// the same rule the customer id already follows. A sweep that ran out of its
// lookup budget writes nulls, and the webhook path that enriches properly comes
// along afterwards; letting the empty write win would undo the good one.
function definedSegmentColumns(segments: MoneySegments | null | undefined) {
  const cols = segmentColumns(segments);
  return Object.fromEntries(Object.entries(cols).filter(([, v]) => v != null));
}

export type { StripeMoneyOut };

export interface MoneyOutTotal {
  bucket: MoneyOutBucket;
  category: MoneyOutCategory;
  currency: string;
  amountMinor: number;
  count: number;
}

export interface MoneyOutDayPoint {
  day: string; // YYYY-MM-DD (UTC)
  category: MoneyOutCategory;
  currency: string;
  amountMinor: number;
}

export interface MoneyOutPageFilters {
  bucket?: MoneyOutBucket | null;
  category?: MoneyOutCategory | null;
  currency?: string | null;
  from?: Date | null;
  to?: Date | null;
  // Categories to leave out entirely — the ledger table hides ordinary
  // processing fees unless they are explicitly asked for.
  excludeCategories?: MoneyOutCategory[] | null;
}

// Local half of the money-out ledger. Rows are upserted by id, which is the
// whole idempotency story: the webhook path, the reconcile sweep and the
// all-time backfill can all write the same row and the last one simply wins.
export class MoneyOutStore {
  constructor(private prisma: PrismaClient) {}

  // Writes the row and hands back what the database now holds, plus whether it
  // was new. The caller emits a point only when it was new, so a re-sweep of
  // already-known transactions stays silent instead of re-counting.
  //
  // Returning the PERSISTED row matters as much as the flag: the caller must
  // emit from the same shape a later rebuild reads back out of Postgres, or the
  // two produce points that differ by a tag — which in Influx is two points.
  async upsert(row: MoneyOutRow): Promise<{ created: boolean; row: StripeMoneyOut }> {
    const existing = await this.prisma.stripeMoneyOut.findUnique({ where: { id: row.id }, select: { id: true } });
    const data = {
      kind: row.kind,
      bucket: row.bucket,
      category: row.category,
      amountMinor: row.amountMinor,
      feeMinor: row.feeMinor,
      netMinor: row.netMinor,
      currency: row.currency,
      source: row.source,
      reason: row.reason,
      stripeObjectId: row.stripeObjectId,
      chargeId: row.chargeId,
      customerId: row.customerId,
      invoiceId: row.invoiceId ?? null,
      occurredAt: row.occurredAt,
    };
    const saved = await this.prisma.stripeMoneyOut.upsert({
      where: { id: row.id },
      create: { id: row.id, ...data, ...usdColumns(row), ...segmentColumns(row.segments) },
      // A later pass may know things the first one didn't (the customer id the
      // webhook path resolves), but must never blank out what is already there.
      update: {
        ...data,
        customerId: row.customerId ?? undefined,
        chargeId: row.chargeId ?? undefined,
        ...definedSegmentColumns(row.segments),
      },
    });
    return { created: existing == null, row: saved };
  }

  // Bulk path for the ledger sweeps, which page 100 transactions at a time.
  // Two queries per page instead of two per ROW: read back which ids already
  // exist, then createMany the rest. Returns the rows that were actually new,
  // so the caller knows exactly which ones to emit as Influx points.
  //
  // Existing rows are NOT rewritten here: a balance transaction is immutable
  // once Stripe has written it, so an update would spend a query storing
  // identical values. Concessions, which CAN change, use upsert() above, and
  // repair() below is how a pass that knows MORE than the first one (segments,
  // a resolved refund kind) corrects a row already on disk.
  //
  // Returns the PERSISTED rows so the caller emits from what the database
  // holds; see the header of moneyPoints.ts for why that is not a detail.
  async insertNew(rows: MoneyOutRow[]): Promise<StripeMoneyOut[]> {
    if (rows.length === 0) return [];
    // Same id twice in one page (a fee row keyed off its movement row cannot
    // collide, but a retry inside one sweep could) would make createMany throw.
    const deduped = [...new Map(rows.map((r) => [r.id, r])).values()];
    const existing = await this.prisma.stripeMoneyOut.findMany({
      where: { id: { in: deduped.map((r) => r.id) } },
      select: { id: true },
    });
    const known = new Set(existing.map((e) => e.id));
    const fresh = deduped.filter((r) => !known.has(r.id));
    if (fresh.length === 0) return [];
    return this.prisma.stripeMoneyOut.createManyAndReturn({
      data: fresh.map((r) => ({
        id: r.id,
        kind: r.kind,
        bucket: r.bucket,
        category: r.category,
        amountMinor: r.amountMinor,
        feeMinor: r.feeMinor,
        netMinor: r.netMinor,
        currency: r.currency,
        source: r.source,
        reason: r.reason,
        stripeObjectId: r.stripeObjectId,
        chargeId: r.chargeId,
        customerId: r.customerId,
        invoiceId: r.invoiceId ?? null,
        occurredAt: r.occurredAt,
        ...usdColumns(r),
        ...segmentColumns(r.segments),
      })),
      // A concurrent sweep (webhook mini-sweep racing the looper) may have
      // inserted the same id between the read and the write.
      skipDuplicates: true,
    });
  }

  // Correct rows that already exist, for the analytics rebuild's repair phase.
  //
  // This is the missing half of insertNew: a first sweep that ran without a
  // segment budget wrote nulls, and because insertNew skips every id it has
  // seen, those nulls were permanent — which is why all historical money
  // charted as "unknown" on every axis.
  //
  // What it may NOT touch is the point: everything in MONEY_OUT_FROZEN_COLUMNS
  // is part of a point's identity, so changing one would produce a SECOND point
  // rather than correcting the first. Repair fills in what was unknown; it does
  // not restate what the money was.
  async repair(rows: MoneyOutRow[]): Promise<number> {
    let repaired = 0;
    for (const row of rows) {
      const data = {
        // Knowable only later, and never blanked back out.
        ...definedSegmentColumns(row.segments),
        ...(row.customerId ? { customerId: row.customerId } : {}),
        ...(row.chargeId ? { chargeId: row.chargeId } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.invoiceId ? { invoiceId: row.invoiceId } : {}),
        // The fee a refund loses is resolved by a charge read the first pass
        // may not have spent. netMinor moves with it.
        ...(row.feeMinor ? { feeMinor: row.feeMinor, netMinor: row.netMinor } : {}),
        // Frozen conversion for rows written before the columns existed.
        ...usdColumns(row),
      };
      const res = await this.prisma.stripeMoneyOut.updateMany({ where: { id: row.id }, data });
      repaired += res.count;
    }
    return repaired;
  }

  // Retire the per-coupon discount ESTIMATES, superseded by invoice-derived
  // actuals. Identifiable exactly: they are the only discount rows keyed on a
  // Stripe discount id.
  //
  // Retired, not deleted. This is a money ledger: an operator who sees the
  // concession total move deserves to be able to find out why, and a second
  // rebuild needs to be able to tell that this already happened.
  async retireEstimatedDiscounts(reason: string): Promise<number> {
    const res = await this.prisma.stripeMoneyOut.updateMany({
      where: { category: "discount", id: { startsWith: "di_" }, retiredAt: null },
      data: { retiredAt: new Date(), retiredReason: reason },
    });
    return res.count;
  }

  // Rows touched since a moment, for the rebuild's tail catch-up: anything a
  // live webhook wrote while emission was suppressed, or after the re-emit
  // cursor had already walked past its id.
  async *iterateChangedSince(since: Date, chunkSize = 500): AsyncGenerator<StripeMoneyOut[]> {
    let cursor: string | null = null;
    for (;;) {
      const batch: StripeMoneyOut[] = await this.prisma.stripeMoneyOut.findMany({
        where: { ...LIVE, updatedAt: { gte: since } },
        take: chunkSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
      });
      if (batch.length === 0) return;
      yield batch;
      cursor = batch[batch.length - 1].id;
      if (batch.length < chunkSize) return;
    }
  }

  // Late attribution: fill in the customer on rows a sweep wrote before it
  // knew who they belonged to. Never overwrites an id that is already there.
  async setCustomerForCharge(chargeId: string, customerId: string): Promise<void> {
    await this.prisma.stripeMoneyOut.updateMany({
      where: { chargeId, customerId: null },
      data: { customerId },
    });
  }

  async get(id: string): Promise<StripeMoneyOut | null> {
    return this.prisma.stripeMoneyOut.findUnique({ where: { id } });
  }

  // What the mirror actually holds. This is the disambiguation when a chart
  // looks wrong: if coverage runs to today, the mirror is fine and the gap is
  // in the Influx points; if coverage stops early, the SWEEP stopped early and
  // no amount of re-emitting will fix it.
  async coverage(): Promise<{ rows: number; oldest: Date | null; newest: Date | null; byCategory: Array<{ category: string; count: number }> }> {
    const [rows, oldest, newest, grouped] = await Promise.all([
      this.prisma.stripeMoneyOut.count({ where: LIVE }),
      this.prisma.stripeMoneyOut.findFirst({ where: LIVE, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
      this.prisma.stripeMoneyOut.findFirst({ where: LIVE, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
      this.prisma.stripeMoneyOut.groupBy({ by: ["category"], where: LIVE, _count: { _all: true } }),
    ]);
    return {
      rows,
      oldest: oldest?.occurredAt ?? null,
      newest: newest?.occurredAt ?? null,
      byCategory: grouped
        .map((g) => ({ category: g.category, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  }

  async count(): Promise<number> {
    return this.prisma.stripeMoneyOut.count({ where: LIVE });
  }

  // Window totals grouped by bucket/category/currency — the stat tiles and the
  // category breakdown chart both read this one query.
  async windowTotals(from: Date, to: Date): Promise<MoneyOutTotal[]> {
    const grouped = await this.prisma.stripeMoneyOut.groupBy({
      by: ["bucket", "category", "currency"],
      where: { ...LIVE, occurredAt: { gte: from, lte: to } },
      _sum: { amountMinor: true },
      _count: { _all: true },
    });
    return grouped.map((g) => ({
      bucket: g.bucket as MoneyOutBucket,
      category: g.category as MoneyOutCategory,
      currency: g.currency,
      amountMinor: g._sum.amountMinor ?? 0,
      count: g._count._all,
    }));
  }

  // Per-day series for the stacked outflow chart. Grouping by day is done in
  // SQL (date_trunc) rather than in JS so a 90-day window doesn't stream every
  // row into the process.
  async dailySeries(from: Date, to: Date): Promise<MoneyOutDayPoint[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ day: Date; category: string; currency: string; amount: bigint | number }>
    >`
      SELECT date_trunc('day', "occurredAt") AS day,
             "category",
             "currency",
             SUM("amountMinor") AS amount
        FROM "stripe_money_out"
       WHERE "occurredAt" >= ${from} AND "occurredAt" <= ${to}
         AND "retiredAt" IS NULL
       GROUP BY 1, 2, 3
       ORDER BY 1 ASC
    `;
    return rows.map((r) => ({
      day: new Date(r.day).toISOString().slice(0, 10),
      category: r.category as MoneyOutCategory,
      currency: r.currency,
      amountMinor: Number(r.amount),
    }));
  }

  // Paginated drill-down for the dashboard table (offset paging, matching the
  // other billing lists). Returns one page plus the unfiltered total so the
  // footer can show "n of m".
  async page(
    filters: MoneyOutPageFilters,
    skip: number,
    take: number
  ): Promise<{ rows: StripeMoneyOut[]; total: number }> {
    const where = {
      ...LIVE,
      ...(filters.bucket ? { bucket: filters.bucket } : {}),
      ...(filters.category
        ? { category: filters.category }
        : filters.excludeCategories?.length
          ? { category: { notIn: filters.excludeCategories } }
          : {}),
      ...(filters.currency ? { currency: filters.currency } : {}),
      ...(filters.from || filters.to
        ? {
            occurredAt: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stripeMoneyOut.findMany({ where, orderBy: { occurredAt: "desc" }, skip, take }),
      this.prisma.stripeMoneyOut.count({ where }),
    ]);
    return { rows, total };
  }

  // Top customers by outflow in a window — "who is costing us the most".
  async topCustomers(from: Date, to: Date, limit: number): Promise<Array<{ customerId: string; amountMinor: number; count: number }>> {
    const grouped = await this.prisma.stripeMoneyOut.groupBy({
      by: ["customerId"],
      where: { ...LIVE, occurredAt: { gte: from, lte: to }, customerId: { not: null } },
      _sum: { amountMinor: true },
      _count: { _all: true },
      orderBy: { _sum: { amountMinor: "desc" } },
      take: limit,
    });
    return grouped
      .filter((g) => g.customerId != null)
      .map((g) => ({ customerId: g.customerId as string, amountMinor: g._sum.amountMinor ?? 0, count: g._count._all }));
  }

  // Every row, oldest first — the backfill's Influx re-emission walks this in
  // chunks so an all-time history doesn't land in memory at once.
  async *iterateAll(chunkSize = 500): AsyncGenerator<StripeMoneyOut[]> {
    let cursor: string | null = null;
    for (;;) {
      const batch: StripeMoneyOut[] = await this.prisma.stripeMoneyOut.findMany({
        where: LIVE,
        take: chunkSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
      });
      if (batch.length === 0) return;
      yield batch;
      cursor = batch[batch.length - 1].id;
      if (batch.length < chunkSize) return;
    }
  }
}
