import { EmbedBuilder } from "discord.js";
import { StatusTag } from "../generated/prisma/client";
import { SettingsStore, ReportSnapshot } from "../config/SettingsStore";
import { TicketStore } from "./TicketStore";
import { CategoryRegistry } from "./CategoryRegistry";
import { COLORS } from "../util/embeds";
import { RESOLVED_EMOJI } from "./StatusService";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BuildReportOptions {
  // Window start for the opened/closed activity counts. null → trailing 24h (manual checks).
  since: Date | null;
}

export interface BuiltReport {
  embed: EmbedBuilder;
  snapshot: ReportSnapshot;
}

// Builds the support status report embed (shared by the scheduler and the /report command).
// Trend deltas are shown vs the snapshot stored after the previous scheduled report.
export class StatusReportService {
  constructor(
    private settings: SettingsStore,
    private ticketStore: TicketStore,
    private categoryRegistry: CategoryRegistry
  ) {}

  async build(options: BuildReportOptions): Promise<BuiltReport> {
    const now = new Date();
    const windowStart = options.since ?? new Date(now.getTime() - DAY_MS);

    const tags = this.settings.tags();
    const doneTagIds = new Set(
      tags.filter((t) => t.closesThread || t.emoji === RESOLVED_EMOJI).map((t) => t.id)
    );

    const [breakdown, opened, closed] = await Promise.all([
      this.ticketStore.statusCategoryBreakdown(),
      this.ticketStore.countOpenedSince(windowStart),
      this.ticketStore.countClosedSince(windowStart),
    ]);

    let openTotal = 0;
    let doneTotal = 0;
    let total = 0;
    const openByStatus = new Map<string | null, number>();
    const openByCategory = new Map<string | null, number>();

    for (const row of breakdown) {
      total += row.count;
      const isDone = row.statusTagId != null && doneTagIds.has(row.statusTagId);
      if (isDone) {
        doneTotal += row.count;
      } else {
        openTotal += row.count;
        openByStatus.set(row.statusTagId, (openByStatus.get(row.statusTagId) ?? 0) + row.count);
        openByCategory.set(row.categoryId, (openByCategory.get(row.categoryId) ?? 0) + row.count);
      }
    }

    const snapshot: ReportSnapshot = { openTotal, doneTotal, total };
    const prev = this.settings.reportLastSnapshot();

    const net = opened - closed;
    const windowLabel = options.since
      ? `Since last report (${this.formatDuration(now.getTime() - windowStart.getTime())})`
      : "Last 24 hours";

    const lines = [
      `**${windowLabel}**`,
      `🆕 Opened **${opened}**   📁 Closed **${closed}**   Net ${this.signedTrend(net)}`,
      "",
      `**Open tickets: ${openTotal}**${this.delta(openTotal, prev?.openTotal)}`,
      `**By status:** ${this.formatStatusList(openByStatus, tags)}`,
      `**By type:** ${this.formatTypeList(openByCategory)}`,
      "",
      `**Done: ${doneTotal}**${this.delta(doneTotal, prev?.doneTotal)}   ·   ` +
        `**Total: ${total}**${this.delta(total, prev?.total)}`,
    ];

    const embed = new EmbedBuilder()
      .setTitle("📊 Support Status")
      .setColor(COLORS.brand)
      .setDescription(lines.join("\n"))
      .setFooter({ text: this.formatTimestamp(now) });

    return { embed, snapshot };
  }

  private formatStatusList(counts: Map<string | null, number>, tags: StatusTag[]): string {
    const parts: string[] = [];
    for (const tag of tags) {
      const count = counts.get(tag.id);
      if (count) parts.push(`${tag.emoji} ${tag.label} ${count}`);
    }
    const unknown = counts.get(null);
    if (unknown) parts.push(`❔ Unknown ${unknown}`);
    return parts.length ? parts.join(" · ") : "_none_";
  }

  private formatTypeList(counts: Map<string | null, number>): string {
    const categories = this.categoryRegistry.getAll();
    const parts: string[] = [];
    let other = counts.get(null) ?? 0;
    for (const category of categories) {
      const count = counts.get(category.id);
      if (count) parts.push(`${category.emoji} ${category.label} ${count}`);
    }
    // Any stored categoryId that no longer maps to a registered category → fold into "Other".
    for (const [key, value] of counts) {
      if (key !== null && !categories.some((c) => c.id === key)) other += value;
    }
    if (other) parts.push(`❔ Other ${other}`);
    return parts.length ? parts.join(" · ") : "_none_";
  }

  // " (📈 N)" / " (📉 N)" / " (➖ 0)" vs the previous snapshot; empty when there's no baseline.
  private delta(curr: number, prev: number | undefined): string {
    if (prev === undefined) return "";
    const diff = curr - prev;
    if (diff > 0) return ` (📈 ${diff})`;
    if (diff < 0) return ` (📉 ${Math.abs(diff)})`;
    return " (➖ 0)";
  }

  private signedTrend(value: number): string {
    if (value > 0) return `📈 ${value}`;
    if (value < 0) return `📉 ${Math.abs(value)}`;
    return "➖ 0";
  }

  private formatDuration(ms: number): string {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
  }

  private formatTimestamp(date: Date): string {
    const tz = this.settings.reportTimezone();
    try {
      const formatted = new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
      }).format(date);
      return `${formatted} (${tz})`;
    } catch {
      return `${date.toISOString()} (UTC)`;
    }
  }
}
