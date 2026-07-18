import type Stripe from "stripe";
import { Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, validCursor, validId } from "./types";
import { amount, badgeCell, dateCell, idCell, money, sentence, text } from "./cells";

// Balances: account balance buckets, the payout ledger (paginated) and recent
// balance transactions (fees/refunds/charges), plus a payout detail page with
// the transactions that composed it. Read-only — payout scheduling stays in
// the real Stripe dashboard.

const PAGE_SIZE = 25;

const TX_TYPES = [
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

  const main: Block[] = [
    {
      type: "header",
      title: ctx.stripe.formatAmount(payout.amount, payout.currency),
      titleSuffix: payout.currency.toUpperCase(),
      sub: "Payout",
      badges: [payoutBadge(payout.status)],
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
        ...(payout.statement_descriptor ? [{ label: "Statement descriptor", cell: text(payout.statement_descriptor) }] : []),
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

function payoutBadge(status: string): Badge {
  const kind: Badge["kind"] =
    status === "paid" ? "ok" : status === "failed" || status === "canceled" ? "error" : "warn"; // pending / in_transit
  return { kind, text: sentence(status.replace(/_/g, " ")) };
}

// Link a balance transaction to its source object when we have a page for it.
function sourceRef(t: Stripe.BalanceTransaction): { page: string; params: { id: string } } | null {
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
