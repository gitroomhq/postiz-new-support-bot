import type Stripe from "stripe";
import { ActionButton, ActionResult, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor } from "./types";
import { badgeCell, dateCell, idCell, money, sentence, strong, text, windowCount } from "./cells";

// Quotes (#/quotes, PA-7b): price proposals with a lifecycle — draft → open
// (finalized) → accepted (mints the subscription/invoice) or canceled. Writes
// are section actions with LIVE status revalidation (payout precedent):
// finalize/cancel = T1 typed-CONFIRM, accept = T2 (fresh factor) because it
// creates the billable subscription/invoice. Create is a minimal one-price
// draft composer; richer quotes stay in the real Stripe dashboard.

const QUOTE_ID_RE = /^qt_[A-Za-z0-9]{1,64}$/;
const PRICE_RE = /^price_[A-Za-z0-9]{1,64}$/;
const CUSTOMER_RE = /^cus_[A-Za-z0-9]{1,64}$/;

const STATUSES: Stripe.Quote.Status[] = ["draft", "open", "accepted", "canceled"];

export function makeQuotesSection(): DashboardSectionModule {
  return {
    nav: [{ key: "quotes", label: "Quotes", page: "quotes" }],

    ownsPage(page: string): boolean {
      return page === "quotes" || page === "quotes.detail";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "quotes") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      const id = typeof req.params?.id === "string" && QUOTE_ID_RE.test(req.params.id) ? req.params.id : null;
      if (!id) return notFound("That quote id is not valid (qt_…).");
      return detail(ctx, id);
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const p = req.params ?? {};
      // Create has no target id; every lifecycle op validates + revalidates one.
      if (req.key === "section:quotes.create") {
        const customerId = typeof p.customer === "string" && CUSTOMER_RE.test(p.customer.trim()) ? p.customer.trim() : null;
        if (!customerId) return { ok: false, fieldErrors: { customer: "Enter a customer id (cus_…)." } };
        const priceId = typeof p.price === "string" && PRICE_RE.test(p.price) ? p.price : null;
        if (!priceId) return { ok: false, fieldErrors: { price: "Pick a price." } };
        const quantity =
          typeof p.quantity === "number" && Number.isSafeInteger(p.quantity) && p.quantity >= 1 && p.quantity <= 999
            ? p.quantity
            : 1;
        const quote = await ctx.stripe.createQuote(
          { customerId, priceId, quantity },
          `dash-quote-${customerId}-${Date.now().toString(36)}`
        );
        await ctx.audit(`Quote ${quote.id} drafted for ${customerId} (${priceId} ×${quantity})`);
        return { ok: true, text: `Draft quote ${quote.id} created — finalize it to make it acceptable.` };
      }

      const id = typeof p.id === "string" && QUOTE_ID_RE.test(p.id) ? p.id : null;
      if (!id) return { ok: false, error: "Bad quote id." };
      const confirmed = req.confirmWord === "CONFIRM";
      switch (req.key) {
        // T1 — draft → open: assigns the number, customer can accept.
        case "section:quotes.finalize": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const quote = await ctx.stripe.getQuote(id).catch(() => null);
          if (!quote) return { ok: false, error: "This quote does not exist." };
          if (quote.status !== "draft") {
            return { ok: false, error: `Quote is ${quote.status} — only draft quotes can be finalized.` };
          }
          const finalized = await ctx.stripe.finalizeQuote(id, `dash-qtfinal-${id}`);
          await ctx.audit(`Quote ${id} finalized (${finalized.number ?? "no number"})`);
          return { ok: true, text: `Quote ${id} is now open${finalized.number ? ` as ${finalized.number}` : ""} — it can be accepted.` };
        }
        // T1 — kill a draft/open quote (accepted quotes are immutable history).
        case "section:quotes.cancel": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const quote = await ctx.stripe.getQuote(id).catch(() => null);
          if (!quote) return { ok: false, error: "This quote does not exist." };
          if (quote.status !== "draft" && quote.status !== "open") {
            return { ok: false, error: `Quote is ${quote.status} — only draft or open quotes can be canceled.` };
          }
          await ctx.stripe.cancelQuote(id, `dash-qtcancel-${id}`);
          await ctx.audit(`Quote ${id} canceled (was ${quote.status})`);
          return { ok: true, text: `Quote ${id} canceled.` };
        }
        // T2 — accepting creates the subscription/invoice the quote describes.
        case "section:quotes.accept": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          if (!ctx.security.stepUpFresh()) return { ok: false, needsStepUp: true };
          const quote = await ctx.stripe.getQuote(id).catch(() => null);
          if (!quote) return { ok: false, error: "This quote does not exist." };
          if (quote.status !== "open") {
            return { ok: false, error: `Quote is ${quote.status} — only open (finalized) quotes can be accepted.` };
          }
          const accepted = await ctx.stripe.acceptQuote(id, `dash-qtaccept-${id}`);
          const subId = typeof accepted.subscription === "string" ? accepted.subscription : accepted.subscription?.id ?? null;
          const invId = typeof accepted.invoice === "string" ? accepted.invoice : accepted.invoice?.id ?? null;
          await ctx.audit(
            `Quote ${id} ACCEPTED (${ctx.stripe.formatAmount(quote.amount_total, quote.currency ?? "usd")})${subId ? ` → ${subId}` : ""}${invId ? ` → ${invId}` : ""}`
          );
          return {
            ok: true,
            text: `Quote ${id} accepted${subId ? ` — subscription ${subId}` : ""}${invId ? `${subId ? "," : " —"} invoice ${invId}` : ""}.`,
          };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

export function quoteBadge(status: Stripe.Quote.Status): Badge {
  const kind: Badge["kind"] =
    status === "accepted" ? "ok" : status === "open" ? "info" : status === "canceled" ? "error" : "neutral";
  return { kind, text: sentence(status) };
}

function customerBits(q: Stripe.Quote): { id: string | null; label: string } {
  const c = q.customer;
  if (typeof c === "string") return { id: c, label: c };
  if (c && !("deleted" in c && c.deleted)) {
    const cust = c as Stripe.Customer;
    return { id: cust.id, label: cust.name ?? cust.email ?? cust.id };
  }
  return { id: null, label: "—" };
}

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const rawCursor = validCursor(cursor) ?? "";
  const startingAfter = QUOTE_ID_RE.test(rawCursor) ? rawCursor : undefined;
  const statusFilter = STATUSES.includes(str(filters.status, 12) as Stripe.Quote.Status) ? str(filters.status, 12) : "";
  const [quotesRes, prices] = await Promise.all([
    ctx.stripe.listQuotes({ limit: 25, startingAfter }),
    ctx.stripe.listAllActivePrices(100).catch(() => [] as Stripe.Price[]),
  ]);
  const quotes = quotesRes.quotes.filter((q) => (statusFilter ? q.status === statusFilter : true));

  const priceOptions = prices.slice(0, 25).map((p) => ({
    value: p.id,
    label: `${p.nickname ?? p.id.slice(0, 18)} — ${p.unit_amount != null ? ctx.stripe.formatAmount(p.unit_amount, p.currency) : "?"}${p.recurring ? `/${p.recurring.interval}` : ""}`,
  }));

  const blocks: Block[] = [
    {
      type: "header",
      title: "Quotes",
      actions: [
        {
          key: "section:quotes.create",
          label: "New quote",
          style: "primary",
          inputs: [
            { type: "text", key: "customer", label: "Customer id (cus_…)", placeholder: "cus_…", maxLength: 70 },
            { type: "select", key: "price", label: "Price", options: priceOptions },
            { type: "number", key: "quantity", label: "Quantity (default 1)", min: 1, max: 999 },
          ],
          summary: "Creates a DRAFT quote for one price — nothing is billable until it's finalized and accepted.",
        },
      ],
    },
    {
      type: "table",
      key: "quotes",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "customer", label: "Customer" },
        { key: "number", label: "Number" },
        { key: "expires", label: "Expires" },
        { key: "id", label: "ID" },
      ],
      // Quotes have no Search API — counts are windowed, suffixed "+" when
      // the window overflowed so they never read as exact totals.
      counts: {
        key: "status",
        items: [
          { value: "", label: "All", count: windowCount(quotesRes.quotes.length, quotesRes.hasMore) },
          ...STATUSES.map((s) => ({
            value: s,
            label: sentence(s),
            count: windowCount(quotesRes.quotes.filter((q) => q.status === s).length, quotesRes.hasMore),
          })),
        ],
      },
      exportable: true,
      rows: quotes.map((q) => {
        const cust = customerBits(q);
        return {
          id: q.id,
          ref: { page: "quotes.detail", params: { id: q.id } },
          cells: [
            {
              t: "amount",
              v: ctx.stripe.formatAmount(q.amount_total, q.currency ?? "usd"),
              cur: (q.currency ?? "usd").toUpperCase(),
              badge: quoteBadge(q.status),
            } as Cell,
            cust.id
              ? ({ t: "link", v: cust.label, ref: { page: "customers.detail", params: { id: cust.id } } } as Cell)
              : text("—"),
            text(q.number ?? "—"),
            dateCell(q.expires_at),
            idCell(q.id, { copy: true }),
          ] as Cell[],
        };
      }),
      nextCursor:
        quotesRes.hasMore && quotesRes.quotes.length > 0 ? quotesRes.quotes[quotesRes.quotes.length - 1].id : null,
      empty: statusFilter ? "No quotes match this filter (within this window)." : "No quotes yet — draft one above.",
      ...(quotes.length ? { footer: `${quotes.length} item${quotes.length === 1 ? "" : "s"}` } : {}),
      notice: "Counts cover this page's window. Accepting a quote creates its subscription/invoice.",
    },
  ];
  return { title: "Quotes", crumbs: [{ label: "Quotes" }], blocks };
}

