import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import {
  VERDICT_SIGNALS,
  VERDICT_SIGNAL_LABELS,
  annualFromPeriod,
  decideVerdict,
  effectiveVerdict,
  hasCancelIntent,
  type VerdictInput,
} from "../billing/disputeVerdict";
import { chargeHistory } from "../billing/evidence/EvidenceFacts";
import { probeSupportContact } from "../billing/evidence/intercomHistory";
import { DisputeVerdictService, quietAccept } from "../billing/DisputeVerdictService";

// ---- the rules, in order ----

// Every feed answered and nothing speaks either way: the baseline a single
// fact is added to, so each test changes exactly what it names.
const base = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  reason: "fraudulent",
  refundedMinor: 0,
  annual: false,
  threeDSecure: null,
  visaCe3: null,
  usage: { publishedSinceCharge: 0, publishedBeforeCharge: 0, channelsDuringPeriod: 0, queued: 0 },
  usageReached: true,
  supportContacts: 0,
  supportReached: true,
  cancelAskBeforeCharge: null,
  cancelledBeforeCharge: null,
  priorSucceededCharges: 5,
  cardVerified: true,
  packScore: 80,
  minScore: 40,
  ...over,
});

const decide = (over: Partial<VerdictInput> = {}) => decideVerdict(base(over));
const withUsage = (u: Partial<NonNullable<VerdictInput["usage"]>>): Partial<VerdictInput> => ({
  usage: { publishedSinceCharge: 0, publishedBeforeCharge: 0, channelsDuringPeriod: 0, queued: 0, ...u },
});

test("verdict: nothing at all is an Accept, and a complete one", () => {
  const v = decide();
  assert.equal(v.verdict, "accept");
  assert.equal(v.decisive, "no_signal");
  assert.equal(v.complete, true);
  assert.deepEqual(v.signals, []);
});

test("verdict: each weak signal fights on its own when the data is not thin", () => {
  const cases: Array<[string, Partial<VerdictInput>]> = [
    ["posts_after_charge", withUsage({ publishedSinceCharge: 1 })],
    ["posts_before_charge", withUsage({ publishedBeforeCharge: 1 })],
    ["channels_in_period", withUsage({ channelsDuringPeriod: 1 })],
    ["queued_posts", withUsage({ queued: 1 })],
    ["support_contact", { supportContacts: 1 }],
    ["cancel_claim_false", { reason: "subscription_canceled", cancelledBeforeCharge: false, cancelAskBeforeCharge: false }],
  ];
  for (const [signal, over] of cases) {
    const v = decide(over);
    assert.equal(v.verdict, "fight", signal);
    assert.equal(v.decisive, signal);
  }
});

test("verdict: ANY thin indicator vetoes every weak signal", () => {
  const strongUsage = { ...withUsage({ publishedSinceCharge: 40, queued: 3 }), supportContacts: 2 };
  const thin: Array<[string, Partial<VerdictInput>]> = [
    ["thin_first_charge", { priorSucceededCharges: 0 }],
    ["thin_low_score", { packScore: 39 }],
    ["thin_unverified", { cardVerified: false }],
  ];
  for (const [signal, over] of thin) {
    const v = decide({ ...strongUsage, ...over });
    assert.equal(v.verdict, "accept", signal);
    assert.equal(v.decisive, signal);
    // The fight signals are still reported, so the card shows what was vetoed.
    assert.ok(v.signals.includes("posts_after_charge"));
  }
  // The bar itself is not thin.
  assert.equal(decide({ ...strongUsage, packScore: 40 }).verdict, "fight");
});

test("verdict: refunds, annual plans, 3-D Secure and Visa CE 3.0 survive the thin-data veto", () => {
  const thin = { priorSucceededCharges: 0, packScore: 5, cardVerified: false };
  assert.equal(decide({ ...thin, refundedMinor: 100 }).decisive, "refunded");
  assert.equal(decide({ ...thin, annual: true }).decisive, "annual");
  assert.equal(decide({ ...thin, threeDSecure: "authenticated" }).decisive, "three_d_secure");
  assert.equal(decide({ ...thin, visaCe3: "qualified" }).decisive, "visa_ce3");
  // Only a real authentication and a real qualification count.
  assert.equal(decide({ ...thin, threeDSecure: "attempt_acknowledged" }).verdict, "accept");
  assert.equal(decide({ ...thin, visaCe3: "requires_action" }).verdict, "accept");
});

