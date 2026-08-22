import type Stripe from "stripe";
import { StripeClient, rebuildCurrentPhase } from "../../StripeClient";
import { SessionStore } from "../../../auth/SessionStore";
import { SettingsStore, BillingActionLevel } from "../../../config/SettingsStore";
import { BlockService, BlockEntry } from "../BlockService";
import { BLOCK_KINDS, type BlockKind } from "../BlockStore";
import { RefundCoreService } from "../RefundCoreService";
import {
  buildPostizMetadata,
  derivePostizPlan,
  isGitroomSub,
  postizSyncStatus,
  postizUniqueId,
} from "../postizPlan";
import type { PostizDriftService } from "../../../postiz/PostizDriftService";
import type { MoneyOutService } from "../MoneyOutService";
import { exportBillingEvent, type BillingEventSurface } from "../../../metrics/MetricsExporter";

// Single source of truth for every canvas/panel billing action: the panel UI,
// the canvas card, the /config levels panel and the approval executor all
// resolve actions through this registry. Each action:
//  - parses+validates its params (hostile input — the panel client is not
//    trusted),
//  - revalidates against LIVE Stripe state immediately before execution
//    (state may have drifted between queue time and approval), including the
//    OWNERSHIP check: the target object must belong to the conversation's
//    Stripe customer, so a forged id can never act on another customer,
//  - executes via the existing StripeClient/BlockService/RefundCoreService
//    paths with their idempotency conventions.

export type { BillingActionLevel };

export interface ActionActor {
  kind: "intercom" | "discord" | "dashboard";
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface ActionExecCtx {
  stripe: StripeClient;
  sessionStore: SessionStore;
  settingsStore: SettingsStore;
  blockService: BlockService;
  refundCore: RefundCoreService;
  // Resolved server-side — never client-supplied. Intercom entry derives it
  // from the conversation link; the dashboard gateway derives it from the
  // TARGET object (charge/PI/sub/invoice → .customer).
  stripeCustomerId: string | null;
  // null for dashboard-origin requests (no Intercom conversation involved).
  conversationId: string | null;
  ticketThreadId: string | null;
  discordCustomerId: string | null;
  actor: ActionActor;
  // Idempotency scope: the approval id (queued path) or a per-request nonce
  // (direct path) — folded into Stripe idempotency keys.
  idemScope: string;
  // Platform-side plan comparison. Absent when the Postiz lookup is not
  // configured, which makes the platform resync action refuse rather than
  // guess.
  postizDrift?: PostizDriftService;
  // Money-out ledger. Concessions (credit notes, coupons, balance credits,
  // write-offs) leave no balance transaction behind, so the action that made
  // them is the ONLY place they can be recorded. Optional: a metrics gap must
  // never stop a billing action.
  moneyOut?: MoneyOutService;
}

// Which surface an action ran from — the Intercom panel always carries a
// conversation, the web dashboard never does.
function surfaceOf(ctx: ActionExecCtx): BillingEventSurface {
  return ctx.conversationId ? "panel" : "dashboard";
}

export type ActionParse<P> = { ok: true; params: P } | { ok: false; error: string };
export type ActionResult = { ok: true; text: string } | { ok: false; error: string };

export interface BillingActionDef<P = unknown> {
  key: string;
  label: string;
  group: "Charges" | "Subscriptions" | "Invoices" | "Customer" | "Reviews";
  // "none" disables the action for EVERYONE including admins — the default
  // for every action except charge_review (user decision).
  defaultLevel: BillingActionLevel;
  // Rendered red + typed-confirm in the panel.
  dangerous: boolean;
  parseParams: (raw: unknown) => ActionParse<P>;
  summarize: (params: P, stripe: StripeClient) => string;
  // null = still executable; a string = human-readable refusal.
  revalidate: (ctx: ActionExecCtx, params: P) => Promise<string | null>;
  execute: (ctx: ActionExecCtx, params: P) => Promise<ActionResult>;
}

// ---- param helpers (hostile input) ----

function obj(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}
function str(v: unknown, maxLen = 200): string | null {
  return typeof v === "string" && v.trim() && v.length <= maxLen ? v.trim() : null;
}
function posInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}
function intAny(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v !== 0 ? v : null;
}
function idWithPrefix(v: unknown, prefix: string): string | null {
  const s = str(v);
  return s && s.startsWith(prefix) ? s : null;
}
function customerIdOf(target: { customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null }): string | null {
  const c = target.customer;
  if (!c) return null;
  return typeof c === "string" ? c : c.id;
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Ownership gate shared by every revalidator.
function requireCustomer(ctx: ActionExecCtx): string | null {
  return ctx.stripeCustomerId;
}

function fmt(stripe: StripeClient, amountMinor: number, currency: string): string {
  return stripe.formatAmount(amountMinor, currency);
}

// ---- action definitions ----

function defineAction<P>(def: BillingActionDef<P>): BillingActionDef {
  return def as unknown as BillingActionDef;
}

interface ChargeReviewParams {
  decision: "approve" | "deny";
  reason?: string;
}

const chargeReview = defineAction<ChargeReviewParams>({
  key: "charge_review",
  label: "Charge review approve/deny",
  group: "Reviews",
  // User decision: the ONE action that ships enabled (agents queue, admins direct).
  defaultLevel: "approval",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const decision = o && (o.decision === "approve" || o.decision === "deny") ? o.decision : null;
    if (!decision) return { ok: false, error: "decision must be approve or deny" };
    return { ok: true, params: { decision, reason: str(o!.reason, 400) ?? undefined } };
  },
  summarize: (p) => (p.decision === "approve" ? "Approve the blocked refund (refund + cancel subscription)" : "Deny the blocked refund"),
  revalidate: async (ctx, p) => {
    if (!ctx.ticketThreadId) return "No linked Discord ticket for this conversation.";
    const review = await ctx.sessionStore.getPendingChargeReview(ctx.ticketThreadId);
    if (!review) return "No pending charge review on this ticket (already resolved?).";
    if (p.decision === "approve") {
      const charge = await ctx.stripe.getChargeAmount(review.chargeId);
      if (charge.refunded) return "Charge is already refunded; use Deny or let it resolve as already processed.";
    }
    return null;
  },
  execute: async (ctx, p) => {
    const threadId = ctx.ticketThreadId!;
    const review = await ctx.sessionStore.getPendingChargeReview(threadId);
    if (!review) return { ok: false, error: "No pending charge review on this ticket." };
    const reviewer = `${ctx.actor.kind}:${ctx.actor.id}`;
    if (p.decision === "deny") {
      await ctx.sessionStore.resolvePendingChargeReview(threadId, "DENIED", reviewer);
      return { ok: true, text: `Refund review denied${p.reason ? `: ${p.reason}` : ""}.` };
    }
    // Approve: same path as Discord /charge approve.
    const charge = await ctx.stripe.getChargeAmount(review.chargeId).catch(() => null);
    if (charge?.refunded) {
      await ctx.sessionStore.resolvePendingChargeReview(threadId, "ALREADY_PROCESSED", reviewer);
      return { ok: true, text: "Charge was already refunded; review resolved as already processed." };
    }
    const result = await ctx.refundCore.run({
      customerId: review.customerId,
      chargeId: review.chargeId,
      subscriptionId: review.subscriptionId,
      threadId,
    });
    if (result.outcome === "already_processed") {
      await ctx.sessionStore.resolvePendingChargeReview(threadId, "ALREADY_PROCESSED", reviewer);
      return { ok: true, text: "Refund already processed earlier; review resolved." };
    }
    if (result.outcome === "refund_failed") {
      return { ok: false, error: `Refund failed: ${result.error}` };
    }
    await ctx.sessionStore.resolvePendingChargeReview(threadId, "APPROVED", reviewer);
    const cancelNote = result.cancelFailed
      ? " Subscription cancel FAILED; follow up manually."
      : result.cancelledSubscriptionId
        ? ` Subscription ${result.cancelledSubscriptionId} cancelled.`
        : "";
    return { ok: true, text: `Refund executed (${result.refundId}).${cancelNote}` };
  },
});

interface RefundFullParams {
  chargeId: string;
}

const refundFull = defineAction<RefundFullParams>({
  key: "charge.refund_full",
  label: "Full refund (+ cancel subscription)",
  group: "Charges",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const chargeId = o ? idWithPrefix(o.chargeId, "ch_") : null;
    return chargeId ? { ok: true, params: { chargeId } } : { ok: false, error: "chargeId (ch_…) required" };
  },
  summarize: (p) => `Fully refund ${p.chargeId} and cancel the subscription`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    if (!ctx.discordCustomerId) return "No linked Discord customer (the refund core tracks refunds per Discord user).";
    const charge = await ctx.stripe.getCharge(p.chargeId);
    if (customerIdOf(charge) !== cus) return "Charge does not belong to this customer.";
    if (charge.refunded) return "Charge is already fully refunded.";
    return null;
  },
  execute: async (ctx, p) => {
    const result = await ctx.refundCore.run({
      customerId: ctx.discordCustomerId!,
      chargeId: p.chargeId,
      subscriptionId: null,
      threadId: ctx.ticketThreadId,
    });
    if (result.outcome === "already_processed") return { ok: true, text: "Refund already processed earlier." };
    if (result.outcome === "refund_failed") return { ok: false, error: `Refund failed: ${result.error}` };
    const cancelNote = result.cancelFailed
      ? " Subscription cancel needs manual follow-up (failed or ambiguous)."
      : result.cancelledSubscriptionId
        ? ` Subscription ${result.cancelledSubscriptionId} cancelled.`
        : "";
    return { ok: true, text: `Refunded ${fmt(ctx.stripe, result.amount, result.currency)} (${result.refundId}).${cancelNote}` };
  },
});

interface RefundPartialParams {
  chargeId: string;
  amountMinor: number;
}

async function revalidatePartialRefund(ctx: ActionExecCtx, p: RefundPartialParams): Promise<string | null> {
  const cus = requireCustomer(ctx);
  if (!cus) return "No linked Stripe customer.";
  const charge = await ctx.stripe.getCharge(p.chargeId);
  if (customerIdOf(charge) !== cus) return "Charge does not belong to this customer.";
  if (charge.refunded) return "Charge is already fully refunded.";
  const remaining = charge.amount - (charge.amount_refunded ?? 0);
  if (p.amountMinor > remaining) return `Amount exceeds the refundable remainder (${remaining} minor units).`;
  return null;
}