async function detail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const quote = await ctx.stripe.getQuote(id).catch(() => null);
  if (!quote) return notFound("This quote does not exist.");
  const items = quote.line_items?.data ?? [];
  const cust = customerBits(quote);
  const subId = typeof quote.subscription === "string" ? quote.subscription : quote.subscription?.id ?? null;
  const invId = typeof quote.invoice === "string" ? quote.invoice : quote.invoice?.id ?? null;

  // Status-aware writes: finalize/cancel while draft, accept/cancel while open.
  const actions: ActionButton[] = [];
  if (quote.status === "draft") {
    actions.push({
      key: "section:quotes.finalize",
      label: "Finalize",
      style: "primary",
      dangerous: true,
      params: { id: quote.id },
      summary: "Finalizes the draft — the quote opens, gets its number, and can be accepted.",
    });
  }
  if (quote.status === "open") {
    actions.push({
      key: "section:quotes.accept",
      label: "Accept",
      style: "primary",
      dangerous: true,
      stepUp: true,
      params: { id: quote.id },
      summary:
        "Accepts on the customer's behalf — Stripe creates the subscription/invoice this quote describes. Requires a fresh factor.",
    });
  }
  if (quote.status === "draft" || quote.status === "open") {
    actions.push({
      key: "section:quotes.cancel",
      label: "Cancel quote",
      style: "danger",
      dangerous: true,
      params: { id: quote.id },
      summary: "Cancels the quote — it can no longer be finalized or accepted.",
    });
  }

  const main: Block[] = [
    {
      type: "header",
      title: ctx.stripe.formatAmount(quote.amount_total, quote.currency ?? "usd"),
      titleSuffix: (quote.currency ?? "usd").toUpperCase(),
      sub: quote.number ? `Quote ${quote.number}` : "Quote",
      badges: [quoteBadge(quote.status)],
      actions,
    },
    {
      type: "table",
      key: "items",
      title: "Line items",
      columns: [
        { key: "desc", label: "Description" },
        { key: "qty", label: "Qty", align: "right" },
        { key: "amount", label: "Amount", align: "right" },
      ],
      rows: items.map((li, i) => ({
        id: li.id ?? String(i),
        cells: [
          text(li.description ?? "item"),
          text(String(li.quantity ?? 1)),
          money(ctx.stripe, li.amount_total ?? 0, li.currency),
        ] as Cell[],
      })),
      empty: "No line items (expand unavailable).",
    },
    {
      type: "kv",
      title: "Totals",
      amounts: true,
      rows: [
        { label: "Subtotal", cell: money(ctx.stripe, quote.amount_subtotal, quote.currency ?? "usd") },
        { label: "Total", cell: money(ctx.stripe, quote.amount_total, quote.currency ?? "usd") },
      ],
    },
  ];

  const rail: Block[] = [
    {
      type: "kv",
      title: "Details",
      rows: [
        { label: "Quote ID", cell: idCell(quote.id, { copy: true }) },
        { label: "Status", cell: badgeCell(quoteBadge(quote.status).kind, quoteBadge(quote.status).text) },
        {
          label: "Customer",
          cell: cust.id
            ? ({ t: "link", v: cust.label, ref: { page: "customers.detail", params: { id: cust.id } } } as Cell)
            : text("—"),
        },
        ...(quote.number ? [{ label: "Number", cell: text(quote.number) }] : []),
        { label: "Expires", cell: dateCell(quote.expires_at) },
        { label: "Created", cell: dateCell(quote.created) },
        ...(subId
          ? [{ label: "Subscription", cell: idCell(subId, { copy: true, ref: { page: "subscriptions.detail", params: { id: subId } } }) }]
          : []),
        ...(invId
          ? [{ label: "Invoice", cell: idCell(invId, { copy: true, ref: { page: "invoices.detail", params: { id: invId } } }) }]
          : []),
      ],
    },
  ];

  return {
    title: quote.number ?? quote.id,
    crumbs: [{ label: "Quotes", ref: { page: "quotes" } }, { label: quote.id, copyId: quote.id }],
    blocks: main,
    rail,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Quotes", ref: { page: "quotes" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Quote not found", hint }],
  };
}
