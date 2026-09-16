import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { isChargebackStage } from "../../bot/billing/disputeRatio";
import { isConvertible, minorUnitsPerMajor, toUsdMinor } from "../../bot/billing/fx";
import {
  customerIdOf,
  evaluateDispute,
  evaluateEfw,
  refundableRemainder,
  refundReasonFor,
  type AutoResolveConfig,
} from "../../bot/billing/autoResolvePolicy";

// Minimal fabricators, same shape as disputeRatio.test.ts: only the fields the
// policy actually reads.
const charge = (p: {
  amount?: number;
  refunded?: number;
  currency?: string;
  customer?: string | null;
  status?: string;
  fullyRefunded?: boolean;
}): Stripe.Charge =>
  ({
    id: "ch_test",
    amount: p.amount ?? 2000,
    amount_refunded: p.refunded ?? 0,
    currency: p.currency ?? "usd",
    customer: p.customer === undefined ? "cus_1" : p.customer,
    status: p.status ?? "succeeded",
    refunded: p.fullyRefunded ?? false,
  }) as unknown as Stripe.Charge;

const dispute = (p: {
  amount?: number;
  reason?: string;
  status?: string;
  refundable?: boolean;
  caseType?: "chargeback" | "inquiry";
}): Stripe.Dispute =>
  ({
    id: "dp_test",
    charge: "ch_test",
    amount: p.amount ?? 2000,
    currency: "usd",
    created: 0,
    reason: p.reason ?? "subscription_canceled",
    status: p.status ?? "warning_needs_response",
    is_charge_refundable: p.refundable ?? true,
    ...(p.caseType ? { payment_method_details: { card: { case_type: p.caseType }, type: "card" } } : {}),
  }) as unknown as Stripe.Dispute;

const efw = (p: { actionable?: boolean; fraudType?: string }): Stripe.Radar.EarlyFraudWarning =>
  ({
    id: "issfr_test",
    charge: "ch_test",
    created: 0,
    actionable: p.actionable ?? true,
    fraud_type: p.fraudType ?? "made_with_stolen_card",
  }) as unknown as Stripe.Radar.EarlyFraudWarning;

// The shipped defaults: 6000 USD cents, the four-reason allowlist, 120 minutes.
const cfg = (over: Partial<AutoResolveConfig> = {}): AutoResolveConfig => ({
  enabled: true,
  efwEnabled: true,
  maxUsdMinor: 6000,
  vetoMinutes: 120,
  reasons: new Set(["subscription_canceled", "duplicate", "credit_not_processed", "product_unacceptable"]),
  ...over,
});

const NOW = new Date("2026-09-16T12:00:00.000Z");

// ---- FX: the minor-unit exponent, which is where the money-losing bug lives ----

test("fx: minor units per major follow Stripe's zero/two/three-decimal split", () => {
  assert.equal(minorUnitsPerMajor("usd"), 100);
  assert.equal(minorUnitsPerMajor("eur"), 100);
  assert.equal(minorUnitsPerMajor("jpy"), 1);
  assert.equal(minorUnitsPerMajor("JPY"), 1, "currency casing must not change the exponent");
  assert.equal(minorUnitsPerMajor("krw"), 1);
  assert.equal(minorUnitsPerMajor("clp"), 1);
  assert.equal(minorUnitsPerMajor("kwd"), 1000);
  assert.equal(minorUnitsPerMajor("bhd"), 1000);
});

test("fx: a zero-decimal amount is NOT hundredths, so a large JPY charge is over the threshold", () => {
  // 20000 JPY is about 134 USD. Treating the minor amount as cents would read
  // it as 200 yen, about 1.34 USD, and wave a charge twice the limit through.
  const usd = toUsdMinor(20000, "jpy");
  assert.ok(usd != null);
  assert.ok(usd > 6000, `20000 JPY should exceed a 60 USD threshold, got ${usd} cents`);
  // The buggy reading, asserted explicitly so the regression is named.
  assert.ok(Math.ceil((20000 / 100) * 0.0067 * 100) < 6000);

  const d = evaluateDispute(
    dispute({ amount: 20000 }),
    charge({ amount: 20000, currency: "jpy" }),
    cfg(),
    false,
    NOW
  );
  assert.deepEqual(d, { kind: "block", guardrail: "over_threshold" });
});

