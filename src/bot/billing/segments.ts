import type Stripe from "stripe";
import { derivePostizPlan, type PostizPeriod, type PostizTier } from "./postizPlan";

// The descriptive axes every money event is sliced by in Grafana: which plan,
// which card, which region, why, and how long the customer had been with us.
//
// Two rules govern everything in this file and they are not negotiable:
//
//   NO PII. Nothing here may carry a name, an email, an address, a card number
//   or anything else that identifies a person. Every value is either a bounded
//   enum we control, a Stripe enum, or a two-letter country code. The one piece
//   of free text that exists (a cancellation comment) is scrubbed and stored as
//   a FIELD, never a tag, and the scrubber lives here so there is exactly one
//   place to audit it.
//
//   BOUNDED CARDINALITY. These values become Influx tags, and an unbounded tag
//   is how a bucket dies. Every normalizer below collapses anything it does not
//   recognise to "unknown" rather than passing it through, so a new Stripe enum
//   value cannot silently mint an unbounded tag space.
//
// Pure functions only: no Stripe calls, no Prisma. The lookups that need the
// network live in StripeSegmentResolver.

// Every segment tag defaults to this rather than being omitted. A tag that is
// present on some points and absent on others makes Grafana's group-by return
// two disjoint sets of series for what is really one question.
export const UNKNOWN = "unknown";

export type PlanTierTag = PostizTier | "custom" | typeof UNKNOWN;
export type PlanPeriodTag = PostizPeriod | "custom" | typeof UNKNOWN;

// The segment axes. Every one is optional at the call site: a path that cannot
// afford the Stripe read simply leaves them out and they render as "unknown".
export interface MoneySegments {
  planTier?: string | null;
  planPeriod?: string | null;
  cardBrand?: string | null;
  cardFunding?: string | null;
  cardCountry?: string | null;
  // Stripe's refund reason, or our own for a refund issued without one.
  refundReason?: string | null;
  // full | partial — a tag rather than the boolean field it used to be, so the
  // split is groupable instead of only summable.
  refundKind?: string | null;
  chargeAge?: string | null;
  tenure?: string | null;
  // Card-network reason code on a dispute (the issuer's own code, e.g. 10.4).
  networkReason?: string | null;
  // Which surface the staff action came from, or "stripe" when it happened
  // outside this bot entirely (the Stripe Dashboard).
  surface?: string | null;
}

// Card brands Stripe documents. Anything else collapses to "unknown" so a new
// network cannot open an unbounded tag space.
const KNOWN_BRANDS = new Set([
  "amex",
  "cartes_bancaires",
  "diners",
  "discover",
  "eftpos_au",
  "jcb",
  "link",
  "mastercard",
  "unionpay",
  "visa",
]);

const KNOWN_FUNDING = new Set(["credit", "debit", "prepaid"]);

const KNOWN_REFUND_REASONS = new Set([
  "duplicate",
  "fraudulent",
  "requested_by_customer",
  "expired_uncaptured_charge",
]);

export function normalizeBrand(brand: string | null | undefined): string {
  if (!brand) return UNKNOWN;
  const v = brand.toLowerCase();
  return KNOWN_BRANDS.has(v) ? v : UNKNOWN;
}

export function normalizeFunding(funding: string | null | undefined): string {
  if (!funding) return UNKNOWN;
  const v = funding.toLowerCase();
  return KNOWN_FUNDING.has(v) ? v : UNKNOWN;
}

// ISO-3166 alpha-2, upper-cased. Two letters is the whole validation: it caps
// the tag space at ~250 values and rejects anything that is not a country code.
export function normalizeCountry(country: string | null | undefined): string {
  if (!country) return UNKNOWN;
  const v = country.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : UNKNOWN;
}

export function normalizeRefundReason(reason: string | null | undefined): string {
  if (!reason) return "none";
  const v = reason.toLowerCase();
  return KNOWN_REFUND_REASONS.has(v) ? v : UNKNOWN;
}

