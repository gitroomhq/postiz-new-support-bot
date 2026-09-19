import type { AiRun, DisputeAutoResolve, DisputeEvent, PrismaClient } from "../../generated/prisma/client";
import { SettingsStore } from "../../config/SettingsStore";
import { MoneyOutService } from "./MoneyOutService";
import { MoneyOutStore } from "./MoneyOutStore";
import { SubscriptionEventService } from "./SubscriptionEventService";
import { SubscriptionEventStore } from "./SubscriptionEventStore";
import { DisputeStore } from "./DisputeStore";
import { StripeClient } from "../StripeClient";
import { StripeSegmentResolver } from "./StripeSegmentResolver";
import { backfillDisputeHistory, reemitDisputeOutcomes } from "./DisputeMonitor";
import { emitDisputeOutcome, emitMoneyOut, emitSubscriptionEvent } from "./moneyPoints";
import { REBUILDABLE_MEASUREMENTS } from "../../metrics/measurements";
import {
  deleteMeasurements,
  flushInflux,
  influxActive,
  probeInfluxDelete,
  resetInfluxForRebuild,
  setSuppressedMeasurements,
} from "../../metrics/InfluxWriter";
import { exportAiRun, exportDisputeAutoResolve, exportDisputeEvent } from "../../metrics/MetricsExporter";
import { log } from "../../util/logger";

const rebuildLog = log.child("analytics-rebuild");

// Flush every N points. The Influx client silently DROPS points once its
// 5000-line buffer fills, so a re-emit that does not flush as it goes loses
// most of what it was asked to restore.
const FLUSH_EVERY = 500;

// Stripe reads the whole run may spend on descriptive segments (plan, card,
// region, tenure). Generous on purpose: this is the pass that exists to buy the
// axes the ordinary backfill leaves as "unknown", and it runs rarely. The
// resolver caches process-wide, so a busy account spends far less than this —
// the same handful of subscriptions repeat endlessly.
//
// Raised from 20k after the first production run: the budget is now spent ONLY
// on rows that actually lack segments (MoneyOutStore.idsNeedingSegments), so it
// buys history rather than re-confirming rows the live sweep already did. A cap
// still exists because a runaway crawl against Stripe is the thing it guards
// against, and running out is now reported rather than silent — and resumable,
// because a row the budget never reached keeps segmentsResolvedAt null.
const SEGMENT_BUDGET = 50_000;

export type RebuildPhase = "preflight" | "repair" | "wipe" | "reemit" | "catchup" | "gauges";

export interface RebuildStats {
  moneyScanned: number;
  moneyCreated: number;
  moneyRepaired: number;
  segmentsEnriched: number;
  segmentBudgetExhausted: boolean;
  creditNotes: number;
  writeOffs: number;
  discountRows: number;
  invoicesScanned: number;
  retiredEstimates: number;
  disputesSwept: number;
  disputeClosedAtImproved: number;
  churnScanned: number;
  churnCreated: number;
  churnUsdBackfilled: number;
  deleted: string[];
  droppedLines: number;
  points: number;
  catchUpPoints: number;
  truncated: boolean;
}

function emptyStats(): RebuildStats {
  return {
    moneyScanned: 0,
    moneyCreated: 0,
    moneyRepaired: 0,
    segmentsEnriched: 0,
    segmentBudgetExhausted: false,
    creditNotes: 0,
    writeOffs: 0,
    discountRows: 0,
    invoicesScanned: 0,
    retiredEstimates: 0,
    disputesSwept: 0,
    disputeClosedAtImproved: 0,
    churnScanned: 0,
    churnCreated: 0,
    churnUsdBackfilled: 0,
    deleted: [],
    droppedLines: 0,
    points: 0,
    catchUpPoints: 0,
    truncated: false,
  };
}

// The full analytics rebuild: wipe the rebuildable Influx measurements, re-walk
// every Stripe datasource into the Postgres mirrors, and re-emit the result.
//
// PHASE ORDER IS REPAIR → WIPE → RE-EMIT, not wipe-first, for three reasons and
// the first is the one that matters:
//
//   FAILURE CONTAINMENT. If the Stripe walk dies at 60%, repair-first leaves
//   the bucket untouched and the whole run is a retryable no-op. Wipe-first
//   leaves a destroyed bucket AND a half-repaired mirror, and the only way out
//   is to finish the repair under pressure.
//
//   NO BLIND WINDOW. Wipe-first means every dashboard reads zero for the entire
//   Stripe walk, which can be hours. This way the bucket is empty only for the
//   re-emit, which is minutes.
//
//   NO ORPHANS. A repair that changes a tag value (a segment going from
//   "unknown" to "visa") writes a NEW series and leaves the old point behind.
//   Wiping after every repair has settled is the only order in which no orphan
//   can survive.
//
// Live webhooks keep writing to Postgres throughout. They must: losing a Stripe
// event is unrecoverable, while a duplicate point is not, and the emission
// design makes duplicates impossible anyway. Only their Influx emission is
// gated, and the catch-up phase picks up whatever they wrote.
export class AnalyticsRebuildService {
  constructor(
    private prisma: PrismaClient,
    private settings: SettingsStore,
    private stripe: StripeClient,
    private moneyOut: MoneyOutService,
    private moneyStore: MoneyOutStore,
    private subscriptions: SubscriptionEventService,
    private subscriptionStore: SubscriptionEventStore,
    private disputeStore: DisputeStore,
    private segments: StripeSegmentResolver
  ) {}

