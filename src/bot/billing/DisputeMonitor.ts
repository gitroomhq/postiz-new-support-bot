import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder } from "discord.js";
import { SettingsStore } from "../../config/SettingsStore";
import { SessionStore } from "../../auth/SessionStore";
import { StripeClient } from "../StripeClient";
import { DisputeStore, OPEN_DISPUTE_STATUSES, RESPONDABLE_DISPUTE_STATUSES, segmentsOfDispute } from "./DisputeStore";
import type { EvidencePackBuilder } from "./evidence/EvidencePackBuilder";
import type { DisputeEvidenceService } from "./DisputeEvidenceService";
import { quietAccept, type DisputeVerdictService } from "./DisputeVerdictService";
import { VERDICT_SIGNAL_LABELS, VERDICT_VERSION } from "./disputeVerdict";
import { DISPUTE_PHASES } from "./disputePhase";
import type { EvidenceFacts } from "./evidence/tokens";
import type { StripeSegmentResolver } from "./StripeSegmentResolver";
import { BlockStore } from "./BlockStore";
import { CachedRatioEngine, describeRatioWindow, ratioLevel, type RatioLevel } from "./disputeRatio";
import { COLORS } from "../../util/embeds";
import { log } from "../../util/logger";
import {
  exportBillingEvent,
  exportDisputeEvidencePack,
  exportDisputeModes,
  emitDisputeOutcome,
  exportDisputeResponse,
  exportDisputeSnapshot,
} from "../../metrics/MetricsExporter";
import { flushInflux, influxActive } from "../../metrics/InfluxWriter";
import type { DisputesTickResult } from "../../temporal/types";
import type Stripe from "stripe";

const monitorLog = log.child("dispute-monitor");

const DAY_S = 24 * 60 * 60;

// The looper ticks hourly; the 90-day Stripe reconcile and the ratio sweeps
// keep their original cadence behind a persisted cursor. A code constant rather
// than a setting: it is a cost decision, not an operator preference.
const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;

// Evidence packs enrich through Intercom, so a tick handles a bounded number.
const AUTO_EVIDENCE_LIMIT = 10;

// Verdicts for open disputes outside the auto-submit window, and backtest
// verdicts for closed ones. Each costs one enriched build (a handful of Stripe
// reads, one platform lookup, up to ten Intercom calls), so both are capped,
// and both stop starting new work once the tick has run this long: the
// activity allows ten minutes and the ratio sweep still has to fit after them.
const VERDICT_LIMIT = 10;
const BACKTEST_LIMIT = 15;
const VERDICT_TIME_BUDGET_MS = 5 * 60_000;
// An open dispute's verdict is re-evaluated once a day: usage and support
// contact keep arriving while a dispute waits for its deadline.
const VERDICT_STALE_MS = 24 * 60 * 60_000;
// How far back the backtest reaches.
export const BACKTEST_WINDOW_DAYS = 365;

const RESPONDABLE = new Set<string>(RESPONDABLE_DISPUTE_STATUSES);

// Stripe → local table reconciliation: upserts every dispute created in the
// last 90 days, then re-checks any locally-open dispute the sweep missed
// (closes older than the window, missed webhooks). Shared by the looper tick
// and the /billing "Sync from Stripe" button. The status breakdown feeds the
// sync notice — most synced disputes are usually already closed, and a bare
// total reads like "sync did nothing" when the open list doesn't change.
export interface ReconcileResult {
  synced: number;
  open: number;
  won: number;
  lost: number;
  otherClosed: number;
  truncated: boolean;
}


// The strength facts that travel with the once-per-dispute pack point, so a
// won/lost split can be read against what the package actually carried.
function packStrength(pack: { score: number; facts: EvidenceFacts }) {
  return {
    score: pack.score,
    postsAfterCharge: pack.facts.usage?.publishedSinceCharge,
    postUrls: pack.facts.usage?.recentPostsSinceCharge.length,
    channelsConnected: pack.facts.usage?.channelsLive,
    threeDSecure: pack.facts.charge?.threeDSecure === "authenticated",
    cvcMatched: pack.facts.charge?.cvcCheck === "pass",
    sameCardPriorCharges: pack.facts.cards?.sameCardPriorCount,
  };
}

const OPEN_SET = new Set<string>(OPEN_DISPUTE_STATUSES);