const refundPartial = defineAction<RefundPartialParams>({
  key: "charge.refund_partial",
  label: "Partial refund",
  group: "Charges",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const chargeId = o ? idWithPrefix(o.chargeId, "ch_") : null;
    const amountMinor = o ? posInt(o.amountMinor) : null;
    if (!chargeId || !amountMinor) return { ok: false, error: "chargeId (ch_…) and positive amountMinor required" };
    return { ok: true, params: { chargeId, amountMinor } };
  },
  summarize: (p) => `Partially refund ${p.chargeId} by ${p.amountMinor} minor units`,
  revalidate: revalidatePartialRefund,
  execute: async (ctx, p) => {
    const refund = await ctx.stripe.refundChargeAmount(
      p.chargeId,
      p.amountMinor,
      `panel-refund-${p.chargeId}-${p.amountMinor}-${ctx.idemScope}`
    );
    // Attribution only. The MONEY is booked by the money-out ledger, which
    // picks this refund up from its balance transaction (webhook first,
    // reconcile sweep as the backstop) — never sum billing_events for totals.
    exportBillingEvent({
      event: "refund",
      amountMinor: refund.amount,
      currency: refund.currency,
      chargeId: p.chargeId,
      surface: surfaceOf(ctx),
      partial: true,
    });
    return { ok: true, text: `Refunded ${fmt(ctx.stripe, refund.amount, refund.currency)} of ${p.chargeId} (${refund.refundId}).` };
  },
});

const refundFraud = defineAction<RefundPartialParams>({
  key: "charge.refund_fraud",
  label: "Refund as fraudulent",
  group: "Charges",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const chargeId = o ? idWithPrefix(o.chargeId, "ch_") : null;
    const amountMinor = o ? posInt(o.amountMinor) : null;
    if (!chargeId || !amountMinor) return { ok: false, error: "chargeId (ch_…) and positive amountMinor required" };
    return { ok: true, params: { chargeId, amountMinor } };
  },
  summarize: (p) => `Refund ${p.amountMinor} minor units of ${p.chargeId} as FRAUDULENT (feeds Radar)`,
  revalidate: revalidatePartialRefund,
  execute: async (ctx, p) => {
    const refund = await ctx.stripe.refundChargeAmount(
      p.chargeId,
      p.amountMinor,
      `panel-fraudrefund-${p.chargeId}-${p.amountMinor}-${ctx.idemScope}`,
      "fraudulent"
    );
    exportBillingEvent({
      event: "refund",
      amountMinor: refund.amount,
      currency: refund.currency,
      chargeId: p.chargeId,
      surface: surfaceOf(ctx),
      partial: true,
      reason: "fraudulent",
    });
    return { ok: true, text: `Refunded ${fmt(ctx.stripe, refund.amount, refund.currency)} of ${p.chargeId} as fraudulent (${refund.refundId}).` };
  },
});

interface PaymentIntentCancelParams {
  paymentIntentId: string;
}

const CANCELABLE_PI_STATUSES = new Set(["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture"]);

const paymentIntentCancel = defineAction<PaymentIntentCancelParams>({
  key: "payment_intent.cancel",
  label: "Cancel payment intent",
  group: "Charges",
  defaultLevel: "none",
  dangerous: false,
  parseParams: (raw) => {
    const o = obj(raw);
    const paymentIntentId = o ? idWithPrefix(o.paymentIntentId, "pi_") : null;
    return paymentIntentId ? { ok: true, params: { paymentIntentId } } : { ok: false, error: "paymentIntentId (pi_…) required" };
  },
  summarize: (p) => `Cancel payment intent ${p.paymentIntentId}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const pi = await ctx.stripe.getPaymentIntent(p.paymentIntentId);
    if (customerIdOf(pi) !== cus) return "Payment intent does not belong to this customer.";
    if (!CANCELABLE_PI_STATUSES.has(pi.status)) return `Payment intent is ${pi.status}, not cancelable.`;
    return null;
  },
  execute: async (ctx, p) => {
    const pi = await ctx.stripe.cancelPaymentIntent(p.paymentIntentId, `panel-picancel-${p.paymentIntentId}-${ctx.idemScope}`);
    return { ok: true, text: `Payment intent ${pi.id} cancelled (was ${fmt(ctx.stripe, pi.amount, pi.currency)}).` };
  },
});

interface PaymentIntentCaptureParams {
  paymentIntentId: string;
  amountMinor?: number;
}

// Capture is the moment the customer's card is actually charged — T1 via
// dangerous here, plus an unconditional T2 step-up in Dashboard.ts (DASH_T2),
// the same class as charge.create.
const paymentIntentCapture = defineAction<PaymentIntentCaptureParams>({
  key: "payment_intent.capture",
  label: "Capture payment",
  group: "Charges",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const paymentIntentId = o ? idWithPrefix(o.paymentIntentId, "pi_") : null;
    if (!paymentIntentId) return { ok: false, error: "paymentIntentId (pi_…) required" };
    const amountMinor = o && o.amountMinor != null ? posInt(o.amountMinor) : null;
    if (o && o.amountMinor != null && !amountMinor) return { ok: false, error: "amountMinor must be a positive integer" };
    return { ok: true, params: { paymentIntentId, ...(amountMinor ? { amountMinor } : {}) } };
  },
  summarize: (p) =>
    p.amountMinor
      ? `Capture ${p.amountMinor} minor units of ${p.paymentIntentId} (the remainder is released)`
      : `Capture the full authorized amount of ${p.paymentIntentId}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const pi = await ctx.stripe.getPaymentIntent(p.paymentIntentId);
    if (customerIdOf(pi) !== cus) return "Payment intent does not belong to this customer.";
    if (pi.status !== "requires_capture") return `Payment intent is ${pi.status}: only requires_capture payments can be captured.`;
    if (p.amountMinor != null && p.amountMinor > (pi.amount_capturable ?? 0)) {
      return `Amount exceeds the capturable remainder (${pi.amount_capturable ?? 0} minor units).`;
    }
    return null;
  },
  execute: async (ctx, p) => {
    const pi = await ctx.stripe.capturePaymentIntent(
      p.paymentIntentId,
      p.amountMinor,
      `panel-picapture-${p.paymentIntentId}-${ctx.idemScope}`
    );
    const captured = pi.amount_received ?? p.amountMinor ?? pi.amount;
    return {
      ok: true,
      text: `Captured ${fmt(ctx.stripe, captured, pi.currency)} of ${pi.id}.${p.amountMinor ? " The uncaptured remainder was released." : ""}`,
    };
  },
});

interface SubscriptionCancelParams {
  subscriptionId: string;
  // "at" = hard end on an absolute date (cancel_at), "never" = disarm whatever
  // cancel is scheduled. Both live on this key so they inherit the cancel
  // permission level: whoever may end a subscription may also re-date it.
  when: "now" | "period_end" | "at" | "never";
  cancelAtUnix?: number;
}

// A scheduled cancel is capped at two years out — the same horizon trialDays
// uses, and far enough that a fat-fingered timestamp (milliseconds pasted as
// seconds) is refused instead of silently parking the sub forever.
const MAX_CANCEL_HORIZON_SECONDS = 730 * 86_400;

function cancelDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

const subscriptionCancel = defineAction<SubscriptionCancelParams>({
  key: "subscription.cancel",
  label: "Cancel subscription",
  group: "Subscriptions",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const subscriptionId = o ? idWithPrefix(o.subscriptionId, "sub_") : null;
    const when =
      o && (o.when === "now" || o.when === "period_end" || o.when === "at" || o.when === "never") ? o.when : null;
    if (!subscriptionId || !when) {
      return { ok: false, error: "subscriptionId (sub_…) and when (now|period_end|at|never) required" };
    }
    if (when !== "at") return { ok: true, params: { subscriptionId, when } };
    const cancelAtUnix = posInt(o!.cancelAtUnix);
    if (cancelAtUnix == null) return { ok: false, error: "cancelAtUnix (unix seconds) required for when=at" };
    return { ok: true, params: { subscriptionId, when, cancelAtUnix } };
  },
  summarize: (p) =>
    p.when === "at"
      ? `Cancel subscription ${p.subscriptionId} on ${cancelDate(p.cancelAtUnix!)} (no proration refund)`
      : p.when === "never"
        ? `Clear the scheduled cancellation on ${p.subscriptionId} (it keeps renewing)`
        : `Cancel subscription ${p.subscriptionId} ${p.when === "now" ? "immediately" : "at period end"}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
    if (sub.status === "canceled") return "Subscription is already canceled.";
    if (p.when === "period_end" && sub.cancel_at_period_end) return "Subscription is already set to cancel at period end.";
    if (p.when === "never" && !sub.cancel_at && !sub.cancel_at_period_end) {
      return "Nothing is scheduled: this subscription is not set to cancel.";
    }
    if (p.when === "at") {
      // A schedule owns its subscription's phases; Stripe refuses cancel_at on
      // one, and the schedule editor already has an end-behavior of "cancel".
      if (sub.schedule) return "This subscription is driven by a schedule; set the end behaviour in the schedule editor instead.";
      const nowSec = Math.floor(Date.now() / 1000);
      if (p.cancelAtUnix! <= nowSec) return "The cancellation date must be in the future.";
      if (p.cancelAtUnix! > nowSec + MAX_CANCEL_HORIZON_SECONDS) return "The cancellation date must be within two years.";
    }
    return null;
  },
  execute: async (ctx, p) => {
    if (p.when === "now") {
      await ctx.stripe.cancelSubscription(p.subscriptionId);
      return { ok: true, text: `Subscription ${p.subscriptionId} cancelled immediately.` };
    }
    if (p.when === "at") {
      await ctx.stripe.setSubscriptionCancelAt(
        p.subscriptionId,
        p.cancelAtUnix!,
        `panel-cancelat-${p.subscriptionId}-${p.cancelAtUnix}-${ctx.idemScope}`
      );
      return { ok: true, text: `Subscription ${p.subscriptionId} will cancel on ${cancelDate(p.cancelAtUnix!)}.` };
    }
    if (p.when === "never") {
      await ctx.stripe.clearScheduledCancel(p.subscriptionId, `panel-uncancel-${p.subscriptionId}-${ctx.idemScope}`);
      return { ok: true, text: `Subscription ${p.subscriptionId} is no longer scheduled to cancel; it renews normally.` };
    }
    await ctx.stripe.cancelSubscriptionAtPeriodEnd(p.subscriptionId);
    return { ok: true, text: `Subscription ${p.subscriptionId} will cancel at period end.` };
  },
});

interface SubscriptionPauseResumeParams {
  subscriptionId: string;
  op: "pause" | "resume";
}

const subscriptionPauseResume = defineAction<SubscriptionPauseResumeParams>({
  key: "subscription.pause_resume",
  label: "Pause / resume subscription",
  group: "Subscriptions",
  defaultLevel: "none",
  dangerous: false,
  parseParams: (raw) => {
    const o = obj(raw);
    const subscriptionId = o ? idWithPrefix(o.subscriptionId, "sub_") : null;
    const op = o && (o.op === "pause" || o.op === "resume") ? o.op : null;
    if (!subscriptionId || !op) return { ok: false, error: "subscriptionId (sub_…) and op (pause|resume) required" };
    return { ok: true, params: { subscriptionId, op } };
  },
  summarize: (p) => `${p.op === "pause" ? "Pause" : "Resume"} collection on ${p.subscriptionId}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
    if (sub.status === "canceled") return "Subscription is canceled.";
    if (p.op === "pause" && sub.pause_collection) return "Collection is already paused.";
    if (p.op === "resume" && !sub.pause_collection) return "Collection is not paused.";
    return null;
  },
  execute: async (ctx, p) => {
    if (p.op === "pause") {
      await ctx.stripe.pauseSubscription(p.subscriptionId, "void", `panel-pause-${p.subscriptionId}-${ctx.idemScope}`);
      return { ok: true, text: `Collection paused on ${p.subscriptionId} (invoices voided while paused).` };
    }
    await ctx.stripe.resumeSubscription(p.subscriptionId, `panel-resume-${p.subscriptionId}-${ctx.idemScope}`);
    return { ok: true, text: `Collection resumed on ${p.subscriptionId}.` };
  },
});

