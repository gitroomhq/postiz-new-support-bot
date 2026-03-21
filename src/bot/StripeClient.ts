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

  async applyDiscountCoupon(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, {
      discounts: [{ coupon: this.config.stripe.discountCouponId }],
    });
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

  async refundCharge(chargeId: string): Promise<{ refundId: string; amount: number; currency: string }> {
    const refund = await this.stripe.refunds.create({
      charge: chargeId,
    });

    return {
      refundId: refund.id,
      amount: refund.amount,
      currency: refund.currency,
    };
  }

  formatAmount(amount: number, currency: string): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  }
}
