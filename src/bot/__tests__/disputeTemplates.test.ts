import { test } from "node:test";
import assert from "node:assert/strict";
import { TEXT_EVIDENCE_KEYS } from "../billing/DisputeStore";
import { TOKENS, TOKEN_NAMES, PLAN_FACTS, resolveTokens, type EvidenceFacts } from "../billing/evidence/tokens";
import {
  NO_INTERNAL_ARTIFACT,
  renderField,
  templateTokens,
  type EvidenceTemplate,
} from "../billing/evidence/renderTemplate";
import {
  FIELD_WEIGHTS,
  GENERIC_TEMPLATES,
  PACK_FIELDS_BY_REASON,
  PACK_REASONS,
  TEMPLATE_LIBRARY,
  packReasonFor,
  templateFor,
  type PackReason,
} from "../billing/evidence/templates";

// ---- fact fabricators ----

const fullFacts = (over: Partial<EvidenceFacts> = {}): EvidenceFacts => ({
  dispute: {
    id: "dp_1",
    amountText: "$29.00",
    reason: "subscription_canceled",
    openedIso: "2026-09-10T00:00:00.000Z",
    dueIso: "2026-09-24T00:00:00.000Z",
  },
  charge: {
    id: "ch_1",
    dateIso: "2026-08-14T09:00:00.000Z",
    amountText: "$29.00",
    currency: "usd",
    descriptor: "POSTIZ",
    description: "Subscription update",
    cardBrand: "Visa",
    cardLast4: "4242",
    cardCountry: "Germany",
    cardName: "Alex Baker",
    refundStatus: "No refund or credit has been issued on this charge.",
    invoiceNumber: "1A2B-0006",
    paidPeriodStartIso: "2026-08-14T00:00:00.000Z",
    paidPeriodEndIso: "2026-09-14T00:00:00.000Z",
    cvcCheck: "pass",
    postalCheck: "pass",
    addressCheck: "pass",
    threeDSecure: "authenticated",
    riskLevel: "normal",
    riskScore: 12,
    networkStatus: "approved_by_network",
    fingerprint: "fp_abc",
  },
  customer: {
    id: "cus_1",
    email: "alex@example.com",
    name: "Alex Baker",
    createdIso: "2026-02-01T00:00:00.000Z",
    addressBlock: "12 Example Street\nBerlin\nGermany",
  },
  sub: {
    plan: "Pro",
    tier: "PRO",
    status: "active",
    startedIso: "2026-02-01T00:00:00.000Z",
    period: "monthly",
    periodStartIso: "2026-08-14T00:00:00.000Z",
    periodEndIso: "2026-09-14T00:00:00.000Z",
    canceledAtIso: "2026-09-09T00:00:00.000Z",
  },
  billing: {
    historyLines: "2026-02-14   $29.00   paid\n2026-03-14   $29.00   paid",
    paidCount: 7,
    ordinal: "7th",
    firstPaidDateIso: "2026-02-14T00:00:00.000Z",
  },
  dup: null,
  postiz: {
    orgName: "Example Media",
    tier: "PRO",
    loginProvider: "a Google account",
    activated: true,
    subPeriod: "MONTHLY",
  },
  usage: {
    published: 142,
    publishedDeleted: 12,
    publishedBeforeCharge: 119,
    publishedSinceCharge: 23,
    publishedDeletedSinceCharge: 2,
    deletedAfterDispute: 0,
    firstPublishedIso: "2026-02-03T00:00:00.000Z",
    lastPublishedIso: "2026-09-09T00:00:00.000Z",
    perPlatform: [
      { platform: "linkedin", count: 61 },
      { platform: "x", count: 48 },
      { platform: "instagram", count: 33 },
    ],
    perPlatformSinceCharge: [
      { platform: "linkedin", count: 14 },
      { platform: "x", count: 9 },
    ],
    channelsLive: 3,
    channelsDeleted: 1,
    channelsDuringPeriod: 3,
    channels: [
      { name: "Example Media", platform: "linkedin", connectedIso: "2026-02-03T00:00:00.000Z", deletedIso: null, disabled: false },
      { name: "@examplemedia", platform: "x", connectedIso: "2026-02-03T00:00:00.000Z", deletedIso: null, disabled: false },
    ],
    recentPosts: [
      { publishedIso: "2026-09-09T00:00:00.000Z", platform: "linkedin", url: "https://www.linkedin.com/posts/example_abc" },
    ],
    recentPostsSinceCharge: [
      { publishedIso: "2026-09-09T00:00:00.000Z", platform: "linkedin", url: "https://www.linkedin.com/posts/example_abc" },
    ],
    queued: 6,
    lastSignInIso: "2026-09-09T00:00:00.000Z",
  },
  cards: { sameCardPriorCount: 6, sameCardFirstIso: "2026-02-14T00:00:00.000Z", sameCard3dsIso: "2026-02-14T00:00:00.000Z" },
  support: {
    historyLines: "2026-08-20 customer asked about scheduling a thread",
    conversationCount: 2,
    firstContactIso: "2026-03-02T00:00:00.000Z",
    lastContactIso: "2026-08-20T00:00:00.000Z",
    transcript: [],
    noRefundRequest: true,
  },
  // Reach only drives reporting, never rendering: a token resolves from the
  // fact, not from whether its feed was alive.
  reach: { charge: true, sub: true, billing: true, postiz: true, usage: true, cards: true, support: true },
  ...over,
});

