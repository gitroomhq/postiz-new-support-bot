import { Badge, Block, Cell, ObjectRef } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage } from "./types";
import { badgeCell, isoDateCell, money, refForId, text } from "./cells";
import { StripeClient } from "../../bot/StripeClient";
import type { StripeMoneyOut } from "../../bot/billing/MoneyOutStore";
import {
  ALL_CATEGORIES,
  BUCKET_OF,
  type MoneyOutBucket,
  type MoneyOutCategory,
} from "../../bot/billing/moneyOutTaxonomy";

// Money out (#/money-out): every euro that left the Stripe account, whatever
// caused it and whichever surface issued it — including refunds made straight
// from the Stripe Dashboard, which no other page here can see.
//
// Everything renders from the local ledger mirror, so a page load is a handful
// of indexed Postgres queries and zero Stripe calls. That is the point of the
// mirror: the Stripe API cannot answer "what did we lose last month" without a
// multi-page sweep on every render.

const PAGE_SIZE = 25;

const WINDOWS = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
  { value: "365d", label: "Last 12 months", days: 365 },
];

const BUCKET_LABELS: Record<MoneyOutBucket, string> = {
  CASH: "Cash reversed",
  FEES: "Stripe fees",
  CONCESSION: "Concessions",
};

const BUCKET_SUBS: Record<MoneyOutBucket, string> = {
  CASH: "Refunds and disputes",
  FEES: "Processing and chargeback fees",
  CONCESSION: "Credits, discounts, write-offs",
};

const CATEGORY_LABELS: Record<MoneyOutCategory, string> = {
  refund: "Refunds",
  refund_failure: "Refunds returned",
  dispute: "Disputes",
  dispute_reversal: "Disputes reversed",
  dispute_fee: "Dispute fees",
  stripe_fee: "Stripe fees",
  credit_note: "Credit notes",
  discount: "Discounts",
  write_off: "Write-offs",
  credit_grant: "Credit grants",
  balance_credit: "Balance credits",
};