  active(): boolean {
    return this.settings.analyticsRebuildActive();
  }

  // Close the emission gate over the rebuildable measurements only. The fixed
  // ones keep flowing: their history has no second source, so suppressing them
  // would lose it outright.
  private suppress(on: boolean): void {
    setSuppressedMeasurements(on ? new Set<string>(REBUILDABLE_MEASUREMENTS) : new Set<string>());
  }

  // Re-apply the gate after a restart that landed mid-rebuild. Called at boot.
  restoreSuppression(): void {
    if (this.settings.analyticsRebuildActive()) {
      rebuildLog.warn("analytics rebuild was in flight at boot: emission stays suppressed", {
        "rebuild.phase": this.settings.analyticsRebuildPhase() ?? "",
      });
      this.suppress(true);
    }
  }

  private async setPhase(phase: RebuildPhase | null): Promise<void> {
    await this.settings.updateAnalyticsRebuild({ analyticsRebuildPhase: phase });
  }

  // ---- phase 0: preflight ----

  // Prove the destructive step will work BEFORE spending an hour on Stripe.
  // Finding out about a 405 or a token-permission problem after the repair has
  // run is the worst available outcome: the mirror has been rewritten and the
  // bucket still holds the old points.
  async preflight(): Promise<void> {
    if (!influxActive()) {
      throw new Error(
        "InfluxDB export is not active, so there is nothing to rebuild. Set it up in /config → Analytics first."
      );
    }
    if (!this.settings.moneyOutEnabled()) {
      throw new Error("The money-out ledger is switched off, so a rebuild would import nothing.");
    }
    // Enrichment off means every segment axis resolves to "unknown", which is
    // the single thing this rebuild exists to fix. Silently producing a bucket
    // full of "unknown" and calling it a success is worse than refusing.
    if (!this.settings.moneyOutEnrichEnabled()) {
      throw new Error(
        "Money-out segment enrichment is switched off (/config → Billing → Money-out), so every plan, card and region would rebuild as \"unknown\". Turn it on first."
      );
    }
    await probeInfluxDelete();
    rebuildLog.info("analytics rebuild preflight ok", {});
  }

  async begin(): Promise<void> {
    await this.settings.updateAnalyticsRebuild({
      analyticsRebuildPhase: "preflight",
      analyticsRebuildStartedAt: new Date(),
      analyticsRebuildDoneAt: null,
    });
    this.suppress(true);
  }

  async finish(stats: RebuildStats | null, error: string | null): Promise<void> {
    this.suppress(false);
    await this.settings.updateAnalyticsRebuild({
      analyticsRebuildPhase: null,
      analyticsRebuildDoneAt: new Date(),
      analyticsRebuildStatsJson: JSON.stringify({ ...(stats ?? {}), error, finishedAt: new Date().toISOString() }),
    });
  }

  // ---- phase 1: repair Postgres ----

