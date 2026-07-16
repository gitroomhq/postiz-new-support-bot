import { StripeClient } from "../StripeClient";
import { SessionStore } from "../../auth/SessionStore";
import { log } from "../../util/logger";
import { metricCount, metricDistribution } from "../../util/instrument";
import { exportBillingEvent } from "../../metrics/MetricsExporter";
import type { TemporalProducers } from "../../temporal/producers";
import type { RefundOutcome, RefundWorkflowInput } from "../../temporal/types";

const billingLog = log.child("billing");

// The refund money-movement core, extracted from BillingCategory so the
// Intercom canvas/panel (BillingActionService) can run the exact same
// idempotent path as the Discord self-service confirm and /charge approve.
// BillingCategory delegates here; the Temporal refundWorkflow's activity body
// is executeRefundCore.
export class RefundCoreService {
  // Temporal seam: when active, the money movement runs inside the
  // refundWorkflow (workflowId refund-{chargeId} = one more idempotency layer)
  // via the executeRefundCore activity.
  private temporalProducers: TemporalProducers | null = null;

  constructor(
    private stripeClient: StripeClient,
    private sessionStore: SessionStore
  ) {}

  setTemporalProducers(producers: TemporalProducers): void {
    this.temporalProducers = producers;
  }

  // Routes the refund core through Temporal when active (null result =
  // Temporal unreachable → run in-process, exactly the legacy behavior).
  async run(input: RefundWorkflowInput): Promise<RefundOutcome> {
    if (this.temporalProducers?.enabled()) {
      const viaWorkflow = await this.temporalProducers.executeRefund(input);
      if (viaWorkflow != null) return viaWorkflow;
    }
    return this.executeRefundCore(input);
  }

  // The money movement shared by the self-service confirm, /charge approve and
  // the Intercom charge-review approve — ALSO the body of the Temporal
  // refundWorkflow's activity. Idempotency: the BillingAction unique-index
  // claim (first, before any Stripe call) and Stripe idempotency keys;
  // "money moved → lock stays" is preserved verbatim.
  async executeRefundCore(input: RefundWorkflowInput): Promise<RefundOutcome> {
    const { customerId, chargeId, subscriptionId, threadId } = input;
    // Claim the charge BEFORE calling Stripe — the unique index on the
    // billing-action row makes exactly one confirm win.
    if (!(await this.sessionStore.claimBillingAction(customerId, chargeId, "refund"))) {
      return { outcome: "already_processed" };
    }

    let refund: { refundId: string; amount: number; currency: string };
    try {
      refund = await this.stripeClient.refundCharge(chargeId, `refund-${chargeId}`);
    } catch (error) {
      billingLog.error("refund failed", error, { "stripe.charge_id": chargeId });
      metricCount("billing.refunds", 1, { outcome: "failed" });
      // Release the lock so the flow can retry; the idempotency key makes a
      // succeeded-at-Stripe retry return the original refund, not a second one.
      await this.sessionStore.releaseBillingAction(chargeId).catch(() => {});
      return { outcome: "refund_failed", error: error instanceof Error ? error.message : String(error) };
    }

    // Money has moved: from here on the lock stays no matter what.
    let cancelFailed = false;
    let cancelledSubscriptionId: string | null = null;
    try {
      if (subscriptionId) {
        await this.stripeClient.cancelSubscription(subscriptionId);
        cancelledSubscriptionId = subscriptionId;
      } else {
        const session = await this.sessionStore.getSession(customerId);
        if (session?.stripeCustomerId) {
          const cancelled = await this.stripeClient.cancelSoleActiveSubscription(session.stripeCustomerId);
          if (cancelled && "ambiguous" in cancelled) {
            // The charge couldn't be tied to a subscription and the customer
            // has several active — don't guess which to cancel; hand to staff.
            cancelFailed = true;
          } else {
            cancelledSubscriptionId = cancelled?.subscriptionId ?? null;
          }
        }
      }
    } catch (error) {
      // Money moved but the cancel didn't — error level: staff must follow up.
      billingLog.error("subscription cancel failed after refund", error, {
        "stripe.charge_id": chargeId,
        "stripe.subscription_id": subscriptionId ?? "",
      });
      cancelFailed = true;
    }

    billingLog.info("billing.refund.processed", {
      "stripe.charge_id": chargeId,
      "stripe.refund_id": refund.refundId,
      "refund.amount": refund.amount,
      "refund.currency": refund.currency,
      "stripe.subscription_id": cancelledSubscriptionId ?? "",
      "refund.cancel_failed": cancelFailed,
      "discord.user_id": customerId,
    });
    metricCount("billing.refunds", 1, { outcome: "processed" });
    metricDistribution("billing.refund_amount", refund.amount, { currency: refund.currency });
    exportBillingEvent({
      event: "refund",
      amountMinor: refund.amount,
      currency: refund.currency,
      chargeId,
      threadId,
    });

    return { outcome: "ok", ...refund, cancelFailed, cancelledSubscriptionId };
  }
}
