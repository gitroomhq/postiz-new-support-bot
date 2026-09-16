import type Stripe from "stripe";
import { isChargebackStage } from "./disputeRatio";
import { toUsdMinor } from "./fx";

// The auto-resolve decision, kept PURE (Stripe types only, no prisma, no
// discord.js) for the same reason disputeRatio.ts is: the rule that decides
// whether money leaves the account without a human pressing anything should be
// readable and testable in one file, with no IO to mock.
//
// THE PREMISE. Refunding a dispute while it is still at the inquiry stage
// (warning_needs_response) makes Stripe close it as "prevented". A prevented
// dispute never becomes a chargeback, so it never enters the numerator that
// isChargebackStage() defines and the account's dispute ratio never sees it.
// Once a dispute IS at chargeback stage the case is already counted: refunding
// then spends the money and changes no ratio at all. That is why this engine
// refuses anything isChargebackStage() calls true, and why that refusal is a
// correctness invariant rather than a policy knob.

export type AutoResolveStage = "inquiry" | "efw";

// Why an in-scope case was not acted on. This vocabulary is a metric tag
// (dispute_auto_resolve.guardrail) and a Grafana dashboard describes it, so it
// stays bounded: add a value here and nowhere else.
export type Guardrail =
  | "already_refunded"
  | "not_refundable"
  | "no_remainder"
  | "reason_not_allowed"
  | "currency_unsupported"
  | "over_threshold"
  | "no_customer"
  | "repeat_offender"
  | "already_claimed";

export interface AutoResolveConfig {
  enabled: boolean;
  efwEnabled: boolean;
  maxUsdMinor: number;
  vetoMinutes: number;
  reasons: ReadonlySet<string>;
}

// "inert" is deliberately distinct from "block". A case the engine has nothing
// to say about (the feature is off, or this is a chargeback no refund can
// prevent) produces NO metric point and NO alert line. A case it wanted to act
// on but could not produces both. Without that split, a default-off feature
// would emit a blocked point for every dispute the account ever receives.
export type AutoResolveDecision =
  | { kind: "inert" }
  | { kind: "propose"; amountMinor: number; usdMinor: number; fireAt: Date }
  | { kind: "block"; guardrail: Guardrail };

function chargeIdOf(obj: { charge: string | { id: string } | null }): string | null {
  return typeof obj.charge === "string" ? obj.charge : (obj.charge?.id ?? null);
}

export function customerIdOf(charge: Stripe.Charge): string | null {
  return typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null);
}

// What a refund would actually move: the whole un-refunded remainder. Never
// dispute.amount, which can be smaller than the charge on a partial dispute.
export function refundableRemainder(charge: Stripe.Charge): number {
  return charge.amount - (charge.amount_refunded ?? 0);
}

// Guardrails that read only the charge, shared by both stages.
function chargeGuardrails(charge: Stripe.Charge, remainder: number): Guardrail | null {
  if (charge.refunded) return "already_refunded";
  if (remainder <= 0) return "no_remainder";
  return null;
}

// Guardrails that read the money figures, shared by both stages.
function amountGuardrails(amountMinor: number, currency: string, cfg: AutoResolveConfig): Guardrail | null {
  const usd = toUsdMinor(amountMinor, currency);
  if (usd == null) return "currency_unsupported";
  if (usd > cfg.maxUsdMinor) return "over_threshold";
  return null;
}

function proposal(amountMinor: number, currency: string, cfg: AutoResolveConfig, now: Date): AutoResolveDecision {
  return {
    kind: "propose",
    amountMinor,
    // Non-null: amountGuardrails already rejected an unconvertible currency.
    usdMinor: toUsdMinor(amountMinor, currency) as number,
    fireAt: new Date(now.getTime() + cfg.vetoMinutes * 60_000),
  };
}

