import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import {
  MAX_COMMENT_LENGTH,
  SEGMENT_TAG_KEYS,
  chargeAgeBucket,
  churnTypeOf,
  itemMrrMinor,
  normalizeBrand,
  normalizeCountry,
  normalizeFunding,
  normalizeNetworkReason,
  normalizeRefundReason,
  planTagsFromPrice,
  scrubFreeText,
  segmentTags,
  subscriptionMrrMinor,
  tenureBucket,
} from "../billing/segments";
import { classifySubscriptionEvent } from "../billing/subscriptionEvents";

// The segment axes are Influx TAGS and they describe paying customers, so two
// properties have to hold and neither is negotiable: no value may identify a
// person, and no value may be unbounded. These tests pin both, plus the churn
// transition rules, which are the part most likely to silently double-count.

// ---- bounded vocabularies ----

test("unrecognised tag values collapse to unknown rather than passing through", () => {
  // The whole cardinality guarantee rests on this: if a new Stripe enum value
  // or a junk string could pass through, one bad payload mints a new series.
  assert.equal(normalizeBrand("some_new_network_2031"), "unknown");
  assert.equal(normalizeFunding("crypto"), "unknown");
  assert.equal(normalizeRefundReason("because_i_felt_like_it"), "unknown");
  assert.equal(normalizeNetworkReason("a-reason-code-far-too-long-to-be-one"), "unknown");
  // Known values survive, lower-cased.
  assert.equal(normalizeBrand("VISA"), "visa");
  assert.equal(normalizeFunding("Prepaid"), "prepaid");
  assert.equal(normalizeRefundReason("fraudulent"), "fraudulent");
  assert.equal(normalizeNetworkReason("10.4"), "10.4");
});

test("country is an ISO-2 code or nothing, never a free-text address", () => {
  assert.equal(normalizeCountry("de"), "DE");
  assert.equal(normalizeCountry("  us "), "US");
  // A full address or country name is exactly the PII shape that must not leak
  // into a tag, so anything that is not two letters is refused outright.
  assert.equal(normalizeCountry("Germany"), "unknown");
  assert.equal(normalizeCountry("12 Example Street, Berlin"), "unknown");
  assert.equal(normalizeCountry(null), "unknown");
});

test("a missing segment renders as unknown, so every point carries every tag key", () => {
  // A tag present on some points and absent on others splits a Grafana
  // group-by into two disjoint answers to one question.
  const tags = segmentTags(null);
  assert.deepEqual(Object.keys(tags).sort(), [...SEGMENT_TAG_KEYS].sort());
  for (const [key, value] of Object.entries(tags)) {
    assert.equal(value, "unknown", `${key} should default to unknown`);
  }
  // A partially-known set still emits the full key set.
  const partial = segmentTags({ planTier: "PRO", cardCountry: "DE" });
  assert.deepEqual(Object.keys(partial).sort(), [...SEGMENT_TAG_KEYS].sort());
  assert.equal(partial.plan_tier, "PRO");
  assert.equal(partial.card_country, "DE");
  assert.equal(partial.card_brand, "unknown");
});

// ---- free text ----

test("a cancellation comment is stripped of every identifier shape", () => {
  const scrubbed = scrubFreeText(
    "Hi, it's Jane Doe, jane.doe@example.com, call me on +49 170 1234567 — see https://app.example.com/orgs/abc, customer cus_SomeRealId12345"
  );
  assert.ok(scrubbed);
  for (const leak of ["jane.doe@example.com", "example.com", "1234567", "cus_SomeRealId12345"]) {
    assert.ok(!scrubbed.includes(leak), `scrubbed text still contains ${leak}`);
  }
  assert.ok(scrubbed.includes("[email]"));
  assert.ok(scrubbed.includes("[url]"));
  assert.ok(scrubbed.includes("[id]"));
});

test("a comment is truncated, so one pathological note cannot become a payload", () => {
  const scrubbed = scrubFreeText("word ".repeat(500));
  assert.ok(scrubbed);
  assert.ok(scrubbed.length <= MAX_COMMENT_LENGTH);
});

test("an empty or whitespace-only comment becomes null, not an empty string", () => {
  assert.equal(scrubFreeText("   "), null);
  assert.equal(scrubFreeText(null), null);
  assert.equal(scrubFreeText(undefined), null);
});

// ---- buckets ----

test("charge age buckets separate instant remorse from a goodwill refund", () => {
  const charged = new Date("2026-01-01T00:00:00Z");
  const at = (iso: string) => chargeAgeBucket(charged, new Date(iso));
  assert.equal(at("2026-01-01T06:00:00Z"), "same_day");
  assert.equal(at("2026-01-05T00:00:00Z"), "1_7d");
  assert.equal(at("2026-01-20T00:00:00Z"), "8_30d");
  assert.equal(at("2026-02-20T00:00:00Z"), "31_90d");
  assert.equal(at("2026-06-01T00:00:00Z"), "90d_plus");
  // Never looked, and a clock that ran backwards, both read "unknown" rather
  // than inventing a bucket.
  assert.equal(chargeAgeBucket(null, new Date()), "unknown");
  assert.equal(at("2025-12-01T00:00:00Z"), "unknown");
});

