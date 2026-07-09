import { PrismaClient } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { TicketStore } from "../bot/TicketStore";
import { IntercomStore } from "../intercom/IntercomStore";
import { log } from "../util/logger";
import { withTickSpan, wasCaptured } from "../util/instrument";
import { influxActive } from "./InfluxWriter";
import {
  exportBotHealth,
  exportIntercomQueueDepth,
  exportSnapshotGauge,
  exportSnapshotTotals,
} from "./MetricsExporter";

const schedLog = log.child("scheduler:metrics-snapshot");

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Periodic gauge snapshots for Grafana: open tickets by status/category, overdue
// and awaiting-first-response counts, Intercom queue depths, pending charge
// reviews, and a bot_health heartbeat. Cheap no-op while Influx is inactive.
export class SnapshotScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaClient,
    private settings: SettingsStore,
    private ticketStore: TicketStore,
    private intercomStore: IntercomStore
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (!influxActive()) return;
      withTickSpan("metrics-snapshot", () => this.tick()).catch((err) => {
        if (!wasCaptured(err)) schedLog.error("tick failed", err);
      });
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const [breakdown, overdue, awaiting, outbox, inbox, pendingReviews] = await Promise.all([
      this.ticketStore.statusCategoryBreakdown(),
      this.ticketStore.countOverdue(new Date(Date.now() - this.settings.overdueThresholdDays() * DAY_MS)),
      this.ticketStore.countAwaitingFirstResponse(),
      this.intercomStore.counts(),
      this.intercomStore.inboundCounts(),
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
    exportIntercomQueueDepth({ queue: "outbox", pending: outbox.pending, dead: outbox.dead });
    exportIntercomQueueDepth({ queue: "inbox", pending: inbox.pending, dead: inbox.dead });
    exportBotHealth();
  }
}