// The unified "Update subscription" action: price swap and/or quantity, promo,
// billing-cycle reset — all optional beyond the target price (pass the current
// price to change only the other knobs). Backward compatible with the original
// {subscriptionId, priceId} shape the Intercom canvas sends.
interface SubscriptionChangePlanParams {
  subscriptionId: string;
  priceId: string;
  itemId?: string;
  quantity?: number;
  promoCode?: string;
  cycleAnchor?: "now";
}

const subscriptionChangePlan = defineAction<SubscriptionChangePlanParams>({
  key: "subscription.change_plan",
  label: "Update subscription (price/qty/promo/cycle)",
  group: "Subscriptions",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const subscriptionId = o ? idWithPrefix(o.subscriptionId, "sub_") : null;
    const priceId = o ? idWithPrefix(o.priceId, "price_") : null;
    if (!subscriptionId || !priceId) return { ok: false, error: "subscriptionId (sub_…) and priceId (price_…) required" };
    return {
      ok: true,
      params: {
        subscriptionId,
        priceId,
        itemId: o ? (idWithPrefix(o.itemId, "si_") ?? undefined) : undefined,
        quantity: o ? (posInt(o.quantity) ?? undefined) : undefined,
        promoCode: o ? (str(o.promoCode, 100) ?? undefined) : undefined,
        cycleAnchor: o?.cycleAnchor === "now" ? "now" : undefined,
      },
    };
  },
  summarize: (p) =>
    `Update ${p.subscriptionId} → price ${p.priceId}` +
    (p.quantity != null ? ` ×${p.quantity}` : "") +
    (p.promoCode ? `, promo ${p.promoCode}` : "") +
    (p.cycleAnchor === "now" ? ", billing cycle reset to now" : "") +
    " (with prorations)",
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
    if (sub.status !== "active" && sub.status !== "trialing") return `Subscription is ${sub.status}, not changeable.`;
    const item = p.itemId ? sub.items.data.find((it) => it.id === p.itemId) : sub.items.data[0];
    if (p.itemId && !item) return "That item does not exist on this subscription.";
    const samePrice = item?.price?.id === p.priceId;
    if (samePrice && p.quantity == null && !p.promoCode && !p.cycleAnchor) {
      return "Nothing to change: pick a different price, quantity, promo or cycle reset.";
    }
    const price = await ctx.stripe.getPrice(p.priceId).catch(() => null);
    if (!price || !price.recurring) return "Target price does not exist or is not recurring.";
    // A gitroom sub may only MOVE to canonical Postiz prices — the platform
    // applies whatever the metadata says, so a non-canonical price would
    // desync what the customer pays from what they get.
    if (!samePrice && isGitroomSub(sub) && !derivePostizPlan(price)) {
      return "This subscription syncs to Postiz; the target price must be a canonical Postiz price ($29/$278, $39/$374, $49/$470, $99/$950 USD). Use a promo for discounts.";
    }
    const allowlist = ctx.settingsStore.allowedPriceIds();
    // Keeping the CURRENT price (qty/promo/cycle-only update) is always fine —
    // the allowlist gates plan MOVES, not already-held plans.
    if (!samePrice && allowlist.length > 0 && !allowlist.includes(p.priceId)) {
      return "Target price is not on the plan allowlist (/config → Billing).";
    }
    if (p.promoCode) {
      const codes = await ctx.stripe.findPromotionCodes(p.promoCode);
      if (!codes.some((c) => c.active)) return "Promo code not found or inactive.";
    }
    return null;
  },
  execute: async (ctx, p) => {
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    const item = p.itemId ? sub.items.data.find((it) => it.id === p.itemId) : sub.items.data[0];
    if (!item) return { ok: false, error: "Subscription has no matching item to update." };
    let promotionCodeId: string | undefined;
    if (p.promoCode) {
      const codes = await ctx.stripe.findPromotionCodes(p.promoCode);
      const active = codes.find((c) => c.active);
      if (!active) return { ok: false, error: "Promo code not found or inactive." };
      promotionCodeId = active.id;
    }
    // Keep the Postiz metadata in the SAME update call: the platform re-reads
    // billing/period from metadata on customer.subscription.updated, so a
    // price change without the matching metadata strands the org on the old
    // tier. uniqueId is the platform's Subscription.identifier — preserved,
    // never rotated.
    let metadata: Record<string, string> | undefined;
    let syncBit: string | null = null;
    if (isGitroomSub(sub)) {
      const price = await ctx.stripe.getPrice(p.priceId).catch(() => null);
      const plan = price ? derivePostizPlan(price) : null;
      if (plan) {
        metadata = buildPostizMetadata(plan, sub.metadata?.uniqueId || postizUniqueId(ctx.idemScope));
        syncBit = `Postiz sync ${plan.tier}/${plan.period}`;
      } else if (item.price?.id !== p.priceId) {
        return { ok: false, error: "Target price is not a canonical Postiz price; cannot keep this subscription synced." };
      }
    }
    await ctx.stripe.changeSubscriptionPlan(
      {
        subscriptionId: p.subscriptionId,
        itemId: item.id,
        priceId: p.priceId,
        prorationBehavior: "create_prorations",
        quantity: p.quantity,
        promotionCodeId,
        billingCycleAnchor: p.cycleAnchor,
        metadata,
      },
      `panel-planchange-${p.subscriptionId}-${p.priceId}-${ctx.idemScope}`
    );
    const bits = [
      `price ${p.priceId}`,
      p.quantity != null ? `quantity ${p.quantity}` : null,
      promotionCodeId ? `promo ${p.promoCode}` : null,
      p.cycleAnchor === "now" ? "billing cycle reset" : null,
      syncBit,
    ].filter(Boolean);
    return { ok: true, text: `Subscription ${p.subscriptionId} updated: ${bits.join(", ")} (with prorations).` };
  },
});

interface SubscriptionTermsParams {
  subscriptionId: string;
  trialEndUnix?: number;
  quantity?: number;
  // Ends a running trial immediately — billing starts NOW (T2 in Dashboard.ts).
  endTrialNow?: boolean;
}