test("verdict: a cancel request support saw before the charge concedes, except to annual and refunded charges", () => {
  const asked = { reason: "subscription_canceled", cancelAskBeforeCharge: true, ...withUsage({ publishedSinceCharge: 30 }) };
  const v = decide(asked);
  assert.equal(v.verdict, "accept");
  assert.equal(v.decisive, "cancel_ask_seen");
  // It beats 3-D Secure too: the customer did what they were supposed to.
  assert.equal(decide({ ...asked, threeDSecure: "authenticated" }).decisive, "cancel_ask_seen");
  assert.equal(decide({ ...asked, annual: true }).decisive, "annual");
  assert.equal(decide({ ...asked, refundedMinor: 2900 }).decisive, "refunded");
  // It only speaks to a cancellation claim.
  assert.equal(decide({ ...asked, reason: "fraudulent" }).verdict, "fight");
});

test("verdict: the cancel claim is disproved only by a POSITIVE no from Stripe and no request seen", () => {
  const claim = { reason: "subscription_canceled" };
  assert.equal(decide({ ...claim, cancelledBeforeCharge: false, cancelAskBeforeCharge: null }).decisive, "cancel_claim_false");
  assert.equal(decide({ ...claim, cancelledBeforeCharge: true }).decisive, "no_signal");
  assert.equal(decide({ ...claim, cancelledBeforeCharge: null }).decisive, "no_signal");
});

test("verdict: unknown is not no, and a silent feed makes the verdict incomplete", () => {
  const unknown = decide({ priorSucceededCharges: null, cardVerified: null, packScore: null, annual: null, usage: null });
  assert.equal(unknown.verdict, "accept");
  assert.deepEqual(unknown.thin, [], "a null never vetoes");
  assert.deepEqual(unknown.missing, ["history"]);
  assert.equal(unknown.complete, false);

  const silent = decide({ usageReached: false, supportReached: false });
  assert.deepEqual(silent.missing, ["usage", "support"]);
  assert.equal(silent.complete, false);
  // Positive evidence from a partial feed still counts.
  assert.equal(decide({ supportReached: false, supportContacts: 1 }).verdict, "fight");
});

test("verdict: every signal has a label, and an override wins in both directions", () => {
  for (const s of VERDICT_SIGNALS) assert.ok(VERDICT_SIGNAL_LABELS[s], s);
  assert.equal(effectiveVerdict({ verdict: "accept", verdictOverride: "fight" }), "fight");
  assert.equal(effectiveVerdict({ verdict: "fight", verdictOverride: "accept" }), "accept");
  assert.equal(effectiveVerdict({ verdict: null, verdictOverride: null }), null);
  assert.equal(quietAccept({ verdict: "accept", verdictOverride: null, verdictComplete: true }), true);
  assert.equal(quietAccept({ verdict: "accept", verdictOverride: null, verdictComplete: false }), false);
  assert.equal(quietAccept({ verdict: "accept", verdictOverride: "fight", verdictComplete: true }), false);
  assert.equal(quietAccept({ verdict: "fight", verdictOverride: "accept", verdictComplete: false }), true);
});

// ---- the facts it is fed ----

test("annual: a paid period of most of a year is annual, whatever the price was", () => {
  assert.equal(annualFromPeriod("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"), true);
  assert.equal(annualFromPeriod("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"), false);
  assert.equal(annualFromPeriod(null, "2026-02-01T00:00:00Z"), null);
  assert.equal(annualFromPeriod("2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z"), null);
});

test("cancel intent: names the plan or is a bare request; a post is not a subscription", () => {
  for (const yes of [
    "Please cancel my subscription",
    "I cancelled the plan last week",
    "I want to cancel.",
    "i would like to cancel, and get my money back",
    "unsubscribe me",
    "Don't renew me",
    "Cancellation request",
    "stop the payments",
  ]) {
    assert.equal(hasCancelIntent(yes), true, yes);
  }
  for (const no of [
    "How do I cancel a scheduled post?",
    "please cancel the scheduled post for tomorrow",
    "my account is not activated",
    "the post got cancelled by LinkedIn",
    "",
    null,
  ]) {
    assert.equal(hasCancelIntent(no), false, String(no));
  }
});

const card = (over: Record<string, unknown> = {}) => ({
  fingerprint: "fp_1",
  checks: { cvc_check: null, address_postal_code_check: null },
  three_d_secure: null,
  ...over,
});
const ch = (id: string, created: number, cardOver: Record<string, unknown> = {}, status = "succeeded"): Stripe.Charge =>
  ({ id, created, status, payment_method_details: { card: card(cardOver) } }) as unknown as Stripe.Charge;

