import { test } from "node:test";
import assert from "node:assert/strict";
import { nsTimestamp } from "../InfluxWriter";
import {
  MONEY_OUT_TAG_KEYS,
  moneyOutFields,
  moneyOutTags,
  disputeOutcomeTags,
  subscriptionEventTags,
  moneyOutPointFor,
} from "../../bot/billing/moneyPoints";
import type { StripeMoneyOut } from "../../generated/prisma/client";

// Regression guards for the two bugs that made the money numbers wrong.
//
// Influx identifies a point by measurement + tag set + timestamp. Two writes
// agreeing on all three overwrite; two disagreeing on any of them are two
// separate points. Every test below is about one of those three.

const row = (over: Partial<StripeMoneyOut> = {}): StripeMoneyOut =>
  ({
    id: "txn_1",
    kind: "LEDGER",
    bucket: "CASH",
    category: "refund",
    amountMinor: 4_200,
    feeMinor: 0,
    netMinor: 4_200,
    currency: "eur",
    source: "sweep",
    reason: null,
    stripeObjectId: "re_1",
    chargeId: "ch_1",
    customerId: "cus_1",
    invoiceId: null,
    occurredAt: new Date("2026-03-04T05:06:07.000Z"),
    planTier: null,
    planPeriod: null,
    cardBrand: null,
    cardFunding: null,
    cardCountry: null,
    refundReason: null,
    refundKind: null,
    chargeAge: null,
    tenure: null,
    networkReason: null,
    surface: null,
    usdMinor: null,
    feeUsdMinor: null,
    netUsdMinor: null,
    fxRate: null,
    fxRatesAt: null,
    retiredAt: null,
    retiredReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as StripeMoneyOut;

// ---- bug A: a tag that differs between the live and rebuild paths ----

test("source is NOT a tag", () => {
  // It used to be. The re-emit hardcoded source:"backfill" while the live paths
  // emitted the row's real source, so every re-emitted row landed as a SECOND
  // point beside the original instead of overwriting it — and every money panel
  // does |> group() |> sum() across all tags, so the totals doubled.
  assert.ok(!MONEY_OUT_TAG_KEYS.includes("source" as never), "source must never be a tag again");
  assert.equal(moneyOutFields(row()).source, "sweep", "but it must still be visible as a field");
});

test("two rows differing ONLY in source produce the identical tag set", () => {
  // The direct expression of the bug: the same movement, discovered two
  // different ways, must be one point.
  assert.deepEqual(moneyOutTags(row({ source: "sweep" })), moneyOutTags(row({ source: "backfill" })));
});

test("the money_out tag set is exactly this, and is stable", () => {
  // Pinned deliberately. Adding or removing a tag forks EVERY existing series
  // in the measurement, so it should be a decision, not a diff nobody noticed.
  assert.deepEqual(
    [...MONEY_OUT_TAG_KEYS],
    [
      "bucket",
      "category",
      "currency",
      "plan_tier",
      "plan_period",
      "card_brand",
      "card_funding",
      "card_country",
      "refund_reason",
      "refund_kind",
      "charge_age",
      "tenure",
      "network_reason",
      "surface",
    ]
  );
  assert.deepEqual(Object.keys(moneyOutTags(row())).sort(), [...MONEY_OUT_TAG_KEYS].sort());
});

test("every segment tag is present even when the row knows nothing", () => {
  // A tag present on some points and absent on others splits one Grafana
  // group-by into two disjoint answers to the same question.
  const tags = moneyOutTags(row());
  for (const key of MONEY_OUT_TAG_KEYS) {
    assert.ok(tags[key], `${key} must be present`);
  }
  assert.equal(tags.plan_tier, "unknown");
  assert.equal(tags.card_brand, "unknown");
});

test("tags are pure: same row in, same tags out", () => {
  const r = row({ planTier: "PRO", cardBrand: "visa" });
  assert.deepEqual(moneyOutTags(r), moneyOutTags(r));
});

test("the other two money measurements always emit their full tag set too", () => {
  const dispute = disputeOutcomeTags({
    id: "dp_1",
    status: "won",
    reason: "fraudulent",
    amount: 5_000,
    currency: "usd",
    closedAt: new Date(),
    closedAtEstimated: true,
    closedAtSource: null,
    evidenceSubmittedAt: null,
    usdMinor: null,
    fxRate: null,
    planTier: null,
    planPeriod: null,
    cardBrand: null,
    cardFunding: null,
    cardCountry: null,
    networkReason: null,
    tenure: null,
  });
  for (const v of Object.values(dispute)) assert.ok(v, "no dispute tag may be empty");

  const sub = subscriptionEventTags({
    id: "evt_1:canceled",
    event: "canceled",
    planTier: "PRO",
    planPeriod: "MONTHLY",
    fromTier: null,
    fromPeriod: null,
    currency: "eur",
    churnType: null,
    cancelReason: null,
    cancelFeedback: null,
    cardCountry: null,
  } as never);
  for (const v of Object.values(sub)) assert.ok(v, "no subscription tag may be empty");
  // Absence is spelled out rather than left blank, for the same reason.
  assert.equal(sub.from_tier, "none");
  assert.equal(sub.churn_type, "unknown");
});

// ---- bug B: two movements in the same second collapsing into one point ----

test("nsTimestamp is deterministic", () => {
  // The whole idempotency story: re-emitting a row must reproduce its own
  // timestamp exactly, or the rebuild adds a point instead of replacing one.
  const at = new Date("2026-03-04T05:06:07.000Z");
  assert.equal(nsTimestamp(at, "txn_1"), nsTimestamp(at, "txn_1"));
});

test("two different rows in the SAME millisecond get different timestamps", () => {
  // Stripe stamps to the second, so occurredAt is always X.000ms. At the old
  // millisecond precision, two similar refunds in one second were the same
  // point and one silently overwrote the other — money vanishing from a chart.
  const at = new Date("2026-03-04T05:06:07.000Z");
  const a = nsTimestamp(at, "txn_aaa");
  const b = nsTimestamp(at, "txn_bbb");
  assert.notEqual(a, b);
});

test("the disambiguator stays strictly inside its own millisecond", () => {
  // It must never bleed into the next millisecond, or a point would be filed
  // under a time it did not happen.
  const at = new Date("2026-03-04T05:06:07.000Z");
  const floor = BigInt(at.getTime()) * 1_000_000n;
  for (const id of ["a", "txn_zzzzzzzzzzzz", "in_1:disc:di_9", "", "0"]) {
    const ns = BigInt(nsTimestamp(at, id));
    assert.ok(ns >= floor, `${id} underflowed its millisecond`);
    assert.ok(ns < floor + 1_000_000n, `${id} overflowed into the next millisecond`);
  }
});

test("spread across the sub-millisecond space is wide enough to matter", () => {
  // 1000 ids in one second should essentially never collide. This is a sanity
  // check on the hash, not a proof: collisions are possible, just rare enough
  // that the failure mode is one lost point rather than a systematic one.
  const at = new Date("2026-03-04T05:06:07.000Z");
  const seen = new Set<string>();
  for (let i = 0; i < 1_000; i++) seen.add(nsTimestamp(at, `txn_${i}`));
  assert.ok(seen.size >= 999, `expected ~1000 distinct offsets, got ${seen.size}`);
});

// ---- retired rows ----

test("a retired row produces no point at all", () => {
  // Retired means superseded by a better measurement of the same money — the
  // coupon estimates replaced by invoice actuals. Both are still in the table,
  // and emitting the old one would double the concession it belongs to.
  assert.equal(moneyOutPointFor(row({ retiredAt: new Date() })), null);
  assert.ok(moneyOutPointFor(row()), "a live row still produces one");
});
