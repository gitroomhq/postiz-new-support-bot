import type Stripe from "stripe";
import type { SettingsStore } from "../../config/SettingsStore";
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
} from "./autoResolvePolicy";
import { exportDisputeAutoResolve } from "../../metrics/MetricsExporter";
import { log } from "../../util/logger";

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

export class AutoResolveService {
  constructor(
    private settings: SettingsStore,
    private stripe: StripeClient,
    private store: AutoResolveStore,
    private disputeStore: DisputeStore
  ) {}

  config(): AutoResolveConfig {
    return {
      enabled: this.settings.disputeAutoResolveEnabled(),
      efwEnabled: this.settings.disputeAutoResolveEfw(),
      maxUsdMinor: this.settings.disputeAutoResolveMaxUsdMinor(),
      vetoMinutes: this.settings.disputeAutoResolveVetoMinutes(),
      reasons: this.settings.disputeAutoResolveReasons(),
    };
  }

  // Cheap pre-check so a disabled engine costs no Stripe reads at all.
  private enabledFor(stage: AutoResolveStage): boolean {
    if (!this.settings.disputeAutoResolveEnabled()) return false;
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
    });
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
}
