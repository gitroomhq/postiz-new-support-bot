import type Stripe from "stripe";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, ActionResult, Badge, Block, Cell, FilterDef, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";
import {
  avatarCell,
  badgeCell,
  chipCount,
  dateCell,
  idCell,
  money,
  paymentMethodCell,
  sentence,
  strong,
  subBadge,
  text,
} from "./cells";

// Subscriptions: account-wide LIST archetype (status count-cards + price
// filter), the DETAIL archetype (sub-stat strip + Pricing + Upcoming invoice
// + rail), the unified UPDATE subpage (price/qty/promo/cycle behind a
// MANDATORY proration preview — the confirm button only exists after a
// preview rendered for the exact change set; there is no direct modal), and
// the CREATE composer (same mandatory first-invoice preview).

const WINDOW = 100;
const PRICE_RE = /^price_[A-Za-z0-9]{1,64}$/;
const ITEM_RE = /^si_[A-Za-z0-9]{1,64}$/;

export function makeSubscriptionsSection(): DashboardSectionModule {
  return {
    nav: [{ key: "subscriptions", label: "Subscriptions", page: "subscriptions" }],

    ownsPage(page: string): boolean {
      return (
        page === "subscriptions" ||
        page === "subscriptions.detail" ||
        page === "subscriptions.changeplan" ||
        page === "subscriptions.new"
      );
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "subscriptions") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      if (req.page === "subscriptions.new") return composer(ctx, req.filters ?? {});
      const id = validId("subscription", req.params?.id);
      if (!id) return notFound("That subscription id is not valid (sub_…).");
      if (req.page === "subscriptions.detail") return detail(ctx, id);
      if (req.page === "subscriptions.changeplan") return updatePage(ctx, id, req.filters ?? {});
      return null;
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      // Test-mode "Run simulation": advance the customer's test clock. The
      // clock id is derived from the LIVE subscription server-side — the
      // client only names the sub.
      if (req.key === "section:subscriptions.clock_advance") {
        if (!ctx.stripe.isTestMode()) return { ok: false, error: "Simulation runs only against a TEST key." };
        const id = validId("subscription", req.params?.id);
        const daysRaw = req.params?.days;
        const days =
          typeof daysRaw === "number" && Number.isSafeInteger(daysRaw) && daysRaw >= 1 && daysRaw <= 365 ? daysRaw : null;
        if (!id || !days) return { ok: false, fieldErrors: { days: "Days must be between 1 and 365." } };
        const sub = await ctx.stripe.getSubscription(id).catch(() => null);
        const clockId = sub
          ? typeof sub.test_clock === "string"
            ? sub.test_clock
            : sub.test_clock?.id ?? null
          : null;
        if (!clockId) return { ok: false, error: "This subscription's customer has no test clock." };
        const clock = await ctx.stripe.getTestClock(clockId);
        const target = clock.frozen_time + days * 86400;
        await ctx.stripe.advanceTestClock(clockId, target);
        await ctx.audit(`Test clock ${clockId} advanced ${days}d (sub ${id})`);
        return {
          ok: true,
          text: `Test clock advanced ${days} day${days === 1 ? "" : "s"} → ${new Date(target * 1000).toISOString().slice(0, 10)}. Stripe replays renewals/invoices shortly.`,
        };
      }
      return { ok: false, error: "Unknown action." };
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

function planLabel(sub: Stripe.Subscription): { name: string; per?: string } {
  const item = sub.items.data[0];
  const price = item?.price;
  const name = price?.nickname ?? (typeof price?.product === "string" ? price.product : price?.id) ?? "plan";
  const per =
    price?.unit_amount != null
      ? `${price.currency.toUpperCase()} ${(price.unit_amount / 100).toFixed(2)}/${price.recurring?.interval ?? "?"}`
      : undefined;
  return { name, per };
}

// ---- LIST ----

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const status = str(filters.status, 24);
  const priceId = /^price_[A-Za-z0-9]{1,64}$/.test(filters.price ?? "") ? filters.price : "";
  const customerScope = validId("customer", filters.customer) ?? "";

  const cursorId = validId("subscription", validCursor(cursor) ?? "") ?? undefined;

  // Real chip totals via subscriptions.search (window counts cap at WINDOW).
  // Subscription search indexes created/metadata/status only — customer- or
  // price-scoped views and the Paused chip (pause_collection) can't be
  // expressed, so those stay honest windowed counts ("N+" on overflow).
  const scoped = Boolean(customerScope || priceId);
  const countSearch = (q: string) =>
    scoped
      ? Promise.resolve(null)
      : Promise.resolve()
          .then(() => ctx.stripe.countBySearch("subscriptions", q))
          .catch(() => null);
  const SUB_STATUSES = ["active", "trialing", "past_due", "canceled"] as const;
  const [subsRes, prices, chipTotals] = await Promise.all([
    ctx.stripe.listAllSubscriptions({
      status: "all",
      priceId: priceId || undefined,
      customerId: customerScope || undefined,
      limit: WINDOW,
      startingAfter: cursorId,
    }),
    ctx.stripe.listRecurringPrices(50).catch(() => [] as Stripe.Price[]),
    Promise.all([countSearch("created>0"), ...SUB_STATUSES.map((s) => countSearch(`status:"${s}"`))]),
  ]);
  const subs = subsRes.subscriptions;
  const [nAll, nActive, nTrialing, nPastDue, nCanceled] = chipTotals;

  const over = subsRes.hasMore;
  const counts = {
    key: "status",
    items: [
      { value: "", label: "All", count: chipCount(nAll, subs.length, over) },
      { value: "active", label: "Active", count: chipCount(nActive, subs.filter((s) => s.status === "active").length, over) },
      {
        value: "trialing",
        label: "Trialing",
        count: chipCount(nTrialing, subs.filter((s) => s.status === "trialing").length, over),
      },
      {
        value: "past_due",
        label: "Past due",
        count: chipCount(nPastDue, subs.filter((s) => s.status === "past_due").length, over),
      },
      { value: "paused", label: "Paused", count: chipCount(null, subs.filter((s) => !!s.pause_collection).length, over) },
      {
        value: "canceled",
        label: "Canceled",
        count: chipCount(nCanceled, subs.filter((s) => s.status === "canceled").length, over),
      },
    ],
  };

  const filtered = subs.filter((s) => {
    if (!status) return true;
    if (status === "paused") return !!s.pause_collection;
    return s.status === status;
  });

  const rows = filtered.map((sub) => {
    const plan = planLabel(sub);
    const item = sub.items.data[0];
    const flags: Badge[] = [subBadge(sub.status)];
    if (sub.pause_collection) flags.push({ kind: "warn", text: "Paused" });
    if (sub.cancel_at_period_end) flags.push({ kind: "warn", text: "Cancels at period end" });
    const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
    return {
      id: sub.id,
      ref: { page: "subscriptions.detail", params: { id: sub.id } },
      cells: [
        avatarCell("subscription", plan.name, { sub: plan.per }),
        customer
          ? ({ t: "link", v: customer, ref: { page: "customers.detail", params: { id: customer } } } as Cell)
          : text("—"),
        { t: "flags", badges: flags } as Cell,
        dateCell(sub.created),
        item?.current_period_end ? dateCell(item.current_period_end) : text("—"),
        idCell(sub.id, { copy: true }),
      ] as Cell[],
    };
  });

  return {
    title: "Subscriptions",
    crumbs: [{ label: "Subscriptions" }],
    blocks: [
      {
        type: "header",
        title: "Subscriptions",
        actions: [
          {
            key: "nav:subscriptions.new",
            label: "Create subscription",
            style: "primary",
            ref: { page: "subscriptions.new" },
          },
        ],
      },
      {
        type: "table",
        key: "subs",
        columns: [
          { key: "plan", label: "Product" },
          { key: "customer", label: "Customer" },
          { key: "status", label: "Status" },
          { key: "created", label: "Started" },
          { key: "next", label: "Next invoice" },
          { key: "id", label: "ID" },
        ],
        counts,
        filters: [
          { key: "customer", label: "Customer", kind: "text", value: customerScope || undefined, placeholder: "cus_…" },
          {
            key: "price",
            label: "Price",
            kind: "select",
            value: priceId || undefined,
            options: prices.slice(0, 25).map((p) => ({
              value: p.id,
              label: p.nickname ?? `${p.id.slice(0, 18)}…`,
            })),
          },
        ],
        rows,
        nextCursor: subsRes.hasMore && subs.length > 0 ? subs[subs.length - 1].id : null,
        empty: status ? "No subscriptions match this filter (within this window)." : "No subscriptions yet.",
        ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
        notice: `Chip counts are account totals (Paused counts this page's window); the table shows ${WINDOW} per page — use Next for older ones.`,
      },
    ],
  };
}

// ---- DETAIL ----

async function detail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const sub = await ctx.stripe.getSubscription(id).catch(() => null);
  if (!sub) return notFound("This subscription does not exist.");
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  const [upcoming, discordIds, customer] = await Promise.all([
    customerId && sub.status !== "canceled"
      ? ctx.stripe.previewUpcomingInvoice(customerId, id)
      : Promise.resolve(null),
    customerId ? ctx.stores.session.findDiscordIdsByStripeId(customerId).catch(() => []) : Promise.resolve([]),
    customerId
      ? Promise.resolve()
          .then(() => ctx.stripe.getCustomer(customerId))
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const plan = planLabel(sub);
  const item = sub.items.data[0];
  const cancelable = sub.status !== "canceled";
  // Stripe titles subscription pages "Customer on Product".
  const customerName = customer && !customer.deleted ? customer.name ?? customer.email ?? customerId : customerId;
  const title = customerName ? `${customerName} on ${plan.name}` : plan.name;

  // Payment method as brand+last4, never a raw pm_ id: the sub-level default
  // is expanded on getSubscription; when absent Stripe falls back to the
  // customer's default — resolve that one with a single extra read.
  const subPm = sub.default_payment_method;
  let pmCell: Cell | null = null;
  if (subPm && typeof subPm === "object") {
    pmCell = paymentMethodCell(subPm as Stripe.PaymentMethod);
  } else {
    const customerPmRaw = customer && !customer.deleted ? customer.invoice_settings?.default_payment_method : null;
    const customerPmId = typeof customerPmRaw === "string" ? customerPmRaw : customerPmRaw?.id ?? null;
    const fallbackId = typeof subPm === "string" ? subPm : customerPmId;
    if (fallbackId) {
      const pm = await ctx.stripe.getPaymentMethod(fallbackId).catch(() => null);
      pmCell = pm
        ? paymentMethodCell(pm, typeof subPm === "string" ? undefined : "customer default")
        : idCell(fallbackId, { copy: true });
    }
  }

  // Change-plan is deliberately NOT a header action: it lives behind the
  // proration-preview subpage (Pricing footer + rail link) — the mandatory
  // preview step has no modal shortcut.
  const actions: ActionButton[] = [];
  if (cancelable) {
    actions.push(
      registryButton(ctx, {
        key: "subscription.cancel",
        label: "Cancel at period end",
        dangerous: true,
        params: { subscriptionId: id, when: "period_end" },
        summary: `The subscription stays active until ${item?.current_period_end ? new Date(item.current_period_end * 1000).toISOString().slice(0, 10) : "the period end"}, then ends.`,
        disabledReason: sub.cancel_at_period_end ? "Already set to cancel at period end." : undefined,
      })
    );
    actions.push(
      registryButton(ctx, {
        key: "subscription.cancel",
        label: "Cancel now",
        style: "danger",
        dangerous: true,
        stepUp: true,
        params: { subscriptionId: id, when: "now" },
        summary: "Ends the subscription IMMEDIATELY (no proration refund). Requires a fresh factor.",
      })
    );
    actions.push(
      registryButton(ctx, {
        key: "subscription.pause_resume",
        label: sub.pause_collection ? "Resume collection" : "Pause collection",
        dangerous: true,
        params: { subscriptionId: id, op: sub.pause_collection ? "resume" : "pause" },
        summary: sub.pause_collection
          ? "Invoices are collected normally again."
          : "Invoices are voided while paused — the subscription stays active.",
      })
    );
    actions.push(
      registryButton(ctx, {
        key: "subscription.terms",
        label: "Trial / quantity",
        dangerous: true,
        params: { subscriptionId: id },
        inputs: [
          { type: "number", key: "trialEndUnix", label: "Trial end (unix seconds, optional)" },
          { type: "number", key: "quantity", label: "Quantity (optional)", min: 1 },
        ],
        summary: "Set a future trial end and/or the seat quantity.",
      })
    );
    actions.push(
      registryButton(ctx, {
        key: "customer.coupon",
        label: "Apply promo code",
        params: { subscriptionId: id },
        inputs: [{ type: "text", key: "promoCode", label: "Promo code" }],
        summary: "Applies the promo's coupon to this subscription.",
      })
    );
  }

  const main: Block[] = [];
  const rail: Block[] = [];

  main.push({
    type: "header",
    title,
    ...(plan.per ? { sub: plan.per } : {}),
    badges: [
      subBadge(sub.status),
      ...(sub.pause_collection ? [{ kind: "warn", text: "Paused" } as Badge] : []),
      ...(sub.cancel_at_period_end ? [{ kind: "warn", text: "Cancels at period end" } as Badge] : []),
    ],
    actions,
  });

  // Sub-stat strip (Started · Next invoice · Auto-cancels), Stripe-style.
  main.push({
    type: "stats",
    items: [
      { label: "Started", value: new Date(sub.created * 1000).toISOString().slice(0, 10) },
      {
        label: "Next invoice",
        value: upcoming
          ? ctx.stripe.formatAmount(upcoming.amount_due, upcoming.currency)
          : item?.current_period_end
            ? new Date(item.current_period_end * 1000).toISOString().slice(0, 10)
            : "—",
        sub: upcoming?.next_payment_attempt
          ? `on ${new Date(upcoming.next_payment_attempt * 1000).toISOString().slice(0, 10)}`
          : item?.current_period_end
            ? `on ${new Date(item.current_period_end * 1000).toISOString().slice(0, 10)}`
            : undefined,
      },
      {
        label: "Auto-cancels",
        value: sub.cancel_at
          ? new Date(sub.cancel_at * 1000).toISOString().slice(0, 10)
          : sub.cancel_at_period_end && item?.current_period_end
            ? new Date(item.current_period_end * 1000).toISOString().slice(0, 10)
            : "—",
      },
      ...(sub.trial_end && sub.trial_end * 1000 > Date.now()
        ? [{ label: "Trial ends", value: new Date(sub.trial_end * 1000).toISOString().slice(0, 10) }]
        : []),
    ],
  });

  // Pricing table (all items, si_ ids surfaced).
  main.push({
    type: "table",
    key: "pricing",
    title: "Pricing",
    columns: [
      { key: "product", label: "Product" },
      { key: "qty", label: "Qty", align: "right" },
      { key: "unit", label: "Unit", align: "right" },
      { key: "total", label: "Total", align: "right" },
      { key: "interval", label: "Billing" },
      { key: "id", label: "ID" },
    ],
    rows: sub.items.data.map((it) => {
      const p = it.price;
      const name = p?.nickname ?? (typeof p?.product === "string" ? p.product : p?.id) ?? "item";
      const qty = it.quantity ?? 1;
      return {
        id: it.id,
        cells: [
          avatarCell("subscription", name),
          text(String(qty)),
          p?.unit_amount != null ? money(ctx.stripe, p.unit_amount, p.currency) : text("—"),
          p?.unit_amount != null ? money(ctx.stripe, p.unit_amount * qty, p.currency) : text("—"),
          text(p?.recurring ? `every ${p.recurring.interval_count ?? 1} ${p.recurring.interval}` : "—"),
          idCell(it.id, { copy: true }),
        ] as Cell[],
      };
    }),
    ...(sub.status === "active" || sub.status === "trialing"
      ? { footer: "Update subscription (proration preview)", footerRef: { page: "subscriptions.changeplan", params: { id } } }
      : {}),
  });

  // Upcoming-invoice preview: full breakdown — every line w/ qty, then the
  // subtotal→total→amount-due ladder Stripe shows.
  if (upcoming) {
    const lineRows = upcoming.lines.data.slice(0, 20).map((line, i) => ({
      id: line.id ?? String(i),
      cells: [
        text(line.description ?? "line"),
        text(String(line.quantity ?? 1)),
        money(ctx.stripe, line.amount, line.currency),
      ] as Cell[],
    }));
    const totalRows: Array<{ id: string; cells: Cell[] }> = [];
    if (typeof upcoming.subtotal === "number") {
      totalRows.push({
        id: "t_subtotal",
        cells: [text("Subtotal"), text(""), money(ctx.stripe, upcoming.subtotal, upcoming.currency)] as Cell[],
      });
      if (typeof upcoming.total === "number" && upcoming.total !== upcoming.subtotal) {
        totalRows.push({
          id: "t_adjust",
          cells: [
            text("Discounts & tax"),
            text(""),
            money(ctx.stripe, upcoming.total - upcoming.subtotal, upcoming.currency),
          ] as Cell[],
        });
      }
    }
    if (typeof upcoming.total === "number") {
      totalRows.push({
        id: "t_total",
        cells: [text("Total"), text(""), money(ctx.stripe, upcoming.total, upcoming.currency)] as Cell[],
      });
    }
    totalRows.push({
      id: "t_due",
      cells: [strong("Amount due"), text(""), money(ctx.stripe, upcoming.amount_due, upcoming.currency)] as Cell[],
    });
    main.push({
      type: "table",
      key: "upcoming",
      title: "Upcoming invoice",
      columns: [
        { key: "desc", label: "Description" },
        { key: "qty", label: "Qty", align: "right" },
        { key: "amount", label: "Amount", align: "right" },
      ],
      rows: [...lineRows, ...totalRows],
      notice: `${upcoming.lines.data.length > 20 ? `Showing 20 of ${upcoming.lines.data.length} lines. ` : ""}${
        upcoming.next_payment_attempt
          ? `Collects ${new Date(upcoming.next_payment_attempt * 1000).toISOString().slice(0, 10)}. `
          : ""
      }Preview — amounts can still change.`,
    });
  }

  // Rail: Details + Customer (+ Simulation in test mode).
  rail.push({
    type: "kv",
    title: "Details",
    rows: [
      { label: "Subscription ID", cell: idCell(sub.id, { copy: true }) },
      { label: "Status", cell: badgeCell(subBadge(sub.status).kind, sentence(sub.status)) },
      { label: "Created", cell: dateCell(sub.created) },
      {
        label: "Collection",
        cell: text(sub.collection_method === "send_invoice" ? "Email invoice" : "Charge automatically"),
      },
      { label: "Payment method", cell: pmCell ?? text("—") },
      ...(sub.discounts?.length ? [{ label: "Discounts", cell: text(String(sub.discounts.length)) }] : []),
      ...(typeof sub.latest_invoice === "string"
        ? [
            {
              label: "Latest invoice",
              cell: idCell(sub.latest_invoice, { copy: true, ref: { page: "invoices.detail", params: { id: sub.latest_invoice } } }),
            },
          ]
        : []),
      ...(sub.status === "active" || sub.status === "trialing"
        ? [
            {
              label: "Update",
              cell: { t: "link", v: "Update subscription (preview)", ref: { page: "subscriptions.changeplan", params: { id } } } as Cell,
            },
          ]
        : []),
    ],
  });
  rail.push({
    type: "kv",
    title: "Customer",
    rows: customerId
      ? [
          ...(customerName && customerName !== customerId ? [{ label: "Name", cell: text(customerName) }] : []),
          { label: "ID", cell: idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } }) },
          { label: "Discord", cell: discordIds.length ? idCell(discordIds[0], { copy: true }) : text("not linked") },
        ]
      : [{ label: "Customer", cell: text("No customer attached.") }],
  });

  // Test-mode-only "Run simulation" affordance (Stripe test clocks). Prod runs
  // sk_live, so this card never renders there.
  if (ctx.stripe.isTestMode()) {
    const clockId = typeof sub.test_clock === "string" ? sub.test_clock : sub.test_clock?.id ?? null;
    rail.push({
      type: "kv",
      title: "Simulation",
      rows: [
        {
          label: "Test clock",
          cell: clockId ? idCell(clockId, { copy: true }) : text("none — clocks attach at customer creation"),
        },
      ],
      ...(clockId
        ? {
            actions: [
              {
                key: "section:subscriptions.clock_advance",
                label: "Run simulation",
                inputs: [{ type: "number", key: "days", label: "Advance by days (1–365)", min: 1, max: 365 }],
                params: { id: sub.id },
                summary:
                  "Advances the customer's test clock — Stripe replays renewals, invoices and dunning up to the new time. Test mode only.",
              },
            ],
          }
        : {}),
    });
  }

  return {
    title,
    crumbs: [{ label: "Subscriptions", ref: { page: "subscriptions" } }, { label: sub.id, copyId: sub.id }],
    blocks: main,
    rail,
  };
}

