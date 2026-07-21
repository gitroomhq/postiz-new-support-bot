import type Stripe from "stripe";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { FraudHuntService } from "../../bot/billing/FraudHuntService";
import { ActionButton, ActionResult, Badge, Block, Cell, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str } from "./types";
import { amount, cardCell, dateCell, idCell, sentence, text } from "./cells";

// Fraud tools (#/fraud, Operate group): the Radar manual-review queue (
// approve closes the review; "decline" = the existing fraud-refund / PI-cancel
// registry ladder), the recent early-fraud-warning feed, plus the three
// account-wide hunts extracted into FraudHuntService — by card fingerprint
// (multi-account picture), by last4+brand+status (grouped by fingerprint;
// "failed" narrows to declined attempts and their PaymentIntents) and by
// amount (PaymentIntents — catches attempts that never produced any
// charge). Hunt inputs ride the hash filters, validated hard server-side;
// hunts NEVER run inside revalidators (the Search API lags ~1 min and must
// not gate money movement).

const SEARCH_LAG_NOTICE = "Stripe Search data can lag ~1 minute behind reality.";
const REVIEW_ID_RE = /^prv_[A-Za-z0-9]{1,64}$/;

export function makeFraudSection(deps: { hunts: FraudHuntService }): DashboardSectionModule {
  return {
    nav: [{ key: "fraud", label: "Fraud tools", page: "fraud", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "fraud";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      const filters = req.filters ?? {};
      const view =
        filters.view === "card" || filters.view === "amount" || filters.view === "reviews" ? filters.view : "";
      const blocks: Block[] = [];
      blocks.push({
        type: "tabs",
        key: "view",
        value: view || undefined,
        items: [
          { value: "", label: "Early fraud warnings" },
          { value: "reviews", label: "Reviews" },
          { value: "card", label: "Hunt by card" },
          { value: "amount", label: "Hunt by amount" },
        ],
      });
      if (view === "card") blocks.push(...(await cardHunts(ctx, deps, filters)));
      else if (view === "amount") blocks.push(...(await amountHunt(ctx, deps, filters)));
      else if (view === "reviews") blocks.push(await reviewsTable(ctx));
      else blocks.push(await efwTable(ctx));
      return { title: "Fraud tools", crumbs: [{ label: "Fraud tools" }], blocks };
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      // T1 — approve (close) a Radar review: "this payment is fine". The
      // review state is re-read live so an already-closed review is a no-op
      // refusal, never a silent success.
      if (req.key === "section:fraud.review_approve") {
        if (req.confirmWord !== "CONFIRM") return { ok: false, error: "Type CONFIRM to run this action." };
        const id = typeof req.params?.id === "string" && REVIEW_ID_RE.test(req.params.id) ? req.params.id : null;
        if (!id) return { ok: false, error: "Bad review id (prv_…)." };
        const review = await ctx.stripe.getReview(id).catch(() => null);
        if (!review) return { ok: false, error: "This review does not exist." };
        if (!review.open) return { ok: false, error: "Review is already closed." };
        await ctx.stripe.approveReview(id, `dash-review-${id}`);
        await ctx.audit(`Radar review ${id} approved`);
        return { ok: true, text: `Review ${id} approved; the payment is released from the queue.` };
      }
      return { ok: false, error: "Unknown action." };
    },
  };
}

function actionActor(ctx: DashboardCtx): ActionActor {
  return { kind: "dashboard", id: ctx.actor.id, name: ctx.actor.name, isAdmin: ctx.actor.isAdmin };
}

// Advisory render mode for a registry button (decline path) — execution
// re-checks server-side regardless.
function registryButton(ctx: DashboardCtx, button: ActionButton): ActionButton {
  const mode = ctx.billing.actions.effectiveMode(button.key, actionActor(ctx));
  if (mode === "denied") return { ...button, disabledReason: "Disabled by /config → Billing → Intercom Actions." };
  return { ...button, mode: mode === "queue" ? "queue" : "direct" };
}

// ---- Radar review queue ----

async function reviewsTable(ctx: DashboardCtx): Promise<Block> {
  const res = await ctx.stripe.listOpenReviews({ limit: 25 }).catch(() => ({ reviews: [] as Stripe.Review[], hasMore: false }));
  const rows = res.reviews.map((review) => {
    const charge = review.charge && typeof review.charge === "object" ? (review.charge as Stripe.Charge) : null;
    const chargeId = charge?.id ?? (typeof review.charge === "string" ? review.charge : null);
    const piId = typeof review.payment_intent === "string" ? review.payment_intent : review.payment_intent?.id ?? null;
    const remaining = charge ? charge.amount - (charge.amount_refunded ?? 0) : 0;
    const actions: ActionButton[] = [
      {
        key: "section:fraud.review_approve",
        label: "Approve",
        style: "primary",
        dangerous: true,
        params: { id: review.id },
        summary: "Closes the review as legitimate; the payment stays as it is.",
      },
      ...(charge && !charge.refunded && remaining > 0
        ? [
            registryButton(ctx, {
              key: "charge.refund_fraud",
              label: "Refund as fraud",
              style: "danger",
              dangerous: true,
              stepUp: true,
              params: { chargeId: charge.id, amountMinor: remaining },
              summary: `Refunds the remaining ${ctx.stripe.formatAmount(remaining, charge.currency)} as FRAUDULENT (feeds Radar), the decline path for this review.`,
            }),
          ]
        : !charge && piId
          ? [
              registryButton(ctx, {
                key: "payment_intent.cancel",
                label: "Cancel payment",
                style: "danger",
                params: { paymentIntentId: piId },
                summary: "Cancels the uncaptured payment intent, the decline path for this review.",
              }),
            ]
          : []),
    ];
    return {
      id: review.id,
      ...(chargeId ? { ref: { page: "payments.detail", params: { id: chargeId } } } : {}),
      cells: [
        charge
          ? amount(ctx.stripe, charge.amount, charge.currency, { kind: "warn", text: "In review" })
          : text(piId ?? "N/A"),
        text(sentence((review.opened_reason ?? "rule").replace(/_/g, " "))),
        chargeId ? idCell(chargeId, { ref: { page: "payments.detail", params: { id: chargeId } } }) : text("N/A"),
        dateCell(review.created),
        idCell(review.id, { copy: true }),
      ] as Cell[],
      actions,
    };
  });
  return {
    type: "table",
    key: "reviews",
    title: "Radar review queue",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Opened by" },
      { key: "charge", label: "Charge" },
      { key: "opened", label: "Opened" },
      { key: "id", label: "Review" },
    ],
    rows,
    empty: "No open reviews. 🎉",
    ...(rows.length ? { footer: `${rows.length}${res.hasMore ? "+" : ""} open review${rows.length === 1 ? "" : "s"}` } : {}),
    notice:
      "Approve releases the payment from the queue; the decline path is a fraud refund (charge) or a payment cancel (uncaptured) through the normal action ladder. Open the charge for full context.",
  };
}

