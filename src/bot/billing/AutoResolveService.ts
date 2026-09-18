import type Stripe from "stripe";
import type { SettingsStore } from "../../config/SettingsStore";
import type { SessionStore } from "../../auth/SessionStore";
import type { StripeClient } from "../StripeClient";
import type { DisputeStore } from "./DisputeStore";
import { AutoResolveStore } from "./AutoResolveStore";
import {
  customerIdOf,
  evaluateDispute,
  evaluateEfw,
  type AutoResolveConfig,
  type AutoResolveDecision,
  type AutoResolveStage,
  type Guardrail,
} from "./autoResolvePolicy";
import { autoExecutes, proposes } from "./disputePhase";
import { exportDisputeAutoResolve } from "../../metrics/MetricsExporter";
import { log } from "../../util/logger";
import { EXECUTING_LEASE_MS } from "./AutoResolveStore";
import { refundReasonFor, refundableRemainder } from "./autoResolvePolicy";
import type { DisputeAutoResolve } from "../../generated/prisma/client";
import type { DisputeEventStore } from "./DisputeEventStore";

const autoLog = log.child("dispute-auto-resolve");

// The auto-resolve engine. This file owns the PROPOSE half: deciding, recording
// the proposal, and reporting the decision. The drain that actually moves money
// is deliberately separate, so this half can ship and accumulate rows in
// production while nothing fires, which is how the threshold and the reason
// allowlist get calibrated against real traffic before any refund happens.
//
// Nothing here throws on a Stripe read failure: a dispute alert that arrives
// without an auto-resolve verdict is far better than a webhook that fails and
// retries five times.

export type ProposeResult =
  | { kind: "inert" }
  | { kind: "proposed"; fireAt: Date; amountMinor: number; currency: string; rowId: string }
  | { kind: "blocked"; guardrail: string }
  | { kind: "duplicate" }
  | { kind: "unavailable"; error: string };

// A proposal a human asked for, by pressing a button, rather than one the
// engine made on its own when a webhook arrived.
//
// It differs from the engine path in exactly one way: a decision that BLOCKS is
// reported and NOT written. The engine records its blocks because nobody is
// watching when a webhook lands, and the row is the only trace. Here somebody
// is watching, gets told the guardrail on the spot, and a curiosity press must
// not leave a Declined row or a metric point behind that cannot be told apart
// from an engine verdict (a `trigger` tag would split every existing series,
// so telling them apart is not on the table).
export type HandProposeResult =
  | { kind: "off" }
  | { kind: "out_of_scope"; status: string }
  | { kind: "blocked"; guardrail: Guardrail }
  | { kind: "duplicate"; state: string }
  // `alerted` is not decoration. A row with no posted alert is never executed,
  // so an unalerted proposal is inert until something posts one, and at phase
  // manual nothing else ever will: the hourly drain does not run at all there.
  | { kind: "proposed"; fireAt: Date; amountMinor: number; currency: string; rowId: string; alerted: boolean }
  | { kind: "unavailable"; error: string };

export interface BackfillResult {
  scanned: number;
  proposed: number;
  blocked: number;
  duplicate: number;
  outOfScope: number;
  unavailable: number;
  // Proposed but not reachable in Discord. Those cannot fire and cannot be
  // vetoed, so they are worth naming rather than burying in `proposed`.
  unalerted: number;
  // Why the scanned disputes were refused, so a cutover can be calibrated from
  // one press instead of opening every dispute in turn.
  guardrails: Record<string, number>;
  remaining: number;
}

// One press never evaluates more than this. Each candidate costs two Stripe
// reads, and an operator waiting on a page deserves an answer.
const BACKFILL_LIMIT = 25;

// How the engine reaches Discord. Kept as a seam rather than a Client so the
// drain is testable without discord.js, and so an unreachable channel is a
// clearly handled `null` rather than a thrown error.
export interface AutoResolveAlerts {
  // Returns where the alert landed, or null when it could not be posted at all.
  postProposal(row: DisputeAutoResolve): Promise<{ channelId: string; messageId: string } | null>;
  postBlocked(row: DisputeAutoResolve): Promise<void>;
  postExecuted(row: DisputeAutoResolve, refundText: string): Promise<void>;
  postFailed(row: DisputeAutoResolve, error: string): Promise<void>;
}