const subscriptionTerms = defineAction<SubscriptionTermsParams>({
  key: "subscription.terms",
  label: "Trial end / quantity",
  group: "Subscriptions",
  defaultLevel: "none",
  dangerous: false,
  parseParams: (raw) => {
    const o = obj(raw);
    const subscriptionId = o ? idWithPrefix(o.subscriptionId, "sub_") : null;
    const trialEndUnix = o ? (posInt(o.trialEndUnix) ?? undefined) : undefined;
    const quantity = o ? (posInt(o.quantity) ?? undefined) : undefined;
    const endTrialNow = o?.endTrialNow === true ? true : undefined;
    if (!subscriptionId || (trialEndUnix == null && quantity == null && !endTrialNow)) {
      return { ok: false, error: "subscriptionId (sub_…) and at least one of trialEndUnix/quantity/endTrialNow required" };
    }
    if (endTrialNow && trialEndUnix != null) {
      return { ok: false, error: "endTrialNow and trialEndUnix are mutually exclusive" };
    }
    return { ok: true, params: { subscriptionId, trialEndUnix, quantity, endTrialNow } };
  },
  summarize: (p) =>
    `Update ${p.subscriptionId}: ${[
      p.endTrialNow ? "END TRIAL NOW (billing starts immediately)" : null,
      p.trialEndUnix != null ? `trial end → ${new Date(p.trialEndUnix * 1000).toISOString().slice(0, 10)}` : null,
      p.quantity != null ? `quantity → ${p.quantity}` : null,
    ]
      .filter(Boolean)
      .join(", ")}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
    if (sub.status === "canceled") return "Subscription is canceled.";
    if (p.endTrialNow && sub.status !== "trialing") return `Subscription is ${sub.status}, no trial to end.`;
    if (p.trialEndUnix != null && p.trialEndUnix * 1000 <= Date.now()) return "Trial end must be in the future.";
    return null;
  },
  execute: async (ctx, p) => {
    const done: string[] = [];
    if (p.endTrialNow) {
      await ctx.stripe.setTrialEnd(p.subscriptionId, "now", `panel-trialnow-${p.subscriptionId}-${ctx.idemScope}`);
      done.push("trial ended; billing starts now");
    }
    if (p.trialEndUnix != null) {
      await ctx.stripe.setTrialEnd(p.subscriptionId, p.trialEndUnix, `panel-trial-${p.subscriptionId}-${p.trialEndUnix}-${ctx.idemScope}`);
      done.push(`trial end set to ${new Date(p.trialEndUnix * 1000).toISOString().slice(0, 10)}`);
    }
    if (p.quantity != null) {
      const sub = await ctx.stripe.getSubscription(p.subscriptionId);
      const itemId = sub.items.data[0]?.id;
      if (!itemId) return { ok: false, error: "Subscription has no item for a quantity change." };
      await ctx.stripe.setSubscriptionQuantity(p.subscriptionId, itemId, p.quantity, "none", `panel-qty-${p.subscriptionId}-${p.quantity}-${ctx.idemScope}`);
      done.push(`quantity set to ${p.quantity}`);
    }
    return { ok: true, text: `Subscription ${p.subscriptionId}: ${done.join(", ")}.` };
  },
});

interface SubscriptionCreateParams {
  customerId: string;
  priceId: string;
  quantity?: number;
  promoCode?: string;
  trialDays?: number;
  // Absolute hard end, armed at creation: "trial for a week, then stop".
  cancelAtUnix?: number;
  // Trial that never got a card: cancel at trial end instead of invoicing.
  cancelIfNoPaymentMethod?: boolean;
  collection: "charge" | "invoice";
}

const subscriptionCreate = defineAction<SubscriptionCreateParams>({
  key: "subscription.create",
  label: "Create subscription",
  group: "Subscriptions",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const customerId = o ? idWithPrefix(o.customerId, "cus_") : null;
    const priceId = o ? idWithPrefix(o.priceId, "price_") : null;
    const collection = o && (o.collection === "charge" || o.collection === "invoice") ? o.collection : null;
    if (!customerId || !priceId || !collection) {
      return { ok: false, error: "customerId (cus_…), priceId (price_…) and collection (charge|invoice) required" };
    }
    const trialDays = posInt(o!.trialDays) ?? undefined;
    if (trialDays != null && trialDays > 730) return { ok: false, error: "trialDays must be ≤ 730" };
    const cancelAtUnix = posInt(o!.cancelAtUnix) ?? undefined;
    const cancelIfNoPaymentMethod = o!.cancelIfNoPaymentMethod === true ? true : undefined;
    if (cancelIfNoPaymentMethod && !trialDays) {
      return { ok: false, error: "cancelIfNoPaymentMethod only applies to a trial; set trialDays too" };
    }
    return {
      ok: true,
      params: {
        customerId,
        priceId,
        quantity: posInt(o!.quantity) ?? undefined,
        promoCode: str(o!.promoCode, 100) ?? undefined,
        trialDays,
        cancelAtUnix,
        cancelIfNoPaymentMethod,
        collection,
      },
    };
  },
  summarize: (p) =>
    `Create a subscription for ${p.customerId} on ${p.priceId}` +
    (p.quantity != null ? ` ×${p.quantity}` : "") +
    (p.trialDays ? `, ${p.trialDays}-day trial` : "") +
    (p.cancelIfNoPaymentMethod ? " (cancels at trial end if no card is on file)" : "") +
    (p.cancelAtUnix ? `, cancels on ${cancelDate(p.cancelAtUnix)}` : "") +
    (p.promoCode ? `, promo ${p.promoCode}` : "") +
    (p.collection === "invoice" ? " (email invoice)" : " (charge the default payment method now)") +
    ", Postiz sync (tier from the price)",
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    if (p.customerId !== cus) return "Customer binding mismatch.";
    const customer = await ctx.stripe.getCustomer(cus);
    if (!customer || customer.deleted) return "Customer no longer exists in Stripe.";
    const price = await ctx.stripe.getPrice(p.priceId).catch(() => null);
    if (!price || !price.recurring) return "Price does not exist or is not recurring.";
    if (!price.active) return "Price is archived.";
    if (!derivePostizPlan(price)) {
      return "Price is not a canonical Postiz price ($29/$278, $39/$374, $49/$470, $99/$950 USD): pick a canonical price, or use a promo for discounts.";
    }
    if (p.cancelAtUnix != null) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (p.cancelAtUnix <= nowSec) return "The cancellation date must be in the future.";
      if (p.cancelAtUnix > nowSec + MAX_CANCEL_HORIZON_SECONDS) return "The cancellation date must be within two years.";
    }
    const allowlist = ctx.settingsStore.allowedPriceIds();
    if (allowlist.length > 0 && !allowlist.includes(p.priceId)) return "Price is not on the plan allowlist (/config → Billing).";
    if (p.promoCode) {
      const codes = await ctx.stripe.findPromotionCodes(p.promoCode);
      if (!codes.some((c) => c.active)) return "Promo code not found or inactive.";
    }
    // Charge-now needs something to charge: no trial softens the first invoice.
    if (
      p.collection === "charge" &&
      !p.trialDays &&
      !customer.invoice_settings?.default_payment_method &&
      !customer.default_source
    ) {
      return "Customer has no default payment method: collect by invoice, add a trial, or attach a card first.";
    }
    return null;
  },
  execute: async (ctx, p) => {
    let promotionCodeId: string | undefined;
    if (p.promoCode) {
      const codes = await ctx.stripe.findPromotionCodes(p.promoCode);
      const active = codes.find((c) => c.active);
      if (!active) return { ok: false, error: "Promo code not found or inactive." };
      promotionCodeId = active.id;
    }
    const price = await ctx.stripe.getPrice(p.priceId);
    const plan = derivePostizPlan(price);
    if (!plan) return { ok: false, error: "Price is not a canonical Postiz price; cannot attach sync metadata." };
    const metadata = buildPostizMetadata(plan, postizUniqueId(ctx.idemScope));
    const sub = await ctx.stripe.createSubscription(
      {
        customerId: p.customerId,
        priceId: p.priceId,
        quantity: p.quantity,
        promotionCodeId,
        trialDays: p.trialDays,
        cancelAtUnix: p.cancelAtUnix,
        cancelIfNoPaymentMethod: p.cancelIfNoPaymentMethod,
        collection: p.collection,
        metadata,
      },
      `panel-subcreate-${p.customerId}-${p.priceId}-${ctx.idemScope}`
    );
    const ends = p.cancelAtUnix ? `, cancels ${cancelDate(p.cancelAtUnix)}` : "";
    return { ok: true, text: `Subscription ${sub.id} created (${sub.status}, Postiz sync ${plan.tier}/${plan.period}${ends}).` };
  },
});

interface SubscriptionRepairSyncParams {
  subscriptionId: string;
}

// Stamps the Postiz sync contract (service/billing/period/uniqueId) onto a
// subscription whose metadata is missing or wrong. The metadata-only update
// fires customer.subscription.updated, so the platform re-syncs the org's
// tier immediately — and a later cancel actually downgrades it instead of
// being dropped by the webhook's service gate. Tier is DERIVED from the
// item's price; non-canonical prices are unrepairable by design.
const subscriptionRepairSync = defineAction<SubscriptionRepairSyncParams>({
  key: "subscription.repair_sync",
  label: "Repair Postiz sync metadata",
  group: "Subscriptions",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const subscriptionId = o ? idWithPrefix(o.subscriptionId, "sub_") : null;
    if (!subscriptionId) return { ok: false, error: "subscriptionId (sub_…) required" };
    return { ok: true, params: { subscriptionId } };
  },
  summarize: (p) => `Repair Postiz sync metadata on ${p.subscriptionId} (tier derived from its price)`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
    if (sub.status === "canceled") return "Subscription is already canceled; nothing left to sync.";
    if (postizSyncStatus(sub) === "synced") return "Subscription already carries correct Postiz sync metadata.";
    const price = sub.items.data[0]?.price;
    if (!price || !derivePostizPlan(price)) {
      return "This subscription's price is not a canonical Postiz price; the tier cannot be derived, so it cannot be synced. Move it to a canonical price first.";
    }
    return null;
  },
  execute: async (ctx, p) => {
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    const price = sub.items.data[0]?.price;
    const plan = price ? derivePostizPlan(price) : null;
    if (!plan) return { ok: false, error: "Price is not a canonical Postiz price; tier cannot be derived." };
    const uniqueId = sub.metadata?.uniqueId || postizUniqueId(ctx.idemScope);
    await ctx.stripe.updateSubscriptionMetadata(
      p.subscriptionId,
      buildPostizMetadata(plan, uniqueId),
      `panel-subrepair-${p.subscriptionId}-${ctx.idemScope}`
    );
    return {
      ok: true,
      text: `Postiz sync metadata repaired on ${p.subscriptionId}: service gitroom, billing ${plan.tier}, period ${plan.period}, uniqueId ${uniqueId}. The platform re-syncs on the update event.`,
    };
  },
});

interface SubscriptionResyncPlatformParams {
  subscriptionId: string;
}

// Forces the platform to re-read a subscription whose Stripe metadata is
// already correct but whose tier never landed on the organization.
//
// Distinct from subscription.repair_sync, which REFUSES once the metadata
// agrees with the price — from Stripe's side alone that case looks perfectly
// healthy. Only the platform's own record of the organization's tier reveals
// the disagreement, so this action is gated on a live drift check rather than
// on anything visible in Stripe.
//
// The re-stamp writes a changing marker alongside the canonical contract:
// Stripe emits customer.subscription.updated only when something actually
// changed, so an identical write would be a silent no-op.
const subscriptionResyncPlatform = defineAction<SubscriptionResyncPlatformParams>({
  key: "subscription.resync_platform",
  label: "Force platform re-sync (plan drift)",
  group: "Subscriptions",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const subscriptionId = o ? idWithPrefix(o.subscriptionId, "sub_") : null;
    if (!subscriptionId) return { ok: false, error: "subscriptionId (sub_…) required" };
    return { ok: true, params: { subscriptionId } };
  },
  summarize: (p) => `Force the platform to re-read ${p.subscriptionId} (fixes a tier that never applied)`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    if (!ctx.postizDrift) return "The Postiz platform lookup is not configured, so drift cannot be confirmed.";
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
    const customer = await ctx.stripe.getCustomer(cus);
    if (!customer) return "Stripe customer is not readable.";

    // Re-confirmed immediately before executing: this writes to live billing
    // on the strength of an identity match, so a stale verdict is not enough.
    const report = await ctx.postizDrift.check(sub, customer);
    if (report.verdict === "in_sync") return "Platform and Stripe already agree; nothing to re-sync.";
    if (report.verdict === "stripe_unsynced") {
      return "The Stripe metadata itself is wrong. Use Repair Postiz sync metadata instead.";
    }
    if (report.verdict === "unknown") return `Drift could not be confirmed: ${report.detail}`;
    return null;
  },
  execute: async (ctx, p) => {
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    const price = sub.items.data[0]?.price;
    const plan = price ? derivePostizPlan(price) : null;
    if (!plan) return { ok: false, error: "Price is not a canonical Postiz price; tier cannot be derived." };
    // The existing uniqueId is preserved: the platform stores it as the
    // subscription identifier, so a new one would orphan its record.
    const uniqueId = sub.metadata?.uniqueId || postizUniqueId(ctx.idemScope);
    await ctx.stripe.updateSubscriptionMetadata(
      p.subscriptionId,
      { ...buildPostizMetadata(plan, uniqueId), resyncedAt: String(Math.floor(Date.now() / 1000)) },
      `panel-subresync-${p.subscriptionId}-${ctx.idemScope}`
    );
    return {
      ok: true,
      text: `Re-stamped ${p.subscriptionId} as ${plan.tier} ${plan.period}. The platform re-syncs the organization on the update event; re-check the drift badge in a moment.`,
    };
  },
});

interface SubscriptionItemsParams {
  subscriptionId: string;
  op: "add" | "remove";
  priceId?: string; // add
  itemId?: string; // remove
  quantity?: number; // add
}

// Grow/shrink a multi-item subscription. Both directions prorate; the
// panel gates them behind the same mandatory preview as plan changes.
const subscriptionItems = defineAction<SubscriptionItemsParams>({
  key: "subscription.items",
  label: "Add / remove subscription item",
  group: "Subscriptions",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const subscriptionId = o ? idWithPrefix(o.subscriptionId, "sub_") : null;
    const op = o && (o.op === "add" || o.op === "remove") ? o.op : null;
    if (!subscriptionId || !op) return { ok: false, error: "subscriptionId (sub_…) and op (add|remove) required" };
    const priceId = idWithPrefix(o!.priceId, "price_") ?? undefined;
    const itemId = idWithPrefix(o!.itemId, "si_") ?? undefined;
    if (op === "add" && !priceId) return { ok: false, error: "priceId (price_…) required to add an item" };
    if (op === "remove" && !itemId) return { ok: false, error: "itemId (si_…) required to remove an item" };
    return { ok: true, params: { subscriptionId, op, priceId, itemId, quantity: posInt(o!.quantity) ?? undefined } };
  },
  summarize: (p) =>
    p.op === "add"
      ? `Add ${p.priceId}${p.quantity ? ` ×${p.quantity}` : ""} to ${p.subscriptionId} (with prorations)`
      : `Remove item ${p.itemId} from ${p.subscriptionId} (with prorations)`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
    if (sub.status !== "active" && sub.status !== "trialing") return `Subscription is ${sub.status}, not changeable.`;
    if (p.op === "add") {
      if (sub.items.data.some((it) => it.price?.id === p.priceId)) return "That price is already on this subscription.";
      const price = await ctx.stripe.getPrice(p.priceId!).catch(() => null);
      if (!price || !price.recurring) return "Price does not exist or is not recurring.";
      if (!price.active) return "Price is archived.";
      const allowlist = ctx.settingsStore.allowedPriceIds();
      if (allowlist.length > 0 && !allowlist.includes(p.priceId!)) return "Price is not on the plan allowlist (/config → Billing).";
      return null;
    }
    if (!sub.items.data.some((it) => it.id === p.itemId)) return "That item does not exist on this subscription.";
    if (sub.items.data.length <= 1) return "Cannot remove the last item; cancel the subscription instead.";
    return null;
  },
  execute: async (ctx, p) => {
    if (p.op === "add") {
      await ctx.stripe.addSubscriptionItem(
        { subscriptionId: p.subscriptionId, priceId: p.priceId!, quantity: p.quantity, prorationBehavior: "create_prorations" },
        `panel-itemadd-${p.subscriptionId}-${p.priceId}-${ctx.idemScope}`
      );
      return { ok: true, text: `Added ${p.priceId}${p.quantity ? ` ×${p.quantity}` : ""} to ${p.subscriptionId} with prorations.` };
    }
    await ctx.stripe.removeSubscriptionItem(
      { subscriptionId: p.subscriptionId, itemId: p.itemId!, prorationBehavior: "create_prorations" },
      `panel-itemrm-${p.subscriptionId}-${p.itemId}-${ctx.idemScope}`
    );
    return { ok: true, text: `Removed item ${p.itemId} from ${p.subscriptionId} with prorations.` };
  },
});

// ---- subscription schedules ----

interface SchedulePhaseParam {
  priceId: string;
  quantity: number;
  durationCount: number;
  durationUnit: "day" | "week" | "month" | "year";
  trial?: boolean;
  proration?: "none" | "create_prorations";
}

interface SubscriptionScheduleOpParams {
  subscriptionId: string;
  op: "set_phases" | "release" | "cancel";
  phases?: SchedulePhaseParam[];
  endBehavior?: "release" | "cancel";
}

const SCHEDULE_MAX_PHASES = 5;
const DURATION_UNITS = new Set(["day", "week", "month", "year"]);

// One action, one /config level, for the whole schedule lifecycle: replace
// future phases / release (sub continues on current terms) / cancel (CANCELS
// THE SUBSCRIPTION — T2 param-aware in Dashboard.ts). Phase 0 is ALWAYS
// rebuilt server-side from the live schedule (rebuildCurrentPhase) — a
// hostile client cannot touch the current phase by construction.
const subscriptionSchedule = defineAction<SubscriptionScheduleOpParams>({
  key: "subscription.schedule",
  label: "Subscription schedule",
  group: "Subscriptions",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const subscriptionId = o ? idWithPrefix(o.subscriptionId, "sub_") : null;
    const op = o && (o.op === "set_phases" || o.op === "release" || o.op === "cancel") ? o.op : null;
    if (!subscriptionId || !op) return { ok: false, error: "subscriptionId (sub_…) and op (set_phases|release|cancel) required" };
    if (op !== "set_phases") return { ok: true, params: { subscriptionId, op } };
    const rawPhases = o && Array.isArray(o.phases) ? o.phases : null;
    if (!rawPhases || rawPhases.length < 1 || rawPhases.length > SCHEDULE_MAX_PHASES) {
      return { ok: false, error: `phases must have 1-${SCHEDULE_MAX_PHASES} entries` };
    }
    const phases: SchedulePhaseParam[] = [];
    for (const entry of rawPhases) {
      const po = obj(entry);
      const priceId = po ? idWithPrefix(po.priceId, "price_") : null;
      const quantity = po ? posInt(po.quantity) : null;
      const durationCount = po ? posInt(po.durationCount) : null;
      const durationUnit = po && typeof po.durationUnit === "string" && DURATION_UNITS.has(po.durationUnit) ? (po.durationUnit as SchedulePhaseParam["durationUnit"]) : null;
      if (!priceId || !quantity || quantity > 999 || !durationCount || durationCount > 36 || !durationUnit) {
        return { ok: false, error: "each phase needs priceId (price_…), quantity 1-999, durationCount 1-36 and durationUnit day|week|month|year" };
      }
      phases.push({
        priceId,
        quantity,
        durationCount,
        durationUnit,
        ...(po!.trial === true ? { trial: true } : {}),
        proration: po!.proration === "none" ? "none" : "create_prorations",
      });
    }
    const endBehavior = o?.endBehavior === "cancel" ? ("cancel" as const) : ("release" as const);
    return { ok: true, params: { subscriptionId, op, phases, endBehavior } };
  },
  summarize: (p) =>
    p.op === "cancel"
      ? `CANCEL the schedule AND subscription ${p.subscriptionId} immediately`
      : p.op === "release"
        ? `Release the schedule on ${p.subscriptionId} (subscription continues on current terms)`
        : `Schedule ${p.phases!.length} future phase(s) on ${p.subscriptionId}, then ${p.endBehavior === "cancel" ? "CANCEL the subscription" : "continue on the last phase's terms"}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
    const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
    if (p.op === "release" || p.op === "cancel") {
      if (!scheduleId) return "No schedule is attached to this subscription.";
      const schedule = await ctx.stripe.getSubscriptionSchedule(scheduleId);
      if (schedule.status !== "active" && schedule.status !== "not_started") {
        return `Schedule is ${schedule.status}, nothing to ${p.op}.`;
      }
      if (p.op === "cancel" && sub.status === "canceled") return "Subscription is already canceled.";
      return null;
    }
    if (sub.status !== "active" && sub.status !== "trialing") return `Subscription is ${sub.status}.`;
    if (scheduleId) {
      const schedule = await ctx.stripe.getSubscriptionSchedule(scheduleId);
      if (schedule.status !== "active" && schedule.status !== "not_started") {
        return `Schedule is ${schedule.status}; release it first.`;
      }
    }
    const allowlist = ctx.settingsStore.allowedPriceIds();
    for (const phase of p.phases!) {
      const price = await ctx.stripe.getPrice(phase.priceId).catch(() => null);
      if (!price) return `Price ${phase.priceId} does not exist.`;
      if (!price.active) return `Price ${phase.priceId} is archived.`;
      if (!price.recurring) return `Price ${phase.priceId} is not recurring.`;
      // Each phase becomes the live price at its boundary — on a gitroom sub
      // every phase must stay derivable or the platform strands on a stale tier.
      if (isGitroomSub(sub) && !derivePostizPlan(price)) {
        return `Price ${phase.priceId} is not a canonical Postiz price; this subscription syncs to Postiz, so every phase must use one.`;
      }
      if (allowlist.length > 0 && !allowlist.includes(phase.priceId)) {
        return `Price ${phase.priceId} is not on the plan allowlist (/config → Billing).`;
      }
    }
    return null;
  },
  execute: async (ctx, p) => {
    const sub = await ctx.stripe.getSubscription(p.subscriptionId);
    let scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
    if (p.op === "release") {
      await ctx.stripe.releaseSchedule(scheduleId!, `panel-schedrel-${p.subscriptionId}-${ctx.idemScope}`);
      return { ok: true, text: `Schedule released: ${p.subscriptionId} continues on its current terms; future phases are discarded.` };
    }
    if (p.op === "cancel") {
      await ctx.stripe.cancelSchedule(scheduleId!, `panel-schedcancel-${p.subscriptionId}-${ctx.idemScope}`);
      return { ok: true, text: `Schedule canceled: subscription ${p.subscriptionId} is now CANCELED.` };
    }
    if (!scheduleId) {
      const created = await ctx.stripe.createScheduleFromSubscription(p.subscriptionId, `panel-schedmk-${p.subscriptionId}-${ctx.idemScope}`);
      scheduleId = created.id;
    }
    const schedule = await ctx.stripe.getSubscriptionSchedule(scheduleId);
    const { phase: currentPhase, unsupported } = rebuildCurrentPhase(schedule);
    if (unsupported.length > 0) {
      return { ok: false, error: `The current phase has settings this editor can't preserve (${unsupported.join("; ")}): edit in the Stripe dashboard.` };
    }
    // On gitroom subs, each future phase carries the sync contract with the
    // billing/period THAT phase's price charges — the phase boundary fires
    // customer.subscription.updated, so scheduled downgrades sync on time.
    const gitroom = isGitroomSub(sub);
    const uniqueId = sub.metadata?.uniqueId || postizUniqueId(ctx.idemScope);
    const futurePhases: Stripe.SubscriptionScheduleUpdateParams.Phase[] = [];
    for (const phase of p.phases!) {
      let metadata: Record<string, string> | undefined;
      if (gitroom) {
        const price = await ctx.stripe.getPrice(phase.priceId).catch(() => null);
        const plan = price ? derivePostizPlan(price) : null;
        if (!plan) return { ok: false, error: `Price ${phase.priceId} is not a canonical Postiz price; cannot keep this subscription synced.` };
        metadata = buildPostizMetadata(plan, uniqueId);
      }
      futurePhases.push({
        items: [{ price: phase.priceId, quantity: phase.quantity }],
        duration: { interval: phase.durationUnit, interval_count: phase.durationCount },
        ...(phase.trial ? { trial: true } : {}),
        proration_behavior: phase.proration ?? "create_prorations",
        ...(metadata ? { metadata } : {}),
      });
    }
    await ctx.stripe.updateSchedulePhases(
      scheduleId,
      { phases: [currentPhase, ...futurePhases], endBehavior: p.endBehavior ?? "release" },
      `panel-sched-${p.subscriptionId}-${ctx.idemScope}`
    );
    return {
      ok: true,
      text: `Scheduled ${p.phases!.length} future phase(s) on ${p.subscriptionId}: after the last phase the subscription ${
        p.endBehavior === "cancel" ? "CANCELS" : "continues on that phase's terms"
      }.`,
    };
  },
});