test("history: an off-session renewal is verified by an earlier payment on the same card", () => {
  const renewal = ch("ch_now", 300);
  const signup = ch("ch_first", 100, { checks: { cvc_check: "pass", address_postal_code_check: null } });
  const failed = ch("ch_fail", 200, {}, "failed");
  assert.deepEqual(chargeHistory([renewal, signup, failed], renewal), { priorSucceeded: 1, cardVerified: true });
  // A different card's pass proves nothing about this one.
  const otherCard = ch("ch_other", 100, { fingerprint: "fp_2", checks: { cvc_check: "pass", address_postal_code_check: null } });
  assert.deepEqual(chargeHistory([renewal, otherCard], renewal), { priorSucceeded: 1, cardVerified: false });
  // No fingerprint to follow back: unknown, which never vetoes.
  const bare = ch("ch_bare", 300, { fingerprint: null });
  assert.equal(chargeHistory([bare], bare).cardVerified, null);
  assert.equal(chargeHistory([renewal], renewal).priorSucceeded, 0);
});

// ---- the Intercom probe ----

function intercomFake(opts: {
  contactsByEmail?: Array<{ id: string }>;
  conversations?: Array<{ id: string; createdAt: Date | null }>;
  transcripts?: Record<string, Array<{ author: string; at: Date | null; text: string }> | null>;
  failSearch?: boolean;
}) {
  return {
    findContactByExternalId: async () => null,
    searchContactsByEmail: async () => opts.contactsByEmail ?? [],
    searchConversationsByContact: async () => {
      if (opts.failSearch) throw new Error("intercom down");
      return opts.conversations ?? [];
    },
    getConversationTranscript: async (id: string) => {
      const t = opts.transcripts?.[id];
      if (t === null) throw new Error("unreadable");
      return t ?? [];
    },
  };
}

const probeDeps = (intercom: ReturnType<typeof intercomFake>, mode = "bi") =>
  ({
    intercom: intercom as never,
    sessionStore: { findDiscordIdsByStripeId: async () => [] } as never,
    settings: { intercomMode: () => mode } as never,
  }) as Parameters<typeof probeSupportContact>[0];

const DISPUTE_AT = new Date("2026-09-10T00:00:00Z");
const CHARGE_AT = new Date("2026-08-14T00:00:00Z");

test("support probe: counts contact before the dispute, finds the customer's own cancel request before the charge", async () => {
  const intercom = intercomFake({
    contactsByEmail: [{ id: "c1" }],
    conversations: [
      { id: "after", createdAt: new Date("2026-09-12T00:00:00Z") }, // complaining about the chargeback
      { id: "before", createdAt: new Date("2026-08-01T00:00:00Z") },
    ],
    transcripts: {
      before: [
        { author: "agent Sam", at: new Date("2026-08-01T01:00:00Z"), text: "You can cancel your subscription in settings." },
        { author: "customer", at: new Date("2026-08-01T02:00:00Z"), text: "Please cancel my subscription." },
      ],
    },
  });
  const p = await probeSupportContact(probeDeps(intercom), null, "a@b.co", {
    disputeOpenedAt: DISPUTE_AT,
    chargeAt: CHARGE_AT,
    scanCancelAsk: true,
  });
  assert.equal(p.reached, true);
  assert.equal(p.conversationsBeforeDispute, 1);
  assert.equal(p.cancelAskBeforeCharge, true);
  assert.equal(p.facts?.conversationCount, 2);
});

test("support probe: an agent explaining cancellation is not a request; an unreadable transcript is not a no", async () => {
  const agentOnly = intercomFake({
    contactsByEmail: [{ id: "c1" }],
    conversations: [{ id: "before", createdAt: new Date("2026-08-01T00:00:00Z") }],
    transcripts: { before: [{ author: "agent Sam", at: new Date("2026-08-01T01:00:00Z"), text: "To cancel your subscription, open Billing." }] },
  });
  const opts = { disputeOpenedAt: DISPUTE_AT, chargeAt: CHARGE_AT, scanCancelAsk: true };
  assert.equal((await probeSupportContact(probeDeps(agentOnly), null, "a@b.co", opts)).cancelAskBeforeCharge, false);

  const unreadable = intercomFake({
    contactsByEmail: [{ id: "c1" }],
    conversations: [{ id: "before", createdAt: new Date("2026-08-01T00:00:00Z") }],
    transcripts: { before: null },
  });
  assert.equal((await probeSupportContact(probeDeps(unreadable), null, "a@b.co", opts)).cancelAskBeforeCharge, null);
});

