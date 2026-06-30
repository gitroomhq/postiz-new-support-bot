import { Client, TextChannel } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { StatusReportService } from "./StatusReportService";

const HOUR_MS = 60 * 60 * 1000;
// How often we check whether a report is due; decoupled from the configured interval.
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export class StatusReportScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private client: Client,
    private settings: SettingsStore,
    private reportService: StatusReportService
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error("Status report scheduler error:", err));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (!this.settings.reportEnabled()) return;
    const channelId = this.settings.reportChannelId();
    if (!channelId) return;
 
    const lastRunAt = this.settings.reportLastRunAt();
    const scheduledHour = this.settings.reportHour();
    const scheduledMinute = this.settings.reportMinute();
    const shouldPublish =
      scheduledHour != null && scheduledMinute != null
        ? this.isDueForScheduledTime(lastRunAt, scheduledHour, scheduledMinute)
        : this.isDueForInterval(lastRunAt);
    if (!shouldPublish) return;
 
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!(channel instanceof TextChannel)) {
      console.error(`Status report channel ${channelId} is not a usable text channel.`);
      return;
    }
 
    // Build first (deltas compare against the stored snapshot), then post and persist the
    // new snapshot + run time so restarts don't double-post.
    const { embed, snapshot } = await this.reportService.build({ since: lastRunAt });
    await channel.send({ embeds: [embed] });
    await this.settings.recordReportRun(snapshot);
  }
 
  private isDueForInterval(lastRunAt: Date | null): boolean {
    if (!lastRunAt) return true;
    const intervalMs = Math.max(1, this.settings.reportIntervalHours()) * HOUR_MS;
    return Date.now() - lastRunAt.getTime() >= intervalMs;
  }
 
  private isDueForScheduledTime(lastRunAt: Date | null, scheduledHour: number, scheduledMinute: number): boolean {
    const now = new Date();
    const timeZone = this.settings.reportTimezone();
    const nowParts = this.getDateParts(now, timeZone);
    if (lastRunAt) {
      const lastRunParts = this.getDateParts(lastRunAt, timeZone);
      if (lastRunParts.year === nowParts.year && lastRunParts.month === nowParts.month && lastRunParts.day === nowParts.day) {
        return false;
      }
    }
    const nowMinutes = nowParts.hour * 60 + nowParts.minute;
    const scheduledMinutes = scheduledHour * 60 + scheduledMinute;
    return nowMinutes >= scheduledMinutes;
  }
 
  private getDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const getPart = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
    return {
      year: getPart("year"),
      month: getPart("month"),
      day: getPart("day"),
      hour: getPart("hour"),
      minute: getPart("minute"),
    };
  }
}