interface InvoiceCollectParams {
  invoiceId: string;
  op: "send" | "pay";
}

const invoiceCollect = defineAction<InvoiceCollectParams>({
  key: "invoice.collect",
  label: "Send / pay invoice",
  group: "Invoices",
  defaultLevel: "none",
  dangerous: false,
  parseParams: (raw) => {
    const o = obj(raw);
    const invoiceId = o ? idWithPrefix(o.invoiceId, "in_") : null;
    const op = o && (o.op === "send" || o.op === "pay") ? o.op : null;
    if (!invoiceId || !op) return { ok: false, error: "invoiceId (in_…) and op (send|pay) required" };
    return { ok: true, params: { invoiceId, op } };
  },
  summarize: (p) => `${p.op === "send" ? "Send" : "Collect payment for"} invoice ${p.invoiceId}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const invoice = await ctx.stripe.getInvoice(p.invoiceId);
    if (customerIdOf(invoice) !== cus) return "Invoice does not belong to this customer.";
    if (invoice.status !== "open") return `Invoice is ${invoice.status}: only open invoices can be ${p.op === "send" ? "sent" : "paid"} (finalize drafts first).`;
    return null;
  },
  execute: async (ctx, p) => {
    if (p.op === "send") {
      await ctx.stripe.sendInvoice(p.invoiceId, `panel-invsend-${p.invoiceId}-${ctx.idemScope}`);
      return { ok: true, text: `Invoice ${p.invoiceId} sent to the customer.` };
    }
    const paid = await ctx.stripe.payInvoice(p.invoiceId, `panel-invpay-${p.invoiceId}-${ctx.idemScope}`);
    return { ok: true, text: `Invoice ${p.invoiceId} payment attempted: status ${paid.status}.` };
  },
});

interface InvoiceFinalizeParams {
  invoiceId: string;
}

const invoiceFinalize = defineAction<InvoiceFinalizeParams>({
  key: "invoice.finalize",
  label: "Finalize draft invoice",
  group: "Invoices",
  defaultLevel: "none",
  dangerous: false,
  parseParams: (raw) => {
    const o = obj(raw);
    const invoiceId = o ? idWithPrefix(o.invoiceId, "in_") : null;
    return invoiceId ? { ok: true, params: { invoiceId } } : { ok: false, error: "invoiceId (in_…) required" };
  },
  summarize: (p) => `Finalize draft invoice ${p.invoiceId} (it becomes open and collectible)`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const invoice = await ctx.stripe.getInvoice(p.invoiceId);
    if (customerIdOf(invoice) !== cus) return "Invoice does not belong to this customer.";
    if (invoice.status !== "draft") return `Invoice is ${invoice.status}: only drafts can be finalized.`;
    return null;
  },
  execute: async (ctx, p) => {
    const finalized = await ctx.stripe.finalizeInvoice(p.invoiceId, `panel-invfinalize-${p.invoiceId}-${ctx.idemScope}`);
    return { ok: true, text: `Invoice ${p.invoiceId} finalized: status ${finalized.status}.` };
  },
});

interface InvoiceVoidParams {
  invoiceId: string;
  op: "void" | "uncollectible" | "delete_draft";
}

const invoiceVoid = defineAction<InvoiceVoidParams>({
  key: "invoice.void",
  label: "Void / uncollectible / delete draft",
  group: "Invoices",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const invoiceId = o ? idWithPrefix(o.invoiceId, "in_") : null;
    const op = o && (o.op === "void" || o.op === "uncollectible" || o.op === "delete_draft") ? o.op : null;
    if (!invoiceId || !op) return { ok: false, error: "invoiceId (in_…) and op (void|uncollectible|delete_draft) required" };
    return { ok: true, params: { invoiceId, op } };
  },
  summarize: (p) =>
    p.op === "void"
      ? `Void invoice ${p.invoiceId}`
      : p.op === "uncollectible"
        ? `Mark invoice ${p.invoiceId} uncollectible`
        : `Delete draft invoice ${p.invoiceId}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const invoice = await ctx.stripe.getInvoice(p.invoiceId);
    if (customerIdOf(invoice) !== cus) return "Invoice does not belong to this customer.";
    if (p.op === "delete_draft" && invoice.status !== "draft") return `Invoice is ${invoice.status}: only drafts can be deleted.`;
    if (p.op === "void" && invoice.status !== "open" && invoice.status !== "uncollectible") return `Invoice is ${invoice.status}: only open/uncollectible invoices can be voided.`;
    if (p.op === "uncollectible" && invoice.status !== "open") return `Invoice is ${invoice.status}: only open invoices can be marked uncollectible.`;
    return null;
  },
  execute: async (ctx, p) => {
    if (p.op === "void") {
      const invoice = await ctx.stripe.voidInvoice(p.invoiceId, `panel-invvoid-${p.invoiceId}-${ctx.idemScope}`);
      await ctx.moneyOut?.recordWriteOff(invoice, "action").catch(() => undefined);
      exportBillingEvent({
        event: "write_off",
        amountMinor: invoice.amount_due - (invoice.amount_paid ?? 0),
        currency: invoice.currency,
        surface: surfaceOf(ctx),
        reason: "void",
      });
      return { ok: true, text: `Invoice ${p.invoiceId} voided.` };
    }
    if (p.op === "uncollectible") {
      const invoice = await ctx.stripe.markInvoiceUncollectible(p.invoiceId, `panel-invunc-${p.invoiceId}-${ctx.idemScope}`);
      await ctx.moneyOut?.recordWriteOff(invoice, "action").catch(() => undefined);
      exportBillingEvent({
        event: "write_off",
        amountMinor: invoice.amount_due - (invoice.amount_paid ?? 0),
        currency: invoice.currency,
        surface: surfaceOf(ctx),
        reason: "uncollectible",
      });
      return { ok: true, text: `Invoice ${p.invoiceId} marked uncollectible.` };
    }
    await ctx.stripe.deleteDraftInvoice(p.invoiceId, `panel-invdel-${p.invoiceId}-${ctx.idemScope}`);
    return { ok: true, text: `Draft invoice ${p.invoiceId} deleted.` };
  },
});