// ---- EFW feed ----

async function efwTable(ctx: DashboardCtx): Promise<Block> {
  const efws = await ctx.stripe.listRecentEarlyFraudWarnings(100).catch(() => [] as Stripe.Radar.EarlyFraudWarning[]);
  const rows = efws.map((w) => {
    const chargeId = typeof w.charge === "string" ? w.charge : w.charge.id;
    return {
      id: w.id,
      ref: { page: "payments.detail", params: { id: chargeId } },
      cells: [
        { t: "badge", b: { kind: w.actionable ? "error" : "neutral", text: w.actionable ? "Actionable" : "Not actionable" } as Badge } as Cell,
        text(sentence((w.fraud_type ?? "unknown").replace(/_/g, " "))),
        idCell(chargeId, { ref: { page: "payments.detail", params: { id: chargeId } } }),
        dateCell(w.created),
        idCell(w.id, { copy: true }),
      ] as Cell[],
    };
  });
  return {
    type: "table",
    key: "efws",
    title: "Early fraud warnings",
    columns: [
      { key: "actionable", label: "" },
      { key: "type", label: "Fraud type" },
      { key: "charge", label: "Charge" },
      { key: "created", label: "Reported" },
      { key: "id", label: "ID" },
    ],
    rows,
    empty: "No early fraud warnings in the recent window. 🎉",
    ...(rows.length ? { footer: `${rows.length} warning${rows.length === 1 ? "" : "s"}` } : {}),
    notice: `Latest ${efws.length || 100} EFWs from the card networks. Actionable = a refund can still prevent the dispute. Open the charge to refund or block.`,
  };
}

