import type Stripe from "stripe";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, Badge, Block, Cell, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";
import { avatarCell, badgeCell, dateCell, idCell, money, paymentMethodCell, sentence, subBadge, text } from "./cells";

// Subscriptions: account-wide LIST archetype (status count-cards + price
// filter) and the DETAIL archetype (sub-stat strip + Pricing + Upcoming
// invoice + rail). Plan changes go through a MANDATORY proration-preview
// subpage — the confirm button only exists after a preview was rendered for
// the exact target price; there is no direct change-plan modal.

const WINDOW = 100;

export function makeSubscriptionsSection(): DashboardSectionModule {
  return {
    nav: [{ key: "subscriptions", label: "Subscriptions", page: "subscriptions" }],

    ownsPage(page: string): boolean {
      return page === "subscriptions" || page === "subscriptions.detail" || page === "subscriptions.changeplan";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "subscriptions") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      const id = validId("subscription", req.params?.id);
      if (!id) return notFound("That subscription id is not valid (sub_…).");
      if (req.page === "subscriptions.detail") return detail(ctx, id);
      if (req.page === "subscriptions.changeplan") return changePlan(ctx, id, req.filters ?? {});
      return null;
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
  const [subsRes, prices] = await Promise.all([
    ctx.stripe.listAllSubscriptions({
      status: "all",
      priceId: priceId || undefined,
      customerId: customerScope || undefined,
      limit: WINDOW,
      startingAfter: cursorId,
    }),
    ctx.stripe.listRecurringPrices(50).catch(() => [] as Stripe.Price[]),
  ]);
  const subs = subsRes.subscriptions;

  const counts = {
    key: "status",
    items: [
      { value: "", label: "All", count: subs.length },
      { value: "active", label: "Active", count: subs.filter((s) => s.status === "active").length },
      { value: "trialing", label: "Trialing", count: subs.filter((s) => s.status === "trialing").length },
      { value: "past_due", label: "Past due", count: subs.filter((s) => s.status === "past_due").length },
      { value: "paused", label: "Paused", count: subs.filter((s) => !!s.pause_collection).length },
      { value: "canceled", label: "Canceled", count: subs.filter((s) => s.status === "canceled").length },
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
        notice: `Counts cover the ${WINDOW} most recent subscriptions per page — use Next for older ones.`,
      },
    ],
  };
}

// ---- DETAIL ----

async function detail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const sub = await ctx.stripe.getSubscription(id).catch(() => null);
  if (!sub) return notFound("This subscription does not exist.");
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  const [upcoming, discordIds] = await Promise.all([
    customerId && sub.status !== "canceled"
      ? ctx.stripe.previewUpcomingInvoice(customerId, id)
      : Promise.resolve(null),
    customerId ? ctx.stores.session.findDiscordIdsByStripeId(customerId).catch(() => []) : Promise.resolve([]),
  ]);

  const plan = planLabel(sub);
  const item = sub.items.data[0];
  const cancelable = sub.status !== "canceled";

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
    title: plan.name,
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

  // Pricing table (all items).
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
        ] as Cell[],
      };
    }),
    ...(sub.status === "active" || sub.status === "trialing"
      ? { footer: "Change plan (proration preview)", footerRef: { page: "subscriptions.changeplan", params: { id } } }
      : {}),
  });

  // Upcoming-invoice preview.
  if (upcoming) {
    main.push({
      type: "table",
      key: "upcoming",
      title: "Upcoming invoice",
      columns: [
        { key: "desc", label: "Description" },
        { key: "amount", label: "Amount", align: "right" },
      ],
      rows: upcoming.lines.data.slice(0, 10).map((line, i) => ({
        id: line.id ?? String(i),
        cells: [text(line.description ?? "line"), money(ctx.stripe, line.amount, line.currency)] as Cell[],
      })),
      notice: `Total ${ctx.stripe.formatAmount(upcoming.amount_due, upcoming.currency)}${
        upcoming.next_payment_attempt
          ? ` — collects ${new Date(upcoming.next_payment_attempt * 1000).toISOString().slice(0, 10)}`
          : ""
      }. Preview — amounts can still change.`,
    });
  }

  // Rail: Details + Customer.
  const defaultPm = sub.default_payment_method;
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
      ...(defaultPm && typeof defaultPm === "object"
        ? [{ label: "Default payment method", cell: paymentMethodCell(defaultPm as Stripe.PaymentMethod) }]
        : defaultPm && typeof defaultPm === "string"
          ? [{ label: "Default payment method", cell: idCell(defaultPm, { copy: true }) }]
          : []),
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
              label: "Change plan",
              cell: { t: "link", v: "Open proration preview", ref: { page: "subscriptions.changeplan", params: { id } } } as Cell,
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
          { label: "ID", cell: idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } }) },
          { label: "Discord", cell: discordIds.length ? idCell(discordIds[0], { copy: true }) : text("not linked") },
        ]
      : [{ label: "Customer", cell: text("No customer attached.") }],
  });

  return {
    title: plan.name,
    crumbs: [{ label: "Subscriptions", ref: { page: "subscriptions" } }, { label: sub.id, copyId: sub.id }],
    blocks: main,
    rail,
  };
}

