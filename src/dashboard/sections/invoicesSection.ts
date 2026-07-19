import type Stripe from "stripe";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, ActionResult, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";
import { bookmarkButton, isBookmarkedSafe, toggleBookmarkAction } from "./bookmarks";
import { amount, badgeCell, cardCell, chipCount, dateCell, fmtAddress, idCell, invoiceBadge, money, sentence, strong, text } from "./cells";
import { StripeClient } from "../../bot/StripeClient";

// Invoices: account-wide LIST archetype (status count-cards) and the DETAIL
// archetype (copy-field hosted URL + Summary + line items + credit notes +
// enabled-payment-method chips + Metadata + rail). Lifecycle ops render as
// registry buttons per status. PA-8 added the multi-line COMPOSER page
// (`invoices.new`): filter-driven like subscriptions.new, lines accumulate in
// a compact `lines` token filter (price*qty + encoded custom lines) and the
// confirm bakes the registry `invoice.create_draft` items[] server-side.

const WINDOW = 100;

export function makeInvoicesSection(): DashboardSectionModule {
  return {
    nav: [{ key: "invoices", label: "Invoices", page: "invoices" }],

    ownsPage(page: string): boolean {
      return page === "invoices" || page === "invoices.detail" || page === "invoices.new";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "invoices") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      if (req.page === "invoices.new") return composer(ctx, req.filters ?? {});
      const id = validId("invoice", req.params?.id);
      if (!id) return notFound("That invoice id is not valid (in_…).");
      return detail(ctx, id);
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      return invoiceEditAction(ctx, req.key, req.params ?? {}, req.confirmWord);
    },
  };
}

// ---- draft editor actions (PA-9) ----
// Every key re-reads the invoice and refuses unless it is a ONE-OFF draft
// (subscription-cycle drafts have no invoiceitems and belong to the billing
// engine). Drafts bill nothing until the T1 `invoice.finalize` gate, so edits
// are T0 — except line_remove (T1), which destroys typed-in work.

const INVOICE_ITEM_RE = /^ii_[A-Za-z0-9]{1,64}$/;