// Nothing known at all beyond the dispute itself.
const emptyFacts = (): EvidenceFacts => ({
  dispute: { id: "dp_x", amountText: "$1.00", reason: "general", openedIso: "2026-09-10T00:00:00.000Z", dueIso: null },
  charge: null,
  customer: null,
  sub: null,
  billing: null,
  dup: null,
  postiz: null,
  support: null,
  usage: null,
  cards: null,
  reach: { charge: false, sub: false, billing: false, postiz: false, usage: false, cards: false, support: false },
});

const allTemplates = (): EvidenceTemplate[] => {
  const out = [...GENERIC_TEMPLATES];
  for (const reason of PACK_REASONS) out.push(...Object.values(TEMPLATE_LIBRARY[reason]));
  return out;
};

// ---- corpus lint ----

test("corpus: every token a template uses exists in the registry", () => {
  const unknown: string[] = [];
  for (const template of allTemplates()) {
    for (const token of templateTokens(template)) {
      if (!TOKENS[token]) unknown.push(`${template.field}: {{${token}}}`);
    }
  }
  assert.deepEqual(unknown, [], `templates reference tokens that do not resolve:\n  ${unknown.join("\n  ")}`);
});

test("corpus: every template targets a real Stripe text evidence key", () => {
  const keys = new Set<string>(TEXT_EVIDENCE_KEYS);
  for (const template of allTemplates()) {
    assert.ok(keys.has(template.field), `${template.field} is not a Stripe text evidence key`);
  }
});

test("corpus: no em-dashes and no internal artifacts reach a bank analyst", () => {
  for (const template of allTemplates()) {
    for (const block of template.blocks) {
      assert.ok(!block.text.includes("—"), `${template.field} contains an em-dash`);
      assert.ok(
        !NO_INTERNAL_ARTIFACT.test(block.text),
        `${template.field} mentions an internal artifact: ${block.text.slice(0, 80)}`
      );
    }
  }
});

test("corpus: every packed field resolves to a template through the fallback chain", () => {
  const unresolved: string[] = [];
  for (const reason of PACK_REASONS) {
    for (const field of PACK_FIELDS_BY_REASON[reason]) {
      if (!templateFor(reason, field)) unresolved.push(`${reason}/${field}`);
    }
  }
  assert.deepEqual(unresolved, [], `packed fields with no template:\n  ${unresolved.join("\n  ")}`);
});

test("corpus: no pack ever includes a shipping field or the purchase IP", () => {
  // Shipping is unfillable for software delivered online, and the payment's
  // client IP is not exposed by any Stripe API object.
  for (const reason of PACK_REASONS) {
    for (const field of PACK_FIELDS_BY_REASON[reason]) {
      assert.ok(!field.startsWith("shipping_"), `${reason} packs ${field}`);
      assert.notEqual(field, "customer_purchase_ip", `${reason} packs the purchase IP, which cannot be known`);
    }
  }
});

test("corpus: every packed field carries a score weight", () => {
  for (const reason of PACK_REASONS) {
    for (const field of PACK_FIELDS_BY_REASON[reason]) {
      assert.ok(FIELD_WEIGHTS[field] > 0, `${field} is packed but has no weight, so it cannot affect the score`);
    }
  }
});