export async function reconcileDisputes(stripe: StripeClient, disputeStore: DisputeStore): Promise<ReconcileResult> {
  const since = Math.floor(Date.now() / 1000) - 90 * DAY_S;
  const sweep = await stripe.listDisputesSince(since);
  const seen = new Set<string>();
  const result: ReconcileResult = { synced: 0, open: 0, won: 0, lost: 0, otherClosed: 0, truncated: sweep.truncated };
  const tally = (status: string) => {
    if (OPEN_SET.has(status)) result.open++;
    else if (status === "won") result.won++;
    else if (status === "lost") result.lost++;
    else result.otherClosed++; // prevented, warning_closed
  };
  for (const dispute of sweep.disputes) {
    seen.add(dispute.id);
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const existing = await disputeStore.get(dispute.id);
    const customerId =
      existing?.customerId ??
      (chargeId ? await stripe.getChargeCustomerId(chargeId).catch(() => null) : null);
    await disputeStore.upsertFromStripe(dispute, customerId);
    tally(dispute.status);
    result.synced++;
  }
  // Locally open but absent from the sweep — fetch individually to catch up.
  for (const id of await disputeStore.listOpenIds()) {
    if (seen.has(id)) continue;
    try {
      const fresh = await stripe.getDispute(id);
      const existing = await disputeStore.get(id);
      await disputeStore.upsertFromStripe(fresh, existing?.customerId ?? null);
      tally(fresh.status);
      result.synced++;
    } catch (error) {
      monitorLog.warn("dispute re-check failed", { "stripe.dispute_id": id, error: String(error) });
    }
  }
  return result;
}

// One-time all-time history import (/config → Billing → Disputes → Backfill
// History): sweeps EVERY dispute from Stripe into the local mirror (win-rate
// analytics need the full history, not the 90d reconcile window), then emits
// one Influx outcome point per terminal dispute at its historical close time.
// Idempotent: re-runs upsert the same rows and overwrite the same points
// (identical measurement + tags + timestamp).
export interface DisputeBackfillResult {
  swept: number;
  terminal: number;
  points: number;
  // Disputes whose closedAt was upgraded from a guess to the real moment, taken
  // from Stripe's event stream. Reported because it is the number that explains
  // a win-rate chart shifting along the time axis after a rebuild.
  closedAtImproved: number;
  truncated: boolean;
}

// Stripe does not expose a closed-at timestamp on disputes. Best available
// estimate: the latest balance transaction (won → funds-reinstatement, most
// closures move funds), else an elapsed evidence deadline, else creation.
function guessClosedAt(d: Stripe.Dispute, now: Date): Date {
  const candidates: number[] = [];
  for (const bt of d.balance_transactions ?? []) {
    if (bt.created) candidates.push(bt.created * 1000);
  }
  const dueBy = d.evidence_details?.due_by ? d.evidence_details.due_by * 1000 : null;
  if (dueBy && dueBy < now.getTime()) candidates.push(dueBy);
  const guess = candidates.length ? Math.max(...candidates) : d.created * 1000;
  return new Date(Math.min(guess, now.getTime()));
}

// Stripe reads the WHOLE history sweep may spend resolving descriptive
// segments — one budget for the entire run, not one per dispute. Disputes are
// low-volume enough that enriching history is worth paying for (unlike the
// money-out ledger, where all-time history is thousands of rows), but it still
// needs a ceiling: an account with a chargeback problem has a lot of them, and
// each one costs up to four reads. Past the cap the rest keep null segments and
// chart as "unknown".
const BACKFILL_SEGMENT_BUDGET = 400;

