import { createHash } from "node:crypto";
import type Stripe from "stripe";

// The Postiz platform derives an org's plan ENTIRELY from subscription
// metadata — its /stripe webhook drops any subscription event whose
// metadata.service !== "gitroom", and reads the tier from metadata.billing /
// metadata.period, never from the price line item. Every subscription this
// bot creates or edits for a Postiz customer must therefore carry:
//   service:  "gitroom"
//   billing:  STANDARD | TEAM | PRO | ULTIMATE
//   period:   MONTHLY | YEARLY
//   uniqueId: 10-char alphanumeric (stored as Subscription.identifier)
// A price/metadata mismatch means the customer pays one amount but gets
// another tier's limits, so tiers are only ever DERIVED from the canonical
// price amounts below — non-canonical prices never sync (user decision:
// hard-block, discounts go through coupons/promos which don't change
// unit_amount).

export const POSTIZ_SERVICE = "gitroom";

export type PostizTier = "STANDARD" | "TEAM" | "PRO" | "ULTIMATE";
export type PostizPeriod = "MONTHLY" | "YEARLY";

// Canonical USD list prices (minor units) per tier, mirroring the platform's
// pricing table (postiz-app pricing.ts). USD only by user decision.
export const POSTIZ_TIERS: Record<PostizTier, { month: number; year: number }> = {
  STANDARD: { month: 2900, year: 27800 },
  TEAM: { month: 3900, year: 37400 },
  PRO: { month: 4900, year: 47000 },
  ULTIMATE: { month: 9900, year: 95000 },
};

export interface PostizPlan {
  tier: PostizTier;
  period: PostizPeriod;
}

export interface PostizMeta {
  service: string | null;
  billing: string | null;
  period: string | null;
  uniqueId: string | null;
}

// Tier/period from a price's list amount. null = not a canonical Postiz
// price (custom amount, non-USD, bundled interval) — callers refuse to sync.
export function derivePostizPlan(price: Pick<Stripe.Price, "currency" | "unit_amount" | "recurring">): PostizPlan | null {
  if (price.currency !== "usd" || price.unit_amount == null) return null;
  const rec = price.recurring;
  if (!rec || (rec.interval_count ?? 1) !== 1) return null;
  if (rec.interval !== "month" && rec.interval !== "year") return null;
  for (const [tier, amounts] of Object.entries(POSTIZ_TIERS) as Array<[PostizTier, { month: number; year: number }]>) {
    if (amounts[rec.interval] === price.unit_amount) {
      return { tier, period: rec.interval === "month" ? "MONTHLY" : "YEARLY" };
    }
  }
  return null;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Deterministic 10-char id from a stable seed (the action's idemScope): a
// queued approval executes with the same params it was summarized with, and
// a Stripe-idempotency retry re-sends byte-identical params instead of
// tripping the "same key, different params" 400.
export function postizUniqueId(seed: string): string {
  const digest = createHash("sha256").update(`postiz-uid:${seed}`).digest();
  let out = "";
  for (let i = 0; i < 10; i++) out += BASE62[digest[i] % 62];
  return out;
}

// Exactly the four contract keys — subscriptions.update merges metadata by
// key, so platform-set extras (userId, ud) survive untouched.
export function buildPostizMetadata(plan: PostizPlan, uniqueId: string): Record<string, string> {
  return {
    service: POSTIZ_SERVICE,
    billing: plan.tier,
    period: plan.period,
    uniqueId,
  };
}

export function readPostizMeta(metadata: Stripe.Metadata | null | undefined): PostizMeta {
  return {
    service: metadata?.service ?? null,
    billing: metadata?.billing ?? null,
    period: metadata?.period ?? null,
    uniqueId: metadata?.uniqueId ?? null,
  };
}

export function isGitroomSub(sub: Pick<Stripe.Subscription, "metadata">): boolean {
  return sub.metadata?.service === POSTIZ_SERVICE;
}

export type PostizSyncStatus = "synced" | "missing" | "mismatch";

// "missing"  → no service:gitroom — every webhook event for this sub is
//              dropped by the platform (cancel would strand the org on its
//              paid tier).
// "mismatch" → carries gitroom metadata, but the tier/period recorded there
//              doesn't match what the item's price actually charges — the
//              customer pays one amount and gets another tier's limits.
export function postizSyncStatus(sub: Pick<Stripe.Subscription, "metadata" | "items">): PostizSyncStatus {
  if (!isGitroomSub(sub)) return "missing";
  const meta = readPostizMeta(sub.metadata);
  const price = sub.items.data[0]?.price;
  const derived = price ? derivePostizPlan(price) : null;
  if (!derived || derived.tier !== meta.billing || derived.period !== meta.period) return "mismatch";
  if (!meta.uniqueId) return "mismatch";
  return "synced";
}
