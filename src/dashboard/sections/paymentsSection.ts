import type Stripe from "stripe";
import { StripeClient } from "../../bot/StripeClient";
import { SettingsStore } from "../../config/SettingsStore";
import { SessionStore } from "../../auth/SessionStore";
import { BlockStore } from "../../bot/billing/BlockStore";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, Badge, Block, Cell, KeyValueBlock, TableBlock } from "../renderer/contract";
import { FINGERPRINT_RE } from "../../bot/billing/types";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";
import { payoutBadge, sourceRef, TX_TYPES } from "./balancesSection";
import {
  amount,
  badgeCell,
  cardCell,
  chargeBadge,
  chipCount,
  dateCell,
  idCell,
  isoDateCell,
  money,
  parseDateFilter,
  piBadge,
  sentence,
  text,
} from "./cells";

// Payments: the account-wide Stripe LIST archetype (count-cards + filter
// pills + flat table) and the charge/PI DETAIL archetype (activity timeline +
// breakdown + payment method + rail). Money movement renders as registry
// action buttons — execution flows through Dashboard.ts → the gateway, never
// through section code. The guardrail dry-run lives on its own subpage so the
// detail view stays within the ≤4-Stripe-calls budget.

const WINDOW = 100; // in-memory filter/count window per page (documented in the notice)
const BULK_REFUND_MAX = 25; // blast-radius cap per bulk-refund run

// Daterange parsing lives in cells.ts since every list uses it (PA-13
// filter expansion); re-exported here for existing importers.
export { parseDateFilter };

const INCOMPLETE_PI = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
]);

