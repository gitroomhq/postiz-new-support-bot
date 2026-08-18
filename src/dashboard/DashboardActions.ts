import { StripeClient } from "../bot/StripeClient";
import { SessionStore } from "../auth/SessionStore";
import {
  ActionActor,
  BillingActionService,
  RequestOutcome,
  ScopedBinding,
} from "../bot/billing/actions/BillingActionService";
import { validId } from "./sections/types";

// The dashboard→registry action gateway. The intercom panel derives its
// customer scope from the conversation link; here the scope is derived from
// the TARGET OBJECT server-side (charge/PI/subscription/invoice → .customer),
// so a hostile client can rename ids all it wants — the binding (and the
// registry's ownership revalidation) always follows the real object. The
// client-visible params only carry ids the page itself baked.
export class DashboardActionGateway {
  constructor(
    private actions: BillingActionService,
    private stripe: StripeClient,
    private sessionStore: SessionStore
  ) {}

  async request(actor: ActionActor, key: string, rawParams: Record<string, unknown>): Promise<RequestOutcome> {
    const resolved = await this.resolve(key, rawParams).catch((e) => ({
      ok: false as const,
      error: `Could not resolve the target: ${e instanceof Error ? e.message : String(e)}`,
    }));
    if (!resolved.ok) return { kind: "invalid", error: resolved.error };
    return this.actions.requestScoped(resolved.binding, actor, resolved.key, resolved.params);
  }