  async repair(stats: RebuildStats, onProgress?: () => void): Promise<void> {
    await this.setPhase("repair");

    // Retire the superseded coupon estimates BEFORE booking the invoice-derived
    // actuals, so the two can never both be live even for an instant.
    stats.retiredEstimates = await this.moneyStore.retireEstimatedDiscounts(
      "superseded by invoice-derived discount actuals"
    );

    // The ledger, all-time, with segments bought for the whole history and
    // existing rows corrected rather than skipped. emitPoints is off: the wipe
    // that follows would orphan anything written here.
    const money = await this.moneyOut.backfillHistory({
      scope: "all",
      repairExisting: true,
      segmentBudget: SEGMENT_BUDGET,
      emitPoints: false,
      onProgress,
    });
    stats.moneyScanned = money.scanned;
    stats.moneyCreated = money.created;
    stats.moneyRepaired = money.repaired;
    stats.segmentsEnriched = money.segmentsEnriched;
    stats.segmentBudgetExhausted = money.segmentBudgetExhausted;
    stats.creditNotes = money.creditNotes;
    stats.writeOffs = money.writeOffs;
    stats.discountRows = money.discounts;
    stats.invoicesScanned = money.invoicesScanned;
    stats.truncated = stats.truncated || money.truncated;

    // Disputes, all-time, including the close-time upgrade from Stripe's own
    // events where they are still within the 30-day retention window.
    const disputes = await backfillDisputeHistory(this.stripe, this.disputeStore, this.segments, {
      segmentBudget: SEGMENT_BUDGET,
      repairOnly: true,
      onProgress,
    });
    stats.disputesSwept = disputes.swept;
    stats.disputeClosedAtImproved = disputes.closedAtImproved;
    stats.truncated = stats.truncated || disputes.truncated;

    // Churn. Thirty days is Stripe's entire event retention, so this is a
    // ceiling rather than a setting: nothing older can be imported, by anyone.
    const churn = await this.subscriptions.replayHistory(onProgress);
    stats.churnScanned = churn.scanned;
    stats.churnCreated = churn.created;
    stats.truncated = stats.truncated || churn.truncated;
    stats.churnUsdBackfilled = await this.subscriptionStore.backfillUsdColumns();
  }

  // ---- phase 2: wipe ----

  async wipe(stats: RebuildStats): Promise<void> {
    await this.setPhase("wipe");
    // flushInflux drains the write buffer but NOT the retry buffer, which
    // re-fires on its own timer and would land after the delete. See
    // resetInfluxForRebuild.
    await flushInflux();
    const { droppedLines } = resetInfluxForRebuild(this.settings.influxConfig());
    stats.droppedLines = droppedLines;
    await deleteMeasurements([...REBUILDABLE_MEASUREMENTS]);
    stats.deleted = [...REBUILDABLE_MEASUREMENTS];
    // The gate closed with the OLD WriteApi; re-apply it to the new one.
    this.suppress(true);
  }

  // ---- phase 3: re-emit ----

  async reemit(stats: RebuildStats, onProgress?: () => void): Promise<void> {
    await this.setPhase("reemit");
    // Everything below writes to the measurements that were just deleted, so
    // the gate has to come off first.
    this.suppress(false);

    let sinceFlush = 0;
    const tick = async () => {
      if (++sinceFlush >= FLUSH_EVERY) {
        sinceFlush = 0;
        await flushInflux();
      }
    };

    for await (const batch of this.moneyStore.iterateAll()) {
      onProgress?.();
      for (const row of batch) {
        emitMoneyOut(row);
        stats.points++;
        await tick();
      }
    }

    stats.points += await reemitDisputeOutcomes(this.disputeStore, onProgress);
    stats.points += await this.subscriptions.reemitAll(onProgress);
    stats.points += await this.reemitDisputeEvents(onProgress);
    stats.points += await this.reemitAutoResolves(onProgress);
    stats.points += await this.reemitAiRuns(onProgress);
    await flushInflux();
  }

  // ---- phase 4: tail catch-up ----

  // Rows a live webhook wrote while emission was suppressed, or after the
  // re-emit cursor had already walked past their id.
  //
  // Safe to run over ground already covered precisely because emission is now
  // idempotent by construction: same row, same tags, same timestamp, so a
  // second emit overwrites its own point instead of adding one.
  async catchUp(stats: RebuildStats, since: Date, onProgress?: () => void): Promise<void> {
    await this.setPhase("catchup");

    for await (const batch of this.moneyStore.iterateChangedSince(since)) {
      onProgress?.();
      for (const row of batch) {
        emitMoneyOut(row);
        stats.catchUpPoints++;
      }
      await flushInflux();
    }

    // The other two mirrors need the same treatment, and for a subtler reason:
    // their re-emit reads the table ONCE, so a dispute that closed a second
    // after that read is not "past the cursor", it was never in the result set
    // at all.
    for (const dispute of await this.disputeStore.listTerminalChangedSince(since)) {
      emitDisputeOutcome(dispute);
      stats.catchUpPoints++;
    }
    for (const event of await this.subscriptionStore.listCreatedSince(since)) {
      emitSubscriptionEvent(event);
      stats.catchUpPoints++;
    }
    await flushInflux();
    onProgress?.();
  }

  // ---- phase 5: gauges ----

  // The gauges were never deleted, but the installed base behind the churn
  // numbers should be current when someone opens the dashboard right after a
  // rebuild rather than up to an hour stale.
  async refreshGauges(): Promise<void> {
    await this.setPhase("gauges");
    await this.subscriptions.snapshotPlanMix().catch(() => undefined);
    await flushInflux();
  }