test("tenure buckets are derived, and the underlying date never becomes a tag", () => {
  const created = new Date("2026-01-01T00:00:00Z");
  assert.equal(tenureBucket(created, new Date("2026-01-01T03:00:00Z")), "first_day");
  assert.equal(tenureBucket(created, new Date("2026-01-20T00:00:00Z")), "under_30d");
  assert.equal(tenureBucket(created, new Date("2026-03-01T00:00:00Z")), "1_3mo");
  assert.equal(tenureBucket(created, new Date("2026-09-01T00:00:00Z")), "3mo_plus");
  assert.equal(tenureBucket(null, new Date()), "unknown");
});

// ---- plan ----

function price(unitAmount: number, interval: "month" | "year", currency = "usd"): Stripe.Price {
  return {
    currency,
    unit_amount: unitAmount,
    recurring: { interval, interval_count: 1 },
  } as Stripe.Price;
}

test("a canonical Postiz price resolves to its tier, a non-canonical one to custom", () => {
  assert.deepEqual(planTagsFromPrice(price(4900, "month")), { planTier: "PRO", planPeriod: "MONTHLY" });
  assert.deepEqual(planTagsFromPrice(price(95000, "year")), { planTier: "ULTIMATE", planPeriod: "YEARLY" });
  // "custom" and "unknown" are different claims: custom means we looked and it
  // genuinely is a bespoke amount, unknown means nobody looked.
  assert.deepEqual(planTagsFromPrice(price(1234, "month")), { planTier: "custom", planPeriod: "custom" });
  assert.deepEqual(planTagsFromPrice(null), { planTier: "unknown", planPeriod: "unknown" });
});

// ---- MRR ----

test("MRR normalises every interval to a month so plans sit on one axis", () => {
  assert.equal(itemMrrMinor({ price: price(2900, "month"), quantity: 1 }), 2900);
  // A yearly plan contributes a twelfth per month, which is what makes "MRR
  // lost to churn" comparable between a monthly and a yearly customer.
  assert.equal(itemMrrMinor({ price: price(27800, "year"), quantity: 1 }), Math.round(27800 / 12));
  assert.equal(itemMrrMinor({ price: price(2900, "month"), quantity: 3 }), 8700);
  assert.equal(itemMrrMinor({ price: null, quantity: 1 }), 0);
});

// ---- churn transitions ----

