import { SettingsStore } from "../config/SettingsStore";
import { TicketScoringService } from "./TicketScoringService";
import { log } from "../util/logger";
import { withTickSpan, wasCaptured } from "../util/instrument";

const schedLog = log.child("scheduler:scoring");

const HOUR_MS = 60 * 60 * 1000;
// Short re-check cadence (poll pending batches promptly, resume after restart);
// the interval due-check makes steady-state ticks cheap no-ops.
const CHECK_INTERVAL_MS = 60 * 1000;

// Drives ticket scoring: polls in-flight Anthropic batches every tick (their
// ids live in Postgres, so restarts resume seamlessly), and submits a new batch
// when the configured interval elapses — or continuously while a historical
// backfill is pending. One batch in flight at a time.
export class ScoringScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private settings: SettingsStore,
    private service: TicketScoringService
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.ticking) return;
      if (!this.settings.scoringEnabled()) return;
      if (!this.service.hasDiscordClient()) return;
      this.ticking = true;
      withTickSpan("scoring", () => this.tick())
        .catch((err) => {
          if (!wasCaptured(err)) schedLog.error("tick failed", err);
        })
        .finally(() => {
          this.ticking = false;
        });
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    // Always poll first — this is what resumes a batch submitted before a restart.
    await this.service.pollBatches();
    if (await this.service.hasPendingBatches()) return;

    const backfill = this.settings.scoringBackfillPending();
    const lastRun = this.settings.scoringLastRunAt();
    const intervalMs = Math.max(1, this.settings.scoringIntervalHours()) * HOUR_MS;
    const due = !lastRun || Date.now() - lastRun.getTime() >= intervalMs;
    if (!backfill && !due) return;

    const result = await this.service.submitBatch(backfill ? "backfill" : "interval");
    if (result.budgetBlocked) return;

    if (result.submitted > 0 || result.skipped > 0) {
      await this.settings.recordScoringRun();
    }
    // Backfill drains oldest-first, one batch per tick-cycle, until empty.
    if (backfill && result.drained) {
      await this.settings.setScoringBackfillPending(false);
      schedLog.info("scoring.backfill_complete");
    }
  }
}
