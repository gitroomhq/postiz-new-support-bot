import type { StripeDispute, StripeMoneyOut, StripeSubscriptionEvent } from "../../generated/prisma/client";
import { nsTimestamp, writePoint, type FieldValue } from "../../metrics/InfluxWriter";
import { SEGMENT_TAG_KEYS, UNKNOWN } from "./segments";
import { usdMinorAtRate, usdMinorOf } from "./fx";

// The canonical money points.
//
// ONE RULE, and everything here exists to enforce it:
//
//   A point is a pure function of ONE PERSISTED ROW, and every tag comes from a
//   column that is written exactly once.
//
// Influx identifies a point by measurement + tag set + timestamp. Two writes
// that agree on all three overwrite; two that disagree on any of them are two
// different points. So a live emit and a later rebuild emit are safe only if
// they compute byte-identical tags — which they cannot do if one of them reads
// an in-memory candidate row and the other reads the database, or if a tag is
// derived from a column that a later pass rewrites.
//
// Both halves of that used to be violated, and both showed up as inflated
// money: the re-emit path hardcoded source="backfill" while the live paths
// emitted the row's real source (a tag, so a second point rather than an
// overwrite), and the concession path emitted with no segments at all while the
// rebuild emitted the mirror's. Every Grafana money panel does
// `|> group() |> sum()` across all tags, so each of those became a double count.
//
// The functions below take a Prisma row and nothing else. That is the fix: it
// is not possible to call them with anything that has not been persisted.

// ---- money_out ----

// The tag set, frozen. `pointIdentity.test.ts` asserts this exact array, so
// re-adding a tag is a test failure rather than a silently forked series.
//
// `source` is NOT here on purpose. It records how a row was DISCOVERED
// (webhook / sweep / backfill / action), not anything about the money; nothing
// in any of the eight Grafana dashboards queries it; and the repair pass would
// rewrite it. As a field it stays visible when inspecting a point.
//
// `currency` IS here. The amounts are USD-only, so nobody sums across it, but
// keeping it bounded and groupable is free and it separates two same-second
// movements that would otherwise share a series.
export const MONEY_OUT_TAG_KEYS = ["bucket", "category", "currency", ...SEGMENT_TAG_KEYS] as const;

// Columns a repair pass may never touch, because a point's identity is built
// from them: changing one produces a second point instead of correcting the
// first. Exported so MoneyOutStore.repair and its test share one list.
export const MONEY_OUT_FROZEN_COLUMNS = [
  "id",
  "occurredAt",
  "bucket",
  "category",
  "currency",
  "amountMinor",
  "source",
] as const;

export function moneyOutTags(row: StripeMoneyOut): Record<string, string> {
  return {
    bucket: row.bucket,
    category: row.category,
    currency: row.currency.toLowerCase(),
    // Every segment axis, always, defaulting to "unknown" rather than being
    // omitted — a tag present on some points and absent on others splits one
    // Grafana group-by into two disjoint answers. See segments.ts.
    plan_tier: row.planTier || UNKNOWN,
    plan_period: row.planPeriod || UNKNOWN,
    card_brand: row.cardBrand || UNKNOWN,
    card_funding: row.cardFunding || UNKNOWN,
    card_country: row.cardCountry || UNKNOWN,
    refund_reason: row.refundReason || UNKNOWN,
    refund_kind: row.refundKind || UNKNOWN,
    charge_age: row.chargeAge || UNKNOWN,
    tenure: row.tenure || UNKNOWN,
    network_reason: row.networkReason || UNKNOWN,
    surface: row.surface || UNKNOWN,
  };
}

