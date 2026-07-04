import Stripe from "stripe";
import { BotConfig } from "../config";

export interface SubscriptionInvoice {
  invoiceId: string;
  chargeId: string;
  amountPaid: number;
  currency: string;
  subscriptionId: string;
  created: Date;
}

export class StripeClient {
  private stripe: Stripe;

  constructor(private config: BotConfig) {
    this.stripe = new Stripe(config.stripe.secretKey);
  }

  async getLastSubscriptionCharge(customerId: string): Promise<SubscriptionInvoice | null> {
    const oneMonthAgo = Math.floor((Date.now() - 35 * 24 * 60 * 60 * 1000) / 1000);

    // Get charges directly — same approach as postiz-app
    const charges = await this.stripe.charges.list({
      customer: customerId,
      limit: 10,
      created: { gte: oneMonthAgo },
    });

    const succeededCharge = charges.data.find(
      (c) => c.status === "succeeded" && !c.refunded && c.amount > 0
    ) as any;

    if (!succeededCharge) return null;

    // Try to find the subscription from the invoice
    let subscriptionId = "";
    const chargeInvoice = succeededCharge.invoice;
    if (chargeInvoice) {
      const invoiceId = typeof chargeInvoice === "string" ? chargeInvoice : chargeInvoice.id;

      try {
        const invoice = await this.stripe.invoices.retrieve(invoiceId) as any;
        const subDetails = invoice.parent?.subscription_details;
        if (subDetails?.subscription) {
          subscriptionId = typeof subDetails.subscription === "string"
            ? subDetails.subscription
            : subDetails.subscription.id;
        }
      } catch {
        // Invoice lookup failed, continue without subscription ID
      }
    }

    return {
      invoiceId: typeof chargeInvoice === "string"
        ? chargeInvoice
        : chargeInvoice?.id || succeededCharge.id,
      chargeId: succeededCharge.id,
      amountPaid: succeededCharge.amount,
      currency: succeededCharge.currency,
      subscriptionId,
      created: new Date(succeededCharge.created * 1000),
    };
  }

  async applyDiscountCoupon(subscriptionId: string, idempotencyKey?: string): Promise<void> {
    await this.stripe.subscriptions.update(
      subscriptionId,
      { discounts: [{ coupon: this.config.stripe.discountCouponId }] },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // Fresh charge state for the refund guardrails (amount cap + already-refunded check).
  async getChargeAmount(chargeId: string): Promise<{ amount: number; currency: string; refunded: boolean }> {
    const charge = await this.stripe.charges.retrieve(chargeId);
    return { amount: charge.amount, currency: charge.currency, refunded: charge.refunded };
  }

  async cancelSubscription(subscriptionIdOrCustomerId: string): Promise<void> {
    // If it looks like a subscription ID, cancel directly
    if (subscriptionIdOrCustomerId.startsWith("sub_")) {
      await this.stripe.subscriptions.cancel(subscriptionIdOrCustomerId);
      return;
    }

    // Otherwise treat as customer ID — find and cancel their active subscription
    const subscriptions = await this.stripe.subscriptions.list({
      customer: subscriptionIdOrCustomerId,
      status: "all",
    });

    const active = subscriptions.data.find((s) => s.status !== "canceled");
    if (active) {
      await this.stripe.subscriptions.cancel(active.id);
    }
  }

  async refundCharge(chargeId: string, idempotencyKey?: string): Promise<{ refundId: string; amount: number; currency: string }> {
    const refund = await this.stripe.refunds.create(
      { charge: chargeId },
      idempotencyKey ? { idempotencyKey } : undefined
    );

    return {
      refundId: refund.id,
      amount: refund.amount,
      currency: refund.currency,
    };
  }

  // ---- Billing admin panel (/billing) reads ----

  async listCustomerCards(customerId: string): Promise<Stripe.PaymentMethod[]> {
    const res = await this.stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 100 });
    return res.data;
  }