// A network reason code is issuer-supplied free-ish text. Codes are short and
// structured (10.4, 4853, UA02), so anything longer or oddly shaped is dropped
// rather than tagged.
export function normalizeNetworkReason(code: string | null | undefined): string {
  if (!code) return UNKNOWN;
  const v = code.trim().toUpperCase();
  return /^[A-Z0-9.\-]{1,10}$/.test(v) ? v : UNKNOWN;
}

// How old the payment was when we gave the money back. This is the axis that
// separates a buyer's-remorse refund from a goodwill gesture months later.
export function chargeAgeBucket(chargeCreatedAt: Date | null | undefined, refundedAt: Date): string {
  if (!chargeCreatedAt) return UNKNOWN;
  const days = (refundedAt.getTime() - chargeCreatedAt.getTime()) / 86_400_000;
  if (days < 0) return UNKNOWN;
  if (days < 1) return "same_day";
  if (days <= 7) return "1_7d";
  if (days <= 30) return "8_30d";
  if (days <= 90) return "31_90d";
  return "90d_plus";
}

// How long the customer had existed when the event happened. Measured from the
// Stripe customer's creation, which is one cached read; measuring from the
// first successful charge would be more precise and costs a charge-list walk
// per customer, which this is deliberately not worth.
export function tenureBucket(customerCreatedAt: Date | null | undefined, at: Date): string {
  if (!customerCreatedAt) return UNKNOWN;
  const days = (at.getTime() - customerCreatedAt.getTime()) / 86_400_000;
  if (days < 0) return UNKNOWN;
  if (days < 1) return "first_day";
  if (days <= 30) return "under_30d";
  if (days <= 90) return "1_3mo";
  return "3mo_plus";
}

// Plan from a price. A price we do not recognise is "custom", NOT "unknown":
// the difference matters, because "custom" means we looked and it genuinely is
// a non-canonical amount, while "unknown" means we never got to look.
export function planTagsFromPrice(
  price: Pick<Stripe.Price, "currency" | "unit_amount" | "recurring"> | null | undefined
): { planTier: PlanTierTag; planPeriod: PlanPeriodTag } {
  if (!price) return { planTier: UNKNOWN, planPeriod: UNKNOWN };
  const plan = derivePostizPlan(price);
  if (!plan) return { planTier: "custom", planPeriod: "custom" };
  return { planTier: plan.tier, planPeriod: plan.period };
}

// The plan of a whole subscription: its first recurring item. Multi-item
// subscriptions are not a thing on this account (the Postiz contract is one
// tier per subscription), so the first item IS the plan.
export function planTagsFromSubscription(sub: Stripe.Subscription): {
  planTier: PlanTierTag;
  planPeriod: PlanPeriodTag;
} {
  const price = sub.items?.data?.[0]?.price;
  return planTagsFromPrice(price ?? null);
}

// ---- MRR ----

// One subscription item's contribution to monthly recurring revenue, in minor
// units. Every interval is normalised to a month so a yearly plan and a monthly
// one are comparable on the same axis; a yearly plan contributes a twelfth of
// its price per month, which is what makes "MRR lost to churn" mean anything
// when both exist side by side.
export function itemMrrMinor(item: {
  price?: Pick<Stripe.Price, "unit_amount" | "recurring"> | null;
  quantity?: number | null;
}): number {
  const price = item.price;
  const amount = price?.unit_amount;
  const rec = price?.recurring;
  if (amount == null || !rec) return 0;
  const count = rec.interval_count && rec.interval_count > 0 ? rec.interval_count : 1;
  const perPeriod = amount * (item.quantity ?? 1);
  switch (rec.interval) {
    case "month":
      return Math.round(perPeriod / count);
    case "year":
      return Math.round(perPeriod / (12 * count));
    case "week":
      return Math.round((perPeriod * 52) / (12 * count));
    case "day":
      return Math.round((perPeriod * 365) / (12 * count));
    default:
      return 0;
  }
}

export function subscriptionMrrMinor(
  sub: Pick<Stripe.Subscription, "items"> | { items?: { data?: Array<{ price?: unknown; quantity?: number | null }> } }
): number {
  const items = (sub as Stripe.Subscription).items?.data ?? [];
  return items.reduce((sum, item) => sum + itemMrrMinor(item as Parameters<typeof itemMrrMinor>[0]), 0);
}

// ---- Churn ----