// ---- UPDATE SUBSCRIPTION (unified drawer: item/price/qty/promo/cycle behind
// the mandatory proration preview) ----

const intervalRank: Record<string, number> = { day: 0, week: 1, month: 2, year: 3 };

function sortPrices(prices: Stripe.Price[]): Stripe.Price[] {
  return [...prices].sort(
    (a, b) =>
      (intervalRank[a.recurring?.interval ?? ""] ?? 9) - (intervalRank[b.recurring?.interval ?? ""] ?? 9) ||
      (a.unit_amount ?? 0) - (b.unit_amount ?? 0)
  );
}

async function updatePage(ctx: DashboardCtx, id: string, filters: Record<string, string>): Promise<SectionPage> {
  const sub = await ctx.stripe.getSubscription(id).catch(() => null);
  if (!sub) return notFound("This subscription does not exist.");
  if (sub.status !== "active" && sub.status !== "trialing") {
    return notFound(`Subscription is ${sub.status} — only active/trialing subscriptions can be updated.`);
  }
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  const itemFilter = ITEM_RE.test(filters.item ?? "") ? filters.item : "";
  const item = itemFilter ? sub.items.data.find((it) => it.id === itemFilter) ?? null : sub.items.data[0] ?? null;
  if (!customerId || !item) return notFound("Subscription has no customer/item to update.");

  // PA-6: the page has three operations — change the selected item's price
  // (default), ADD a new item, REMOVE an item. All behind the same mandatory
  // proration preview.
  const mode = filters.mode === "add" || filters.mode === "remove" ? filters.mode : "";
  if (mode === "add") return addItemMode(ctx, sub, id, customerId, filters);
  if (mode === "remove") return removeItemMode(ctx, sub, id, customerId, filters);

  const prices = await ctx.stripe.listRecurringPrices(50).catch(() => [] as Stripe.Price[]);
  const allowlist = ctx.settings.allowedPriceIds();
  const currentPriceId = item.price?.id ?? "";
  // The picker includes the CURRENT price (marked) so qty/promo/cycle-only
  // updates are possible; other prices respect the allowlist.
  let candidates = sortPrices(
    prices.filter((p) => p.id === currentPriceId || allowlist.length === 0 || allowlist.includes(p.id))
  );
  if (currentPriceId && item.price && !candidates.some((p) => p.id === currentPriceId)) {
    candidates = [item.price as Stripe.Price, ...candidates];
  }

  // The whole change set rides page filters so row-picks and field edits
  // compose (a row click preserves qty/promo/cycle).
  const targetPrice = PRICE_RE.test(filters.price ?? "") ? filters.price : "";
  const effectiveTarget = targetPrice || currentPriceId;
  const qtyRaw = str(filters.qty, 6).trim();
  const quantity = /^\d{1,5}$/.test(qtyRaw) ? Math.max(1, Number.parseInt(qtyRaw, 10)) : null;
  const promo = str(filters.promo, 60).replace(/["\\]/g, "").trim();
  const cycle = filters.cycle === "now" ? "now" : "";
  const currentQty = item.quantity ?? 1;
  const priceChanged = !!effectiveTarget && effectiveTarget !== currentPriceId;
  const qtyChanged = quantity != null && quantity !== currentQty;
  const dirty = priceChanged || qtyChanged || !!promo || cycle === "now";

  const carried: Record<string, string> = {
    ...(itemFilter ? { item: itemFilter } : {}),
    ...(qtyRaw ? { qty: qtyRaw } : {}),
    ...(promo ? { promo } : {}),
    ...(cycle ? { cycle } : {}),
  };

  const pageFilters: FilterDef[] = [
    modeFilter(sub, ""),
    ...(sub.items.data.length > 1
      ? [
          {
            key: "item",
            label: "Item",
            kind: "select" as const,
            value: item.id,
            options: sub.items.data.map((it) => ({
              value: it.id,
              label: it.price?.nickname ?? it.price?.id ?? it.id,
            })),
          },
        ]
      : []),
    { key: "qty", label: "Quantity", kind: "text" as const, value: qtyRaw || undefined, placeholder: `current: ${currentQty}` },
    { key: "promo", label: "Promo code", kind: "text" as const, value: promo || undefined, placeholder: "SAVE20" },
    {
      key: "cycle",
      label: "Billing cycle",
      kind: "select" as const,
      value: cycle || undefined,
      options: [
        { value: "", label: "Keep cycle" },
        { value: "now", label: "Reset cycle to now" },
      ],
    },
  ];

  const plan = planLabel(sub);
  // Row click = pick: each row navigates to this page with its price applied.
  const blocks: Block[] = [
    {
      type: "header",
      title: "Update subscription",
      sub: `${plan.name} · ${sub.id}`,
    },
    {
      type: "table",
      key: "prices",
      title: "Price",
      columns: [
        { key: "name", label: "Price" },
        { key: "picked", label: "" },
        { key: "amount", label: "Amount", align: "right" },
        { key: "interval", label: "Billing" },
        { key: "id", label: "ID" },
      ],
      filters: pageFilters,
      rows: candidates.slice(0, 25).map((p) => ({
        id: p.id,
        ref: { page: "subscriptions.changeplan", params: { id }, filters: { ...carried, price: p.id } },
        cells: [
          avatarCell("subscription", p.nickname ?? p.id),
          p.id === currentPriceId
            ? badgeCell("neutral", "Current")
            : p.id === effectiveTarget
              ? badgeCell("info", "Selected")
              : text(""),
          p.unit_amount != null ? money(ctx.stripe, p.unit_amount, p.currency) : text("—"),
          text(p.recurring ? `every ${p.recurring.interval_count ?? 1} ${p.recurring.interval}` : "—"),
          idCell(p.id, { copy: true }),
        ] as Cell[],
      })),
      empty: allowlist.length
        ? "No prices on the plan allowlist (/config → Billing)."
        : "No recurring prices found.",
      notice: "Pick a price and/or set quantity, promo or cycle — then confirm below the proration preview.",
    },
  ];

  // MANDATORY preview: the confirm button exists ONLY once the change set is
  // non-empty and its proration preview rendered.
  if (dirty && effectiveTarget) {
    const preview = await ctx.stripe
      .previewPlanChange({
        customerId,
        subscriptionId: id,
        itemId: item.id,
        priceId: effectiveTarget,
        prorationDate: Math.floor(Date.now() / 1000),
        ...(qtyChanged ? { quantity: quantity! } : {}),
        ...(cycle === "now" ? { billingCycleAnchor: "now" as const } : {}),
      })
      .catch(() => null);
    if (!preview) {
      blocks.push({
        type: "notice",
        badge: { kind: "error", text: "PREVIEW FAILED" },
        text: "Stripe could not preview this change (incompatible currency/interval?). Pick a different change set.",
      });
    } else {
      const changeBits = [
        priceChanged ? `price → ${effectiveTarget}` : null,
        qtyChanged ? `quantity → ${quantity}` : null,
        promo ? `promo ${promo} (applied at execution — not in the preview)` : null,
        cycle === "now" ? "billing cycle resets to now" : null,
      ].filter(Boolean);
      blocks.push({
        type: "table",
        key: "preview",
        title: "Proration preview",
        columns: [
          { key: "desc", label: "Description" },
          { key: "amount", label: "Amount", align: "right" },
        ],
        rows: preview.lines.data.slice(0, 15).map((line, i) => ({
          id: line.id ?? String(i),
          cells: [text(line.description ?? "line"), money(ctx.stripe, line.amount, line.currency)] as Cell[],
        })),
        notice: `Next invoice would be ${ctx.stripe.formatAmount(preview.amount_due, preview.currency)}. Estimate — the committed prorations are computed at execution time.`,
      });
      const confirmParams: Record<string, unknown> = { subscriptionId: id, priceId: effectiveTarget };
      if (itemFilter && itemFilter !== sub.items.data[0]?.id) confirmParams.itemId = itemFilter;
      if (qtyChanged) confirmParams.quantity = quantity;
      if (promo) confirmParams.promoCode = promo;
      if (cycle === "now") confirmParams.cycleAnchor = "now";
      blocks.push({
        type: "notice",
        badge: { kind: "info", text: "REVIEWED" },
        text: `Update ${sub.id}: ${changeBits.join(", ")}.`,
        actions: [
          registryButton(ctx, {
            key: "subscription.change_plan",
            label: "Update subscription",
            style: "primary",
            dangerous: true,
            params: confirmParams,
            summary: `Apply ${changeBits.join(", ")} with create_prorations — you reviewed the preview above.`,
          }),
        ],
      });
    }
  } else if (targetPrice && !dirty) {
    blocks.push({
      type: "notice",
      badge: { kind: "info", text: "NO CHANGE" },
      text: "That is already the current price — set a different price, quantity, promo or cycle reset.",
    });
  }

  return {
    title: "Update subscription",
    crumbs: [
      { label: "Subscriptions", ref: { page: "subscriptions" } },
      { label: sub.id, ref: { page: "subscriptions.detail", params: { id } } },
      { label: "Update" },
    ],
    blocks,
  };
}

// The operation switch shared by the three update-page modes. "Remove item"
// only exists on multi-item subscriptions (the last item can't be removed).
function modeFilter(sub: Stripe.Subscription, value: string): FilterDef {
  return {
    key: "mode",
    label: "Operation",
    kind: "select",
    value: value || undefined,
    options: [
      { value: "", label: "Change price" },
      { value: "add", label: "Add item" },
      ...(sub.items.data.length > 1 ? [{ value: "remove", label: "Remove item" }] : []),
    ],
  };
}

// ---- ADD ITEM (PA-6: grow a subscription, mandatory proration preview) ----

async function addItemMode(
  ctx: DashboardCtx,
  sub: Stripe.Subscription,
  id: string,
  customerId: string,
  filters: Record<string, string>
): Promise<SectionPage> {
  const prices = await ctx.stripe.listRecurringPrices(50).catch(() => [] as Stripe.Price[]);
  const allowlist = ctx.settings.allowedPriceIds();
  const onSub = new Set(sub.items.data.map((it) => it.price?.id).filter(Boolean));
  const candidates = sortPrices(
    prices.filter((p) => !onSub.has(p.id) && (allowlist.length === 0 || allowlist.includes(p.id)))
  );
  const targetPrice = PRICE_RE.test(filters.price ?? "") ? filters.price : "";
  const qtyRaw = str(filters.qty, 6).trim();
  const quantity = /^\d{1,5}$/.test(qtyRaw) && Number.parseInt(qtyRaw, 10) > 1 ? Number.parseInt(qtyRaw, 10) : null;
  const carried: Record<string, string> = { mode: "add", ...(qtyRaw ? { qty: qtyRaw } : {}) };
  const plan = planLabel(sub);

  const blocks: Block[] = [
    { type: "header", title: "Update subscription", sub: `Add item · ${plan.name} · ${sub.id}` },
    {
      type: "table",
      key: "prices",
      title: "Pick the price to ADD",
      columns: [
        { key: "name", label: "Price" },
        { key: "picked", label: "" },
        { key: "amount", label: "Amount", align: "right" },
        { key: "interval", label: "Billing" },
        { key: "id", label: "ID" },
      ],
      filters: [
        modeFilter(sub, "add"),
        { key: "qty", label: "Quantity", kind: "text", value: qtyRaw || undefined, placeholder: "1" },
      ],
      rows: candidates.slice(0, 25).map((p) => ({
        id: p.id,
        ref: { page: "subscriptions.changeplan", params: { id }, filters: { ...carried, price: p.id } },
        cells: [
          avatarCell("subscription", p.nickname ?? p.id),
          p.id === targetPrice ? badgeCell("info", "Selected") : text(""),
          p.unit_amount != null ? money(ctx.stripe, p.unit_amount, p.currency) : text("—"),
          text(p.recurring ? `every ${p.recurring.interval_count ?? 1} ${p.recurring.interval}` : "—"),
          idCell(p.id, { copy: true }),
        ] as Cell[],
      })),
      empty: "No addable prices — every allowlisted recurring price is already on this subscription.",
      notice: "Prices already on the subscription are hidden. Pick one to preview the proration, then confirm.",
    },
  ];

  if (targetPrice) {
    const preview = await ctx.stripe
      .previewItemsChange({
        customerId,
        subscriptionId: id,
        items: [{ price: targetPrice, ...(quantity ? { quantity } : {}) }],
        prorationDate: Math.floor(Date.now() / 1000),
      })
      .catch(() => null);
    if (!preview) {
      blocks.push({
        type: "notice",
        badge: { kind: "error", text: "PREVIEW FAILED" },
        text: "Stripe could not preview this addition (currency/interval mismatch with the subscription?). Pick a different price.",
      });
    } else {
      blocks.push({
        type: "table",
        key: "preview",
        title: "Proration preview",
        columns: [
          { key: "desc", label: "Description" },
          { key: "amount", label: "Amount", align: "right" },
        ],
        rows: preview.lines.data.slice(0, 15).map((line, i) => ({
          id: line.id ?? String(i),
          cells: [text(line.description ?? "line"), money(ctx.stripe, line.amount, line.currency)] as Cell[],
        })),
        notice: `Next invoice would be ${ctx.stripe.formatAmount(preview.amount_due, preview.currency)}. Estimate — computed again at execution time.`,
      });
      blocks.push({
        type: "notice",
        badge: { kind: "info", text: "REVIEWED" },
        text: `Add ${targetPrice}${quantity ? ` ×${quantity}` : ""} to ${sub.id}.`,
        actions: [
          registryButton(ctx, {
            key: "subscription.items",
            label: "Add item",
            style: "primary",
            dangerous: true,
            params: { subscriptionId: id, op: "add", priceId: targetPrice, ...(quantity ? { quantity } : {}) },
            summary: `Adds ${targetPrice}${quantity ? ` ×${quantity}` : ""} with create_prorations — you reviewed the preview above.`,
          }),
        ],
      });
    }
  }

  return {
    title: "Update subscription",
    crumbs: [
      { label: "Subscriptions", ref: { page: "subscriptions" } },
      { label: sub.id, ref: { page: "subscriptions.detail", params: { id } } },
      { label: "Add item" },
    ],
    blocks,
  };
}

// ---- REMOVE ITEM (PA-6: shrink a subscription, mandatory proration preview) ----

async function removeItemMode(
  ctx: DashboardCtx,
  sub: Stripe.Subscription,
  id: string,
  customerId: string,
  filters: Record<string, string>
): Promise<SectionPage> {
  const plan = planLabel(sub);
  const itemSel = ITEM_RE.test(filters.item ?? "") ? filters.item : "";
  const selected = itemSel ? sub.items.data.find((it) => it.id === itemSel) ?? null : null;
  const removable = sub.items.data.length > 1;

  const blocks: Block[] = [
    { type: "header", title: "Update subscription", sub: `Remove item · ${plan.name} · ${sub.id}` },
    {
      type: "table",
      key: "items",
      title: "Pick the item to REMOVE",
      columns: [
        { key: "product", label: "Product" },
        { key: "picked", label: "" },
        { key: "qty", label: "Qty", align: "right" },
        { key: "total", label: "Total", align: "right" },
        { key: "id", label: "ID" },
      ],
      filters: [modeFilter(sub, "remove")],
      rows: sub.items.data.map((it) => {
        const p = it.price;
        const name = p?.nickname ?? (typeof p?.product === "string" ? p.product : p?.id) ?? "item";
        const qty = it.quantity ?? 1;
        return {
          id: it.id,
          ref: { page: "subscriptions.changeplan", params: { id }, filters: { mode: "remove", item: it.id } },
          cells: [
            avatarCell("subscription", name),
            it.id === itemSel ? badgeCell("error", "Removing") : text(""),
            text(String(qty)),
            p?.unit_amount != null ? money(ctx.stripe, p.unit_amount * qty, p.currency) : text("—"),
            idCell(it.id, { copy: true }),
          ] as Cell[],
        };
      }),
      empty: "No items.",
      notice: removable
        ? "Click an item to preview the removal proration, then confirm below."
        : "This subscription has a single item — the last item cannot be removed (cancel the subscription instead).",
    },
  ];

  if (removable && selected) {
    const preview = await ctx.stripe
      .previewItemsChange({
        customerId,
        subscriptionId: id,
        items: [{ id: selected.id, deleted: true }],
        prorationDate: Math.floor(Date.now() / 1000),
      })
      .catch(() => null);
    if (!preview) {
      blocks.push({
        type: "notice",
        badge: { kind: "error", text: "PREVIEW FAILED" },
        text: "Stripe could not preview this removal. Pick a different item.",
      });
    } else {
      blocks.push({
        type: "table",
        key: "preview",
        title: "Proration preview",
        columns: [
          { key: "desc", label: "Description" },
          { key: "amount", label: "Amount", align: "right" },
        ],
        rows: preview.lines.data.slice(0, 15).map((line, i) => ({
          id: line.id ?? String(i),
          cells: [text(line.description ?? "line"), money(ctx.stripe, line.amount, line.currency)] as Cell[],
        })),
        notice: `Next invoice would be ${ctx.stripe.formatAmount(preview.amount_due, preview.currency)}. Estimate — computed again at execution time.`,
      });
      blocks.push({
        type: "notice",
        badge: { kind: "info", text: "REVIEWED" },
        text: `Remove item ${selected.id} from ${sub.id}.`,
        actions: [
          registryButton(ctx, {
            key: "subscription.items",
            label: "Remove item",
            style: "danger",
            dangerous: true,
            params: { subscriptionId: id, op: "remove", itemId: selected.id },
            summary: `Removes ${selected.id} with create_prorations — you reviewed the preview above.`,
          }),
        ],
      });
    }
  }

  return {
    title: "Update subscription",
    crumbs: [
      { label: "Subscriptions", ref: { page: "subscriptions" } },
      { label: sub.id, ref: { page: "subscriptions.detail", params: { id } } },
      { label: "Remove item" },
    ],
    blocks,
  };
}

// ---- CREATE SUBSCRIPTION (composer, mandatory first-invoice preview) ----

async function composer(ctx: DashboardCtx, filters: Record<string, string>): Promise<SectionPage> {
  const customerId = validId("customer", filters.customer) ?? "";
  const targetPrice = PRICE_RE.test(filters.price ?? "") ? filters.price : "";
  const qtyRaw = str(filters.qty, 6).trim();
  const quantity = /^\d{1,5}$/.test(qtyRaw) && Number.parseInt(qtyRaw, 10) > 1 ? Number.parseInt(qtyRaw, 10) : null;
  const promo = str(filters.promo, 60).replace(/["\\]/g, "").trim();
  const trialRaw = str(filters.trial, 4).trim();
  const trialDays = /^\d{1,3}$/.test(trialRaw) && Number.parseInt(trialRaw, 10) > 0 ? Number.parseInt(trialRaw, 10) : null;
  const collection: "charge" | "invoice" = filters.collection === "invoice" ? "invoice" : "charge";

  const [prices, customer] = await Promise.all([
    ctx.stripe.listRecurringPrices(50).catch(() => [] as Stripe.Price[]),
    customerId
      ? Promise.resolve()
          .then(() => ctx.stripe.getCustomer(customerId))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const allowlist = ctx.settings.allowedPriceIds();
  const candidates = sortPrices(prices.filter((p) => allowlist.length === 0 || allowlist.includes(p.id)));

  const carried: Record<string, string> = {
    ...(customerId ? { customer: customerId } : {}),
    ...(qtyRaw ? { qty: qtyRaw } : {}),
    ...(promo ? { promo } : {}),
    ...(trialRaw ? { trial: trialRaw } : {}),
    ...(filters.collection === "invoice" ? { collection: "invoice" } : {}),
  };

  const blocks: Block[] = [
    {
      type: "header",
      title: "Create subscription",
      sub: "Pick a customer and a price — the first-invoice preview is the mandatory review step.",
    },
  ];

  // Customer resolution card: name/email + whether off-session billing can work.
  if (customerId) {
    if (!customer || customer.deleted) {
      blocks.push({
        type: "notice",
        badge: { kind: "error", text: "NO CUSTOMER" },
        text: `Customer ${customerId} does not exist (or was deleted).`,
      });
    } else {
      const pmRaw = customer.invoice_settings?.default_payment_method;
      const pmId = typeof pmRaw === "string" ? pmRaw : pmRaw?.id ?? null;
      const pm = pmId ? await ctx.stripe.getPaymentMethod(pmId).catch(() => null) : null;
      blocks.push({
        type: "kv",
        title: "Customer",
        rows: [
          { label: "Customer", cell: strong(customer.name ?? customer.email ?? customerId) },
          { label: "ID", cell: idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } }) },
          ...(customer.email ? [{ label: "Email", cell: text(customer.email) }] : []),
          {
            label: "Default payment method",
            cell: pm
              ? paymentMethodCell(pm)
              : text(pmId ?? "none", pmId ? undefined : "charge-now needs a card — use invoice or a trial"),
          },
        ],
      });
    }
  }

  blocks.push({
    type: "table",
    key: "prices",
    title: "Price",
    columns: [
      { key: "name", label: "Price" },
      { key: "picked", label: "" },
      { key: "amount", label: "Amount", align: "right" },
      { key: "interval", label: "Billing" },
      { key: "id", label: "ID" },
    ],
    filters: [
      { key: "customer", label: "Customer", kind: "text", value: customerId || undefined, placeholder: "cus_…" },
      { key: "qty", label: "Quantity", kind: "text", value: qtyRaw || undefined, placeholder: "1" },
      { key: "promo", label: "Promo code", kind: "text", value: promo || undefined, placeholder: "SAVE20" },
      { key: "trial", label: "Trial days", kind: "text", value: trialRaw || undefined, placeholder: "0" },
      {
        key: "collection",
        label: "Collection",
        kind: "select",
        value: filters.collection === "invoice" ? "invoice" : undefined,
        options: [
          { value: "", label: "Charge automatically" },
          { value: "invoice", label: "Email invoice (due in 7 days)" },
        ],
      },
    ],
    rows: candidates.slice(0, 25).map((p) => ({
      id: p.id,
      ref: { page: "subscriptions.new", filters: { ...carried, price: p.id } },
      cells: [
        avatarCell("subscription", p.nickname ?? p.id),
        p.id === targetPrice ? badgeCell("info", "Selected") : text(""),
        p.unit_amount != null ? money(ctx.stripe, p.unit_amount, p.currency) : text("—"),
        text(p.recurring ? `every ${p.recurring.interval_count ?? 1} ${p.recurring.interval}` : "—"),
        idCell(p.id, { copy: true }),
      ] as Cell[],
    })),
    empty: allowlist.length
      ? "No prices on the plan allowlist (/config → Billing)."
      : "No active recurring prices found.",
    notice: customerId
      ? "Click a price to preview the first invoice, then confirm below the preview."
      : "Set the Customer filter (cus_…) first, then pick a price.",
  });

  // MANDATORY preview: confirm exists ONLY after a successful first-invoice
  // preview for the exact customer+price(+qty/trial) combination.
  if (customerId && customer && !customer.deleted && targetPrice) {
    const preview = await ctx.stripe
      .previewNewSubscription({
        customerId,
        priceId: targetPrice,
        ...(quantity ? { quantity } : {}),
        ...(trialDays ? { trialEndUnix: Math.floor(Date.now() / 1000) + trialDays * 86400 } : {}),
      })
      .catch(() => null);
    if (!preview) {
      blocks.push({
        type: "notice",
        badge: { kind: "error", text: "PREVIEW FAILED" },
        text: "Stripe could not preview this subscription (currency mismatch with the customer?). Pick a different price.",
      });
    } else {
      const bits = [
        `${targetPrice}${quantity ? ` ×${quantity}` : ""}`,
        trialDays ? `${trialDays}-day trial` : null,
        promo ? `promo ${promo} (applied at creation — not in the preview)` : null,
        collection === "invoice" ? "collected by emailed invoice" : "charges the default payment method",
      ].filter(Boolean);
      blocks.push({
        type: "table",
        key: "preview",
        title: trialDays ? "First invoice after trial (preview)" : "First invoice (preview)",
        columns: [
          { key: "desc", label: "Description" },
          { key: "amount", label: "Amount", align: "right" },
        ],
        rows: preview.lines.data.slice(0, 15).map((line, i) => ({
          id: line.id ?? String(i),
          cells: [text(line.description ?? "line"), money(ctx.stripe, line.amount, line.currency)] as Cell[],
        })),
        notice: `First invoice would be ${ctx.stripe.formatAmount(preview.amount_due, preview.currency)}. Estimate — computed again at creation time.`,
      });
      blocks.push({
        type: "notice",
        badge: { kind: "info", text: "REVIEWED" },
        text: `Create a subscription for ${customerId}: ${bits.join(", ")}.`,
        actions: [
          registryButton(ctx, {
            key: "subscription.create",
            label: "Create subscription",
            style: "primary",
            dangerous: true,
            ...(collection === "charge" ? { stepUp: true } : {}),
            params: {
              customerId,
              priceId: targetPrice,
              ...(quantity ? { quantity } : {}),
              ...(promo ? { promoCode: promo } : {}),
              ...(trialDays ? { trialDays } : {}),
              collection,
            },
            summary: `Creates the subscription now — ${collection === "charge" ? "the default payment method is charged immediately (unless trialing)" : "an invoice is emailed, due in 7 days"}. You reviewed the preview above.`,
          }),
        ],
      });
    }
  }

  return {
    title: "Create subscription",
    crumbs: [{ label: "Subscriptions", ref: { page: "subscriptions" } }, { label: "New" }],
    blocks,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Subscriptions", ref: { page: "subscriptions" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Not available", hint }],
  };
}