function sub(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    currency: "usd",
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    pause_collection: null,
    cancellation_details: null,
    items: { data: [{ price: price(4900, "month"), quantity: 1 }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

const AT = new Date("2026-05-01T00:00:00Z");

test("a signup counts its MRR as arriving, a trial counts nothing yet", () => {
  const [created] = classifySubscriptionEvent("customer.subscription.created", sub(), null, AT);
  assert.equal(created.event, "created");
  assert.equal(created.mrrDeltaMinor, 4900);

  // Counting a trial as revenue on day one and again as churn when it lapses
  // would invent revenue that never existed.
  const [trial] = classifySubscriptionEvent(
    "customer.subscription.created",
    sub({ status: "trialing" }),
    null,
    AT
  );
  assert.equal(trial.event, "trial_started");
  assert.equal(trial.mrrDeltaMinor, 0);
});

test("a cancellation carries the plan, the reason enums and the churn type", () => {
  const [movement] = classifySubscriptionEvent(
    "customer.subscription.deleted",
    sub({
      cancellation_details: {
        reason: "cancellation_requested",
        feedback: "too_expensive",
        comment: "too pricey, reach me at a@b.com",
      },
    } as Partial<Stripe.Subscription>),
    null,
    AT
  );
  assert.equal(movement.event, "canceled");
  assert.equal(movement.planTier, "PRO");
  assert.equal(movement.mrrDeltaMinor, -4900);
  assert.equal(movement.churnType, "voluntary");
  assert.equal(movement.cancelReason, "cancellation_requested");
  assert.equal(movement.cancelFeedback, "too_expensive");
  // The comment survives, the email in it does not.
  assert.ok(movement.comment?.includes("[email]"));
  assert.ok(!movement.comment?.includes("a@b.com"));
});

test("a dunning cancellation is involuntary, which is a different problem entirely", () => {
  const [movement] = classifySubscriptionEvent(
    "customer.subscription.deleted",
    sub({ cancellation_details: { reason: "payment_failed", feedback: null, comment: null } } as Partial<Stripe.Subscription>),
    null,
    AT
  );
  assert.equal(movement.churnType, "involuntary");
  assert.equal(churnTypeOf({ reason: "cancellation_requested" } as Stripe.Subscription.CancellationDetails), "voluntary");
});

test("a scheduled cancellation is at-risk revenue, not lost revenue", () => {
  const [movement] = classifySubscriptionEvent(
    "customer.subscription.updated",
    sub({ cancel_at_period_end: true }),
    { cancel_at_period_end: false },
    AT
  );
  assert.equal(movement.event, "cancel_scheduled");
  // Adding this to the delta would count the same churn twice: once when it is
  // scheduled and again when the subscription actually ends.
  assert.equal(movement.mrrDeltaMinor, 0);
  assert.equal(movement.mrrAtRiskMinor, 4900);
});

test("an update that changes nothing relevant emits nothing", () => {
  // This is the whole reason transitions are read from previous_attributes: a
  // subscription that has been pending cancellation for weeks looks identical
  // to one cancelled a second ago, and keying off the object would re-emit the
  // same cancellation on every subsequent update.
  const movements = classifySubscriptionEvent(
    "customer.subscription.updated",
    sub({ cancel_at_period_end: true }),
    { items: undefined } as never,
    AT
  );
  assert.deepEqual(movements, []);
});

test("a plan change is signed by direction and names the plan it came from", () => {
  const [up] = classifySubscriptionEvent(
    "customer.subscription.updated",
    sub({ items: { data: [{ price: price(9900, "month"), quantity: 1 }] } } as Partial<Stripe.Subscription>),
    { items: { data: [{ price: price(2900, "month"), quantity: 1 }] } } as never,
    AT
  );
  assert.equal(up.event, "upgraded");
  assert.equal(up.planTier, "ULTIMATE");
  assert.equal(up.fromTier, "STANDARD");
  assert.equal(up.mrrDeltaMinor, 9900 - 2900);

  const [down] = classifySubscriptionEvent(
    "customer.subscription.updated",
    sub({ items: { data: [{ price: price(2900, "month"), quantity: 1 }] } } as Partial<Stripe.Subscription>),
    { items: { data: [{ price: price(9900, "month"), quantity: 1 }] } } as never,
    AT
  );
  assert.equal(down.event, "downgraded");
  assert.equal(down.fromTier, "ULTIMATE");
  assert.equal(down.mrrDeltaMinor, 2900 - 9900);
});

test("a save cancels out the at-risk revenue it previously flagged", () => {
  const [movement] = classifySubscriptionEvent(
    "customer.subscription.updated",
    sub({ cancel_at_period_end: false }),
    { cancel_at_period_end: true },
    AT
  );
  assert.equal(movement.event, "cancel_reverted");
  // Negative, so a window sum of at-risk is the revenue still genuinely
  // pending departure rather than every cancellation ever scheduled.
  assert.equal(movement.mrrAtRiskMinor, -4900);
});

test("a failing payment is flagged before it becomes involuntary churn", () => {
  const [failing] = classifySubscriptionEvent(
    "customer.subscription.updated",
    sub({ status: "past_due" }),
    { status: "active" },
    AT
  );
  assert.equal(failing.event, "payment_failing");
  assert.equal(failing.mrrAtRiskMinor, 4900);

  const [recovered] = classifySubscriptionEvent(
    "customer.subscription.updated",
    sub({ status: "active" }),
    { status: "past_due" },
    AT
  );
  assert.equal(recovered.event, "payment_recovered");
  assert.equal(recovered.mrrAtRiskMinor, -4900);
});

test("one event carrying several changes yields one movement per change", () => {
  // A plan change that also calls off a pending cancellation is one webhook and
  // two facts. Collapsing it to one would lose whichever was not chosen, which
  // is why the caller keys rows on event id PLUS movement name.
  const movements = classifySubscriptionEvent(
    "customer.subscription.updated",
    sub({
      cancel_at_period_end: false,
      items: { data: [{ price: price(9900, "month"), quantity: 1 }] },
    } as Partial<Stripe.Subscription>),
    { cancel_at_period_end: true, items: { data: [{ price: price(4900, "month"), quantity: 1 }] } } as never,
    AT
  );
  const names = movements.map((m) => m.event).sort();
  assert.deepEqual(names, ["cancel_reverted", "upgraded"]);
  assert.equal(new Set(names).size, names.length, "movement names must be unique within one event");
});

test("a trial converting counts as revenue arriving, once", () => {
  const [movement] = classifySubscriptionEvent(
    "customer.subscription.updated",
    sub({ status: "active" }),
    { status: "trialing" },
    AT
  );
  assert.equal(movement.event, "trial_converted");
  assert.equal(movement.mrrDeltaMinor, 4900);
});

test("subscription MRR sums every item", () => {
  const multi = sub({
    items: { data: [{ price: price(2900, "month"), quantity: 1 }, { price: price(4900, "month"), quantity: 2 }] },
  } as Partial<Stripe.Subscription>);
  assert.equal(subscriptionMrrMinor(multi), 2900 + 9800);
});
