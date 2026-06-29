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
    const intervalMs = Math.max(1, this.settings.reportIntervalHours()) * HOUR_MS;
    if (lastRunAt && Date.now() - lastRunAt.getTime() < intervalMs) return;

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
}