export function moneyOutFields(row: StripeMoneyOut): Record<string, FieldValue | undefined> {
  // The frozen conversion, preferred over re-converting: fxRate is the rate the
  // row was written with, so a later revision of fx.ts cannot restate history.
  // Falling back to a live conversion only covers rows written before the
  // columns existed, which the rebuild's repair pass then fills in.
  const usd = usdOf(row);
  return {
    count: 1,
    // USD only. The original amount and currency live in Postgres, where they
    // stay exact and reconcilable against Stripe; exporting them too would
    // invite a panel that sums EUR minor units into a USD total.
    amount_usd_minor: usd?.amount,
    fee_usd_minor: usd?.fee,
    net_usd_minor: usd?.net,
    fx_rate: usd?.rate,
    // 0 when fx.ts has no rate for the currency. The amount fields are then
    // absent rather than zero, so an unconvertible movement reads as missing
    // from the total instead of silently as nothing.
    usd_convertible: usd ? 1 : 0,
    // Labels, not money: string fields cannot be summed, so they carry the
    // original currency and the provenance without inviting arithmetic.
    currency: row.currency.toLowerCase(),
    source: row.source,
  };
}

function usdOf(row: StripeMoneyOut): { amount: number; fee: number; net: number; rate: number } | null {
  if (row.fxRate != null && row.usdMinor != null) {
    return {
      amount: row.usdMinor,
      fee: row.feeUsdMinor ?? usdMinorAtRate(row.feeMinor, row.currency, row.fxRate),
      net: row.netUsdMinor ?? usdMinorAtRate(row.netMinor, row.currency, row.fxRate),
      rate: row.fxRate,
    };
  }
  const live = usdMinorOf(row.amountMinor, row.currency);
  if (!live) return null;
  return {
    amount: live.usdMinor,
    fee: usdMinorAtRate(row.feeMinor, row.currency, live.rate),
    net: usdMinorAtRate(row.netMinor, row.currency, live.rate),
    rate: live.rate,
  };
}

// The complete point a row would produce, or null when it must not produce one.
//
// Separate from emitMoneyOut so the decision is testable: writePoint no-ops
// whenever the exporter is inactive, which is always in a unit test, so a rule
// enforced only inside the emit call cannot be asserted on at all.
export function moneyOutPointFor(row: StripeMoneyOut): {
  tags: Record<string, string>;
  fields: Record<string, FieldValue | undefined>;
  timestamp: string;
} | null {
  // A retired row has been superseded by a better measurement of the same
  // money. Emitting it would double the category it belongs to.
  if (row.retiredAt) return null;
  return {
    tags: moneyOutTags(row),
    fields: moneyOutFields(row),
    timestamp: nsTimestamp(row.occurredAt, row.id),
  };
}

export function emitMoneyOut(row: StripeMoneyOut): void {
  const point = moneyOutPointFor(row);
  if (!point) return;
  writePoint("money_out", point.tags, point.fields, point.timestamp);
}

// ---- dispute_outcomes ----

export const DISPUTE_OUTCOME_TAG_KEYS = ["outcome", "reason", "currency", ...SEGMENT_TAG_KEYS] as const;

// Exactly the columns an outcome point reads, so the type doubles as the list
// of what the point depends on — and so a projected read (the mirror re-emit
// selects only these) satisfies it without widening to the whole row.
export type DisputeOutcomeRow = Pick<
  StripeDispute,
  | "id"
  | "status"
  | "reason"
  | "amount"
  | "currency"
  | "closedAt"
  | "closedAtEstimated"
  | "closedAtSource"
  | "evidenceSubmittedAt"
  | "usdMinor"
  | "fxRate"
  | "planTier"
  | "planPeriod"
  | "cardBrand"
  | "cardFunding"
  | "cardCountry"
  | "networkReason"
  | "tenure"
>;

export function disputeOutcomeTags(row: DisputeOutcomeRow): Record<string, string> {
  return {
    outcome: row.status,
    reason: row.reason || UNKNOWN,
    currency: row.currency.toLowerCase(),
    plan_tier: row.planTier || UNKNOWN,
    plan_period: row.planPeriod || UNKNOWN,
    card_brand: row.cardBrand || UNKNOWN,
    card_funding: row.cardFunding || UNKNOWN,
    card_country: row.cardCountry || UNKNOWN,
    // A dispute has no refund of its own, but the tag set has to match the
    // measurement's shape on every point or a group-by drops half the series.
    refund_reason: UNKNOWN,
    refund_kind: UNKNOWN,
    charge_age: UNKNOWN,
    tenure: row.tenure || UNKNOWN,
    network_reason: row.networkReason || UNKNOWN,
    surface: UNKNOWN,
  };
}