test("corpus: PLAN_FACTS covers every tier the segment resolver can produce", () => {
  for (const tier of ["STANDARD", "TEAM", "PRO", "ULTIMATE"]) {
    assert.ok(PLAN_FACTS[tier], `no published plan facts for ${tier}`);
    assert.ok(PLAN_FACTS[tier].channels > 0);
  }
});

test("packReasonFor: unlisted Stripe reasons fall back to the generic corpus", () => {
  assert.equal(packReasonFor("duplicate"), "duplicate");
  assert.equal(packReasonFor("fraudulent"), "fraudulent");
  assert.equal(packReasonFor("product_unacceptable"), "general");
  assert.equal(packReasonFor("bank_cannot_process"), "general");
  assert.equal(packReasonFor(null), "general");
  assert.equal(packReasonFor("general"), "general");
});

// ---- rendering ----

function renderPack(reason: PackReason, facts: EvidenceFacts) {
  const tokens = resolveTokens(facts);
  const out = new Map<string, ReturnType<typeof renderField>>();
  for (const field of PACK_FIELDS_BY_REASON[reason]) {
    const template = templateFor(reason, field);
    if (template) out.set(field, renderField(template, tokens, facts));
  }
  return out;
}

test("render: a complete fact bag fills every field of a subscription_canceled pack", () => {
  const rendered = renderPack("subscription_canceled", fullFacts());
  const empty = [...rendered.values()].filter((r) => r.text == null).map((r) => `${r.field} (${r.dropped})`);
  assert.deepEqual(empty, [], `fields dropped despite complete facts:\n  ${empty.join("\n  ")}`);
  for (const r of rendered.values()) {
    assert.ok(r.text && !r.text.includes("{{"), `${r.field} leaked a token`);
  }
  const narrative = rendered.get("uncategorized_text")?.text ?? "";
  assert.ok(narrative.includes("alex@example.com"));
  assert.ok(narrative.length > 400);
});

test("render: an EMPTY fact bag never leaks a placeholder, for every template in the corpus", () => {
  // The anti-leak property. A rendered field is either grounded or absent, so
  // no template may emit a hole under any combination of missing facts.
  const facts = emptyFacts();
  const tokens = resolveTokens(facts);
  for (const template of allTemplates()) {
    const out = renderField(template, tokens, facts);
    if (out.text != null) {
      assert.ok(!out.text.includes("{{"), `${template.field} leaked a token on empty facts`);
      assert.ok(!out.text.includes("}}"), `${template.field} leaked a token on empty facts`);
    }
  }
});

test("render: a missing fact drops only the paragraph that used it", () => {
  const facts = fullFacts({ sub: { ...fullFacts().sub!, canceledAtIso: null } });
  const rebuttal = renderPack("subscription_canceled", facts).get("cancellation_rebuttal");
  assert.ok(rebuttal?.text, "the field survives a missing cancellation date");
  assert.ok(!rebuttal.text.includes("A cancellation was recorded"), "the paragraph that needed it is gone");
  assert.ok(rebuttal.text.includes("was not cancelled before the disputed renewal"), "the rest survives");
});

test("render: no Postiz answer keeps the Stripe half of the activity log", () => {
  const log = renderPack("general", fullFacts({ postiz: null })).get("access_activity_log");
  assert.ok(log?.text, "the activity log survives without platform facts");
  assert.ok(!log.text.includes("signs in using"), "the platform paragraph is gone");
  assert.ok(log.text.includes("Payment history"), "the Stripe payment history remains");
});

test("render: a negative is never asserted from an absent lookup", () => {
  // refund_refusal_explanation claims no refund was requested. That claim is
  // only permitted when Intercom actually answered and said so.
  const off = renderPack("subscription_canceled", fullFacts({ support: null })).get("refund_refusal_explanation");
  assert.equal(off?.text, null);
  assert.equal(off?.dropped, "missing_requires");

  const unknown = renderPack(
    "subscription_canceled",
    fullFacts({ support: { ...fullFacts().support!, noRefundRequest: null } })
  ).get("refund_refusal_explanation");
  assert.equal(unknown?.text, null, "a timed-out or errored lookup must not license the claim");

  const confirmed = renderPack("subscription_canceled", fullFacts()).get("refund_refusal_explanation");
  assert.ok(confirmed?.text?.includes("no refund was requested"));
});