export function makePaymentsSection(): DashboardSectionModule {
  return {
    nav: [{ key: "payments", label: "Payments", page: "payments" }],

    ownsPage(page: string): boolean {
      return page === "payments" || page === "payments.detail" || page === "payments.guardrails";
    },

    // Hover peek card (PA-13): ONE retrieve (charge or PI), plain text only —
    // last4 at most, never full card data.
    async peek(ctx: DashboardCtx, page: string, id: string) {
      if (page !== "payments.detail") return null;
      if (/^pi_/.test(id)) {
        const pi = await ctx.stripe.getPaymentIntent(id).catch(() => null);
        if (!pi) return null;
        const lines = [
          `Created ${new Date(pi.created * 1000).toISOString().slice(0, 10)}`,
          ...(pi.last_payment_error?.message ? [`Last error: ${pi.last_payment_error.message.slice(0, 120)}`] : []),
        ];
        return { title: ctx.stripe.formatAmount(pi.amount, pi.currency), badge: piBadge(pi.status), lines: lines.slice(0, 5) };
      }
      const c = await ctx.stripe.getChargeDetailed(id).catch(() => null);
      if (!c) return null;
      const email = c.billing_details?.email ?? c.receipt_email ?? null;
      const lines = [
        ...(email ? [email] : []),
        `Created ${new Date(c.created * 1000).toISOString().slice(0, 10)}`,
        ...(c.payment_method_details?.card?.last4 ? [`Card ···· ${c.payment_method_details.card.last4}`] : []),
        ...(c.outcome?.seller_message && c.status !== "succeeded" ? [c.outcome.seller_message.slice(0, 120)] : []),
      ];
      return { title: ctx.stripe.formatAmount(c.amount, c.currency), badge: chargeBadge(c), lines: lines.slice(0, 5) };
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "payments") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      const rawId = req.params?.id;
      if (req.page === "payments.detail") {
        const chargeId = validId("charge", rawId);
        if (chargeId) return chargeDetail(ctx, chargeId);
        const piId = validId("payment_intent", rawId);
        if (piId) return piDetail(ctx, piId);
        return notFound("That id is not a charge (ch_/py_) or payment intent (pi_).");
      }
      if (req.page === "payments.guardrails") {
        const chargeId = validId("charge", rawId);
        if (!chargeId) return notFound("Guardrail dry runs work on charge ids (ch_…).");
        return guardrailPage(ctx, chargeId);
      }
      return null;
    },

    async action(ctx: DashboardCtx, req) {
      const p = req.params ?? {};
      switch (req.key) {
        case "section:payments.note_add": {
          const chargeId = validId("charge", p.chargeId);
          const body = str(p.text, 1000);
          if (!chargeId || !body) return { ok: false, fieldErrors: { text: "Write something first." } };
          await ctx.stores.qol.addNote("charge", chargeId, ctx.actor.id, ctx.actor.name, body);
          await ctx.audit(`Note added on ${chargeId}`);
          return { ok: true, text: "Note added." };
        }
        case "section:payments.bookmark": {
          const chargeId = validId("charge", p.chargeId);
          if (!chargeId) return { ok: false, error: "Bad charge id." };
          const r = await ctx.stores.qol.toggleBookmark("charge", chargeId, str(p.label, 80) || null, ctx.actor.id, ctx.actor.name);
          return { ok: true, text: r.bookmarked ? "Bookmarked." : "Bookmark removed." };
        }
        case "section:payments.bulk_refund": {
          // Bulk money movement gets the STRONG ceremony: typed CONFIRM is
          // enforced HERE (the modal listed count + total), and every charge
          // then rides the registry ladder INDIVIDUALLY via the gateway —
          // per-charge ownership binding, live revalidation, level/queue
          // routing and refund idempotency. One bad row never blocks the rest.
          if (req.confirmWord !== "CONFIRM") return { ok: false, error: "Type CONFIRM to run this action." };
          const rawIds = Array.isArray(p.ids) ? (p.ids as unknown[]) : [];
          const ids = [...new Set(rawIds.map((v) => validId("charge", v)).filter((v): v is string => v != null))];
          if (ids.length === 0) return { ok: false, error: "Select at least one charge row first." };
          if (ids.length > BULK_REFUND_MAX) {
            return { ok: false, error: `Bulk refund is capped at ${BULK_REFUND_MAX} charges per run — select fewer rows.` };
          }
          const actor = actionActor(ctx);
          let executed = 0;
          let queued = 0;
          const failures: string[] = [];
          for (const chargeId of ids) {
            const outcome = await ctx.billing.gateway.request(actor, "charge.refund_full", { chargeId });
            if (outcome.kind === "executed") executed++;
            else if (outcome.kind === "queued") queued++;
            else failures.push(`${chargeId}: ${outcome.error}`);
          }
          await ctx.audit(
            `Bulk refund over ${ids.length} charge(s) — ${executed} refunded, ${queued} queued, ${failures.length} skipped`
          );
          const parts = [
            executed ? `${executed} refunded` : null,
            queued ? `${queued} queued for approval` : null,
            failures.length ? `${failures.length} skipped` : null,
          ].filter(Boolean);
          const detail = failures.length ? ` — ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "; …" : ""}` : "";
          if (executed + queued === 0) return { ok: false, error: `Bulk refund: every charge was skipped${detail}` };
          return { ok: true, text: `Bulk refund: ${parts.join(", ")}${detail}` };
        }
        case "section:payments.payout_create": {
          // T2 money movement out of the balance: typed CONFIRM + fresh factor.
          if (req.confirmWord !== "CONFIRM") return { ok: false, error: "Type CONFIRM to run this action." };
          if (!ctx.security.stepUpFresh()) return { ok: false, needsStepUp: true };
          const amountMajor =
            typeof p.amountMajor === "number" && isFinite(p.amountMajor) && p.amountMajor > 0 ? p.amountMajor : null;
          const currency = str(p.currency, 3).trim().toLowerCase();
          if (!amountMajor || !/^[a-z]{3}$/.test(currency)) {
            return { ok: false, error: "A positive amount and a 3-letter currency are required." };
          }
          const factor = StripeClient.isZeroDecimal(currency) ? 1 : 100;
          const amountMinor = Math.round(amountMajor * factor);
          const instant = p.method === "instant";
          // Preflight against the right bucket — Stripe would refuse anyway,
          // but a friendly error beats a raw API message. instant_available is
          // absent entirely on ineligible accounts (best-effort check; Stripe
          // stays the final authority).
          const balance = await ctx.stripe.getBalance().catch(() => null);
          const bucket = instant
            ? balance?.instant_available?.find((b) => b.currency === currency)
            : balance?.available.find((b) => b.currency === currency);
          if (!bucket || bucket.amount < amountMinor) {
            return {
              ok: false,
              error: instant
                ? `Instant-available ${currency.toUpperCase()} balance is ${
                    bucket ? ctx.stripe.formatAmount(bucket.amount, currency) : ctx.stripe.formatAmount(0, currency)
                  } — instant payouts need an eligible debit destination and instant funds.`
                : `Available ${currency.toUpperCase()} balance is ${
                    bucket ? ctx.stripe.formatAmount(bucket.amount, currency) : ctx.stripe.formatAmount(0, currency)
                  } — cannot pay out ${ctx.stripe.formatAmount(amountMinor, currency)}.`,
            };
          }
          try {
            const payout = await ctx.stripe.createPayout(
              {
                amountMinor,
                currency,
                description: str(p.description, 200).trim() || undefined,
                statementDescriptor: str(p.statementDescriptor, 22).trim() || undefined,
                ...(instant ? { method: "instant" as const } : {}),
              },
              `dash-payout-${amountMinor}-${currency}-${Date.now().toString(36)}`
            );
            await ctx.audit(`Payout ${payout.id} created — ${ctx.stripe.formatAmount(amountMinor, currency)}${instant ? " (instant)" : ""}`);
            return {
              ok: true,
              text: `Payout ${payout.id} created — ${ctx.stripe.formatAmount(amountMinor, currency)}${
                instant ? " (instant)" : `, arriving ${new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)}`
              }.`,
            };
          } catch (e) {
            // Destination-ineligibility errors are the useful part — surface them.
            return { ok: false, error: `Stripe refused the payout: ${(e as Error).message?.slice(0, 200) ?? "unknown error"}` };
          }
        }
        case "section:payments.topup_create": {
          // T2 — pulls money FROM the external bank into the Stripe balance.
          if (req.confirmWord !== "CONFIRM") return { ok: false, error: "Type CONFIRM to run this action." };
          if (!ctx.security.stepUpFresh()) return { ok: false, needsStepUp: true };
          const amountMajor =
            typeof p.amountMajor === "number" && isFinite(p.amountMajor) && p.amountMajor > 0 ? p.amountMajor : null;
          const currency = str(p.currency, 3).trim().toLowerCase();
          if (!amountMajor || !/^[a-z]{3}$/.test(currency)) {
            return { ok: false, error: "A positive amount and a 3-letter currency are required." };
          }
          const amountMinor = Math.round(amountMajor * (StripeClient.isZeroDecimal(currency) ? 1 : 100));
          try {
            const topup = await ctx.stripe.createTopUp(
              {
                amountMinor,
                currency,
                description: str(p.description, 200).trim() || undefined,
                statementDescriptor: str(p.statementDescriptor, 15).trim() || undefined,
              },
              `dash-topup-${amountMinor}-${currency}-${Date.now().toString(36)}`
            );
            await ctx.audit(`Top-up ${topup.id} created — ${ctx.stripe.formatAmount(amountMinor, currency)} from the default bank`);
            return { ok: true, text: `Top-up ${topup.id} created — ${ctx.stripe.formatAmount(amountMinor, currency)} (${topup.status}).` };
          } catch (e) {
            // Fails on accounts without a verified default bank / unsupported
            // countries — Stripe's message is the useful part.
            return { ok: false, error: `Stripe refused the top-up: ${(e as Error).message?.slice(0, 200) ?? "unknown error"}` };
          }
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

function actionActor(ctx: DashboardCtx): ActionActor {
  return { kind: "dashboard", id: ctx.actor.id, name: ctx.actor.name, isAdmin: ctx.actor.isAdmin };
}

// Advisory render mode for a registry button: queue notice or disabled state.
// Execution re-checks server-side regardless.
function registryButton(ctx: DashboardCtx, button: ActionButton): ActionButton {
  const mode = ctx.billing.actions.effectiveMode(button.key, actionActor(ctx));
  if (mode === "denied") {
    return { ...button, disabledReason: "Disabled by /config → Billing → Intercom Actions." };
  }
  return { ...button, mode: mode === "queue" ? "queue" : "direct" };
}

function pmIntentId(charge: Stripe.Charge): string | null {
  return typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
}

// Capture pair for a requires_capture authorization (PA-9): full + partial.
// T1 (registry dangerous) + T2 (DASH_T2) — capture is the moment the card is
// actually charged.
function captureButtons(ctx: DashboardCtx, paymentIntentId: string, capturableMinor: number, currency: string): ActionButton[] {
  return [
    registryButton(ctx, {
      key: "payment_intent.capture",
      label: "Capture",
      style: "primary",
      dangerous: true,
      stepUp: true,
      params: { paymentIntentId },
      summary: `Charges the customer's card the full authorized ${ctx.stripe.formatAmount(capturableMinor, currency)} NOW. Requires a fresh factor.`,
    }),
    registryButton(ctx, {
      key: "payment_intent.capture",
      label: "Capture partial",
      dangerous: true,
      stepUp: true,
      params: { paymentIntentId },
      inputs: [
        {
          type: "number",
          key: "amountMajor",
          label: `Amount (${currency.toUpperCase()}, ≤ ${ctx.stripe.formatAmount(capturableMinor, currency)})`,
          min: 0,
        },
      ],
      summary: "Charges part of the authorization — the uncaptured remainder is RELEASED back to the customer. Requires a fresh factor.",
    }),
  ];
}

// ---- LIST ----

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  // PA-5: the transactions tab row is a filter-driven view switch — Payouts /
  // Top-ups / All activity render here (Stripe's own layout), charges below.
  const txview =
    filters.txview === "payouts" || filters.txview === "topups" || filters.txview === "activity" ? filters.txview : "";
  if (txview) return transactionsView(ctx, txview, filters, cursor);
  const status = str(filters.status, 20);
  const dateKey = str(filters.date, 24);
  const amountFilter = str(filters.amount, 20);
  const last4 = /^\d{4}$/.test(filters.last4 ?? "") ? filters.last4 : "";
  const flagged = str(filters.flagged, 12);
  const currencyFilter = str(filters.currency, 8).toLowerCase();
  const pmFilter = str(filters.pm, 24).toLowerCase();
  // PA-13 filter expansion (user ask — Stripe "More filters" parity):
  // fingerprint = the reverse-card sweep (exact identity across ALL
  // customers, search-backed); email exact-matches via search; decline
  // reason + invoice slice the fetched window.
  const fingerprint = FINGERPRINT_RE.test(filters.fingerprint ?? "") ? filters.fingerprint : "";
  const emailFilter = str(filters.email, 100).replace(/["\\]/g, "").trim().toLowerCase();
  const declineFilter = str(filters.declineReason, 40).replace(/["\\]/g, "").trim().toLowerCase();
  const invoiceFilter = validId("invoice", filters.invoice) ?? "";

  // Date filter (PA-13 daterange): a preset token OR a custom
  // "YYYY-MM-DD..YYYY-MM-DD" range in the same key. The range end is
  // INCLUSIVE — +86400 turns it into the exclusive `lt` Stripe wants.
  const { createdGte, createdLt } = parseDateFilter(dateKey);
  // Customer scope (Customer-360 "view all payments" + the Customer pill):
  // per-customer Stripe listings replace the account-wide ones.
  const customerScope = validId("customer", filters.customer) ?? "";

  const cursorId = validId("charge", cursor) ?? undefined;

  // Real chip totals via the Search API — the fetched window caps at WINDOW,
  // so counting rows inside it shows "100" forever on a busy account. Scope
  // mirrors the server-side filters (customer + date); currency/pm/amount/
  // last4/flagged slice the window rows client-side, as before. Every count
  // falls back to the honest windowed number ("N+") if search fails.
  const scopeParts: string[] = [];
  if (customerScope) scopeParts.push(`customer:"${customerScope}"`);
  if (createdGte) scopeParts.push(`created>=${createdGte}`);
  // Chip totals must honor the custom range's upper bound too.
  if (createdLt) scopeParts.push(`created<${createdLt}`);
  if (fingerprint) scopeParts.push(`payment_method_details.card.fingerprint:"${fingerprint}"`);
  if (emailFilter) scopeParts.push(`billing_details.email:"${emailFilter}"`);
  const searchQ = (extra?: string) => [...scopeParts, ...(extra ? [extra] : [])].join(" AND ") || "created>0";
  const countSearch = (kind: "charges" | "paymentIntents", q: string) =>
    Promise.resolve()
      .then(() => ctx.stripe.countBySearch(kind, q))
      .catch(() => null);

  // Search mode: fingerprint/email aren't list params, so the ROWS come from
  // charges.search (whole account, not just the recency window) — this is the
  // reverse-card lookup. No cursor (one 100-row page + exact total).
  const searchMode = Boolean(fingerprint || emailFilter);

  const [chargeWindow, piWindow, efws, blockPage, searchCounts] = await Promise.all([
    searchMode
      ? ctx.stripe
          .searchChargesForList(searchQ(), WINDOW)
          .then((r) => ({ charges: r.charges, hasMore: (r.totalCount ?? r.charges.length) > r.charges.length }))
      : customerScope
        ? ctx.stripe.listCharges(customerScope, WINDOW, cursorId)
        : ctx.stripe.listAllCharges({ limit: WINDOW, createdGte, createdLt, startingAfter: cursorId }),
    (searchMode
      ? // PI search can't express card/email fields — the Incomplete view is
        // meaningless under these filters; it renders empty with a notice.
        Promise.resolve({ paymentIntents: [] as Stripe.PaymentIntent[], hasMore: false })
      : customerScope
        ? ctx.stripe.listPaymentIntents(customerScope, WINDOW).then((paymentIntents) => ({ paymentIntents, hasMore: false }))
        : ctx.stripe.listAllPaymentIntents({ limit: WINDOW, createdGte, createdLt })
    ).catch(() => ({ paymentIntents: [] as Stripe.PaymentIntent[], hasMore: false })),
    ctx.stripe.listRecentEarlyFraudWarnings(100).catch(() => [] as Stripe.Radar.EarlyFraudWarning[]),
    ctx.stores.block.listPage(0, 200).catch(() => ({ rows: [], total: 0 })),
    Promise.all([
      countSearch("charges", searchQ()),
      countSearch("charges", searchQ('status:"succeeded"')),
      countSearch("charges", searchQ('refunded:"true"')),
      countSearch("charges", searchQ('disputed:"true"')),
      countSearch("charges", searchQ('status:"failed"')),
      // One count per incomplete PI status — Stripe search has no grouping
      // parentheses, so OR can't be mixed with the scope's ANDs safely.
      Promise.all([...INCOMPLETE_PI].map((s) => countSearch("paymentIntents", searchQ(`status:"${s}"`)))),
    ]).then(([all, succeeded, refunded, disputed, failed, piByStatus]) => ({
      all,
      succeeded,
      refunded,
      disputed,
      failed,
      uncaptured: piByStatus[[...INCOMPLETE_PI].indexOf("requires_capture")],
      incomplete: piByStatus.every((c) => c != null) ? piByStatus.reduce((s, c) => s! + c!, 0) : null,
    })),
  ]);

  const efwChargeIds = new Set(efws.map((w) => (typeof w.charge === "string" ? w.charge : w.charge.id)));
  const blockedCustomers = new Set<string>();
  const blockedEmails = new Set<string>();
  for (const row of blockPage.rows) {
    if (row.kind === "customer_id") blockedCustomers.add(row.value);
    if (row.customerId) blockedCustomers.add(row.customerId);
    if (row.kind === "email") blockedEmails.add(row.value.toLowerCase());
  }
  const isBlocked = (c: Stripe.Charge): boolean => {
    const cus = typeof c.customer === "string" ? c.customer : c.customer?.id;
    const email = (c.billing_details?.email ?? c.receipt_email ?? "").toLowerCase();
    return (!!cus && blockedCustomers.has(cus)) || (!!email && blockedEmails.has(email));
  };

  const charges = chargeWindow.charges;
  const incompletePis = piWindow.paymentIntents.filter((pi) => INCOMPLETE_PI.has(pi.status));

  // Count-cards are FILTERS whose totals come from search (exact); the rows
  // they reveal still come from the fetched window. Fallback = windowed "N+".
  const over = chargeWindow.hasMore;
  const counts = {
    key: "status",
    items: [
      { value: "", label: "All", count: chipCount(searchCounts.all, charges.length, over) },
      {
        value: "succeeded",
        label: "Succeeded",
        count: chipCount(searchCounts.succeeded, charges.filter((c) => c.status === "succeeded").length, over),
      },
      {
        value: "refunded",
        label: "Refunded",
        count: chipCount(searchCounts.refunded, charges.filter((c) => c.refunded).length, over),
      },
      {
        value: "disputed",
        label: "Disputed",
        count: chipCount(searchCounts.disputed, charges.filter((c) => c.disputed).length, over),
      },
      {
        value: "failed",
        label: "Failed",
        count: chipCount(searchCounts.failed, charges.filter((c) => c.status === "failed").length, over),
      },
      {
        value: "uncaptured",
        label: "Uncaptured",
        count: chipCount(
          searchCounts.uncaptured,
          charges.filter((c) => c.status === "succeeded" && !c.captured).length,
          over
        ),
      },
      {
        value: "incomplete",
        label: "Incomplete",
        count: chipCount(searchCounts.incomplete, incompletePis.length, piWindow.hasMore),
      },
    ],
  };

  const sharedFilters: TableBlock["filters"] = [
    { key: "customer", label: "Customer", kind: "text", value: customerScope || undefined, placeholder: "cus_…" },
    {
      key: "date",
      label: "Date",
      kind: "daterange",
      value: dateKey || undefined,
      options: [
        { value: "24h", label: "Last 24 hours" },
        { value: "7d", label: "Last 7 days" },
        { value: "30d", label: "Last 30 days" },
        { value: "90d", label: "Last 90 days" },
      ],
    },
    { key: "amount", label: "Amount", kind: "text", value: amountFilter || undefined, placeholder: "e.g. 29.00" },
    { key: "last4", label: "Last 4", kind: "text", value: last4 || undefined, placeholder: "4242" },
    {
      key: "flagged",
      label: "Flagged",
      kind: "select",
      value: flagged || undefined,
      options: [
        { value: "blocked", label: "Blocked customer" },
        { value: "disputed", label: "Disputed" },
        { value: "efw", label: "Early fraud warning" },
      ],
    },
    // PA-13 "More filters" parity. Fingerprint/email flip the list into a
    // whole-account Stripe-Search sweep; decline reason + invoice slice rows.
    {
      key: "fingerprint",
      label: "Card fingerprint",
      kind: "text",
      value: fingerprint || undefined,
      placeholder: "Exact card identity — sweeps ALL customers",
    },
    { key: "email", label: "Email", kind: "text", value: emailFilter || undefined, placeholder: "ada@example.com" },
    {
      key: "declineReason",
      label: "Decline reason",
      kind: "text",
      value: declineFilter || undefined,
      placeholder: "e.g. insufficient_funds",
    },
    { key: "invoice", label: "Invoice", kind: "text", value: invoiceFilter || undefined, placeholder: "in_…" },
  ];

  // Currency + payment-method pills, built from what's actually in the window.
  const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const currencies = [...new Set(charges.map((c) => c.currency))].sort();
  const brands = [...new Set(charges.map((c) => c.payment_method_details?.card?.brand).filter(Boolean))] as string[];
  const extraFilters: NonNullable<TableBlock["filters"]> = [];
  if (currencies.length > 1)
    extraFilters.push({ key: "currency", label: "Currency", kind: "select", value: currencyFilter || undefined, options: currencies.map((c) => ({ value: c, label: c.toUpperCase() })) });
  if (brands.length)
    extraFilters.push({ key: "pm", label: "Payment method", kind: "select", value: pmFilter || undefined, options: brands.map((b) => ({ value: b, label: cap(b) })) });
  const mainFilters: TableBlock["filters"] = [...(sharedFilters ?? []), ...extraFilters];

  const header: Block = {
    type: "header",
    title: "Payments",
    actions: [
      registryButton(ctx, {
        key: "charge.refund_full",
        label: "Refund by ID",
        dangerous: true,
        inputs: [{ type: "text", key: "chargeId", label: "Charge id (ch_…)", placeholder: "ch_…" }],
        summary: "Full refund of a charge by id (customers without a Discord link get a partial refund of the remaining amount instead).",
      }),
    ],
  };

  const tabs = txTabs("");

  // Bulk refund over the selected rows (money-moving bulk → strong ceremony;
  // hidden entirely when the refund action is disabled by /config).
  const refundMode = ctx.billing.actions.effectiveMode("charge.refund_full", actionActor(ctx));
  const bulkActions: ActionButton[] =
    refundMode === "denied"
      ? []
      : [
          {
            key: "section:payments.bulk_refund",
            label: "Refund selected…",
            style: "danger",
            dangerous: true,
            mode: refundMode === "queue" ? "queue" : "direct",
            summary:
              `Fully refunds every selected charge (max ${BULK_REFUND_MAX} per run). Each charge is revalidated individually through the action ladder; unlinked customers get the remaining amount as a partial refund. Skipped charges are reported per id.`,
          },
        ];

  // Incomplete view: PaymentIntent rows instead of charges.
  if (status === "incomplete") {
    const rows = incompletePis.map((pi) => ({
      id: pi.id,
      ref: { page: "payments.detail", params: { id: pi.id } },
      cells: [
        amount(ctx.stripe, pi.amount, pi.currency, piBadge(pi.status)),
        text(pi.description ?? "—"),
        text(pi.last_payment_error?.message?.slice(0, 60) ?? "—"),
        typeof pi.customer === "string"
          ? ({ t: "link", v: pi.customer, ref: { page: "customers.detail", params: { id: pi.customer } } } as Cell)
          : text("—"),
        dateCell(pi.created),
      ] as Cell[],
    }));
    return {
      title: "Payments",
      crumbs: [{ label: "Payments" }],
      blocks: [
        header,
        tabs,
        {
          type: "table",
          key: "payments",
          columns: [
            { key: "amount", label: "Amount" },
            { key: "desc", label: "Description" },
            { key: "error", label: "Last error" },
            { key: "customer", label: "Customer" },
            { key: "created", label: "Date" },
          ],
          counts,
          filters: sharedFilters,
          rows,
          empty: "No incomplete payments in this window.",
          ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
          notice: `Incomplete = payment attempts that never became charges. Counts reflect the ${WINDOW} most recent objects${dateKey ? ` in the ${dateKey} window` : ""}.`,
        },
      ],
    };
  }

  const filtered = charges.filter((c) => {
    // Per-customer listings can't take a server-side date param — cut here.
    if (customerScope && createdGte && c.created < createdGte) return false;
    if (customerScope && createdLt && c.created >= createdLt) return false;
    if (status === "succeeded" && c.status !== "succeeded") return false;
    // Fully refunded — Stripe's own chip definition (searchable as
    // refunded:"true"); partial refunds keep their "Partial refund" badge.
    if (status === "refunded" && !c.refunded) return false;
    if (status === "disputed" && !c.disputed) return false;
    if (status === "failed" && c.status !== "failed") return false;
    if (status === "uncaptured" && (c.status !== "succeeded" || c.captured)) return false;
    if (last4 && c.payment_method_details?.card?.last4 !== last4) return false;
    if (amountFilter) {
      const major = Number(amountFilter.replace(",", "."));
      if (!isFinite(major)) return true;
      const minor = Math.round(major * (StripeClient.isZeroDecimal(c.currency) ? 1 : 100));
      if (c.amount !== minor) return false;
    }
    if (flagged === "blocked" && !isBlocked(c)) return false;
    if (flagged === "disputed" && !c.disputed) return false;
    if (flagged === "efw" && !efwChargeIds.has(c.id)) return false;
    if (currencyFilter && c.currency !== currencyFilter) return false;
    if (pmFilter && (c.payment_method_details?.card?.brand ?? "") !== pmFilter) return false;
    // PA-13 expansion: email/fingerprint re-check what search matched (and cut
    // the plain window when search was unavailable); decline reason + invoice
    // slice the fetched rows — the list API can't express them.
    if (emailFilter && !(c.billing_details?.email ?? c.receipt_email ?? "").toLowerCase().includes(emailFilter)) return false;
    if (fingerprint && c.payment_method_details?.card?.fingerprint !== fingerprint) return false;
    if (declineFilter && !`${c.outcome?.reason ?? ""} ${c.failure_code ?? ""}`.toLowerCase().includes(declineFilter)) return false;
    if (invoiceFilter) {
      const inv = (c as { invoice?: string | { id: string } | null }).invoice;
      const invId = typeof inv === "string" ? inv : inv?.id ?? null;
      if (invId !== invoiceFilter) return false;
    }
    return true;
  });

  const rows = filtered.map((c) => {
    const flags: Badge[] = [];
    if (isBlocked(c)) flags.push({ kind: "error", text: "BLOCKED" });
    if (efwChargeIds.has(c.id)) flags.push({ kind: "warn", text: "EFW" });
    const custObj = c.customer && typeof c.customer !== "string" ? c.customer : null;
    const cus = typeof c.customer === "string" ? c.customer : c.customer?.id ?? null;
    // Prefer the customer's name/email (Stripe's list look); fall back to the
    // charge's billing/receipt email, then the raw id as a last resort.
    const custName = custObj && !("deleted" in custObj) ? custObj.name ?? custObj.email ?? null : null;
    const email = custName ?? c.billing_details?.email ?? c.receipt_email ?? null;
    return {
      id: c.id,
      ref: { page: "payments.detail", params: { id: c.id } },
      cells: [
        amount(ctx.stripe, c.amount, c.currency, chargeBadge(c)),
        c.payment_method_details?.card
          ? cardCell(c.payment_method_details.card.brand ?? "card", c.payment_method_details.card.last4 ?? "????")
          : c.payment_method_details?.type
            ? cardCell(c.payment_method_details.type, "") // wallet chip (Link, PayPal, SEPA…)
            : text("—"),
        text(c.description ?? (typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id) ?? "—"),
        cus
          ? ({ t: "link", v: email ?? cus, ref: { page: "customers.detail", params: { id: cus } } } as Cell)
          : text(email ?? "—"),
        dateCell(c.created),
        c.refunds?.data?.[0]?.created ? dateCell(c.refunds.data[0].created) : text("—"),
        text(c.failure_message ?? "—"),
        { t: "flags", badges: flags } as Cell,
      ] as Cell[],
    };
  });

  const hasInMemoryFilter = !!(
    status || last4 || amountFilter || flagged || currencyFilter || pmFilter ||
    emailFilter || fingerprint || declineFilter || invoiceFilter
  );
  return {
    title: "Payments",
    crumbs: [{ label: "Payments" }],
    blocks: [
      header,
      tabs,
      {
        type: "table",
        key: "payments",
        columns: [
          { key: "amount", label: "Amount" },
          { key: "pm", label: "Payment method" },
          { key: "desc", label: "Description" },
          { key: "customer", label: "Customer" },
          { key: "created", label: "Date" },
          { key: "refunded", label: "Refunded date" },
          { key: "decline", label: "Decline reason" },
          { key: "flags", label: "Flags" },
        ],
        counts,
        filters: mainFilters,
        selectable: true,
        exportable: true,
        editableColumns: true,
        ...(bulkActions.length ? { bulkActions } : {}),
        rows,
        // Search mode has no starting_after cursor — one 100-row page.
        nextCursor: !searchMode && chargeWindow.hasMore && charges.length > 0 ? charges[charges.length - 1].id : null,
        empty: hasInMemoryFilter ? "No payments match these filters (within this window)." : "No payments yet.",
        ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
        notice:
          (searchMode
            ? `Card/email filters sweep the WHOLE account via Stripe Search (~1 min lag; first ${WINDOW} matches shown). Incomplete attempts aren't searchable by card or email.`
            : `Counts and filters cover the ${WINDOW} most recent payments${dateKey ? ` of the ${dateKey} window` : ""} per page — use Next for older ones. EFW matching covers the 100 most recent warnings.`) +
          // The wallet blind spot: Link/PayPal charges expose no card digits.
          (last4 || fingerprint || pmFilter
            ? " Wallet payments (Link/PayPal) expose no card digits — they never match card filters."
            : ""),
      },
    ],
  };
}

// ---- TRANSACTIONS TABS (PA-5: Payouts / Top-ups / All activity) ----

// Stripe's tab row under the Payments H1 — a filter-driven view switch.
function txTabs(active: string): Block {
  return {
    type: "tabs",
    key: "txview",
    value: active || undefined,
    items: [
      { value: "", label: "Payments" },
      { value: "payouts", label: "Payouts" },
      { value: "topups", label: "Top-ups" },
      { value: "activity", label: "All activity" },
    ],
  };
}

function topupBadge(status: string): Badge {
  const kind: Badge["kind"] =
    status === "succeeded" ? "ok" : status === "failed" || status === "canceled" ? "error" : status === "reversed" ? "neutral" : "warn";
  return { kind, text: status.charAt(0).toUpperCase() + status.slice(1) };
}

async function transactionsView(
  ctx: DashboardCtx,
  view: "payouts" | "topups" | "activity",
  filters: Record<string, string>,
  cursor: string | null
): Promise<SectionPage> {
  const crumbs = [{ label: "Payments" }];

  if (view === "payouts") {
    const payoutCursor = validId("payout", validCursor(cursor) ?? "") ?? undefined;
    const [balance, payoutsRes] = await Promise.all([
      ctx.stripe.getBalance().catch(() => null),
      ctx.stripe.listPayouts({ limit: 25, startingAfter: payoutCursor }),
    ]);
    const buckets = (rows: Array<{ amount: number; currency: string }> | undefined) =>
      (rows ?? []).map((b) => ctx.stripe.formatAmount(b.amount, b.currency)).join(" + ") || "—";
    return {
      title: "Payments",
      crumbs,
      blocks: [
        {
          type: "header",
          title: "Payments",
          actions: [
            {
              key: "section:payments.payout_create",
              label: "Create payout",
              style: "primary",
              dangerous: true,
              stepUp: true,
              inputs: [
                { type: "number", key: "amountMajor", label: "Amount (major units, e.g. 250.00)", min: 0 },
                { type: "text", key: "currency", label: "Currency (3 letters)", placeholder: "eur" },
                {
                  type: "select",
                  key: "method",
                  label: "Payout speed",
                  options: [
                    { value: "", label: "Standard (free, 1-3 days)" },
                    { value: "instant", label: "Instant (fee — eligible debit destinations only)" },
                  ],
                },
                { type: "text", key: "description", label: "Description (optional)" },
                { type: "text", key: "statementDescriptor", label: "Bank statement text (optional, ≤22 chars)", maxLength: 22 },
              ],
              summary: `Pays out from the AVAILABLE balance (${balance ? buckets(balance.available) : "—"}) to the default external account. Requires a fresh factor.`,
            },
          ],
        },
        txTabs(view),
        {
          type: "stats",
          items: [
            { label: "Available", value: balance ? buckets(balance.available) : "—", sub: "settled, ready to pay out" },
            { label: "Pending", value: balance ? buckets(balance.pending) : "—", sub: "settling to available" },
          ],
        },
        {
          type: "table",
          key: "payouts",
          exportable: true,
          columns: [
            { key: "amount", label: "Amount" },
            { key: "method", label: "Method" },
            { key: "desc", label: "Description" },
            { key: "created", label: "Initiated" },
            { key: "arrival", label: "Arrival" },
            { key: "id", label: "ID" },
          ],
          rows: payoutsRes.payouts.map((p) => ({
            id: p.id,
            ref: { page: "balances.detail", params: { id: p.id } },
            cells: [
              amount(ctx.stripe, p.amount, p.currency, payoutBadge(p.status)),
              text(p.method === "instant" ? "Instant" : "Standard"),
              text(p.description ?? "—"),
              dateCell(p.created),
              dateCell(p.arrival_date),
              idCell(p.id, { copy: true }),
            ] as Cell[],
          })),
          nextCursor:
            payoutsRes.hasMore && payoutsRes.payouts.length > 0
              ? payoutsRes.payouts[payoutsRes.payouts.length - 1].id
              : null,
          empty: "No payouts yet.",
          ...(payoutsRes.payouts.length
            ? { footer: `${payoutsRes.payouts.length}${payoutsRes.hasMore ? "+" : ""} item${payoutsRes.payouts.length === 1 ? "" : "s"}` }
            : {}),
          notice: "Click a payout for its transactions — cancel (pending) and reverse (paid) live on the payout page.",
        },
      ],
    };
  }

  if (view === "topups") {
    const rawCursor = validCursor(cursor) ?? "";
    const topupCursor = /^tu_[A-Za-z0-9]{1,64}$/.test(rawCursor) ? rawCursor : undefined;
    const topupsRes = await ctx.stripe
      .listTopUps({ limit: 25, startingAfter: topupCursor })
      .catch(() => ({ topups: [] as Stripe.Topup[], hasMore: false }));
    return {
      title: "Payments",
      crumbs,
      blocks: [
        {
          type: "header",
          title: "Payments",
          actions: [
            {
              key: "section:payments.topup_create",
              label: "Add to balance",
              style: "primary",
              dangerous: true,
              stepUp: true,
              inputs: [
                { type: "number", key: "amountMajor", label: "Amount (major units, e.g. 500.00)", min: 0 },
                { type: "text", key: "currency", label: "Currency (3 letters)", placeholder: "eur" },
                { type: "text", key: "description", label: "Description (optional)" },
                { type: "text", key: "statementDescriptor", label: "Bank statement text (optional, ≤15 chars)", maxLength: 15 },
              ],
              summary:
                "Pulls money from the account's DEFAULT VERIFIED BANK into the Stripe balance (takes days, like a payout in reverse). Requires a fresh factor.",
            },
          ],
        },
        txTabs(view),
        {
          type: "table",
          key: "topups",
          exportable: true,
          columns: [
            { key: "amount", label: "Amount" },
            { key: "desc", label: "Description" },
            { key: "created", label: "Date" },
            { key: "id", label: "ID" },
          ],
          rows: topupsRes.topups.map((t) => ({
            id: t.id,
            cells: [
              amount(ctx.stripe, t.amount, t.currency, topupBadge(t.status)),
              text(t.description ?? "—"),
              dateCell(t.created),
              idCell(t.id, { copy: true }),
            ] as Cell[],
          })),
          nextCursor:
            topupsRes.hasMore && topupsRes.topups.length > 0 ? topupsRes.topups[topupsRes.topups.length - 1].id : null,
          empty: "No top-ups — fund the balance via bank transfer or the API.",
          ...(topupsRes.topups.length
            ? { footer: `${topupsRes.topups.length}${topupsRes.hasMore ? "+" : ""} item${topupsRes.topups.length === 1 ? "" : "s"}` }
            : {}),
        },
      ],
    };
  }

  // All activity: the account balance-transaction ledger, cursor-paginated.
  const txType = TX_TYPES.some((t) => t.value === filters.type) ? filters.type : "";
  const rawTxCursor = validCursor(cursor) ?? "";
  const txCursor = /^txn_[A-Za-z0-9]{1,64}$/.test(rawTxCursor) ? rawTxCursor : undefined;
  const txRes = await ctx.stripe
    .listAccountBalanceTransactions({ limit: 50, startingAfter: txCursor, ...(txType ? { type: txType } : {}) })
    .catch(() => ({ transactions: [] as Stripe.BalanceTransaction[], hasMore: false }));
  return {
    title: "Payments",
    crumbs,
    blocks: [
      { type: "header", title: "Payments" },
      txTabs(view),
      {
        type: "table",
        key: "activity",
        exportable: true,
        columns: [
          { key: "amount", label: "Amount" },
          { key: "fee", label: "Fee", align: "right" },
          { key: "net", label: "Net", align: "right" },
          { key: "type", label: "Type" },
          { key: "available", label: "Available on" },
          { key: "id", label: "Source" },
        ],
        filters: [{ key: "type", label: "Type", kind: "select", value: txType || undefined, options: TX_TYPES }],
        rows: txRes.transactions.map((t) => ({
          id: t.id,
          ...(sourceRef(t) ? { ref: sourceRef(t)! } : {}),
          cells: [
            amount(ctx.stripe, t.amount, t.currency),
            money(ctx.stripe, -t.fee, t.currency, t.fee ? "muted" : undefined),
            money(ctx.stripe, t.net, t.currency, t.net >= 0 ? "pos" : "neg"),
            text(sentence(t.type.replace(/_/g, " "))),
            dateCell(t.available_on),
            typeof t.source === "string" ? idCell(t.source, { copy: true }) : text("—"),
          ] as Cell[],
        })),
        nextCursor:
          txRes.hasMore && txRes.transactions.length > 0 ? txRes.transactions[txRes.transactions.length - 1].id : null,
        empty: "No balance transactions match.",
        ...(txRes.transactions.length
          ? { footer: `${txRes.transactions.length}${txRes.hasMore ? "+" : ""} item${txRes.transactions.length === 1 ? "" : "s"}` }
          : {}),
      },
    ],
  };
}

// ---- CHARGE DETAIL ----

async function chargeDetail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const charge = await ctx.stripe.getChargeDetailed(id).catch(() => null);
  if (!charge) return notFound("This charge does not exist.");

  const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id ?? null;
  const [refundsRes, customer, efws, disputes, blocks, discordIds, notes, bookmarked] = await Promise.all([
    ctx.stripe.listRefunds({ chargeId: id, limit: 25 }).catch(() => ({ refunds: [] as Stripe.Refund[], hasMore: false })),
    customerId ? ctx.stripe.getCustomer(customerId).catch(() => null) : Promise.resolve(null),
    ctx.stripe.listRecentEarlyFraudWarnings(100).catch(() => [] as Stripe.Radar.EarlyFraudWarning[]),
    ctx.stores.dispute.listByCustomer(customerId ?? "", 10).catch(() => []),
    customerId ? ctx.stores.block.listForCustomer(customerId, null).catch(() => []) : Promise.resolve([]),
    customerId ? ctx.stores.session.findDiscordIdsByStripeId(customerId).catch(() => []) : Promise.resolve([]),
    ctx.stores.qol.listNotes("charge", id, 0, 5).catch(() => ({ rows: [], total: 0 })),
    ctx.stores.qol.isBookmarked("charge", id).catch(() => false),
  ]);

  const hasEfw = efws.some((w) => (typeof w.charge === "string" ? w.charge : w.charge.id) === id);
  const chargeDispute = disputes.find((d) => d.chargeId === id) ?? null;
  const remaining = charge.amount - (charge.amount_refunded ?? 0);
  const refundable = charge.status === "succeeded" && charge.captured && !charge.refunded && remaining > 0;
  const uncaptured = charge.status === "succeeded" && !charge.captured && !charge.refunded;
  const chargePiId = pmIntentId(charge);
  const linked = discordIds.length > 0;

  // Header actions: capture (T1+T2, uncaptured auths), refunds (T1/T2),
  // bookmark/note (T0 section-local).
  const actions: ActionButton[] = [];
  if (uncaptured && chargePiId) {
    actions.push(...captureButtons(ctx, chargePiId, charge.amount, charge.currency));
    actions.push(
      registryButton(ctx, {
        key: "payment_intent.cancel",
        label: "Cancel authorization",
        style: "danger",
        dangerous: true, // T1 belt (DASH_T1_EXTRA server-side)
        params: { paymentIntentId: chargePiId },
        summary: "Releases the hold — the customer is never charged and the authorization is voided.",
      })
    );
  }
  if (refundable) {
    actions.push(
      registryButton(
        ctx,
        linked
          ? {
              key: "charge.refund_full",
              label: charge.amount_refunded ? "Refund remaining" : "Refund",
              style: "primary",
              dangerous: true,
              params: { chargeId: id },
              summary: `Fully refund ${ctx.stripe.formatAmount(remaining, charge.currency)} and cancel the customer's subscription (refund-core path).`,
            }
          : {
              key: "charge.refund_partial",
              label: charge.amount_refunded ? "Refund remaining" : "Refund",
              style: "primary",
              dangerous: true,
              params: { chargeId: id, amountMinor: remaining },
              summary: `Refund the remaining ${ctx.stripe.formatAmount(remaining, charge.currency)}. (No Discord link on this customer, so this runs as a partial refund of the full remainder.)`,
            }
      )
    );
    actions.push(
      registryButton(ctx, {
        key: "charge.refund_partial",
        label: "Partial refund",
        dangerous: true,
        params: { chargeId: id },
        inputs: [{ type: "number", key: "amountMajor", label: `Amount (${charge.currency.toUpperCase()}, e.g. 5.00)`, min: 0 }],
        summary: `Refund part of ${ctx.stripe.formatAmount(charge.amount, charge.currency)} — ${ctx.stripe.formatAmount(remaining, charge.currency)} is refundable.`,
      })
    );
    actions.push(
      registryButton(ctx, {
        key: "charge.refund_fraud",
        label: "Refund as fraud",
        style: "danger",
        dangerous: true,
        stepUp: true,
        params: { chargeId: id },
        inputs: [{ type: "number", key: "amountMajor", label: `Amount (${charge.currency.toUpperCase()})`, min: 0 }],
        summary: "Refund with reason=fraudulent — feeds Stripe Radar. Requires a fresh factor (passkey/TOTP).",
      })
    );
  }
  actions.push({
    key: "section:payments.bookmark",
    label: bookmarked ? "Remove bookmark" : "Bookmark",
    params: { chargeId: id },
  });
  actions.push({
    key: "section:payments.note_add",
    label: "Add note",
    params: { chargeId: id },
    inputs: [{ type: "text", key: "text", label: "Team note", multiline: true, maxLength: 1000 }],
  });

  const headBadges: Badge[] = [chargeBadge(charge)];
  // Only add a "Disputed" flag when the status pill isn't already showing it
  // (a refunded+disputed charge shows "Refunded" as status, so the flag adds info).
  if ((chargeDispute || charge.disputed) && chargeBadge(charge).text !== "Disputed")
    headBadges.push({ kind: "error", text: "Disputed" });
  if (hasEfw) headBadges.push({ kind: "warn", text: "EFW" });
  if (blocks.length > 0) headBadges.push({ kind: "error", text: "Blocked customer" });

  const main: Block[] = [];
  const rail: Block[] = [];

  const customerLabel = customer?.name || customer?.email || customerId;
  main.push({
    type: "header",
    title: ctx.stripe.formatAmount(charge.amount, charge.currency),
    titleSuffix: charge.currency.toUpperCase(),
    ...(customerLabel ? { sub: `Charged to ${customerLabel}` } : {}),
    badges: headBadges,
    actions,
  });

  // Dispute banner: surface an open chargeback on the charge page itself, with
  // the urgency + a pointer to the evidence workbench (which stays the one editor).
  const disputeOpen = chargeDispute && !["won", "lost", "prevented"].includes(chargeDispute.status);
  const disputeDaysLeft = chargeDispute?.evidenceDueBy
    ? Math.ceil((chargeDispute.evidenceDueBy.getTime() - Date.now()) / 86400000)
    : null;
  if (disputeOpen && chargeDispute) {
    const urgency =
      disputeDaysLeft == null
        ? "Disputed"
        : disputeDaysLeft <= 0
          ? "Past due"
          : `${disputeDaysLeft} day${disputeDaysLeft === 1 ? "" : "s"} to respond`;
    main.push({
      type: "notice",
      badge: { kind: disputeDaysLeft != null && disputeDaysLeft <= 2 ? "error" : "warn", text: urgency },
      text: `The customer disputed this payment (${sentence(chargeDispute.reason)}). Respond with evidence in the Disputes workbench — see the Dispute panel on the right.`,
    });
  }

  // Recent activity: refunds (newest first from Stripe) + dispute + lifecycle.
  const timeline: Array<{ label: string; iso: string; text?: string; kind?: Badge["kind"]; ref?: { page: string; params?: Record<string, string> } }> = [];
  for (const refund of refundsRes.refunds) {
    const arn = refund.destination_details?.card?.reference;
    timeline.push({
      label: `Refunded ${ctx.stripe.formatAmount(refund.amount, refund.currency)}${refund.reason ? ` (${sentence(refund.reason)})` : ""}`,
      iso: new Date(refund.created * 1000).toISOString(),
      text: `${refund.id} · ${refund.status ?? "?"}${arn ? ` · ARN ${arn}` : ""}`,
      kind: "info",
    });
  }
  if (chargeDispute?.disputeCreatedAt) {
    timeline.push({
      label: `Dispute opened (${chargeDispute.reason})`,
      iso: chargeDispute.disputeCreatedAt.toISOString(),
      text: `${chargeDispute.id} · ${chargeDispute.status}`,
      kind: "error",
      ref: { page: "disputes.detail", params: { id: chargeDispute.id } },
    });
  }
  // Lifecycle, Stripe-style: "Payment started" always, then the outcome row.
  // For failures, outcome.seller_message carries the real bank story — the
  // top-level failure_message is often just "The payment failed."
  const createdIso = new Date(charge.created * 1000).toISOString();
  if (charge.status === "failed") {
    const msg = charge.outcome?.seller_message ?? charge.failure_message ?? "The payment failed.";
    const codes = [...new Set([charge.failure_code, charge.outcome?.reason].filter((c): c is string => !!c))];
    timeline.push({
      label: "Payment failed",
      iso: createdIso,
      text: codes.length ? `${msg} (${codes.join(" / ")})` : msg,
      kind: "error",
    });
  } else if (charge.status === "pending") {
    timeline.push({ label: "Payment processing", iso: createdIso, kind: "warn" });
  } else {
    timeline.push({ label: charge.captured ? "Payment succeeded" : "Payment authorized", iso: createdIso, kind: "ok" });
  }
  timeline.push({ label: "Payment started", iso: createdIso, kind: "info" });
  // Stable sort: equal timestamps keep push order (outcome above "started").
  timeline.sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));
  main.push({ type: "timeline", title: "Recent activity", items: timeline });

  const bt = charge.balance_transaction;
  // Payment breakdown (fees come from the expanded balance transaction) —
  // only when money actually moved; a failed attempt has no breakdown.
  if (charge.status === "succeeded") {
    const fee = bt && typeof bt === "object" ? bt.fee : null;
    const refunded = charge.amount_refunded ?? 0;
    const net = charge.amount - (fee ?? 0) - refunded;
    main.push({
      type: "kv",
      title: "Payment breakdown",
      amounts: true,
      rows: [
        { label: "Payment amount", cell: money(ctx.stripe, charge.amount, charge.currency) },
        ...(fee != null ? [{ label: "Stripe processing fees", cell: money(ctx.stripe, -fee, charge.currency, "muted") }] : []),
        ...(refunded > 0 ? [{ label: "Refunded amount", cell: money(ctx.stripe, -refunded, charge.currency, "neg") }] : []),
        { label: "Net amount", cell: money(ctx.stripe, net, charge.currency, net >= 0 ? "pos" : "neg") },
      ],
    });
  }

  // Payment method.
  const card = charge.payment_method_details?.card;
  main.push({
    type: "kv",
    title: "Payment method",
    rows: [
      ...(charge.payment_method ? [{ label: "ID", cell: idCell(charge.payment_method, { copy: true }) }] : []),
      {
        label: card ? "Card" : "Type",
        cell: card
          ? cardCell(card.brand ?? "card", card.last4 ?? "????")
          : charge.payment_method_details?.type
            ? cardCell(charge.payment_method_details.type, "")
            : text("—"),
      },
      ...(card?.fingerprint
        ? [
            {
              label: "Fingerprint",
              cell: {
                t: "link",
                v: `${card.fingerprint} — hunt same card`,
                ref: { page: "fraud", filters: { view: "card", fp: card.fingerprint } },
              } as Cell,
            },
          ]
        : []),
      ...(card ? [{ label: "Expires", cell: text(`${card.exp_month}/${card.exp_year}`) }] : []),
      ...(card?.funding ? [{ label: "Type", cell: text(`${sentence(card.funding)} card`) }] : []),
      ...(card?.country ? [{ label: "Origin", cell: text(card.country) }] : []),
      {
        label: "CVC check",
        cell:
          card?.checks?.cvc_check === "pass"
            ? badgeCell("ok", "Passed")
            : card?.checks?.cvc_check
              ? badgeCell("warn", sentence(card.checks.cvc_check))
              : text("—"),
      },
    ],
  });

  // Team notes.
  if (notes.rows.length > 0) {
    main.push({
      type: "timeline",
      title: `Team notes (${notes.total})`,
      items: notes.rows.map((n) => ({
        label: n.authorName,
        iso: n.createdAt.toISOString(),
        text: n.text,
        kind: "info" as const,
      })),
    });
  }

  // Rail: Details / Customer / Related.
  rail.push({
    type: "kv",
    title: "Details",
    rows: [
      ...(charge.payment_intent
        ? [
            {
              label: "Payment ID",
              cell: idCell(typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id, {
                copy: true,
                ref: {
                  page: "payments.detail",
                  params: { id: typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id },
                },
              }),
            },
          ]
        : []),
      { label: "Charge ID", cell: idCell(charge.id, { copy: true }) },
      {
        label: "Risk level",
        cell: charge.outcome?.risk_level
          ? badgeCell(
              charge.outcome.risk_level === "normal" ? "ok" : charge.outcome.risk_level === "elevated" ? "warn" : "error",
              sentence(charge.outcome.risk_level) + (charge.outcome.risk_score != null ? ` (${charge.outcome.risk_score})` : "")
            )
          : text("—"),
      },
      ...(charge.description ? [{ label: "Description", cell: text(charge.description) }] : []),
      ...(charge.calculated_statement_descriptor
        ? [{ label: "Statement descriptor", cell: text(charge.calculated_statement_descriptor) }]
        : []),
      ...(charge.receipt_email ? [{ label: "Receipt email", cell: text(charge.receipt_email) }] : []),
      { label: "Created", cell: dateCell(charge.created) },
      ...(bt && typeof bt === "object" && bt.available_on
        ? [
            {
              label: "Funds available",
              cell: {
                t: "link",
                v: new Date(bt.available_on * 1000).toISOString().slice(0, 10),
                ref: { page: "balances" },
              } as Cell,
            },
          ]
        : []),
      {
        label: "Guardrail dry run",
        cell: { t: "link", v: "Run refund guardrails", ref: { page: "payments.guardrails", params: { id: charge.id } } },
      },
    ],
  });

  // Dispute panel (rail): id / amount / reason / status / response-due + a link
  // straight into the evidence workbench.
  if (chargeDispute) {
    rail.push({
      type: "kv",
      title: "Dispute",
      rows: [
        {
          label: "Respond",
          cell: {
            t: "link",
            v: "Open evidence workbench",
            ref: { page: "disputes.detail", params: { id: chargeDispute.id } },
          } as Cell,
        },
        {
          label: "Dispute ID",
          cell: idCell(chargeDispute.id, { copy: true, ref: { page: "disputes.detail", params: { id: chargeDispute.id } } }),
        },
        { label: "Amount", cell: money(ctx.stripe, chargeDispute.amount, chargeDispute.currency) },
        { label: "Reason", cell: text(sentence(chargeDispute.reason)) },
        {
          label: "Status",
          cell: badgeCell(
            chargeDispute.status === "won" ? "ok" : chargeDispute.status === "lost" ? "error" : "warn",
            sentence(chargeDispute.status)
          ),
        },
        ...(chargeDispute.evidenceDueBy
          ? [{ label: "Response due", cell: dateCell(Math.floor(chargeDispute.evidenceDueBy.getTime() / 1000)) }]
          : []),
      ],
    });
  }

  rail.push({
    type: "kv",
    title: "Customer",
    rows: customerId
      ? [
          { label: "ID", cell: idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } }) },
          ...(customer?.email ? [{ label: "Email", cell: text(customer.email) }] : []),
          ...(customer?.name ? [{ label: "Name", cell: text(customer.name) }] : []),
          {
            label: "Discord",
            cell: linked ? idCell(discordIds[0], { copy: true }) : text("not linked", "full refunds run as partial (remaining amount)"),
          },
        ]
      : [{ label: "Customer", cell: text("No customer attached to this charge.") }],
  });

  return {
    title: `${ctx.stripe.formatAmount(charge.amount, charge.currency)}`,
    crumbs: [{ label: "Payments", ref: { page: "payments" } }, { label: charge.id, copyId: charge.id }],
    blocks: main,
    rail,
  };
}

