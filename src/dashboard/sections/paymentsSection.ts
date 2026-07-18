import type Stripe from "stripe";
import { StripeClient } from "../../bot/StripeClient";
import { SettingsStore } from "../../config/SettingsStore";
import { SessionStore } from "../../auth/SessionStore";
import { BlockStore } from "../../bot/billing/BlockStore";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, Badge, Block, Cell, KeyValueBlock, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validId } from "./types";
import {
  amount,
  badgeCell,
  cardCell,
  chargeBadge,
  dateCell,
  idCell,
  isoDateCell,
  money,
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

const DATE_RANGES: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

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

// ---- LIST ----

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const status = str(filters.status, 20);
  const dateKey = str(filters.date, 8);
  const amountFilter = str(filters.amount, 20);
  const last4 = /^\d{4}$/.test(filters.last4 ?? "") ? filters.last4 : "";
  const flagged = str(filters.flagged, 12);

  const createdGte = DATE_RANGES[dateKey]
    ? Math.floor(Date.now() / 1000) - DATE_RANGES[dateKey] * 86400
    : undefined;

  const cursorId = validId("charge", cursor) ?? undefined;
  const [chargeWindow, piWindow, efws, blockPage] = await Promise.all([
    ctx.stripe.listAllCharges({ limit: WINDOW, createdGte, startingAfter: cursorId }),
    ctx.stripe.listAllPaymentIntents({ limit: WINDOW, createdGte }).catch(() => ({ paymentIntents: [], hasMore: false })),
    ctx.stripe.listRecentEarlyFraudWarnings(100).catch(() => [] as Stripe.Radar.EarlyFraudWarning[]),
    ctx.stores.block.listPage(0, 200).catch(() => ({ rows: [], total: 0 })),
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

  // Count-cards are FILTERS over the fetched window (may overlap, like Stripe's).
  const counts = {
    key: "status",
    items: [
      { value: "", label: "All", count: charges.length },
      { value: "succeeded", label: "Succeeded", count: charges.filter((c) => c.status === "succeeded").length },
      { value: "refunded", label: "Refunded", count: charges.filter((c) => (c.amount_refunded ?? 0) > 0).length },
      { value: "disputed", label: "Disputed", count: charges.filter((c) => c.disputed).length },
      { value: "failed", label: "Failed", count: charges.filter((c) => c.status === "failed").length },
      {
        value: "uncaptured",
        label: "Uncaptured",
        count: charges.filter((c) => c.status === "succeeded" && !c.captured).length,
      },
      { value: "incomplete", label: "Incomplete", count: incompletePis.length },
    ],
  };

  const sharedFilters: TableBlock["filters"] = [
    {
      key: "date",
      label: "Date",
      kind: "select",
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
  ];

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
    if (status === "succeeded" && c.status !== "succeeded") return false;
    if (status === "refunded" && (c.amount_refunded ?? 0) === 0) return false;
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
    return true;
  });

  const rows = filtered.map((c) => {
    const flags: Badge[] = [];
    if (isBlocked(c)) flags.push({ kind: "error", text: "BLOCKED" });
    if (efwChargeIds.has(c.id)) flags.push({ kind: "warn", text: "EFW" });
    const cus = typeof c.customer === "string" ? c.customer : c.customer?.id ?? null;
    const email = c.billing_details?.email ?? c.receipt_email ?? null;
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
        { t: "flags", badges: flags } as Cell,
      ] as Cell[],
    };
  });

  const hasInMemoryFilter = !!(status || last4 || amountFilter || flagged);
  return {
    title: "Payments",
    crumbs: [{ label: "Payments" }],
    blocks: [
      header,
      {
        type: "table",
        key: "payments",
        columns: [
          { key: "amount", label: "Amount" },
          { key: "pm", label: "Payment method" },
          { key: "desc", label: "Description" },
          { key: "customer", label: "Customer" },
          { key: "created", label: "Date" },
          { key: "flags", label: "Flags" },
        ],
        counts,
        filters: sharedFilters,
        rows,
        nextCursor: chargeWindow.hasMore && charges.length > 0 ? charges[charges.length - 1].id : null,
        empty: hasInMemoryFilter ? "No payments match these filters (within this window)." : "No payments yet.",
        ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
        notice: `Counts and filters cover the ${WINDOW} most recent payments${dateKey ? ` of the ${dateKey} window` : ""} per page — use Next for older ones. EFW matching covers the 100 most recent warnings.`,
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
  const linked = discordIds.length > 0;

  // Header actions: refunds (T1/T2) + bookmark/note (T0 section-local).
  const actions: ActionButton[] = [];
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
  if (chargeDispute || charge.disputed) headBadges.push({ kind: "error", text: "Disputed" });
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

  // Recent activity: refunds (newest first from Stripe) + dispute + lifecycle.
  const timeline: Array<{ label: string; iso: string; text?: string; kind?: Badge["kind"] }> = [];
  for (const refund of refundsRes.refunds) {
    timeline.push({
      label: `Refunded ${ctx.stripe.formatAmount(refund.amount, refund.currency)}${refund.reason ? ` (${sentence(refund.reason)})` : ""}`,
      iso: new Date(refund.created * 1000).toISOString(),
      text: `${refund.id} · ${refund.status ?? "?"}`,
      kind: "info",
    });
  }
  if (chargeDispute?.disputeCreatedAt) {
    timeline.push({
      label: `Dispute opened (${chargeDispute.reason})`,
      iso: chargeDispute.disputeCreatedAt.toISOString(),
      text: `${chargeDispute.id} · ${chargeDispute.status} — manage in /billing → Disputes until the web console ships`,
      kind: "error",
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

  // Payment breakdown (fees come from the expanded balance transaction) —
  // only when money actually moved; a failed attempt has no breakdown.
  if (charge.status === "succeeded") {
    const bt = charge.balance_transaction;
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
        ? [{ label: "Fingerprint", cell: text(card.fingerprint, "same-card hunts arrive with Fraud tools (M7)") }]
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
      {
        label: "Guardrail dry run",
        cell: { t: "link", v: "Run refund guardrails", ref: { page: "payments.guardrails", params: { id: charge.id } } },
      },
    ],
  });

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
  const actions: ActionButton[] = cancelable
    ? [
        registryButton(ctx, {
          key: "payment_intent.cancel",
          label: "Cancel payment intent",
          style: "danger",
          dangerous: true, // T1 belt (typed CONFIRM) — enforced server-side too
          params: { paymentIntentId: id },
          summary: `Cancel this ${ctx.stripe.formatAmount(pi.amount, pi.currency)} payment attempt.`,
        }),
      ]
    : [];

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