test("fx: a three-decimal amount is thousandths, so a small KWD charge is under the threshold", () => {
  // 10000 KWD-minor is 10 KWD, about 32.60 USD. Reading it as cents would make
  // it 100 KWD, about 326 USD, and block a charge well inside the limit.
  const usd = toUsdMinor(10000, "kwd");
  assert.ok(usd != null);
  assert.ok(usd < 6000, `10 KWD should sit under a 60 USD threshold, got ${usd} cents`);
  assert.ok(Math.ceil((10000 / 100) * 3.26 * 100) > 6000);

  const d = evaluateDispute(
    dispute({ amount: 10000 }),
    charge({ amount: 10000, currency: "kwd" }),
    cfg(),
    false,
    NOW
  );
  assert.equal(d.kind, "propose");
});

test("fx: an unsupported currency is null and never a pass", () => {
  assert.equal(toUsdMinor(100, "xyz"), null);
  assert.equal(isConvertible("xyz"), false);
  assert.equal(isConvertible("eur"), true);
  const d = evaluateDispute(dispute({}), charge({ currency: "xyz" }), cfg(), false, NOW);
  assert.deepEqual(d, { kind: "block", guardrail: "currency_unsupported" });
});

test("fx: conversion rounds UP, so an inexact amount blocks rather than slips through", () => {
  // 1 JPY is 0.67 cents; ceil makes it 1, never 0.
  assert.equal(toUsdMinor(1, "jpy"), 1);
  assert.equal(toUsdMinor(0, "usd"), 0);
  assert.equal(toUsdMinor(1, "usd"), 1);
  assert.equal(toUsdMinor(NaN, "usd"), null);
});

// ---- Scope: the invariant the whole feature rests on ----

test("policy: only inquiry-stage disputes are in scope, and every accepted one is off the ratio", () => {
  const accepted = dispute({ status: "warning_needs_response" });
  assert.equal(isChargebackStage(accepted), false, "an accepted dispute must never be in the chargeback numerator");
  assert.equal(evaluateDispute(accepted, charge({}), cfg(), false, NOW).kind, "propose");

  // Out of scope entirely: no alert line, no metric point.
  for (const status of ["needs_response", "under_review", "won", "lost", "warning_under_review", "warning_closed"]) {
    assert.deepEqual(
      evaluateDispute(dispute({ status }), charge({}), cfg(), false, NOW),
      { kind: "inert" },
      `status ${status} must be inert`
    );
  }
});

test("policy: a card case_type of chargeback is refused even at warning_needs_response", () => {
  const d = dispute({ status: "warning_needs_response", caseType: "chargeback" });
  assert.equal(isChargebackStage(d), true);
  assert.deepEqual(evaluateDispute(d, charge({}), cfg(), false, NOW), { kind: "inert" });
});

test("policy: the master toggle produces inert, never a blocked point", () => {
  assert.deepEqual(evaluateDispute(dispute({}), charge({}), cfg({ enabled: false }), false, NOW), { kind: "inert" });
  assert.deepEqual(evaluateEfw(efw({}), charge({}), cfg({ enabled: false }), false, NOW), { kind: "inert" });
  assert.deepEqual(evaluateEfw(efw({}), charge({}), cfg({ efwEnabled: false }), false, NOW), { kind: "inert" });
});

// ---- Guardrails ----

test("policy: the threshold boundary is inclusive, one cent over blocks", () => {
  assert.equal(evaluateDispute(dispute({ amount: 6000 }), charge({ amount: 6000 }), cfg(), false, NOW).kind, "propose");
  assert.deepEqual(evaluateDispute(dispute({ amount: 6001 }), charge({ amount: 6001 }), cfg(), false, NOW), {
    kind: "block",
    guardrail: "over_threshold",
  });
});