interface InvoiceCreateDraftParams {
  items: Array<{ description: string; amountMinor: number; currency: string }>;
  daysUntilDue?: number;
  finalize: boolean;
}

const invoiceCreateDraft = defineAction<InvoiceCreateDraftParams>({
  key: "invoice.create_draft",
  label: "Create draft invoice",
  group: "Invoices",
  defaultLevel: "none",
  dangerous: false,
  parseParams: (raw) => {
    const o = obj(raw);
    const rawItems = o && Array.isArray(o.items) ? o.items : null;
    if (!rawItems || rawItems.length < 1 || rawItems.length > 10) return { ok: false, error: "items must have 1-10 entries" };
    const items: InvoiceCreateDraftParams["items"] = [];
    for (const entry of rawItems) {
      const io = obj(entry);
      const description = io ? str(io.description, 300) : null;
      const amountMinor = io ? posInt(io.amountMinor) : null;
      const currency = io ? str(io.currency, 3)?.toLowerCase() : null;
      if (!description || !amountMinor || !currency || !/^[a-z]{3}$/.test(currency)) {
        return { ok: false, error: "each item needs description, positive amountMinor and a 3-letter currency" };
      }
      items.push({ description, amountMinor, currency });
    }
    const daysUntilDue = o ? (posInt(o.daysUntilDue) ?? undefined) : undefined;
    return { ok: true, params: { items, daysUntilDue, finalize: o?.finalize === true } };
  },
  summarize: (p) => `Create ${p.finalize ? "and finalize " : ""}a draft invoice with ${p.items.length} item(s)`,
  revalidate: async (ctx) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const customer = await ctx.stripe.getCustomer(cus);
    if (!customer || customer.deleted) return "Customer no longer exists in Stripe.";
    return null;
  },
  execute: async (ctx, p) => {
    const cus = ctx.stripeCustomerId!;
    const invoice = await ctx.stripe.createDraftInvoice(
      { customerId: cus, collectionMethod: "send_invoice", daysUntilDue: p.daysUntilDue },
      `panel-invcreate-${ctx.idemScope}`
    );
    for (let i = 0; i < p.items.length; i++) {
      const item = p.items[i];
      await ctx.stripe.createInvoiceItem(
        { customerId: cus, invoiceId: invoice.id!, amountMinor: item.amountMinor, currency: item.currency, description: item.description },
        `panel-invitem-${i}-${ctx.idemScope}`
      );
    }
    if (p.finalize) {
      await ctx.stripe.finalizeInvoice(invoice.id!, `panel-invfin-${ctx.idemScope}`);
      return { ok: true, text: `Invoice ${invoice.id} created and finalized (${p.items.length} item(s)).` };
    }
    return { ok: true, text: `Draft invoice ${invoice.id} created (${p.items.length} item(s)).` };
  },
});

