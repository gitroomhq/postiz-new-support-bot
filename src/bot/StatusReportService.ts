import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { StatusTag } from "../generated/prisma/client";
import { SettingsStore, ReportSnapshot } from "../config/SettingsStore";
import { TicketStore, TicketWithTag } from "./TicketStore";
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
  components: ActionRowBuilder<ButtonBuilder>[];
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

    const overdueCutoff = new Date(now.getTime() - this.settings.overdueThresholdDays() * DAY_MS);

    const [breakdown, opened, closed, overdueTotal] = await Promise.all([
      this.ticketStore.statusCategoryBreakdown(),
      this.ticketStore.countOpenedSince(windowStart),
      this.ticketStore.countClosedSince(windowStart),
      this.ticketStore.countOverdue(overdueCutoff),
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

    const snapshot: ReportSnapshot = { openTotal, doneTotal, total, overdueTotal };
    const prev = this.settings.reportLastSnapshot();

    const net = opened - closed;
    const thresholdDays = this.settings.overdueThresholdDays();
    const windowLabel = options.since
      ? `Since last report (${this.formatDuration(now.getTime() - windowStart.getTime())})`
      : "Last 24 hours";

    const embed = new EmbedBuilder()
      .setTitle("📊 Support Status")
      .setColor(COLORS.brand)
      .addFields(
        {
          name: `📈 ${windowLabel}`,
          value: `🆕 Opened **${opened}**\n📁 Closed **${closed}**\nNet ${this.signedTrend(net)}`,
          inline: true,
        },
        {
          name: "🎫 Open",
          value: `**${openTotal}**${this.delta(openTotal, prev?.openTotal)}`,
          inline: true,
        },
        {
          name: "⚠️ Overdue",
          value: `**${overdueTotal}**${this.delta(overdueTotal, prev?.overdueTotal)}\n_over ${thresholdDays}d old_`,
          inline: true,
        },
        {
          name: "🏷️ By status",
          value: this.formatStatusList(openByStatus, tags),
          inline: false,
        },
        {
          name: "🗂️ By type",
          value: this.formatTypeList(openByCategory),
          inline: false,
        },
        {
          name: "✅ Done",
          value: `**${doneTotal}**${this.delta(doneTotal, prev?.doneTotal)}`,
          inline: true,
        },
        {
          name: "📚 Total",
          value: `**${total}**${this.delta(total, prev?.total)}`,
          inline: true,
        }
      )
      .setFooter({ text: this.formatTimestamp(now) });

    return { embed, components: [this.buildReportButtons()], snapshot };
  }

  // The two drill-down buttons attached to every report (scheduled and manual). Static
  // customIds with no state — the handlers recompute live from the ticket store on click.
  private buildReportButtons(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("report_overdue")
        .setLabel("Overdue Tickets")
        .setEmoji("⚠️")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("report_age")
        .setLabel("Age Breakdown")
        .setEmoji("📊")
        .setStyle(ButtonStyle.Secondary)
    );
  }

  // One list row for a ticket: current status, a clickable thread link, and relative age.
  // Mirrors the /search-tickets result formatting.
  private ticketLine(ticket: TicketWithTag): string {
    const status = ticket.statusTag ? `${ticket.statusTag.emoji} ${ticket.statusTag.label}` : "❔ Unknown";
    const created = `<t:${Math.floor(ticket.createdAt.getTime() / 1000)}:R>`;
    return `${status} · <#${ticket.threadId}> · ${created}`;
  }

  // Ephemeral drill-down for the "Overdue Tickets" button: open tickets whose age exceeds
  // the configured threshold, oldest first.
  async buildOverdueEmbed(): Promise<EmbedBuilder> {
    const thresholdDays = this.settings.overdueThresholdDays();
    const cutoff = Date.now() - thresholdDays * DAY_MS;
    const open = await this.ticketStore.listOpenWithTag();
    const overdue = open.filter((t) => t.createdAt.getTime() < cutoff); // already oldest-first

    if (overdue.length === 0) {
      return new EmbedBuilder()
        .setTitle("⚠️ Overdue Tickets")
        .setColor(COLORS.success)
        .setDescription(`No tickets have been open longer than ${thresholdDays} day(s). 🎉`);
    }

    const cap = 15;
    const lines = overdue.slice(0, cap).map((t) => this.ticketLine(t));
    if (overdue.length > cap) lines.push(`…and **${overdue.length - cap}** more`);

    return new EmbedBuilder()
      .setTitle(`⚠️ Overdue Tickets — ${overdue.length}`)
      .setColor(COLORS.warn)
      .setDescription(lines.join("\n"))
      .setFooter({ text: `Open longer than ${thresholdDays} day(s) · oldest first` });
  }

  // Ephemeral drill-down for the "Age Breakdown" button: distribution of open tickets across
  // age buckets, plus the oldest open tickets as an actionable list.
  async buildAgeBreakdownEmbed(): Promise<EmbedBuilder> {
    const now = Date.now();
    const open = await this.ticketStore.listOpenWithTag();

    if (open.length === 0) {
      return new EmbedBuilder()
        .setTitle("📊 Open Tickets by Age")
        .setColor(COLORS.neutral)
        .setDescription("There are no open tickets right now. 🎉");
    }

    const buckets = [
      { label: "< 12 h", min: 0, max: 0.5 },
      { label: "12–24 h", min: 0.5, max: 1 },
      { label: "1–2 days", min: 1, max: 2 },
      { label: "2–3 days", min: 2, max: 3 },
      { label: "3–5 days", min: 3, max: 5 },
      { label: "5–7 days", min: 5, max: 7 },
      { label: "7–14 days", min: 7, max: 14 },
      { label: "> 14 days", min: 14, max: Infinity },
    ];
    const counts = buckets.map(() => 0);
    for (const t of open) {
      const ageDays = (now - t.createdAt.getTime()) / DAY_MS;
      const idx = buckets.findIndex((b) => ageDays >= b.min && ageDays < b.max);
      counts[idx >= 0 ? idx : buckets.length - 1]++;
    }

    const total = open.length;
    const maxCount = Math.max(...counts, 1);
    const barWidth = 12;
    const distribution = buckets
      .map((b, i) => {
        const count = counts[i];
        const filled = Math.round((count / maxCount) * barWidth);
        const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
        const pct = Math.round((count / total) * 100);
        return `\`${b.label.padEnd(9)}\` ${bar} **${count}** (${pct}%)`;
      })
      .join("\n");

    const cap = 5;
    const oldest = open.slice(0, cap).map((t) => this.ticketLine(t));
    if (open.length > cap) oldest.push(`…and **${open.length - cap}** more`);

    return new EmbedBuilder()
      .setTitle(`📊 Open Tickets by Age — ${total}`)
      .setColor(COLORS.brand)
      .addFields(
        { name: "Distribution", value: distribution, inline: false },
        { name: "Oldest open", value: oldest.join("\n"), inline: false }
      )
      .setFooter({ text: this.formatTimestamp(new Date()) });
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