async function invoiceEditAction(
  ctx: DashboardCtx,
  key: string,
  p: Record<string, unknown>,
  confirmWord: string | undefined
): Promise<ActionResult> {
  // T0 — shared team bookmark toggle (any invoice status, not just drafts).
  if (key === "section:invoices.bookmark") return toggleBookmarkAction(ctx, "invoice", p);

  const invoiceId = validId("invoice", p.invoiceId);
  if (!invoiceId) return { ok: false, error: "Bad invoice id." };
  const invoice = await ctx.stripe.getInvoice(invoiceId).catch(() => null);
  if (!invoice) return { ok: false, error: "This invoice does not exist." };
  if (invoice.status !== "draft") return { ok: false, error: `Invoice is ${invoice.status} — only drafts are editable.` };
  if (invoice.parent?.subscription_details) {
    return { ok: false, error: "This draft belongs to a subscription cycle — it is not editable here." };
  }
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
  if (!customerId) return { ok: false, error: "This invoice has no customer attached." };
  const idem = () => `dash-invline-${invoiceId}-${Date.now().toString(36)}`;

  switch (key) {
    // T0 — add a catalog-price line (flattened to amount, the composer idiom).
    case "section:invoices.line_add": {
      const priceId = typeof p.price === "string" && /^price_[A-Za-z0-9]{1,64}$/.test(p.price) ? p.price : null;
      if (!priceId) return { ok: false, fieldErrors: { price: "Pick a price." } };
      const price = await ctx.stripe.getPrice(priceId).catch(() => null);
      if (!price || price.unit_amount == null) return { ok: false, error: "That price does not exist (or has no unit amount)." };
      if (price.currency !== invoice.currency) {
        return { ok: false, error: `Price is ${price.currency.toUpperCase()} — this invoice bills ${invoice.currency.toUpperCase()}.` };
      }
      const qty =
        typeof p.quantity === "number" && Number.isSafeInteger(p.quantity) && p.quantity >= 1 && p.quantity <= 999
          ? p.quantity
          : 1;
      const desc = price.nickname ?? (typeof price.product === "string" ? price.product : price.id);
      await ctx.stripe.createInvoiceItem(
        {
          customerId,
          invoiceId,
          amountMinor: price.unit_amount * qty,
          currency: price.currency,
          description: qty > 1 ? `${desc} ×${qty}` : desc,
        },
        idem()
      );
      await ctx.audit(`Invoice ${invoiceId}: line added (${priceId} ×${qty})`);
      return { ok: true, text: "Line added." };
    }

    // T0 — ad-hoc custom line.
    case "section:invoices.line_add_custom": {
      const description = str(p.description, 300).trim();
      if (!description) return { ok: false, fieldErrors: { description: "Describe the line." } };
      const amountMajor = typeof p.amountMajor === "number" && isFinite(p.amountMajor) && p.amountMajor > 0 ? p.amountMajor : null;
      if (!amountMajor) return { ok: false, fieldErrors: { amountMajor: "Enter a positive amount." } };
      const amountMinor = Math.round(amountMajor * (StripeClient.isZeroDecimal(invoice.currency) ? 1 : 100));
      await ctx.stripe.createInvoiceItem(
        { customerId, invoiceId, amountMinor, currency: invoice.currency, description },
        idem()
      );
      await ctx.audit(`Invoice ${invoiceId}: custom line added (${ctx.stripe.formatAmount(amountMinor, invoice.currency)})`);
      return { ok: true, text: "Line added." };
    }

    // T0 — edit a line's amount/description (qty only on price-based items).
    case "section:invoices.line_edit": {
      const itemId = typeof p.itemId === "string" && INVOICE_ITEM_RE.test(p.itemId) ? p.itemId : null;
      if (!itemId) return { ok: false, error: "Bad line item id." };
      const item = await ctx.stripe.getInvoiceItem(itemId).catch(() => null);
      const itemInvoice = typeof item?.invoice === "string" ? item.invoice : item?.invoice?.id ?? null;
      if (!item || itemInvoice !== invoiceId) return { ok: false, error: "That line does not belong to this invoice." };
      const updates: { amountMinor?: number; quantity?: number; description?: string } = {};
      const description = str(p.description, 300).trim();
      if (description) updates.description = description;
      if (typeof p.amountMajor === "number" && isFinite(p.amountMajor) && p.amountMajor > 0) {
        updates.amountMinor = Math.round(p.amountMajor * (StripeClient.isZeroDecimal(invoice.currency) ? 1 : 100));
      }
      if (typeof p.quantity === "number" && Number.isSafeInteger(p.quantity) && p.quantity >= 1 && p.quantity <= 999) {
        // Quantity edits only make sense on price-based items; amount-based
        // items get their amount edited instead (Stripe errors otherwise).
        if (item.pricing?.price_details?.price) updates.quantity = p.quantity;
        else return { ok: false, fieldErrors: { quantity: "This line is amount-based — edit the amount instead." } };
      }
      if (updates.amountMinor != null && updates.quantity != null) {
        return { ok: false, error: "Edit either the amount or the quantity — not both." };
      }
      if (Object.keys(updates).length === 0) return { ok: false, error: "Nothing to change." };
      await ctx.stripe.updateInvoiceItem(itemId, updates, idem());
      await ctx.audit(`Invoice ${invoiceId}: line ${itemId} edited (${Object.keys(updates).join(", ")})`);
      return { ok: true, text: "Line updated." };
    }

    // T1 — remove a line (destroys typed-in work).
    case "section:invoices.line_remove": {
      if (confirmWord !== "CONFIRM") return { ok: false, error: "Type CONFIRM to run this action." };
      const itemId = typeof p.itemId === "string" && INVOICE_ITEM_RE.test(p.itemId) ? p.itemId : null;
      if (!itemId) return { ok: false, error: "Bad line item id." };
      const item = await ctx.stripe.getInvoiceItem(itemId).catch(() => null);
      const itemInvoice = typeof item?.invoice === "string" ? item.invoice : item?.invoice?.id ?? null;
      if (!item || itemInvoice !== invoiceId) return { ok: false, error: "That line does not belong to this invoice." };
      await ctx.stripe.deleteInvoiceItem(itemId);
      await ctx.audit(`Invoice ${invoiceId}: line ${itemId} removed`);
      return { ok: true, text: "Line removed." };
    }

    // T0 — due date / memo / footer ('-' clears, blank keeps).
    case "section:invoices.details_edit": {
      const params: { dueDateUnix?: number; memo?: string | null; footer?: string | null } = {};
      const due = str(p.dueDate, 10).trim();
      if (due) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, fieldErrors: { dueDate: "Use YYYY-MM-DD." } };
        const unix = Math.floor(Date.parse(`${due}T00:00:00Z`) / 1000);
        if (!Number.isFinite(unix) || unix <= Math.floor(Date.now() / 1000)) {
          return { ok: false, fieldErrors: { dueDate: "Due date must be in the future." } };
        }
        params.dueDateUnix = unix;
      }
      const memo = str(p.memo, 500).trim();
      if (memo) params.memo = memo === "-" ? null : memo;
      const footer = str(p.footer, 500).trim();
      if (footer) params.footer = footer === "-" ? null : footer;
      if (Object.keys(params).length === 0) return { ok: false, error: "Nothing to change — fill at least one field ('-' clears)." };
      await ctx.stripe.updateInvoiceDetails(invoiceId, params, idem());
      await ctx.audit(`Invoice ${invoiceId}: details updated (${Object.keys(params).join(", ")})`);
      return { ok: true, text: "Invoice details updated." };
    }

    // T0 — metadata (the customers.metadata parse, verbatim rules).
    case "section:invoices.metadata": {
      const raw = str(p.metadata, 2000).trim();
      if (!raw) return { ok: false, error: "Enter key=value lines, or '-' to clear all metadata." };
      if (raw === "-") {
        await ctx.stripe.updateInvoiceDetails(invoiceId, { metadata: "" }, idem());
        await ctx.audit(`Invoice ${invoiceId}: metadata cleared`);
        return { ok: true, text: "Metadata cleared." };
      }
      const metadata: Record<string, string> = {};
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) return { ok: false, fieldErrors: { metadata: `"${trimmed.slice(0, 40)}" is not key=value.` } };
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1).trim();
        if (!k || k.length > 40 || v.length > 500) return { ok: false, fieldErrors: { metadata: `"${k.slice(0, 40)}" — keys ≤40 chars, values ≤500.` } };
        metadata[k] = v;
      }
      if (Object.keys(metadata).length === 0) return { ok: false, error: "No key=value lines found." };
      await ctx.stripe.updateInvoiceDetails(invoiceId, { metadata }, idem());
      await ctx.audit(`Invoice ${invoiceId}: metadata updated (${Object.keys(metadata).length} key(s))`);
      return { ok: true, text: `Metadata updated (${Object.keys(metadata).length} key(s)).` };
    }

    default:
      return { ok: false, error: "Unknown action." };
  }
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

  // Real chip totals via invoices.search total_count (window counts cap at
  // WINDOW); fallback = honest windowed "N+" when search fails.
  const scope = customerScope ? `customer:"${customerScope}"` : "";
  const searchQ = (extra?: string) => [scope, extra].filter(Boolean).join(" AND ") || "created>0";
  const countSearch = (q: string) =>
    Promise.resolve()
      .then(() => ctx.stripe.countBySearch("invoices", q))
      .catch(() => null);
  const STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;
  const [res, chipTotals] = await Promise.all([
    ctx.stripe.listInvoicesByStatus(customerScope || null, undefined, WINDOW, cursorId),
    Promise.all([countSearch(searchQ()), ...STATUSES.map((s) => countSearch(searchQ(`status:"${s}"`)))]),
  ]);
  const [nAll, ...nByStatus] = chipTotals;
  const invoices = res.data;

  const over = res.has_more;
  const counts = {
    key: "status",
    items: [
      { value: "", label: "All", count: chipCount(nAll, invoices.length, over) },
      ...STATUSES.map((s, i) => ({
        value: s,
        label: sentence(s),
        count: chipCount(nByStatus[i], invoices.filter((inv) => inv.status === s).length, over),
      })),
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
          {
            key: "nav:invoices.new",
            label: "Create invoice",
            style: "primary",
            ref: { page: "invoices.new" },
          },
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
        notice: `Chip counts are account totals; the table shows ${WINDOW} per page — use Next for older ones.`,
      },
    ],
  };
}