interface InvoiceCreditNoteParams {
  invoiceId: string;
  amountMinor: number;
  mode: "refund" | "credit" | "out_of_band";
  memo?: string;
}

const invoiceCreditNote = defineAction<InvoiceCreditNoteParams>({
  key: "invoice.credit_note",
  label: "Credit note",
  group: "Invoices",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const invoiceId = o ? idWithPrefix(o.invoiceId, "in_") : null;
    const amountMinor = o ? posInt(o.amountMinor) : null;
    const mode = o && (o.mode === "refund" || o.mode === "credit" || o.mode === "out_of_band") ? o.mode : "credit";
    if (!invoiceId || !amountMinor) return { ok: false, error: "invoiceId (in_…) and positive amountMinor required" };
    return { ok: true, params: { invoiceId, amountMinor, mode, memo: str(o!.memo, 400) ?? undefined } };
  },
  summarize: (p) => `Credit note on ${p.invoiceId}: ${p.amountMinor} minor units as ${p.mode}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const invoice = await ctx.stripe.getInvoice(p.invoiceId);
    if (customerIdOf(invoice) !== cus) return "Invoice does not belong to this customer.";
    try {
      await ctx.stripe.previewCreditNote({
        invoiceId: p.invoiceId,
        ...(p.mode === "refund"
          ? { refundAmountMinor: p.amountMinor }
          : p.mode === "credit"
            ? { creditAmountMinor: p.amountMinor }
            : { outOfBandAmountMinor: p.amountMinor }),
      });
    } catch (e) {
      return `Credit note preview failed: ${errText(e)}`;
    }
    return null;
  },
  execute: async (ctx, p) => {
    const note = await ctx.stripe.createCreditNote(
      { invoiceId: p.invoiceId, amountMinor: p.amountMinor, mode: p.mode, memo: p.memo },
      `panel-creditnote-${p.invoiceId}-${p.amountMinor}-${ctx.idemScope}`
    );
    // Concession: no balance transaction exists for the credited portion, so
    // this action is the only place it can be booked. A refund-mode note also
    // produces a real refund — the classifier subtracts that half so cash and
    // concession never double-count the same money.
    await ctx.moneyOut?.recordCreditNote(note, "action").catch(() => undefined);
    exportBillingEvent({
      event: "credit_note",
      amountMinor: note.total,
      currency: note.currency,
      surface: surfaceOf(ctx),
      reason: p.mode,
    });
    return { ok: true, text: `Credit note ${note.id} created on ${p.invoiceId} (${fmt(ctx.stripe, note.total, note.currency)}).` };
  },
});

interface CustomerCouponParams {
  // apply targets a subscription; remove targets a subscription OR the
  // customer-level discount (exactly one id present).
  subscriptionId?: string;
  customerId?: string;
  op: "apply" | "remove";
  promoCode?: string;
  couponId?: string;
}

const customerCoupon = defineAction<CustomerCouponParams>({
  key: "customer.coupon",
  label: "Apply / remove coupon",
  group: "Customer",
  defaultLevel: "none",
  dangerous: false, // remove is T1 param-aware in Dashboard.ts (needsConfirm)
  parseParams: (raw) => {
    const o = obj(raw);
    // op defaults to "apply" so legacy payloads (Intercom canvas) keep working.
    const op = o?.op === "remove" ? ("remove" as const) : ("apply" as const);
    const subscriptionId = o ? (idWithPrefix(o.subscriptionId, "sub_") ?? undefined) : undefined;
    if (op === "apply") {
      const promoCode = o ? (str(o.promoCode, 100) ?? undefined) : undefined;
      const couponId = o ? (str(o.couponId, 100) ?? undefined) : undefined;
      if (!subscriptionId || (!promoCode && !couponId)) return { ok: false, error: "subscriptionId (sub_…) and promoCode or couponId required" };
      return { ok: true, params: { subscriptionId, op, promoCode, couponId } };
    }
    const customerId = o ? (idWithPrefix(o.customerId, "cus_") ?? undefined) : undefined;
    if (!subscriptionId === !customerId) {
      return { ok: false, error: "remove needs exactly one of subscriptionId (sub_…) or customerId (cus_…)" };
    }
    return { ok: true, params: { op, subscriptionId, customerId } };
  },
  summarize: (p) =>
    p.op === "remove"
      ? `Remove the discount from ${p.subscriptionId ?? "the customer"}`
      : `Apply ${p.promoCode ? `promo code ${p.promoCode}` : `coupon ${p.couponId}`} to ${p.subscriptionId}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    if (p.op === "remove") {
      if (p.subscriptionId) {
        const sub = await ctx.stripe.getSubscription(p.subscriptionId);
        if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
        if ((sub.discounts?.length ?? 0) === 0) return "No discount on this subscription.";
        return null;
      }
      if (p.customerId !== cus) return "Customer id does not match the bound customer.";
      const customer = await ctx.stripe.getCustomer(cus);
      if (!customer || customer.deleted) return "Customer no longer exists in Stripe.";
      if (!customer.discount) return "No customer-level discount.";
      return null;
    }
    const sub = await ctx.stripe.getSubscription(p.subscriptionId!);
    if (customerIdOf(sub) !== cus) return "Subscription does not belong to this customer.";
    if (sub.status !== "active" && sub.status !== "trialing") return `Subscription is ${sub.status}.`;
    if (p.promoCode) {
      const codes = await ctx.stripe.findPromotionCodes(p.promoCode);
      if (!codes.some((c) => c.active)) return "Promo code not found or inactive.";
    }
    return null;
  },
  execute: async (ctx, p) => {
    if (p.op === "remove") {
      if (p.subscriptionId) {
        await ctx.stripe.removeSubscriptionDiscount(p.subscriptionId);
        return { ok: true, text: `Discount removed from ${p.subscriptionId}. (A customer-level discount, if any, still applies.)` };
      }
      await ctx.stripe.removeCustomerDiscount(ctx.stripeCustomerId!);
      return { ok: true, text: "Customer-level discount removed." };
    }
    let couponId = p.couponId;
    let label = p.couponId ?? "";
    if (p.promoCode) {
      const codes = await ctx.stripe.findPromotionCodes(p.promoCode);
      const active = codes.find((c) => c.active);
      if (!active) return { ok: false, error: "Promo code not found or inactive." };
      const coupon = active.promotion.coupon;
      if (!coupon) return { ok: false, error: "Promo code carries no coupon." };
      couponId = typeof coupon === "string" ? coupon : coupon.id;
      label = `promo ${p.promoCode}`;
    }
    await ctx.stripe.applyDiscountCoupon(p.subscriptionId!, couponId!, `panel-coupon-${p.subscriptionId}-${couponId}-${ctx.idemScope}`);
    // Attribution only. The concession itself is booked from the
    // customer.discount.created webhook, which is the first point that knows
    // the discount id (needed as the ledger key) and can price the coupon
    // against the upcoming invoice — neither is knowable here.
    exportBillingEvent({
      event: "discount",
      surface: surfaceOf(ctx),
      reason: label || couponId || null,
    });
    return { ok: true, text: `Applied ${label || `coupon ${couponId}`} to ${p.subscriptionId}.` };
  },
});

interface CustomerBalanceParams {
  deltaMinor: number;
  currency: string;
  note?: string;
}

const customerBalance = defineAction<CustomerBalanceParams>({
  key: "customer.balance",
  label: "Adjust customer balance",
  group: "Customer",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const deltaMinor = o ? intAny(o.deltaMinor) : null;
    const currency = o ? str(o.currency, 3)?.toLowerCase() : null;
    if (!deltaMinor || !currency || !/^[a-z]{3}$/.test(currency)) {
      return { ok: false, error: "non-zero integer deltaMinor and 3-letter currency required" };
    }
    return { ok: true, params: { deltaMinor, currency, note: str(o!.note, 300) ?? undefined } };
  },
  summarize: (p) =>
    `${p.deltaMinor < 0 ? "Credit" : "Debit"} the customer balance by ${Math.abs(p.deltaMinor)} minor units ${p.currency.toUpperCase()}` +
    (p.note ? ` (${p.note})` : ""),
  revalidate: async (ctx) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const customer = await ctx.stripe.getCustomer(cus);
    if (!customer || customer.deleted) return "Customer no longer exists in Stripe.";
    return null;
  },
  execute: async (ctx, p) => {
    const txn = await ctx.stripe.adjustCustomerBalance(
      ctx.stripeCustomerId!,
      p.deltaMinor,
      p.currency,
      p.note ?? `Support adjustment via ${ctx.actor.kind} panel (${ctx.actor.name})`,
      `panel-balance-${p.deltaMinor}-${p.currency}-${ctx.idemScope}`
    );
    // Only a CREDIT is money out (the customer owes us less). A debit is the
    // opposite and is dropped by the classifier.
    await ctx.moneyOut
      ?.recordBalanceConcession({
        id: txn.id,
        category: "balance_credit",
        customerId: ctx.stripeCustomerId,
        currency: p.currency,
        amountMinor: p.deltaMinor,
        reason: p.note ?? null,
        source: "action",
      })
      .catch(() => undefined);
    if (p.deltaMinor < 0) {
      exportBillingEvent({
        event: "balance_credit",
        amountMinor: Math.abs(p.deltaMinor),
        currency: p.currency,
        surface: surfaceOf(ctx),
      });
    }
    return { ok: true, text: `Balance adjusted by ${fmt(ctx.stripe, p.deltaMinor, p.currency)} (txn ${txn.id}).` };
  },
});