// The two things that happen to a customer after a successful auto-refund.
// Optional: an instance without them still refunds, it just does not follow up.
export interface AutoResolveSideEffects {
  cancelSubscriptions(customerId: string, idemKey: string): Promise<void>;
  noteOnCustomer(customerId: string, body: string): Promise<void>;
}

export interface DrainResult {
  executed: number;
  blocked: number;
  failed: number;
  superseded: number;
  alerted: number;
}

// A refund attempt is retried this many times across ticks before the row is
// parked as FAILED for a human. Each attempt is a fresh live re-check, so a
// transient Stripe error recovers and a permanent one stops bothering anyone.
const MAX_ATTEMPTS = 5;

// One tick never processes more than this. A liveness guard against the
// activity timeout, not a spend cap: the rest drain on the next tick.
const DRAIN_LIMIT = 20;

export class AutoResolveService {
  constructor(
    private settings: SettingsStore,
    private stripe: StripeClient,
    private store: AutoResolveStore,
    private disputeStore: DisputeStore,
    private sessionStore?: SessionStore,
    private alerts?: AutoResolveAlerts,
    private sideEffects?: AutoResolveSideEffects,
    private events?: DisputeEventStore | null
  ) {}

  config(): AutoResolveConfig {
    return {
      // The policy's "enabled" means "evaluate and record". Whether a recorded
      // proposal may FIRE is a separate question, answered by autoExecutes.
      enabled: proposes(this.settings.disputeResolveMode()),
      efwEnabled: this.settings.disputeAutoResolveEfw(),
      maxUsdMinor: this.settings.disputeAutoResolveMaxUsdMinor(),
      vetoMinutes: this.settings.disputeAutoResolveVetoMinutes(),
      reasons: this.settings.disputeAutoResolveReasons(),
    };
  }

  // Cheap pre-check so a disabled engine costs no Stripe reads at all.
  private enabledFor(stage: AutoResolveStage): boolean {
    if (!proposes(this.settings.disputeResolveMode())) return false;
    return stage === "inquiry" || this.settings.disputeAutoResolveEfw();
  }

