import type Stripe from "stripe";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, ActionResult, Badge, Block, Cell, FilterDef, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";
import { bookmarkButton, isBookmarkedSafe, toggleBookmarkAction } from "./bookmarks";
import {
  avatarCell,
  badgeCell,
  chipCount,
  dateCell,
  DATE_RANGE_OPTIONS,
  idCell,
  money,
  parseDateFilter,
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
        page === "subscriptions.new" ||
        page === "subscriptions.schedule"
      );
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "subscriptions") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      if (req.page === "subscriptions.new") return composer(ctx, req.filters ?? {});
      const id = validId("subscription", req.params?.id);
      if (!id) return notFound("That subscription id is not valid (sub_…).");
      if (req.page === "subscriptions.detail") return detail(ctx, id);
      if (req.page === "subscriptions.changeplan") return updatePage(ctx, id, req.filters ?? {});
      if (req.page === "subscriptions.schedule") return schedulePage(ctx, id, req.filters ?? {});
      return null;
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      // T0 — shared team bookmark toggle.
      if (req.key === "section:subscriptions.bookmark") {
        return toggleBookmarkAction(ctx, "subscription", req.params ?? {});
      }
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
  // Filter expansion (Stripe Subscriptions-filter parity): created is
  // a SERVER param + searchable; collection method slices the window.
  const createdRaw = str(filters.created, 24);
  const { createdGte, createdLt } = parseDateFilter(createdRaw);
  const collection =
    filters.collection === "charge_automatically" || filters.collection === "send_invoice" ? filters.collection : "";

  const cursorId = validId("subscription", validCursor(cursor) ?? "") ?? undefined;

  // Real chip totals via subscriptions.search (window counts cap at WINDOW).
  // Subscription search indexes created/metadata/status only — customer- or
  // price-scoped views, collection method and the Paused chip can't be
  // expressed, so those stay honest windowed counts ("N+" on overflow).
  const scoped = Boolean(customerScope || priceId || collection);
  const scopeParts: string[] = [];
  if (createdGte) scopeParts.push(`created>=${createdGte}`);
  if (createdLt) scopeParts.push(`created<${createdLt}`);
  const searchQ = (extra?: string) => [...scopeParts, ...(extra ? [extra] : [])].join(" AND ") || "created>0";
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
      createdGte,
      createdLt,
    }),
    ctx.stripe.listRecurringPrices(50).catch(() => [] as Stripe.Price[]),
    Promise.all([countSearch(searchQ()), ...SUB_STATUSES.map((s) => countSearch(searchQ(`status:"${s}"`)))]),
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
    if (collection && s.collection_method !== collection) return false;
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
          {
            key: "created",
            label: "Created",
            kind: "daterange",
            value: createdRaw && (createdGte || createdLt) ? createdRaw : undefined,
            options: DATE_RANGE_OPTIONS,
          },
          {
            key: "collection",
            label: "Collection method",
            kind: "select",
            value: collection || undefined,
            options: [
              { value: "charge_automatically", label: "Charge automatically" },
              { value: "send_invoice", label: "Send invoice" },
            ],
          },
        ],
        rows,
        nextCursor: subsRes.hasMore && subs.length > 0 ? subs[subs.length - 1].id : null,
        empty: status || collection ? "No subscriptions match this filter (within this window)." : "No subscriptions yet.",
        ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
        notice: scoped
          ? `Customer/price/collection filters aren't searchable — chip counts cover this window only ("N+" on overflow).`
          : `Chip counts are account totals (Paused counts this page's window); the table shows ${WINDOW} per page — use Next for older ones.`,
      },
    ],
  };
}

// ---- DETAIL ----