// ---- CHANGE PLAN (mandatory proration preview) ----

async function changePlan(ctx: DashboardCtx, id: string, filters: Record<string, string>): Promise<SectionPage> {
  const sub = await ctx.stripe.getSubscription(id).catch(() => null);
  if (!sub) return notFound("This subscription does not exist.");
  if (sub.status !== "active" && sub.status !== "trialing") {
    return notFound(`Subscription is ${sub.status} — plans can only change on active/trialing subscriptions.`);
  }
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  const item = sub.items.data[0];
  if (!customerId || !item) return notFound("Subscription has no customer/item to change.");

  const prices = await ctx.stripe.listRecurringPrices(50).catch(() => [] as Stripe.Price[]);
  const allowlist = ctx.settings.allowedPriceIds();
  const intervalRank: Record<string, number> = { day: 0, week: 1, month: 2, year: 3 };
  const candidates = prices
    .filter((p) => p.id !== item.price?.id && (allowlist.length === 0 || allowlist.includes(p.id)))
    .sort(
      (a, b) =>
        (intervalRank[a.recurring?.interval ?? ""] ?? 9) - (intervalRank[b.recurring?.interval ?? ""] ?? 9) ||
        (a.unit_amount ?? 0) - (b.unit_amount ?? 0)
    );

  const targetPrice = /^price_[A-Za-z0-9]{1,64}$/.test(filters.price ?? "") ? filters.price : "";
  const plan = planLabel(sub);
  // Row click = pick: each row navigates to this page with its price applied.
  const blocks: Block[] = [
    {
      type: "header",
      title: "Change plan",
      sub: `${plan.name} · ${sub.id}`,
    },
    {
      type: "table",
      key: "prices",
      title: "Pick the target price",
      columns: [
        { key: "name", label: "Price" },
        { key: "picked", label: "" },
        { key: "amount", label: "Amount", align: "right" },
        { key: "interval", label: "Billing" },
        { key: "id", label: "ID" },
      ],
      rows: candidates.slice(0, 25).map((p) => ({
        id: p.id,
        ref: { page: "subscriptions.changeplan", params: { id }, filters: { price: p.id } },
        cells: [
          avatarCell("subscription", p.nickname ?? p.id),
          p.id === targetPrice ? badgeCell("info", "Selected") : text(""),
          p.unit_amount != null ? money(ctx.stripe, p.unit_amount, p.currency) : text("—"),
          text(p.recurring ? `every ${p.recurring.interval_count ?? 1} ${p.recurring.interval}` : "—"),
          idCell(p.id, { copy: true }),
        ] as Cell[],
      })),
      empty: allowlist.length
        ? "No other prices on the plan allowlist (/config → Billing)."
        : "No other recurring prices found.",
      notice: "Click a price to preview the proration, then confirm below the preview.",
    },
  ];

  // MANDATORY preview: the confirm button exists ONLY once a target price was
  // chosen and its proration preview rendered.
  if (targetPrice) {
    const preview = await ctx.stripe
      .previewPlanChange({
        customerId,
        subscriptionId: id,
        itemId: item.id,
        priceId: targetPrice,
        prorationDate: Math.floor(Date.now() / 1000),
      })
      .catch(() => null);
    if (!preview) {
      blocks.push({
        type: "notice",
        badge: { kind: "error", text: "PREVIEW FAILED" },
        text: "Stripe could not preview this change (incompatible currency/interval?). Pick a different price.",
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
        notice: `Next invoice would be ${ctx.stripe.formatAmount(preview.amount_due, preview.currency)}. Estimate — the committed prorations are computed at execution time.`,
      });
      blocks.push({
        type: "notice",
        badge: { kind: "info", text: "REVIEWED" },
        text: `Move ${sub.id} to ${targetPrice} with prorations.`,
        actions: [
          registryButton(ctx, {
            key: "subscription.change_plan",
            label: "Change plan",
            style: "primary",
            dangerous: true,
            params: { subscriptionId: id, priceId: targetPrice },
            summary: `Swap the subscription item to ${targetPrice} with create_prorations — you reviewed the preview above.`,
          }),
        ],
      });
    }
  }

  return {
    title: "Change plan",
    crumbs: [
      { label: "Subscriptions", ref: { page: "subscriptions" } },
      { label: sub.id, ref: { page: "subscriptions.detail", params: { id } } },
      { label: "Change plan" },
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