// An inquiry-stage dispute we could prevent by refunding the charge outright.
//
// `repeat` is the caller's answer to "has this customer had a dispute or an
// auto-resolve inside the configured window": it needs the database, so it does
// not belong in here.
export function evaluateDispute(
  dispute: Stripe.Dispute,
  charge: Stripe.Charge,
  cfg: AutoResolveConfig,
  repeat: boolean,
  now: Date
): AutoResolveDecision {
  if (!cfg.enabled) return { kind: "inert" };

  // Out of scope entirely, so no alert line and no metric point. A chargeback
  // is already in the ratio; a dispute past the response window cannot be
  // prevented by anything we do.
  if (dispute.status !== "warning_needs_response") return { kind: "inert" };
  if (isChargebackStage(dispute)) return { kind: "inert" };

  const remainder = refundableRemainder(charge);
  const blocked = chargeGuardrails(charge, remainder);
  if (blocked) return { kind: "block", guardrail: blocked };

  // Stripe's own verdict on whether a refund is still possible on this charge.
  if (dispute.is_charge_refundable === false) return { kind: "block", guardrail: "not_refundable" };

  // A PARTIAL refund does not prevent a dispute. Stripe closes the case as
  // prevented only when the disputed amount is returned in full, so a
  // remainder short of the dispute amount would spend the money AND still take
  // the chargeback. Refuse instead of half-paying.
  if (remainder < dispute.amount) return { kind: "block", guardrail: "no_remainder" };

  if (!cfg.reasons.has(dispute.reason)) return { kind: "block", guardrail: "reason_not_allowed" };

  const amountBlocked = amountGuardrails(remainder, charge.currency, cfg);
  if (amountBlocked) return { kind: "block", guardrail: amountBlocked };

  // A guest charge has nobody to cancel subscriptions for or note against, and
  // no history to check for repeat abuse. Leave it to a human.
  if (!customerIdOf(charge)) return { kind: "block", guardrail: "no_customer" };

  // Refunding a serial disputer teaches them the route works. Block, alert, and
  // let a human decide whether to fight it and block the card.
  if (repeat) return { kind: "block", guardrail: "repeat_offender" };

  return proposal(remainder, charge.currency, cfg, now);
}

// An early fraud warning: the network telling us a chargeback is coming on a
// charge that has not been disputed yet. Refunding now stops the dispute from
// being filed at all.
//
// NOTE on the reason allowlist: it deliberately does NOT apply here. An EFW
// carries a fraud_type (made_with_stolen_card, unauthorized_use_of_card, and so
// on), which is a different vocabulary from a dispute reason, and every value
// in it is a fraud value. Applying the dispute allowlist would reject every EFW
// that exists. The gate for this stage is Stripe's own `actionable` flag plus
// the separate efwEnabled toggle, both of which are stricter than a reason
// list would be.
export function evaluateEfw(
  efw: Stripe.Radar.EarlyFraudWarning,
  charge: Stripe.Charge,
  cfg: AutoResolveConfig,
  repeat: boolean,
  now: Date
): AutoResolveDecision {
  if (!cfg.enabled || !cfg.efwEnabled) return { kind: "inert" };

  // Stripe sets actionable when refunding the charge would actually prevent the
  // dispute. When it is false, a refund spends the money and the chargeback
  // arrives anyway.
  if (!efw.actionable) return { kind: "inert" };
  if (charge.status !== "succeeded") return { kind: "inert" };
  if (chargeIdOf(efw) == null) return { kind: "inert" };

  const remainder = refundableRemainder(charge);
  const blocked = chargeGuardrails(charge, remainder);
  if (blocked) return { kind: "block", guardrail: blocked };

  const amountBlocked = amountGuardrails(remainder, charge.currency, cfg);
  if (amountBlocked) return { kind: "block", guardrail: amountBlocked };

  if (!customerIdOf(charge)) return { kind: "block", guardrail: "no_customer" };
  if (repeat) return { kind: "block", guardrail: "repeat_offender" };

  return proposal(remainder, charge.currency, cfg, now);
}

// The Stripe refund reason to send. NEVER "fraudulent": that value
// additionally puts the card and the email on Stripe's native block lists (see
// StripeClient.refundChargeAmount), and auto-resolve is explicitly not allowed
// to block anyone. Blocking stays a deliberate human action in the disputes
// console.
export function refundReasonFor(stage: AutoResolveStage, disputeReason: string | null): Stripe.RefundCreateParams.Reason {
  if (stage === "inquiry" && disputeReason === "duplicate") return "duplicate";
  return "requested_by_customer";
}