// ---- DETAIL ----


async function detail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const invoice = await ctx.stripe.getInvoice(id).catch(() => null);
  if (!invoice) return notFound("This invoice does not exist.");
  // One-off drafts are editable (PA-9); subscription-cycle drafts belong to
  // the billing engine and stay read-only.
  const editableDraft = invoice.status === "draft" && !invoice.parent?.subscription_details;
  const [creditNotes, editableItems, editorPrices, bookmarked] = await Promise.all([
    ctx.stripe.listCreditNotes(id).catch(() => [] as Stripe.CreditNote[]),
    editableDraft ? ctx.stripe.listInvoiceItems(id).catch(() => [] as Stripe.InvoiceItem[]) : Promise.resolve([]),
    editableDraft ? ctx.stripe.listAllActivePrices(100).catch(() => [] as Stripe.Price[]) : Promise.resolve([]),
    isBookmarkedSafe(ctx, "invoice", id),
  ]);
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;

  // Lifecycle actions by status (belts: send/finalize = T1, pay = T2, void/
  // uncollectible/delete = T1 dangerous, credit note = T1 dangerous).
  const actions: ActionButton[] = [];
  if (editableDraft) {
    const priceOptions = editorPrices
      .filter((p) => p.unit_amount != null && p.currency === invoice.currency)
      .slice(0, 25)
      .map((p) => ({
        value: p.id,
        label: `${p.nickname ?? p.id.slice(0, 18)} — ${ctx.stripe.formatAmount(p.unit_amount!, p.currency)}${p.recurring ? `/${p.recurring.interval}` : ""}`,
      }));
    actions.push(
      {
        key: "section:invoices.line_add",
        label: "Add line",
        params: { invoiceId: id },
        inputs: [
          { type: "select", key: "price", label: `Price (${invoice.currency.toUpperCase()} only)`, options: priceOptions },
          { type: "number", key: "quantity", label: "Quantity (default 1)", min: 1, max: 999 },
        ],
        summary: "Adds a catalog price as a draft line.",
      },
      {
        key: "section:invoices.line_add_custom",
        label: "Add custom line",
        params: { invoiceId: id },
        inputs: [
          { type: "text", key: "description", label: "Description", maxLength: 300 },
          { type: "number", key: "amountMajor", label: `Amount (${invoice.currency.toUpperCase()}, e.g. 49.00)`, min: 0 },
        ],
      },
      {
        key: "section:invoices.details_edit",
        label: "Edit details",
        params: { invoiceId: id },
        inputs: [
          { type: "text", key: "dueDate", label: `Due date YYYY-MM-DD (now: ${invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().slice(0, 10) : "—"})` },
          { type: "text", key: "memo", label: `Memo (now: ${invoice.description?.slice(0, 40) ?? "—"}) — '-' clears`, multiline: true, maxLength: 500 },
          { type: "text", key: "footer", label: `Footer (now: ${invoice.footer?.slice(0, 40) ?? "—"}) — '-' clears`, maxLength: 500 },
        ],
        summary: "Blank fields stay unchanged; a single '-' clears the field.",
      },
      {
        key: "section:invoices.metadata",
        label: "Metadata",
        params: { invoiceId: id },
        inputs: [
          { type: "text", key: "metadata", label: "key=value per line — '-' alone clears ALL metadata", multiline: true, maxLength: 2000 },
        ],
        summary: "Replaces the listed keys (other keys survive); '-' wipes everything.",
      }
    );
  }
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

  actions.push(bookmarkButton("section:invoices.bookmark", bookmarked, invoice.id ?? id, invoice.number ?? id));
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

  // Line items. On an editable one-off draft the rows come from invoiceItems
  // (the editable objects) with Edit/Remove actions; otherwise the read-only
  // Basil lines view.
  if (editableDraft) {
    main.push({
      type: "table",
      key: "lines",
      title: "Line items (draft — editable)",
      columns: [
        { key: "desc", label: "Description" },
        { key: "qty", label: "Qty", align: "right" },
        { key: "amount", label: "Amount", align: "right" },
      ],
      rows: editableItems.map((item) => ({
        id: item.id,
        cells: [
          text(item.description ?? "line"),
          text(String(item.quantity ?? 1)),
          money(ctx.stripe, item.amount, item.currency),
        ] as Cell[],
        actions: [
          {
            key: "section:invoices.line_edit",
            label: "Edit",
            params: { invoiceId: id, itemId: item.id },
            inputs: [
              { type: "number", key: "amountMajor", label: `Amount (${invoice.currency.toUpperCase()}, now ${ctx.stripe.formatAmount(item.amount, item.currency)})`, min: 0 },
              { type: "text", key: "description", label: `Description (now: ${item.description?.slice(0, 40) ?? "—"})`, maxLength: 300 },
              ...(item.pricing?.price_details?.price
                ? [{ type: "number", key: "quantity", label: `Quantity (now ${item.quantity ?? 1})`, min: 1, max: 999 } as const]
                : []),
            ],
            summary: "Blank fields stay unchanged. Edit either the amount or the quantity — not both.",
          },
          {
            key: "section:invoices.line_remove",
            label: "Remove",
            dangerous: true,
            params: { invoiceId: id, itemId: item.id },
            summary: "Removes this line from the draft.",
          },
        ],
      })),
      empty: "No lines yet — add one with the header actions.",
      ...(editableItems.length ? { footer: `${editableItems.length} line${editableItems.length === 1 ? "" : "s"}` } : {}),
    });
  }
  const lines = editableDraft ? [] : invoice.lines?.data ?? [];
  if (!editableDraft)
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