// ---- PAYMENT INTENT DETAIL ----

async function piDetail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const pi = await ctx.stripe.getPaymentIntent(id).catch(() => null);
  if (!pi) return notFound("This payment intent does not exist.");
  const customerId = typeof pi.customer === "string" ? pi.customer : pi.customer?.id ?? null;
  const latestChargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null;

  const cancelable = INCOMPLETE_PI.has(pi.status);
  const actions: ActionButton[] = [
    ...(pi.status === "requires_capture"
      ? captureButtons(ctx, id, pi.amount_capturable || pi.amount, pi.currency)
      : []),
    ...(cancelable
      ? [
          registryButton(ctx, {
            key: "payment_intent.cancel",
            label: pi.status === "requires_capture" ? "Cancel authorization" : "Cancel payment intent",
            style: "danger",
            dangerous: true, // T1 belt (typed CONFIRM) — enforced server-side too
            params: { paymentIntentId: id },
            summary:
              pi.status === "requires_capture"
                ? "Releases the hold — the customer is never charged."
                : `Cancel this ${ctx.stripe.formatAmount(pi.amount, pi.currency)} payment attempt.`,
          }),
        ]
      : []),
  ];

  const main: Block[] = [
    {
      type: "header",
      title: ctx.stripe.formatAmount(pi.amount, pi.currency),
      titleSuffix: pi.currency.toUpperCase(),
      sub: "Payment intent",
      badges: [piBadge(pi.status)],
      actions,
    },
    {
      type: "kv",
      title: "Details",
      rows: [
        { label: "Status", cell: badgeCell(piBadge(pi.status).kind, sentence(pi.status)) },
        ...(pi.description ? [{ label: "Description", cell: text(pi.description) }] : []),
        ...(pi.cancellation_reason ? [{ label: "Cancellation reason", cell: text(sentence(pi.cancellation_reason)) }] : []),
        ...(pi.last_payment_error?.message
          ? [{ label: "Last payment error", cell: text(pi.last_payment_error.message.slice(0, 300)) }]
          : []),
        { label: "Created", cell: dateCell(pi.created) },
      ],
    },
  ];

  const rail: Block[] = [
    {
      type: "kv",
      title: "Details",
      rows: [
        { label: "Payment ID", cell: idCell(pi.id, { copy: true }) },
        ...(latestChargeId
          ? [
              {
                label: "Latest charge",
                cell: idCell(latestChargeId, { copy: true, ref: { page: "payments.detail", params: { id: latestChargeId } } }),
              },
            ]
          : []),
      ],
    },
    {
      type: "kv",
      title: "Customer",
      rows: customerId
        ? [{ label: "ID", cell: idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } }) }]
        : [{ label: "Customer", cell: text("No customer attached.") }],
    },
  ];

  return {
    title: ctx.stripe.formatAmount(pi.amount, pi.currency),
    crumbs: [{ label: "Payments", ref: { page: "payments" } }, { label: pi.id, copyId: pi.id }],
    blocks: main,
    rail,
  };
}

