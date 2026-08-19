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
  intercom: {
    teamId: "77",
    teamName: "Billing",
    adminAssigneeId: "555",
    kind: "ticket",
    ticketTypeId: "9",
    tags: ["vip"],
    attributes: { Sentiment: "positive", "AI Title": "Refund request", Empty: "" },
  },
  text: "I want a refund for my subscription",
};

const nativeFacts: SlaFacts = {
  kind: "native",
  intercom: { teamId: "88", teamName: "Support", kind: "conversation", ticketTypeId: null, tags: [], attributes: {} },
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

test("attribute conditions: eq/neq/matches/set/not_set", () => {
  const eq = rule([{ dim: "intercom.attribute", name: "Sentiment", op: "eq", value: "POSITIVE" }], { position: 1 });
  assert.ok(evaluateRules([eq], bridgedFacts).winner, "eq is case-insensitive");
  const neq = rule([{ dim: "intercom.attribute", name: "Sentiment", op: "neq", value: "negative" }], { position: 1 });
  assert.ok(evaluateRules([neq], bridgedFacts).winner);
  const rx = rule([{ dim: "intercom.attribute", name: "AI Title", op: "matches", value: "refund" }], { position: 1 });
  assert.ok(evaluateRules([rx], bridgedFacts).winner);
  const set = rule([{ dim: "intercom.attribute", name: "Sentiment", op: "set" }], { position: 1 });
  assert.ok(evaluateRules([set], bridgedFacts).winner);
  // empty string counts as not set
  const emptyNotSet = rule([{ dim: "intercom.attribute", name: "Empty", op: "not_set" }], { position: 1 });
  assert.ok(evaluateRules([emptyNotSet], bridgedFacts).winner);
  const missingNotSet = rule([{ dim: "intercom.attribute", name: "Nope", op: "not_set" }], { position: 1 });
  assert.ok(evaluateRules([missingNotSet], bridgedFacts).winner, "absent attribute is not set (attrs fetched = data)");
  // no attribute data at all → false even for not_set
  const noAttrs = { ...bridgedFacts, intercom: { ...bridgedFacts.intercom, attributes: undefined } };
  assert.equal(evaluateRules([rule([{ dim: "intercom.attribute", name: "X", op: "not_set" }], { position: 1 })], noAttrs).winner, null);
});

test("assignee matches by admin id", () => {
  assert.ok(evaluateRules([rule([{ dim: "intercom.assignee", op: "eq", value: "555" }], { position: 1 })], bridgedFacts).winner);
  assert.equal(evaluateRules([rule([{ dim: "intercom.assignee", op: "eq", value: "1" }], { position: 1 })], bridgedFacts).winner, null);
  assert.ok(evaluateRules([rule([{ dim: "intercom.assignee", op: "neq", value: "1" }], { position: 1 })], bridgedFacts).winner);
  // unassigned → false either way
  assert.equal(evaluateRules([rule([{ dim: "intercom.assignee", op: "neq", value: "1" }], { position: 1 })], nativeFacts).winner, null);
});

test("trace records reasons for the preview UI", () => {
  const r = rule([{ dim: "stripe.refund_review", op: "eq", value: true }], { position: 1 });
  const res = evaluateRules([r], bridgedFacts);
  assert.equal(res.trace[0].conditions[0].pass, true);
  assert.ok(res.trace[0].conditions[0].reason.length > 0);
});

// ---- postiz.* -------------------------------------------------------------
// The account is resolved once at ticket creation and stored on the ticket row,
// so these dimensions cost nothing to evaluate and behave like stripe.*:
// `linked` is always answerable, everything else is false without data.

const matches = (cond: SlaCondition, facts: SlaFacts): boolean =>
  evaluateRules([rule([cond], { position: 1 })], facts).winner != null;

test("postiz.linked answers both ways once an account was resolved", () => {
  const linked: SlaFacts = { ...bridgedFacts, postiz: { linked: true, tier: "PRO", role: "ADMIN" } };
  assert.equal(matches({ dim: "postiz.linked", op: "eq", value: true }, linked), true);

  const unlinked: SlaFacts = { ...bridgedFacts, postiz: { linked: false } };
  assert.equal(matches({ dim: "postiz.linked", op: "eq", value: false }, unlinked), true);
  assert.equal(matches({ dim: "postiz.linked", op: "eq", value: true }, unlinked), false);
});

test("postiz dimensions are all false for a subject carrying no postiz facts", () => {
  assert.equal(matches({ dim: "postiz.linked", op: "eq", value: true }, bridgedFacts), false);
  assert.equal(matches({ dim: "postiz.tier", op: "eq", value: "PRO" }, bridgedFacts), false);
});

test("postiz.tier compares case-insensitively and supports a regex", () => {
  const facts: SlaFacts = { ...bridgedFacts, postiz: { linked: true, tier: "PRO" } };
  assert.equal(matches({ dim: "postiz.tier", op: "eq", value: "pro" }, facts), true);
  assert.equal(matches({ dim: "postiz.tier", op: "neq", value: "TEAM" }, facts), true);
  assert.equal(matches({ dim: "postiz.tier", op: "matches", value: "^(pro|ultimate)$" }, facts), true);
  assert.equal(matches({ dim: "postiz.tier", op: "matches", value: "^team$" }, facts), false);
});

test("postiz.role compares case-insensitively", () => {
  const facts: SlaFacts = { ...bridgedFacts, postiz: { linked: true, role: "SUPERADMIN" } };
  assert.equal(matches({ dim: "postiz.role", op: "eq", value: "superadmin" }, facts), true);
  assert.equal(matches({ dim: "postiz.role", op: "eq", value: "USER" }, facts), false);
});

test("an unavailable lookup fails every postiz dimension except linked", () => {
  // A native conversation has no ticket row to carry a resolved account, so
  // the identity is unknown. `linked=false` must stay answerable so authors
  // can gate on it, exactly as they do for stripe.
  const facts: SlaFacts = { ...nativeFacts, postiz: { linked: false, unavailable: true, tier: "PRO" } };
  assert.equal(matches({ dim: "postiz.linked", op: "eq", value: false }, facts), true);
  assert.equal(matches({ dim: "postiz.tier", op: "eq", value: "PRO" }, facts), false);
});

test("a free organization has no tier, which is not an unavailable lookup", () => {
  const facts: SlaFacts = { ...bridgedFacts, postiz: { linked: true, tier: null, role: "USER" } };
  assert.equal(matches({ dim: "postiz.linked", op: "eq", value: true }, facts), true);
  assert.equal(matches({ dim: "postiz.tier", op: "eq", value: "PRO" }, facts), false);
  // The role is still known, so it evaluates normally.
  assert.equal(matches({ dim: "postiz.role", op: "eq", value: "USER" }, facts), true);
});