async function detail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const sub = await ctx.stripe.getSubscription(id).catch(() => null);
  if (!sub) return notFound("This subscription does not exist.");
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
  const [upcoming, discordIds, customer, schedule, bookmarked] = await Promise.all([
    customerId && sub.status !== "canceled"
      ? ctx.stripe.previewUpcomingInvoice(customerId, id)
      : Promise.resolve(null),
    customerId ? ctx.stores.session.findDiscordIdsByStripeId(customerId).catch(() => []) : Promise.resolve([]),
    customerId
      ? Promise.resolve()
          .then(() => ctx.stripe.getCustomer(customerId))
          .catch(() => null)
      : Promise.resolve(null),
    scheduleId
      ? Promise.resolve()
          .then(() => ctx.stripe.getSubscriptionSchedule(scheduleId))
          .catch(() => null)
      : Promise.resolve(null),
    isBookmarkedSafe(ctx, "subscription", id),
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
    if (sub.discounts?.length) {
      actions.push(
        registryButton(ctx, {
          key: "customer.coupon",
          label: "Remove discount",
          dangerous: true, // T1 param-aware (needsConfirmExtra) server-side
          params: { subscriptionId: id, op: "remove" },
          summary:
            "Removes the discount from this subscription — the next invoice bills full price. A customer-level discount (if any) is untouched.",
        })
      );
    }
    if (sub.status === "trialing") {
      actions.push(
        registryButton(ctx, {
          key: "subscription.terms",
          label: "End trial now",
          style: "danger",
          dangerous: true,
          stepUp: true,
          params: { subscriptionId: id, endTrialNow: true },
          summary: "Ends the trial IMMEDIATELY — the first invoice is generated and charged now. Requires a fresh factor.",
        })
      );
    }
    if (sub.status === "active" || sub.status === "trialing") {
      actions.push({
        key: "nav:subscriptions.schedule",
        label: schedule ? "Edit schedule" : "Schedule changes",
        ref: { page: "subscriptions.schedule", params: { id } },
      });
    }
  }

  const main: Block[] = [];
  const rail: Block[] = [];

  actions.push(bookmarkButton("section:subscriptions.bookmark", bookmarked, sub.id, title));
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

  // Schedule phases panel: the live phase timeline when a schedule is
  // attached; edits happen on the schedule editor page.
  if (schedule) {
    main.push(schedulePhasesTable(ctx, schedule, { footerRef: { page: "subscriptions.schedule", params: { id } } }));
  }

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
      ...(sub.discounts?.length
        ? [
            {
              label: sub.discounts.length === 1 ? "Discount" : "Discounts",
              // Basil: entries are string | Discount; the coupon moved under
              // discount.source.coupon (string | Coupon | null).
              cell: text(
                sub.discounts
                  .map((d) => {
                    if (typeof d === "string") return d;
                    const coupon = d.source?.coupon;
                    return typeof coupon === "string" ? coupon : coupon?.name ?? coupon?.id ?? d.id;
                  })
                  .join(", ")
              ),
            },
          ]
        : []),
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

  // The page has three operations — change the selected item's price
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

// ---- ADD ITEM (grow a subscription, mandatory proration preview) ----

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

// ---- REMOVE ITEM (shrink a subscription, mandatory proration preview) ----

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

// ---- SCHEDULE EDITOR (`subscriptions.schedule`) ----
// Composer idiom: composed future phases live in the `phases` URL filter as
// tokens `price_<id>*<qty>*<count><d|w|m|y>[*t][*pn]` (t = whole-phase trial,
// pn = proration none). Confirm bakes the SERVER-parsed phases into the
// registry `subscription.schedule` action — the client adds nothing. On
// confirm the composed phases REPLACE every scheduled future phase (the live
// ones render read-only above; response phases carry no reconstructible
// duration, so there is no lossy token pre-seeding).

const SCHEDULE_MAX = 5;
const UNIT_MAP: Record<string, "day" | "week" | "month" | "year"> = { d: "day", w: "week", m: "month", y: "year" };

interface PhaseToken {
  token: string;
  priceId: string;
  quantity: number;
  durationCount: number;
  durationUnit: "day" | "week" | "month" | "year";
  trial: boolean;
  prorationNone: boolean;
}

function parsePhaseTokens(raw: string): { phases: PhaseToken[]; dropped: number } {
  const phases: PhaseToken[] = [];
  let dropped = 0;
  for (const token of raw.split(",").filter(Boolean).slice(0, SCHEDULE_MAX)) {
    const parts = token.split("*");
    const m = /^(\d{1,2})([dwmy])$/.exec(parts[2] ?? "");
    const quantity = Number.parseInt(parts[1] ?? "", 10);
    const flags = parts.slice(3);
    if (
      !PRICE_RE.test(parts[0] ?? "") ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 999 ||
      !m ||
      Number.parseInt(m[1], 10) < 1 ||
      Number.parseInt(m[1], 10) > 36 ||
      flags.some((f) => f !== "t" && f !== "pn")
    ) {
      dropped++;
      continue;
    }
    phases.push({
      token,
      priceId: parts[0],
      quantity,
      durationCount: Number.parseInt(m[1], 10),
      durationUnit: UNIT_MAP[m[2]],
      trial: flags.includes("t"),
      prorationNone: flags.includes("pn"),
    });
  }
  return { phases, dropped };
}

function scheduleBadge(status: Stripe.SubscriptionSchedule.Status): Badge {
  const kind: Badge["kind"] =
    status === "active" ? "ok" : status === "not_started" ? "info" : status === "canceled" ? "error" : "neutral";
  return { kind, text: sentence(status.replace(/_/g, " ")) };
}

// Live phases table shared by the sub detail and the editor page.
function schedulePhasesTable(
  ctx: DashboardCtx,
  schedule: Stripe.SubscriptionSchedule,
  opts: { footerRef?: { page: string; params: Record<string, string> } } = {}
): Block {
  const now = Math.floor(Date.now() / 1000);
  const currentStart = schedule.current_phase?.start_date ?? null;
  return {
    type: "table",
    key: "schedulephases",
    title: "Schedule phases",
    columns: [
      { key: "phase", label: "Phase" },
      { key: "items", label: "Items" },
      { key: "start", label: "Starts" },
      { key: "end", label: "Ends" },
      { key: "flags", label: "" },
    ],
    rows: schedule.phases.map((phase, i) => {
      const labels = phase.items
        .slice(0, 2)
        .map((it) => {
          const price = it.price;
          const name =
            typeof price === "string" ? price : ("nickname" in price ? price.nickname : null) ?? price.id;
          return it.quantity && it.quantity > 1 ? `${name} ×${it.quantity}` : name;
        })
        .join(", ");
      const extra = phase.items.length > 2 ? ` +${phase.items.length - 2}` : "";
      const flags: Badge[] = [];
      if (currentStart != null && phase.start_date === currentStart) flags.push({ kind: "ok", text: "Current" });
      else if (phase.start_date > now) flags.push({ kind: "info", text: "Scheduled" });
      if (phase.trial_end && phase.trial_end > phase.start_date) flags.push({ kind: "neutral", text: "Trial" });
      return {
        id: String(i),
        cells: [
          strong(`Phase ${i + 1}`),
          text(labels + extra),
          dateCell(phase.start_date),
          dateCell(phase.end_date),
          { t: "flags", badges: flags } as Cell,
        ] as Cell[],
      };
    }),
    empty: "No phases.",
    notice: `After the last phase the subscription ${schedule.end_behavior === "cancel" ? "CANCELS" : "continues on that phase's terms"}.`,
    ...(opts.footerRef ? { footer: "Edit schedule", footerRef: opts.footerRef } : {}),
  };
}

async function schedulePage(ctx: DashboardCtx, id: string, filters: Record<string, string>): Promise<SectionPage> {
  const sub = await ctx.stripe.getSubscription(id).catch(() => null);
  if (!sub) return notFound("This subscription does not exist.");
  const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null;
  const [schedule, prices] = await Promise.all([
    scheduleId
      ? Promise.resolve()
          .then(() => ctx.stripe.getSubscriptionSchedule(scheduleId))
          .catch(() => null)
      : Promise.resolve(null),
    ctx.stripe.listRecurringPrices(50).catch(() => [] as Stripe.Price[]),
  ]);
  const allowlist = ctx.settings.allowedPriceIds();
  const candidates = sortPrices(prices.filter((p) => allowlist.length === 0 || allowlist.includes(p.id)));

  const phasesRaw = str(filters.phases, 1000);
  const { phases, dropped } = parsePhaseTokens(phasesRaw);
  const endBehavior = filters.end === "cancel" ? "cancel" : "release";
  const qtyRaw = str(filters.qty, 3).trim();
  const addQty = /^\d{1,3}$/.test(qtyRaw) && Number.parseInt(qtyRaw, 10) >= 1 ? Math.min(Number.parseInt(qtyRaw, 10), 999) : 1;
  const durRaw = str(filters.dur, 4).trim();
  const addDur = /^\d{1,2}[dwmy]$/.test(durRaw) ? durRaw : "1m";
  const addTrial = filters.trial === "1";

  const editable = sub.status === "active" || sub.status === "trialing";
  const scheduleActive = schedule && (schedule.status === "active" || schedule.status === "not_started");

  const baseFilters = (over: Record<string, string | null>): Record<string, string> => {
    const merged: Record<string, string | null> = {
      phases: phasesRaw || null,
      end: endBehavior === "cancel" ? "cancel" : null,
      qty: qtyRaw || null,
      dur: durRaw || null,
      trial: addTrial ? "1" : null,
      ...over,
    };
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) if (v) f[k] = v;
    return f;
  };

  const priceById = new Map(prices.map((p) => [p.id, p]));
  const plan = planLabel(sub);

  const blocks: Block[] = [
    {
      type: "header",
      title: "Subscription schedule",
      sub: plan.name,
      badges: schedule ? [scheduleBadge(schedule.status)] : [],
      actions: scheduleActive
        ? [
            registryButton(ctx, {
              key: "subscription.schedule",
              label: "Release schedule",
              dangerous: true,
              params: { subscriptionId: id, op: "release" },
              summary: "Removes the schedule — the subscription continues on its CURRENT terms; future phases are discarded.",
            }),
            registryButton(ctx, {
              key: "subscription.schedule",
              label: "Cancel schedule",
              style: "danger",
              dangerous: true,
              stepUp: true,
              params: { subscriptionId: id, op: "cancel" },
              summary: "Cancels the schedule AND the subscription IMMEDIATELY. This is a subscription cancellation. Requires a fresh factor.",
            }),
          ]
        : [],
    },
  ];

  if (!editable) {
    blocks.push({
      type: "notice",
      badge: { kind: "warn", text: sentence(sub.status) },
      text: "Only active or trialing subscriptions can be scheduled.",
    });
  }

  // The live schedule (read-only) — composed phases below REPLACE its future.
  if (schedule) {
    blocks.push(schedulePhasesTable(ctx, schedule));
    if (phases.length > 0) {
      blocks.push({
        type: "notice",
        badge: { kind: "warn", text: "Replaces" },
        text: "Confirming below REPLACES every scheduled future phase with the composed phases.",
      });
    }
  } else {
    // Locked current-terms card: future phases start at the current period end.
    const item = sub.items.data[0];
    blocks.push({
      type: "kv",
      title: "Current phase (locked)",
      rows: [
        { label: "Items", cell: text(sub.items.data.map((it) => `${planLabel(sub).name}${(it.quantity ?? 1) > 1 ? ` ×${it.quantity}` : ""}`).join(", ")) },
        ...(item?.current_period_end
          ? [{ label: "Current period ends", cell: dateCell(item.current_period_end) }]
          : []),
      ],
      actions: [],
    });
  }

  // Composed future phases.
  blocks.push({
    type: "table",
    key: "composed",
    title: "Composed future phases",
    columns: [
      { key: "phase", label: "Phase" },
      { key: "price", label: "Price" },
      { key: "qty", label: "Qty", align: "right" },
      { key: "dur", label: "Duration" },
      { key: "flags", label: "" },
    ],
    rows: phases.map((ph, i) => {
      const price = priceById.get(ph.priceId);
      const flags: Badge[] = [];
      if (ph.trial) flags.push({ kind: "neutral", text: "Trial" });
      if (ph.prorationNone) flags.push({ kind: "info", text: "No proration" });
      const reordered = (swap: number) => {
        const next = phases.map((x) => x.token);
        [next[i], next[swap]] = [next[swap], next[i]];
        return next.join(",");
      };
      return {
        id: ph.token + i,
        cells: [
          strong(`Phase ${i + 1}`),
          text(price?.nickname ?? ph.priceId, price?.unit_amount != null ? `${ctx.stripe.formatAmount(price.unit_amount * ph.quantity, price.currency)}/${price.recurring?.interval}` : undefined),
          text(String(ph.quantity)),
          text(`${ph.durationCount} ${ph.durationUnit}${ph.durationCount > 1 ? "s" : ""}`),
          { t: "flags", badges: flags } as Cell,
        ] as Cell[],
        actions: [
          ...(i > 0
            ? [{ key: "nav:sched.up", label: "Up", ref: { page: "subscriptions.schedule", params: { id }, filters: baseFilters({ phases: reordered(i - 1) }) } }]
            : []),
          ...(i < phases.length - 1
            ? [{ key: "nav:sched.down", label: "Down", ref: { page: "subscriptions.schedule", params: { id }, filters: baseFilters({ phases: reordered(i + 1) }) } }]
            : []),
          {
            key: "nav:sched.remove",
            label: "Remove",
            ref: {
              page: "subscriptions.schedule",
              params: { id },
              filters: baseFilters({ phases: phases.filter((x) => x !== ph).map((x) => x.token).join(",") || null }),
            },
          },
        ],
      };
    }),
    empty: "No composed phases yet — add prices from the picker below.",
    ...(dropped ? { notice: `${dropped} invalid phase token(s) were dropped.` } : {}),
  });

  // Approximate timeline preview (Stripe computes the exact boundaries).
  if (phases.length > 0) {
    const item = sub.items.data[0];
    let cursor = (schedule?.current_phase?.end_date ?? item?.current_period_end ?? Math.floor(Date.now() / 1000)) * 1000;
    const timeline: Array<{ label: string; iso: string; text?: string; kind?: Badge["kind"] }> = [];
    const UNIT_MS: Record<string, number> = { day: 86400_000, week: 7 * 86400_000, month: 30 * 86400_000, year: 365 * 86400_000 };
    for (const [i, ph] of phases.entries()) {
      const price = priceById.get(ph.priceId);
      timeline.push({
        label: `Phase ${i + 1} starts — ${price?.nickname ?? ph.priceId}${ph.trial ? " (trial)" : ""}`,
        iso: new Date(cursor).toISOString(),
        kind: "info",
      });
      cursor += ph.durationCount * UNIT_MS[ph.durationUnit];
    }
    timeline.push({
      label: endBehavior === "cancel" ? "Subscription CANCELS" : "Continues on the last phase's terms",
      iso: new Date(cursor).toISOString(),
      kind: endBehavior === "cancel" ? "error" : "ok",
    });
    blocks.push({ type: "timeline", title: "Timeline (approximate)", items: timeline });
  }

  // Confirm card — params are the SERVER's parse of the tokens.
  if (editable && phases.length > 0) {
    blocks.push({
      type: "kv",
      title: "Confirm",
      rows: [
        { label: "Phases", cell: text(String(phases.length)) },
        {
          label: "After the last phase",
          cell: text(endBehavior === "cancel" ? "Subscription CANCELS" : "Continues on the last phase's terms"),
        },
      ],
      actions: [
        registryButton(ctx, {
          key: "subscription.schedule",
          label: schedule ? "Replace scheduled phases" : "Create schedule",
          style: "primary",
          dangerous: true,
          params: {
            subscriptionId: id,
            op: "set_phases",
            endBehavior,
            phases: phases.map((ph) => ({
              priceId: ph.priceId,
              quantity: ph.quantity,
              durationCount: ph.durationCount,
              durationUnit: ph.durationUnit,
              ...(ph.trial ? { trial: true } : {}),
              proration: ph.prorationNone ? "none" : "create_prorations",
            })),
          },
          summary: `Applies ${phases.length} future phase(s) after the current one${
            endBehavior === "cancel" ? ", then CANCELS the subscription" : ""
          }. The current phase is preserved exactly as-is.`,
        }),
      ],
    });
  }

  // Price picker (single-item phases: multi-item edits live in Update via
  // subscription.items — a nested token grammar isn't legible in filter pills).
  blocks.push({
    type: "table",
    key: "schedpicker",
    title: "Add a phase",
    columns: [
      { key: "name", label: "Price" },
      { key: "amount", label: "Amount", align: "right" },
      { key: "interval", label: "Billing" },
    ],
    filters: [
      { key: "qty", label: "Qty", kind: "text", value: qtyRaw || undefined, placeholder: "1" },
      {
        key: "dur",
        label: "Duration",
        kind: "select",
        value: durRaw || undefined,
        options: [
          { value: "1m", label: "1 month" },
          { value: "3m", label: "3 months" },
          { value: "6m", label: "6 months" },
          { value: "12m", label: "12 months" },
          { value: "1y", label: "1 year" },
        ],
      },
      {
        key: "trial",
        label: "Trial",
        kind: "select",
        value: addTrial ? "1" : undefined,
        options: [{ value: "1", label: "Whole phase is a free trial" }],
      },
      {
        key: "end",
        label: "End behavior",
        kind: "select",
        value: endBehavior === "cancel" ? "cancel" : undefined,
        options: [
          { value: "", label: "Release — continue on last phase" },
          { value: "cancel", label: "Cancel the subscription" },
        ],
      },
    ],
    rows: candidates.slice(0, 25).map((p) => ({
      id: p.id,
      cells: [
        strong(p.nickname ?? p.id, p.id),
        p.unit_amount != null ? money(ctx.stripe, p.unit_amount, p.currency) : text("—"),
        text(p.recurring ? `every ${p.recurring.interval_count ?? 1} ${p.recurring.interval}` : "—"),
      ] as Cell[],
      actions:
        phases.length >= SCHEDULE_MAX || !editable
          ? []
          : [
              {
                key: "nav:sched.add",
                label: "Add phase",
                ref: {
                  page: "subscriptions.schedule",
                  params: { id },
                  filters: baseFilters({
                    phases: [phasesRaw, `${p.id}*${addQty}*${addDur}${addTrial ? "*t" : ""}`].filter(Boolean).join(","),
                  }),
                },
              },
            ],
    })),
    empty: "No recurring prices available (check the plan allowlist).",
    notice:
      phases.length >= SCHEDULE_MAX
        ? `Phase cap reached (${SCHEDULE_MAX}).`
        : "One price per phase — multi-item changes live in Update subscription. Qty/Duration/Trial apply to the next Add.",
  });

  return {
    title: "Subscription schedule",
    crumbs: [
      { label: "Subscriptions", ref: { page: "subscriptions" } },
      { label: id, ref: { page: "subscriptions.detail", params: { id } } },
      { label: "Schedule" },
    ],
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