// ---- GUARDRAIL DRY RUN ----

async function guardrailPage(ctx: DashboardCtx, chargeId: string): Promise<SectionPage> {
  const charge = await ctx.stripe.getCharge(chargeId).catch(() => null);
  if (!charge) return notFound("This charge does not exist.");
  const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id ?? null;
  const discordIds = customerId
    ? await ctx.stores.session.findDiscordIdsByStripeId(customerId).catch(() => [])
    : [];
  const panel = await buildGuardrailPanel(
    { settings: ctx.settings, stripe: ctx.stripe, sessionStore: ctx.stores.session, blockStore: ctx.stores.block },
    {
      amount: charge.amount,
      currency: charge.currency,
      created: charge.created,
      customerId,
      email: charge.billing_details?.email ?? charge.receipt_email ?? null,
    },
    discordIds[0] ?? null
  );
  return {
    title: "Guardrail dry run",
    crumbs: [
      { label: "Payments", ref: { page: "payments" } },
      { label: chargeId, ref: { page: "payments.detail", params: { id: chargeId } } },
      { label: "Guardrails" },
    ],
    blocks: [
      { type: "header", title: "Guardrail dry run", sub: `${chargeId} · ${ctx.stripe.formatAmount(charge.amount, charge.currency)}` },
      {
        type: "notice",
        badge: { kind: "info", text: "ADVISORY" },
        text: "This is the SELF-SERVICE refund gate, evaluated read-only against the same settings and stores. Staff refunds from this dashboard bypass it — exactly like /billing admin refunds do.",
      },
      panel,
    ],
  };
}

