import type Stripe from "stripe";
import { Badge, Block, Cell, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";
import {
  amount,
  avatarCell,
  badgeCell,
  chargeBadge,
  dateCell,
  estimateMrr,
  formatPerCurrency,
  idCell,
  invoiceBadge,
  isoDateCell,
  paymentMethodCell,
  strong,
  subBadge,
  text,
} from "./cells";

// Customers: account-wide browse/search + the read-only Customer 360. M0 scope
// is deliberately read-only — write actions (edit/create/link/block) arrive
// with the action-gateway milestone. Layout follows the Stripe DETAIL
// archetype: flat tables in the main column, Insights/Details/Linked accounts
// stacked label-over-value in the right rail.

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

  const n = customers.length;
  const table: TableBlock = {
    type: "table",
    key: "customers",
    columns: [
      { key: "name", label: "Customer" },
      { key: "email", label: "Email" },
      { key: "flags", label: "Flags" },
      { key: "created", label: "Created" },
      { key: "id", label: "ID" },
    ],
    filters: [
      { key: "q", label: "Search", kind: "search", value: q || undefined, placeholder: "Search by name or email" },
    ],
    rows: customers.map((c) => ({
      id: c.id,
      ref: { page: "customers.detail", params: { id: c.id } },
      cells: [
        strong(c.name ?? "—"),
        text(c.email ?? "—"),
        { t: "flags", badges: c.delinquent ? [{ kind: "warn", text: "Delinquent" }] : [] },
        dateCell(c.created),
        idCell(c.id, { copy: true }),
      ] as Cell[],
    })),
    nextCursor: !q && hasMore && customers.length > 0 ? customers[customers.length - 1].id : null,
    empty: q ? "No customers match that search." : "No customers yet.",
    ...(n > 0 ? { footer: q ? `${n} result${n === 1 ? "" : "s"}` : `${n}${hasMore ? "+" : ""} item${n === 1 ? "" : "s"}` } : {}),
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

  const main: Block[] = [];
  const rail: Block[] = [];

  // Header: big name, email subline, status pills (Stripe detail archetype).
  const headBadges: Badge[] = [];
  if (customer.delinquent) headBadges.push({ kind: "warn", text: "Delinquent" });
  if (blocks.length > 0) headBadges.push({ kind: "error", text: "Blocked" });
  const title = customer.name || customer.email || customer.id;
  main.push({
    type: "header",
    title,
    ...(customer.email && customer.email !== title ? { sub: customer.email, subCopy: true } : {}),
    badges: headBadges,
  });

  // Blocklist banner (error notice with the first block's context).
  if (blocks.length > 0) {
    const b = blocks[0];
    main.push({
      type: "notice",
      badge: { kind: "error", text: "BLOCKED" },
      text:
        `${b.kind} "${b.value}" — ${b.reason}` +
        (b.actorName ? ` · added by ${b.actorName}` : "") +
        ` · ${b.createdAt.toISOString().slice(0, 10)}` +
        (blocks.length > 1 ? ` (+${blocks.length - 1} more entries)` : ""),
    });
  }

  // ---- rail: Insights (big values) ----
  const succeeded = chargesPage.charges.filter((c) => c.status === "succeeded");
  const spendByCurrency = new Map<string, number>();
  const refundsByCurrency = new Map<string, number>();
  for (const c of succeeded) {
    spendByCurrency.set(c.currency, (spendByCurrency.get(c.currency) ?? 0) + (c.amount - (c.amount_refunded ?? 0)));
  }
  for (const c of chargesPage.charges) {
    if ((c.amount_refunded ?? 0) > 0) {
      refundsByCurrency.set(c.currency, (refundsByCurrency.get(c.currency) ?? 0) + (c.amount_refunded ?? 0));
    }
  }
  const balance =
    customer.balance !== 0 && customer.currency != null
      ? ctx.stripe.formatAmount(customer.balance, customer.currency)
      : customer.balance !== 0
        ? String(customer.balance)
        : null;
  rail.push({
    type: "kv",
    title: "Insights",
    big: true,
    rows: [
      {
        label: "Spent",
        cell: text(
          formatPerCurrency(ctx.stripe, spendByCurrency),
          chargesPage.hasMore ? "from the 100 most recent payments" : undefined
        ),
      },
      { label: "MRR", cell: text(formatPerCurrency(ctx.stripe, estimateMrr(subs))) },
      { label: "Refunds", cell: text(formatPerCurrency(ctx.stripe, refundsByCurrency)) },
      ...(balance
        ? [{ label: "Balance", cell: text(balance, customer.balance < 0 ? "negative = customer credit" : undefined) }]
        : []),
    ],
  });

  // ---- rail: Details ----
  const defaultPm =
    typeof customer.invoice_settings?.default_payment_method === "string"
      ? customer.invoice_settings.default_payment_method
      : (customer.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null)?.id ?? null;
  const defaultPmObj = defaultPm ? methods.find((m) => m.id === defaultPm) ?? null : null;
  rail.push({
    type: "kv",
    title: "Details",
    rows: [
      { label: "Customer ID", cell: idCell(customer.id, { copy: true }) },
      { label: "Customer since", cell: dateCell(customer.created) },
      { label: "Billing email", cell: text(customer.email ?? "—") },
      { label: "Currency", cell: text(customer.currency?.toUpperCase() ?? "—") },
      ...(customer.delinquent ? [{ label: "Delinquent", cell: badgeCell("warn", "Yes") }] : []),
      ...(customer.tax_exempt && customer.tax_exempt !== "none"
        ? [{ label: "Tax exempt", cell: text(customer.tax_exempt) }]
        : []),
      ...(customer.preferred_locales?.length
        ? [{ label: "Locale", cell: text(customer.preferred_locales.join(", ")) }]
        : []),
      {
        label: "Default payment method",
        cell: defaultPmObj ? paymentMethodCell(defaultPmObj) : defaultPm ? idCell(defaultPm, { copy: true }) : text("—"),
      },
      ...(customer.description ? [{ label: "Description", cell: text(customer.description) }] : []),
    ],
  });

  // ---- rail: Linked accounts (Discord / Postiz) ----
  const linkRows: Array<{ label: string; cell: Cell }> = [];
  for (const discordId of discordIds.slice(0, 5)) {
    linkRows.push({ label: "Discord user", cell: idCell(discordId, { copy: true }) });
    const session = await ctx.stores.session.getSession(discordId).catch(() => null);
    if (session?.postizUserId) {
      linkRows.push({ label: "Postiz user", cell: idCell(session.postizUserId, { copy: true }) });
    }
  }
  rail.push({
    type: "kv",
    title: "Linked accounts",
    rows: linkRows.length ? linkRows : [{ label: "Discord user", cell: text("not linked") }],
  });

  // ---- main: Subscriptions ----
  main.push({
    type: "table",
    key: "subs",
    title: "Subscriptions",
    columns: [
      { key: "plan", label: "Product" },
      { key: "status", label: "Status" },
      { key: "period", label: "Next invoice" },
      { key: "id", label: "ID" },
    ],
    rows: subs.slice(0, 25).map((sub) => {
      const item = sub.items.data[0];
      const price = item?.price;
      const plan = price?.nickname ?? (typeof price?.product === "string" ? price.product : price?.id) ?? "plan";
      const per =
        price?.unit_amount != null
          ? `${ctx.stripe.formatAmount(price.unit_amount * (item?.quantity ?? 1), price.currency)}/${price.recurring?.interval ?? "?"}`
          : undefined;
      const statusBadges: Badge[] = [subBadge(sub.status)];
      if (sub.pause_collection) statusBadges.push({ kind: "warn", text: "Paused" });
      if (sub.cancel_at_period_end) statusBadges.push({ kind: "warn", text: "Cancels at period end" });
      return {
        id: sub.id,
        ref: { page: "subscriptions.detail", params: { id: sub.id } },
        cells: [
          avatarCell("subscription", plan, { sub: per }),
          { t: "flags", badges: statusBadges },
          item?.current_period_end ? dateCell(item.current_period_end) : text("—"),
          idCell(sub.id, { copy: true }),
        ] as Cell[],
      };
    }),
    empty: "No subscriptions.",
    ...(subs.length > 0
      ? {
          footer: `${Math.min(subs.length, 25)} result${subs.length === 1 ? "" : "s"} — view all`,
          footerRef: { page: "subscriptions", filters: { customer: id } },
        }
      : {}),
    ...(subs.length > 25 ? { notice: `Showing 25 of ${subs.length} subscriptions.` } : {}),
  });

  // ---- main: Payments (from the lifetime-spend fetch — no extra API call) ----
  const recentCharges = chargesPage.charges.slice(0, 10);
  main.push({
    type: "table",
    key: "charges",
    title: "Payments",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "desc", label: "Description" },
      { key: "created", label: "Date" },
      { key: "id", label: "ID" },
    ],
    rows: recentCharges.map((charge) => ({
      id: charge.id,
      ref: { page: "payments.detail", params: { id: charge.id } },
      cells: [
        amount(ctx.stripe, charge.amount, charge.currency, chargeBadge(charge)),
        text(charge.description ?? pmIntentId(charge) ?? "—"),
        dateCell(charge.created),
        idCell(charge.id, { copy: true }),
      ] as Cell[],
    })),
    empty: "No payments.",
    ...(recentCharges.length > 0
      ? {
          footer: `${recentCharges.length}${chargesPage.charges.length > 10 || chargesPage.hasMore ? "+" : ""} result${recentCharges.length === 1 ? "" : "s"} — view all`,
          footerRef: { page: "payments", filters: { customer: id } },
        }
      : {}),
  });

  // ---- main: Payment methods ----
  main.push({
    type: "table",
    key: "pms",
    title: "Payment methods",
    columns: [
      { key: "method", label: "Method" },
      { key: "default", label: "Default" },
      { key: "expires", label: "Expires" },
      { key: "id", label: "ID" },
    ],
    rows: methods.slice(0, 25).map((pm) => ({
      id: pm.id,
      cells: [
        paymentMethodCell(pm),
        pm.id === defaultPm ? badgeCell("info", "Default") : text("—"),
        pm.type === "card" && pm.card ? text(`${pm.card.exp_month}/${pm.card.exp_year}`) : text("—"),
        idCell(pm.id, { copy: true }),
      ] as Cell[],
    })),
    empty: "No saved payment methods.",
    ...(methods.length > 0 ? { footer: `${Math.min(methods.length, 25)} result${methods.length === 1 ? "" : "s"}` } : {}),
  });

  // ---- main: Invoices ----
  main.push({
    type: "table",
    key: "invoices",
    title: "Invoices",
    columns: [
      { key: "total", label: "Amount" },
      { key: "number", label: "Invoice" },
      { key: "created", label: "Created" },
    ],
    rows: invoices.invoices.map((invoice) => ({
      id: invoice.id ?? "draft",
      ...(invoice.id ? { ref: { page: "invoices.detail", params: { id: invoice.id } } } : {}),
      cells: [
        amount(ctx.stripe, invoice.total, invoice.currency, invoiceBadge(invoice.status)),
        idCell(invoice.number ?? invoice.id ?? "draft", { copy: !!invoice.id }),
        dateCell(invoice.created),
      ] as Cell[],
    })),
    empty: "No invoices.",
    ...(invoices.invoices.length > 0
      ? {
          footer: `${invoices.invoices.length}${invoices.hasMore ? "+" : ""} result${invoices.invoices.length === 1 ? "" : "s"} — view all`,
          footerRef: { page: "invoices", filters: { customer: id } },
        }
      : {}),
  });

  // ---- main: dispute mirror rows ----
  if (disputes.length > 0) {
    main.push({
      type: "table",
      key: "disputes",
      title: "Disputes",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "reason", label: "Reason" },
        { key: "opened", label: "Opened" },
        { key: "due", label: "Evidence due" },
      ],
      rows: disputes.map((d) => ({
        id: d.id,
        cells: [
          amount(ctx.stripe, d.amount, d.currency, {
            kind: d.status.includes("needs_response") ? "error" : d.status === "won" ? "ok" : "info",
            text: d.status.replace(/_/g, " "),
          }),
          text(d.reason),
          d.disputeCreatedAt ? isoDateCell(d.disputeCreatedAt) : text("—"),
          d.evidenceDueBy ? isoDateCell(d.evidenceDueBy) : text("—"),
        ] as Cell[],
      })),
      footer: `${disputes.length} result${disputes.length === 1 ? "" : "s"}`,
      notice: "Local mirror — manage disputes in /billing → Disputes until the web console ships.",
    });
  }

  // ---- main: team notes (read-only in M0) ----
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

  return {
    title,
    crumbs: [
      { label: "Customers", ref: { page: "customers" } },
      { label: customer.email ?? customer.id, copyId: customer.id },
    ],
    blocks: main,
    rail,
  };
}

function pmIntentId(charge: Stripe.Charge): string | null {
  return typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
}

function notFound(hint: string): SectionPage {
  return {
    title: "Customer not found",
    crumbs: [{ label: "Customers", ref: { page: "customers" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Customer not found", hint }],
  };
}