export async function backfillDisputeHistory(
  stripe: StripeClient,
  disputeStore: DisputeStore,
  segments?: StripeSegmentResolver,
  opts: {
    // Stripe reads the whole run may spend on segments. Overridable so the
    // analytics rebuild, which is allowed to be slow and thorough, can buy
    // axes for a history this default deliberately leaves as "unknown".
    segmentBudget?: number;
    // Skip the re-emission entirely. The analytics rebuild repairs the mirror
    // with Influx suppressed and re-emits afterwards in its own phase, so
    // emitting here would write points the wipe then deletes.
    repairOnly?: boolean;
    onProgress?: () => void;
  } = {}
): Promise<DisputeBackfillResult> {
  const now = new Date();
  const sweep = await stripe.listAllDisputes();
  // One budget for the run. Letting each upsert open its own would mean the cap
  // never caps: a thousand disputes would each get a fresh allowance.
  segments?.startBatch(opts.segmentBudget ?? BACKFILL_SEGMENT_BUDGET);
  // Authoritative close times, where Stripe still remembers them. Fetched once
  // for the whole sweep rather than per dispute: it is a handful of event pages
  // against a 30-day window, and it is the only way an already-stored estimate
  // can ever be replaced (closedAt is otherwise write-once).
  const exactCloses = await fetchExactCloseTimes(stripe).catch((error) => {
    monitorLog.warn("dispute close-time lookup failed", { "error.message": String(error) });
    return new Map<string, Date>();
  });
  let closedAtImproved = 0;

  for (const dispute of sweep.disputes) {
    opts.onProgress?.();
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const existing = await disputeStore.get(dispute.id);
    const customerId =
      existing?.customerId ??
      (chargeId ? await stripe.getChargeCustomerId(chargeId).catch(() => null) : null);
    const exact = exactCloses.get(dispute.id);
    if (exact && existing?.closedAtEstimated !== false) closedAtImproved++;
    await disputeStore.upsertFromStripe(dispute, customerId, {
      closedAtHint: guessClosedAt(dispute, now),
      ...(exact ? { closedAtExact: { at: exact, source: "stripe_event" } } : {}),
      // null = this loop owns the budget opened above.
      enrichBudget: segments ? null : undefined,
      silent: opts.repairOnly,
    });
  }

  const terminal = sweep.disputes.filter((d) => !OPEN_SET.has(d.status)).length;
  const points = opts.repairOnly ? 0 : await reemitDisputeOutcomes(disputeStore);
  return { swept: sweep.disputes.length, terminal, points, closedAtImproved, truncated: sweep.truncated };
}

// Emit an outcome point for the WHOLE terminal mirror at its stored closedAt.
//
// Idempotent by construction now that both this and the live transition emit
// through emitDisputeOutcome(row): same row, same tags, same timestamp, so a
// re-run overwrites instead of double-counting.
export async function reemitDisputeOutcomes(
  disputeStore: DisputeStore,
  onProgress?: () => void
): Promise<number> {
  if (!influxActive()) return 0;
  let points = 0;
  for (const row of await disputeStore.listTerminalForExport()) {
    onProgress?.();
    emitDisputeOutcome(row);
    points++;
  }
  await flushInflux();
  return points;
}

// Real close times from Stripe's own event stream.
//
// Stripe puts no closed-at field on a dispute, so the mirror otherwise stores a
// guess (guessClosedAt). Events carry the actual moment, but only for 30 days —
// past that the guess is all there is, which is exactly why closedAtEstimated
// exists as a column rather than the estimate being passed off as fact.
async function fetchExactCloseTimes(stripe: StripeClient): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const createdGte = Math.floor((Date.now() - 30 * DAY_S * 1000) / 1000);
  let startingAfter: string | undefined;
  for (let page = 0; page < 40; page++) {
    const { events, hasMore } = await stripe.listEventsByType({
      types: ["charge.dispute.closed"],
      createdGte,
      limit: 100,
      ...(startingAfter ? { startingAfter } : {}),
    });
    if (events.length === 0) break;
    for (const event of events) {
      const dispute = event.data.object as Stripe.Dispute;
      if (!dispute?.id) continue;
      // Events page newest-first, so an earlier entry is the more recent close.
      if (!out.has(dispute.id)) out.set(dispute.id, new Date(event.created * 1000));
    }
    if (!hasMore) break;
    startingAfter = events[events.length - 1].id;
  }
  return out;
}

// The disputes-looper tick body: reconcile → evidence-due reminders → ratio
// threshold check. Constructed before the Discord client (bindClient idiom,
// same as StripeWebhookHandler).
export class DisputeMonitor {
  private client: Client | null = null;
  // Closed disputes the backtest could not evaluate in this process (a charge
  // Stripe no longer returns, say). Skipped so one bad row cannot keep the
  // backtest "running" forever; a restart gives them one more chance.
  private backtestFailed = new Set<string>();

