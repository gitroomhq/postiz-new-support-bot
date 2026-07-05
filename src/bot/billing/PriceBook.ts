import type Stripe from "stripe";
import { StripeClient } from "../StripeClient";
import { priceLabel } from "./ui";

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface PlanUsage {
  counts: Map<string, number>;
  scanned: number;
  truncated: boolean;
  at: number;
}

// Owns the two Stripe caches every billing panel used to re-fetch:
// (a) the active recurring price list (and the human labels derived from it),
// (b) per-price active-subscription counts (a full account sweep).
export class PriceBook {
  private pricesCache?: { prices: Stripe.Price[]; at: number };
  // Per-price active-subscription counts are a full sweep of the account —
  // cache them briefly so saving the allowlist doesn't recount.
  private planUsage?: PlanUsage;

  constructor(private stripe: StripeClient) {}

  async prices(force = false): Promise<Stripe.Price[]> {
    if (!force && this.pricesCache && Date.now() - this.pricesCache.at < CACHE_TTL_MS) {
      return this.pricesCache.prices;
    }
    const prices = await this.stripe.listRecurringPrices();
    this.pricesCache = { prices, at: Date.now() };
    return prices;
  }

  // Product names live on the prices list (expanded there); subscription items
  // carry only a bare price, so panels resolve human labels through this map.
  async labelMap(): Promise<Map<string, string>> {
    const prices = await this.prices();
    return new Map(prices.map((p) => [p.id, priceLabel(this.stripe, p)]));
  }

  async label(priceId: string): Promise<string | undefined> {
    return (await this.labelMap()).get(priceId);
  }

  isPlanUsageStale(): boolean {
    return !this.planUsage || Date.now() - this.planUsage.at >= CACHE_TTL_MS;
  }

  async getPlanUsage(force = false): Promise<PlanUsage> {
    if (!force && this.planUsage && Date.now() - this.planUsage.at < CACHE_TTL_MS) return this.planUsage;
    const res = await this.stripe.countActiveSubscriptionsByPrice();
    this.planUsage = { ...res, at: Date.now() };
    return this.planUsage;
  }
}
