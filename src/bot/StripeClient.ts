import Stripe from "stripe";
import { BotConfig } from "../config";
import type { SettingsStore } from "../config/SettingsStore";
import { safeFetch } from "../util/safeFetch";
import { countWithSearchCap } from "./billing/disputeRatio";

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
  private sdk: Stripe;
  private sdkKey: string;

  // `settings` is optional: the read-only MCP server builds a StripeClient in
  // a child process from a synthetic env-only config (no DB there), and the
  // env key alone is correct for it.
  constructor(private config: BotConfig, private settings?: SettingsStore) {
    this.sdkKey = this.resolveKey();
    this.sdk = new Stripe(this.sdkKey);
  }

  // Managed key first (Vault KV / enc:v1 column — rotatable at runtime), boot
  // env as fallback. `||` not `??`: an empty managed value must fall through
  // to env, never reach `new Stripe("")`.
  private resolveKey(): string {
    return this.settings?.stripeSecretKey() || this.config.stripe.secretKey;
  }

  // Every API call resolves the key per access — same live-rotation semantics
  // as the webhook secret — but the SDK instance is rebuilt only when the key
  // actually changed; steady state costs one string compare.
  private get stripe(): Stripe {
    const key = this.resolveKey();
    if (key !== this.sdkKey) {
      this.sdkKey = key;
      this.sdk = new Stripe(key);
    }
    return this.sdk;
  }

  // Key mode for the /billing root panel banner (sk_test_/rk_test_ keys).
  isTestMode(): boolean {
    return this.resolveKey().includes("_test_");
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
    // flat "100 = $1" would wrongly discard real small charges there. Disputed
    // charges are excluded too: Stripe rejects their refunds (charge_disputed)
    // after the billing-action lock has already been churned.
    const succeededCharge = charges.data.find(
      (c) =>
        c.status === "succeeded" &&
        !c.refunded &&
        !c.disputed &&
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

  // Billing shape of a subscription, for the self-service guardrails: whether
  // it is actually being paid for right now, and how long a period one charge
  // buys. Both are invisible on the charge itself, which is why the
  // self-service flow could not previously tell an annual payment from a
  // monthly one, or a trial from a paying customer.
  async getSubscriptionBillingContext(
    subscriptionId: string
  ): Promise<{
    status: string;
    customerId: string | null;
    interval: string | null;
    intervalCount: number;
    monthsPerPeriod: number | null;
  } | null> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    const price = sub.items.data[0]?.price;
    const recurring = price?.recurring ?? null;
    const interval = recurring?.interval ?? null;
    const intervalCount = recurring?.interval_count ?? 1;
    // Normalised to months so callers compare one number instead of
    // re-deriving the day/week/month/year ladder.
    const monthsPerPeriod =
      interval === "year"
        ? 12 * intervalCount
        : interval === "month"
          ? intervalCount
          : interval === "week" || interval === "day"
            ? 0 // shorter than a month; never a multi-month prepayment
            : null;
    return {
      status: sub.status,
      customerId: typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null),
      interval,
      intervalCount,
      monthsPerPeriod,
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
    idempotencyKey: string,
    opts: { description?: string } = {}
  ): Promise<{ id: string; secret: string | null }> {
    const ep = await this.stripe.webhookEndpoints.create(
      { url, enabled_events: events, description: opts.description ?? "Postiz support bot" },
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

  // Fresh charge state for the refund guardrails (amount cap, already-refunded,
  // charge-age and blocklist/history identity checks).
  async getChargeAmount(chargeId: string): Promise<{
    amount: number;
    currency: string;
    refunded: boolean;
    created: Date;
    customerId: string | null;
  }> {
    const charge = await this.stripe.charges.retrieve(chargeId);
    return {
      amount: charge.amount,
      currency: charge.currency,
      refunded: charge.refunded,
      created: new Date(charge.created * 1000),
      customerId: typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null),
    };
  }

  // Any refund (full or partial) anywhere in the customer's charge history —
  // feeds the first-refund-only guardrail. refunds.list has no customer filter
  // in this API version, so this sweeps charges.list and checks amount_refunded.
  // The page cap is a runaway guard — callers treat truncated as "could not
  // verify" (fail-safe to manual review).
  async customerHasAnyRefund(customerId: string, maxPages = 3): Promise<{ hasRefund: boolean; truncated: boolean }> {
    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.stripe.charges.list({
        customer: customerId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      if (res.data.some((c) => c.refunded || c.amount_refunded > 0)) {
        return { hasRefund: true, truncated: false };
      }
      if (!res.has_more || res.data.length === 0) return { hasRefund: false, truncated: false };
      startingAfter = res.data[res.data.length - 1].id;
    }
    return { hasRefund: false, truncated: true };
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

  // Discount removal. Sub-level removal leaves a customer-level
  // discount (if any) untouched — they are separate objects at Stripe.
  async removeSubscriptionDiscount(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.deleteDiscount(subscriptionId);
  }

  async removeCustomerDiscount(customerId: string): Promise<void> {
    await this.stripe.customers.deleteDiscount(customerId);
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
  // identification. Both string inputs are validated by the caller (digits /
  // [a-z_]) since they are interpolated into the query string; status is a
  // closed union for the same reason. Declined/blocked attempts on a confirmed
  // PI DO exist here as status:"failed" charges — only attempts that never
  // reached confirmation (abandoned checkout, unfinished 3DS) have no charge
  // at all and need the amount-based PI search instead.
  async searchChargesByCardLast4(
    last4: string,
    brand: string | undefined,
    limit = 10,
    page?: string,
    status?: "succeeded" | "pending" | "failed"
  ): Promise<{ charges: Stripe.Charge[]; nextPage: string | null }> {
    const query =
      `payment_method_details.card.last4:"${last4}"` +
      (brand ? ` AND payment_method_details.card.brand:"${brand}"` : "") +
      (status ? ` AND status:"${status}"` : "");
    const res = await this.stripe.charges.search({ query, limit, ...(page ? { page } : {}) });
    return { charges: res.data, nextPage: res.next_page ?? null };
  }

  // Account-wide search over PaymentIntents by exact amount (minor units) and
  // optional currency. Unlike charges.search, this reaches attempts that never
  // produced ANY charge (abandoned checkout, unfinished 3DS) — the slice the
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
    const query = `name~"${safe}" OR email~"${safe}"`;
    try {
      // Same expansion as listCustomersPage so the list's has-subscription
      // filter works on search results too — but search endpoints can refuse
      // sub-list expansions that list endpoints allow, so degrade rather
      // than kill the search box.
      const res = await this.stripe.customers.search({ query, limit, expand: ["data.subscriptions"] });
      return res.data;
    } catch {
      const res = await this.stripe.customers.search({ query, limit });
      return res.data;
    }
  }

  // The Basil-era API version this SDK pins DROPPED billing_details.email
  // from the charges.search fields (prod-confirmed refusal). The field still
  // works under older versions, and Stripe honors a per-request version pin —
  // the charge fields the Payments list renders (amount/currency/created/
  // status/customer/billing_details/payment_method_details) are shape-stable
  // across these versions. Callers keep the customers-first merge as the
  // fallback if this pin is ever refused.
  private static readonly LEGACY_SEARCH_API_VERSION = "2024-06-20";

  async searchChargesByBillingEmail(
    email: string,
    limit = 100
  ): Promise<{ charges: Stripe.Charge[]; totalCount: number | null }> {
    const safe = email.replace(/["\\]/g, "").trim();
    if (safe.length < 3) return { charges: [], totalCount: 0 };
    const res = await this.stripe.charges.search(
      { query: `billing_details.email~"${safe}"`, limit, expand: ["total_count"] },
      { apiVersion: StripeClient.LEGACY_SEARCH_API_VERSION }
    );
    return { charges: res.data as unknown as Stripe.Charge[], totalCount: res.total_count ?? null };
  }

  // Customers by (billing/wallet) email, substring match. `email` IS a
  // supported customers.search field on the current version — the second leg
  // of the email sweep (catches customer-record matches whose charges carry
  // a DIFFERENT billing email).
  async searchCustomersByEmail(email: string, limit = 10): Promise<Stripe.Customer[]> {
    const safe = email.replace(/["\\]/g, "").trim();
    if (safe.length < 3) return [];
    const res = await this.stripe.customers.search({ query: `email~"${safe}"`, limit });
    return res.data;
  }

  async getCustomer(customerId: string): Promise<Stripe.Customer | null> {
    const customer = await this.stripe.customers.retrieve(customerId);
    return customer.deleted ? null : (customer as Stripe.Customer);
  }

  // Account-wide customer browse (dashboard Customers list) — plain
  // customers.list pagination, newest first.
  async listCustomersPage(opts: {
    limit?: number;
    startingAfter?: string;
    createdGte?: number;
    createdLt?: number;
  }): Promise<{ customers: Stripe.Customer[]; hasMore: boolean }> {
    const created = {
      ...(opts.createdGte ? { gte: opts.createdGte } : {}),
      ...(opts.createdLt ? { lt: opts.createdLt } : {}),
    };
    const res = await this.stripe.customers.list({
      limit: opts.limit ?? 25,
      // Subscriptions ride along so the list can filter "has subscription"
      // without N+1 lookups (Stripe inlines up to 10 per customer).
      expand: ["data.subscriptions"],
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
      ...(Object.keys(created).length ? { created } : {}),
    });
    return { customers: res.data, hasMore: res.has_more };
  }

  async findCustomersByEmail(email: string): Promise<Stripe.Customer[]> {
    const res = await this.stripe.customers.list({ email, limit: 10 });
    return res.data;
  }

  // ---- Dashboard account-wide reads (/billing web) ----

  // Account-wide charge browse (dashboard Payments list), newest first.
  // createdGte/createdLt narrow the window server-side (the date filter pill;
  // Lt is exclusive — callers add a day to make custom ranges inclusive).
  async listAllCharges(opts: {
    limit?: number;
    startingAfter?: string;
    createdGte?: number;
    createdLt?: number;
  }): Promise<{ charges: Stripe.Charge[]; hasMore: boolean }> {
    const created = {
      ...(opts.createdGte ? { gte: opts.createdGte } : {}),
      ...(opts.createdLt ? { lt: opts.createdLt } : {}),
    };
    const res = await this.stripe.charges.list({
      limit: opts.limit ?? 25,
      // Expand the customer (name/email in the list) and refunds (refunded-date
      // column) so the list matches Stripe's look with no per-row lookups.
      expand: ["data.customer", "data.refunds"],
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
      ...(Object.keys(created).length ? { created } : {}),
    });
    return { charges: res.data, hasMore: res.has_more };
  }

  // Account-wide PaymentIntent browse — the "Incomplete" payments view
  // (declined/abandoned attempts that never produced a Charge).
  async listAllPaymentIntents(opts: {
    limit?: number;
    startingAfter?: string;
    createdGte?: number;
    createdLt?: number;
  }): Promise<{ paymentIntents: Stripe.PaymentIntent[]; hasMore: boolean }> {
    const created = {
      ...(opts.createdGte ? { gte: opts.createdGte } : {}),
      ...(opts.createdLt ? { lt: opts.createdLt } : {}),
    };
    const res = await this.stripe.paymentIntents.list({
      limit: opts.limit ?? 25,
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
      ...(Object.keys(created).length ? { created } : {}),
    });
    return { paymentIntents: res.data, hasMore: res.has_more };
  }

  // Charge search shaped for the Payments LIST (customer expanded like
  // listAllCharges, total_count for the footer). Powers the filters the list
  // API can't express server-side — card fingerprint (the reverse-card sweep)
  // and exact email. NO data.refunds expand: search endpoints refuse sub-LIST
  // expansions that plain list endpoints allow (the refunded-date column
  // degrades to "—" in sweep mode). If even data.customer is refused, retry
  // bare — a degraded row beats a dead page. Queries are BUILT BY CALLERS
  // from validated values only. Search lags live data by ~1 minute.
  async searchChargesForList(
    query: string,
    limit = 100
  ): Promise<{ charges: Stripe.Charge[]; totalCount: number | null }> {
    try {
      const res = await this.stripe.charges.search({
        query,
        limit,
        expand: ["data.customer", "total_count"],
      });
      return { charges: res.data, totalCount: res.total_count ?? null };
    } catch {
      const res = await this.stripe.charges.search({ query, limit, expand: ["total_count"] });
      return { charges: res.data, totalCount: res.total_count ?? null };
    }
  }

  // Refunds of one charge (payment-detail timeline) or account-wide.
  async listRefunds(opts: {
    chargeId?: string;
    limit?: number;
    startingAfter?: string;
  }): Promise<{ refunds: Stripe.Refund[]; hasMore: boolean }> {
    const res = await this.stripe.refunds.list({
      limit: opts.limit ?? 25,
      ...(opts.chargeId ? { charge: opts.chargeId } : {}),
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
    });
    return { refunds: res.data, hasMore: res.has_more };
  }

  async getRefund(refundId: string): Promise<Stripe.Refund> {
    return this.stripe.refunds.retrieve(refundId);
  }

  async getPaymentMethod(paymentMethodId: string): Promise<Stripe.PaymentMethod> {
    return this.stripe.paymentMethods.retrieve(paymentMethodId);
  }

  // Charge with the fee-bearing balance transaction expanded (the dashboard
  // "Payment breakdown" panel). Kept separate from getCharge so the hot
  // revalidation paths stay expansion-free.
  async getChargeDetailed(chargeId: string): Promise<Stripe.Charge> {
    return this.stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
  }

  async getBalance(): Promise<Stripe.Balance> {
    return this.stripe.balance.retrieve();
  }

  async listPayouts(opts: {
    limit?: number;
    startingAfter?: string;
  }): Promise<{ payouts: Stripe.Payout[]; hasMore: boolean }> {
    const res = await this.stripe.payouts.list({
      limit: opts.limit ?? 25,
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
    });
    return { payouts: res.data, hasMore: res.has_more };
  }

  async getPayout(payoutId: string): Promise<Stripe.Payout> {
    return this.stripe.payouts.retrieve(payoutId);
  }

  // ---- payout writes: create / cancel / reverse ----

  // Manual payout from the AVAILABLE balance to the default external account.
  async createPayout(
    params: {
      amountMinor: number;
      currency: string;
      description?: string;
      statementDescriptor?: string;
      // "instant" needs an eligible debit destination and draws from the
      // instant_available balance (fee applies); default is standard.
      method?: "standard" | "instant";
    },
    idempotencyKey: string
  ): Promise<Stripe.Payout> {
    return this.stripe.payouts.create(
      {
        amount: params.amountMinor,
        currency: params.currency,
        ...(params.description ? { description: params.description } : {}),
        ...(params.statementDescriptor ? { statement_descriptor: params.statementDescriptor } : {}),
        ...(params.method === "instant" ? { method: "instant" as const } : {}),
      },
      { idempotencyKey }
    );
  }

  // Pull money from the account's default verified bank into the Stripe
  // balance. Statement descriptor caps at 15 chars for top-ups (not 22).
  async createTopUp(
    params: { amountMinor: number; currency: string; description?: string; statementDescriptor?: string },
    idempotencyKey: string
  ): Promise<Stripe.Topup> {
    return this.stripe.topups.create(
      {
        amount: params.amountMinor,
        currency: params.currency,
        ...(params.description ? { description: params.description } : {}),
        ...(params.statementDescriptor ? { statement_descriptor: params.statementDescriptor } : {}),
      },
      { idempotencyKey }
    );
  }

  // Only PENDING payouts can be canceled — the funds return to the available balance.
  async cancelPayout(payoutId: string, idempotencyKey?: string): Promise<Stripe.Payout> {
    return this.stripe.payouts.cancel(payoutId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  // Debits the destination bank account to claw a PAID payout back (Stripe
  // supports this for US/CA bank accounts only).
  async reversePayout(payoutId: string, idempotencyKey?: string): Promise<Stripe.Payout> {
    return this.stripe.payouts.reverse(payoutId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  // Top-ups: money YOU push into the Stripe balance (bank transfer / API).
  async listTopUps(opts: { limit?: number; startingAfter?: string } = {}): Promise<{ topups: Stripe.Topup[]; hasMore: boolean }> {
    const res = await this.stripe.topups.list({
      limit: opts.limit ?? 25,
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
    });
    return { topups: res.data, hasMore: res.has_more };
  }

  // ACCOUNT balance transactions (fees/charges/refunds/payouts) — distinct
  // from the per-customer credit-ledger listCustomerBalanceTransactions.
  async listAccountBalanceTransactions(opts: {
    limit?: number;
    startingAfter?: string;
    type?: string;
    payoutId?: string;
    createdGte?: number;
    createdLt?: number;
    // Narrows to the transactions produced by one object (re_… / dp_… / ch_…) —
    // the money-out webhook path uses this for its targeted mini-sweep.
    sourceId?: string;
    // Expands source (and, through it, the charge) so the money-out classifier
    // can attribute a row without an extra round-trip per transaction.
    expandSource?: boolean;
  }): Promise<{ transactions: Stripe.BalanceTransaction[]; hasMore: boolean }> {
    const created = {
      ...(opts.createdGte ? { gte: opts.createdGte } : {}),
      ...(opts.createdLt ? { lt: opts.createdLt } : {}),
    };
    const res = await this.stripe.balanceTransactions.list({
      limit: opts.limit ?? 25,
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.payoutId ? { payout: opts.payoutId } : {}),
      ...(opts.sourceId ? { source: opts.sourceId } : {}),
      ...(opts.expandSource ? { expand: ["data.source"] } : {}),
      ...(Object.keys(created).length ? { created } : {}),
    });
    return { transactions: res.data, hasMore: res.has_more };
  }

  // A charge with its balance transaction expanded — the ONLY place the
  // processing fee Stripe charged for it is visible. The money-out ledger needs
  // it to work out what a refund cost in fees: Stripe takes no new fee on a
  // refund, it simply never gives the original one back.
  async getChargeWithFee(chargeId: string): Promise<{ amount: number; feeMinor: number; currency: string } | null> {
    const charge = await this.stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] }).catch(() => null);
    if (!charge) return null;
    const bt = charge.balance_transaction;
    if (!bt || typeof bt === "string") return null;
    return { amount: charge.amount, feeMinor: bt.fee ?? 0, currency: bt.currency };
  }

  async getCreditNote(creditNoteId: string): Promise<Stripe.CreditNote> {
    return this.stripe.creditNotes.retrieve(creditNoteId);
  }

  // Account-wide credit notes (the per-invoice listCreditNotes above cannot
  // answer "what did we credit last year"). Used by the money-out concession
  // backfill, which has no balance-transaction trail to walk.
  async listAllCreditNotes(opts: { limit?: number; startingAfter?: string } = {}): Promise<{
    notes: Stripe.CreditNote[];
    hasMore: boolean;
  }> {
    const res = await this.stripe.creditNotes.list({
      limit: opts.limit ?? 100,
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
    });
    return { notes: res.data, hasMore: res.has_more };
  }

  // ---- Radar reviews: the manual-review queue ----

  // reviews.list returns OPEN reviews only; the charge is expanded so the
  // queue can show amount/status without N+1 reads.
  async listOpenReviews(opts: { limit?: number; startingAfter?: string } = {}): Promise<{ reviews: Stripe.Review[]; hasMore: boolean }> {
    const res = await this.stripe.reviews.list({
      limit: opts.limit ?? 25,
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
      expand: ["data.charge"],
    });
    return { reviews: res.data, hasMore: res.has_more };
  }

  async getReview(reviewId: string): Promise<Stripe.Review> {
    return this.stripe.reviews.retrieve(reviewId);
  }

  // Closes the review as approved. "Decline" has no API — declining is a
  // fraud refund / PI cancel through the normal action ladder.
  async approveReview(reviewId: string, idempotencyKey?: string): Promise<Stripe.Review> {
    return this.stripe.reviews.approve(reviewId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  // ---- customer portal: configuration + per-customer login links ----

  async listPortalConfigurations(limit = 10): Promise<Stripe.BillingPortal.Configuration[]> {
    const res = await this.stripe.billingPortal.configurations.list({ limit });
    return res.data;
  }

  async createPortalConfiguration(
    features: Stripe.BillingPortal.ConfigurationCreateParams.Features,
    idempotencyKey?: string
  ): Promise<Stripe.BillingPortal.Configuration> {
    return this.stripe.billingPortal.configurations.create(
      { features },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  async updatePortalConfiguration(
    configurationId: string,
    features: Stripe.BillingPortal.ConfigurationUpdateParams.Features
  ): Promise<Stripe.BillingPortal.Configuration> {
    return this.stripe.billingPortal.configurations.update(configurationId, { features });
  }

  // Mints a short-lived login link into the customer's self-serve portal.
  async createPortalSession(customerId: string): Promise<Stripe.BillingPortal.Session> {
    return this.stripe.billingPortal.sessions.create({ customer: customerId });
  }

  // Recent account events (Home activity feed). Read-only, newest first.
  async listEvents(limit = 15): Promise<Stripe.Event[]> {
    const res = await this.stripe.events.list({ limit });
    return res.data;
  }

  // Paginated/filtered event browse for the dashboard Events page (Stripe
  // retains 30 days). type accepts Stripe's wildcard forms ("invoice.*").
  async listEventsPage(opts: {
    limit?: number;
    type?: string;
    startingAfter?: string;
  }): Promise<{ events: Stripe.Event[]; hasMore: boolean }> {
    const res = await this.stripe.events.list({
      limit: opts.limit ?? 25,
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
    });
    return { events: res.data, hasMore: res.has_more };
  }

  // Account-wide subscription browse (dashboard Subscriptions list). Status
  // "all" includes canceled; price narrows to one plan.
  async listAllSubscriptions(opts: {
    status?: Stripe.SubscriptionListParams.Status;
    priceId?: string;
    customerId?: string;
    limit?: number;
    startingAfter?: string;
    createdGte?: number;
    createdLt?: number;
    expandDiscounts?: boolean;
  }): Promise<{ subscriptions: Stripe.Subscription[]; hasMore: boolean }> {
    const created = {
      ...(opts.createdGte ? { gte: opts.createdGte } : {}),
      ...(opts.createdLt ? { lt: opts.createdLt } : {}),
    };
    const res = await this.stripe.subscriptions.list({
      status: opts.status ?? "all",
      ...(opts.priceId ? { price: opts.priceId } : {}),
      ...(opts.customerId ? { customer: opts.customerId } : {}),
      limit: opts.limit ?? 25,
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
      ...(Object.keys(created).length ? { created } : {}),
      // discounts arrive as bare ids otherwise, and there is no
      // discounts.retrieve endpoint to resolve them with.
      ...(opts.expandDiscounts ? { expand: ["data.discounts"] } : {}),
    });
    return { subscriptions: res.data, hasMore: res.has_more };
  }

  async listCreditNotes(invoiceId: string, limit = 25): Promise<Stripe.CreditNote[]> {
    const res = await this.stripe.creditNotes.list({ invoice: invoiceId, limit });
    return res.data;
  }

  // Plain upcoming-invoice preview for a live subscription (no plan change) —
  // the "Upcoming invoice" panel on the subscription detail page.
  async previewUpcomingInvoice(customerId: string, subscriptionId: string): Promise<Stripe.Invoice | null> {
    try {
      return await this.stripe.invoices.createPreview({ customer: customerId, subscription: subscriptionId });
    } catch {
      // No upcoming invoice (canceled / fully-ended subs) — not an error.
      return null;
    }
  }

  // First-invoice preview for a subscription that does NOT exist yet (the
  // create-subscription composer). trial_end shifts the first collection.
  async previewNewSubscription(params: {
    customerId: string;
    priceId: string;
    quantity?: number;
    trialEndUnix?: number;
  }): Promise<Stripe.Invoice> {
    return this.stripe.invoices.createPreview({
      customer: params.customerId,
      subscription_details: {
        items: [{ price: params.priceId, ...(params.quantity ? { quantity: params.quantity } : {}) }],
        ...(params.trialEndUnix ? { trial_end: params.trialEndUnix } : {}),
      },
    });
  }

  // Free-text charge search for the palette (email/description substring).
  // Search API: eventually consistent (~1min), never used in revalidators.
  async searchChargesByTerm(term: string, limit = 5): Promise<Stripe.Charge[]> {
    const safe = term.replace(/["\\]/g, "").trim();
    if (safe.length < 2) return [];
    // billing_details.email is NOT a supported charges.search field on this
    // API version (Stripe refusal observed in prod) — the old email clause
    // made this whole query fail silently. Email terms find their hits via
    // the customers group instead; charges match on description only.
    const res = await this.stripe.charges.search({
      query: `description~"${safe}"`,
      limit,
    });
    return res.data;
  }

  // Invoice-number search for the palette ("WLNHKEWS-0002" style).
  async searchInvoicesByNumber(term: string, limit = 5): Promise<Stripe.Invoice[]> {
    const safe = term.replace(/["\\]/g, "").trim();
    if (safe.length < 3) return [];
    const res = await this.stripe.invoices.search({ query: `number~"${safe}"`, limit });
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
    // default_payment_method is expanded so panels can show brand+last4
    // instead of a raw pm_ id without a second round-trip.
    return this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["discounts.source.coupon", "default_payment_method"],
    });
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

  // All active prices (recurring + one-time) in one call — lets the catalog list
  // show a real price + "N prices" even when a product has no default_price set.
  async listAllActivePrices(limit = 100): Promise<Stripe.Price[]> {
    const res = await this.stripe.prices.list({ active: true, limit });
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
  // cancelAtUnix schedules the hard end up front; cancelIfNoPaymentMethod makes
  // a trial that never got a card die at trial end instead of falling into
  // past_due (Stripe's default is to invoice anyway).
  async createSubscription(
    params: {
      customerId: string;
      priceId: string;
      quantity?: number;
      couponId?: string;
      promotionCodeId?: string;
      trialDays?: number;
      cancelAtUnix?: number;
      cancelIfNoPaymentMethod?: boolean;
      collection: "charge" | "invoice";
      metadata?: Record<string, string>;
    },
    idempotencyKey: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.create(
      {
        customer: params.customerId,
        items: [{ price: params.priceId, ...(params.quantity ? { quantity: params.quantity } : {}) }],
        ...(params.metadata ? { metadata: params.metadata } : {}),
        ...(params.couponId
          ? { discounts: [{ coupon: params.couponId }] }
          : params.promotionCodeId
            ? { discounts: [{ promotion_code: params.promotionCodeId }] }
            : {}),
        ...(params.trialDays ? { trial_period_days: params.trialDays } : {}),
        ...(params.cancelAtUnix ? { cancel_at: params.cancelAtUnix } : {}),
        // trial_settings only means anything alongside a trial.
        ...(params.trialDays && params.cancelIfNoPaymentMethod
          ? { trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } } }
          : {}),
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
      promotionCodeId?: string;
      quantity?: number;
      billingCycleAnchor?: "now";
      prorationDate?: number;
      metadata?: Record<string, string>;
    },
    idempotencyKey: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      params.subscriptionId,
      {
        items: [{ id: params.itemId, price: params.priceId, ...(params.quantity ? { quantity: params.quantity } : {}) }],
        proration_behavior: params.prorationBehavior,
        ...(params.metadata ? { metadata: params.metadata } : {}),
        ...(params.billingCycleAnchor === "now" ? { billing_cycle_anchor: "now" as const } : {}),
        ...(params.prorationDate && params.prorationBehavior === "create_prorations"
          ? { proration_date: params.prorationDate }
          : {}),
        ...(params.promotionCodeId
          ? { discounts: [{ promotion_code: params.promotionCodeId }] }
          : params.discounts === "clear"
            ? { discounts: "" }
            : params.discounts
              ? { discounts: [{ coupon: params.discounts }] }
              : {}),
      },
      { idempotencyKey }
    );
  }

  // Metadata-only update (merge-by-key: absent keys survive, null values
  // delete). Fires customer.subscription.updated — the Postiz repair path
  // relies on that event re-syncing the platform immediately.
  async updateSubscriptionMetadata(
    subscriptionId: string,
    metadata: Record<string, string>,
    idempotencyKey: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(subscriptionId, { metadata }, { idempotencyKey });
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

  // ---- Dispute console (account-wide disputes, evidence, Radar blocklists) ----

  async listDisputes(
    limit = 25,
    startingAfter?: string,
    createdGte?: number
  ): Promise<{ disputes: Stripe.Dispute[]; hasMore: boolean }> {
    const res = await this.stripe.disputes.list({
      limit,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
      ...(createdGte ? { created: { gte: createdGte } } : {}),
    });
    return { disputes: res.data, hasMore: res.has_more };
  }

  async getDispute(disputeId: string): Promise<Stripe.Dispute> {
    return this.stripe.disputes.retrieve(disputeId);
  }

  // Full sweep of disputes created since a timestamp (ratio + reconciliation).
  // Dispute volume is low; the page cap is a runaway guard.
  async listDisputesSince(
    createdGte: number,
    maxPages = 20
  ): Promise<{ disputes: Stripe.Dispute[]; truncated: boolean }> {
    const disputes: Stripe.Dispute[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.stripe.disputes.list({
        limit: 100,
        created: { gte: createdGte },
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      disputes.push(...res.data);
      if (!res.has_more || res.data.length === 0) return { disputes, truncated: false };
      startingAfter = res.data[res.data.length - 1].id;
    }
    return { disputes, truncated: true };
  }

  // All-time dispute sweep for the one-time history backfill. Same pagination
  // as listDisputesSince but without a created floor; the page cap is a
  // runaway guard (20k disputes — far beyond any realistic account history).
  async listAllDisputes(maxPages = 200): Promise<{ disputes: Stripe.Dispute[]; truncated: boolean }> {
    const disputes: Stripe.Dispute[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.stripe.disputes.list({
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      disputes.push(...res.data);
      if (!res.has_more || res.data.length === 0) return { disputes, truncated: false };
      startingAfter = res.data[res.data.length - 1].id;
    }
    return { disputes, truncated: true };
  }

  async listEarlyFraudWarningsSince(
    createdGte: number,
    maxPages = 20
  ): Promise<{ efws: Stripe.Radar.EarlyFraudWarning[]; truncated: boolean }> {
    const efws: Stripe.Radar.EarlyFraudWarning[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.stripe.radar.earlyFraudWarnings.list({
        limit: 100,
        created: { gte: createdGte },
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      efws.push(...res.data);
      if (!res.has_more || res.data.length === 0) return { efws, truncated: false };
      startingAfter = res.data[res.data.length - 1].id;
    }
    return { efws, truncated: true };
  }

  // Screenshot/PDF proof for the bank: uploads via the Files API with the
  // dispute_evidence purpose. The returned file id goes into one of the
  // dispute's FILE evidence slots (receipt, customer_communication, …) via
  // updateDisputeEvidence. dispute_evidence accepts PDF/JPEG/PNG; callers
  // validate type/size (combined evidence is capped by Stripe at ~4.5MB).
  async uploadDisputeEvidenceFile(name: string, data: Buffer, contentType: string): Promise<Stripe.File> {
    return this.stripe.files.create({
      purpose: "dispute_evidence",
      file: { data, name, type: contentType },
    });
  }

  // Read a staged evidence file back for the AI review: the file object's
  // `url` points at files.stripe.com/…/contents, which serves the bytes to the
  // owning account's secret key. Files that can't go to the model (unsupported
  // type, oversized, Dashboard-uploaded formats) come back with data:null and
  // a skipped reason instead of throwing, so one bad file never sinks the
  // whole review.
  async getEvidenceFileWithContents(
    fileId: string,
    maxBytes: number
  ): Promise<{
    filename: string;
    sizeBytes: number;
    mimeType: "image/png" | "image/jpeg" | "application/pdf" | null;
    data: Buffer | null;
    skipped: "unsupported_type" | "too_large" | "no_url" | null;
  }> {
    const file = await this.stripe.files.retrieve(fileId);
    const filename = file.filename ?? fileId;
    const mimeType =
      file.type === "pdf"
        ? ("application/pdf" as const)
        : file.type === "png"
          ? ("image/png" as const)
          : file.type === "jpg" || file.type === "jpeg"
            ? ("image/jpeg" as const)
            : null;
    if (!mimeType) return { filename, sizeBytes: file.size, mimeType, data: null, skipped: "unsupported_type" };
    if (file.size > maxBytes) return { filename, sizeBytes: file.size, mimeType, data: null, skipped: "too_large" };
    if (!file.url) return { filename, sizeBytes: file.size, mimeType, data: null, skipped: "no_url" };
    // Assert the host before attaching the full-access secret key: safeFetch
    // refuses anything but files.stripe.com (and blocks redirect-to-internal),
    // so the Bearer credential can never leak to a third-party host.
    const res = await safeFetch(file.url, {
      allowHosts: ["files.stripe.com"],
      headers: { Authorization: `Bearer ${this.resolveKey()}` },
    });
    if (!res.ok) throw new Error(`Stripe file contents download failed (${res.status}) for ${fileId}`);
    return { filename, sizeBytes: file.size, mimeType, data: Buffer.from(await res.arrayBuffer()), skipped: null };
  }

  // Receipt PDF for a charge (auto-attached as dispute evidence). Subscription
  // charges carry an invoice whose `invoice_pdf` URL is documented and public
  // (tokenized); one-off charges only have the hosted receipt page, whose
  // "/pdf" variant is undocumented-but-longstanding — hence the %PDF magic-byte
  // check, so an HTML page never gets uploaded as evidence. Null = no receipt
  // obtainable; callers treat that as "skip", not an error.
  async downloadChargeReceiptPdf(chargeId: string, maxBytes: number): Promise<Buffer | null> {
    const charge = (await this.stripe.charges.retrieve(chargeId)) as ChargeWithInvoice;
    const urls: string[] = [];
    const invoiceId = typeof charge.invoice === "string" ? charge.invoice : (charge.invoice?.id ?? null);
    if (invoiceId) {
      const invoice = await this.stripe.invoices.retrieve(invoiceId).catch(() => null);
      if (invoice?.invoice_pdf) urls.push(invoice.invoice_pdf);
    }
    if (charge.receipt_url) urls.push(`${charge.receipt_url.split("?")[0].replace(/\/+$/, "")}/pdf`);
    for (const url of urls) {
      try {
        // Stripe-hosted URLs only; redirect:manual so a tokenized link can't be
        // bounced to an internal address. No credential attached.
        const res = await safeFetch(url, { allowHosts: [".stripe.com"] });
        if (!res.ok) continue;
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length === 0 || data.length > maxBytes) continue;
        if (!data.subarray(0, 5).toString("latin1").startsWith("%PDF")) continue;
        return data;
      } catch {
        // try the next source
      }
    }
    return null;
  }

  // Stripe's `submit` param defaults to TRUE — this wrapper makes it mandatory
  // so a draft save can never accidentally submit to the bank. submit:false
  // stages evidence server-side; submit:true sends it (usually once, ever).
  async updateDisputeEvidence(
    disputeId: string,
    evidence: Stripe.DisputeUpdateParams.Evidence,
    submit: boolean,
    idempotencyKey: string
  ): Promise<Stripe.Dispute> {
    return this.stripe.disputes.update(disputeId, { evidence, submit }, { idempotencyKey });
  }

  // Accept the dispute: irreversible, status becomes lost.
  async closeDispute(disputeId: string, idempotencyKey: string): Promise<Stripe.Dispute> {
    return this.stripe.disputes.close(disputeId, {}, { idempotencyKey });
  }

  // ---- search counts (list count-cards) ----
  // Lists never expose totals, so window-derived chip counts silently cap at
  // the fetch window. Search total_count is exact up to Stripe's 10k cap —
  // plenty for a UI chip (render "10,000+" at the cap; the ratio engine's
  // countWithSearchCap handles beyond-cap exactness where it matters). The
  // 30s cache absorbs filter clicks and pagination re-renders. Queries are
  // BUILT BY CALLERS from validated values only — never raw user input.
  private searchCountCache = new Map<string, { at: number; value: number }>();

  async countBySearch(
    kind: "charges" | "paymentIntents" | "invoices" | "subscriptions",
    query: string
  ): Promise<number> {
    const cacheKey = `${kind}:${query}`;
    const hit = this.searchCountCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const params = { query, limit: 1 as const, expand: ["total_count"] };
    const res =
      kind === "charges"
        ? await this.stripe.charges.search(params)
        : kind === "paymentIntents"
          ? await this.stripe.paymentIntents.search(params)
          : kind === "invoices"
            ? await this.stripe.invoices.search(params)
            : await this.stripe.subscriptions.search(params);
    const value = (res as { total_count?: number }).total_count ?? 0;
    if (this.searchCountCache.size > 500) this.searchCountCache.clear();
    this.searchCountCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  // Count of succeeded charges in [createdGte, createdLt) — the dispute-ratio
  // denominator. Search exposes total_count (lists don't) but CAPS it at
  // 10,000, so busy windows are counted in recursively-split time slices
  // (countWithSearchCap) — exact at any realistic volume for a few extra
  // requests. Search freshness lags up to ~1 minute; callers cache results.
  async countSucceededCharges(createdGte: number, createdLt?: number): Promise<number> {
    const lt = Math.floor(createdLt ?? Date.now() / 1000 + 60);
    return countWithSearchCap(
      async (gte, sliceLt) => {
        const res = await this.stripe.charges.search({
          query: `created>=${Math.floor(gte)} AND created<${Math.floor(sliceLt)} AND status:"succeeded"`,
          limit: 1,
          expand: ["total_count"],
        });
        return res.total_count ?? 0;
      },
      Math.floor(createdGte),
      lt
    );
  }

  // Blockable identifiers derivable from a charge. The payment's client IP is
  // NOT exposed by any Stripe API object — IP blocks stay manual entry.
  async getChargeBlockIdentifiers(chargeId: string): Promise<{
    customerId: string | null;
    email: string | null;
    cardFingerprint: string | null;
  }> {
    const charge = await this.stripe.charges.retrieve(chargeId, { expand: ["customer"] });
    const customer = charge.customer;
    const customerId = typeof customer === "string" ? customer : (customer?.id ?? null);
    const customerEmail =
      customer && typeof customer !== "string" && !customer.deleted ? (customer.email ?? null) : null;
    return {
      customerId,
      email: charge.billing_details?.email ?? charge.receipt_email ?? customerEmail,
      cardFingerprint: charge.payment_method_details?.card?.fingerprint ?? null,
    };
  }

  // Blocking a customer wants ALL their subscriptions gone — unlike
  // cancelSoleActiveSubscription's refuse-on-ambiguity, which protects the
  // self-service flow. A cancel that races an already-finished cancel counts
  // as success: the end state is what matters.
  async cancelAllActiveSubscriptions(
    customerId: string,
    idempotencyKeyPrefix: string
  ): Promise<{ cancelled: string[]; failed: string[] }> {
    const subs = await this.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    const cancelled: string[] = [];
    const failed: string[] = [];
    for (const sub of subs.data.filter((s) => s.status !== "canceled")) {
      try {
        await this.stripe.subscriptions.cancel(sub.id, {}, { idempotencyKey: `${idempotencyKeyPrefix}-${sub.id}` });
        cancelled.push(sub.id);
      } catch {
        try {
          const fresh = await this.stripe.subscriptions.retrieve(sub.id);
          if (fresh.status === "canceled") {
            cancelled.push(sub.id);
            continue;
          }
        } catch {
          // fall through to failed
        }
        failed.push(sub.id);
      }
    }
    return { cancelled, failed };
  }

  // ---- Radar value lists (the Stripe half of the blocklist) ----
  // A value list only blocks payments once a Dashboard-authored Radar rule
  // references it (there is no Rules API; custom rules need Radar for Fraud Teams).

  async findValueListByAlias(alias: string): Promise<Stripe.Radar.ValueList | null> {
    const res = await this.stripe.radar.valueLists.list({ alias, limit: 1 });
    return res.data[0] ?? null;
  }

  async createValueList(
    alias: string,
    name: string,
    itemType: Stripe.Radar.ValueListCreateParams.ItemType,
    idempotencyKey: string
  ): Promise<Stripe.Radar.ValueList> {
    return this.stripe.radar.valueLists.create({ alias, name, item_type: itemType }, { idempotencyKey });
  }

  // The `value` filter is an "is like" match — exact equality is re-checked here.
  async findValueListItem(valueListId: string, value: string): Promise<Stripe.Radar.ValueListItem | null> {
    const res = await this.stripe.radar.valueListItems.list({ value_list: valueListId, value, limit: 100 });
    return res.data.find((i) => i.value === value) ?? null;
  }

  async addValueListItem(
    valueListId: string,
    value: string,
    idempotencyKey: string
  ): Promise<Stripe.Radar.ValueListItem> {
    return this.stripe.radar.valueListItems.create({ value_list: valueListId, value }, { idempotencyKey });
  }

  async deleteValueListItem(itemId: string): Promise<void> {
    await this.stripe.radar.valueListItems.del(itemId);
  }

  async listValueListItems(valueListId: string, limit = 100): Promise<Stripe.Radar.ValueListItem[]> {
    const res = await this.stripe.radar.valueListItems.list({ value_list: valueListId, limit });
    return res.data;
  }

  async listTaxIds(customerId: string): Promise<Stripe.TaxId[]> {
    const res = await this.stripe.customers.listTaxIds(customerId, { limit: 100 });
    return res.data;
  }

  // Our OWN platform account (no id = the account the secret key belongs to).
  async getAccount(): Promise<Stripe.Account> {
    return this.stripe.accounts.retrieve();
  }

  // Payout schedule on our OWN account. ⚠ accounts.update may be
  // Connect-only for some account types — best-effort by design: callers map
  // Stripe's refusal to a friendly error; the read path stays correct.
  async updatePayoutSchedule(schedule: {
    interval: "manual" | "daily" | "weekly" | "monthly";
    weeklyAnchor?: string;
    monthlyAnchor?: number;
    delayDays?: number;
  }): Promise<Stripe.Account> {
    const account = await this.getAccount();
    return this.stripe.accounts.update(account.id, {
      settings: {
        payouts: {
          schedule: {
            interval: schedule.interval,
            ...(schedule.weeklyAnchor
              ? { weekly_anchor: schedule.weeklyAnchor as Stripe.AccountUpdateParams.Settings.Payouts.Schedule.WeeklyAnchor }
              : {}),
            ...(schedule.monthlyAnchor != null ? { monthly_anchor: schedule.monthlyAnchor } : {}),
            ...(schedule.delayDays != null ? { delay_days: schedule.delayDays } : {}),
          },
        },
      },
    });
  }

  // Bank-transfer funds a customer has sent that await reconciliation onto
  // invoices. null on error — most customers have no cash balance object.
  async getCashBalance(customerId: string): Promise<Stripe.CashBalance | null> {
    return this.stripe.customers.retrieveCashBalance(customerId).catch(() => null);
  }

  // Account-level tax IDs (the VAT etc. displayed on our invoices) — distinct
  // from customer tax IDs and from the write-only onboarding company tax_id.
  async listAccountTaxIds(): Promise<Stripe.TaxId[]> {
    const res = await this.stripe.taxIds.list({ limit: 100 });
    return res.data;
  }

  // ---- Billing admin panel (/billing) writes ----

  // Omitted amount = Stripe refunds the full remaining un-refunded amount.
  // reason "fraudulent" additionally puts the card + email on Stripe's native
  // block lists — the refund-to-prevent flow offers it for fraud EFWs/inquiries.
  async refundChargeAmount(
    chargeId: string,
    amountMinor: number | null,
    idempotencyKey: string,
    reason?: Stripe.RefundCreateParams.Reason
  ): Promise<{ refundId: string; amount: number; currency: string; status: string | null }> {
    const refund = await this.stripe.refunds.create(
      {
        charge: chargeId,
        ...(amountMinor != null ? { amount: amountMinor } : {}),
        ...(reason ? { reason } : {}),
      },
      { idempotencyKey }
    );
    return { refundId: refund.id, amount: refund.amount, currency: refund.currency, status: refund.status };
  }

  // Only valid while the PaymentIntent is in a cancelable status
  // (requires_payment_method / requires_confirmation / requires_action / processing).
  // Capture an authorized (requires_capture) payment. Partial captures
  // release the uncaptured remainder back to the customer (Stripe default).
  async capturePaymentIntent(
    paymentIntentId: string,
    amountMinor?: number,
    idempotencyKey?: string
  ): Promise<Stripe.PaymentIntent> {
    return this.stripe.paymentIntents.capture(
      paymentIntentId,
      amountMinor != null ? { amount_to_capture: amountMinor } : {},
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

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
    params: {
      coupon: string;
      code?: string;
      maxRedemptions?: number;
      expiresAt?: number;
      minimumAmountMinor?: number;
      minimumAmountCurrency?: string;
      firstTimeTransaction?: boolean;
      customerId?: string;
    },
    idempotencyKey: string
  ): Promise<Stripe.PromotionCode> {
    return this.stripe.promotionCodes.create(
      {
        promotion: { type: "coupon", coupon: params.coupon },
        ...(params.code ? { code: params.code } : {}),
        ...(params.maxRedemptions ? { max_redemptions: params.maxRedemptions } : {}),
        ...(params.expiresAt ? { expires_at: params.expiresAt } : {}),
        ...(params.customerId ? { customer: params.customerId } : {}),
        ...(params.minimumAmountMinor != null || params.firstTimeTransaction
          ? {
              restrictions: {
                ...(params.minimumAmountMinor != null
                  ? { minimum_amount: params.minimumAmountMinor, minimum_amount_currency: params.minimumAmountCurrency }
                  : {}),
                ...(params.firstTimeTransaction ? { first_time_transaction: true } : {}),
              },
            }
          : {}),
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
      maxRedemptions?: number;
      redeemByUnix?: number;
      appliesToProducts?: string[];
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
        ...(params.maxRedemptions ? { max_redemptions: params.maxRedemptions } : {}),
        ...(params.redeemByUnix ? { redeem_by: params.redeemByUnix } : {}),
        ...(params.appliesToProducts?.length ? { applies_to: { products: params.appliesToProducts } } : {}),
      },
      { idempotencyKey }
    );
  }

  // Deleting a coupon does not affect subscriptions it is already applied to.
  async deleteCoupon(couponId: string): Promise<void> {
    await this.stripe.coupons.del(couponId);
  }

  // ---- payment links ----

  // line_items are expanded so the list can show what each link sells
  // without N+1 reads.
  async listPaymentLinks(
    opts: { limit?: number; startingAfter?: string } = {}
  ): Promise<{ links: Stripe.PaymentLink[]; hasMore: boolean }> {
    const res = await this.stripe.paymentLinks.list({
      limit: opts.limit ?? 25,
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
      expand: ["data.line_items"],
    });
    return { links: res.data, hasMore: res.has_more };
  }

  async getPaymentLink(paymentLinkId: string): Promise<Stripe.PaymentLink> {
    return this.stripe.paymentLinks.retrieve(paymentLinkId, { expand: ["line_items"] });
  }

  async createPaymentLink(
    params: { priceId: string; quantity: number; adjustableQuantity?: boolean },
    idempotencyKey: string
  ): Promise<Stripe.PaymentLink> {
    return this.stripe.paymentLinks.create(
      {
        line_items: [
          {
            price: params.priceId,
            quantity: params.quantity,
            ...(params.adjustableQuantity ? { adjustable_quantity: { enabled: true, minimum: 1 } } : {}),
          },
        ],
      },
      { idempotencyKey }
    );
  }

  // Payment links can't be deleted — deactivation kills the URL (and
  // reactivation revives the same URL).
  async setPaymentLinkActive(paymentLinkId: string, active: boolean): Promise<Stripe.PaymentLink> {
    return this.stripe.paymentLinks.update(paymentLinkId, { active });
  }

  // ---- checkout sessions: read-only browse on the Links page ----

  async listCheckoutSessions(opts: {
    limit?: number;
    status?: "open" | "complete" | "expired";
    startingAfter?: string;
  }): Promise<{ sessions: Stripe.Checkout.Session[]; hasMore: boolean }> {
    const res = await this.stripe.checkout.sessions.list({
      limit: opts.limit ?? 25,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
    });
    return { sessions: res.data, hasMore: res.has_more };
  }

  // ---- tax rates ----

  async listTaxRates(limit = 25): Promise<Stripe.TaxRate[]> {
    const res = await this.stripe.taxRates.list({ limit });
    return res.data;
  }

  async createTaxRate(
    params: { displayName: string; percentage: number; inclusive: boolean; country?: string; description?: string },
    idempotencyKey: string
  ): Promise<Stripe.TaxRate> {
    return this.stripe.taxRates.create(
      {
        display_name: params.displayName,
        percentage: params.percentage,
        inclusive: params.inclusive,
        ...(params.country ? { country: params.country } : {}),
        ...(params.description ? { description: params.description } : {}),
      },
      { idempotencyKey }
    );
  }

  // Tax rates can't be deleted — archiving (active:false) hides them from new
  // use; already-attached invoices/subscriptions keep them.
  async setTaxRateActive(taxRateId: string, active: boolean): Promise<Stripe.TaxRate> {
    return this.stripe.taxRates.update(taxRateId, { active });
  }

  // ---- shipping rates: fixed-amount rates, 5th Catalog tab ----

  async listShippingRates(limit = 25): Promise<Stripe.ShippingRate[]> {
    const res = await this.stripe.shippingRates.list({ limit });
    return res.data;
  }

  async createShippingRate(
    params: {
      displayName: string;
      amountMinor: number;
      currency: string;
      taxBehavior?: "inclusive" | "exclusive" | "unspecified";
    },
    idempotencyKey: string
  ): Promise<Stripe.ShippingRate> {
    return this.stripe.shippingRates.create(
      {
        display_name: params.displayName,
        type: "fixed_amount",
        fixed_amount: { amount: params.amountMinor, currency: params.currency },
        ...(params.taxBehavior ? { tax_behavior: params.taxBehavior } : {}),
      },
      { idempotencyKey }
    );
  }

  // Shipping rates can't be deleted — archiving (active:false) hides them
  // from new checkouts; existing sessions keep them.
  async setShippingRateActive(shippingRateId: string, active: boolean): Promise<Stripe.ShippingRate> {
    return this.stripe.shippingRates.update(shippingRateId, { active });
  }

  // ---- quotes ----

  // data.customer is expanded so the list can show a name/email instead of a
  // raw cus_ id without N+1 reads.
  async listQuotes(
    opts: { limit?: number; startingAfter?: string } = {}
  ): Promise<{ quotes: Stripe.Quote[]; hasMore: boolean }> {
    const res = await this.stripe.quotes.list({
      limit: opts.limit ?? 25,
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
      expand: ["data.customer"],
    });
    return { quotes: res.data, hasMore: res.has_more };
  }

  async getQuote(quoteId: string): Promise<Stripe.Quote> {
    return this.stripe.quotes.retrieve(quoteId, { expand: ["line_items", "customer"] });
  }

  // Minimal draft-quote composer: one price for one customer. Richer quotes
  // (multi-line, discounts, headers) stay in the real Stripe dashboard.
  async createQuote(
    params: { customerId: string; priceId: string; quantity: number },
    idempotencyKey: string
  ): Promise<Stripe.Quote> {
    return this.stripe.quotes.create(
      {
        customer: params.customerId,
        line_items: [{ price: params.priceId, quantity: params.quantity }],
      },
      { idempotencyKey }
    );
  }

  // draft → open: assigns the quote number and makes it acceptable.
  async finalizeQuote(quoteId: string, idempotencyKey?: string): Promise<Stripe.Quote> {
    return this.stripe.quotes.finalizeQuote(quoteId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  async cancelQuote(quoteId: string, idempotencyKey?: string): Promise<Stripe.Quote> {
    return this.stripe.quotes.cancel(quoteId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  // Accepting mints the subscription/invoice the quote describes.
  async acceptQuote(quoteId: string, idempotencyKey?: string): Promise<Stripe.Quote> {
    return this.stripe.quotes.accept(quoteId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  // Quote PDF: the API returns a STREAM, not a File object — fileLinks
  // can't mint URLs for it, so the bytes ride the dashboard's JSON channel as
  // b64. Size-capped accumulation + the %PDF magic-byte check (receipt-PDF
  // idiom) so an error page never gets served as a download. Null = no PDF
  // obtainable within the cap.
  async getQuotePdf(quoteId: string, maxBytes: number): Promise<Buffer | null> {
    const stream = (await this.stripe.quotes.pdf(quoteId)) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
    const data = await new Promise<Buffer | null>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          if (stream.destroy) stream.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
    if (!data || data.length === 0) return null;
    if (!data.subarray(0, 5).toString("latin1").startsWith("%PDF")) return null;
    return data;
  }

  // ---- usage meters ----

  async listMeters(limit = 25): Promise<Stripe.Billing.Meter[]> {
    const res = await this.stripe.billing.meters.list({ limit });
    return res.data;
  }

  async getMeter(meterId: string): Promise<Stripe.Billing.Meter> {
    return this.stripe.billing.meters.retrieve(meterId);
  }

  // Minimal meter create: Stripe defaults the customer mapping to the
  // stripe_customer_id payload key and (for sum) the value key to "value".
  async createMeter(
    params: { displayName: string; eventName: string; formula: "count" | "sum" | "last" },
    idempotencyKey: string
  ): Promise<Stripe.Billing.Meter> {
    return this.stripe.billing.meters.create(
      {
        display_name: params.displayName,
        event_name: params.eventName,
        default_aggregation: { formula: params.formula },
      },
      { idempotencyKey }
    );
  }

  // Meters can't be deleted — deactivating stops event ingestion (and blocks
  // attaching the meter to new prices) until reactivated.
  async setMeterActive(meterId: string, active: boolean): Promise<Stripe.Billing.Meter> {
    return active
      ? this.stripe.billing.meters.reactivate(meterId, {})
      : this.stripe.billing.meters.deactivate(meterId, {});
  }

  // Stripe scopes meter event summaries to ONE customer; start/end must align
  // with hour/day boundaries matching the grouping window.
  async listMeterEventSummaries(
    meterId: string,
    params: { customerId: string; startTime: number; endTime: number; granularity: "hour" | "day" }
  ): Promise<Stripe.Billing.MeterEventSummary[]> {
    const res = await this.stripe.billing.meters.listEventSummaries(meterId, {
      customer: params.customerId,
      start_time: params.startTime,
      end_time: params.endTime,
      value_grouping_window: params.granularity,
      limit: 100,
    });
    return res.data;
  }

  // ---- credit grants ----

  async listCreditGrants(customerId: string, limit = 25): Promise<Stripe.Billing.CreditGrant[]> {
    const res = await this.stripe.billing.creditGrants.list({ customer: customerId, limit });
    return res.data;
  }

  async getCreditGrant(creditGrantId: string): Promise<Stripe.Billing.CreditGrant> {
    return this.stripe.billing.creditGrants.retrieve(creditGrantId);
  }

  // Monetary credits against METERED usage (Stripe currently supports only
  // metered prices as the applicability scope). No expiry unless given.
  async createCreditGrant(
    params: { customerId: string; amountMinor: number; currency: string; name?: string; category: "paid" | "promotional"; expiresAt?: number },
    idempotencyKey: string
  ): Promise<Stripe.Billing.CreditGrant> {
    return this.stripe.billing.creditGrants.create(
      {
        customer: params.customerId,
        amount: { type: "monetary", monetary: { value: params.amountMinor, currency: params.currency } },
        applicability_config: { scope: { price_type: "metered" } },
        category: params.category,
        ...(params.name ? { name: params.name } : {}),
        ...(params.expiresAt ? { expires_at: params.expiresAt } : {}),
      },
      { idempotencyKey }
    );
  }

  // Voiding zeroes the remaining credit; already-applied credit stays applied.
  async voidCreditGrant(creditGrantId: string, idempotencyKey?: string): Promise<Stripe.Billing.CreditGrant> {
    return this.stripe.billing.creditGrants.voidGrant(creditGrantId, {}, idempotencyKey ? { idempotencyKey } : undefined);
  }

  // Product catalog (read-only surface for the dashboard). default_price is
  // expanded so list rows can show the headline price without N+1 reads.
  async listProducts(opts: { limit?: number; startingAfter?: string } = {}): Promise<{ products: Stripe.Product[]; hasMore: boolean }> {
    const res = await this.stripe.products.list({
      limit: opts.limit ?? 25,
      expand: ["data.default_price"],
      ...(opts.startingAfter ? { starting_after: opts.startingAfter } : {}),
    });
    return { products: res.data, hasMore: res.has_more };
  }

  async listPricesForProduct(productId: string, limit = 50): Promise<Stripe.Price[]> {
    const res = await this.stripe.prices.list({ product: productId, limit });
    return res.data;
  }

  async getProduct(productId: string): Promise<Stripe.Product> {
    return this.stripe.products.retrieve(productId);
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  // Attach an existing (floating) PaymentMethod to a customer. PMs created via
  // Elements/API/token float free until attached; Stripe rejects the attach if
  // the PM already belongs to a different customer.
  async attachPaymentMethod(paymentMethodId: string, customerId: string): Promise<Stripe.PaymentMethod> {
    return this.stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
  }

  // Server-side PM creation from a card TOKEN (tok_…) — raw card numbers never
  // touch this server; tokens come from Stripe.js or test fixtures.
  async createPaymentMethodFromToken(token: string, idempotencyKey?: string): Promise<Stripe.PaymentMethod> {
    return this.stripe.paymentMethods.create(
      { type: "card", card: { token } },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // Off-session SetupIntent for saving a card without charging it. The
  // client_secret is deliberately never surfaced in panels — it is only useful
  // to a Stripe.js confirm flow on the customer's device.
  async createSetupIntent(
    params: { customerId: string; paymentMethodId?: string },
    idempotencyKey?: string
  ): Promise<Stripe.SetupIntent> {
    return this.stripe.setupIntents.create(
      {
        customer: params.customerId,
        usage: "off_session",
        ...(params.paymentMethodId ? { payment_method: params.paymentMethodId } : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
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

  // Hard end at an absolute moment. Unlike cancel_at_period_end this can land
  // mid-period (Stripe does NOT prorate or refund the unused part) and it
  // overrides a running trial, which is the point: a trial nobody paid for can
  // be given a fixed expiry date.
  async setSubscriptionCancelAt(
    subscriptionId: string,
    cancelAtUnix: number,
    idempotencyKey?: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      subscriptionId,
      { cancel_at: cancelAtUnix },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // Clears BOTH scheduled-cancel mechanisms — a sub can carry cancel_at and
  // cancel_at_period_end independently, so an undo that only cleared one would
  // silently leave the other armed.
  async clearScheduledCancel(subscriptionId: string, idempotencyKey?: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      subscriptionId,
      { cancel_at: null, cancel_at_period_end: false },
      idempotencyKey ? { idempotencyKey } : undefined
    );
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

  // customerId null = ACCOUNT-WIDE listing (dashboard Invoices page).
  async listInvoicesByStatus(
    customerId: string | null,
    status: Stripe.Invoice.Status | undefined,
    limit = 10,
    startingAfter?: string,
    // Filter expansion: these are all SERVER-side invoices.list params.
    opts: {
      collectionMethod?: "charge_automatically" | "send_invoice";
      subscriptionId?: string;
      createdGte?: number;
      createdLt?: number;
    } = {}
  ): Promise<Stripe.ApiList<Stripe.Invoice>> {
    const created = {
      ...(opts.createdGte ? { gte: opts.createdGte } : {}),
      ...(opts.createdLt ? { lt: opts.createdLt } : {}),
    };
    return this.stripe.invoices.list({
      ...(customerId ? { customer: customerId } : {}),
      ...(status ? { status } : {}),
      ...(opts.collectionMethod ? { collection_method: opts.collectionMethod } : {}),
      ...(opts.subscriptionId ? { subscription: opts.subscriptionId } : {}),
      ...(Object.keys(created).length ? { created } : {}),
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
    quantity?: number;
    billingCycleAnchor?: "now" | "unchanged";
  }): Promise<Stripe.Invoice> {
    return this.stripe.invoices.createPreview({
      customer: params.customerId,
      subscription: params.subscriptionId,
      subscription_details: {
        items: [{ id: params.itemId, price: params.priceId, ...(params.quantity ? { quantity: params.quantity } : {}) }],
        proration_behavior: "create_prorations",
        proration_date: params.prorationDate,
        ...(params.billingCycleAnchor === "now" ? { billing_cycle_anchor: "now" as const } : {}),
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

  // Items WITHOUT an id are ADDED to the subscription (grow).
  async addSubscriptionItem(
    params: { subscriptionId: string; priceId: string; quantity?: number; prorationBehavior: "create_prorations" | "none" },
    idempotencyKey?: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      params.subscriptionId,
      {
        items: [{ price: params.priceId, ...(params.quantity ? { quantity: params.quantity } : {}) }],
        proration_behavior: params.prorationBehavior,
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // deleted:true removes the item (shrink) — Stripe refuses on the last one.
  async removeSubscriptionItem(
    params: { subscriptionId: string; itemId: string; prorationBehavior: "create_prorations" | "none" },
    idempotencyKey?: string
  ): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.update(
      params.subscriptionId,
      { items: [{ id: params.itemId, deleted: true }], proration_behavior: params.prorationBehavior },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // Generic proration preview over an item change-set (add = {price}, remove =
  // {id, deleted}) — the add/remove twin of previewPlanChange.
  async previewItemsChange(params: {
    customerId: string;
    subscriptionId: string;
    items: Array<{ id?: string; price?: string; quantity?: number; deleted?: boolean }>;
    prorationDate: number;
  }): Promise<Stripe.Invoice> {
    return this.stripe.invoices.createPreview({
      customer: params.customerId,
      subscription: params.subscriptionId,
      subscription_details: {
        items: params.items,
        proration_behavior: "create_prorations",
        proration_date: params.prorationDate,
      },
    });
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

  // ---- full-phase schedule editor ----

  // Replace the schedule's phases wholesale. Callers pass the REBUILT current
  // phase first (rebuildCurrentPhase) — the update API only accepts
  // param-shaped phases and refuses overlapping/omitted current phases.
  async updateSchedulePhases(
    scheduleId: string,
    params: { phases: Stripe.SubscriptionScheduleUpdateParams.Phase[]; endBehavior: "release" | "cancel" },
    idempotencyKey?: string
  ): Promise<Stripe.SubscriptionSchedule> {
    return this.stripe.subscriptionSchedules.update(
      scheduleId,
      { phases: params.phases, end_behavior: params.endBehavior },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  // CANCELS THE SUBSCRIPTION TOO — Stripe semantics; callers must ceremony
  // this like a subscription cancellation (T2 in the dashboard).
  async cancelSchedule(scheduleId: string, idempotencyKey?: string): Promise<Stripe.SubscriptionSchedule> {
    return this.stripe.subscriptionSchedules.cancel(scheduleId, {}, idempotencyKey ? { idempotencyKey } : undefined);
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
  // ---- draft-invoice editor ----
  // invoiceItems.list is the source of truth for EDITABLE rows on a one-off
  // draft — never map Basil invoice.lines back to ii_ ids (fragile parent
  // indirection). Subscription-cycle drafts have no invoiceitems and are not
  // editable here.

  async listInvoiceItems(invoiceId: string): Promise<Stripe.InvoiceItem[]> {
    const res = await this.stripe.invoiceItems.list({ invoice: invoiceId, limit: 50 });
    return res.data;
  }

  async updateInvoiceItem(
    itemId: string,
    params: { amountMinor?: number; quantity?: number; description?: string },
    idempotencyKey?: string
  ): Promise<Stripe.InvoiceItem> {
    return this.stripe.invoiceItems.update(
      itemId,
      {
        ...(params.amountMinor != null ? { amount: params.amountMinor } : {}),
        ...(params.quantity != null ? { quantity: params.quantity } : {}),
        ...(params.description != null ? { description: params.description } : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

  async getInvoiceItem(itemId: string): Promise<Stripe.InvoiceItem> {
    return this.stripe.invoiceItems.retrieve(itemId);
  }

  async deleteInvoiceItem(itemId: string): Promise<void> {
    await this.stripe.invoiceItems.del(itemId);
  }

  // Draft-only metadata/memo/footer/due-date edits ("description" is the memo
  // shown above the line items on the hosted invoice).
  async updateInvoiceDetails(
    invoiceId: string,
    params: { dueDateUnix?: number; memo?: string | null; footer?: string | null; metadata?: Stripe.Emptyable<Stripe.MetadataParam> },
    idempotencyKey?: string
  ): Promise<Stripe.Invoice> {
    return this.stripe.invoices.update(
      invoiceId,
      {
        ...(params.dueDateUnix != null ? { due_date: params.dueDateUnix } : {}),
        ...(params.memo !== undefined ? { description: params.memo ?? "" } : {}),
        ...(params.footer !== undefined ? { footer: params.footer ?? "" } : {}),
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
  }

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

  // ---- reporting: report runs + short-lived file links ----

  async listReportRuns(limit = 25): Promise<Stripe.Reporting.ReportRun[]> {
    const res = await this.stripe.reporting.reportRuns.list({ limit });
    return res.data;
  }

  async getReportRun(runId: string): Promise<Stripe.Reporting.ReportRun> {
    return this.stripe.reporting.reportRuns.retrieve(runId);
  }

  // Report types are free strings in the SDK; per-account availability is
  // validated by Stripe at create time — callers map those errors to friendly
  // text. Runs execute asynchronously.
  async createReportRun(
    reportType: string,
    params: { intervalStart?: number; intervalEnd?: number },
    idempotencyKey: string
  ): Promise<Stripe.Reporting.ReportRun> {
    const interval = {
      ...(params.intervalStart ? { interval_start: params.intervalStart } : {}),
      ...(params.intervalEnd ? { interval_end: params.intervalEnd } : {}),
    };
    return this.stripe.reporting.reportRuns.create(
      {
        report_type: reportType,
        ...(Object.keys(interval).length ? { parameters: interval } : {}),
      },
      { idempotencyKey }
    );
  }

  // Mints a tokenized, expiring public URL onto a Stripe File (report
  // results are real Files — unlike quote PDFs, which are streams).
  async createFileLink(fileId: string, expiresAt: number): Promise<Stripe.FileLink> {
    return this.stripe.fileLinks.create({ file: fileId, expires_at: expiresAt });
  }

  // ---- test clocks (test mode only — the "Run simulation" affordance) ----

  async getTestClock(clockId: string): Promise<Stripe.TestHelpers.TestClock> {
    return this.stripe.testHelpers.testClocks.retrieve(clockId);
  }

  // frozenTime must be >= the clock's current frozen_time; Stripe replays all
  // billing activity (renewals, invoices, dunning) up to the new time.
  async advanceTestClock(clockId: string, frozenTime: number): Promise<Stripe.TestHelpers.TestClock> {
    return this.stripe.testHelpers.testClocks.advance(clockId, { frozen_time: frozenTime });
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

// Rebuild a schedule's CURRENT phase (phase 0) into the param shape the
// update API accepts, preserving trial_end and coupon-backed discounts (the
// response-only fields the older scheduleNextPhasePlan rebuild dropped).
// Anything that cannot be re-sent faithfully lands in `unsupported` — callers
// must refuse rather than silently drop it.
export function rebuildCurrentPhase(schedule: Stripe.SubscriptionSchedule): {
  phase: Stripe.SubscriptionScheduleUpdateParams.Phase;
  unsupported: string[];
} {
  const current = schedule.phases[0];
  const unsupported: string[] = [];
  const discounts: Array<{ coupon: string }> = [];
  for (const d of current.discounts ?? []) {
    const coupon = typeof d.coupon === "string" ? d.coupon : d.coupon?.id ?? null;
    if (coupon) discounts.push({ coupon });
    else unsupported.push("a phase discount without a resolvable coupon");
  }
  const items: Stripe.SubscriptionScheduleUpdateParams.Phase.Item[] = [];
  for (const item of current.items) {
    if (item.discounts?.length) unsupported.push("per-item discounts on the current phase");
    items.push({
      price: typeof item.price === "string" ? item.price : item.price.id,
      ...(item.quantity != null ? { quantity: item.quantity } : {}),
    });
  }
  if (current.default_payment_method) unsupported.push("a phase-level default payment method");
  // Phase metadata is response-only unless re-sent — dropping it here would
  // silently strip the Postiz sync keys (service/billing/period/uniqueId)
  // from the current phase on every schedule edit.
  const metadata = current.metadata && Object.keys(current.metadata).length ? current.metadata : null;
  const phase: Stripe.SubscriptionScheduleUpdateParams.Phase = {
    items,
    start_date: current.start_date,
    end_date: current.end_date,
    ...(current.trial_end ? { trial_end: current.trial_end } : {}),
    ...(discounts.length ? { discounts } : {}),
    ...(metadata ? { metadata } : {}),
  };
  return { phase, unsupported };
}
