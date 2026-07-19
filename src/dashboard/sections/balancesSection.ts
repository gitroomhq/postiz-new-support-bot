import type Stripe from "stripe";
import { ActionButton, ActionResult, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, validCursor, validId } from "./types";
import { amount, badgeCell, dateCell, idCell, money, sentence, text } from "./cells";

// Balances: account balance buckets, the payout ledger (paginated) and recent
// balance transactions (fees/refunds/charges), plus a payout detail page with
// the transactions that composed it. PA-5 added payout WRITES: create lives on
// the Payments → Payouts tab; cancel (pending, T2 fresh-factor) and reverse
// (paid, T3 Discord reverse-code) live here on the detail page.

const PAGE_SIZE = 25;

// Shared with the Payments "All activity" tab view.
export const TX_TYPES = [
  { value: "charge", label: "Charges" },
  { value: "refund", label: "Refunds" },
  { value: "payout", label: "Payouts" },
  { value: "adjustment", label: "Adjustments" },
  { value: "stripe_fee", label: "Stripe fees" },
];

export function makeBalancesSection(): DashboardSectionModule {
  return {
    nav: [{ key: "balances", label: "Balances", page: "balances" }],

    ownsPage(page: string): boolean {
      return page === "balances" || page === "balances.detail";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "balances") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      if (req.page === "balances.detail") {
        const id = validId("payout", req.params?.id);
        if (!id) return notFound("That payout id is not valid (po_…).");
        return payoutDetail(ctx, id);
      }
      return null;
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const id = validId("payout", req.params?.id);
      if (!id) return { ok: false, error: "Bad payout id." };
      const confirmed = req.confirmWord === "CONFIRM";
      switch (req.key) {
        // T2 — cancel a PENDING payout; the funds return to the available balance.
        case "section:balances.payout_cancel": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          if (!ctx.security.stepUpFresh()) return { ok: false, needsStepUp: true };
          const payout = await ctx.stripe.getPayout(id).catch(() => null);
          if (!payout) return { ok: false, error: "This payout does not exist." };
          if (payout.status !== "pending") {
            return { ok: false, error: `Payout is ${payout.status} — only pending payouts can be canceled.` };
          }
          await ctx.stripe.cancelPayout(id, `dash-pocancel-${id}`);
          await ctx.audit(`Payout ${id} canceled (${ctx.stripe.formatAmount(payout.amount, payout.currency)})`);
          return { ok: true, text: `Payout ${id} canceled — the funds return to the available balance.` };
        }
        // T3 — reverse a PAID payout (debits the destination bank account).
        // Typed CONFIRM plus the Discord reverse code.
        case "section:balances.payout_reverse": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true };
          const payout = await ctx.stripe.getPayout(id).catch(() => null);
          if (!payout) return { ok: false, error: "This payout does not exist." };
          if (payout.status !== "paid") {
            return { ok: false, error: `Payout is ${payout.status} — only paid payouts can be reversed.` };
          }
          const reversedBy = typeof payout.reversed_by === "string" ? payout.reversed_by : payout.reversed_by?.id ?? null;
          if (reversedBy) return { ok: false, error: `Payout was already reversed (${reversedBy}).` };
          const reversal = await ctx.stripe.reversePayout(id, `dash-poreverse-${id}`);
          await ctx.audit(`Payout ${id} REVERSED → ${reversal.id} (${ctx.stripe.formatAmount(payout.amount, payout.currency)})`);
          return { ok: true, text: `Payout ${id} reversed — ${reversal.id} debits the destination bank account.` };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const txType = TX_TYPES.some((t) => t.value === filters.type) ? filters.type : "";
  // The cursor belongs to the PAYOUTS table only (po_ ids) — the transactions
  // table shows the latest window (one paginating table per page).
  const payoutCursor = validId("payout", validCursor(cursor) ?? "") ?? undefined;

  const [balance, payoutsRes, txRes] = await Promise.all([
    ctx.stripe.getBalance().catch(() => null),
    ctx.stripe.listPayouts({ limit: PAGE_SIZE, startingAfter: payoutCursor }),
    ctx.stripe
      .listAccountBalanceTransactions({ limit: PAGE_SIZE, ...(txType ? { type: txType } : {}) })
      .catch(() => ({ transactions: [] as Stripe.BalanceTransaction[], hasMore: false })),
  ]);

  const blocks: Block[] = [];

  const buckets = (rows: Array<{ amount: number; currency: string }> | undefined) =>
    (rows ?? []).map((b) => ctx.stripe.formatAmount(b.amount, b.currency)).join(" + ") || "—";
  blocks.push({
    type: "stats",
    items: [
      { label: "Available", value: balance ? buckets(balance.available) : "—", sub: "settled, ready to pay out" },
      { label: "Pending", value: balance ? buckets(balance.pending) : "—", sub: "settling to available" },
      ...(balance?.connect_reserved?.length
        ? [{ label: "Reserved", value: buckets(balance.connect_reserved) }]
        : []),
    ],
  });

  blocks.push({
    type: "table",
    key: "payouts",
    title: "Payouts",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "method", label: "Method" },
      { key: "arrival", label: "Arrival" },
      { key: "id", label: "ID" },
    ],
    rows: payoutsRes.payouts.map((p) => ({
      id: p.id,
      ref: { page: "balances.detail", params: { id: p.id } },
      cells: [
        amount(ctx.stripe, p.amount, p.currency, payoutBadge(p.status)),
        text(p.method === "instant" ? "Instant" : "Standard"),
        dateCell(p.arrival_date),
        idCell(p.id, { copy: true }),
      ] as Cell[],
    })),
    nextCursor:
      payoutsRes.hasMore && payoutsRes.payouts.length > 0 ? payoutsRes.payouts[payoutsRes.payouts.length - 1].id : null,
    empty: "No payouts yet.",
    ...(payoutsRes.payouts.length
      ? { footer: `${payoutsRes.payouts.length}${payoutsRes.hasMore ? "+" : ""} item${payoutsRes.payouts.length === 1 ? "" : "s"}` }
      : {}),
  });

  blocks.push({
    type: "table",
    key: "transactions",
    title: "Balance transactions",
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
    empty: "No balance transactions in this window.",
    ...(txRes.transactions.length
      ? {
          footer: `${txRes.transactions.length}${txRes.hasMore ? "+" : ""} item${txRes.transactions.length === 1 ? "" : "s"}`,
        }
      : {}),
    notice: "Latest transactions only — the payout pager above pages independently.",
  });

  return { title: "Balances", crumbs: [{ label: "Balances" }], blocks };
}

