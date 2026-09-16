import type Stripe from "stripe";
import type { SubscriptionEventKind } from "../../metrics/MetricsExporter";
import {
  UNKNOWN,
  churnTypeOf,
  normalizeCancelReason,
  normalizeCountry,
  normalizeFeedback,
  planTagsFromPrice,
  planTagsFromSubscription,
  scrubFreeText,
  subscriptionMrrMinor,
} from "./segments";

// Turning Stripe subscription webhooks into churn movements.
//
// Pure functions only — no Stripe calls, no Prisma — so every transition rule
// below is unit-testable against a raw event shape.
//
// THE CENTRAL TRICK: Stripe sends one `customer.subscription.updated` for every
// change, and the object it carries is the state AFTER the change. "Did they
// just schedule a cancellation" is therefore unanswerable from the object
// alone — an unchanged subscription that has been pending cancellation for
// three weeks looks identical to one cancelled a second ago, so keying off the
// object would re-emit the same cancellation on every subsequent update.
//
// The answer is `event.data.previous_attributes`, which names exactly the
// fields that changed and their old values. Every rule here is a TRANSITION
// read from it, which is what makes the movements countable: one signup is one
// point, one cancellation is one point, and a no-op update is no point at all.
// It also means no local mirror of subscription state is needed to detect any
// of this.

export interface SubscriptionMovement {
  event: SubscriptionEventKind;
  subscriptionId: string;
  customerId: string | null;
  planTier: string;
  planPeriod: string;
  fromTier: string | null;
  fromPeriod: string | null;
  currency: string;
  // Monthly recurring revenue the subscription represents right now.
  mrrMinor: number;
  // Signed movement: positive when revenue arrived, negative when it left. A
  // window sum over this is net revenue movement.
  mrrDeltaMinor: number;
  // Revenue that is scheduled to leave but has NOT left yet (a cancellation set
  // for period end, a paused collection). Deliberately a separate number: adding
  // it to the delta would count the same churn twice, once when it is scheduled
  // and again when it completes.
  mrrAtRiskMinor: number;
  churnType: string | null;
  cancelReason: string | null;
  cancelFeedback: string | null;
  comment: string | null;
  cardCountry: string | null;
  occurredAt: Date;
}

// Stripe types previous_attributes as a loose bag; these are the fields the
// rules below actually read.
export type PreviousAttributes = Partial<
  Pick<Stripe.Subscription, "status" | "cancel_at" | "cancel_at_period_end" | "pause_collection" | "items">
> | null;

const FAILING_STATUSES = new Set(["past_due", "unpaid"]);

function customerIdOf(sub: Stripe.Subscription): string | null {
  const c = sub.customer;
  if (!c) return null;
  return typeof c === "string" ? c : c.id;
}

// MRR of the state BEFORE the change. previous_attributes carries the whole
// items list whenever any item changed, which is what makes a plan-change delta
// computable without remembering anything.
function previousMrrMinor(prev: PreviousAttributes): number | null {
  const items = prev?.items as Stripe.ApiList<Stripe.SubscriptionItem> | undefined;
  if (!items?.data?.length) return null;
  return subscriptionMrrMinor({ items } as Pick<Stripe.Subscription, "items">);
}

function previousPlanTags(prev: PreviousAttributes): { tier: string; period: string } | null {
  const items = prev?.items as Stripe.ApiList<Stripe.SubscriptionItem> | undefined;
  const price = items?.data?.[0]?.price;
  if (!price) return null;
  const tags = planTagsFromPrice(price);
  return { tier: tags.planTier, period: tags.planPeriod };
}

// A movement with everything that does not depend on which transition it was.
function baseMovement(sub: Stripe.Subscription, occurredAt: Date): Omit<SubscriptionMovement, "event"> {
  const plan = planTagsFromSubscription(sub);
  const mrr = subscriptionMrrMinor(sub);
  return {
    subscriptionId: sub.id,
    customerId: customerIdOf(sub),
    planTier: plan.planTier,
    planPeriod: plan.planPeriod,
    fromTier: null,
    fromPeriod: null,
    currency: sub.currency ?? "usd",
    mrrMinor: mrr,
    mrrDeltaMinor: 0,
    mrrAtRiskMinor: 0,
    churnType: null,
    cancelReason: null,
    cancelFeedback: null,
    comment: null,
    cardCountry: null,
    occurredAt,
  };
}

