import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import {
  buildWindowNumbers,
  computeDisputeRatios,
  computeVampNumerator,
  isChargebackStage,
  ratioLevel,
  windowStarts,
  type DisputeRatios,
  type RatioStripeReads,
} from "../../bot/billing/disputeRatio";

// Minimal fabricators — only the fields the ratio math reads.
const dispute = (p: {
  charge: string;
  created?: number;
  reason?: string;
  status?: string;
  caseType?: "chargeback" | "inquiry";
}): Stripe.Dispute =>
  ({
    id: `dp_${p.charge}`,
    charge: p.charge,
    created: p.created ?? 0,
    reason: p.reason ?? "fraudulent",
    status: p.status ?? "needs_response",
    ...(p.caseType ? { payment_method_details: { card: { case_type: p.caseType }, type: "card" } } : {}),
  }) as unknown as Stripe.Dispute;

const efw = (charge: string, created = 0): Stripe.Radar.EarlyFraudWarning =>
  ({ id: `issfr_${charge}`, charge, created, actionable: true, fraud_type: "made_with_stolen_card" }) as unknown as Stripe.Radar.EarlyFraudWarning;

test("windowStarts: month = UTC 1st 00:00, 30/90d are exact day offsets", () => {
  const now = new Date(Date.UTC(2026, 6, 10, 15, 30, 0)); // 2026-07-10T15:30Z
  const s = windowStarts(now);
  assert.equal(s.month, Date.UTC(2026, 6, 1) / 1000);
  assert.equal(s.d30, Math.floor(now.getTime() / 1000) - 30 * 86400);
  assert.equal(s.d90, Math.floor(now.getTime() / 1000) - 90 * 86400);
  // Month rollover: Jan 1 just after midnight still buckets to Jan 1.
  const jan = windowStarts(new Date(Date.UTC(2027, 0, 1, 0, 0, 5)));
  assert.equal(jan.month, Date.UTC(2027, 0, 1) / 1000);
});

test("isChargebackStage: card case_type wins; non-card falls back to warning_* prefix", () => {
  assert.equal(isChargebackStage(dispute({ charge: "ch_1", caseType: "chargeback" })), true);
  assert.equal(isChargebackStage(dispute({ charge: "ch_2", caseType: "inquiry", status: "needs_response" })), false);
  assert.equal(isChargebackStage(dispute({ charge: "ch_3", status: "warning_needs_response" })), false);
  assert.equal(isChargebackStage(dispute({ charge: "ch_4", status: "under_review" })), true);
});

test("computeVampNumerator dedupes by charge and excludes inquiries", () => {
  const disputes = [
    dispute({ charge: "ch_both", caseType: "chargeback", reason: "fraudulent" }), // also has an EFW → counts once
    dispute({ charge: "ch_nonfraud", caseType: "chargeback", reason: "product_not_received" }), // non-fraud chargeback counts
    dispute({ charge: "ch_inquiry", caseType: "inquiry", status: "warning_needs_response" }), // inquiry excluded
  ];
  const efws = [efw("ch_both"), efw("ch_efw_only")];
  assert.equal(computeVampNumerator(disputes, efws), 3); // ch_both, ch_nonfraud, ch_efw_only
});

test("buildWindowNumbers: pct math, inquiry split, zero denominator → null", () => {
  const w = buildWindowNumbers(
    [
      dispute({ charge: "ch_a", caseType: "chargeback", reason: "fraudulent" }),
      dispute({ charge: "ch_b", caseType: "inquiry", status: "warning_needs_response", reason: "fraudulent" }),
    ],
    [efw("ch_c")],
    200
  );
  assert.equal(w.chargebacks, 1);
  assert.equal(w.inquiries, 1);
  assert.equal(w.fraudDisputes, 2);
  assert.equal(w.efws, 1);
  assert.equal(w.vampNumerator, 2); // ch_a + ch_c
  assert.equal(w.plainPct, 0.5);
  assert.equal(w.vampPct, 1.0);

  const empty = buildWindowNumbers([], [], 0);
  assert.equal(empty.plainPct, null);
  assert.equal(empty.vampPct, null);
});

test("computeDisputeRatios buckets by window and propagates truncation", async () => {
  const now = new Date(Date.UTC(2026, 6, 10));
  const s = windowStarts(now);
  const stripe: RatioStripeReads = {
    listDisputesSince: async () => ({
      disputes: [
        dispute({ charge: "ch_month", created: s.month + 60, caseType: "chargeback" }),
        dispute({ charge: "ch_old", created: s.d90 + 60, caseType: "chargeback" }),
      ],
      truncated: true,
    }),
    listEarlyFraudWarningsSince: async () => ({ efws: [efw("ch_efw", s.d30 + 60)], truncated: false }),
    countSucceededCharges: async (gte) => (gte === s.month ? 100 : gte === s.d30 ? 200 : 400),
  };
  const r = await computeDisputeRatios(stripe, now);
  assert.equal(r.truncated, true);
  assert.equal(r.month.chargebacks, 1);
  assert.equal(r.month.efws, 0);
  assert.equal(r.d30.vampNumerator, 2); // ch_month + ch_efw (month ⊂ d30 on the 10th)
  assert.equal(r.d90.chargebacks, 2);
  assert.equal(r.d90.succeeded, 400);
  assert.equal(r.month.plainPct, 1.0);
});

test("ratioLevel: month VAMP figure drives transitions; null → ok", () => {
  const mk = (vampPct: number | null): DisputeRatios =>
    ({
      computedAt: 0,
      truncated: false,
      month: { succeeded: 100, chargebacks: 0, inquiries: 0, fraudDisputes: 0, efws: 0, vampNumerator: 0, plainPct: null, vampPct },
      d30: {} as never,
      d90: {} as never,
    }) as DisputeRatios;
  assert.equal(ratioLevel(mk(null), 0.5, 0.9), "ok");
  assert.equal(ratioLevel(mk(0.4), 0.5, 0.9), "ok");
  assert.equal(ratioLevel(mk(0.5), 0.5, 0.9), "warn");
  assert.equal(ratioLevel(mk(0.9), 0.5, 0.9), "critical");
});
