import { PrismaClient, StripeSubscriptionEvent } from "../../generated/prisma/client";
import type { SubscriptionMovement } from "./subscriptionEvents";
import { usdMinorOf } from "./fx";

export type { StripeSubscriptionEvent };

export interface ChurnTotal {
  event: string;
  planTier: string;
  count: number;
  mrrDeltaMinor: number;
}

// Local mirror of subscription lifecycle movements.
//
// Rows key on `${stripeEventId}:${movement}` — one Stripe event can carry more
// than one movement (a plan change that also calls off a pending cancellation),
// and each needs its own row. That key is the whole idempotency story: the
// 30-day replay writes the same ids as the live webhook path did, so re-running
// it is free rather than doubling every number.
export class SubscriptionEventStore {
  constructor(private prisma: PrismaClient) {}

  // Returns the rows that did NOT already exist, AS PERSISTED. The caller emits
  // Influx points only for those, so a replay over ground already covered stays
  // silent instead of re-counting it.
  //
  // Returning the stored rows rather than the in-memory candidates is what lets
  // the caller emit from the same shape a rebuild will later read back out of
  // Postgres. A point built from a candidate and a point built from its row can
  // differ by one tag, and in Influx that is two points rather than one.
  async insertNew(
    rows: Array<{ id: string; source: string; movement: SubscriptionMovement }>
  ): Promise<StripeSubscriptionEvent[]> {
    if (rows.length === 0) return [];
    const deduped = [...new Map(rows.map((r) => [r.id, r])).values()];
    const existing = await this.prisma.stripeSubscriptionEvent.findMany({
      where: { id: { in: deduped.map((r) => r.id) } },
      select: { id: true },
    });
    const known = new Set(existing.map((e) => e.id));
    const fresh = deduped.filter((r) => !known.has(r.id));
    if (fresh.length === 0) return [];
    // createManyAndReturn rather than createMany: the caller needs what the
    // database actually holds, not what it was asked to store.
    return this.prisma.stripeSubscriptionEvent.createManyAndReturn({
      data: fresh.map(({ id, source, movement: m }) => {
        // Frozen at ingest and never recomputed, so revising the rate table
        // cannot restate churn that already happened.
        const usd = usdMinorOf(m.mrrDeltaMinor, m.currency);
        const atRisk = usdMinorOf(m.mrrAtRiskMinor, m.currency);
        return {
          id,
          subscriptionId: m.subscriptionId,
          customerId: m.customerId,
          event: m.event,
          planTier: m.planTier,
          planPeriod: m.planPeriod,
          fromTier: m.fromTier,
          fromPeriod: m.fromPeriod,
          currency: m.currency,
          mrrMinor: m.mrrMinor,
          mrrDeltaMinor: m.mrrDeltaMinor,
          mrrAtRiskMinor: m.mrrAtRiskMinor,
          mrrDeltaUsdMinor: usd?.usdMinor ?? null,
          mrrAtRiskUsdMinor: atRisk?.usdMinor ?? null,
          fxRate: usd?.rate ?? atRisk?.rate ?? null,
          churnType: m.churnType,
          cancelReason: m.cancelReason,
          cancelFeedback: m.cancelFeedback,
          comment: m.comment,
          cardCountry: m.cardCountry,
          source,
          occurredAt: m.occurredAt,
        };
      }),
      // The live webhook and a replay can race for the same event id.
      skipDuplicates: true,
    });
  }

  // Fill the frozen USD columns on rows written before those columns existed.
  // Used by the analytics rebuild's repair phase; returns how many it filled.
  //
  // Paged by an ID CURSOR, not by re-querying `fxRate: null`. A currency fx.ts
  // has no rate for can never be given one, so a filter-on-null pager would
  // hand back the same unconvertible rows on every pass and never terminate.
  // Walking the table once, skipping what cannot be converted, does terminate.
  async backfillUsdColumns(chunkSize = 500): Promise<number> {
    let repaired = 0;
    let cursor: string | null = null;
    for (;;) {
      const batch: StripeSubscriptionEvent[] = await this.prisma.stripeSubscriptionEvent.findMany({
        where: { fxRate: null },
        take: chunkSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
      });
      if (batch.length === 0) return repaired;
      cursor = batch[batch.length - 1].id;
      for (const row of batch) {
        const usd = usdMinorOf(row.mrrDeltaMinor, row.currency);
        const atRisk = usdMinorOf(row.mrrAtRiskMinor, row.currency);
        const rate = usd?.rate ?? atRisk?.rate;
        if (rate == null) continue; // unconvertible currency: charts as absent
        await this.prisma.stripeSubscriptionEvent.update({
          where: { id: row.id },
          data: {
            mrrDeltaUsdMinor: usd?.usdMinor ?? null,
            mrrAtRiskUsdMinor: atRisk?.usdMinor ?? null,
            fxRate: rate,
          },
        });
        repaired++;
      }
      if (batch.length < chunkSize) return repaired;
    }
  }

  async count(): Promise<number> {
    return this.prisma.stripeSubscriptionEvent.count();
  }

  // What the mirror holds — the same disambiguation the money-out coverage
  // panel provides: if coverage stops early, the REPLAY stopped early, and
  // re-emitting points will not fix it.
  async coverage(): Promise<{
    rows: number;
    oldest: Date | null;
    newest: Date | null;
    byEvent: Array<{ event: string; count: number }>;
  }> {
    const [rows, oldest, newest, grouped] = await Promise.all([
      this.prisma.stripeSubscriptionEvent.count(),
      this.prisma.stripeSubscriptionEvent.findFirst({ orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
      this.prisma.stripeSubscriptionEvent.findFirst({ orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
      this.prisma.stripeSubscriptionEvent.groupBy({ by: ["event"], _count: { _all: true } }),
    ]);
    return {
      rows,
      oldest: oldest?.occurredAt ?? null,
      newest: newest?.occurredAt ?? null,
      byEvent: grouped.map((g) => ({ event: g.event, count: g._count._all })).sort((a, b) => b.count - a.count),
    };
  }

  // Window churn totals for the Discord and dashboard surfaces, so they can
  // answer "which plans cancelled" without going through Grafana.
  async windowTotals(from: Date, to: Date): Promise<ChurnTotal[]> {
    const grouped = await this.prisma.stripeSubscriptionEvent.groupBy({
      by: ["event", "planTier"],
      where: { occurredAt: { gte: from, lte: to } },
      _count: { _all: true },
      _sum: { mrrDeltaMinor: true },
    });
    return grouped
      .map((g) => ({
        event: g.event,
        planTier: g.planTier,
        count: g._count._all,
        mrrDeltaMinor: g._sum.mrrDeltaMinor ?? 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  // Rows created since a moment — the rebuild's tail catch-up, for movements a
  // live webhook recorded while emission was suppressed or after the re-emit
  // had already walked past them.
  async listCreatedSince(since: Date): Promise<StripeSubscriptionEvent[]> {
    return this.prisma.stripeSubscriptionEvent.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { id: "asc" },
    });
  }

  // Every row, oldest first, for re-emitting the mirror into a fresh Influx
  // bucket without touching Stripe.
  async *iterateAll(chunkSize = 500): AsyncGenerator<StripeSubscriptionEvent[]> {
    let cursor: string | null = null;
    for (;;) {
      const batch: StripeSubscriptionEvent[] = await this.prisma.stripeSubscriptionEvent.findMany({
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