// ---- card hunts (fingerprint exact + last4 grouped) ----

async function cardHunts(ctx: DashboardCtx, deps: { hunts: FraudHuntService }, filters: Record<string, string>): Promise<Block[]> {
  const fingerprint = str(filters.fp, 64);
  const last4 = str(filters.last4, 4);
  const brand = str(filters.brand, 20);
  const status = str(filters.status, 9);
  const blocks: Block[] = [];

  // Fingerprint hunt: exact card identity across every customer.
  const fpTable: TableBlock = {
    type: "table",
    key: "fphunt",
    title: "Same card, every account",
    filters: [{ key: "fp", label: "Card fingerprint", kind: "search", value: fingerprint || undefined, placeholder: "Card fingerprint (e.g. Xt5EWLLDS7FJjR1c) · exact match across all customers" }],
    columns: [
      { key: "customer", label: "Customer" },
      { key: "email", label: "Email" },
      { key: "charges", label: "Charges", align: "right" },
      { key: "discord", label: "Discord link" },
    ],
    rows: [],
    empty: fingerprint ? "No charges match that fingerprint." : "Enter a card fingerprint; you'll find it on any payment's detail rail.",
    notice: SEARCH_LAG_NOTICE,
  };
  if (fingerprint) {
    const result = await deps.hunts.usersByFingerprint(fingerprint);
    if (!result.ok) {
      blocks.push({ type: "notice", badge: { kind: "error", text: "Invalid" }, text: result.error });
    } else {
      fpTable.rows = result.rows.map((r) => ({
        id: r.customerId,
        ...(r.customerId.startsWith("cus_") ? { ref: { page: "customers.detail", params: { id: r.customerId } } } : {}),
        cells: [
          r.customerId.startsWith("cus_")
            ? idCell(r.customerId, { ref: { page: "customers.detail", params: { id: r.customerId } } })
            : text(r.customerId),
          text(r.email ?? "N/A"),
          text(String(r.count)),
          r.discordIds.length ? text(r.discordIds.map((d) => `@${d}`).join(", ")) : text("no Discord link"),
        ] as Cell[],
      }));
      fpTable.footer = `${result.rows.length} account${result.rows.length === 1 ? "" : "s"} · from the ${result.scanned} most recent matching charges${result.hasMore ? " (more exist)" : ""}`;
    }
  }
  blocks.push(fpTable);

  // last4 hunt: grouped by fingerprint (the exact id for the hunt above).
  // "Failed only" is the failed-PaymentIntent hunt: declines/blocks DO exist
  // as failed charges, each pointing at its PI.
  const l4Table: TableBlock = {
    type: "table",
    key: "l4hunt",
    title: "Cards by last 4 digits",
    filters: [
      { key: "last4", label: "Last 4", kind: "text", value: last4 || undefined, placeholder: "4242" },
      { key: "brand", label: "Brand", kind: "text", value: brand || undefined, placeholder: "visa / mastercard / amex" },
      {
        key: "status",
        label: "Status",
        kind: "select",
        value: status || undefined,
        options: [
          { label: "All attempts", value: "" },
          { label: "Failed only", value: "failed" },
          { label: "Succeeded only", value: "succeeded" },
        ],
      },
    ],
    columns: [
      { key: "card", label: "Card" },
      { key: "exp", label: "Expires" },
      { key: "charges", label: "Charges", align: "right" },
      { key: "failed", label: "Failed", align: "right" },
      { key: "lastfail", label: "Last failure" },
      { key: "customers", label: "Customers" },
      { key: "fp", label: "Fingerprint" },
    ],
    rows: [],
    empty: last4
      ? "No matching charges. Two blind spots: wallet payments (Link/PayPal/Klarna) expose NO card digits on their charges (hunt those by customer email or amount); and never-confirmed attempts (abandoned checkout, unfinished 3DS) have no charge (hunt by amount). Declined attempts DO show up as failed charges."
      : "Enter the last 4 digits (brand narrows it; Failed only = declined attempts and their payment intents). Wallet-rail payments (Link/PayPal) carry no card digits and can't be found here.",
    notice: `last4 is not unique. Rows are grouped by fingerprint; feed one into the exact hunt above. Wallet payments (Link/PayPal) expose no card digits to any lookup. ${SEARCH_LAG_NOTICE}`,
  };
  if (last4) {
    const result = await deps.hunts.cardsByLast4(last4, brand || undefined, status || undefined);
    if (!result.ok) {
      blocks.push({ type: "notice", badge: { kind: "error", text: "Invalid" }, text: result.error });
    } else {
      l4Table.rows = result.rows.map((g, i) => ({
        id: g.fingerprint ?? `nofp-${i}`,
        ...(g.lastFailure?.piId ? { ref: { page: "payments.detail", params: { id: g.lastFailure.piId } } } : {}),
        cells: [
          cardCell(g.brand, g.last4),
          text(g.exp),
          text(String(g.count)),
          g.failed
            ? ({ t: "badge", b: { kind: "error", text: String(g.failed) } as Badge } as Cell)
            : text("0"),
          g.lastFailure
            ? text(`${g.lastFailure.reason ?? "no reason given"} · ${g.lastFailure.piId ?? g.lastFailure.chargeId}`)
            : text("N/A"),
          text(
            g.customers
              .slice(0, 3)
              .map((c) => c.email ?? c.id)
              .join(", ") + (g.customers.length > 3 ? ` +${g.customers.length - 3}` : "") || "N/A"
          ),
          g.fingerprint ? idCell(g.fingerprint, { copy: true }) : text("N/A"),
        ] as Cell[],
      }));
      l4Table.footer = `${result.rows.length} card${result.rows.length === 1 ? "" : "s"} · from the ${result.scanned} most recent matching charges${result.hasMore ? " (more exist)" : ""}`;
    }
  }
  blocks.push(l4Table);
  return blocks;
}

