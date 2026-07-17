import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules } from "../evaluate";
import { SlaCondition, SlaFacts, SlaRuleLike } from "../types";

let seq = 0;
function rule(conditions: SlaCondition[], overrides: Partial<SlaRuleLike> = {}): SlaRuleLike {
  seq++;
  return {
    id: overrides.id ?? `r${seq}`,
    name: overrides.name ?? `rule ${seq}`,
    enabled: overrides.enabled ?? true,
    position: overrides.position ?? seq,
    conditions,
    target: overrides.target ?? `target-${seq}`,
  };
}

const bridgedFacts: SlaFacts = {
  kind: "bridged",
  categoryId: "billing",
  statusTagId: "tag_open",
  tierId: "tier_1",
  open: true,
  exempt: false,
  mirrored: true,
  stripe: {
    linked: true,
    paying: true,
    planKeys: ["price_123", "Pro Plan"],
    spendMajor: 250,
    openDispute: false,
    refundReview: true,
  },
  intercom: { teamId: "77", teamName: "Billing", kind: "ticket", ticketTypeId: "9", tags: ["vip"] },
  text: "I want a refund for my subscription",
};

const nativeFacts: SlaFacts = {
  kind: "native",
  intercom: { teamId: "88", teamName: "Support", kind: "conversation", ticketTypeId: null, tags: [] },
  text: "hello, question about pricing",
};

test("first enabled match wins, position order", () => {
  const low = rule([{ dim: "category", op: "eq", value: "billing" }], { position: 5, target: "low" });
  const high = rule([{ dim: "open", op: "eq", value: true }], { position: 1, target: "high" });
  const res = evaluateRules([low, high], bridgedFacts);
  assert.equal(res.winner?.target, "high");
  // both rules still traced
  assert.equal(res.trace.length, 2);
  assert.equal(res.trace[0].target, "high");
});

test("disabled rules are skipped but traced", () => {
  const off = rule([{ dim: "open", op: "eq", value: true }], { position: 1, enabled: false, target: "off" });
  const on = rule([{ dim: "open", op: "eq", value: true }], { position: 2, target: "on" });
  const res = evaluateRules([off, on], bridgedFacts);
  assert.equal(res.winner?.target, "on");
  assert.equal(res.trace[0].skipped, "disabled");
});

test("conditions are AND-ed", () => {
  const r = rule([
    { dim: "category", op: "eq", value: "billing" },
    { dim: "stripe.paying", op: "eq", value: false }, // fails
  ]);
  const res = evaluateRules([r], bridgedFacts);
  assert.equal(res.winner, null);
  assert.equal(res.trace[0].matched, false);
  assert.equal(res.trace[0].conditions[0].pass, true);
  assert.equal(res.trace[0].conditions[1].pass, false);
});

test("no rules → no winner", () => {
  assert.equal(evaluateRules([], bridgedFacts).winner, null);
});

test("missing data = false, including negated ops", () => {
  // native facts: no category/status/tier/stripe/text-independent dims
  const cases: SlaCondition[] = [
    { dim: "category", op: "eq", value: "billing" },
    { dim: "category", op: "neq", value: "billing" }, // still false: no category at all
    { dim: "status", op: "neq", tagId: "x" },
    { dim: "tier", op: "eq", tierId: "x" },
    { dim: "open", op: "eq", value: true },
    { dim: "exempt", op: "eq", value: false },
    { dim: "mirrored", op: "eq", value: false },
    { dim: "stripe.linked", op: "eq", value: false }, // no stripe facts at all → false
    { dim: "stripe.paying", op: "eq", value: false },
    { dim: "stripe.spend", op: "lt", value: 10 },
    { dim: "stripe.plan", op: "neq", value: "x" },
  ];
  for (const cond of cases) {
    const res = evaluateRules([rule([cond], { position: 1 })], nativeFacts);
    assert.equal(res.winner, null, `expected no match for ${JSON.stringify(cond)}`);
  }
});

test("stripe.linked=false matches when stripe facts exist and are unlinked", () => {
  const facts: SlaFacts = { ...bridgedFacts, stripe: { linked: false } };
  const res = evaluateRules([rule([{ dim: "stripe.linked", op: "eq", value: false }], { position: 1 })], facts);
  assert.ok(res.winner);
});