interface CustomerPaymentMethodParams {
  // pm_… everywhere; op "attach" also accepts a card token (tok_…) which is
  // first minted into a PaymentMethod server-side.
  paymentMethodId: string;
  op: "detach" | "set_default" | "attach";
  makeDefault?: boolean;
}

const customerPaymentMethod = defineAction<CustomerPaymentMethodParams>({
  key: "customer.payment_method",
  label: "Payment methods",
  group: "Customer",
  defaultLevel: "none",
  dangerous: false,
  parseParams: (raw) => {
    const o = obj(raw);
    const op = o && (o.op === "detach" || o.op === "set_default" || o.op === "attach") ? o.op : null;
    const paymentMethodId = o
      ? op === "attach"
        ? (idWithPrefix(o.paymentMethodId, "pm_") ?? idWithPrefix(o.paymentMethodId, "tok_"))
        : idWithPrefix(o.paymentMethodId, "pm_")
      : null;
    if (!paymentMethodId || !op) {
      return { ok: false, error: "paymentMethodId (pm_…, attach also tok_…) and op (detach|set_default|attach) required" };
    }
    return { ok: true, params: { paymentMethodId, op, makeDefault: o?.makeDefault === true } };
  },
  summarize: (p) =>
    p.op === "attach"
      ? `Attach payment method ${p.paymentMethodId}${p.makeDefault ? " and set as default" : ""}`
      : `${p.op === "detach" ? "Detach" : "Set as default"} payment method ${p.paymentMethodId}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    if (p.op === "attach") {
      const customer = await ctx.stripe.getCustomer(cus);
      if (!customer || customer.deleted) return "Customer no longer exists in Stripe.";
      if (p.paymentMethodId.startsWith("pm_")) {
        const pm = await ctx.stripe.getPaymentMethod(p.paymentMethodId).catch(() => null);
        if (!pm) return "Payment method does not exist.";
        const owner = typeof pm.customer === "string" ? pm.customer : pm.customer?.id ?? null;
        if (owner && owner !== cus) return "Payment method belongs to a different customer.";
      }
      return null;
    }
    const methods = await ctx.stripe.listAllPaymentMethods(cus);
    if (!methods.some((m) => m.id === p.paymentMethodId)) return "Payment method is not attached to this customer.";
    return null;
  },
  execute: async (ctx, p) => {
    if (p.op === "attach") {
      let pmId = p.paymentMethodId;
      if (pmId.startsWith("tok_")) {
        const created = await ctx.stripe.createPaymentMethodFromToken(pmId, `panel-pmtok-${ctx.idemScope}`);
        pmId = created.id;
      }
      const pm = await ctx.stripe.attachPaymentMethod(pmId, ctx.stripeCustomerId!);
      if (p.makeDefault) await ctx.stripe.setDefaultPaymentMethod(ctx.stripeCustomerId!, pm.id);
      const label = pm.type === "card" && pm.card ? `${pm.card.brand} ···· ${pm.card.last4}` : pm.id;
      return { ok: true, text: `Payment method ${label} (${pm.id}) attached${p.makeDefault ? " and set as default" : ""}.` };
    }
    if (p.op === "detach") {
      await ctx.stripe.detachPaymentMethod(p.paymentMethodId);
      return { ok: true, text: `Payment method ${p.paymentMethodId} detached.` };
    }
    await ctx.stripe.setDefaultPaymentMethod(ctx.stripeCustomerId!, p.paymentMethodId);
    return { ok: true, text: `Payment method ${p.paymentMethodId} set as default.` };
  },
});

interface ChargeCreateParams {
  amountMinor: number;
  currency: string;
  paymentMethodId?: string;
  description?: string;
}

// Off-session charge of a SAVED payment method (no customer present). The
// hardest new money primitive: T1 typed-CONFIRM via `dangerous` plus an
// unconditional T2 step-up in Dashboard.ts.
const chargeCreate = defineAction<ChargeCreateParams>({
  key: "charge.create",
  label: "Charge saved payment method",
  group: "Charges",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const amountMinor = o ? posInt(o.amountMinor) : null;
    const currency = o ? str(o.currency, 3)?.toLowerCase() : null;
    if (!amountMinor || !currency || !/^[a-z]{3}$/.test(currency)) {
      return { ok: false, error: "positive amountMinor and 3-letter currency required" };
    }
    return {
      ok: true,
      params: {
        amountMinor,
        currency,
        paymentMethodId: idWithPrefix(o!.paymentMethodId, "pm_") ?? undefined,
        description: str(o!.description, 300) ?? undefined,
      },
    };
  },
  summarize: (p, stripe) =>
    `Charge ${fmt(stripe, p.amountMinor, p.currency)} off-session to ${p.paymentMethodId ?? "the default payment method"}`,
  revalidate: async (ctx, p) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const customer = await ctx.stripe.getCustomer(cus);
    if (!customer || customer.deleted) return "Customer no longer exists in Stripe.";
    if (p.paymentMethodId) {
      const methods = await ctx.stripe.listAllPaymentMethods(cus);
      if (!methods.some((m) => m.id === p.paymentMethodId)) return "Payment method is not attached to this customer.";
    } else if (!customer.invoice_settings?.default_payment_method && !customer.default_source) {
      return "Customer has no default payment method: pick a saved card explicitly.";
    }
    return null;
  },
  execute: async (ctx, p) => {
    const pi = await ctx.stripe.createManualPaymentIntent(
      {
        customerId: ctx.stripeCustomerId!,
        amountMinor: p.amountMinor,
        currency: p.currency,
        paymentMethodId: p.paymentMethodId,
        description: p.description ?? `Off-session charge via ${ctx.actor.kind} panel (${ctx.actor.name})`,
      },
      `panel-charge-${p.amountMinor}-${p.currency}-${ctx.idemScope}`
    );
    return { ok: true, text: `Charged ${fmt(ctx.stripe, p.amountMinor, p.currency)}: payment intent ${pi.id} (${pi.status}).` };
  },
});

interface CustomerBlockParams {
  reason: string;
  cancelSubs: boolean;
  kinds: BlockKind[];
}

const customerBlock = defineAction<CustomerBlockParams>({
  key: "customer.block",
  label: "Blocklist customer",
  group: "Customer",
  defaultLevel: "none",
  dangerous: true,
  parseParams: (raw) => {
    const o = obj(raw);
    const reason = o ? str(o.reason, 300) : null;
    if (!reason) return { ok: false, error: "reason required" };
    const kindsRaw = o && Array.isArray(o.kinds) ? o.kinds : ["customer_id", "email"];
    const kinds = kindsRaw.filter((k): k is BlockKind => (BLOCK_KINDS as string[]).includes(k as string));
    if (kinds.length === 0) return { ok: false, error: "at least one valid kind required" };
    return { ok: true, params: { reason, cancelSubs: o?.cancelSubs === true, kinds } };
  },
  summarize: (p) => `Blocklist the customer (${p.kinds.join(", ")})${p.cancelSubs ? " and cancel all subscriptions" : ""}: ${p.reason}`,
  revalidate: async (ctx) => {
    const cus = requireCustomer(ctx);
    if (!cus) return "No linked Stripe customer.";
    const customer = await ctx.stripe.getCustomer(cus);
    if (!customer || customer.deleted) return "Customer no longer exists in Stripe.";
    return null;
  },
  execute: async (ctx, p) => {
    const cus = ctx.stripeCustomerId!;
    const customer = await ctx.stripe.getCustomer(cus);
    const entries: BlockEntry[] = [];
    if (p.kinds.includes("customer_id")) entries.push({ kind: "customer_id", value: cus });
    if (p.kinds.includes("email") && customer && !customer.deleted && customer.email) {
      entries.push({ kind: "email", value: customer.email });
    }
    if (entries.length === 0) return { ok: false, error: "No blockable identifiers resolved (customer has no email?)." };
    const results = await ctx.blockService.block(entries, {
      reason: p.reason,
      source: "manual",
      actorId: ctx.actor.id,
      actorName: ctx.actor.name,
      customerId: cus,
      cancelSubs: p.cancelSubs,
    });
    const lines = results.map((r) =>
      r.ok ? `${r.kind}: ${r.alreadyBlocked ? "already blocked" : "blocked"}${r.cancelledSubs?.length ? `, cancelled ${r.cancelledSubs.length} sub(s)` : ""}` : `${r.kind}: FAILED (${r.error})`
    );
    return { ok: true, text: `Blocklist result: ${lines.join("; ")}.` };
  },
});

export const BILLING_ACTIONS: BillingActionDef[] = [
  chargeReview,
  refundFull,
  refundPartial,
  refundFraud,
  paymentIntentCancel,
  paymentIntentCapture,
  chargeCreate,
  subscriptionCancel,
  subscriptionPauseResume,
  subscriptionChangePlan,
  subscriptionTerms,
  subscriptionCreate,
  subscriptionRepairSync,
  subscriptionResyncPlatform,
  subscriptionItems,
  subscriptionSchedule,
  invoiceCollect,
  invoiceFinalize,
  invoiceVoid,
  invoiceCreateDraft,
  invoiceCreditNote,
  customerCoupon,
  customerBalance,
  customerPaymentMethod,
  customerBlock,
];

export function actionByKey(key: string): BillingActionDef | null {
  return BILLING_ACTIONS.find((a) => a.key === key) ?? null;
}