test("policy: the reason allowlist tolerates whitespace and casing from /config", () => {
  const configured = " Subscription_Canceled , duplicate ,, ".split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
  const reasons = new Set(configured);
  assert.equal(evaluateDispute(dispute({ reason: "duplicate" }), charge({}), cfg({ reasons }), false, NOW).kind, "propose");
  assert.equal(
    evaluateDispute(dispute({ reason: "subscription_canceled" }), charge({}), cfg({ reasons }), false, NOW).kind,
    "propose"
  );
  assert.deepEqual(evaluateDispute(dispute({ reason: "fraudulent" }), charge({}), cfg({ reasons }), false, NOW), {
    kind: "block",
    guardrail: "reason_not_allowed",
  });
});

test("policy: a charge Stripe will not refund is blocked, not attempted", () => {
  assert.deepEqual(evaluateDispute(dispute({ refundable: false }), charge({}), cfg(), false, NOW), {
    kind: "block",
    guardrail: "not_refundable",
  });
  assert.deepEqual(evaluateDispute(dispute({}), charge({ fullyRefunded: true }), cfg(), false, NOW), {
    kind: "block",
    guardrail: "already_refunded",
  });
});

test("policy: a remainder short of the dispute amount blocks, because a partial refund prevents nothing", () => {
  // 20.00 charge, 15.00 already refunded, 20.00 disputed: returning the
  // remaining 5.00 would spend money AND still take the chargeback.
  const d = evaluateDispute(dispute({ amount: 2000 }), charge({ amount: 2000, refunded: 1500 }), cfg(), false, NOW);
  assert.deepEqual(d, { kind: "block", guardrail: "no_remainder" });
  assert.equal(refundableRemainder(charge({ amount: 2000, refunded: 1500 })), 500);
});

test("policy: a guest charge and a repeat disputer both block", () => {
  assert.deepEqual(evaluateDispute(dispute({}), charge({ customer: null }), cfg(), false, NOW), {
    kind: "block",
    guardrail: "no_customer",
  });
  assert.deepEqual(evaluateDispute(dispute({}), charge({}), cfg(), true, NOW), {
    kind: "block",
    guardrail: "repeat_offender",
  });
  assert.equal(customerIdOf(charge({})), "cus_1");
  assert.equal(customerIdOf(charge({ customer: null })), null);
});

test("policy: a proposal refunds the whole remainder and fires after the veto window", () => {
  const d = evaluateDispute(dispute({ amount: 1500 }), charge({ amount: 2000, refunded: 500 }), cfg(), false, NOW);
  assert.equal(d.kind, "propose");
  if (d.kind !== "propose") return;
  assert.equal(d.amountMinor, 1500, "the refund moves the remainder, not the dispute amount");
  assert.equal(d.usdMinor, 1500);
  assert.equal(d.fireAt.getTime(), NOW.getTime() + 120 * 60_000);

  const immediate = evaluateDispute(dispute({}), charge({}), cfg({ vetoMinutes: 0 }), false, NOW);
  assert.equal(immediate.kind, "propose");
  if (immediate.kind !== "propose") return;
  assert.equal(immediate.fireAt.getTime(), NOW.getTime(), "a zero window is due immediately");
});

// ---- Early fraud warnings ----

test("policy: an EFW needs Stripe's actionable flag, and skips the dispute reason allowlist", () => {
  assert.equal(evaluateEfw(efw({ actionable: true }), charge({}), cfg(), false, NOW).kind, "propose");
  assert.deepEqual(evaluateEfw(efw({ actionable: false }), charge({}), cfg(), false, NOW), { kind: "inert" });
  // fraud_type is a different vocabulary from a dispute reason; applying the
  // allowlist here would reject every EFW that exists.
  assert.equal(
    evaluateEfw(efw({ fraudType: "unauthorized_use_of_card" }), charge({}), cfg({ reasons: new Set() }), false, NOW).kind,
    "propose"
  );
});

