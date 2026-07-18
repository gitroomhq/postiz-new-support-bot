import type Stripe from "stripe";
import { Badge, Block, Cell, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";

// Customers: account-wide browse/search + the read-only Customer 360. M0 scope
// is deliberately read-only — write actions (edit/create/link/block) arrive
// with the action-gateway milestone.

const PAGE_SIZE = 25;

export function makeCustomersSection(): DashboardSectionModule {
  return {
    nav: [{ key: "customers", label: "Customers", page: "customers" }],

    ownsPage(page: string): boolean {
      return page === "customers" || page === "customers.detail";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "customers") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      if (req.page === "customers.detail") {
        const id = validId("customer", req.params?.id);
        if (!id) return notFound("That customer id is not valid.");
        return detail(ctx, id);
      }
      return null;
    },
  };
}

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const q = str(filters.q, 80);
  let customers: Stripe.Customer[];
  let hasMore = false;
  let notice: string | undefined;
  if (q) {
    customers = await ctx.stripe.searchCustomersByTerm(q, PAGE_SIZE);
    notice = "Search results (name/email fuzzy match) — may lag Stripe by ~1 minute.";
  } else {
    const page = await ctx.stripe.listCustomersPage({ limit: PAGE_SIZE, startingAfter: validCursor(cursor) ?? undefined });
    customers = page.customers;
    hasMore = page.hasMore;
  }

  const table: TableBlock = {
    type: "table",
    key: "customers",
    columns: [
      { key: "email", label: "Email" },
      { key: "name", label: "Name" },
      { key: "flags", label: "Flags" },
      { key: "created", label: "Created" },
      { key: "id", label: "ID" },
    ],
    filters: [{ key: "q", label: "Search", kind: "text", value: q || undefined, placeholder: "name or email" }],
    rows: customers.map((c) => ({
      id: c.id,
      ref: { page: "customers.detail", params: { id: c.id } },
      cells: [
        { t: "text", v: c.email ?? "—" },
        { t: "text", v: c.name ?? "—" },
        { t: "flags", badges: c.delinquent ? [{ kind: "warn", text: "DELINQUENT" }] : [] },
        dateCell(c.created),
        { t: "id", v: c.id, copy: true },
      ] as Cell[],
    })),
    nextCursor: !q && hasMore && customers.length > 0 ? customers[customers.length - 1].id : null,
    empty: q ? "No customers match that search." : "No customers yet.",
    notice,
  };

  return { title: "Customers", crumbs: [{ label: "Customers" }], blocks: [table] };
}