test("support probe: nobody under any id is a real zero for the verdict but nothing the pack may assert", async () => {
  const p = await probeSupportContact(probeDeps(intercomFake({})), "cus_1", "a@b.co", { disputeOpenedAt: DISPUTE_AT });
  assert.equal(p.reached, true);
  assert.equal(p.conversationsBeforeDispute, 0);
  assert.equal(p.facts, null);

  const down = await probeSupportContact(probeDeps(intercomFake({ contactsByEmail: [{ id: "c1" }], failSearch: true })), null, "a@b.co");
  assert.equal(down.reached, false, "a failed search could have hidden a conversation");
  assert.equal(down.facts?.noRefundRequest, null, "and the pack may not claim there was no refund request");

  const off = await probeSupportContact(probeDeps(intercomFake({}), "none"), null, "a@b.co");
  assert.equal(off.reached, false);
});

// ---- the service: facts in, verdict out ----

function packWith(over: Record<string, unknown> = {}) {
  return {
    score: 80,
    usageReached: true,
    supportProbe: { reached: true, conversationsBeforeDispute: 0, cancelAskBeforeCharge: false, facts: null },
    facts: {
      charge: { threeDSecure: null, paidPeriodStartIso: "2026-08-14T00:00:00Z", paidPeriodEndIso: "2026-09-14T00:00:00Z", dateIso: "2026-08-14T00:00:00.000Z" },
      sub: { period: "monthly", canceledAtIso: null },
      usage: null,
      history: { priorSucceeded: 4, cardVerified: true },
      reach: { usage: true },
    },
    ...over,
  } as never;
}

function serviceWith(tickets: Array<{ createdAt: Date; categoryId: string | null; question: string | null }>) {
  const written: Array<Record<string, unknown>> = [];
  const svc = new DisputeVerdictService(
    { disputeVerdictMinScore: () => 40 } as never,
    {
      get: async () => null,
      recordVerdict: async (_id: string, v: Record<string, unknown>) => {
        written.push(v);
        return { id: "dp_1" };
      },
    } as never,
    { findDiscordIdsByStripeId: async () => ["u1"] } as never,
    { listByCustomerIdsBefore: async (_ids: string[], before: Date) => tickets.filter((t) => t.createdAt < before) } as never
  );
  return { svc, written };
}

const dispute = (reason: string) =>
  ({ id: "dp_1", reason, created: Math.floor(DISPUTE_AT.getTime() / 1000), evidence_details: {} }) as unknown as Stripe.Dispute;
const chargeObj = { id: "ch_1", customer: "cus_1", currency: "usd", amount_refunded: 0, created: Math.floor(CHARGE_AT.getTime() / 1000) } as unknown as Stripe.Charge;

test("service: a Discord refund ticket before the charge is a cancel request; one after it is only contact", async () => {
  const before = serviceWith([{ createdAt: new Date("2026-08-01T00:00:00Z"), categoryId: "billing", question: "Refund request" }]);
  const d1 = await before.svc.evaluate(dispute("subscription_canceled"), chargeObj, packWith());
  assert.equal(d1.result.decisive, "cancel_ask_seen");
  assert.equal(d1.discordTickets, 1);

  const after = serviceWith([{ createdAt: new Date("2026-08-20T00:00:00Z"), categoryId: "billing", question: "Refund request" }]);
  const d2 = await after.svc.evaluate(dispute("subscription_canceled"), chargeObj, packWith());
  assert.equal(d2.cancelAskBeforeCharge, false);
  assert.equal(d2.result.verdict, "fight", "contact before the dispute still counts");
  assert.ok(d2.result.signals.includes("support_contact"));
});

test("service: annual comes from the charge's own paid period, and the fast path is provisional", async () => {
  const { svc } = serviceWith([]);
  const annual = await svc.evaluate(
    dispute("fraudulent"),
    chargeObj,
    packWith({
      facts: {
        charge: { threeDSecure: null, paidPeriodStartIso: "2026-08-14T00:00:00Z", paidPeriodEndIso: "2027-08-14T00:00:00Z", dateIso: "2026-08-14T00:00:00.000Z" },
        sub: { period: "monthly", canceledAtIso: null },
        usage: null,
        history: { priorSucceeded: 0, cardVerified: false },
        reach: { usage: true },
      },
    })
  );
  assert.equal(annual.result.decisive, "annual");

  const fast = await svc.evaluate(dispute("fraudulent"), chargeObj, packWith({ supportProbe: null }));
  assert.equal(fast.result.complete, false);
  assert.deepEqual(fast.result.missing, ["support"]);
});

test("service: a stored verdict carries its facts and version", async () => {
  const { svc, written } = serviceWith([]);
  const stored = await svc.evaluateAndStore(dispute("fraudulent"), chargeObj, packWith(), "backtest");
  assert.equal(stored?.verdict, "accept");
  assert.equal(written[0].source, "backtest");
  assert.equal(written[0].version, "v1");
  assert.equal((written[0].signals as { result: { decisive: string } }).result.decisive, "no_signal");
});