test("policy: an EFW on a charge that did not succeed is out of scope", () => {
  assert.deepEqual(evaluateEfw(efw({}), charge({ status: "failed" }), cfg(), false, NOW), { kind: "inert" });
});

test("policy: an EFW obeys the same amount, customer and repeat guardrails", () => {
  assert.deepEqual(evaluateEfw(efw({}), charge({ amount: 9000 }), cfg(), false, NOW), {
    kind: "block",
    guardrail: "over_threshold",
  });
  assert.deepEqual(evaluateEfw(efw({}), charge({ customer: null }), cfg(), false, NOW), {
    kind: "block",
    guardrail: "no_customer",
  });
  assert.deepEqual(evaluateEfw(efw({}), charge({}), cfg(), true, NOW), {
    kind: "block",
    guardrail: "repeat_offender",
  });
});

// ---- The refund reason, which carries a silent side effect ----

test("policy: the refund reason is never fraudulent, because that blocklists at Stripe", () => {
  assert.equal(refundReasonFor("inquiry", "duplicate"), "duplicate");
  assert.equal(refundReasonFor("inquiry", "subscription_canceled"), "requested_by_customer");
  assert.equal(refundReasonFor("inquiry", "fraudulent"), "requested_by_customer");
  assert.equal(refundReasonFor("efw", null), "requested_by_customer");
  for (const stage of ["inquiry", "efw"] as const) {
    for (const reason of ["fraudulent", "duplicate", "general", null]) {
      assert.notEqual(refundReasonFor(stage, reason), "fraudulent");
    }
  }
});

// ---- the drain: where money actually moves ----

import { AutoResolveService } from "../../bot/billing/AutoResolveService";

type Row = Record<string, unknown>;

const row = (over: Row = {}): Row => ({
  id: "cjld2cjxh0000qzrmn831i7rn",
  stage: "inquiry",
  sourceId: "dp_1",
  disputeId: "dp_1",
  chargeId: "ch_1",
  customerId: "cus_1",
  amountMinor: 2000,
  currency: "usd",
  usdMinor: 2000,
  reason: "subscription_canceled",
  state: "PENDING",
  guardrail: null,
  fireAt: new Date("2026-09-16T10:00:00.000Z"),
  alertedAt: new Date("2026-09-16T08:00:00.000Z"),
  refundId: null,
  subsCancelledAt: new Date(),
  intercomNotedAt: new Date(),
  attempts: 0,
  createdAt: new Date("2026-09-16T08:00:00.000Z"),
  ...over,
});

function drainHarness(opts: { rows: Row[]; charge?: Stripe.Charge; dispute?: Stripe.Dispute; casOk?: boolean }) {
  const calls: string[] = [];
  const store = {
    claimDue: async () => opts.rows,
    casExecuting: async () => {
      calls.push("cas");
      return opts.casOk !== false;
    },
    casReclaim: async () => opts.casOk !== false,
    recordAlert: async () => {
      calls.push("recordAlert");
    },
    markExecuted: async (_id: string, refundId: string) => {
      calls.push(`executed:${refundId}`);
    },
    markBlocked: async (_id: string, g: string) => {
      calls.push(`blocked:${g}`);
    },
    markSuperseded: async () => {
      calls.push("superseded");
    },
    markRetryable: async () => "retry" as const,
    stampSideEffect: async () => {},
  };
  const alerts = {
    postProposal: async () => {
      calls.push("postProposal");
      return { channelId: "c", messageId: "m" };
    },
    postBlocked: async () => {
      calls.push("postBlocked");
    },
    postExecuted: async () => {},
    postFailed: async () => {},
  };
  const stripe = {
    getCharge: async () => opts.charge ?? charge({}),
    getDispute: async () => opts.dispute ?? dispute({}),
    refundChargeAmount: async (chargeId: string, amountMinor: number, key: string, reason: string) => {
      calls.push(`refund:${chargeId}:${amountMinor}:${key}:${reason}`);
      return { refundId: "re_1", amount: amountMinor, currency: "usd", status: "succeeded" };
    },
    formatAmount: (a: number) => `$${(a / 100).toFixed(2)}`,
  };
  const svc = new AutoResolveService(
    { disputeAutoResolveEnabled: () => true, disputeAutoResolveVetoMinutes: () => 120 } as never,
    stripe as never,
    store as never,
    {} as never,
    { claimBillingAction: async () => true, releaseBillingAction: async () => {} } as never,
    alerts as never,
    { cancelSubscriptions: async () => {}, noteOnCustomer: async () => {} } as never
  );
  return { svc, calls };
}

