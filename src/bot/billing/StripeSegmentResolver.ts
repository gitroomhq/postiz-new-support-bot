import type Stripe from "stripe";
import { StripeClient } from "../StripeClient";
import {
  UNKNOWN,
  chargeAgeBucket,
  normalizeBrand,
  normalizeCountry,
  normalizeFunding,
  normalizeNetworkReason,
  planTagsFromSubscription,
  tenureBucket,
  type MoneySegments,
} from "./segments";
import { log } from "../../util/logger";

const segLog = log.child("segments");

// Caches live for the process, not for one sweep: the same charge is touched by
// the webhook, then the reconcile tick, then a dispute weeks later, and paying
// three times for the same immutable answer is pure waste. Bounded because an
// all-time backfill would otherwise hold every charge on the account.
const MAX_CACHE_ENTRIES = 5_000;
// Customers change (rarely) but their creation date never does, so that half of
// the cache never needs to expire. Charge-derived plan/card facts are equally
// immutable once the charge has settled.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  at: number;
}

// Insertion-ordered eviction. Not a true LRU — a re-read does not refresh
// position — which is fine here: the access pattern is "a burst of lookups for
// recent objects", so the oldest inserted really is the least interesting.
class BoundedCache<T> {
  private map = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.map.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, at: Date.now() });
  }
}

// What a charge can tell us about who paid and for what.
export interface ChargeFacts {
  planTier: string;
  planPeriod: string;
  cardBrand: string;
  cardFunding: string;
  cardCountry: string;
  chargeCreatedAt: Date | null;
  customerId: string | null;
  subscriptionId: string | null;
}

const UNKNOWN_CHARGE_FACTS: ChargeFacts = {
  planTier: UNKNOWN,
  planPeriod: UNKNOWN,
  cardBrand: UNKNOWN,
  cardFunding: UNKNOWN,
  cardCountry: UNKNOWN,
  chargeCreatedAt: null,
  customerId: null,
  subscriptionId: null,
};

// Turns a Stripe object into the descriptive segments the metrics pipeline
// tags with. Everything here is best-effort by construction: a failed lookup
// degrades a Grafana axis to "unknown" and must never fail the money movement
// it describes, so every path catches and returns what it has.
//
// COST CONTROL. Resolving a plan is up to three Stripe reads (charge, invoice,
// subscription) and every sweep page could contain a hundred rows. Two things
// keep that bounded:
//
//   1. A process-wide cache, because charges and subscriptions are immutable
//      once settled and the same handful of subscriptions repeat endlessly.
//   2. A per-batch budget the caller opens with startBatch(n). When it runs
//      out, lookups stop and the remaining rows are tagged "unknown" rather
//      than the sweep turning into a thousand-call Stripe crawl.
//
// The backfill deliberately never opens a budget at all: enriching all-time
// history would cost thousands of reads for rows nobody segments by.
export class StripeSegmentResolver {
  private chargeCache = new BoundedCache<ChargeFacts>();
  private subscriptionPlanCache = new BoundedCache<{ planTier: string; planPeriod: string }>();
  private customerCreatedCache = new BoundedCache<Date | null>();
  private budget = 0;

  constructor(private stripe: StripeClient) {}

  // Opens a lookup budget for one unit of work (a sweep page, a webhook event).
  // Calls beyond it return "unknown" instead of hitting Stripe.
  startBatch(lookups: number): void {
    this.budget = Math.max(0, lookups);
  }

  remainingBudget(): number {
    return this.budget;
  }

  private spend(): boolean {
    if (this.budget <= 0) return false;
    this.budget--;
    return true;
  }

  // ---- charges ----

  async factsForCharge(chargeId: string | null | undefined): Promise<ChargeFacts> {
    if (!chargeId) return UNKNOWN_CHARGE_FACTS;
    const cached = this.chargeCache.get(chargeId);
    if (cached) return cached;
    if (!this.spend()) return UNKNOWN_CHARGE_FACTS;

    let charge: Stripe.Charge;
    try {
      charge = await this.stripe.getCharge(chargeId);
    } catch (error) {
      segLog.debug("segment charge lookup failed", { "stripe.charge_id": chargeId, "error.message": String(error) });
      return UNKNOWN_CHARGE_FACTS;
    }

    const facts = await this.factsFromCharge(charge);
    this.chargeCache.set(chargeId, facts);
    return facts;
  }

  // Same as factsForCharge but for a charge we already hold, which is the
  // common case on a webhook: the payload carried it, so the read is free.
  async factsFromCharge(charge: Stripe.Charge): Promise<ChargeFacts> {
    const card = charge.payment_method_details?.card ?? null;
    const customerId = typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null);
    const base: ChargeFacts = {
      ...UNKNOWN_CHARGE_FACTS,
      cardBrand: normalizeBrand(card?.brand),
      cardFunding: normalizeFunding(card?.funding),
      cardCountry: normalizeCountry(card?.country),
      chargeCreatedAt: charge.created ? new Date(charge.created * 1000) : null,
      customerId,
    };

