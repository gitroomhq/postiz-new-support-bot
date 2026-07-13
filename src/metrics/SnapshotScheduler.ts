import { PrismaClient } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { OPEN_DISPUTE_STATUSES, RESPONDABLE_DISPUTE_STATUSES } from "../bot/billing/DisputeStore";
import { exportBotHealth, exportDisputeSnapshot, exportPendingChargeReviews } from "./MetricsExporter";

const DAY_MS = 24 * 60 * 60 * 1000;

// Gauge snapshots for Grafana: pending charge reviews, dispute-console counts,
// and a bot_health heartbeat. Driven by the metricsSnapshotWorkflow looper's
// 5-minute snapshotTick activity, which also emits the Intercom queue-depth
// gauges from Temporal visibility counts. (The ticket-quality gauges left with
// the agent-rip — ticket analytics live in Intercom now.)
export class SnapshotScheduler {
  constructor(
    private prisma: PrismaClient,
    private settings: SettingsStore
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
    exportDisputeSnapshot({ open: openDisputes, dueSoon, blocked });
    exportBotHealth();
  }
}