// Advisory re-implementation of BillingCategory.checkRefundGuardrails, minus
// the Discord-invoker rails (member age needs a guild member; per-user checks
// need the Discord link). Exported for tests. Read-only: no state, no claims.
export async function buildGuardrailPanel(
  deps: { settings: SettingsStore; stripe: StripeClient; sessionStore: SessionStore; blockStore: BlockStore },
  charge: { amount: number; currency: string; created: number; customerId: string | null; email: string | null },
  discordUserId: string | null
): Promise<KeyValueBlock> {
  const rows: KeyValueBlock["rows"] = [];
  let trips = 0;
  let unknowns = 0;
  const pass = (label: string, detail: string) => rows.push({ label, cell: { t: "text", v: detail, strong: false } });
  const trip = (label: string, detail: string) => {
    trips++;
    rows.push({ label, cell: badgeCell("error", detail) });
  };
  const unknown = (label: string, detail: string) => {
    unknowns++;
    rows.push({ label, cell: badgeCell("neutral", detail) });
  };
  const off = (label: string) => rows.push({ label, cell: { t: "text", v: "off (no limit configured)" } });

  // Blocklist.
  const blockHit = await deps.blockStore
    .anyBlocked({ customerId: charge.customerId, email: charge.email })
    .catch(() => null);
  if (blockHit) trip("Blocklist", `blocked (${blockHit.kind}): ${blockHit.reason}`);
  else pass("Blocklist", "not on the block list");

  // Amount cap.
  const maxAmount = deps.settings.refundMaxAmount();
  if (maxAmount == null) off("Amount cap");
  else {
    const capCurrency = deps.settings.refundMaxAmountCurrency().toLowerCase();
    if (charge.currency.toLowerCase() !== capCurrency) {
      trip("Amount cap", `currency mismatch (charge ${charge.currency.toUpperCase()}, cap ${capCurrency.toUpperCase()})`);
    } else if (charge.amount > maxAmount) {
      trip("Amount cap", `${deps.stripe.formatAmount(charge.amount, charge.currency)} exceeds ${deps.stripe.formatAmount(maxAmount, capCurrency)}`);
    } else pass("Amount cap", `within ${deps.stripe.formatAmount(maxAmount, capCurrency)}`);
  }

  // Charge age.
  const maxAgeDays = deps.settings.refundMaxChargeAgeDays();
  if (maxAgeDays == null) off("Charge age");
  else {
    const ageDays = Math.floor((Date.now() - charge.created * 1000) / 86_400_000);
    if (ageDays >= maxAgeDays) trip("Charge age", `${ageDays}d old — window is ${maxAgeDays}d`);
    else pass("Charge age", `${ageDays}d old (window ${maxAgeDays}d)`);
  }

  // Velocity (global).
  const maxPer24h = deps.settings.refundMaxPer24h();
  if (maxPer24h == null) off("Velocity (global)");
  else {
    const count = await deps.sessionStore.countRefundsSince(new Date(Date.now() - 86_400_000)).catch(() => null);
    if (count == null) unknown("Velocity (global)", "count unavailable");
    else if (count >= maxPer24h) trip("Velocity (global)", `${count}/${maxPer24h} in 24h`);
    else pass("Velocity (global)", `${count}/${maxPer24h} in 24h`);
  }

  // Velocity (per user) — needs the Discord link.
  const maxPerUser = deps.settings.refundMaxPer24hPerUser();
  if (maxPerUser == null) off("Velocity (per user)");
  else if (!discordUserId) unknown("Velocity (per user)", "no Discord link — cannot evaluate");
  else {
    const count = await deps.sessionStore
      .countRefundsSinceForUser(discordUserId, new Date(Date.now() - 86_400_000))
      .catch(() => null);
    if (count == null) unknown("Velocity (per user)", "count unavailable");
    else if (count >= maxPerUser) trip("Velocity (per user)", `${count}/${maxPerUser} in 24h`);
    else pass("Velocity (per user)", `${count}/${maxPerUser} in 24h`);
  }

  // Member age — Discord-only rail.
  if (deps.settings.refundMinMemberAgeDays() == null) off("Member age");
  else unknown("Member age", "Discord-only guardrail — not checkable from the web");

  // First-refund-only: local ledger + Stripe sweep.
  if (discordUserId && (await deps.sessionStore.hasEverBeenRefunded(discordUserId).catch(() => false))) {
    trip("First refund only", "user already refunded via the bot");
  } else if (!charge.customerId) {
    unknown("First refund only", "no Stripe customer on the charge");
  } else {
    try {
      const history = await deps.stripe.customerHasAnyRefund(charge.customerId);
      if (history.hasRefund) trip("First refund only", "customer already has a Stripe refund");
      else if (history.truncated) unknown("First refund only", "history sweep truncated");
      else pass("First refund only", "no prior refunds found");
    } catch {
      unknown("First refund only", "history sweep failed");
    }
  }

  const verdict: { label: string; cell: Cell } = {
    label: "Verdict",
    cell:
      trips > 0
        ? badgeCell("error", `WOULD TRIP (${trips}) → manual review`)
        : unknowns > 0
          ? badgeCell("warn", `uncertain (${unknowns} unknown) → likely manual review`)
          : badgeCell("ok", "self-service would pass"),
  };
  return { type: "kv", title: "Refund guardrails (dry run)", rows: [verdict, ...rows] };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Payments", ref: { page: "payments" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Not found", hint }],
  };
}