test("render: the duplicate branches are mutually exclusive and never invent a charge id", () => {
  const withSibling = fullFacts({
    dispute: { ...fullFacts().dispute, reason: "duplicate" },
    dup: {
      originalChargeId: "ch_original",
      originalInvoiceNumber: "1A2B-0005",
      originalDateIso: "2026-07-14T00:00:00.000Z",
      originalAmountText: "$29.00",
      daysApart: 31,
      candidateCount: 1,
    },
  });
  const a = renderPack("duplicate", withSibling);
  assert.equal(a.get("duplicate_charge_id")?.text, "ch_original");
  const explainA = a.get("duplicate_charge_explanation")?.text ?? "";
  assert.ok(explainA.includes("ch_original"));
  assert.ok(!explainA.includes("Only one charge"), "variant B must not also render");

  const without = fullFacts({ dispute: { ...fullFacts().dispute, reason: "duplicate" }, dup: null });
  const b = renderPack("duplicate", without);
  assert.equal(b.get("duplicate_charge_id")?.text, null, "no candidate means no id, never a guessed one");
  const explainB = b.get("duplicate_charge_explanation")?.text ?? "";
  assert.ok(explainB.includes("Only one charge"));
  assert.ok(!explainB.includes("separate subscription periods"), "variant A must not also render");
});

test("render: a field below its minimum length is dropped rather than staged as a stub", () => {
  const template: EvidenceTemplate = { field: "uncategorized_text", minChars: 200, blocks: [{ text: "Too short." }] };
  const out = renderField(template, {}, emptyFacts());
  assert.equal(out.text, null);
  assert.equal(out.dropped, "too_short");
});

test("render: an em-dash is scrubbed, an internal artifact drops the field", () => {
  const dash: EvidenceTemplate = {
    field: "uncategorized_text",
    minChars: 1,
    blocks: [{ text: "The subscription renewed—as disclosed—on the anniversary date of the original purchase." }],
  };
  const scrubbed = renderField(dash, {}, emptyFacts());
  assert.ok(scrubbed.text && !scrubbed.text.includes("—"));
  assert.ok(scrubbed.text.includes("renewed, as disclosed, on"));

  const leak: EvidenceTemplate = {
    field: "uncategorized_text",
    minChars: 1,
    blocks: [{ text: "Our refund policy, documented in ./postiz-docs/cloud/refunds.mdx, applies to everyone." }],
  };
  assert.equal(renderField(leak, {}, emptyFacts()).dropped, "internal_artifact");
});

test("render: usage.summary degrades through its sources instead of vanishing", () => {
  const full = resolveTokens(fullFacts());
  assert.ok(full["usage.summary"]?.includes("Example Media"));

  const stripeOnly = resolveTokens(fullFacts({ postiz: null }));
  assert.ok(stripeOnly["usage.summary"]?.includes("7 subscription charges"));

  assert.equal(resolveTokens(emptyFacts())["usage.summary"], null);
});

test("tokens: a throwing resolver reads as unresolved, not as a crash", () => {
  const facts = emptyFacts();
  const resolved = resolveTokens(facts);
  assert.equal(Object.keys(resolved).length, TOKEN_NAMES.length);
  for (const name of TOKEN_NAMES) assert.ok(name in resolved);
});

// ---- completeness score and the auto-submit gate ----

import { EvidencePackBuilder, scorePack } from "../billing/evidence/EvidencePackBuilder";

const fullPackFields = (reason: PackReason): Record<string, string> =>
  Object.fromEntries(PACK_FIELDS_BY_REASON[reason].map((f) => [f, "x".repeat(250)]));

test("score: a complete pack is 100, an empty one is 0, the receipt bonus cannot exceed 100", () => {
  assert.equal(scorePack("general", fullPackFields("general"), false), 100);
  assert.equal(scorePack("general", {}, false), 0);
  assert.equal(scorePack("general", fullPackFields("general"), true), 100, "the bonus is capped, not additive past 100");
});

test("score: the narrative fields dominate the cheap scalar ones", () => {
  const scalars = { customer_email_address: "a@b.co", service_date: "1 May 2026", customer_name: "A B" };
  const narrative = { product_description: "x".repeat(250), uncategorized_text: "x".repeat(250) };
  assert.ok(
    scorePack("general", narrative, false) > scorePack("general", scalars, false),
    "two narrative fields must outweigh three scalar ones"
  );
});