export type ChurnType = "voluntary" | "involuntary" | typeof UNKNOWN;

// Voluntary means somebody decided to leave; involuntary means the money simply
// stopped arriving. Conflating the two makes a dunning problem look like a
// product problem, which is the single most expensive mistake this dashboard
// can make, so the split is derived here rather than read off a chart.
export function churnTypeOf(details: Stripe.Subscription.CancellationDetails | null | undefined): ChurnType {
  switch (details?.reason) {
    case "cancellation_requested":
      return "voluntary";
    case "payment_failed":
    case "payment_disputed":
      return "involuntary";
    default:
      return UNKNOWN;
  }
}

const KNOWN_FEEDBACK = new Set([
  "customer_service",
  "low_quality",
  "missing_features",
  "other",
  "switched_service",
  "too_complex",
  "too_expensive",
  "unused",
]);

export function normalizeFeedback(feedback: string | null | undefined): string {
  if (!feedback) return "none";
  const v = feedback.toLowerCase();
  return KNOWN_FEEDBACK.has(v) ? v : UNKNOWN;
}

export function normalizeCancelReason(reason: string | null | undefined): string {
  if (!reason) return "none";
  const v = reason.toLowerCase();
  return v === "cancellation_requested" || v === "payment_disputed" || v === "payment_failed" ? v : UNKNOWN;
}

// ---- Free text ----

export const MAX_COMMENT_LENGTH = 280;

// The only free text that leaves Stripe. A cancellation comment is written by a
// customer, so it can contain anything they chose to type: their name, their
// email, a support ticket link, a phone number. The verbatim is genuinely
// useful for reading churn, so it is kept, but every identifier shape is
// replaced before it goes anywhere near the metrics pipeline, and the result is
// stored as a FIELD so it can never become a tag value.
//
// This is a redaction, not an anonymisation: it removes the identifier shapes we
// can recognise, and it cannot remove a name typed as a bare word. Treat the
// output as low-risk free text, not as guaranteed-clean data.
export function scrubFreeText(text: string | null | undefined): string | null {
  if (!text) return null;
  let out = text
    // Emails first: an email contains an @ and dots that later rules would
    // otherwise chew into unrecognisable pieces.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    // URLs, which routinely carry account ids and tokens in their paths.
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[url]")
    // Stripe object ids: cus_, sub_, ch_, in_, pi_ and friends identify a person
    // just as surely as a name does.
    .replace(/\b(?:cus|sub|ch|py|re|in|pi|cn|dp|du|card|pm|src|txn|si|price|prod)_[A-Za-z0-9]{6,}\b/g, "[id]")
    // Long digit runs: phone numbers, card fragments, account numbers.
    .replace(/\b[\d][\d\s().+-]{6,}\d\b/g, "[number]")
    // Anything that looks like a bearer token or a long opaque key.
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[token]")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length === 0) return null;
  if (out.length > MAX_COMMENT_LENGTH) out = `${out.slice(0, MAX_COMMENT_LENGTH - 1)}…`;
  return out;
}

// ---- Tag assembly ----

// Every segment axis, always all of them, always a non-empty string. Callers
// pass what they know and the rest fills in as "unknown" — see the comment on
// UNKNOWN for why absence is not an option.
export function segmentTags(seg: MoneySegments | null | undefined): Record<string, string> {
  const s = seg ?? {};
  return {
    plan_tier: s.planTier || UNKNOWN,
    plan_period: s.planPeriod || UNKNOWN,
    card_brand: s.cardBrand || UNKNOWN,
    card_funding: s.cardFunding || UNKNOWN,
    card_country: s.cardCountry || UNKNOWN,
    refund_reason: s.refundReason || UNKNOWN,
    refund_kind: s.refundKind || UNKNOWN,
    charge_age: s.chargeAge || UNKNOWN,
    tenure: s.tenure || UNKNOWN,
    network_reason: s.networkReason || UNKNOWN,
    surface: s.surface || UNKNOWN,
  };
}

// The tag keys segmentTags always emits. Exported so the Grafana dashboards and
// the tests have one authoritative list to check themselves against.
export const SEGMENT_TAG_KEYS = [
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
] as const;