// Every movement in one Stripe event. An update CAN change several things at
// once (a plan change that also clears a pending cancellation), so this returns
// a list rather than a single movement, and the caller keys each row on
// `${eventId}:${event}` to keep a replay idempotent.
export function classifySubscriptionEvent(
  eventType: string,
  sub: Stripe.Subscription,
  previous: PreviousAttributes,
  occurredAt: Date
): SubscriptionMovement[] {
  const base = baseMovement(sub, occurredAt);

  if (eventType === "customer.subscription.created") {
    // A trial is not revenue yet. Counting it as MRR on day one and again as
    // churn when it lapses would invent revenue that never existed.
    if (sub.status === "trialing") {
      return [{ ...base, event: "trial_started", mrrDeltaMinor: 0 }];
    }
    return [{ ...base, event: "created", mrrDeltaMinor: base.mrrMinor }];
  }

  if (eventType === "customer.subscription.deleted") {
    const details = sub.cancellation_details ?? null;
    return [
      {
        ...base,
        event: "canceled",
        // The subscription is gone, so the revenue is gone with it.
        mrrDeltaMinor: -base.mrrMinor,
        churnType: churnTypeOf(details),
        cancelReason: normalizeCancelReason(details?.reason),
        cancelFeedback: normalizeFeedback(details?.feedback),
        // Customer free text: scrubbed of every identifier shape we can
        // recognise, and never exported as a tag. See segments.scrubFreeText.
        comment: scrubFreeText(details?.comment),
      },
    ];
  }

  if (eventType !== "customer.subscription.updated") return [];

  const movements: SubscriptionMovement[] = [];

  // --- trial converting to paid ---
  if (previous?.status === "trialing" && sub.status === "active") {
    movements.push({ ...base, event: "trial_converted", mrrDeltaMinor: base.mrrMinor });
  }

  // --- plan change ---
  const prevMrr = previousMrrMinor(previous);
  if (prevMrr != null && prevMrr !== base.mrrMinor) {
    const prevPlan = previousPlanTags(previous);
    const delta = base.mrrMinor - prevMrr;
    movements.push({
      ...base,
      event: delta > 0 ? "upgraded" : "downgraded",
      fromTier: prevPlan?.tier ?? UNKNOWN,
      fromPeriod: prevPlan?.period ?? UNKNOWN,
      mrrDeltaMinor: delta,
    });
  }

  // --- cancellation scheduled or called off ---
  // Two independent fields express the same intent: cancel_at_period_end for a
  // period-end cancel, cancel_at for a hard date. Either flipping counts once.
  const scheduledNow = Boolean(sub.cancel_at_period_end || sub.cancel_at);
  const scheduledBefore =
    previous && ("cancel_at_period_end" in previous || "cancel_at" in previous)
      ? Boolean(previous.cancel_at_period_end ?? sub.cancel_at_period_end) ||
        Boolean(previous.cancel_at ?? sub.cancel_at)
      : scheduledNow;
  if (!scheduledBefore && scheduledNow) {
    const details = sub.cancellation_details ?? null;
    movements.push({
      ...base,
      event: "cancel_scheduled",
      // Nothing has left yet — this is the pipeline of revenue about to go.
      mrrAtRiskMinor: base.mrrMinor,
      churnType: churnTypeOf(details),
      cancelReason: normalizeCancelReason(details?.reason),
      cancelFeedback: normalizeFeedback(details?.feedback),
      comment: scrubFreeText(details?.comment),
    });
  } else if (scheduledBefore && !scheduledNow) {
    // A save. Negative at-risk so a window sum of mrr_at_risk_minor is the
    // revenue still genuinely pending departure.
    movements.push({ ...base, event: "cancel_reverted", mrrAtRiskMinor: -base.mrrMinor });
  }

  // --- collection paused / resumed ---
  const pausedNow = Boolean(sub.pause_collection);
  const pausedBefore = previous && "pause_collection" in previous ? Boolean(previous.pause_collection) : pausedNow;
  if (!pausedBefore && pausedNow) {
    movements.push({ ...base, event: "paused", mrrAtRiskMinor: base.mrrMinor });
  } else if (pausedBefore && !pausedNow) {
    movements.push({ ...base, event: "resumed", mrrAtRiskMinor: -base.mrrMinor });
  }

  // --- dunning ---
  // The leading indicator of involuntary churn: payment started failing. Worth
  // its own movement because it is the window in which a save is still possible.
  if (previous?.status && previous.status !== sub.status) {
    const wasFailing = FAILING_STATUSES.has(previous.status);
    const isFailing = FAILING_STATUSES.has(sub.status);
    if (!wasFailing && isFailing) {
      movements.push({ ...base, event: "payment_failing", mrrAtRiskMinor: base.mrrMinor });
    } else if (wasFailing && !isFailing && sub.status === "active") {
      movements.push({ ...base, event: "payment_recovered", mrrAtRiskMinor: -base.mrrMinor });
    }
  }

  return movements;
}

// Region for a movement, when the caller managed to resolve the card behind the
// subscription. Kept separate from the classifier because it needs a Stripe
// read and the classifier is pure.
export function withCardCountry(movement: SubscriptionMovement, country: string | null): SubscriptionMovement {
  return { ...movement, cardCountry: normalizeCountry(country) };
}