// ---- COMPOSER (`invoices.new`, PA-8) ----
// Filter-driven multi-line draft builder. State lives entirely in the URL
// filters (the subscriptions.new idiom): `customer` scopes it, `lines` holds
// the accumulated items as tokens, `due`/`qty`/`custom` are knobs. Tokens:
//   price_x*3                          → 3 × that price
//   c:<encodeURIComponent(desc)>:<minor>:<cur> → ad-hoc custom line
// The confirm bakes the registry invoice.create_draft items[] SERVER-side —
// the client only ever toggles "finalize".

const MAX_LINES = 10; // registry invoice.create_draft cap

interface ComposedLine {
  token: string;
  desc: string;
  qty: number;
  unitMinor: number;
  currency: string;
}

function parseLineTokens(raw: string, prices: Stripe.Price[]): { lines: ComposedLine[]; dropped: number } {
  const lines: ComposedLine[] = [];
  let dropped = 0;
  for (const token of raw.split(",").filter(Boolean).slice(0, MAX_LINES)) {
    if (token.startsWith("c:")) {
      const parts = token.split(":");
      const desc = decodeURIComponent(parts[1] ?? "").slice(0, 300);
      const minor = Number.parseInt(parts[2] ?? "", 10);
      const cur = (parts[3] ?? "").toLowerCase();
      if (!desc || !Number.isSafeInteger(minor) || minor <= 0 || !/^[a-z]{3}$/.test(cur)) {
        dropped++;
        continue;
      }
      lines.push({ token, desc, qty: 1, unitMinor: minor, currency: cur });
      continue;
    }
    const m = /^(price_[A-Za-z0-9]{1,64})\*(\d{1,3})$/.exec(token);
    const price = m ? prices.find((p) => p.id === m[1]) : undefined;
    const qty = m ? Number.parseInt(m[2], 10) : 0;
    if (!price || price.unit_amount == null || qty < 1 || qty > 999) {
      dropped++;
      continue;
    }
    lines.push({
      token,
      desc: price.nickname ?? (typeof price.product === "string" ? price.product : price.id),
      qty,
      unitMinor: price.unit_amount,
      currency: price.currency,
    });
  }
  return { lines, dropped };
}

