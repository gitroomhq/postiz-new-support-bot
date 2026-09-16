import { PrismaClient } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { OPEN_DISPUTE_STATUSES, RESPONDABLE_DISPUTE_STATUSES } from "../bot/billing/DisputeStore";
import { exportBotHealth, exportDisputeSnapshot, exportPendingChargeReviews } from "./MetricsExporter";
import type { SubscriptionEventService } from "../bot/billing/SubscriptionEventService";

const DAY_MS = 24 * 60 * 60 * 1000;

// The plan-mix gauge walks every active subscription on the account, so it
// cannot ride the 5-minute tick. An hour is the right cadence for an installed
// base: it moves in signups and cancellations, not in minutes, and the churn
// counts it contextualises are themselves daily numbers.
const PLAN_MIX_INTERVAL_MS = 60 * 60 * 1000;

// Gauge snapshots for Grafana: pending charge reviews, dispute-console counts,
// and a bot_health heartbeat. Driven by the metricsSnapshotWorkflow looper's
// 5-minute snapshotTick activity, which also emits the Intercom queue-depth
// gauges from Temporal visibility counts. (The ticket-quality gauges left with
// the agent-rip — ticket analytics live in Intercom now.)
export class SnapshotScheduler {
  // Process-local damper for the plan-mix sweep. Deliberately not persisted: a
  // restart re-sweeping once is harmless, and a bot_settings write every hour
  // to save one Stripe page walk is a worse trade.
  private planMixAt = 0;

  constructor(
    private prisma: PrismaClient,
    private settings: SettingsStore,
    // Churn analytics — optional so the scheduler still runs without it.
    private subscriptionEvents?: SubscriptionEventService,
    // Queue depth of the dispute auto-resolve engine, injected as a thunk
    // rather than as its store: this scheduler has no business knowing how that
    // engine persists anything, and the thunk keeps the dependency one number
    // wide. Must never throw — a gauge is not worth failing a tick over.
    private autoResolvePending?: () => Promise<number>
  ) {}

  async tick(): Promise<void> {
    const now = new Date();
    const [pendingReviews, openDisputes, dueSoon, blocked] = await Promise.all([
      this.prisma.pendingChargeReview.count({ where: { status: "PENDING" } }),
      this.prisma.stripeDispute.count({ where: { status: { in: [...OPEN_DISPUTE_STATUSES] } } }),
      this.prisma.stripeDispute.count({
        where: {
          status: { in: [...RESPONDABLE_DISPUTE_STATUSES] },
          evidenceSubmittedAt: null,
          evidenceDueBy: {
            gte: now,
            lte: new Date(now.getTime() + this.settings.disputeReminderDays() * DAY_MS),
          },
        },
      }),
      this.prisma.blockedEntity.count(),
    ]);

    exportPendingChargeReviews(pendingReviews);
    // Counts only — the ratio percentages come from the 6-hourly dispute
    // monitor tick (they need Stripe sweeps, abusive at 5-minute cadence).
    // auto_resolve_pending rides THIS tick rather than the looper's because it
    // is a queue depth: it is only useful if it is fresh, and one gauge has
    // exactly one writer.
    const autoResolvePending = this.autoResolvePending
      ? await this.autoResolvePending().catch(() => undefined)
      : undefined;
    exportDisputeSnapshot({ open: openDisputes, dueSoon, blocked, autoResolvePending });
    exportBotHealth();

    // The installed base behind the churn numbers. Hour-dampered: it walks
    // every active subscription, which is far too expensive for this tick's
    // 5-minute cadence, and an installed base does not move in five minutes.
    if (this.subscriptionEvents && this.settings.subscriptionEventsEnabled()) {
      if (now.getTime() - this.planMixAt >= PLAN_MIX_INTERVAL_MS) {
        this.planMixAt = now.getTime();
        await this.subscriptionEvents.snapshotPlanMix().catch(() => undefined);
      }
    }
  }
}
