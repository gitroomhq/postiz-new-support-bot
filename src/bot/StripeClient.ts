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

// Basil (SDK v20) dropped `invoice` from the Stripe.Charge type, but the field is
// still returned on the wire for subscription charges — narrow instead of `as any`.
interface ChargeWithInvoice extends Stripe.Charge {
  invoice?: string | { id: string } | null;
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

    // Skip the ~$1 card-verification charges Postiz creates — they aren't
    // subscription charges and must never be offered for refund. The threshold is
    // per-currency: zero-decimal currencies (JPY/KRW…) have no minor units, so a
    // flat "100 = $1" would wrongly discard real small charges there.
    const succeededCharge = charges.data.find(
      (c) =>
        c.status === "succeeded" &&
        !c.refunded &&
        c.amount > (StripeClient.isZeroDecimal(c.currency) ? 1 : 100)
    ) as ChargeWithInvoice | undefined;

    if (!succeededCharge) return null;

    // Try to find the subscription from the invoice
    let subscriptionId = "";
    const chargeInvoice = succeededCharge.invoice;
    if (chargeInvoice) {
      const invoiceId = typeof chargeInvoice === "string" ? chargeInvoice : chargeInvoice.id;

      try {
        const invoice = await this.stripe.invoices.retrieve(invoiceId);
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

  async applyDiscountCoupon(subscriptionId: string, couponId: string, idempotencyKey?: string): Promise<void> {
    await this.stripe.subscriptions.update(
      subscriptionId,
      { discounts: [{ coupon: couponId }] },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // ---- Webhook endpoints (programmatic registration; no dashboard access) ----

  async listWebhookEndpoints(limit = 100): Promise<Stripe.WebhookEndpoint[]> {
    const res = await this.stripe.webhookEndpoints.list({ limit });
    return res.data;
  }

  // The signing secret is returned ONLY here, at creation time — capture and
  // persist it. The URL-derived idempotency key stops a boot race across
  // instances from creating two endpoints for the same URL.
  async createWebhookEndpoint(
    url: string,
    events: Stripe.WebhookEndpointCreateParams.EnabledEvent[],
    idempotencyKey: string
  ): Promise<{ id: string; secret: string | null }> {
    const ep = await this.stripe.webhookEndpoints.create(
      { url, enabled_events: events, description: "Postiz support bot" },
      { idempotencyKey }
    );
    return { id: ep.id, secret: ep.secret ?? null };
  }

  // NOTE: update never returns the secret — the existing one keeps working.
  async updateWebhookEndpoint(
    id: string,
    params: Stripe.WebhookEndpointUpdateParams
  ): Promise<Stripe.WebhookEndpoint> {
    return this.stripe.webhookEndpoints.update(id, params);
  }

  async deleteWebhookEndpoint(id: string): Promise<void> {
    await this.stripe.webhookEndpoints.del(id);
  }

  // Kept here so the `Stripe` import/instance stays encapsulated in this class.
  constructWebhookEvent(rawBody: Buffer, signature: string, secret: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }

  // Customer behind a charge (for webhook alerts → linked Discord user lookup).
  async getChargeCustomerId(chargeId: string): Promise<string | null> {
    const charge = await this.stripe.charges.retrieve(chargeId);
    return typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null);
  }

  // Fresh charge state for the refund guardrails (amount cap + already-refunded check).
  async getChargeAmount(chargeId: string): Promise<{ amount: number; currency: string; refunded: boolean }> {
    const charge = await this.stripe.charges.retrieve(chargeId);
    return { amount: charge.amount, currency: charge.currency, refunded: charge.refunded };
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    if (!subscriptionId.startsWith("sub_")) {
      throw new Error("cancelSubscription requires a subscription id (sub_...)");
    }
    await this.stripe.subscriptions.cancel(subscriptionId);
  }

  // Cancels the customer's SOLE active subscription. Used only when a refund's
  // charge couldn't be tied to a specific subscription; in that case cancelling
  // "the newest" is a guess that can kill an unrelated (e.g. just-upgraded) plan.
  // Returns { ambiguous: true } when the customer has more than one active
  // subscription so the caller can hand off to staff instead of guessing wrong,
  // or null when there is nothing to cancel.
  async cancelSoleActiveSubscription(
    customerId: string
  ): Promise<{ subscriptionId: string } | { ambiguous: true } | null> {
    const subscriptions = await this.stripe.subscriptions.list({
      customer: customerId,
      status: "all",
    });

    const active = subscriptions.data.filter((s) => s.status !== "canceled");
    if (active.length === 0) return null;
    if (active.length > 1) return { ambiguous: true };

    await this.stripe.subscriptions.cancel(active[0].id);
    return { subscriptionId: active[0].id };
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

  // Account-wide search over PaymentIntents by exact amount (minor units) and
  // optional currency. Unlike charges.search, this reaches DECLINED / incomplete
  // attempts that never produced a Charge — issuer-blocked or failed renewals the
  // last4/charge searches are structurally blind to. latest_charge is expanded so
  // callers can read the card + decline reason off the failed charge when present.
  // amountMinor is interpolated into the query, so callers must pass a number.
  async searchPaymentIntentsByAmount(
    amountMinor: number,
    currency: string | undefined,
    limit = 50,
    page?: string
  ): Promise<{ paymentIntents: Stripe.PaymentIntent[]; nextPage: string | null }> {
    const query = `amount:${amountMinor}` + (currency ? ` AND currency:"${currency}"` : "");
    const res = await this.stripe.paymentIntents.search({
      query,
      limit,
      expand: ["data.latest_charge"],
      ...(page ? { page } : {}),
    });
    return { paymentIntents: res.data, nextPage: res.next_page ?? null };
  }

  // Fuzzy customer lookup by name OR email substring (Search API's ~ operator) —
  // the exact-match customers.list({ email }) can't do partial or company-name
  // hits (Postiz stores the org name as the Stripe customer name). term is
  // interpolated into the query string, so callers must strip quotes/backslashes.
  async searchCustomersByTerm(term: string, limit = 20): Promise<Stripe.Customer[]> {
    // Strip quotes/backslashes here too (not just at the callers): this method is
    // reachable from the read-only MCP server, where the term is model-supplied.
    const safe = term.replace(/["\\]/g, "").trim();
    if (safe.length < 2) return [];
    const res = await this.stripe.customers.search({
      query: `name~"${safe}" OR email~"${safe}"`,
      limit,
    });
    return res.data;
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

  // Full sweep of active subscriptions, counting how many use each price —
  // there is no Stripe API for per-price totals. 100/page; capped as a runaway guard.
  async countActiveSubscriptionsByPrice(
    maxPages = 50
  ): Promise<{ counts: Map<string, number>; scanned: number; truncated: boolean }> {
    const counts = new Map<string, number>();
    let scanned = 0;
    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.stripe.subscriptions.list({
        status: "active",
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const sub of res.data) {
        scanned++;
        for (const item of sub.items.data) {
          counts.set(item.price.id, (counts.get(item.price.id) ?? 0) + 1);
        }
      }
      if (!res.has_more || res.data.length === 0) return { counts, scanned, truncated: false };
      startingAfter = res.data[res.data.length - 1].id;
    }
    return { counts, scanned, truncated: true };
  }

  // "charge" bills the default payment method immediately and errors visibly if
  // that isn't possible; "invoice" emails an invoice due in 7 days instead.
  async createSubscription(
    params: {
      customerId: string;
      priceId: string;
      couponId?: string;
      promotionCodeId?: string;
      trialDays?: number;
      collection: "charge" | "invoice";
    },
    idempotencyKey: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.create(
      {
        customer: params.customerId,
        items: [{ price: params.priceId }],
        ...(params.couponId
          ? { discounts: [{ coupon: params.couponId }] }
          : params.promotionCodeId
            ? { discounts: [{ promotion_code: params.promotionCodeId }] }
            : {}),
        ...(params.trialDays ? { trial_period_days: params.trialDays } : {}),
        ...(params.collection === "invoice"
          ? { collection_method: "send_invoice", days_until_due: 7 }
          : { payment_behavior: "error_if_incomplete" }),
      },
      { idempotencyKey }
    );
  }

  // Plan change on one subscription item. Discounts: undefined = keep existing
  // (Stripe's default on price changes), "clear" = remove all, coupon id = replace.
  // prorationDate pins prorations to the same timestamp a preview used, so the
  // committed invoice matches the previewed one exactly.
  async changeSubscriptionPlan(
    params: {
      subscriptionId: string;
      itemId: string;
      priceId: string;
      prorationBehavior: "create_prorations" | "none";
      discounts?: "clear" | string;
      prorationDate?: number;
    },
    idempotencyKey: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      params.subscriptionId,
      {
        items: [{ id: params.itemId, price: params.priceId }],
        proration_behavior: params.prorationBehavior,
        ...(params.prorationDate && params.prorationBehavior === "create_prorations"
          ? { proration_date: params.prorationDate }
          : {}),
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

  // All PaymentIntents of a customer — includes attempts that never produced a
  // charge (declined at confirm, abandoned 3DS, canceled) which charges.list
  // can't surface. Callers filter on latest_charge == null for those.
  async listPaymentIntents(customerId: string, limit = 100): Promise<Stripe.PaymentIntent[]> {
    const res = await this.stripe.paymentIntents.list({ customer: customerId, limit });
    return res.data;
  }

  async getPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.retrieve(paymentIntentId);
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

  // Only valid while the PaymentIntent is in a cancelable status
  // (requires_payment_method / requires_confirmation / requires_action / processing).
  async cancelPaymentIntent(paymentIntentId: string, idempotencyKey?: string): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.cancel(
      paymentIntentId,
      {},
      idempotencyKey ? { idempotencyKey } : undefined
    );
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

  async listPromotionCodes(limit = 25, activeOnly = false): Promise<Stripe.PromotionCode[]> {
    const res = await this.stripe.promotionCodes.list({
      limit,
      ...(activeOnly ? { active: true } : {}),
      expand: ["data.promotion.coupon"],
    });
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

  // ---- Billing admin panel (/billing) invoice, balance & schedule reads ----

  async getInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    // payments is expandable-only on Basil invoices — without it the invoice
    // carries no charge/payment-intent reference at all.
    return this.stripe.invoices.retrieve(invoiceId, { expand: ["payments"] });
  }

  async listInvoicesByStatus(
    customerId: string,
    status: Stripe.Invoice.Status | undefined,
    limit = 10,
    startingAfter?: string
  ): Promise<Stripe.ApiList<Stripe.Invoice>> {
    return this.stripe.invoices.list({
      customer: customerId,
      ...(status ? { status } : {}),
      limit,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
  }

  // All payment method types — listCustomerCards only covers cards.
  async listAllPaymentMethods(customerId: string): Promise<Stripe.PaymentMethod[]> {
    const res = await this.stripe.paymentMethods.list({ customer: customerId, limit: 100 });
    return res.data;
  }

  async listBalanceTransactions(
    customerId: string,
    limit = 10,
    startingAfter?: string
  ): Promise<Stripe.ApiList<Stripe.CustomerBalanceTransaction>> {
    return this.stripe.customers.listBalanceTransactions(customerId, {
      limit,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
  }

  // Upcoming-invoice preview of a plan change. Callers pass the same prorationDate
  // to changeSubscriptionPlan so the committed prorations match this preview.
  async previewPlanChange(params: {
    customerId: string;
    subscriptionId: string;
    itemId: string;
    priceId: string;
    prorationDate: number;
  }): Promise<Stripe.Invoice> {
    return this.stripe.invoices.createPreview({
      customer: params.customerId,
      subscription: params.subscriptionId,
      subscription_details: {
        items: [{ id: params.itemId, price: params.priceId }],
        proration_behavior: "create_prorations",
        proration_date: params.prorationDate,
      },
    });
  }

  async previewCreditNote(params: {
    invoiceId: string;
    amountMinor?: number;
    refundAmountMinor?: number;
    creditAmountMinor?: number;
    outOfBandAmountMinor?: number;
  }): Promise<Stripe.CreditNote> {
    return this.stripe.creditNotes.preview({
      invoice: params.invoiceId,
      ...(params.amountMinor != null ? { amount: params.amountMinor } : {}),
      ...(params.refundAmountMinor != null ? { refund_amount: params.refundAmountMinor } : {}),
      ...(params.creditAmountMinor != null ? { credit_amount: params.creditAmountMinor } : {}),
      ...(params.outOfBandAmountMinor != null ? { out_of_band_amount: params.outOfBandAmountMinor } : {}),
    });
  }

  async getSubscriptionSchedule(scheduleId: string): Promise<Stripe.SubscriptionSchedule> {
    return this.stripe.subscriptionSchedules.retrieve(scheduleId);
  }

  async listPendingInvoiceItems(customerId: string): Promise<Stripe.InvoiceItem[]> {
    const res = await this.stripe.invoiceItems.list({ customer: customerId, pending: true, limit: 25 });
    return res.data;
  }

  // ---- Billing admin panel (/billing) subscription writes ----

  async pauseSubscription(
    subscriptionId: string,
    behavior: "keep_as_draft" | "mark_uncollectible" | "void",
    idempotencyKey?: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      subscriptionId,
      { pause_collection: { behavior } },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // pause_collection is Emptyable in v20 — empty string clears the pause.
  async resumeSubscription(subscriptionId: string, idempotencyKey?: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      subscriptionId,
      { pause_collection: "" },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  async setTrialEnd(
    subscriptionId: string,
    trialEnd: number | "now",
    idempotencyKey?: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      subscriptionId,
      { trial_end: trialEnd, proration_behavior: "none" },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  async setSubscriptionQuantity(
    subscriptionId: string,
    itemId: string,
    quantity: number,
    prorationBehavior: "create_prorations" | "none",
    idempotencyKey?: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      subscriptionId,
      { items: [{ id: itemId, quantity }], proration_behavior: prorationBehavior },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  async createScheduleFromSubscription(
    subscriptionId: string,
    idempotencyKey?: string
  ): Promise<Stripe.SubscriptionSchedule> {
    return this.stripe.subscriptionSchedules.create(
      { from_subscription: subscriptionId },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // Keeps the current phase as-is and appends a phase that switches to newPriceId
  // at the current period end; end_behavior "release" hands the subscription back
  // afterwards instead of keeping it schedule-managed forever.
  async scheduleNextPhasePlan(
    scheduleId: string,
    newPriceId: string,
    idempotencyKey?: string
  ): Promise<Stripe.SubscriptionSchedule> {
    const schedule = await this.stripe.subscriptionSchedules.retrieve(scheduleId);
    const current = schedule.phases[0];
    // The update API only accepts param-shaped phases, so rebuild phase 0 from the
    // response's items/start_date/end_date and drop response-only fields.
    const currentPhase: Stripe.SubscriptionScheduleUpdateParams.Phase = {
      items: current.items.map((item) => ({
        price: typeof item.price === "string" ? item.price : item.price.id,
        ...(item.quantity != null ? { quantity: item.quantity } : {}),
      })),
      start_date: current.start_date,
      end_date: current.end_date,
    };
    return this.stripe.subscriptionSchedules.update(
      scheduleId,
      {
        end_behavior: "release",
        phases: [currentPhase, { items: [{ price: newPriceId }] }],
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  async releaseSchedule(scheduleId: string, idempotencyKey?: string): Promise<Stripe.SubscriptionSchedule> {
    return this.stripe.subscriptionSchedules.release(
      scheduleId,
      {},
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // ---- Billing admin panel (/billing) invoice, credit & payment writes ----

  // pending_invoice_items_behavior MUST stay "exclude": ad-hoc invoices must never
  // sweep in unrelated pending items — items are attached explicitly via
  // createInvoiceItem with the invoice id.
  async createDraftInvoice(
    params: {
      customerId: string;
      collectionMethod: "charge_automatically" | "send_invoice";
      daysUntilDue?: number;
    },
    idempotencyKey?: string
  ): Promise<Stripe.Invoice> {
    return this.stripe.invoices.create(
      {
        customer: params.customerId,
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        collection_method: params.collectionMethod,
        ...(params.collectionMethod === "send_invoice"
          ? { days_until_due: params.daysUntilDue ?? 7 }
          : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  async createInvoiceItem(
    params: {
      customerId: string;
      invoiceId: string;
      amountMinor: number;
      currency: string;
      description: string;
    },
    idempotencyKey?: string
  ): Promise<Stripe.InvoiceItem> {
    return this.stripe.invoiceItems.create(
      {
        customer: params.customerId,
        invoice: params.invoiceId,
        amount: params.amountMinor,
        currency: params.currency,
        description: params.description,
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  async updateInvoiceCollection(
    invoiceId: string,
    collectionMethod: "charge_automatically" | "send_invoice",
    daysUntilDue?: number,
    idempotencyKey?: string
  ): Promise<Stripe.Invoice> {
    return this.stripe.invoices.update(
      invoiceId,
      {
        collection_method: collectionMethod,
        ...(collectionMethod === "send_invoice" ? { days_until_due: daysUntilDue ?? 7 } : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // auto_advance stays off: finalizing must not let Stripe auto-collect later —
  // collection happens explicitly via sendInvoice/payInvoice.
  async finalizeInvoice(invoiceId: string, idempotencyKey?: string): Promise<Stripe.Invoice> {
    return this.stripe.invoices.finalizeInvoice(
      invoiceId,
      { auto_advance: false },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  async sendInvoice(invoiceId: string, idempotencyKey?: string): Promise<Stripe.Invoice> {
    return this.stripe.invoices.sendInvoice(invoiceId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  async payInvoice(invoiceId: string, idempotencyKey?: string): Promise<Stripe.Invoice> {
    return this.stripe.invoices.pay(invoiceId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  async voidInvoice(invoiceId: string, idempotencyKey?: string): Promise<Stripe.Invoice> {
    return this.stripe.invoices.voidInvoice(invoiceId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  async markInvoiceUncollectible(invoiceId: string, idempotencyKey?: string): Promise<Stripe.Invoice> {
    return this.stripe.invoices.markUncollectible(invoiceId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  async deleteDraftInvoice(invoiceId: string, idempotencyKey?: string): Promise<void> {
    await this.stripe.invoices.del(invoiceId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  // mode picks which Stripe amount field carries amountMinor: "refund" refunds the
  // payment, "credit" credits the customer balance, "out_of_band" records an
  // off-Stripe credit. Omitted amountMinor lets Stripe determine the amount.
  async createCreditNote(
    params: {
      invoiceId: string;
      amountMinor?: number;
      mode: "refund" | "credit" | "out_of_band";
      memo?: string;
      reason?: Stripe.CreditNoteCreateParams.Reason;
    },
    idempotencyKey?: string
  ): Promise<Stripe.CreditNote> {
    return this.stripe.creditNotes.create(
      {
        invoice: params.invoiceId,
        ...(params.amountMinor != null
          ? params.mode === "refund"
            ? { refund_amount: params.amountMinor }
            : params.mode === "credit"
              ? { credit_amount: params.amountMinor }
              : { out_of_band_amount: params.amountMinor }
          : {}),
        ...(params.memo ? { memo: params.memo } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // Stripe sign convention: NEGATIVE amount = credit (reduces what the customer
  // owes next invoice), POSITIVE = debit. Callers pass the signed amount.
  async adjustCustomerBalance(
    customerId: string,
    amountMinor: number,
    currency: string,
    description: string,
    idempotencyKey?: string
  ): Promise<Stripe.CustomerBalanceTransaction> {
    return this.stripe.customers.createBalanceTransaction(
      customerId,
      { amount: amountMinor, currency, description },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // off_session + confirm: charges the saved payment method immediately and errors
  // visibly (no customer-present flow) if the charge can't be completed.
  async createManualPaymentIntent(
    params: {
      customerId: string;
      amountMinor: number;
      currency: string;
      paymentMethodId?: string;
      description?: string;
    },
    idempotencyKey?: string
  ): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.create(
      {
        customer: params.customerId,
        amount: params.amountMinor,
        currency: params.currency,
        ...(params.paymentMethodId ? { payment_method: params.paymentMethodId } : {}),
        off_session: true,
        confirm: true,
        ...(params.description ? { description: params.description } : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
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