async function payoutDetail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const payout = await ctx.stripe.getPayout(id).catch(() => null);
  if (!payout) return notFound("This payout does not exist.");
  const txRes = await ctx.stripe
    .listAccountBalanceTransactions({ limit: 50, payoutId: id })
    .catch(() => ({ transactions: [] as Stripe.BalanceTransaction[], hasMore: false }));

  // Status-aware writes: cancel while pending (T2), reverse once paid (T3).
  const reversedBy = typeof payout.reversed_by === "string" ? payout.reversed_by : payout.reversed_by?.id ?? null;
  const originalPayout = typeof payout.original_payout === "string" ? payout.original_payout : payout.original_payout?.id ?? null;
  const actions: ActionButton[] = [];
  if (payout.status === "pending") {
    actions.push({
      key: "section:balances.payout_cancel",
      label: "Cancel payout",
      dangerous: true,
      stepUp: true,
      params: { id: payout.id },
      summary: "Cancels this pending payout — the funds return to the available balance. Requires a fresh factor.",
    });
  }
  if (payout.status === "paid" && !reversedBy && !originalPayout) {
    actions.push({
      key: "section:balances.payout_reverse",
      label: "Reverse payout",
      style: "danger",
      dangerous: true,
      reverseConfirm: true,
      params: { id: payout.id },
      summary:
        "Debits the destination bank account to pull this payout back (US/CA bank accounts only). Requires the Discord reverse code.",
    });
  }

  const main: Block[] = [
    {
      type: "header",
      title: ctx.stripe.formatAmount(payout.amount, payout.currency),
      titleSuffix: payout.currency.toUpperCase(),
      sub: originalPayout ? "Payout reversal" : "Payout",
      badges: [payoutBadge(payout.status), ...(reversedBy ? [{ kind: "error", text: "Reversed" } as Badge] : [])],
      actions,
    },
    {
      type: "table",
      key: "txs",
      title: "Transactions in this payout",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "fee", label: "Fee", align: "right" },
        { key: "net", label: "Net", align: "right" },
        { key: "type", label: "Type" },
        { key: "id", label: "Source" },
      ],
      rows: txRes.transactions.map((t) => ({
        id: t.id,
        ...(sourceRef(t) ? { ref: sourceRef(t)! } : {}),
        cells: [
          amount(ctx.stripe, t.amount, t.currency),
          money(ctx.stripe, -t.fee, t.currency, t.fee ? "muted" : undefined),
          money(ctx.stripe, t.net, t.currency, t.net >= 0 ? "pos" : "neg"),
          text(sentence(t.type.replace(/_/g, " "))),
          typeof t.source === "string" ? idCell(t.source, { copy: true }) : text("—"),
        ] as Cell[],
      })),
      empty: "Stripe has not attached transactions to this payout (yet).",
      ...(txRes.transactions.length
        ? { footer: `${txRes.transactions.length}${txRes.hasMore ? "+" : ""} item${txRes.transactions.length === 1 ? "" : "s"}` }
        : {}),
    },
  ];

  const rail: Block[] = [
    {
      type: "kv",
      title: "Details",
      rows: [
        { label: "Payout ID", cell: idCell(payout.id, { copy: true }) },
        { label: "Status", cell: badgeCell(payoutBadge(payout.status).kind, sentence(payout.status)) },
        { label: "Method", cell: text(payout.method === "instant" ? "Instant" : "Standard") },
        { label: "Arrival date", cell: dateCell(payout.arrival_date) },
        { label: "Created", cell: dateCell(payout.created) },
        ...(typeof payout.destination === "string"
          ? [{ label: "Destination", cell: idCell(payout.destination, { copy: true }) }]
          : []),
        ...(payout.description ? [{ label: "Description", cell: text(payout.description) }] : []),
        ...(payout.statement_descriptor ? [{ label: "Statement descriptor", cell: text(payout.statement_descriptor) }] : []),
        ...(reversedBy
          ? [{ label: "Reversed by", cell: idCell(reversedBy, { copy: true, ref: { page: "balances.detail", params: { id: reversedBy } } }) }]
          : []),
        ...(originalPayout
          ? [{ label: "Reversal of", cell: idCell(originalPayout, { copy: true, ref: { page: "balances.detail", params: { id: originalPayout } } }) }]
          : []),
        ...(payout.failure_message ? [{ label: "Failure", cell: badgeCell("error", payout.failure_message.slice(0, 120)) }] : []),
      ],
    },
  ];

  return {
    title: ctx.stripe.formatAmount(payout.amount, payout.currency),
    crumbs: [{ label: "Balances", ref: { page: "balances" } }, { label: payout.id, copyId: payout.id }],
    blocks: main,
    rail,
  };
}

export function payoutBadge(status: string): Badge {
  const kind: Badge["kind"] =
    status === "paid" ? "ok" : status === "failed" || status === "canceled" ? "error" : "warn"; // pending / in_transit
  return { kind, text: sentence(status.replace(/_/g, " ")) };
}

// Link a balance transaction to its source object when we have a page for it.
// (Also used by the Payments "All activity" tab view.)
export function sourceRef(t: Stripe.BalanceTransaction): { page: string; params: { id: string } } | null {
  const source = typeof t.source === "string" ? t.source : null;
  if (!source) return null;
  if (/^(ch|py)_/.test(source)) return { page: "payments.detail", params: { id: source } };
  if (/^po_/.test(source)) return { page: "balances.detail", params: { id: source } };
  if (/^re_/.test(source)) return null; // refund objects have no page yet
  return null;
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Balances", ref: { page: "balances" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Payout not found", hint }],
  };
}