export function makeMoneyOutSection(): DashboardSectionModule {
  return {
    nav: [{ key: "money-out", label: "Money out", page: "money-out", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "money-out";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page !== "money-out") return null;
      return list(ctx, req.filters ?? {}, req.cursor ?? null);
    },
  };
}

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const window = WINDOWS.find((w) => w.value === filters.window) ?? WINDOWS[1];
  const bucket = (["CASH", "FEES", "CONCESSION"] as const).find((b) => b === filters.bucket) ?? null;
  const category = ALL_CATEGORIES.find((c) => c === filters.category) ?? null;
  const skip = Math.max(0, Number.parseInt(cursor ?? "0", 10) || 0);

  const to = new Date();
  const from = new Date(to.getTime() - window.days * 86_400_000);

  const [totals, page, topCustomers] = await Promise.all([
    ctx.stores.moneyOut.windowTotals(from, to),
    ctx.stores.moneyOut.page({ bucket, category, from, to }, skip, PAGE_SIZE),
    ctx.stores.moneyOut.topCustomers(from, to, 5),
  ]);

  const enabled = ctx.settings.moneyOutEnabled();
  const lastSweep = ctx.settings.moneyOutSweepAt();
  const backfilled = ctx.settings.moneyOutBackfillDoneAt();

  const blocks: Block[] = [];

  blocks.push({
    type: "header",
    title: "Money out",
    sub: `Every outflow from the Stripe account over the ${window.label.toLowerCase()}, whatever issued it.`,
    badges: enabled
      ? [{ kind: "ok", text: "Ledger active" } as Badge]
      : [{ kind: "warn", text: "Ledger disabled" } as Badge],
  });

  if (!enabled) {
    blocks.push({
      type: "notice",
      badge: { kind: "warn", text: "Disabled" },
      text: "The money-out ledger is switched off, so nothing new is being recorded. Enable it in /config → Billing → Money out.",
    });
  } else if (!backfilled) {
    blocks.push({
      type: "notice",
      badge: { kind: "info", text: "No history" },
      text: "History has never been backfilled, so figures only cover the period since the ledger was enabled. Run /config → Billing → Money out → Backfill history for all-time totals.",
    });
  }

  // Currency handling: pick the account's dominant currency for the headline
  // tiles and say so, rather than summing cents into yen.
  const currency = dominantCurrency(totals.map((t) => t.currency)) ?? "usd";
  const inCurrency = totals.filter((t) => t.currency === currency);
  const otherCurrencies = [...new Set(totals.filter((t) => t.currency !== currency).map((t) => t.currency))];

  const byBucket = new Map<MoneyOutBucket, number>([
    ["CASH", 0],
    ["FEES", 0],
    ["CONCESSION", 0],
  ]);
  for (const t of inCurrency) byBucket.set(t.bucket, (byBucket.get(t.bucket) ?? 0) + t.amountMinor);
  const grandTotal = [...byBucket.values()].reduce((a, b) => a + b, 0);

  blocks.push({
    type: "stats",
    items: [
      {
        label: "Total out",
        value: ctx.stripe.formatAmount(grandTotal, currency),
        sub: `${window.label} · net of reversals`,
      },
      ...[...byBucket.entries()].map(([b, minor]) => ({
        label: BUCKET_LABELS[b],
        value: ctx.stripe.formatAmount(minor, currency),
        sub: BUCKET_SUBS[b],
      })),
    ],
  });

  if (otherCurrencies.length > 0) {
    blocks.push({
      type: "notice",
      badge: { kind: "info", text: "Multi-currency" },
      text: `Totals show ${currency.toUpperCase()} only. This window also has activity in ${otherCurrencies
        .map((c) => c.toUpperCase())
        .join(", ")} — filter the table to see it.`,
    });
  }

  blocks.push({ type: "chart", key: "money_out_daily", title: "Outflow per day", kind: "bars", window: chartWindow(window.value) });
  blocks.push({
    type: "chart",
    key: "money_out_by_category",
    title: "Outflow by category",
    kind: "bars",
    window: chartWindow(window.value),
  });

  // Category breakdown as a table rather than a legend: the numbers matter more
  // than the shape, and every row is a filter into the ledger below.
  const categoryRows = inCurrency
    .filter((t) => t.amountMinor !== 0)
    .sort((a, b) => b.amountMinor - a.amountMinor)
    .map((t) => ({
      id: t.category,
      cells: [
        text(CATEGORY_LABELS[t.category] ?? t.category, BUCKET_LABELS[t.bucket]),
        money(ctx.stripe, t.amountMinor, t.currency, t.amountMinor < 0 ? "pos" : "neg"),
        text(String(t.count)),
        text(percentOf(t.amountMinor, grandTotal)),
      ] as Cell[],
      ref: { page: "money-out", filters: { category: t.category, window: window.value } } as ObjectRef,
    }));

  blocks.push({
    type: "table",
    key: "money-out-categories",
    title: "By category",
    columns: [
      { key: "category", label: "Category" },
      { key: "amount", label: "Amount", align: "right" },
      { key: "count", label: "Events", align: "right" },
      { key: "share", label: "Share", align: "right" },
    ],
    rows: categoryRows,
    empty: "Nothing left the account in this window.",
    exportable: true,
  });

  if (topCustomers.length > 0) {
    blocks.push({
      type: "table",
      key: "money-out-customers",
      title: "Costliest customers",
      columns: [
        { key: "customer", label: "Customer" },
        { key: "amount", label: "Amount", align: "right" },
        { key: "count", label: "Events", align: "right" },
      ],
      rows: topCustomers.map((c) => ({
        id: c.customerId,
        cells: [text(c.customerId), money(ctx.stripe, c.amountMinor, currency, "neg"), text(String(c.count))] as Cell[],
        ...(refForId(c.customerId) ? { ref: refForId(c.customerId)! } : {}),
      })),
      empty: "No customer-attributed outflow in this window.",
    });
  }

  blocks.push({
    type: "table",
    key: "money-out-ledger",
    title: "Ledger",
    columns: [
      { key: "when", label: "When" },
      { key: "category", label: "Category" },
      { key: "amount", label: "Amount", align: "right" },
      { key: "object", label: "Object" },
      { key: "origin", label: "Recorded by" },
    ],
    counts: {
      key: "bucket",
      items: [
        { value: "", label: "All", count: totals.reduce((n, t) => n + t.count, 0) },
        ...(["CASH", "FEES", "CONCESSION"] as MoneyOutBucket[]).map((b) => ({
          value: b,
          label: BUCKET_LABELS[b],
          count: totals.filter((t) => t.bucket === b).reduce((n, t) => n + t.count, 0),
        })),
      ],
    },
    filters: [
      { key: "window", label: "Period", kind: "select", value: window.value, options: WINDOWS.map((w) => ({ value: w.value, label: w.label })) },
      {
        key: "category",
        label: "Category",
        kind: "select",
        value: category ?? "",
        options: [
          { value: "", label: "All categories" },
          ...ALL_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
        ],
      },
    ],
    rows: page.rows.map((r) => ledgerRow(ctx.stripe, r)),
    nextCursor: skip + PAGE_SIZE < page.total ? String(skip + PAGE_SIZE) : null,
    empty: "No outflow recorded for this filter.",
    footer: `${page.total} item${page.total === 1 ? "" : "s"}`,
    notice: lastSweep
      ? `Reconciled with Stripe's balance transactions ${describeAge(lastSweep)}. Refunds issued in the Stripe Dashboard appear here too.`
      : "Never reconciled with Stripe yet — only events seen live are listed.",
    exportable: true,
  });

  return {
    title: "Money out",
    crumbs: [{ label: "Money out" }],
    blocks,
  };
}

function ledgerRow(stripe: StripeClient, r: StripeMoneyOut): { id: string; cells: Cell[]; ref?: ObjectRef } {
  const category = r.category as MoneyOutCategory;
  const bucket = BUCKET_OF[category] ?? (r.bucket as MoneyOutBucket);
  // A negative row is money that came BACK (a reversed dispute, a failed
  // refund) — it reads as good news, so it gets the positive tone.
  const returned = r.amountMinor < 0;
  const objectRef = r.chargeId ? refForId(r.chargeId) : r.stripeObjectId ? refForId(r.stripeObjectId) : null;
  return {
    id: r.id,
    cells: [
      isoDateCell(r.occurredAt),
      text(CATEGORY_LABELS[category] ?? r.category, BUCKET_LABELS[bucket]),
      money(stripe, r.amountMinor, r.currency, returned ? "pos" : "neg"),
      text(r.stripeObjectId ?? r.chargeId ?? "—", r.reason ?? undefined),
      badgeCell(r.source === "webhook" ? "ok" : r.source === "backfill" ? "neutral" : "info", r.source),
    ],
    ...(objectRef ? { ref: objectRef } : {}),
  };
}

// The charts only know the three HomeMetrics windows; 365d falls back to the
// widest one they support rather than silently rendering an empty series.
function chartWindow(value: string): string {
  return value === "365d" ? "90d" : value;
}

function percentOf(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

function dominantCurrency(currencies: string[]): string | null {
  const counts = new Map<string, number>();
  for (const c of currencies) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [c, n] of counts) {
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

function describeAge(at: Date): string {
  const mins = Math.round((Date.now() - at.getTime()) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 90) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
