import type Stripe from "stripe";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";
import { amount, badgeCell, cardCell, dateCell, idCell, invoiceBadge, money, sentence, text } from "./cells";

// Invoices: account-wide LIST archetype (status count-cards) and the DETAIL
// archetype (copy-field hosted URL + Summary + line items + credit notes +
// enabled-payment-method chips + Metadata + rail). Lifecycle ops render as
// registry buttons per status; the one-off draft builder collects a single
// line item (multi-line drafts stay in /billing).

const WINDOW = 100;

export function makeInvoicesSection(): DashboardSectionModule {
  return {
    nav: [{ key: "invoices", label: "Invoices", page: "invoices" }],

    ownsPage(page: string): boolean {
      return page === "invoices" || page === "invoices.detail";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "invoices") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      const id = validId("invoice", req.params?.id);
      if (!id) return notFound("That invoice id is not valid (in_…).");
      return detail(ctx, id);
    },
  };
}

function actionActor(ctx: DashboardCtx): ActionActor {
  return { kind: "dashboard", id: ctx.actor.id, name: ctx.actor.name, isAdmin: ctx.actor.isAdmin };
}

function registryButton(ctx: DashboardCtx, button: ActionButton): ActionButton {
  const mode = ctx.billing.actions.effectiveMode(button.key, actionActor(ctx));
  if (mode === "denied") return { ...button, disabledReason: "Disabled by /config → Billing → Intercom Actions." };
  return { ...button, mode: mode === "queue" ? "queue" : "direct" };
}

// ---- LIST ----

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const status = str(filters.status, 16);
  const customerScope = validId("customer", filters.customer) ?? "";
  const cursorId = validId("invoice", validCursor(cursor) ?? "") ?? undefined;
  const res = await ctx.stripe.listInvoicesByStatus(customerScope || null, undefined, WINDOW, cursorId);
  const invoices = res.data;

  const counts = {
    key: "status",
    items: [
      { value: "", label: "All", count: invoices.length },
      { value: "draft", label: "Draft", count: invoices.filter((i) => i.status === "draft").length },
      { value: "open", label: "Open", count: invoices.filter((i) => i.status === "open").length },
      { value: "paid", label: "Paid", count: invoices.filter((i) => i.status === "paid").length },
      { value: "void", label: "Void", count: invoices.filter((i) => i.status === "void").length },
      { value: "uncollectible", label: "Uncollectible", count: invoices.filter((i) => i.status === "uncollectible").length },
    ],
  };

  const filtered = status ? invoices.filter((i) => i.status === status) : invoices;
  const rows = filtered.map((invoice) => {
    const customer = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
    return {
      id: invoice.id ?? "draft",
      ...(invoice.id ? { ref: { page: "invoices.detail", params: { id: invoice.id } } } : {}),
      cells: [
        amount(ctx.stripe, invoice.total, invoice.currency, invoiceBadge(invoice.status)),
        invoice.number
          ? idCell(invoice.number, { copy: true })
          : text("Draft"),
        customer
          ? ({ t: "link", v: invoice.customer_email ?? customer, ref: { page: "customers.detail", params: { id: customer } } } as Cell)
          : text(invoice.customer_email ?? "—"),
        invoice.due_date ? dateCell(invoice.due_date) : text("—"),
        dateCell(invoice.created),
      ] as Cell[],
    };
  });

  return {
    title: "Invoices",
    crumbs: [{ label: "Invoices" }],
    blocks: [
      {
        type: "header",
        title: "Invoices",
        actions: [
          registryButton(ctx, {
            key: "invoice.create_draft",
            label: "New draft invoice",
            style: "primary",
            inputs: [
              { type: "text", key: "customerId", label: "Customer id (cus_…)", placeholder: "cus_…" },
              { type: "text", key: "description", label: "Line description", maxLength: 300 },
              { type: "number", key: "amountMajor", label: "Amount (e.g. 29.00)", min: 0 },
              { type: "text", key: "currency", label: "Currency (3 letters)", placeholder: "usd" },
              { type: "number", key: "daysUntilDue", label: "Days until due (optional)", min: 1 },
              { type: "toggle", key: "finalize", label: "Finalize immediately (email invoice)" },
            ],
            summary: "One-line draft invoice (collection: email). Multi-line drafts live in /billing → Invoices.",
          }),
        ],
      },
      {
        type: "table",
        key: "invoices",
        columns: [
          { key: "total", label: "Amount" },
          { key: "number", label: "Invoice" },
          { key: "customer", label: "Customer" },
          { key: "due", label: "Due" },
          { key: "created", label: "Created" },
        ],
        counts,
        filters: [
          { key: "customer", label: "Customer", kind: "text", value: customerScope || undefined, placeholder: "cus_…" },
        ],
        rows,
        nextCursor:
          res.has_more && invoices.length > 0 ? invoices[invoices.length - 1].id ?? null : null,
        empty: status || customerScope ? "No invoices match this filter (within this window)." : "No invoices yet.",
        ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
        notice: `Counts cover the ${WINDOW} most recent invoices per page — use Next for older ones.`,
      },
    ],
  };
}

