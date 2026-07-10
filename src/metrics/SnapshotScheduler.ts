import { PrismaClient } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { TicketStore } from "../bot/TicketStore";
import { OPEN_DISPUTE_STATUSES, RESPONDABLE_DISPUTE_STATUSES } from "../bot/billing/DisputeStore";
import { exportBotHealth, exportDisputeSnapshot, exportSnapshotGauge, exportSnapshotTotals } from "./MetricsExporter";

const DAY_MS = 24 * 60 * 60 * 1000;

// Gauge snapshots for Grafana: open tickets by status/category, overdue and
// awaiting-first-response counts, pending charge reviews, dispute-console
// counts, and a bot_health heartbeat. Driven by the metricsSnapshotWorkflow
// looper's 5-minute snapshotTick activity, which also emits the Intercom
// queue-depth gauges from Temporal visibility counts.
export class SnapshotScheduler {
  constructor(
    private prisma: PrismaClient,
    private settings: SettingsStore,
    private ticketStore: TicketStore
  ) {}

  async tick(): Promise<void> {
    const now = new Date();
    const [breakdown, overdue, awaiting, pendingReviews, openDisputes, dueSoon, blocked] = await Promise.all([
      this.ticketStore.statusCategoryBreakdown(),
      this.ticketStore.countOverdue(new Date(Date.now() - this.settings.overdueThresholdDays() * DAY_MS)),
      this.ticketStore.countAwaitingFirstResponse(),
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

    const byStatus = new Map<string, number>();
    const byCategory = new Map<string, number>();
    let openTotal = 0;
    for (const row of breakdown) {
      if (row.closed) continue;
      openTotal += row.count;
      const statusLabel = (row.statusTagId && this.settings.tagById(row.statusTagId)?.label) || "unknown";
      byStatus.set(statusLabel, (byStatus.get(statusLabel) ?? 0) + row.count);
      const category = row.categoryId ?? "unknown";
      byCategory.set(category, (byCategory.get(category) ?? 0) + row.count);
    }
    for (const [label, count] of byStatus) exportSnapshotGauge("status", label, count);
    for (const [category, count] of byCategory) exportSnapshotGauge("category", category, count);

    exportSnapshotTotals({
      open: openTotal,
      overdue,
      awaitingFirstResponse: awaiting,
      pendingChargeReviews: pendingReviews,
    });
    // Counts only — the ratio percentages come from the 6-hourly dispute
    // monitor tick (they need Stripe sweeps, abusive at 5-minute cadence).
    exportDisputeSnapshot({ open: openDisputes, dueSoon, blocked });
    exportBotHealth();
  }
}