  // Has this customer already cost us a dispute or an auto-resolve recently.
  // Counts BOTH sources: a second dispute from someone we already refunded, and
  // a second dispute from someone who disputed before the engine existed.
  //
  // Callers deliberately treat a lookup FAILURE as "yes, repeat": if we cannot
  // tell whether this customer has burned us before, the safe answer is to not
  // refund automatically. It costs a human one look; the other way round costs
  // money to somebody already flagged.
  private async isRepeatOffender(customerId: string | null, excludeDisputeId: string | null): Promise<boolean> {
    if (!customerId) return false;
    const days = this.settings.disputeAutoResolveRepeatDays();
    if (days <= 0) return false;
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);
    const [priorAutoResolves, priorDisputes] = await Promise.all([
      this.store.recentExecutedForCustomer(customerId, since),
      this.disputeStore.countForCustomerSince(customerId, since, excludeDisputeId),
    ]);
    return priorAutoResolves > 0 || priorDisputes > 0;
  }

  async proposeFromDispute(dispute: Stripe.Dispute, chargeId: string, customerId: string | null): Promise<ProposeResult> {
    if (!this.enabledFor("inquiry")) return { kind: "inert" };
    // Cheap scope test before spending a Stripe read on the charge.
    if (dispute.status !== "warning_needs_response") return { kind: "inert" };

    let charge: Stripe.Charge;
    try {
      charge = await this.stripe.getCharge(chargeId);
    } catch (error) {
      autoLog.warn("auto-resolve charge read failed", { "stripe.dispute_id": dispute.id, "error.message": String(error) });
      return { kind: "unavailable", error: String(error) };
    }

    const repeat = await this.isRepeatOffender(customerId ?? customerIdOf(charge), dispute.id).catch(() => true);
    const decision = evaluateDispute(dispute, charge, this.config(), repeat, new Date());
    return this.record(decision, {
      stage: "inquiry",
      sourceId: dispute.id,
      disputeId: dispute.id,
      chargeId,
      customerId: customerId ?? customerIdOf(charge),
      currency: charge.currency,
      reason: dispute.reason,
    });
  }

  async proposeFromEfw(efw: Stripe.Radar.EarlyFraudWarning, chargeId: string, customerId: string | null): Promise<ProposeResult> {
    if (!this.enabledFor("efw")) return { kind: "inert" };
    if (!efw.actionable) return { kind: "inert" };

    let charge: Stripe.Charge;
    try {
      charge = await this.stripe.getCharge(chargeId);
    } catch (error) {
      autoLog.warn("auto-resolve charge read failed", { "stripe.efw_id": efw.id, "error.message": String(error) });
      return { kind: "unavailable", error: String(error) };
    }

    const repeat = await this.isRepeatOffender(customerId ?? customerIdOf(charge), null).catch(() => true);
    const decision = evaluateEfw(efw, charge, this.config(), repeat, new Date());
    return this.record(decision, {
      stage: "efw",
      // An EFW has no dispute object, so this row is its only local footprint.
      sourceId: efw.id,
      disputeId: null,
      chargeId,
      customerId: customerId ?? customerIdOf(charge),
      currency: charge.currency,
      // A different vocabulary from a dispute reason, which is why the metric
      // tag is documented as a union keyed by stage.
      reason: efw.fraud_type ?? "unknown",
    });
  }

  // Evaluate ONE dispute because a human asked, outside the webhook path.
  //
  // The phase gate is deliberately different from the engine's. A phase says
  // what may happen WITHOUT a human: "manual" means nothing auto-stages and
  // nothing fires by itself, not that a human may not ask the question. So this
  // works from "manual" upward and only a pipeline switched fully off refuses.
  // Whether the resulting proposal may then FIRE on its own is still decided by
  // autoExecutes, which this does not touch.
  async proposeByHand(disputeId: string, now: Date = new Date()): Promise<HandProposeResult> {
    if (this.settings.disputeResolveMode() === "none") return { kind: "off" };

    // Cheap short-circuit: an existing row means this dispute already has a
    // verdict, so a re-press costs nothing at Stripe.
    const existing = await this.store.bySourceId(disputeId).catch(() => null);
    if (existing) return { kind: "duplicate", state: existing.state };

    let dispute: Stripe.Dispute;
    let charge: Stripe.Charge;
    try {
      dispute = await this.stripe.getDispute(disputeId);
      const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? "");
      if (!chargeId) return { kind: "out_of_scope", status: dispute.status };
      charge = await this.stripe.getCharge(chargeId);
    } catch (error) {
      autoLog.warn("hand-triggered auto-resolve read failed", {
        "stripe.dispute_id": disputeId,
        "error.message": String(error),
      });
      return { kind: "unavailable", error: String(error) };
    }

    const customerId = customerIdOf(charge);
    const repeat = await this.isRepeatOffender(customerId, disputeId).catch(() => true);
    // enabled:true overrides the phase gate the engine reads, which is the one
    // difference between asking by hand and waiting for a webhook.
    const decision = evaluateDispute(dispute, charge, { ...this.config(), enabled: true }, repeat, now);

    if (decision.kind === "inert") return { kind: "out_of_scope", status: dispute.status };
    if (decision.kind === "block") {
      autoLog.info("hand-triggered auto-resolve declined", {
        "stripe.dispute_id": disputeId,
        "auto_resolve.guardrail": decision.guardrail,
      });
      return { kind: "blocked", guardrail: decision.guardrail };
    }

    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? "");
    const recorded = await this.record(decision, {
      stage: "inquiry",
      sourceId: dispute.id,
      disputeId: dispute.id,
      chargeId,
      customerId,
      currency: charge.currency,
      reason: dispute.reason,
    });
    if (recorded.kind === "proposed") {
      return {
        kind: "proposed",
        fireAt: recorded.fireAt,
        amountMinor: recorded.amountMinor,
        currency: recorded.currency,
        rowId: recorded.rowId,
        alerted: await this.alertProposal(recorded.rowId, now),
      };
    }
    // Raced another writer between the existence check and the insert.
    return { kind: "duplicate", state: "PENDING" };
  }

  // Post the proposal alert now, the same way the drain's first branch does.
  //
  // The engine can afford to leave this to the next tick. A hand-made proposal
  // cannot: at phase manual the drain never runs, so the alert would never be
  // posted, the row could never fire and Execute now would spend its first
  // press posting the alert instead of accepting the proposal.
  //
  // A failure here is the same fail-closed state the engine produces: the row
  // stands, unalerted, and therefore unexecutable, until an alert lands.
  private async alertProposal(rowId: string, now: Date): Promise<boolean> {
    if (!this.alerts) return false;
    const row = await this.store.byId(rowId).catch(() => null);
    if (!row) return false;
    const posted = await this.alerts.postProposal(row).catch(() => null);
    if (!posted) {
      autoLog.warn("hand-triggered proposal could not be alerted; it cannot fire until one lands", {
        "auto_resolve.id": rowId,
      });
      return false;
    }
    const fireAt = new Date(now.getTime() + this.settings.disputeAutoResolveVetoMinutes() * 60_000);
    await this.store.recordAlert(row.id, posted.channelId, posted.messageId, fireAt);
    return true;
  }

  // Sweep the open inquiries already in the mirror and propose on each.
  //
  // This is the cutover tool: turning the engine on only affects disputes that
  // arrive afterwards, because proposals are made from webhooks, so every
  // inquiry already on the books would otherwise stay invisible forever.
  //
  // Idempotent by construction: a dispute with a row is skipped before any
  // Stripe read, so re-pressing costs one query and tells you the same thing.
  async backfillOpenInquiries(now: Date = new Date()): Promise<BackfillResult> {
    const out: BackfillResult = {
      scanned: 0,
      proposed: 0,
      blocked: 0,
      duplicate: 0,
      outOfScope: 0,
      unavailable: 0,
      unalerted: 0,
      guardrails: {},
      remaining: 0,
    };
    if (this.settings.disputeResolveMode() === "none") return out;

    // Only the inquiry stage: a formal chargeback cannot be prevented by a
    // refund, which is the whole point of the pipeline.
    const page = await this.disputeStore.listOpen(0, BACKFILL_LIMIT, { status: "warning_needs_response" });
    out.remaining = Math.max(0, page.total - page.rows.length);

    for (const row of page.rows) {
      out.scanned++;
      const result = await this.proposeByHand(row.id, now).catch(
        (error): HandProposeResult => ({ kind: "unavailable", error: String(error) })
      );
      switch (result.kind) {
        case "proposed":
          out.proposed++;
          if (!result.alerted) out.unalerted++;
          break;
        case "blocked":
          out.blocked++;
          out.guardrails[result.guardrail] = (out.guardrails[result.guardrail] ?? 0) + 1;
          break;
        case "duplicate":
          out.duplicate++;
          break;
        case "out_of_scope":
          out.outOfScope++;
          break;
        default:
          out.unavailable++;
      }
    }
    autoLog.info("auto-resolve backfill swept the open inquiries", {
      "auto_resolve.scanned": out.scanned,
      "auto_resolve.proposed": out.proposed,
    });
    return out;
  }

  // Persists the decision and emits exactly one metric point for it, or none at
  // all when the engine was inert. A redelivered webhook re-reaches the same
  // row through the unique sourceId and emits nothing the second time.
  private async record(
    decision: AutoResolveDecision,
    ctx: {
      stage: AutoResolveStage;
      sourceId: string;
      disputeId: string | null;
      chargeId: string;
      customerId: string | null;
      currency: string;
      reason: string;
    }
  ): Promise<ProposeResult> {
    if (decision.kind === "inert") return { kind: "inert" };

    if (decision.kind === "block") {
      const { created } = await this.store.recordBlocked({
        ...ctx,
        amountMinor: 0,
        usdMinor: 0,
        guardrail: decision.guardrail,
      });
      if (!created) return { kind: "duplicate" };
      exportDisputeAutoResolve({
        stage: ctx.stage,
        outcome: "blocked",
        reason: ctx.reason,
        currency: ctx.currency,
        guardrail: decision.guardrail,
      });
      if (ctx.disputeId) {
        await this.events?.record({
          disputeId: ctx.disputeId,
          kind: "resolve_blocked",
          summary: `Auto-resolve declined: ${decision.guardrail.replace(/_/g, " ")}`,
          detail: { stage: ctx.stage, guardrail: decision.guardrail },
        });
      }
      autoLog.info("auto-resolve blocked", { "auto_resolve.source": ctx.sourceId, "auto_resolve.guardrail": decision.guardrail });
      return { kind: "blocked", guardrail: decision.guardrail };
    }

    const { created, row } = await this.store.propose({
      ...ctx,
      amountMinor: decision.amountMinor,
      usdMinor: decision.usdMinor,
      fireAt: decision.fireAt,
    });
    if (!created) return { kind: "duplicate" };
    exportDisputeAutoResolve({
      stage: ctx.stage,
      outcome: "proposed",
      reason: ctx.reason,
      currency: ctx.currency,
      amountMinor: decision.amountMinor,
      amountUsdMinor: decision.usdMinor,
    });
    if (ctx.disputeId) {
      await this.events?.record({
        disputeId: ctx.disputeId,
        kind: "resolve_proposed",
        summary: `Auto-resolve proposed: refund ${decision.amountMinor} ${ctx.currency.toUpperCase()} unless cancelled`,
        detail: { stage: ctx.stage, fireAt: decision.fireAt.toISOString(), amountMinor: decision.amountMinor },
      });
    }
    autoLog.info("auto-resolve proposed", {
      "auto_resolve.source": ctx.sourceId,
      "auto_resolve.stage": ctx.stage,
      "auto_resolve.fire_at": decision.fireAt.toISOString(),
    });
    return {
      kind: "proposed",
      fireAt: decision.fireAt,
      amountMinor: decision.amountMinor,
      currency: ctx.currency,
      rowId: row.id,
    };
  }

  // Rows a human has explicitly told to run now. Held in memory only: it is a
  // single-tick instruction, and losing it on a restart simply means the
  // operator presses Execute again rather than a refund firing unexpectedly.
  private forcedExecute = new Set<string>();

  // "Execute now", the manualplus path: a human accepting a proposal rather
  // than the veto window expiring. The drain still re-runs every live guardrail
  // before the refund, so accepting is not the same as overriding.
  async executeNow(rowId: string, now: Date = new Date()): Promise<DrainResult> {
    const row = await this.store.byId(rowId);
    const result: DrainResult = { executed: 0, blocked: 0, failed: 0, superseded: 0, alerted: 0 };
    if (!row || row.state !== "PENDING") return result;
    this.forcedExecute.add(rowId);
    try {
      await this.drainRow(row, now, result);
    } finally {
      this.forcedExecute.delete(rowId);
    }
    return result;
  }

  // Executes proposals whose veto window has expired. Called by the disputes
  // looper every hour.
  //
  // The ordering here is the whole safety argument:
  //   1. a row with no posted alert is never executed, it is alerted instead
  //   2. PENDING -> EXECUTING is a compare-and-set, so a veto racing the drain
  //      wins or loses cleanly and never half-wins
  //   3. every guardrail is re-run against LIVE Stripe state, because the
  //      window is hours old and the world moved
  //   4. the claim is keyed on the CHARGE, so an EFW row and an inquiry row for
  //      the same charge collide instead of refunding twice
  //   5. EXECUTED and the refund id are persisted BEFORE any side effect, so a
  //      crash in a side effect can never cause a second refund
  async drain(now: Date = new Date()): Promise<DrainResult> {
    const result: DrainResult = { executed: 0, blocked: 0, failed: 0, superseded: 0, alerted: 0 };
    const mode = this.settings.disputeResolveMode();
    if (!proposes(mode)) return result;

    const due = await this.store.claimDue(now, DRAIN_LIMIT);
    for (const row of due) {
      try {
        await this.drainRow(row, now, result);
      } catch (error) {
        autoLog.error("auto-resolve drain row failed", error, { "auto_resolve.id": row.id });
      }
    }
    return result;
  }

  private async drainRow(row: DisputeAutoResolve, now: Date, result: DrainResult): Promise<void> {
    // Finish the side effects of an already-executed row and stop. The money
    // moved on a previous tick; nothing here may touch Stripe again.
    if (row.state === "EXECUTED") {
      await this.runSideEffects(row);
      return;
    }

    // No alert on a channel means nobody could have vetoed this. Post it and
    // push the window out, so a misconfigured billing channel fails closed
    // rather than refunding in silence.
    if (!row.alertedAt) {
      const posted = await this.alerts?.postProposal(row).catch(() => null);
      if (!posted) {
        autoLog.warn("auto-resolve alert could not be posted; refund deferred", { "auto_resolve.id": row.id });
        return;
      }
      const fireAt = new Date(now.getTime() + this.settings.disputeAutoResolveVetoMinutes() * 60_000);
      await this.store.recordAlert(row.id, posted.channelId, posted.messageId, fireAt);
      result.alerted++;
      return;
    }

    // In manualplus the proposal waits for a human to press Execute, however
    // long its veto window says. The alert above has already gone out, so the
    // case is visible; it simply does not fire by itself.
    if (!autoExecutes(this.settings.disputeResolveMode()) && !this.forcedExecute.has(row.id)) return;

    // Reclaim a row abandoned by a crashed process, or take a pending one.
    const claimed =
      row.state === "EXECUTING"
        ? await this.store.casReclaim(row.id, now)
        : await this.store.casExecuting(row.id);
    // Lost the race to a veto or to another worker. Silence is correct here.
    if (!claimed) return;

    const live = await this.liveGuardrails(row);
    if (live.kind === "superseded") {
      // A human already refunded inside the window. The engine's goal is met,
      // so nothing is emitted: a blocked point here would be a lie.
      await this.store.markSuperseded(row.id);
      result.superseded++;
      return;
    }
    if (live.kind === "block") {
      await this.store.markBlocked(row.id, live.guardrail);
      exportDisputeAutoResolve({
        stage: row.stage as AutoResolveStage,
        outcome: "blocked",
        reason: row.reason,
        currency: row.currency,
        guardrail: live.guardrail,
      });
      await this.alerts?.postBlocked({ ...row, guardrail: live.guardrail }).catch(() => {});
      result.blocked++;
      return;
    }

    // Keyed on the charge, not the row: two stages on one charge must collide.
    const claimKey = `dispute-autoresolve-${row.chargeId}`;
    const held = await this.sessionStore
      ?.claimBillingAction("system", claimKey, "dispute_autoresolve")
      .catch(() => false);
    if (this.sessionStore && !held) {
      await this.store.markBlocked(row.id, "already_claimed");
      exportDisputeAutoResolve({
        stage: row.stage as AutoResolveStage,
        outcome: "blocked",
        reason: row.reason,
        currency: row.currency,
        guardrail: "already_claimed",
      });
      result.blocked++;
      return;
    }

    let refund: { refundId: string; amount: number; currency: string };
    try {
      refund = await this.stripe.refundChargeAmount(
        row.chargeId,
        live.amountMinor,
        // Idempotency keyed on the charge for the same reason as the claim.
        `dp-autoresolve-${row.chargeId}`,
        // NEVER "fraudulent": that value also adds the card and email to
        // Stripe's native block lists, and auto-resolve is not allowed to block.
        refundReasonFor(row.stage as AutoResolveStage, row.disputeId ? row.reason : null)
      );
    } catch (error) {
      await this.sessionStore?.releaseBillingAction(claimKey).catch(() => {});
      const outcome = await this.store.markRetryable(row.id, String(error), MAX_ATTEMPTS);
      if (outcome === "failed") {
        exportDisputeAutoResolve({
          stage: row.stage as AutoResolveStage,
          outcome: "failed",
          reason: row.reason,
          currency: row.currency,
        });
        await this.alerts?.postFailed(row, String(error)).catch(() => {});
        result.failed++;
      }
      autoLog.error("auto-resolve refund failed", error, { "auto_resolve.id": row.id, "auto_resolve.outcome": outcome });
      return;
    }

    // Money moved. Persist FIRST: from here the claim is never released, on the
    // same principle the refund core uses.
    await this.store.markExecuted(row.id, refund.refundId);
    exportDisputeAutoResolve({
      stage: row.stage as AutoResolveStage,
      outcome: "executed",
      reason: row.reason,
      currency: row.currency,
      // The charge's own currency, never the USD comparison value.
      amountMinor: refund.amount,
      // An admin accepting the proposal, rather than the window expiring.
      humanTriggered: this.forcedExecute.has(row.id),
    });
    result.executed++;
    if (row.disputeId) {
      await this.events?.record({
        disputeId: row.disputeId,
        kind: "resolve_executed",
        summary: `Auto-resolve refunded ${refund.amount} ${refund.currency.toUpperCase()} to prevent the dispute`,
        detail: { refundId: refund.refundId, chargeId: row.chargeId, stage: row.stage },
      });
    }
    autoLog.info("auto-resolve executed", {
      "auto_resolve.id": row.id,
      "stripe.refund_id": refund.refundId,
      "stripe.charge_id": row.chargeId,
    });

    const executed = { ...row, state: "EXECUTED", refundId: refund.refundId };
    await this.alerts
      ?.postExecuted(executed, this.stripe.formatAmount(refund.amount, refund.currency))
      .catch(() => {});
    await this.runSideEffects(executed);
  }

  // Re-runs every guardrail against live Stripe state. The veto window is hours
  // wide, and surviving that drift is exactly what it is for.
  private async liveGuardrails(
    row: DisputeAutoResolve
  ): Promise<{ kind: "ok"; amountMinor: number } | { kind: "block"; guardrail: Guardrail } | { kind: "superseded" }> {
    const charge = await this.stripe.getCharge(row.chargeId);

    // Did a human do it for us while the window ran? Any refund created after
    // the proposal is theirs, not ours.
    const humanRefund = (charge.refunds?.data ?? []).some((r) => r.created * 1000 > row.createdAt.getTime());
    if (charge.refunded && humanRefund) return { kind: "superseded" };

    if (charge.refunded) return { kind: "block", guardrail: "already_refunded" };
    const remainder = refundableRemainder(charge);
    if (remainder <= 0) return { kind: "block", guardrail: "no_remainder" };

    if (row.disputeId) {
      const dispute = await this.stripe.getDispute(row.disputeId);
      // The case moved on: it is a chargeback now, or already closed, and a
      // refund can no longer prevent anything.
      if (dispute.status !== "warning_needs_response") return { kind: "block", guardrail: "not_refundable" };
      if (dispute.is_charge_refundable === false) return { kind: "block", guardrail: "not_refundable" };
      // A partial refund does not close a dispute as prevented.
      if (remainder < dispute.amount) return { kind: "block", guardrail: "no_remainder" };
    }
    return { kind: "ok", amountMinor: remainder };
  }

  // Each side effect is stamped separately, so the drain can re-attempt one
  // without re-attempting the other and without ever re-refunding.
  private async runSideEffects(row: DisputeAutoResolve): Promise<void> {
    if (!row.customerId) return;
    if (!row.subsCancelledAt) {
      try {
        await this.sideEffects?.cancelSubscriptions(row.customerId, `dp-autoresolve-${row.sourceId}`);
        await this.store.stampSideEffect(row.id, "subs");
      } catch (error) {
        autoLog.warn("auto-resolve subscription cancel failed", {
          "auto_resolve.id": row.id,
          "error.message": String(error),
        });
      }
    }
    if (!row.intercomNotedAt) {
      try {
        await this.sideEffects?.noteOnCustomer(
          row.customerId,
          `Stripe ${row.stage === "efw" ? "fraud warning" : "dispute"} auto-resolved: the charge ${row.chargeId} was refunded in full to prevent a chargeback, and any active subscription was cancelled. Do not issue a further refund or concession for this charge.`
        );
        await this.store.stampSideEffect(row.id, "intercom");
      } catch (error) {
        autoLog.warn("auto-resolve intercom note failed", { "auto_resolve.id": row.id, "error.message": String(error) });
      }
    }
  }

}
