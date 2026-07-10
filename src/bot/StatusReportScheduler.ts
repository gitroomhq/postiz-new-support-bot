import { Client, TextChannel } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { StatusReportService } from "./StatusReportService";
import { log } from "../util/logger";
import { withTickSpan } from "../util/instrument";

const schedLog = log.child("scheduler:status-report");

const HOUR_MS = 60 * 60 * 1000;

export class StatusReportScheduler {
  // Guards against overlapping publishes (an overlapping Schedule fire or a
  // manual trigger racing a scheduled one) — the once-per-day guard persists
  // only after the publish completes.
  private publishing = false;

  constructor(
    private client: Client,
    private settings: SettingsStore,
    private reportService: StatusReportService
  ) {}

  // The body of the Temporal publishStatusReportWorkflow activity (fired by
  // the "status-report" Schedule or the /config "Run Report Now" button).
  // force=true bypasses the due-check but still respects the enabled/channel
  // gates and the in-flight guard. Returns whether a report actually went out.
  async publishIfDue(force: boolean): Promise<{ published: boolean }> {
    if (!this.settings.reportEnabled()) return { published: false };
    const channelId = this.settings.reportChannelId();
    if (!channelId) return { published: false };

    const lastRunAt = this.settings.reportLastRunAt();
    const scheduledHour = this.settings.reportHour();
    const scheduledMinute = this.settings.reportMinute();
    const shouldPublish =
      force ||
      (scheduledHour != null && scheduledMinute != null
        ? this.isDueForScheduledTime(lastRunAt, scheduledHour, scheduledMinute)
        : this.isDueForInterval(lastRunAt));
    if (!shouldPublish) return { published: false };
    if (this.publishing) return { published: false }; // a previous publish is still running — don't double-post

    this.publishing = true;
    try {
      // Span only the rare publish, not the cheap once-a-minute due check.
      let published = false;
      await withTickSpan("status-report", async () => {
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (!(channel instanceof TextChannel)) {
          schedLog.warn("report channel unusable", { "report.channel_id": channelId });
          return;
        }

        // Build first (deltas compare against the stored snapshot), then post and persist the
        // new snapshot + run time so restarts don't double-post.
        const { embed, components, snapshot } = await this.reportService.build({ since: lastRunAt });
        await channel.send({ embeds: [embed], components });
        await this.settings.recordReportRun(snapshot);
        schedLog.info("report.published", { "report.channel_id": channelId });
        published = true;
      });
      return { published };
    } finally {
      this.publishing = false;
    }
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
