import { PrismaClient } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { TicketStore } from "../bot/TicketStore";
import { exportBotHealth, exportSnapshotGauge, exportSnapshotTotals } from "./MetricsExporter";

const DAY_MS = 24 * 60 * 60 * 1000;

// Gauge snapshots for Grafana: open tickets by status/category, overdue and
// awaiting-first-response counts, pending charge reviews, and a bot_health
// heartbeat. Driven by the metricsSnapshotWorkflow looper's 5-minute
// snapshotTick activity, which also emits the Intercom queue-depth gauges
// from Temporal visibility counts.
export class SnapshotScheduler {
  constructor(
    private prisma: PrismaClient,
    private settings: SettingsStore,
    private ticketStore: TicketStore
  ) {}

  async tick(): Promise<void> {
    const [breakdown, overdue, awaiting, pendingReviews] = await Promise.all([
      this.ticketStore.statusCategoryBreakdown(),
      this.ticketStore.countOverdue(new Date(Date.now() - this.settings.overdueThresholdDays() * DAY_MS)),
      this.ticketStore.countAwaitingFirstResponse(),
      this.prisma.pendingChargeReview.count({ where: { status: "PENDING" } }),
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
    exportBotHealth();
  }
}