  constructor(
    private settings: SettingsStore,
    private sessionStore: SessionStore,
    private stripe: StripeClient,
    private disputeStore: DisputeStore,
    private blockStore: BlockStore,
    private ratio: CachedRatioEngine,
    // Optional so an instance without them still reconciles and reminds.
    private autoResolve?: { drain(): Promise<{ executed: number; blocked: number; failed: number }> } | null,
    private evidencePack?: EvidencePackBuilder | null,
    private evidence?: DisputeEvidenceService | null,
    // Fight or accept. Absent, packs still build and nothing auto-submits,
    // because the submit gate refuses a dispute with no verdict.
    private verdicts?: DisputeVerdictService | null
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  // The looper ticks HOURLY so due auto-resolves fire close to their configured
  // veto window and near-deadline evidence is noticed in time. The expensive
  // Stripe work does not run hourly: the 90-day reconcile and the ratio sweeps
  // stay on their original 6h cadence behind a persisted cursor, so this change
  // buys timeliness without multiplying Stripe reads by six.
  //
  // Order matters. The auto-resolve drain runs FIRST and unconditionally: it is
  // cheap and time-critical, and a slow reconcile must never push a due refund
  // past the window a human was promised.
  async tick(force: boolean, beat: () => void = () => {}): Promise<DisputesTickResult> {
    const startedAt = Date.now();
    // Written every tick so every other dispute panel can be read against what
    // was actually switched on at the time. A change in win rate means nothing
    // without knowing which week evidence went to auto.
    exportDisputeModes({
      evidencePhase: DISPUTE_PHASES.indexOf(this.settings.disputeEvidenceMode()),
      resolvePhase: DISPUTE_PHASES.indexOf(this.settings.disputeResolveMode()),
    });

    const autoResolve = await this.autoResolve?.drain().catch((error) => {
      monitorLog.error("auto-resolve drain failed", error);
      return null;
    });

    // Free to run every tick: the query carries its own 24h damper per dispute
    // and touches no Stripe at all, so hourly simply notices a near-due dispute
    // within an hour instead of within six.
    const reminders = await this.sendReminders().catch((error) => {
      monitorLog.error("dispute reminders failed", error);
      return 0;
    });

    const evidence = await this.runAutoEvidence(beat).catch((error) => {
      monitorLog.error("dispute auto-evidence failed", error);
      return { packed: 0, autoSubmitted: 0, autoAccepted: 0, escalated: 0, touched: new Set<string>() };
    });

    const verdicts = await this.runVerdicts(evidence.touched, startedAt, beat).catch((error) => {
      monitorLog.error("dispute verdict sweep failed", error);
      return { verdicts: 0, backtested: 0 };
    });

    const last = this.settings.disputeReconcileAt();
    const heavyDue = force || !last || Date.now() - last.getTime() >= RECONCILE_INTERVAL_MS;

    let reconciled = 0;
    let level: DisputesTickResult["ratioLevel"] = "skipped";
    if (heavyDue) {
      try {
        reconciled = (await reconcileDisputes(this.stripe, this.disputeStore)).synced;
      } catch (error) {
        monitorLog.error("dispute reconciliation failed", error);
      }
      level = await this.checkRatio(force).catch((error) => {
        monitorLog.error("dispute ratio check failed", error);
        return "skipped" as const;
      });
      await this.settings.recordDisputeReconcile().catch(() => {
        // A failed stamp only means the heavy pass runs again next hour.
      });
    }

    return {
      reconciled,
      reminders,
      ratioLevel: level,
      autoResolved: autoResolve?.executed ?? 0,
      autoResolveBlocked: autoResolve?.blocked ?? 0,
      autoResolveFailed: autoResolve?.failed ?? 0,
      packed: evidence.packed,
      autoSubmitted: evidence.autoSubmitted,
      autoAccepted: evidence.autoAccepted,
      escalated: evidence.escalated,
      verdicts: verdicts.verdicts,
      backtested: verdicts.backtested,
    };
  }

  // Builds (or rebuilds) the templated evidence pack for disputes approaching
  // their deadline, then either submits it or escalates. Capped per tick: this
  // is the expensive path, with Intercom enrichment on every dispute it touches.
  private async runAutoEvidence(beat: () => void): Promise<{
    packed: number;
    autoSubmitted: number;
    autoAccepted: number;
    escalated: number;
    touched: Set<string>;
  }> {
    const out = { packed: 0, autoSubmitted: 0, autoAccepted: 0, escalated: 0, touched: new Set<string>() };
    const builder = this.evidencePack;
    if (!builder || !this.settings.disputeAutoPackEnabled()) return out;

    // Look a full day beyond the submit window so a pack is built and readable
    // BEFORE the hour it might be submitted in.
    const windowHours = this.settings.disputeAutoSubmitHours() + 24;
    const rows = await this.disputeStore.listNeedingAutoEvidence(windowHours);
    for (const listed of rows.slice(0, AUTO_EVIDENCE_LIMIT)) {
      beat();
      try {
        const dispute = await this.stripe.getDispute(listed.id);
        if (!RESPONDABLE.has(dispute.status)) continue;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
        if (!chargeId) continue;
        const charge = await this.stripe.getCharge(chargeId);
        const pack = await builder.build(dispute, charge, { enrich: true });
        const staged = await builder.stage(dispute, pack, false);
        // A rebuild that produced identical text staged nothing, so it is not a
        // pack this tick made. Counting it would report an hourly stream of
        // work on a dispute nobody has touched since the day it arrived.
        if (!staged.unchanged) out.packed++;

        // The verdict is re-decided from exactly the facts this build used,
        // then read back with any human override before the gates look at it.
        out.touched.add(listed.id);
        await this.verdicts?.evaluateAndStore(dispute, charge, staged.pack, "live").catch((error) => {
          monitorLog.warn("dispute verdict failed", { "stripe.dispute_id": listed.id, "error.message": String(error) });
        });
        const row = (await this.disputeStore.get(listed.id).catch(() => null)) ?? listed;

        const decision = await builder.autoSubmitDecision(dispute, row, staged.pack);
        if (decision.kind === "refuse" && decision.why === "verdict_accept") {
          // Not worth fighting. In auto mode, concede it inside the same window
          // a fight would have been submitted in; otherwise it simply lapses,
          // which loses it exactly as accepting would, with nobody paged.
          const accept = builder.autoAcceptDecision(dispute, row);
          if (accept.kind === "accept" && this.evidence) {
            const result = await this.evidence.accept(dispute.id, "system", row.customerId);
            if (result.kind === "accepted") {
              out.autoAccepted++;
              exportBillingEvent({ event: "dispute_accepted", amountMinor: dispute.amount, currency: dispute.currency, chargeId });
              await this.postAutoAccepted(dispute, row);
            }
          }
          continue;
        }
        if (decision.kind === "submit") {
          const result = await this.evidence!.submit(dispute.id, "system", row.customerId);
          if (result.kind === "submitted") {
            out.autoSubmitted++;
            exportDisputeEvidencePack({
              reason: dispute.reason,
              source: row.evidenceTouchedAt ? "mixed" : "template",
              fieldsFilled: staged.staged.length,
              fieldsRecommended: staged.staged.length + staged.omitted.length,
              filesAttached: 0,
              autoSubmitted: true,
              ...packStrength(staged.pack),
            });
            exportDisputeResponse({
              reason: dispute.reason,
              currency: dispute.currency,
              hoursToSubmit: (Date.now() - dispute.created * 1000) / 3_600_000,
              // NOT clamped: a negative value means it went past the deadline,
              // which is precisely the signal worth seeing.
              hoursBeforeDeadline: ((dispute.evidence_details?.due_by ?? 0) * 1000 - Date.now()) / 3_600_000,
            });
            await this.postAutoSubmitted(dispute, staged.pack.score);
          }
          continue;
        }

        // Refused. NOTHING is un-staged: the pack stays exactly where it is, so
        // a human only has to press Submit.
        if (this.shouldEscalate(decision.why, dispute)) {
          await this.escalateEvidence(dispute, decision.why, decision.score, staged.omitted);
          exportDisputeEvidencePack({
            reason: dispute.reason,
            source: row.evidenceTouchedAt ? "mixed" : "template",
            fieldsFilled: staged.staged.length,
            fieldsRecommended: staged.staged.length + staged.omitted.length,
            filesAttached: 0,
            autoSubmitted: false,
            ...packStrength(staged.pack),
          });
          out.escalated++;
        }
      } catch (error) {
        monitorLog.error("dispute auto-evidence row failed", error, { "stripe.dispute_id": listed.id });
      }
    }
    return out;
  }

  // Keeps a current, enriched verdict on every open dispute, not only the ones
  // already inside the auto-submit window, so the list can be triaged the day
  // a dispute arrives. Then, with whatever budget is left, works through a
  // requested backtest over closed disputes.
  private async runVerdicts(
    skip: Set<string>,
    startedAt: number,
    beat: () => void
  ): Promise<{ verdicts: number; backtested: number }> {
    const out = { verdicts: 0, backtested: 0 };
    const builder = this.evidencePack;
    const verdicts = this.verdicts;
    if (!builder || !verdicts) return out;
    const overBudget = () => Date.now() - startedAt > VERDICT_TIME_BUDGET_MS;

    const open = await this.disputeStore.listNeedingVerdict(
      VERDICT_VERSION,
      new Date(Date.now() - VERDICT_STALE_MS),
      VERDICT_LIMIT + skip.size
    );
    for (const row of open.filter((r) => !skip.has(r.id)).slice(0, VERDICT_LIMIT)) {
      if (overBudget()) return out;
      beat();
      if (await this.verdictFor(row.id, "live")) out.verdicts++;
    }

    const requested = this.settings.disputeBacktestRequestedAt();
    if (!requested) return out;
    const since = new Date(Date.now() - BACKTEST_WINDOW_DAYS * 24 * 60 * 60_000);
    const failed = [...this.backtestFailed];
    const candidates = await this.disputeStore.listBacktestCandidates(VERDICT_VERSION, since, BACKTEST_LIMIT, failed);
    for (const row of candidates) {
      if (overBudget()) return out;
      beat();
      if (await this.verdictFor(row.id, "backtest")) out.backtested++;
      else this.backtestFailed.add(row.id);
    }
    // Finished when nothing evaluable is left. What failed is reported rather
    // than retried forever: it shows up in the tables as "No verdict".
    const left = await this.disputeStore.listBacktestCandidates(VERDICT_VERSION, since, 1, [...this.backtestFailed]);
    if (left.length === 0) {
      await this.settings.updateDisputeVerdict({ disputeBacktestRequestedAt: null }).catch(() => {});
      monitorLog.info("dispute verdict backtest finished", {
        "verdict.version": VERDICT_VERSION,
        "verdict.unevaluable": this.backtestFailed.size,
      });
      this.backtestFailed.clear();
    }
    return out;
  }

  // One enriched build and verdict. Read-only at Stripe: build() gathers and
  // renders but never stages, so a closed dispute can be evaluated freely.
  private async verdictFor(disputeId: string, source: "live" | "backtest"): Promise<boolean> {
    try {
      const dispute = await this.stripe.getDispute(disputeId);
      const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
      if (!chargeId) return false;
      const charge = await this.stripe.getCharge(chargeId);
      const pack = await this.evidencePack!.build(dispute, charge, { enrich: true });
      return (await this.verdicts!.evaluateAndStore(dispute, charge, pack, source)) != null;
    } catch (error) {
      monitorLog.warn("dispute verdict failed", {
        "stripe.dispute_id": disputeId,
        "verdict.source": source,
        "error.message": String(error),
      });
      return false;
    }
  }

  // Only a refusal that a human can still act on is worth a ping. "Not due yet"
  // and "already submitted" are the system working, not a problem, and neither
  // is a dispute the verdict says not to fight: letting it lapse IS accepting it.
  private shouldEscalate(why: string, dispute: Stripe.Dispute): boolean {
    if (why === "not_due_yet" || why === "already_submitted" || why === "opted_out" || why === "verdict_accept") {
      return false;
    }
    const dueBy = dispute.evidence_details?.due_by;
    if (!dueBy) return false;
    return (dueBy * 1000 - Date.now()) / 3_600_000 <= this.settings.disputeAutoSubmitHours();
  }

  private async escalateEvidence(
    dispute: Stripe.Dispute,
    why: string,
    score: number,
    omitted: Array<{ field: string; why: string }>
  ): Promise<void> {
    const dueBy = dispute.evidence_details?.due_by ?? 0;
    const hours = Math.max(0, Math.round((dueBy * 1000 - Date.now()) / 3_600_000));
    const roleId = this.settings.disputeUrgentRoleId();
    // A verdict that could not be completed, or was never made, is a decision
    // for a human, not a Submit press: submitting against it asks for a reason.
    const verdictGap = why === "verdict_incomplete" || why === "verdict_missing";
    const embed = new EmbedBuilder()
      .setTitle("⏳ Evidence needs a human before the deadline")
      .setColor(COLORS.danger)
      .setDescription(
        verdictGap
          ? `The evidence package for \`${dispute.id}\` is staged, but whether to fight it could not be decided: **${
              why === "verdict_missing" ? "no verdict yet" : "a source did not answer"
            }**. Open the dispute and choose: submit (with a reason) or accept it as lost.`
          : `The evidence package for \`${dispute.id}\` is staged but was NOT auto-submitted: **${why.replace(/_/g, " ")}**. ` +
              "Nothing was un-staged, so opening it and pressing Submit is all that is required."
      )
      .addFields(
        { name: "Completeness", value: `${score}%`, inline: true },
        { name: "Hours left", value: String(hours), inline: true },
        { name: "Amount", value: this.stripe.formatAmount(dispute.amount, dispute.currency), inline: true },
        ...(omitted.length
          ? [{ name: "Missing", value: omitted.map((o) => `${o.field}: ${o.why}`).join("\n").slice(0, 1024), inline: false }]
          : [])
      )
      .setTimestamp();
    await this.postAlert(embed, [], roleId ? `<@&${roleId}>` : undefined);
    // Share the urgent damper so the ordinary urgent ping does not double-fire
    // in the same hour for the same dispute.
    await this.disputeStore.recordUrgentReminder(dispute.id).catch(() => {});
  }

  // The record of an irreversible thing the bot did on its own, mirroring the
  // auto-submit notice. It names the rule, because "auto-accepted" without a
  // why is the one message nobody can check.
  private async postAutoAccepted(
    dispute: Stripe.Dispute,
    row: { verdictDecisive: string | null; verdictOverride: string | null; verdictOverrideBy: string | null }
  ): Promise<void> {
    const why = row.verdictOverride
      ? `overridden to Accept by ${row.verdictOverrideBy ?? "a human"}`
      : (VERDICT_SIGNAL_LABELS[row.verdictDecisive as keyof typeof VERDICT_SIGNAL_LABELS] ?? row.verdictDecisive ?? "verdict");
    const embed = new EmbedBuilder()
      .setTitle("🏳️ Dispute auto-accepted")
      .setColor(COLORS.warn)
      .setDescription(
        `\`${dispute.id}\` was accepted as lost before its deadline because the verdict is **Accept**: ${why}. No evidence was sent, so no countered-dispute fee applies.`
      )
      .addFields(
        { name: "Amount", value: this.stripe.formatAmount(dispute.amount, dispute.currency), inline: true },
        { name: "Reason", value: dispute.reason || "unknown", inline: true }
      )
      .setTimestamp();
    await this.postAlert(embed, [this.openButtonRow(dispute.id)]);
  }

  private async postAutoSubmitted(dispute: Stripe.Dispute, score: number): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("📤 Evidence auto-submitted")
      .setColor(COLORS.success)
      .setDescription(`The templated evidence package for \`${dispute.id}\` was submitted to the bank at ${score}% completeness.`)
      .addFields({ name: "Amount", value: this.stripe.formatAmount(dispute.amount, dispute.currency), inline: true })
      .setTimestamp();
    await this.postAlert(embed);
  }