export function disputeOutcomeFields(row: DisputeOutcomeRow): Record<string, FieldValue | undefined> {
  const usd =
    row.fxRate != null && row.usdMinor != null
      ? { usdMinor: row.usdMinor, rate: row.fxRate }
      : usdMinorOf(row.amount, row.currency);
  return {
    count: 1,
    amount_usd_minor: usd?.usdMinor,
    fx_rate: usd?.rate,
    usd_convertible: usd ? 1 : 0,
    submitted: row.evidenceSubmittedAt != null ? 1 : 0,
    // Stripe exposes no closed-at timestamp, so this is usually inferred. A
    // panel reading win-rate-over-time deserves to know which points sit at a
    // real moment and which at a best guess.
    closed_at_estimated: row.closedAtEstimated ? 1 : 0,
    closed_at_source: row.closedAtSource ?? undefined,
    currency: row.currency.toLowerCase(),
  };
}

export function emitDisputeOutcome(row: DisputeOutcomeRow): void {
  // Only a closed dispute has an outcome. closedAt is also the timestamp, so a
  // row without one has nowhere to be placed.
  if (!row.closedAt) return;
  writePoint(
    "dispute_outcomes",
    disputeOutcomeTags(row),
    disputeOutcomeFields(row),
    nsTimestamp(row.closedAt, row.id)
  );
}

// ---- subscription_events ----

export const SUBSCRIPTION_EVENT_TAG_KEYS = [
  "event",
  "plan_tier",
  "plan_period",
  "from_tier",
  "from_period",
  "currency",
  "churn_type",
  "cancel_reason",
  "cancel_feedback",
  "card_country",
] as const;

export function subscriptionEventTags(row: StripeSubscriptionEvent): Record<string, string> {
  return {
    event: row.event,
    plan_tier: row.planTier,
    plan_period: row.planPeriod,
    from_tier: row.fromTier || "none",
    from_period: row.fromPeriod || "none",
    currency: row.currency.toLowerCase(),
    churn_type: row.churnType || UNKNOWN,
    cancel_reason: row.cancelReason || "none",
    cancel_feedback: row.cancelFeedback || "none",
    card_country: row.cardCountry || UNKNOWN,
  };
}

export function subscriptionEventFields(row: StripeSubscriptionEvent): Record<string, FieldValue | undefined> {
  const rate = row.fxRate ?? usdMinorOf(row.mrrDeltaMinor, row.currency)?.rate ?? null;
  const delta =
    row.mrrDeltaUsdMinor ?? (rate == null ? undefined : usdMinorAtRate(row.mrrDeltaMinor, row.currency, rate));
  const atRisk =
    row.mrrAtRiskUsdMinor ?? (rate == null ? undefined : usdMinorAtRate(row.mrrAtRiskMinor, row.currency, rate));
  return {
    count: 1,
    // Signed and month-normalised, so a window sum is net revenue movement.
    // mrr_at_risk is the separate "scheduled to leave but has not left yet"
    // number and must never be added to the delta.
    mrr_delta_usd_minor: delta,
    mrr_at_risk_usd_minor: atRisk,
    fx_rate: rate ?? undefined,
    usd_convertible: rate == null ? 0 : 1,
    has_comment: row.comment ? 1 : 0,
    // Already scrubbed and truncated by segments.scrubFreeText before storage.
    // A field, never a tag: it is customer free text.
    comment: row.comment ?? undefined,
    currency: row.currency.toLowerCase(),
  };
}

export function emitSubscriptionEvent(row: StripeSubscriptionEvent): void {
  writePoint(
    "subscription_events",
    subscriptionEventTags(row),
    subscriptionEventFields(row),
    nsTimestamp(row.occurredAt, row.id)
  );
}
