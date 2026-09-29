import type Stripe from "stripe";
import type { StripeClient } from "../StripeClient";
import type { DisputeStore } from "./DisputeStore";
import { annualFromPeriod } from "./disputeVerdict";

// Is this charge a yearly plan? Asked by auto-resolve, which refunds inquiries
// to keep them off the dispute ratio EXCEPT on annual charges, where the
// operator's rule is to fight instead.
//
// Cheapest answer first: the dispute mirror already resolved the plan period
// for its analytics segments, from the canonical price table. A custom price
// reads as "custom" there, so the charge's own invoice decides the rest: any
// line whose service period spans most of a year is an annual plan.
//
// A charge with no invoice at all is a one-off payment, not a plan, so it is
// not annual. A Stripe error is thrown, never guessed: the caller reports the
// proposal as unavailable and the looper asks again.

const CACHE_CAP = 500;

function iso(unix: number | null | undefined): string | null {
  return unix ? new Date(unix * 1000).toISOString() : null;
}

export class AnnualChargeResolver {
  private cache = new Map<string, boolean>();

  constructor(
    private stripe: StripeClient,
    private disputeStore: DisputeStore
  ) {}

  async isAnnual(disputeId: string | null, charge: Stripe.Charge): Promise<boolean> {
    const cached = this.cache.get(charge.id);
    if (cached !== undefined) return cached;

    let result: boolean | null = null;
    if (disputeId) {
      const row = await this.disputeStore.get(disputeId).catch(() => null);
      if (row?.planPeriod === "YEARLY") result = true;
      else if (row?.planPeriod === "MONTHLY") result = false;
    }
    if (result == null) {
      const invoiceId = await this.stripe.resolveChargeInvoiceId(charge);
      if (!invoiceId) {
        result = false;
      } else {
        const invoice = await this.stripe.getInvoice(invoiceId);
        const lines = (invoice.lines?.data ?? []) as unknown as Array<{ period?: { start?: number; end?: number } }>;
        result = lines.some((line) => annualFromPeriod(iso(line.period?.start), iso(line.period?.end)) === true);
      }
    }

    if (this.cache.size >= CACHE_CAP) this.cache.clear();
    this.cache.set(charge.id, result);
    return result;
  }
}