// ---- amount hunt (PaymentIntents — includes declined attempts) ----

async function amountHunt(ctx: DashboardCtx, deps: { hunts: FraudHuntService }, filters: Record<string, string>): Promise<Block[]> {
  const amountRaw = str(filters.amount, 20);
  const currency = str(filters.currency, 3);
  const blocks: Block[] = [];
  const table: TableBlock = {
    type: "table",
    key: "amthunt",
    title: "Payment attempts by amount",
    filters: [
      { key: "amount", label: "Amount", kind: "text", value: amountRaw || undefined, placeholder: "25.39" },
      { key: "currency", label: "Currency", kind: "text", value: currency || undefined, placeholder: "eur (blank = any)" },
    ],
    columns: [
      { key: "amount", label: "Amount" },
      { key: "customer", label: "Customer" },
      { key: "email", label: "Email" },
      { key: "card", label: "Card" },
      { key: "created", label: "When" },
      { key: "reason", label: "Failure reason" },
    ],
    rows: [],
    empty: amountRaw
      ? "No payment attempts for that amount (declined ones included). Different currency, or a different Stripe account?"
      : "Enter the exact amount the customer sees on their statement; declined and issuer-blocked attempts show up here.",
    notice: `Searches PaymentIntents, so attempts that never produced a charge (abandoned checkout, unfinished 3DS) are included, the ones the card hunts can't see. ${SEARCH_LAG_NOTICE}`,
  };
  if (amountRaw) {
    const result = await deps.hunts.paymentsByAmount(amountRaw, currency || undefined);
    if (!result.ok) {
      blocks.push({ type: "notice", badge: { kind: "error", text: "Invalid" }, text: result.error });
    } else {
      table.rows = result.rows.map((r) => {
        const badge: Badge =
          r.status === "succeeded" ? { kind: "ok", text: "Succeeded" } : r.status === "canceled" ? { kind: "neutral", text: "Canceled" } : { kind: "error", text: sentence(r.status.replace(/_/g, " ")) };
        return {
          id: r.id,
          ref: { page: "payments.detail", params: { id: r.id } },
          cells: [
            amount(ctx.stripe, r.amount, r.currency, badge),
            r.customerId ? idCell(r.customerId, { ref: { page: "customers.detail", params: { id: r.customerId } } }) : text("N/A"),
            text(r.email ?? "N/A"),
            r.cardBrand ? cardCell(r.cardBrand, r.cardLast4 ?? "") : text("N/A"),
            dateCell(r.created),
            text(r.failureReason ?? "N/A"),
          ] as Cell[],
        };
      });
      table.footer = `${result.rows.length} attempt${result.rows.length === 1 ? "" : "s"}${result.hasMore ? " (more exist)" : ""}`;
    }
  }
  blocks.push(table);
  return blocks;
}
