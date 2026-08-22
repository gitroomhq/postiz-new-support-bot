import { PrismaClient, StripeMoneyOut } from "../../generated/prisma/client";
import type { MoneyOutBucket, MoneyOutCategory, MoneyOutRow } from "./moneyOutTaxonomy";

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

  // Returns true when the row did NOT exist before — the caller uses that to
  // decide whether to emit an Influx point, so a re-sweep of already-known
  // transactions stays silent instead of re-counting them.
  async upsert(row: MoneyOutRow): Promise<boolean> {
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
      occurredAt: row.occurredAt,
    };
    await this.prisma.stripeMoneyOut.upsert({
      where: { id: row.id },
      create: { id: row.id, ...data },
      // A later pass may know things the first one didn't (the customer id the
      // webhook path resolves), but must never blank out what is already there.
      update: {
        ...data,
        customerId: row.customerId ?? undefined,
        chargeId: row.chargeId ?? undefined,
      },
    });
    return existing == null;
  }

  // Bulk path for the ledger sweeps, which page 100 transactions at a time.
  // Two queries per page instead of two per ROW: read back which ids already
  // exist, then createMany the rest. Returns the rows that were actually new,
  // so the caller knows exactly which ones to emit as Influx points.
  //
  // Existing rows are deliberately NOT rewritten: a balance transaction is
  // immutable once Stripe has written it, so an update would spend a query to
  // store the identical values. Concessions, which CAN change, keep using
  // upsert() above.
  async insertNew(rows: MoneyOutRow[]): Promise<MoneyOutRow[]> {
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
    await this.prisma.stripeMoneyOut.createMany({
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
        occurredAt: r.occurredAt,
      })),
      // A concurrent sweep (webhook mini-sweep racing the looper) may have
      // inserted the same id between the read and the write.
      skipDuplicates: true,
    });
    return fresh;
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

  async count(): Promise<number> {
    return this.prisma.stripeMoneyOut.count();
  }

  // Window totals grouped by bucket/category/currency — the stat tiles and the
  // category breakdown chart both read this one query.
  async windowTotals(from: Date, to: Date): Promise<MoneyOutTotal[]> {
    const grouped = await this.prisma.stripeMoneyOut.groupBy({
      by: ["bucket", "category", "currency"],
      where: { occurredAt: { gte: from, lte: to } },
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
      where: { occurredAt: { gte: from, lte: to }, customerId: { not: null } },
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