  // Server-side binding table (exposed for tests). May rewrite the action:
  // a full refund for a customer with no Discord link becomes a partial
  // refund of the remaining amount (the refund core tracks refunds per
  // Discord user, so refund_full is structurally Discord-linked).
  async resolve(
    key: string,
    raw: Record<string, unknown>
  ): Promise<{ ok: true; key: string; params: Record<string, unknown>; binding: ScopedBinding } | { ok: false; error: string }> {
    const params: Record<string, unknown> = { ...raw };

    switch (key) {
      case "charge.refund_full":
      case "charge.refund_partial":
      case "charge.refund_fraud": {
        const chargeId = validId("charge", params.chargeId);
        if (!chargeId) return { ok: false, error: "chargeId (ch_…) required." };
        const charge = await this.stripe.getCharge(chargeId);
        const customerId = idOf(charge.customer);
        if (!customerId) return { ok: false, error: "This charge has no customer attached." };
        // Modal inputs are in major units; convert with the charge's currency.
        if (params.amountMinor == null && typeof params.amountMajor === "number" && isFinite(params.amountMajor)) {
          const factor = StripeClient.isZeroDecimal(charge.currency) ? 1 : 100;
          params.amountMinor = Math.round(params.amountMajor * factor);
          delete params.amountMajor;
        }
        const binding = await this.bindingFor(customerId);
        if (key === "charge.refund_full" && !binding.discordCustomerId) {
          const remaining = charge.amount - (charge.amount_refunded ?? 0);
          if (remaining <= 0) return { ok: false, error: "Charge is already fully refunded." };
          return { ok: true, key: "charge.refund_partial", params: { chargeId, amountMinor: remaining }, binding };
        }
        return { ok: true, key, params, binding };
      }
      case "payment_intent.cancel":
      case "payment_intent.capture": {
        const paymentIntentId = validId("payment_intent", params.paymentIntentId);
        if (!paymentIntentId) return { ok: false, error: "paymentIntentId (pi_…) required." };
        const pi = await this.stripe.getPaymentIntent(paymentIntentId);
        const customerId = idOf(pi.customer);
        if (!customerId) return { ok: false, error: "This payment intent has no customer attached." };
        // Partial-capture modal input is in major units; convert with the
        // PI's currency (same idiom as the charge-refund conversion).
        if (key === "payment_intent.capture" && params.amountMinor == null && typeof params.amountMajor === "number" && isFinite(params.amountMajor)) {
          const factor = StripeClient.isZeroDecimal(pi.currency) ? 1 : 100;
          params.amountMinor = Math.round(params.amountMajor * factor);
          delete params.amountMajor;
        }
        return { ok: true, key, params, binding: await this.bindingFor(customerId) };
      }
      case "subscription.cancel":
      case "subscription.pause_resume":
      case "subscription.change_plan":
      case "subscription.terms":
      case "subscription.items":
      case "subscription.schedule":
      case "subscription.repair_sync":
      case "customer.coupon": {
        // coupon op:"remove" may target the CUSTOMER-level discount instead of
        // a subscription — bind via the explicit customer id then.
        if (key === "customer.coupon" && params.op === "remove" && params.subscriptionId == null) {
          const customerId = validId("customer", params.customerId);
          if (!customerId) return { ok: false, error: "customerId (cus_…) required to remove a customer-level discount." };
          return { ok: true, key, params, binding: await this.bindingFor(customerId) };
        }
        const subscriptionId = validId("subscription", params.subscriptionId);
        if (!subscriptionId) return { ok: false, error: "subscriptionId (sub_…) required." };
        // The dated-cancel modal asks for a horizon in days ("cancel it after a
        // week"); the registry only speaks absolute timestamps. Same idiom as
        // the major→minor amount conversions above. A typed unix value wins, so
        // the modal's optional override beats the day count.
        if (key === "subscription.cancel" && params.when === "at" && params.cancelAtUnix == null) {
          const days = typeof params.cancelInDays === "number" && isFinite(params.cancelInDays) ? params.cancelInDays : null;
          if (days == null || days <= 0) return { ok: false, error: "Give a positive number of days (or an explicit unix timestamp)." };
          params.cancelAtUnix = Math.floor(Date.now() / 1000) + Math.round(days * 86_400);
        }
        delete params.cancelInDays;
        const sub = await this.stripe.getSubscription(subscriptionId);
        const customerId = idOf(sub.customer);
        if (!customerId) return { ok: false, error: "This subscription has no customer attached." };
        return { ok: true, key, params, binding: await this.bindingFor(customerId) };
      }
      case "invoice.collect":
      case "invoice.finalize":
      case "invoice.void":
      case "invoice.credit_note": {
        const invoiceId = validId("invoice", params.invoiceId);
        if (!invoiceId) return { ok: false, error: "invoiceId (in_…) required." };
        const invoice = await this.stripe.getInvoice(invoiceId);
        const customerId = idOf(invoice.customer);
        if (!customerId) return { ok: false, error: "This invoice has no customer attached." };
        // Credit-note modal input is in major units; convert with the
        // invoice's currency (same idiom as the charge-refund conversion).
        if (params.amountMinor == null && typeof params.amountMajor === "number" && isFinite(params.amountMajor)) {
          const factor = StripeClient.isZeroDecimal(invoice.currency) ? 1 : 100;
          params.amountMinor = Math.round(params.amountMajor * factor);
          delete params.amountMajor;
        }
        return { ok: true, key, params, binding: await this.bindingFor(customerId) };
      }
      case "invoice.create_draft":
      case "customer.balance":
      case "customer.payment_method":
      case "customer.block":
      case "subscription.create":
      case "charge.create": {
        // Explicit-customer actions: the page bakes params.customerId; only
        // its SHAPE is trusted — the registry revalidates existence/ownership.
        const customerId = validId("customer", params.customerId);
        if (!customerId) return { ok: false, error: "customerId (cus_…) required." };
        // Charge-saved-card modal input is in major units; convert with the
        // TYPED currency — there is no target object to derive it from.
        if (key === "charge.create" && params.amountMinor == null && typeof params.amountMajor === "number" && isFinite(params.amountMajor)) {
          const currency = typeof params.currency === "string" ? params.currency.trim().toLowerCase() : "";
          if (!/^[a-z]{3}$/.test(currency)) return { ok: false, error: "A 3-letter currency is required." };
          const factor = StripeClient.isZeroDecimal(currency) ? 1 : 100;
          params.amountMinor = Math.round(params.amountMajor * factor);
          params.currency = currency;
          delete params.amountMajor;
        }
        // Balance-adjust modal collects a direction + major-unit amount; fold
        // into the registry's signed deltaMinor (credit = negative = the
        // customer owes less on future invoices).
        if (key === "customer.balance" && params.deltaMinor == null) {
          const mode = params.mode === "credit" || params.mode === "debit" ? params.mode : null;
          const amountMajor = typeof params.amountMajor === "number" && isFinite(params.amountMajor) ? params.amountMajor : null;
          const currency = typeof params.currency === "string" ? params.currency.trim().toLowerCase() : "";
          if (!mode || amountMajor == null || amountMajor <= 0 || !/^[a-z]{3}$/.test(currency)) {
            return { ok: false, error: "Pick credit/debit, a positive amount and a 3-letter currency." };
          }
          const factor = StripeClient.isZeroDecimal(currency) ? 1 : 100;
          params.deltaMinor = Math.round(amountMajor * factor) * (mode === "credit" ? -1 : 1);
          params.currency = currency;
          delete params.mode;
          delete params.amountMajor;
        }
        // The web draft builder collects ONE line item as flat modal fields;
        // fold them into the registry's items[] shape (multi-line drafts stay
        // in /billing).
        if (key === "invoice.create_draft" && !Array.isArray(params.items)) {
          const description = typeof params.description === "string" ? params.description.trim() : "";
          const currency =
            typeof params.currency === "string" && /^[A-Za-z]{3}$/.test(params.currency.trim())
              ? params.currency.trim().toLowerCase()
              : "";
          const amountMajor = typeof params.amountMajor === "number" && isFinite(params.amountMajor) ? params.amountMajor : null;
          if (!description || !currency || amountMajor == null || amountMajor <= 0) {
            return { ok: false, error: "Draft needs a description, a positive amount and a 3-letter currency." };
          }
          const factor = StripeClient.isZeroDecimal(currency) ? 1 : 100;
          params.items = [{ description, amountMinor: Math.round(amountMajor * factor), currency }];
          delete params.description;
          delete params.amountMajor;
          delete params.currency;
        }
        return { ok: true, key, params, binding: await this.bindingFor(customerId) };
      }
      case "charge_review": {
        // Bound from the PendingChargeReview row, not from a Stripe object.
        const threadId = typeof params.threadId === "string" && /^\d{5,32}$/.test(params.threadId) ? params.threadId : null;
        if (!threadId) return { ok: false, error: "threadId required." };
        const review = await this.sessionStore.getPendingChargeReview(threadId);
        if (!review) return { ok: false, error: "No pending charge review on that ticket (already resolved?)." };
        delete params.threadId;
        return {
          ok: true,
          key,
          params,
          binding: {
            stripeCustomerId: null,
            discordCustomerId: review.customerId,
            ticketThreadId: threadId,
            conversationId: null,
            origin: "dashboard",
          },
        };
      }
      default:
        return { ok: false, error: "Unknown action." };
    }
  }

  private async bindingFor(stripeCustomerId: string): Promise<ScopedBinding> {
    const discordIds = await this.sessionStore.findDiscordIdsByStripeId(stripeCustomerId).catch(() => []);
    return {
      stripeCustomerId,
      discordCustomerId: discordIds[0] ?? null,
      ticketThreadId: null,
      conversationId: null,
      origin: "dashboard",
    };
  }
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}