test("stripe unavailable fails paying/plan/spend but not linked", () => {
  const facts: SlaFacts = { ...bridgedFacts, stripe: { linked: true, unavailable: true } };
  assert.equal(evaluateRules([rule([{ dim: "stripe.paying", op: "eq", value: true }], { position: 1 })], facts).winner, null);
  assert.equal(evaluateRules([rule([{ dim: "stripe.spend", op: "gte", value: 1 }], { position: 2 })], facts).winner, null);
  assert.ok(evaluateRules([rule([{ dim: "stripe.linked", op: "eq", value: true }], { position: 3 })], facts).winner);
});

test("plan matching: exact ci, neq, regex", () => {
  const eq = rule([{ dim: "stripe.plan", op: "eq", value: "PRICE_123" }], { position: 1 });
  const neq = rule([{ dim: "stripe.plan", op: "neq", value: "price_999" }], { position: 2 });
  const rx = rule([{ dim: "stripe.plan", op: "matches", value: "^pro" }], { position: 3 });
  assert.ok(evaluateRules([eq], bridgedFacts).winner);
  assert.ok(evaluateRules([neq], bridgedFacts).winner);
  assert.ok(evaluateRules([rx], bridgedFacts).winner);
});

test("spend comparisons", () => {
  assert.ok(evaluateRules([rule([{ dim: "stripe.spend", op: "gte", value: 250 }], { position: 1 })], bridgedFacts).winner);
  assert.equal(evaluateRules([rule([{ dim: "stripe.spend", op: "gt", value: 250 }], { position: 1 })], bridgedFacts).winner, null);
  assert.ok(evaluateRules([rule([{ dim: "stripe.spend", op: "lte", value: 250 }], { position: 1 })], bridgedFacts).winner);
});

test("team matches by id or name (ci)", () => {
  assert.ok(evaluateRules([rule([{ dim: "intercom.team", op: "eq", value: "77" }], { position: 1 })], bridgedFacts).winner);
  assert.ok(evaluateRules([rule([{ dim: "intercom.team", op: "eq", value: "billing" }], { position: 1 })], bridgedFacts).winner);
  assert.equal(evaluateRules([rule([{ dim: "intercom.team", op: "eq", value: "Sales" }], { position: 1 })], bridgedFacts).winner, null);
  assert.ok(evaluateRules([rule([{ dim: "intercom.team", op: "neq", value: "Sales" }], { position: 1 })], bridgedFacts).winner);
});

test("intercom tags: has/not_has; empty tag list is data (not missing)", () => {
  assert.ok(evaluateRules([rule([{ dim: "intercom.tag", op: "has", value: "VIP" }], { position: 1 })], bridgedFacts).winner);
  assert.equal(evaluateRules([rule([{ dim: "intercom.tag", op: "has", value: "spam" }], { position: 1 })], bridgedFacts).winner, null);
  // native facts have tags: [] → not_has passes (real data saying tag absent)
  assert.ok(evaluateRules([rule([{ dim: "intercom.tag", op: "not_has", value: "vip" }], { position: 1 })], nativeFacts).winner);
});

test("keyword regex + substring, and not_matches", () => {
  assert.ok(evaluateRules([rule([{ dim: "keyword", op: "matches", value: "refund" }], { position: 1 })], bridgedFacts).winner);
  assert.ok(evaluateRules([rule([{ dim: "keyword", op: "matches", value: "refund.*subscription" }], { position: 1 })], bridgedFacts).winner);
  assert.equal(evaluateRules([rule([{ dim: "keyword", op: "matches", value: "chargeback" }], { position: 1 })], bridgedFacts).winner, null);
  assert.ok(evaluateRules([rule([{ dim: "keyword", op: "not_matches", value: "chargeback" }], { position: 1 })], bridgedFacts).winner);
  // no text → false either way
  const noText: SlaFacts = { kind: "native" };
  assert.equal(evaluateRules([rule([{ dim: "keyword", op: "not_matches", value: "x" }], { position: 1 })], noText).winner, null);
});

test("native conversation matches reduced filter set", () => {
  const r = rule(
    [
      { dim: "intercom.kind", op: "eq", value: "conversation" },
      { dim: "keyword", op: "matches", value: "pricing" },
    ],
    { position: 1, target: "native-target" }
  );
  const res = evaluateRules([r], nativeFacts);
  assert.equal(res.winner?.target, "native-target");
});

test("trace records reasons for the preview UI", () => {
  const r = rule([{ dim: "stripe.refund_review", op: "eq", value: true }], { position: 1 });
  const res = evaluateRules([r], bridgedFacts);
  assert.equal(res.trace[0].conditions[0].pass, true);
  assert.ok(res.trace[0].conditions[0].reason.length > 0);
});