  // Respondable disputes with evidence due within N days: one channel ping per
  // dispute per 24h (lastReminderAt damper lives in the store query). Disputes
  // inside the urgent window escalate: red embed, harder wording and a role
  // mention when /config has an urgent dispute role set — with its own 24h
  // damper so entering the window pings even if a normal reminder just fired.
  private async sendReminders(): Promise<number> {
    const withinDays = this.settings.disputeReminderDays();
    const urgentHours = this.settings.disputeUrgentHours();
    const [allNormal, allUrgent] = await Promise.all([
      this.disputeStore.listNeedingReminder(withinDays, urgentHours),
      this.disputeStore.listNeedingUrgentReminder(urgentHours),
    ]);
    // A dispute the verdict concedes needs nothing from anyone: it lapses to
    // lost at the deadline, the same outcome accepting would give. Paging a
    // human to "submit evidence" for it would be asking for the fight we
    // decided not to have.
    const normal = allNormal.filter((row) => !quietAccept(row));
    const urgent = allUrgent.filter((row) => !quietAccept(row));
    let sent = 0;
    for (const row of urgent) {
      if (await this.sendReminderAlert(row, true, urgentHours)) {
        await this.disputeStore.recordUrgentReminder(row.id);
        // Keeps the normal damper in step so a shrinking urgent window (config
        // change) can't double-ping the same dispute within 24h.
        await this.disputeStore.recordReminder(row.id);
        sent++;
      }
    }
    for (const row of normal) {
      if (await this.sendReminderAlert(row, false, urgentHours)) {
        await this.disputeStore.recordReminder(row.id);
        sent++;
      }
    }
    return sent;
  }

