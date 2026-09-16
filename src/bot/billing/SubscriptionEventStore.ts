import { PrismaClient, StripeSubscriptionEvent } from "../../generated/prisma/client";
import type { SubscriptionMovement } from "./subscriptionEvents";

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

  // Returns the rows that did NOT already exist. The caller emits Influx points
  // only for those, so a replay over ground already covered stays silent
  // instead of re-counting it.
  async insertNew<T extends { id: string; source: string; movement: SubscriptionMovement }>(
    rows: T[]
  ): Promise<T[]> {
    if (rows.length === 0) return [];
    const deduped = [...new Map(rows.map((r) => [r.id, r])).values()];
    const existing = await this.prisma.stripeSubscriptionEvent.findMany({
      where: { id: { in: deduped.map((r) => r.id) } },
      select: { id: true },
    });
    const known = new Set(existing.map((e) => e.id));
    const fresh = deduped.filter((r) => !known.has(r.id));
    if (fresh.length === 0) return [];
    await this.prisma.stripeSubscriptionEvent.createMany({
      data: fresh.map(({ id, source, movement: m }) => ({
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
        churnType: m.churnType,
        cancelReason: m.cancelReason,
        cancelFeedback: m.cancelFeedback,
        comment: m.comment,
        cardCountry: m.cardCountry,
        source,
        occurredAt: m.occurredAt,
      })),
      // The live webhook and a replay can race for the same event id.
      skipDuplicates: true,
    });
    return fresh;
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