async function composer(ctx: DashboardCtx, filters: Record<string, string>): Promise<SectionPage> {
  const customerId = validId("customer", filters.customer) ?? "";
  const due = ["7", "14", "30"].includes(filters.due ?? "") ? filters.due : "30";
  const qtyRaw = str(filters.qty, 3).trim();
  const addQty = /^\d{1,3}$/.test(qtyRaw) && Number.parseInt(qtyRaw, 10) >= 1 ? Math.min(Number.parseInt(qtyRaw, 10), 999) : 1;
  const linesRaw = str(filters.lines, 2000);
  const customRaw = str(filters.custom, 400).trim();

  const [prices, customer] = await Promise.all([
    ctx.stripe.listAllActivePrices(100).catch(() => [] as Stripe.Price[]),
    customerId
      ? Promise.resolve()
          .then(() => ctx.stripe.getCustomer(customerId))
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const { lines, dropped } = parseLineTokens(linesRaw, prices);
  const lineCurrency = lines[0]?.currency ?? null;
  const mixed = lines.some((l) => l.currency !== lineCurrency);
  const totalMinor = lines.reduce((sum, l) => sum + l.unitMinor * l.qty, 0);

  // Every ref must carry the FULL filter state (refs replace, not merge).
  const baseFilters = (over: Record<string, string | null>): Record<string, string> => {
    const f: Record<string, string> = {};
    const merged: Record<string, string | null> = {
      customer: customerId || null,
      lines: linesRaw || null,
      due: due === "30" ? null : due,
      qty: qtyRaw || null,
      custom: customRaw || null,
      ...over,
    };
    for (const [k, v] of Object.entries(merged)) if (v) f[k] = v;
    return f;
  };

  const blocks: Block[] = [
    {
      type: "header",
      title: "New invoice",
      sub: customer && !customer.deleted ? customer.name ?? customer.email ?? customerId : "Draft composer",
    },
  ];

  if (!customerId) {
    blocks.push({
      type: "notice",
      badge: { kind: "info", text: "Customer" },
      text: "Set the Customer filter (cus_…) below to scope the invoice — everything else stays as you build.",
    });
  } else if (!customer || customer.deleted) {
    blocks.push({ type: "notice", badge: { kind: "error", text: "Not found" }, text: `Customer ${customerId} does not exist (or was deleted).` });
  }

  // Pending custom line: parses "desc | 12.50 | eur" from the custom filter
  // into an add-ref that moves it into the token list.
  if (customRaw) {
    const parts = customRaw.split("|").map((s) => s.trim());
    const desc = (parts[0] ?? "").slice(0, 300);
    const amt = Number.parseFloat(parts[1] ?? "");
    const cur = (parts[2] ?? "").toLowerCase();
    const valid = desc.length > 0 && Number.isFinite(amt) && amt > 0 && /^[a-z]{3}$/.test(cur);
    if (valid) {
      const minor = Math.round(amt * (StripeClient.isZeroDecimal(cur) ? 1 : 100));
      const token = `c:${encodeURIComponent(desc)}:${minor}:${cur}`;
      blocks.push({
        type: "notice",
        badge: { kind: "info", text: "Custom line" },
        text: `"${desc}" — ${ctx.stripe.formatAmount(minor, cur)}`,
        actions: [
          {
            key: "nav:invoices.addcustom",
            label: "Add line",
            style: "primary",
            ref: { page: "invoices.new", filters: baseFilters({ lines: [linesRaw, token].filter(Boolean).join(","), custom: null }) },
          },
        ],
      });
    } else {
      blocks.push({
        type: "notice",
        badge: { kind: "warn", text: "Custom line" },
        text: 'Format: description | amount | currency — e.g. "Setup fee | 49.00 | eur".',
      });
    }
  }

  // Current lines + totals.
  blocks.push({
    type: "table",
    key: "lines",
    title: "Invoice lines",
    columns: [
      { key: "desc", label: "Description" },
      { key: "qty", label: "Qty", align: "right" },
      { key: "unit", label: "Unit", align: "right" },
      { key: "amount", label: "Amount", align: "right" },
    ],
    rows: lines.map((l) => ({
      id: l.token,
      cells: [
        text(l.desc),
        text(String(l.qty)),
        money(ctx.stripe, l.unitMinor, l.currency),
        money(ctx.stripe, l.unitMinor * l.qty, l.currency),
      ] as Cell[],
      actions: [
        {
          key: "nav:invoices.removeline",
          label: "Remove",
          ref: {
            page: "invoices.new",
            filters: baseFilters({ lines: lines.filter((o) => o.token !== l.token).map((o) => o.token).join(",") || null }),
          },
        },
      ],
    })),
    empty: "No lines yet — add prices from the picker below, or a custom line via the Custom filter.",
    ...(dropped ? { notice: `${dropped} invalid/unknown line token(s) were dropped.` } : {}),
  });

  if (mixed) {
    blocks.push({
      type: "notice",
      badge: { kind: "error", text: "Mixed currencies" },
      text: "An invoice bills ONE currency — remove lines until a single currency remains.",
    });
  } else if (lines.length > 0 && lineCurrency) {
    blocks.push({
      type: "kv",
      title: "Totals",
      amounts: true,
      rows: [
        { label: "Subtotal", cell: money(ctx.stripe, totalMinor, lineCurrency) },
        { label: "Total", cell: money(ctx.stripe, totalMinor, lineCurrency) },
      ],
    });
  }

  // Confirm: bakes the registry items[] — description ×qty flattened to
  // amountMinor per line (the registry shape). Renders only when creatable.
  const ready = customerId && customer && !customer.deleted && lines.length > 0 && !mixed;
  if (ready) {
    blocks.push({
      type: "kv",
      title: "Create",
      rows: [
        { label: "Customer", cell: idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } }) },
        { label: "Collection", cell: text(`Email invoice, due in ${due} days`) },
        { label: "Lines", cell: text(`${lines.length} — ${ctx.stripe.formatAmount(totalMinor, lineCurrency!)}`) },
      ],
      actions: [
        registryButton(ctx, {
          key: "invoice.create_draft",
          label: "Create draft invoice",
          style: "primary",
          params: {
            customerId,
            daysUntilDue: Number.parseInt(due, 10),
            items: lines.map((l) => ({
              description: l.qty > 1 ? `${l.desc} ×${l.qty}` : l.desc,
              amountMinor: l.unitMinor * l.qty,
              currency: l.currency,
            })),
          },
          inputs: [{ type: "toggle", key: "finalize", label: "Finalize immediately (emails the invoice)" }],
          summary: `Creates a draft invoice for ${customerId} with ${lines.length} line(s), ${ctx.stripe.formatAmount(totalMinor, lineCurrency!)} total. Finalizing emails it and makes it collectible.`,
        }),
      ],
    });
  }

  // Price picker: currency-locked once lines exist.
  const pickable = prices.filter(
    (p) => p.unit_amount != null && (!lineCurrency || mixed || p.currency === lineCurrency)
  );
  blocks.push({
    type: "table",
    key: "picker",
    title: "Add from catalog",
    columns: [
      { key: "name", label: "Price" },
      { key: "amount", label: "Amount", align: "right" },
      { key: "kind", label: "Type" },
    ],
    filters: [
      { key: "customer", label: "Customer", kind: "text", value: customerId || undefined, placeholder: "cus_…" },
      {
        key: "due",
        label: "Due",
        kind: "select",
        value: due === "30" ? undefined : due,
        options: [
          { value: "7", label: "Due in 7 days" },
          { value: "14", label: "Due in 14 days" },
          { value: "30", label: "Due in 30 days" },
        ],
      },
      { key: "qty", label: "Qty", kind: "text", value: qtyRaw || undefined, placeholder: "1" },
      { key: "custom", label: "Custom line", kind: "text", value: customRaw || undefined, placeholder: "desc | 12.50 | eur" },
    ],
    rows: pickable.slice(0, 25).map((p) => ({
      id: p.id,
      cells: [
        strong(p.nickname ?? (typeof p.product === "string" ? p.product : p.id), p.id),
        money(ctx.stripe, p.unit_amount ?? 0, p.currency),
        text(p.recurring ? `Recurring /${p.recurring.interval}` : "One-time"),
      ] as Cell[],
      actions:
        lines.length >= MAX_LINES
          ? []
          : [
              {
                key: "nav:invoices.addline",
                label: addQty > 1 ? `Add ×${addQty}` : "Add",
                ref: {
                  page: "invoices.new",
                  filters: baseFilters({ lines: [linesRaw, `${p.id}*${addQty}`].filter(Boolean).join(",") }),
                },
              },
            ],
    })),
    empty: lineCurrency && !mixed ? `No active ${lineCurrency.toUpperCase()} prices to add.` : "No active prices in the catalog.",
    notice:
      lines.length >= MAX_LINES
        ? `Line cap reached (${MAX_LINES}).`
        : lineCurrency && !mixed
          ? `Picker is locked to ${lineCurrency.toUpperCase()} — the invoice's currency.`
          : "Qty applies to the next Add. Custom lines: description | amount | currency.",
  });

  return {
    title: "New invoice",
    crumbs: [{ label: "Invoices", ref: { page: "invoices" } }, { label: "New" }],
    blocks,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Invoices", ref: { page: "invoices" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Invoice not found", hint }],
  };
}