  private async sendReminderAlert(
    row: { id: string; amount: number; currency: string; reason: string; chargeId: string; customerId: string | null; evidenceDueBy: Date | null },
    isUrgent: boolean,
    urgentHours: number
  ): Promise<boolean> {
    const dueTs = row.evidenceDueBy ? Math.floor(row.evidenceDueBy.getTime() / 1000) : null;
    const linked = row.customerId ? await this.linkedMention(row.customerId) : null;
    const embed = new EmbedBuilder()
      .setTitle(isUrgent ? "🚨 URGENT: dispute evidence deadline imminent" : "⏰ Dispute evidence due soon")
      .setColor(isUrgent ? COLORS.danger : COLORS.warn)
      .addFields(
        { name: "Dispute", value: `\`${row.id}\``, inline: true },
        { name: "Amount", value: this.stripe.formatAmount(row.amount, row.currency), inline: true },
        { name: "Reason", value: row.reason, inline: true },
        ...(dueTs ? [{ name: "Evidence due", value: `<t:${dueTs}:R> (<t:${dueTs}:f>)`, inline: false }] : []),
        ...(linked ? [{ name: "Customer", value: linked, inline: false }] : [])
      )
      .setTimestamp();
    if (isUrgent) {
      embed.setDescription(
        `Less than **${urgentHours}h** remain and **no evidence has been submitted**. Submit evidence or accept the dispute. After the deadline the bank decides on an empty response.`
      );
    }
    const roleId = isUrgent ? this.settings.disputeUrgentRoleId() : null;
    const posted = await this.postAlert(embed, [this.openButtonRow(row.id)], roleId ? `<@&${roleId}>` : undefined);
    if (posted) {
      exportBillingEvent({ event: "dispute_reminder", amountMinor: row.amount, currency: row.currency, chargeId: row.chargeId });
    }
    return posted;
  }

