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

function drainHarness(opts: {
  rows: Row[];
  charge?: Stripe.Charge;
  dispute?: Stripe.Dispute;
  casOk?: boolean;
  mode?: "none" | "manual" | "manualplus" | "auto";
}) {
  const calls: string[] = [];
  const store = {
    claimDue: async () => opts.rows,
    byId: async (id: string) => opts.rows.find((r) => r.id === id) ?? null,
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
    { disputeResolveMode: () => opts.mode ?? "auto", disputeAutoResolveVetoMinutes: () => 120 } as never,
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

test("drain: manualplus alerts and waits, and never refunds on its own", async () => {
  // The whole point of the phase: the case is visible and a human decides.
  const h = drainHarness({ rows: [row()], mode: "manualplus" });
  const result = await h.svc.drain(new Date("2026-09-16T12:00:00.000Z"));
  assert.equal(result.executed, 0);
  assert.ok(!h.calls.some((c) => c.startsWith("refund:")), "manualplus must not move money");
  assert.ok(!h.calls.includes("cas"), "and must not even claim the row");
});

test("drain: manualplus still posts the alert for a row that has none", async () => {
  const h = drainHarness({ rows: [row({ alertedAt: null })], mode: "manualplus" });
  const result = await h.svc.drain(new Date("2026-09-16T12:00:00.000Z"));
  assert.equal(result.alerted, 1);
  assert.deepEqual(h.calls, ["postProposal", "recordAlert"]);
});

test("executeNow: a human accepting a proposal refunds, but still re-checks every guardrail", async () => {
  const h = drainHarness({ rows: [row()], mode: "manualplus" });
  const result = await h.svc.executeNow("cjld2cjxh0000qzrmn831i7rn", new Date("2026-09-16T12:00:00.000Z"));
  assert.equal(result.executed, 1);
  assert.ok(h.calls.some((c) => c.startsWith("refund:")));

  // Accepting is not overriding: a dispute that became a chargeback still blocks.
  const moved = drainHarness({ rows: [row()], dispute: dispute({ status: "needs_response" }), mode: "manualplus" });
  const blocked = await moved.svc.executeNow("cjld2cjxh0000qzrmn831i7rn", new Date("2026-09-16T12:00:00.000Z"));
  assert.equal(blocked.executed, 0);
  assert.equal(blocked.blocked, 1);
});

test("drain: the none and manual phases make the drain a no-op", async () => {
  const h = drainHarness({ rows: [row()] });
  const off = new AutoResolveService(
    { disputeResolveMode: () => "none" } as never,
    {} as never,
    { claimDue: async () => [] } as never,
    {} as never
  );
  assert.deepEqual(await off.drain(), { executed: 0, blocked: 0, failed: 0, superseded: 0, alerted: 0 });
  assert.equal(h.calls.length, 0);

  // "manual" means the old button only: the engine records nothing.
  const manual = drainHarness({ rows: [row()], mode: "manual" });
  assert.deepEqual(await manual.svc.drain(), { executed: 0, blocked: 0, failed: 0, superseded: 0, alerted: 0 });
  assert.equal(manual.calls.length, 0);
});

// ---- proposing by hand: the cutover tool ----
//
// Proposals are made from webhooks, so switching the engine on does nothing for
// the disputes already on the books. These cover the button that closes that
// gap, and the one way it deliberately differs from the engine: a refusal is
// reported and never written.

function handHarness(opts: {
  mode?: "none" | "manual" | "manualplus" | "auto";
  dispute?: Stripe.Dispute;
  charge?: Stripe.Charge;
  existing?: { state: string } | null;
  open?: Array<{ id: string }>;
  openTotal?: number;
  priorDisputes?: number;
  alertFails?: boolean;
}) {
  const writes: string[] = [];
  const store = {
    bySourceId: async (id: string) => (opts.existing ? { id: "row_1", state: opts.existing.state, sourceId: id } : null),
    propose: async (input: { sourceId: string; amountMinor: number }) => {
      writes.push(`propose:${input.sourceId}:${input.amountMinor}`);
      return { created: true, row: { id: "row_new" } };
    },
    recordBlocked: async (input: { guardrail: string }) => {
      writes.push(`recordBlocked:${input.guardrail}`);
      return { created: true, row: { id: "row_blocked" } };
    },
    recentExecutedForCustomer: async () => 0,
    byId: async (id: string) => ({ id, chargeId: "ch_test", amountMinor: 2000, currency: "usd" }),
    recordAlert: async () => {
      writes.push("recordAlert");
    },
  };
  const disputeStore = {
    countForCustomerSince: async () => opts.priorDisputes ?? 0,
    listOpen: async () => ({ rows: opts.open ?? [], total: opts.openTotal ?? (opts.open ?? []).length }),
  };
  const alerts = {
    postProposal: async () => {
      if (opts.alertFails) return null;
      writes.push("alert");
      return { channelId: "c", messageId: "m" };
    },
    postBlocked: async () => {},
    postExecuted: async () => {},
    postFailed: async () => {},
  };
  const stripe = {
    getDispute: async (id: string) => ({ ...(opts.dispute ?? dispute({})), id }) as Stripe.Dispute,
    getCharge: async () => opts.charge ?? charge({}),
  };
  const svc = new AutoResolveService(
    {
      disputeResolveMode: () => opts.mode ?? "manual",
      disputeAutoResolveEfw: () => true,
      disputeAutoResolveMaxUsdMinor: () => 6000,
      disputeAutoResolveVetoMinutes: () => 120,
      disputeAutoResolveRepeatDays: () => 90,
      disputeAutoResolveReasons: () => new Set(["subscription_canceled", "duplicate"]),
    } as never,
    stripe as never,
    store as never,
    disputeStore as never,
    undefined,
    alerts as never
  );
  return { svc, writes };
}

test("by hand: works at phase manual, which the engine itself never proposes at", async () => {
  // The phase says what may happen WITHOUT a human. A human pressing a button
  // is not the engine acting on its own, so "manual" allows it.
  const h = handHarness({ mode: "manual" });
  const r = await h.svc.proposeByHand("dp_9", NOW);
  assert.equal(r.kind, "proposed");
  // The alert goes out NOW, not on the next drain: at manual the drain never
  // runs at all, so a deferred alert would never be posted and the row could
  // never fire or be vetoed.
  assert.deepEqual(h.writes, ["propose:dp_9:2000", "alert", "recordAlert"]);
  assert.equal(r.kind === "proposed" ? r.alerted : false, true);

  // And the engine at that same phase still proposes nothing on its own.
  const engine = handHarness({ mode: "manual" });
  const viaWebhook = await engine.svc.proposeFromDispute(dispute({}), "ch_test", "cus_1");
  assert.equal(viaWebhook.kind, "inert");
  assert.deepEqual(engine.writes, [], "the webhook path stays inert at manual");
});

test("by hand: a switched-off pipeline still refuses", async () => {
  const h = handHarness({ mode: "none" });
  assert.equal((await h.svc.proposeByHand("dp_9", NOW)).kind, "off");
  assert.deepEqual(h.writes, []);
});

test("by hand: a guardrail is reported and NOTHING is written", async () => {
  // The engine records its blocks because nobody is watching a webhook land.
  // Here somebody is, and a Declined row could never be told apart from a
  // verdict the engine reached by itself.
  const h = handHarness({ mode: "manualplus", priorDisputes: 2 });
  const r = await h.svc.proposeByHand("dp_9", NOW);
  assert.equal(r.kind, "blocked");
  assert.equal(r.kind === "blocked" ? r.guardrail : "", "repeat_offender");
  assert.deepEqual(h.writes, [], "no row, and therefore no metric point either");
});

test("by hand: a chargeback is out of scope, because a refund cannot prevent it", async () => {
  const h = handHarness({ mode: "manualplus", dispute: dispute({ status: "needs_response" }) });
  const r = await h.svc.proposeByHand("dp_9", NOW);
  assert.equal(r.kind, "out_of_scope");
  assert.deepEqual(h.writes, []);
});

test("by hand: an existing row short-circuits before any Stripe read", async () => {
  let reads = 0;
  const h = handHarness({ mode: "manualplus", existing: { state: "VETOED" } });
  const svc = h.svc as unknown as { stripe: { getDispute: (id: string) => Promise<unknown> } };
  const real = svc.stripe.getDispute;
  svc.stripe.getDispute = async (id: string) => {
    reads++;
    return real(id);
  };
  const r = await h.svc.proposeByHand("dp_9", NOW);
  assert.equal(r.kind, "duplicate");
  assert.equal(r.kind === "duplicate" ? r.state : "", "VETOED");
  assert.equal(reads, 0, "re-pressing costs one query, not two Stripe calls");
});

test("backfill: sweeps the open inquiries, counts why the rest were refused, and reports the remainder", async () => {
  const h = handHarness({
    mode: "manualplus",
    open: [{ id: "dp_1" }, { id: "dp_2" }],
    openTotal: 7,
  });
  const r = await h.svc.backfillOpenInquiries(NOW);
  assert.equal(r.scanned, 2);
  assert.equal(r.proposed, 2);
  assert.equal(r.remaining, 5, "the operator is told to press again");
  assert.deepEqual(h.writes, ["propose:dp_1:2000", "alert", "recordAlert", "propose:dp_2:2000", "alert", "recordAlert"]);
  assert.equal(r.unalerted, 0);

  const refused = handHarness({ mode: "manualplus", open: [{ id: "dp_1" }], priorDisputes: 1 });
  const rr = await refused.svc.backfillOpenInquiries(NOW);
  assert.equal(rr.proposed, 0);
  assert.equal(rr.blocked, 1);
  assert.deepEqual(rr.guardrails, { repeat_offender: 1 });
  assert.deepEqual(refused.writes, []);
});

test("backfill: off means off", async () => {
  const h = handHarness({ mode: "none", open: [{ id: "dp_1" }] });
  const r = await h.svc.backfillOpenInquiries(NOW);
  assert.equal(r.scanned, 0);
  assert.deepEqual(h.writes, []);
});

test("by hand: an unreachable billing channel leaves the proposal inert, and says so", async () => {
  // Same fail-closed state the engine produces: the row stands but cannot fire,
  // because nothing may execute a proposal nobody could have vetoed.
  const h = handHarness({ mode: "manual", alertFails: true });
  const r = await h.svc.proposeByHand("dp_9", NOW);
  assert.equal(r.kind === "proposed" ? r.alerted : true, false);
  assert.deepEqual(h.writes, ["propose:dp_9:2000"], "no alert stamp without an alert");

  const swept = handHarness({ mode: "manual", alertFails: true, open: [{ id: "dp_1" }] });
  const b = await swept.svc.backfillOpenInquiries(NOW);
  assert.equal(b.proposed, 1);
  assert.equal(b.unalerted, 1);
});