async function detail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const customer = await ctx.stripe.getCustomer(id).catch(() => null);
  if (!customer) {
    return notFound("This customer does not exist (or was deleted).");
  }

  const [subs, invoices, methods, chargesPage, disputes, blocks, discordIds, notes] = await Promise.all([
    ctx.stripe.listSubscriptions(id).catch(() => [] as Stripe.Subscription[]),
    ctx.stripe.listInvoices(id, 10).catch(() => ({ invoices: [] as Stripe.Invoice[], hasMore: false })),
    ctx.stripe.listAllPaymentMethods(id).catch(() => [] as Stripe.PaymentMethod[]),
    ctx.stripe.listCharges(id, 100).catch(() => ({ charges: [] as Stripe.Charge[], hasMore: false })),
    ctx.stores.dispute.listByCustomer(id, 10).catch(() => []),
    ctx.stores.block.listForCustomer(id, customer.email).catch(() => []),
    ctx.stores.session.findDiscordIdsByStripeId(id).catch(() => [] as string[]),
    ctx.stores.qol.listNotes("customer", id, 0, 5).catch(() => ({ rows: [], total: 0 })),
  ]);

  const out: Block[] = [];

  // Header: name/email + status badges.
  const headBadges: Badge[] = [];
  if (customer.delinquent) headBadges.push({ kind: "warn", text: "DELINQUENT" });
  if (blocks.length > 0) headBadges.push({ kind: "error", text: "BLOCKED" });
  out.push({
    type: "header",
    title: customer.name || customer.email || customer.id,
    id: customer.id,
    badges: headBadges,
  });

  // Blocklist banner (error notice with the first block's context).
  if (blocks.length > 0) {
    const b = blocks[0];
    out.push({
      type: "notice",
      badge: { kind: "error", text: "BLOCKED" },
      text:
        `${b.kind} "${b.value}" — ${b.reason}` +
        (b.actorName ? ` · added by ${b.actorName}` : "") +
        ` · ${b.createdAt.toISOString().slice(0, 10)}` +
        (blocks.length > 1 ? ` (+${blocks.length - 1} more entries)` : ""),
    });
  }

  // Stat row: lifetime spend, balance, open invoices, disputes.
  const succeeded = chargesPage.charges.filter((c) => c.status === "succeeded");
  const spendByCurrency = new Map<string, number>();
  for (const c of succeeded) {
    spendByCurrency.set(c.currency, (spendByCurrency.get(c.currency) ?? 0) + (c.amount - (c.amount_refunded ?? 0)));
  }
  const lifetime =
    [...spendByCurrency.entries()].map(([cur, amt]) => ctx.stripe.formatAmount(amt, cur)).join(" + ") || "—";
  const openInvoices = invoices.invoices.filter((i) => i.status === "open");
  const openTotal = openInvoices.reduce((sum, i) => sum + (i.amount_due ?? 0), 0);
  const balance =
    customer.currency != null
      ? ctx.stripe.formatAmount(customer.balance, customer.currency)
      : String(customer.balance ?? 0);
  out.push({
    type: "stats",
    items: [
      {
        label: "Lifetime spend",
        value: lifetime,
        sub: chargesPage.hasMore ? "from the 100 most recent charges" : `${succeeded.length} succeeded charges`,
      },
      { label: "Balance", value: balance, sub: customer.balance < 0 ? "negative = customer credit" : undefined },
      {
        label: "Open invoices",
        value: String(openInvoices.length),
        sub: openInvoices.length
          ? openInvoices[0].currency
            ? ctx.stripe.formatAmount(openTotal, openInvoices[0].currency)
            : undefined
          : undefined,
      },
      {
        label: "Disputes",
        value: String(disputes.length),
        badge: disputes.some((d) => d.status.includes("needs_response"))
          ? { kind: "error", text: "needs response" }
          : undefined,
      },
    ],
  });

  // Profile.
  const defaultPm =
    typeof customer.invoice_settings?.default_payment_method === "string"
      ? customer.invoice_settings.default_payment_method
      : (customer.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null)?.id ?? null;
  out.push({
    type: "kv",
    title: "Profile",
    rows: [
      { label: "Email", cell: text(customer.email ?? "—") },
      { label: "Name", cell: text(customer.name ?? "—") },
      { label: "Created", cell: dateCell(customer.created) },
      { label: "Currency", cell: text(customer.currency?.toUpperCase() ?? "—") },
      { label: "Delinquent", cell: customer.delinquent ? badge("warn", "yes") : text("no") },
      { label: "Tax exempt", cell: text(customer.tax_exempt ?? "none") },
      { label: "Locale", cell: text(customer.preferred_locales?.join(", ") || "—") },
      { label: "Default payment method", cell: defaultPm ? { t: "id", v: defaultPm, copy: true } : text("—") },
      ...(customer.description ? [{ label: "Description", cell: text(customer.description) }] : []),
    ],
  });

  // Subscriptions.
  out.push({
    type: "table",
    key: "subs",
    title: `Subscriptions (${subs.length})`,
    columns: [
      { key: "plan", label: "Plan" },
      { key: "status", label: "Status" },
      { key: "flags", label: "Flags" },
      { key: "period", label: "Period end" },
      { key: "id", label: "ID" },
    ],
    rows: subs.slice(0, 25).map((sub) => {
      const item = sub.items.data[0];
      const price = item?.price;
      const plan = price?.nickname ?? (typeof price?.product === "string" ? price.product : price?.id) ?? "plan";
      const amount =
        price?.unit_amount != null
          ? `${ctx.stripe.formatAmount(price.unit_amount * (item?.quantity ?? 1), price.currency)}/${price.recurring?.interval ?? "?"}`
          : null;
      const flags: Badge[] = [];
      if (sub.pause_collection) flags.push({ kind: "warn", text: "paused" });
      if (sub.cancel_at_period_end) flags.push({ kind: "warn", text: "cancels at period end" });
      return {
        id: sub.id,
        cells: [
          { t: "text", v: plan, sub: amount ?? undefined },
          statusBadge(sub.status),
          { t: "flags", badges: flags },
          item?.current_period_end ? dateCell(item.current_period_end) : text("—"),
          { t: "id", v: sub.id, copy: true },
        ] as Cell[],
      };
    }),
    empty: "No subscriptions.",
    ...(subs.length > 25 ? { notice: `Showing 25 of ${subs.length} subscriptions.` } : {}),
  });

  // Payment methods.
  out.push({
    type: "table",
    key: "pms",
    title: `Payment methods (${methods.length})`,
    columns: [
      { key: "method", label: "Method" },
      { key: "default", label: "Default" },
      { key: "id", label: "ID" },
    ],
    rows: methods.slice(0, 25).map((pm) => {
      const label =
        pm.type === "card" && pm.card
          ? `${pm.card.brand} •••• ${pm.card.last4} (exp ${pm.card.exp_month}/${pm.card.exp_year})`
          : pm.type;
      return {
        id: pm.id,
        cells: [
          text(label),
          pm.id === defaultPm ? badge("ok", "default") : text("—"),
          { t: "id", v: pm.id, copy: true },
        ] as Cell[],
      };
    }),
    empty: "No saved payment methods.",
  });

  // Recent invoices.
  out.push({
    type: "table",
    key: "invoices",
    title: "Recent invoices",
    columns: [
      { key: "number", label: "Invoice" },
      { key: "status", label: "Status" },
      { key: "total", label: "Total", align: "right" },
      { key: "created", label: "Created" },
    ],
    rows: invoices.invoices.map((invoice) => ({
      id: invoice.id ?? "draft",
      cells: [
        { t: "id", v: invoice.number ?? invoice.id ?? "draft", copy: !!invoice.id },
        invoiceStatusBadge(invoice.status),
        money(ctx, invoice.total, invoice.currency),
        dateCell(invoice.created),
      ] as Cell[],
    })),
    empty: "No invoices.",
  });

  // Recent charges (from the lifetime-spend fetch — no extra API call).
  out.push({
    type: "table",
    key: "charges",
    title: "Recent payments",
    columns: [
      { key: "created", label: "Date" },
      { key: "amount", label: "Amount", align: "right" },
      { key: "status", label: "Status" },
      { key: "id", label: "Charge" },
    ],
    rows: chargesPage.charges.slice(0, 10).map((charge) => ({
      id: charge.id,
      cells: [
        dateCell(charge.created),
        money(ctx, charge.amount, charge.currency),
        chargeStatusBadge(charge),
        { t: "id", v: charge.id, copy: true },
      ] as Cell[],
    })),
    empty: "No payments.",
  });

  // Dispute mirror rows.
  if (disputes.length > 0) {
    out.push({
      type: "table",
      key: "disputes",
      title: `Disputes (${disputes.length})`,
      columns: [
        { key: "opened", label: "Opened" },
        { key: "amount", label: "Amount", align: "right" },
        { key: "status", label: "Status" },
        { key: "reason", label: "Reason" },
        { key: "due", label: "Evidence due" },
      ],
      rows: disputes.map((d) => ({
        id: d.id,
        cells: [
          d.disputeCreatedAt ? isoDateCell(d.disputeCreatedAt) : text("—"),
          money(ctx, d.amount, d.currency),
          {
            t: "badge",
            b: {
              kind: d.status.includes("needs_response") ? "error" : d.status === "won" ? "ok" : "info",
              text: d.status,
            },
          },
          text(d.reason),
          d.evidenceDueBy ? isoDateCell(d.evidenceDueBy) : text("—"),
        ] as Cell[],
      })),
      notice: "Local mirror — manage disputes in /billing → Disputes until the web console ships.",
    });
  }

  // Discord / Postiz links.
  const linkRows: Array<{ label: string; cell: Cell }> = [];
  for (const discordId of discordIds.slice(0, 5)) {
    linkRows.push({ label: "Discord user", cell: { t: "id", v: discordId, copy: true } });
    const session = await ctx.stores.session.getSession(discordId).catch(() => null);
    if (session?.postizUserId) {
      linkRows.push({ label: "Postiz user", cell: { t: "id", v: session.postizUserId, copy: true } });
    }
  }
  out.push({
    type: "kv",
    title: "Linked accounts",
    rows: linkRows.length ? linkRows : [{ label: "Discord user", cell: text("not linked") }],
  });

  // Team notes (read-only in M0).
  if (notes.rows.length > 0) {
    out.push({
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

  return {
    title: customer.name || customer.email || customer.id,
    crumbs: [
      { label: "Customers", ref: { page: "customers" } },
      { label: customer.email ?? customer.id, copyId: customer.id },
    ],
    blocks: out,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Customer not found",
    crumbs: [{ label: "Customers", ref: { page: "customers" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Customer not found", hint }],
  };
}

// ---- cell helpers ----

function text(v: string): Cell {
  return { t: "text", v };
}

function badge(kind: Badge["kind"], t: string): Cell {
  return { t: "badge", b: { kind, text: t } };
}

function money(ctx: DashboardCtx, amount: number, currency: string): Cell {
  return { t: "money", v: ctx.stripe.formatAmount(amount, currency) };
}

function dateCell(unixSeconds: number): Cell {
  const iso = new Date(unixSeconds * 1000).toISOString();
  return { t: "date", v: iso.slice(0, 10), iso };
}

function isoDateCell(d: Date): Cell {
  const iso = d.toISOString();
  return { t: "date", v: iso.slice(0, 10), iso };
}

function statusBadge(status: Stripe.Subscription.Status): Cell {
  const kind: Badge["kind"] =
    status === "active" || status === "trialing"
      ? "ok"
      : status === "past_due" || status === "unpaid" || status === "incomplete"
        ? "warn"
        : status === "canceled" || status === "incomplete_expired"
          ? "neutral"
          : "info";
  return { t: "badge", b: { kind, text: status } };
}

function invoiceStatusBadge(status: Stripe.Invoice.Status | null): Cell {
  const s = status ?? "—";
  const kind: Badge["kind"] =
    s === "paid" ? "ok" : s === "open" ? "warn" : s === "void" || s === "uncollectible" ? "error" : "neutral";
  return { t: "badge", b: { kind, text: s } };
}

function chargeStatusBadge(charge: Stripe.Charge): Cell {
  if (charge.refunded) return { t: "badge", b: { kind: "neutral", text: "refunded" } };
  if ((charge.amount_refunded ?? 0) > 0) return { t: "badge", b: { kind: "warn", text: "partial refund" } };
  if (charge.disputed) return { t: "badge", b: { kind: "error", text: "disputed" } };
  const kind: Badge["kind"] = charge.status === "succeeded" ? "ok" : charge.status === "pending" ? "warn" : "error";
  return { t: "badge", b: { kind, text: charge.status } };
}