  // Alert only on level TRANSITIONS (including recovery back to ok), never on
  // every tick — the last alerted level is persisted in bot_settings.
  private async checkRatio(force: boolean): Promise<RatioLevel> {
    const ratios = await this.ratio.get(force);
    const warnPct = this.settings.disputeRatioWarnPct();
    const criticalPct = this.settings.disputeRatioCriticalPct();
    const level = ratioLevel(ratios, warnPct, criticalPct);
    const last = this.settings.disputeRatioLastLevel();

    const [open, dueSoon, blocked] = await Promise.all([
      this.disputeStore.countOpen(),
      this.disputeStore.countDueWithin(this.settings.disputeReminderDays()),
      this.blockStore.count(),
    ]);
    exportDisputeSnapshot({
      open,
      dueSoon,
      blocked,
      plain30dPct: ratios.d30.plainPct,
      vamp30dPct: ratios.d30.vampPct,
      vampMonthPct: ratios.month.vampPct,
    });

    if (level !== last) {
      const color = level === "critical" ? COLORS.danger : level === "warn" ? COLORS.warn : COLORS.success;
      const title =
        level === "ok"
          ? "✅ Dispute ratio recovered"
          : level === "warn"
            ? "⚠️ Dispute ratio above warn threshold"
            : "🚨 Dispute ratio CRITICAL";
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .setDescription(
          [
            describeRatioWindow("This month", ratios.month, ratios.truncated),
            describeRatioWindow("Trailing 30d", ratios.d30, ratios.truncated),
            describeRatioWindow("Trailing 90d", ratios.d90, ratios.truncated),
            "",
            `Thresholds: warn ≥ ${warnPct}% · critical ≥ ${criticalPct}% (month VAMP-style figure). Was **${last}**, now **${level}**.`,
          ].join("\n")
        )
        .setTimestamp();
      await this.postAlert(embed);
      await this.settings.setDisputeRatioLevel(level);
    }
    return level;
  }

  private openButtonRow(disputeId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`billadmin_dpa_open:${disputeId}`).setLabel("Open Dispute").setStyle(ButtonStyle.Primary)
    );
  }

  private async linkedMention(customerId: string): Promise<string | null> {
    try {
      const ids = await this.sessionStore.findDiscordIdsByStripeId(customerId);
      return ids.length
        ? `${ids.map((id) => `<@${id}>`).join(", ")} (\`${customerId}\`)`
        : `\`${customerId}\` (no linked Discord user)`;
    } catch {
      return null;
    }
  }

  private async postAlert(
    embed: EmbedBuilder,
    components: ActionRowBuilder<ButtonBuilder>[] = [],
    content?: string
  ): Promise<boolean> {
    const channelId = this.settings.billingAuditChannelId() ?? this.settings.auditLogChannelId();
    if (!this.client || !channelId) return false;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return false;
    return channel
      .send({
        embeds: [embed],
        components,
        ...(content ? { content, allowedMentions: { parse: ["roles" as const] } } : {}),
      })
      .then(() => true)
      .catch(() => false);
  }
}