    const subscriptionId = await this.subscriptionIdForCharge(charge);
    if (!subscriptionId) {
      this.chargeCache.set(charge.id, base);
      return base;
    }
    const plan = await this.planForSubscription(subscriptionId);
    const facts: ChargeFacts = { ...base, subscriptionId, planTier: plan.planTier, planPeriod: plan.planPeriod };
    this.chargeCache.set(charge.id, facts);
    return facts;
  }

  // Basil moved the subscription reference off the invoice root and under
  // parent.subscription_details, and removed `invoice` from Charge entirely —
  // resolveChargeInvoiceId owns that second quirk, so this only handles the first.
  private async subscriptionIdForCharge(charge: Stripe.Charge): Promise<string | null> {
    let invoiceId: string | null = null;
    try {
      invoiceId = await this.stripe.resolveChargeInvoiceId(charge);
    } catch {
      return null;
    }
    if (!invoiceId) return null;
    if (!this.spend()) return null;
    try {
      const invoice = await this.stripe.getInvoice(invoiceId);
      const subRef = invoice.parent?.subscription_details?.subscription;
      if (!subRef) return null;
      return typeof subRef === "string" ? subRef : subRef.id;
    } catch (error) {
      segLog.debug("segment invoice lookup failed", { "stripe.invoice_id": invoiceId, "error.message": String(error) });
      return null;
    }
  }

  // ---- subscriptions ----

  async planForSubscription(subscriptionId: string): Promise<{ planTier: string; planPeriod: string }> {
    const cached = this.subscriptionPlanCache.get(subscriptionId);
    if (cached) return cached;
    if (!this.spend()) return { planTier: UNKNOWN, planPeriod: UNKNOWN };
    try {
      const sub = await this.stripe.getSubscription(subscriptionId);
      const plan = planTagsFromSubscription(sub);
      const value = { planTier: plan.planTier as string, planPeriod: plan.planPeriod as string };
      this.subscriptionPlanCache.set(subscriptionId, value);
      return value;
    } catch (error) {
      segLog.debug("segment subscription lookup failed", {
        "stripe.subscription_id": subscriptionId,
        "error.message": String(error),
      });
      return { planTier: UNKNOWN, planPeriod: UNKNOWN };
    }
  }

  // ---- customers ----

  // Only the creation date is read, and only the BUCKET derived from it is ever
  // exported. The date itself never leaves this class.
  async tenureFor(customerId: string | null | undefined, at: Date): Promise<string> {
    if (!customerId) return UNKNOWN;
    const cached = this.customerCreatedCache.get(customerId);
    if (cached !== undefined) return tenureBucket(cached, at);
    if (!this.spend()) return UNKNOWN;
    try {
      const customer = await this.stripe.getCustomer(customerId);
      const created = customer?.created ? new Date(customer.created * 1000) : null;
      this.customerCreatedCache.set(customerId, created);
      return tenureBucket(created, at);
    } catch (error) {
      segLog.debug("segment customer lookup failed", {
        "stripe.customer_id": customerId,
        "error.message": String(error),
      });
      return UNKNOWN;
    }
  }

  // ---- composed segment sets ----

  // Segments for a refund-shaped money-out row.
  async forRefund(input: {
    chargeId: string | null;
    occurredAt: Date;
    refundReason?: string | null;
    partial?: boolean | null;
    surface?: string | null;
  }): Promise<MoneySegments> {
    const facts = await this.factsForCharge(input.chargeId);
    return {
      planTier: facts.planTier,
      planPeriod: facts.planPeriod,
      cardBrand: facts.cardBrand,
      cardFunding: facts.cardFunding,
      cardCountry: facts.cardCountry,
      refundReason: input.refundReason ?? undefined,
      refundKind: input.partial == null ? UNKNOWN : input.partial ? "partial" : "full",
      chargeAge: chargeAgeBucket(facts.chargeCreatedAt, input.occurredAt),
      tenure: await this.tenureFor(facts.customerId, input.occurredAt),
      surface: input.surface ?? undefined,
    };
  }

  // Segments for a dispute. Brand and the network reason code come off the
  // dispute payload for free; funding, country and plan need the charge behind
  // it, which the dispute payload does not carry.
  async forDispute(dispute: Stripe.Dispute, at: Date): Promise<MoneySegments> {
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? null);
    const facts = await this.factsForCharge(chargeId);
    const card = dispute.payment_method_details?.card ?? null;
    return {
      planTier: facts.planTier,
      planPeriod: facts.planPeriod,
      // The dispute's own brand wins when present: it is the brand as the
      // network reported it on the chargeback itself.
      cardBrand: normalizeBrand(card?.brand) !== UNKNOWN ? normalizeBrand(card?.brand) : facts.cardBrand,
      cardFunding: facts.cardFunding,
      cardCountry: facts.cardCountry,
      networkReason: normalizeNetworkReason(card?.network_reason_code),
      tenure: await this.tenureFor(facts.customerId, at),
    };
  }
}