test("drain: a row with no posted alert is alerted, never refunded", async () => {
  // The invariant that makes the veto window real: an unreachable billing
  // channel must fail closed, not refund in silence.
  const h = drainHarness({ rows: [row({ alertedAt: null })] });
  const result = await h.svc.drain(new Date("2026-09-16T12:00:00.000Z"));
  assert.deepEqual(h.calls, ["postProposal", "recordAlert"]);
  assert.equal(result.executed, 0);
  assert.equal(result.alerted, 1);
  assert.ok(!h.calls.some((c) => c.startsWith("refund:")));
});

test("drain: losing the compare-and-set to a veto refunds nothing, silently", async () => {
  const h = drainHarness({ rows: [row()], casOk: false });
  const result = await h.svc.drain(new Date("2026-09-16T12:00:00.000Z"));
  assert.deepEqual(h.calls, ["cas"]);
  assert.equal(result.executed, 0);
});

test("drain: the refund is keyed on the CHARGE and never uses the fraudulent reason", async () => {
  const h = drainHarness({ rows: [row()] });
  await h.svc.drain(new Date("2026-09-16T12:00:00.000Z"));
  const refund = h.calls.find((c) => c.startsWith("refund:"));
  assert.ok(refund, "a refund should have been made");
  // Keyed on the charge so an EFW row and an inquiry row for the same charge
  // collide by design instead of refunding it twice.
  assert.ok(refund.includes("dp-autoresolve-ch_1"), refund);
  assert.ok(!refund.includes("fraudulent"), "fraudulent would also blocklist at Stripe");
  assert.ok(refund.endsWith("requested_by_customer"), refund);
});

test("drain: live guardrails are re-run, and a human refund inside the window supersedes", async () => {
  // Superseded emits nothing and blocks nothing: a human did the thing the
  // engine wanted, so a blocked point here would be a lie.
  const refundedByHuman = charge({ fullyRefunded: true, refunded: 2000 });
  // Only `created` is read, and only to tell a human's refund from ours.
  (refundedByHuman as unknown as { refunds: { data: Array<{ created: number }> } }).refunds = {
    data: [{ created: Math.floor(new Date("2026-09-16T09:00:00.000Z").getTime() / 1000) }],
  };
  const h = drainHarness({ rows: [row()], charge: refundedByHuman });
  const result = await h.svc.drain(new Date("2026-09-16T12:00:00.000Z"));
  assert.equal(result.superseded, 1);
  assert.equal(result.executed, 0);
  assert.ok(h.calls.includes("superseded"));
});

test("drain: a dispute that became a chargeback during the window is blocked, not refunded", async () => {
  const h = drainHarness({ rows: [row()], dispute: dispute({ status: "needs_response" }) });
  const result = await h.svc.drain(new Date("2026-09-16T12:00:00.000Z"));
  assert.equal(result.blocked, 1);
  assert.equal(result.executed, 0);
  assert.ok(h.calls.includes("blocked:not_refundable"));
  assert.ok(h.calls.includes("postBlocked"), "a blocked case still reaches a human");
});

test("drain: the master toggle makes the drain a no-op", async () => {
  const h = drainHarness({ rows: [row()] });
  const off = new AutoResolveService(
    { disputeAutoResolveEnabled: () => false } as never,
    {} as never,
    { claimDue: async () => [] } as never,
    {} as never
  );
  assert.deepEqual(await off.drain(), { executed: 0, blocked: 0, failed: 0, superseded: 0, alerted: 0 });
  assert.equal(h.calls.length, 0);
});