// ---- DETAIL ----

function fmtAddress(a?: Stripe.Address | null): string | null {
  if (!a) return null;
  const parts = [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(" ").trim(), a.state, a.country]
    .map((p) => (p ? String(p).trim() : ""))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

async function detail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const invoice = await ctx.stripe.getInvoice(id).catch(() => null);
  if (!invoice) return notFound("This invoice does not exist.");
  const creditNotes = await ctx.stripe.listCreditNotes(id).catch(() => [] as Stripe.CreditNote[]);
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;

  // Lifecycle actions by status (belts: send/finalize = T1, pay = T2, void/
  // uncollectible/delete = T1 dangerous, credit note = T1 dangerous).
  const actions: ActionButton[] = [];
  if (invoice.status === "draft") {
    actions.push(
      registryButton(ctx, {
        key: "invoice.finalize",
        label: "Finalize",
        style: "primary",
        dangerous: true,
        params: { invoiceId: id },
        summary: "Locks the draft and makes it open/collectible.",
      }),
      registryButton(ctx, {
        key: "invoice.void",
        label: "Delete draft",
        style: "danger",
        dangerous: true,
        params: { invoiceId: id, op: "delete_draft" },
        summary: "Deletes the draft permanently.",
      })
    );
  }
  if (invoice.status === "open") {
    actions.push(
      registryButton(ctx, {
        key: "invoice.collect",
        label: "Send invoice",
        style: "primary",
        dangerous: true,
        params: { invoiceId: id, op: "send" },
        summary: "Emails the hosted invoice to the customer.",
      }),
      registryButton(ctx, {
        key: "invoice.collect",
        label: "Collect payment now",
        dangerous: true,
        stepUp: true,
        params: { invoiceId: id, op: "pay" },
        summary: "Attempts an OFF-SESSION charge on the default payment method. Requires a fresh factor.",
      }),
      registryButton(ctx, {
        key: "invoice.void",
        label: "Void",
        style: "danger",
        dangerous: true,
        params: { invoiceId: id, op: "void" },
        summary: "Voids the invoice — it can no longer be paid.",
      }),
      registryButton(ctx, {
        key: "invoice.void",
        label: "Mark uncollectible",
        style: "danger",
        dangerous: true,
        params: { invoiceId: id, op: "uncollectible" },
        summary: "Writes the invoice off as bad debt.",
      })
    );
  }
  if (invoice.status === "paid" || invoice.status === "open") {
    actions.push(
      registryButton(ctx, {
        key: "invoice.credit_note",
        label: "Credit note",
        dangerous: true,
        params: { invoiceId: id },
        inputs: [
          { type: "number", key: "amountMajor", label: `Amount (${invoice.currency.toUpperCase()}, e.g. 5.00)`, min: 0 },
          {
            type: "select",
            key: "mode",
            label: "Mode",
            options: [
              { value: "credit", label: "Customer credit" },
              { value: "refund", label: "Refund" },
              { value: "out_of_band", label: "Out of band" },
            ],
          },
          { type: "text", key: "memo", label: "Memo (optional)", maxLength: 400 },
        ],
        summary: "Issues a credit note against this invoice (previewed server-side before it executes).",
      })
    );
  }

  const main: Block[] = [];
  const rail: Block[] = [];

  main.push({
    type: "header",
    title: ctx.stripe.formatAmount(invoice.total, invoice.currency),
    titleSuffix: invoice.currency.toUpperCase(),
    ...(invoice.number ? { sub: invoice.number, subCopy: true } : {}),
    badges: [invoiceBadge(invoice.status)],
    actions,
  });

  // Hosted URL + PDF (the Stripe copy-field pattern).
  if (invoice.hosted_invoice_url || invoice.invoice_pdf) {
    main.push({
      type: "kv",
      title: "Links",
      rows: [
        ...(invoice.hosted_invoice_url
          ? [
              {
                label: "Hosted invoice",
                cell: { t: "external", v: "Open payment page", href: invoice.hosted_invoice_url, copy: true } as Cell,
              },
            ]
          : []),
        ...(invoice.invoice_pdf
          ? [{ label: "PDF", cell: { t: "external", v: "Download PDF", href: invoice.invoice_pdf } as Cell }]
          : []),
      ],
    });
  }

  // Billing details (Stripe's "Summary" left column: who/where/how it's billed).
  const billTo = invoice.customer_name || invoice.customer_email || customerId;
  const billAddr = fmtAddress(invoice.customer_address);
  const shipAddr = fmtAddress(invoice.customer_shipping?.address ?? null);
  main.push({
    type: "kv",
    title: "Billing details",
    rows: [
      ...(billTo ? [{ label: "Billed to", cell: text(billTo) }] : []),
      ...(invoice.customer_email ? [{ label: "Email", cell: text(invoice.customer_email) }] : []),
      ...(billAddr ? [{ label: "Billing address", cell: text(billAddr) }] : []),
      ...(shipAddr ? [{ label: "Shipping address", cell: text(shipAddr) }] : []),
      { label: "Currency", cell: text(invoice.currency.toUpperCase()) },
      {
        label: "Billing method",
        cell: text(invoice.collection_method === "send_invoice" ? "Send invoice" : "Charge automatically"),
      },
      ...(invoice.description ? [{ label: "Memo", cell: text(invoice.description) }] : []),
      ...(invoice.footer ? [{ label: "Footer", cell: text(invoice.footer) }] : []),
    ],
  });

  // Recent activity — the invoice lifecycle from its status transitions.
  const st = invoice.status_transitions;
  const isoOf = (sec: number) => new Date(sec * 1000).toISOString();
  const activity: Array<{ label: string; iso: string; kind: Badge["kind"] }> = [
    { label: "Invoice created", iso: isoOf(invoice.created), kind: "info" },
  ];
  if (st?.finalized_at) activity.push({ label: "Finalized", iso: isoOf(st.finalized_at), kind: "info" });
  if (st?.paid_at) activity.push({ label: "Paid", iso: isoOf(st.paid_at), kind: "ok" });
  if (st?.voided_at) activity.push({ label: "Voided", iso: isoOf(st.voided_at), kind: "neutral" });
  if (st?.marked_uncollectible_at)
    activity.push({ label: "Marked uncollectible", iso: isoOf(st.marked_uncollectible_at), kind: "error" });
  activity.sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));
  main.push({ type: "timeline", title: "Recent activity", items: activity });

  // Summary (label left, amount right — the breakdown variant). Basil quirk:
  // tax lives in total_taxes, not the old tax_amounts.
  const taxTotal = (invoice.total_taxes ?? []).reduce((sum, t) => sum + t.amount, 0);
  main.push({
    type: "kv",
    title: "Summary",
    amounts: true,
    rows: [
      { label: "Subtotal", cell: money(ctx.stripe, invoice.subtotal, invoice.currency) },
      ...(taxTotal > 0 ? [{ label: "Tax", cell: money(ctx.stripe, taxTotal, invoice.currency) }] : []),
      ...(invoice.total !== invoice.subtotal && taxTotal === 0
        ? [{ label: "Discounts / adjustments", cell: money(ctx.stripe, invoice.total - invoice.subtotal, invoice.currency) }]
        : []),
      { label: "Total", cell: money(ctx.stripe, invoice.total, invoice.currency) },
      { label: "Amount paid", cell: money(ctx.stripe, invoice.amount_paid, invoice.currency, invoice.amount_paid ? "pos" : undefined) },
      { label: "Amount due", cell: money(ctx.stripe, invoice.amount_due, invoice.currency, invoice.amount_due ? "neg" : undefined) },
    ],
  });

  // Line items.
  const lines = invoice.lines?.data ?? [];
  main.push({
    type: "table",
    key: "lines",
    title: "Line items",
    columns: [
      { key: "desc", label: "Description" },
      { key: "qty", label: "Qty", align: "right" },
      { key: "amount", label: "Amount", align: "right" },
    ],
    rows: lines.slice(0, 20).map((line, i) => ({
      id: line.id ?? String(i),
      cells: [
        text(line.description ?? "line"),
        text(String(line.quantity ?? 1)),
        money(ctx.stripe, line.amount, line.currency),
      ] as Cell[],
    })),
    empty: "No line items.",
    ...(lines.length ? { footer: `${Math.min(lines.length, 20)} result${lines.length === 1 ? "" : "s"}` } : {}),
    ...(invoice.lines?.has_more ? { notice: "More lines exist than shown — open the hosted invoice for the full list." } : {}),
  });

  // Credit notes.
  if (creditNotes.length > 0) {
    main.push({
      type: "table",
      key: "creditnotes",
      title: "Credit notes",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "reason", label: "Memo" },
        { key: "created", label: "Created" },
        { key: "id", label: "ID" },
      ],
      rows: creditNotes.map((note) => ({
        id: note.id,
        cells: [
          amount(ctx.stripe, note.total, note.currency, {
            kind: note.status === "void" ? "neutral" : "info",
            text: sentence(note.status ?? "issued"),
          }),
          text(note.memo ?? "—"),
          dateCell(note.created),
          idCell(note.id, { copy: true }),
        ] as Cell[],
      })),
      footer: `${creditNotes.length} result${creditNotes.length === 1 ? "" : "s"}`,
    });
  }

  // Enabled payment methods (branded chips, one per row label-free after the first).
  const pmTypes = invoice.payment_settings?.payment_method_types ?? null;
  if (pmTypes?.length) {
    main.push({
      type: "kv",
      title: "Enabled payment methods",
      rows: pmTypes.slice(0, 8).map((t, i) => ({ label: i === 0 ? "Methods" : "", cell: cardCell(t, "") })),
    });
  }

  // Metadata.
  const metadata = Object.entries(invoice.metadata ?? {});
  main.push({
    type: "kv",
    title: "Metadata",
    rows: metadata.length
      ? metadata.slice(0, 15).map(([k, v]) => ({ label: k, cell: text(String(v).slice(0, 200)) }))
      : [{ label: "Metadata", cell: text("No metadata") }],
  });

  // Rail: Details + Customer.
  rail.push({
    type: "kv",
    title: "Details",
    rows: [
      { label: "Invoice ID", cell: idCell(invoice.id ?? id, { copy: true }) },
      ...(invoice.number ? [{ label: "Number", cell: idCell(invoice.number, { copy: true }) }] : []),
      { label: "Status", cell: badgeCell(invoiceBadge(invoice.status).kind, sentence(invoice.status ?? "draft")) },
      { label: "Created", cell: dateCell(invoice.created) },
      ...(invoice.due_date ? [{ label: "Due", cell: dateCell(invoice.due_date) }] : []),
      {
        label: "Collection",
        cell: text(invoice.collection_method === "send_invoice" ? "Email invoice" : "Charge automatically"),
      },
      // Basil quirk: the subscription ref moved under parent.subscription_details.
      ...(() => {
        const subRef = invoice.parent?.subscription_details?.subscription;
        const subId = typeof subRef === "string" ? subRef : subRef?.id ?? null;
        return subId
          ? [
              {
                label: "Subscription",
                cell: idCell(subId, { copy: true, ref: { page: "subscriptions.detail", params: { id: subId } } }),
              },
            ]
          : [];
      })(),
      ...(invoice.attempt_count ? [{ label: "Payment attempts", cell: text(String(invoice.attempt_count)) }] : []),
    ],
  });
  rail.push({
    type: "kv",
    title: "Customer",
    rows: customerId
      ? [
          { label: "ID", cell: idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } }) },
          ...(invoice.customer_email ? [{ label: "Email", cell: text(invoice.customer_email) }] : []),
          ...(invoice.customer_name ? [{ label: "Name", cell: text(invoice.customer_name) }] : []),
        ]
      : [{ label: "Customer", cell: text("No customer attached.") }],
  });

  return {
    title: ctx.stripe.formatAmount(invoice.total, invoice.currency),
    crumbs: [
      { label: "Invoices", ref: { page: "invoices" } },
      { label: invoice.number ?? invoice.id ?? id, copyId: invoice.id ?? id },
    ],
    blocks: main,
    rail,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Invoices", ref: { page: "invoices" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Invoice not found", hint }],
  };
}