  async listCharges(
    customerId: string,
    limit = 10,
    startingAfter?: string
  ): Promise<{ charges: Stripe.Charge[]; hasMore: boolean }> {
    const res = await this.stripe.charges.list({
      customer: customerId,
      limit,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    return { charges: res.data, hasMore: res.has_more };
  }

  // Search API paginates with page/next_page tokens, not starting_after.
  // The fingerprint is interpolated into the query string — callers must validate it.
  async searchChargesByCardFingerprint(
    fingerprint: string,
    limit = 10,
    page?: string
  ): Promise<{ charges: Stripe.Charge[]; nextPage: string | null }> {
    const res = await this.stripe.charges.search({
      query: `payment_method_details.card.fingerprint:"${fingerprint}"`,
      limit,
      ...(page ? { page } : {}),
    });
    return { charges: res.data, nextPage: res.next_page ?? null };
  }

  // last4 is far from unique — callers should aggregate by fingerprint for exact
  // identification. Both inputs are validated by the caller (digits / [a-z_]) since
  // they are interpolated into the query string.
  async searchChargesByCardLast4(
    last4: string,
    brand: string | undefined,
    limit = 10,
    page?: string
  ): Promise<{ charges: Stripe.Charge[]; nextPage: string | null }> {
    const query =
      `payment_method_details.card.last4:"${last4}"` +
      (brand ? ` AND payment_method_details.card.brand:"${brand}"` : "");
    const res = await this.stripe.charges.search({ query, limit, ...(page ? { page } : {}) });
    return { charges: res.data, nextPage: res.next_page ?? null };
  }

  async getCustomer(customerId: string): Promise<Stripe.Customer | null> {
    const customer = await this.stripe.customers.retrieve(customerId);
    return customer.deleted ? null : (customer as Stripe.Customer);
  }

  async findCustomersByEmail(email: string): Promise<Stripe.Customer[]> {
    const res = await this.stripe.customers.list({ email, limit: 10 });
    return res.data;
  }

  // Discounts are expanded so panels can show the coupon behind each discount.
  async listSubscriptions(customerId: string): Promise<Stripe.Subscription[]> {
    const res = await this.stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      expand: ["data.discounts.source.coupon"],
    });
    return res.data;
  }

  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.retrieve(subscriptionId, { expand: ["discounts.source.coupon"] });
  }

  async listRecurringPrices(limit = 100): Promise<Stripe.Price[]> {
    const res = await this.stripe.prices.list({
      active: true,
      type: "recurring",
      limit,
      expand: ["data.product"],
    });
    return res.data;
  }

  async getPrice(priceId: string): Promise<Stripe.Price> {
    return this.stripe.prices.retrieve(priceId, { expand: ["product"] });
  }

  // Plan change on one subscription item. Discounts: undefined = keep existing
  // (Stripe's default on price changes), "clear" = remove all, coupon id = replace.
  async changeSubscriptionPlan(
    params: {
      subscriptionId: string;
      itemId: string;
      priceId: string;
      prorationBehavior: "create_prorations" | "none";
      discounts?: "clear" | string;
    },
    idempotencyKey: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      params.subscriptionId,
      {
        items: [{ id: params.itemId, price: params.priceId }],
        proration_behavior: params.prorationBehavior,
        ...(params.discounts === "clear"
          ? { discounts: "" }
          : params.discounts
            ? { discounts: [{ coupon: params.discounts }] }
            : {}),
      },
      { idempotencyKey }
    );
  }

  async listInvoices(
    customerId: string,
    limit = 10,
    startingAfter?: string
  ): Promise<{ invoices: Stripe.Invoice[]; hasMore: boolean }> {
    const res = await this.stripe.invoices.list({
      customer: customerId,
      limit,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    return { invoices: res.data, hasMore: res.has_more };
  }

  async getCharge(chargeId: string): Promise<Stripe.Charge> {
    return this.stripe.charges.retrieve(chargeId);
  }

  async getDisputeForCharge(chargeId: string): Promise<Stripe.Dispute | null> {
    const res = await this.stripe.disputes.list({ charge: chargeId, limit: 1 });
    return res.data[0] ?? null;
  }

  // The EFW list API filters only by charge/payment_intent — callers fetch a recent
  // window once and intersect against the charge ids they already have.
  async listRecentEarlyFraudWarnings(limit = 100): Promise<Stripe.Radar.EarlyFraudWarning[]> {
    const res = await this.stripe.radar.earlyFraudWarnings.list({ limit });
    return res.data;
  }

  async listTaxIds(customerId: string): Promise<Stripe.TaxId[]> {
    const res = await this.stripe.customers.listTaxIds(customerId, { limit: 100 });
    return res.data;
  }

  // ---- Billing admin panel (/billing) writes ----

  // Omitted amount = Stripe refunds the full remaining un-refunded amount.
  async refundChargeAmount(
    chargeId: string,
    amountMinor: number | null,
    idempotencyKey: string
  ): Promise<{ refundId: string; amount: number; currency: string; status: string | null }> {
    const refund = await this.stripe.refunds.create(
      { charge: chargeId, ...(amountMinor != null ? { amount: amountMinor } : {}) },
      { idempotencyKey }
    );
    return { refundId: refund.id, amount: refund.amount, currency: refund.currency, status: refund.status };
  }

  async updateCustomer(customerId: string, params: Stripe.CustomerUpdateParams): Promise<Stripe.Customer> {
    return this.stripe.customers.update(customerId, params);
  }

  // Promo code strings are unique among active codes, but inactive duplicates can
  // exist — lookups by code therefore return a list. promotion.coupon is expanded
  // everywhere so panels can show the discount without a second round-trip.
  async findPromotionCodes(code: string): Promise<Stripe.PromotionCode[]> {
    const res = await this.stripe.promotionCodes.list({ code, limit: 10, expand: ["data.promotion.coupon"] });
    return res.data;
  }

  async getPromotionCode(promotionCodeId: string): Promise<Stripe.PromotionCode> {
    return this.stripe.promotionCodes.retrieve(promotionCodeId, { expand: ["promotion.coupon"] });
  }

  async createPromotionCode(
    params: { coupon: string; code?: string; maxRedemptions?: number; expiresAt?: number },
    idempotencyKey: string
  ): Promise<Stripe.PromotionCode> {
    return this.stripe.promotionCodes.create(
      {
        promotion: { type: "coupon", coupon: params.coupon },
        ...(params.code ? { code: params.code } : {}),
        ...(params.maxRedemptions ? { max_redemptions: params.maxRedemptions } : {}),
        ...(params.expiresAt ? { expires_at: params.expiresAt } : {}),
        expand: ["promotion.coupon"],
      },
      { idempotencyKey }
    );
  }

  // Stripe has no delete for promotion codes — deactivation is the terminal state.
  async setPromotionCodeActive(promotionCodeId: string, active: boolean): Promise<Stripe.PromotionCode> {
    return this.stripe.promotionCodes.update(promotionCodeId, { active, expand: ["promotion.coupon"] });
  }

  async listPromotionCodes(limit = 25): Promise<Stripe.PromotionCode[]> {
    const res = await this.stripe.promotionCodes.list({ limit, expand: ["data.promotion.coupon"] });
    return res.data;
  }

  async listCoupons(limit = 25): Promise<Stripe.Coupon[]> {
    const res = await this.stripe.coupons.list({ limit });
    return res.data;
  }

  async getCoupon(couponId: string): Promise<Stripe.Coupon> {
    return this.stripe.coupons.retrieve(couponId);
  }

  async createCoupon(
    params: {
      id?: string;
      name?: string;
      percentOff?: number;
      amountOffMinor?: number;
      currency?: string;
      duration: "once" | "forever" | "repeating";
      durationInMonths?: number;
    },
    idempotencyKey: string
  ): Promise<Stripe.Coupon> {
    return this.stripe.coupons.create(
      {
        ...(params.id ? { id: params.id } : {}),
        ...(params.name ? { name: params.name } : {}),
        ...(params.percentOff != null ? { percent_off: params.percentOff } : {}),
        ...(params.amountOffMinor != null ? { amount_off: params.amountOffMinor, currency: params.currency } : {}),
        duration: params.duration,
        ...(params.durationInMonths ? { duration_in_months: params.durationInMonths } : {}),
      },
      { idempotencyKey }
    );
  }

  // Deleting a coupon does not affect subscriptions it is already applied to.
  async deleteCoupon(couponId: string): Promise<void> {
    await this.stripe.coupons.del(couponId);
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  async setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  async createCustomer(params: { email?: string; name?: string; description?: string }): Promise<Stripe.Customer> {
    return this.stripe.customers.create({
      ...(params.email ? { email: params.email } : {}),
      ...(params.name ? { name: params.name } : {}),
      ...(params.description ? { description: params.description } : {}),
    });
  }

  // Permanent: cancels active subscriptions and cannot be undone.
  async deleteCustomer(customerId: string): Promise<void> {
    await this.stripe.customers.del(customerId);
  }

  async cancelSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }

  async addTaxId(customerId: string, type: string, value: string): Promise<Stripe.TaxId> {
    return this.stripe.customers.createTaxId(customerId, {
      type: type as Stripe.CustomerCreateTaxIdParams.Type,
      value,
    });
  }

  async removeTaxId(customerId: string, taxIdId: string): Promise<void> {
    await this.stripe.customers.deleteTaxId(customerId, taxIdId);
  }

  // Currencies Stripe treats as zero-decimal: the minor unit IS the major unit.
  private static readonly ZERO_DECIMAL = new Set([
    "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
  ]);

  static isZeroDecimal(currency: string): boolean {
    return StripeClient.ZERO_DECIMAL.has(currency.toLowerCase());
  }

  formatAmount(amount: number, currency: string): string {
    const value = StripeClient.isZeroDecimal(currency) ? amount : amount / 100;
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
      }).format(value);
    } catch {
      // Unknown ISO code from Stripe — don't crash the panel over formatting.
      return `${value} ${currency.toUpperCase()}`;
    }
  }
}