  // ---- mirror re-emits with no service of their own ----

  private async reemitDisputeEvents(onProgress?: () => void): Promise<number> {
    let points = 0;
    let cursor: string | null = null;
    for (;;) {
      const batch: DisputeEvent[] = await this.prisma.disputeEvent.findMany({
        take: FLUSH_EVERY,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
      });
      if (batch.length === 0) break;
      onProgress?.();
      for (const row of batch) {
        // A null actor means the bot acted unprompted; a present one is a human.
        exportDisputeEvent({ kind: row.kind, automated: row.actorId == null, rowId: row.id, at: row.at });
        points++;
      }
      await flushInflux();
      cursor = batch[batch.length - 1].id;
      if (batch.length < FLUSH_EVERY) break;
    }
    return points;
  }

  private async reemitAutoResolves(onProgress?: () => void): Promise<number> {
    let points = 0;
    let cursor: string | null = null;
    for (;;) {
      const batch: DisputeAutoResolve[] = await this.prisma.disputeAutoResolve.findMany({
        take: FLUSH_EVERY,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
      });
      if (batch.length === 0) break;
      onProgress?.();
      for (const row of batch) {
        const stage = row.stage === "efw" ? "efw" : "inquiry";
        const common = {
          stage: stage as "inquiry" | "efw",
          reason: row.reason,
          currency: row.currency,
          amountMinor: row.amountMinor,
          amountUsdMinor: row.usdMinor,
          rowId: row.id,
        };
        // Every row was proposed once, at creation.
        exportDisputeAutoResolve({ ...common, outcome: "proposed", at: row.createdAt });
        points++;
        // …and then reached at most one terminal outcome. blockedAt and
        // failedAt are new columns: rows that predate them fall back to
        // updatedAt, which is the best available and is why the two stamps
        // were added rather than inferred forever.
        const terminal = terminalOutcomeOf(row);
        if (terminal) {
          exportDisputeAutoResolve({
            ...common,
            outcome: terminal.outcome,
            guardrail: row.guardrail,
            at: terminal.at,
          });
          points++;
        }
      }
      await flushInflux();
      cursor = batch[batch.length - 1].id;
      if (batch.length < FLUSH_EVERY) break;
    }
    return points;
  }

  private async reemitAiRuns(onProgress?: () => void): Promise<number> {
    let points = 0;
    let cursor: string | null = null;
    for (;;) {
      const batch: AiRun[] = await this.prisma.aiRun.findMany({
        take: FLUSH_EVERY,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
      });
      if (batch.length === 0) break;
      onProgress?.();
      for (const row of batch) {
        exportAiRun({
          agentName: row.agentName,
          kind: row.kind,
          source: row.source,
          model: row.model,
          outcome: row.outcome,
          sessionId: row.sessionId,
          numTurns: row.numTurns,
          durationMs: row.durationMs,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreationTokens: row.cacheCreationTokens,
          costUsd: row.costUsd,
          toolCalls: row.toolCalls,
          toolErrors: row.toolErrors,
          rowId: row.id,
          at: row.createdAt,
        });
        points++;
      }
      await flushInflux();
      cursor = batch[batch.length - 1].id;
      if (batch.length < FLUSH_EVERY) break;
    }
    return points;
  }

  static emptyStats = emptyStats;
}

// Which terminal outcome a proposal reached, and when.
//
// EXECUTED and VETOED have always had their own stamp. BLOCKED and FAILED did
// not, and updatedAt is not a substitute for them: `attempts` bumps it, so a
// row that failed three times would be placed at the last retry rather than at
// the failure. blockedAt / failedAt fix that going forward; rows written before
// the columns existed fall back to updatedAt and are approximate, which is the
// honest limit rather than something to hide.
function terminalOutcomeOf(row: {
  state: string;
  executedAt: Date | null;
  vetoedAt: Date | null;
  blockedAt: Date | null;
  failedAt: Date | null;
  updatedAt: Date;
}): { outcome: "executed" | "vetoed" | "blocked" | "failed"; at: Date } | null {
  switch (row.state) {
    case "EXECUTED":
      return { outcome: "executed", at: row.executedAt ?? row.updatedAt };
    case "VETOED":
      return { outcome: "vetoed", at: row.vetoedAt ?? row.updatedAt };
    case "BLOCKED":
      return { outcome: "blocked", at: row.blockedAt ?? row.updatedAt };
    case "FAILED":
      return { outcome: "failed", at: row.failedAt ?? row.updatedAt };
    default:
      // PENDING / EXECUTING / SUPERSEDED have not reached an outcome.
      return null;
  }
}