// Only `settings` is read by autoSubmitDecision, so the rest stay unconstructed.
const builderWith = (over: Record<string, unknown> = {}) =>
  new EvidencePackBuilder(
    null as never,
    {
      disputeAutoSubmitEnabled: () => true,
      disputeAutoSubmitHours: () => 24,
      disputeAutoSubmitMinScore: () => 70,
      disputeAutoSubmitMaxMinor: () => null,
      disputeTemplateIntercomEnabled: () => true,
      ...over,
    } as never,
    null as never,
    null as never,
    null as never,
    null as never
  );

const NOW = new Date("2026-09-16T12:00:00.000Z");
const dueIn = (hours: number) => Math.floor((NOW.getTime() + hours * 3_600_000) / 1000);
const gateDispute = (over: Record<string, unknown> = {}) =>
  ({
    id: "dp_1",
    status: "needs_response",
    amount: 4900,
    evidence_details: { due_by: dueIn(12), submission_count: 0 },
    ...over,
  }) as never;
const gateRow = (over: Record<string, unknown> = {}) =>
  ({ evidenceTouchedAt: null, evidenceAutoOptOut: false, evidenceSubmittedAt: null, ...over }) as never;
const strongPack = { score: 90, fields: fullPackFields("general") };

test("auto-submit: a strong, untouched, near-deadline pack is allowed through", async () => {
  const d = await builderWith().autoSubmitDecision(gateDispute(), gateRow(), strongPack, NOW);
  assert.deepEqual(d, { kind: "submit" });
});

test("auto-submit: every gate refuses for its own reason", async () => {
  const cases: Array<[string, Promise<{ kind: string }>]> = [
    ["disabled", builderWith({ disputeAutoSubmitEnabled: () => false }).autoSubmitDecision(gateDispute(), gateRow(), strongPack, NOW)],
    ["not_respondable", builderWith().autoSubmitDecision(gateDispute({ status: "under_review" }), gateRow(), strongPack, NOW)],
    ["already_submitted", builderWith().autoSubmitDecision(gateDispute(), gateRow({ evidenceSubmittedAt: NOW }), strongPack, NOW)],
    ["opted_out", builderWith().autoSubmitDecision(gateDispute(), gateRow({ evidenceAutoOptOut: true }), strongPack, NOW)],
    ["human_touched", builderWith().autoSubmitDecision(gateDispute(), gateRow({ evidenceTouchedAt: NOW }), strongPack, NOW)],
    ["no_deadline", builderWith().autoSubmitDecision(gateDispute({ evidence_details: { due_by: null, submission_count: 0 } }), gateRow(), strongPack, NOW)],
    ["past_deadline", builderWith().autoSubmitDecision(gateDispute({ evidence_details: { due_by: dueIn(-1), submission_count: 0 } }), gateRow(), strongPack, NOW)],
    ["not_due_yet", builderWith().autoSubmitDecision(gateDispute({ evidence_details: { due_by: dueIn(100), submission_count: 0 } }), gateRow(), strongPack, NOW)],
    ["over_amount", builderWith({ disputeAutoSubmitMaxMinor: () => 1000 }).autoSubmitDecision(gateDispute(), gateRow(), strongPack, NOW)],
    ["low_score", builderWith().autoSubmitDecision(gateDispute(), gateRow(), { ...strongPack, score: 40 }, NOW)],
  ];
  for (const [expected, promise] of cases) {
    const d = (await promise) as { kind: string; why?: string };
    assert.equal(d.kind, "refuse", `${expected} should refuse`);
    assert.equal(d.why, expected);
  }
});

test("auto-submit: a high score on thin narrative fields is still refused", async () => {
  // The gate that stops a package scoring 75 on an email, a date and a name
  // from being sent to a bank with nothing that argues the case.
  const thin = {
    score: 95,
    fields: { ...fullPackFields("general"), uncategorized_text: "Short.", product_description: "x".repeat(250) },
  };
  const d = (await builderWith().autoSubmitDecision(gateDispute(), gateRow(), thin, NOW)) as { kind: string; why?: string };
  assert.equal(d.kind, "refuse");
  assert.equal(d.why, "thin_narrative");
});
