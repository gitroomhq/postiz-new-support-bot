import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import {
  buildPostizMetadata,
  derivePostizPlan,
  isGitroomSub,
  POSTIZ_TIERS,
  postizSyncStatus,
  postizUniqueId,
  readPostizMeta,
} from "../../bot/billing/postizPlan";
import { rebuildCurrentPhase } from "../../bot/StripeClient";
import { actionByKey, ActionExecCtx } from "../../bot/billing/actions/ActionRegistry";
import { DashboardCtx } from "../sections/types";
import { makeSubscriptionsSection } from "../sections/subscriptionsSection";
import type { Block, KeyValueBlock, NoticeBlock, TableBlock } from "../renderer/contract";

// ---- fixtures ----

function usdPrice(id: string, amount: number, interval: "month" | "year"): Stripe.Price {
  return {
    id,
    currency: "usd",
    unit_amount: amount,
    active: true,
    nickname: id,
    recurring: { interval, interval_count: 1 },
  } as unknown as Stripe.Price;
}

const PRICE_STD_M = usdPrice("price_stdm", 2900, "month");
const PRICE_PRO_M = usdPrice("price_prom", 4900, "month");
const PRICE_CUSTOM = usdPrice("price_custom", 3500, "month");

function gitroomMeta(tier = "STANDARD", period = "MONTHLY", uniqueId = "AbCd123456"): Record<string, string> {
  return { service: "gitroom", billing: tier, period, uniqueId };
}

function fakeSub(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_a",
    created: 1_700_000_000,
    cancel_at: null,
    cancel_at_period_end: false,
    pause_collection: null,
    trial_end: null,
    collection_method: "charge_automatically",
    default_payment_method: null,
    test_clock: null,
    discounts: [],
    latest_invoice: "in_9",
    metadata: {},
    schedule: null,
    items: {
      data: [{ id: "si_1", quantity: 1, current_period_end: 1_700_900_000, price: PRICE_STD_M }],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

// ---- pure module ----

test("postizPlan: all 8 canonical USD amount/interval pairs derive their tier", () => {
  for (const [tier, amounts] of Object.entries(POSTIZ_TIERS)) {
    assert.deepEqual(derivePostizPlan(usdPrice("price_m", amounts.month, "month")), { tier, period: "MONTHLY" });
    assert.deepEqual(derivePostizPlan(usdPrice("price_y", amounts.year, "year")), { tier, period: "YEARLY" });
  }
});

test("postizPlan: near-miss amounts, non-USD, bundled intervals and one-time prices derive nothing", () => {
  assert.equal(derivePostizPlan(usdPrice("p", 3500, "month")), null); // custom amount
  assert.equal(derivePostizPlan(usdPrice("p", 2901, "month")), null); // off by one
  assert.equal(derivePostizPlan(usdPrice("p", 2900, "year")), null); // right amount, wrong interval
  assert.equal(derivePostizPlan({ ...usdPrice("p", 2900, "month"), currency: "eur" } as Stripe.Price), null);
  const bundled = usdPrice("p", 2900, "month");
  (bundled.recurring as Stripe.Price.Recurring).interval_count = 3;
  assert.equal(derivePostizPlan(bundled), null);
  assert.equal(derivePostizPlan({ id: "p", currency: "usd", unit_amount: 2900, recurring: null } as unknown as Stripe.Price), null);
  assert.equal(derivePostizPlan({ ...usdPrice("p", 2900, "month"), unit_amount: null } as unknown as Stripe.Price), null);
});

test("postizPlan: uniqueId is 10 alphanumeric chars, deterministic per seed", () => {
  const a = postizUniqueId("scope-1");
  assert.match(a, /^[0-9A-Za-z]{10}$/);
  assert.equal(a, postizUniqueId("scope-1")); // retries produce identical params
  assert.notEqual(a, postizUniqueId("scope-2"));
});

test("postizPlan: buildPostizMetadata emits exactly the four contract keys", () => {
  const meta = buildPostizMetadata({ tier: "PRO", period: "YEARLY" }, "AbCd123456");
  assert.deepEqual(meta, { service: "gitroom", billing: "PRO", period: "YEARLY", uniqueId: "AbCd123456" });
});

test("postizPlan: sync status is missing / mismatch / synced", () => {
  assert.equal(postizSyncStatus(fakeSub()), "missing"); // no metadata at all
  assert.equal(postizSyncStatus(fakeSub({ metadata: gitroomMeta() })), "synced");
  // Tier recorded ≠ what the price charges.
  assert.equal(postizSyncStatus(fakeSub({ metadata: gitroomMeta("PRO") })), "mismatch");
  // gitroom but the price itself is non-canonical.
  const custom = fakeSub({ metadata: gitroomMeta(), items: { data: [{ id: "si_1", quantity: 1, price: PRICE_CUSTOM }] } });
  assert.equal(postizSyncStatus(custom), "mismatch");
  // Missing uniqueId is not fully synced either.
  const noUid = gitroomMeta();
  delete (noUid as Record<string, unknown>).uniqueId;
  assert.equal(postizSyncStatus(fakeSub({ metadata: noUid })), "mismatch");
  assert.equal(isGitroomSub(fakeSub({ metadata: gitroomMeta() })), true);
  assert.equal(readPostizMeta(gitroomMeta()).billing, "STANDARD");
});

test("rebuildCurrentPhase carries the current phase's metadata through instead of dropping it", () => {
  const schedule = {
    phases: [
      {
        items: [{ price: "price_stdm", quantity: 1, discounts: [] }],
        start_date: 1,
        end_date: 2,
        discounts: [],
        metadata: gitroomMeta(),
        trial_end: null,
        default_payment_method: null,
      },
    ],
  } as unknown as Stripe.SubscriptionSchedule;
  const { phase, unsupported } = rebuildCurrentPhase(schedule);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(phase.metadata, gitroomMeta());
});

// ---- registry: subscription.create ----

function createCtx(overrides: Record<string, unknown> = {}): {
  ctx: ActionExecCtx;
  created: Array<Record<string, unknown>>;
} {
  const created: Array<Record<string, unknown>> = [];
  const ctx = {
    stripe: {
      getCustomer: async () => ({ id: "cus_a", invoice_settings: { default_payment_method: "pm_1" } }),
      getPrice: async () => PRICE_PRO_M,
      findPromotionCodes: async () => [],
      createSubscription: async (params: Record<string, unknown>) => {
        created.push(params);
        return { id: "sub_new", status: "active" };
      },
      ...((overrides.stripe as Record<string, unknown>) ?? {}),
    },
    settingsStore: { allowedPriceIds: () => [] },
    stripeCustomerId: "cus_a",
    idemScope: "scope-xyz",
    ...overrides,
  } as unknown as ActionExecCtx;
  return { ctx, created };
}

test("subscription.create: sync is the default, attaches the full 4-key metadata; No sync attaches none", async () => {
  const def = actionByKey("subscription.create")!;
  const parsed = def.parseParams({ customerId: "cus_a", priceId: "price_prom", collection: "invoice" });
  assert.ok(parsed.ok);
  assert.equal((parsed as { params: { postizSync: boolean } }).params.postizSync, true);
  const { ctx, created } = createCtx();
  assert.equal(await def.revalidate(ctx, (parsed as { params: unknown }).params), null);
  const res = await def.execute(ctx, (parsed as { params: unknown }).params);
  assert.ok(res.ok);
  assert.ok(res.ok && res.text.includes("Postiz sync PRO/MONTHLY"));
  assert.deepEqual(created[0].metadata, {
    service: "gitroom",
    billing: "PRO",
    period: "MONTHLY",
    uniqueId: postizUniqueId("scope-xyz"),
  });

  const off = def.parseParams({ customerId: "cus_a", priceId: "price_prom", collection: "invoice", postizSync: false });
  assert.ok(off.ok);
  const offRun = createCtx();
  const offRes = await def.execute(offRun.ctx, (off as { params: unknown }).params);
  assert.ok(offRes.ok);
  assert.equal(offRun.created[0].metadata, undefined);
});

test("subscription.create: non-canonical price is refused when syncing, allowed with No sync", async () => {
  const def = actionByKey("subscription.create")!;
  const parsed = def.parseParams({ customerId: "cus_a", priceId: "price_custom", collection: "invoice" });
  assert.ok(parsed.ok);
  const { ctx } = createCtx();
  (ctx.stripe as unknown as Record<string, unknown>).getPrice = async () => PRICE_CUSTOM;
  assert.match((await def.revalidate(ctx, (parsed as { params: unknown }).params)) ?? "", /not a canonical Postiz price/);
  const off = def.parseParams({ customerId: "cus_a", priceId: "price_custom", collection: "invoice", postizSync: false });
  assert.equal(await def.revalidate(ctx, (off as { ok: true; params: unknown }).params), null);
});

// ---- registry: subscription.change_plan ----

test("subscription.change_plan: gitroom sub gets recomputed billing/period in the same call, uniqueId preserved", async () => {
  const def = actionByKey("subscription.change_plan")!;
  const sub = fakeSub({ metadata: gitroomMeta("STANDARD", "MONTHLY", "KeepMe0000") });
  const changed: Array<Record<string, unknown>> = [];
  const ctx = {
    stripe: {
      getSubscription: async () => sub,
      getPrice: async () => PRICE_PRO_M,
      findPromotionCodes: async () => [],
      changeSubscriptionPlan: async (params: Record<string, unknown>) => {
        changed.push(params);
        return sub;
      },
    },
    settingsStore: { allowedPriceIds: () => [] },
    stripeCustomerId: "cus_a",
    idemScope: "scope-cp",
  } as unknown as ActionExecCtx;
  const parsed = def.parseParams({ subscriptionId: "sub_1", priceId: "price_prom" });
  assert.ok(parsed.ok);
  assert.equal(await def.revalidate(ctx, (parsed as { params: unknown }).params), null);
  const res = await def.execute(ctx, (parsed as { params: unknown }).params);
  assert.ok(res.ok);
  assert.deepEqual(changed[0].metadata, {
    service: "gitroom",
    billing: "PRO",
    period: "MONTHLY",
    uniqueId: "KeepMe0000",
  });
});

test("subscription.change_plan: gitroom sub cannot MOVE to a non-canonical price; non-gitroom subs pass no metadata", async () => {
  const def = actionByKey("subscription.change_plan")!;
  const gitroomSub = fakeSub({ metadata: gitroomMeta() });
  const mkCtx = (sub: Stripe.Subscription, price: Stripe.Price, changed: Array<Record<string, unknown>>) =>
    ({
      stripe: {
        getSubscription: async () => sub,
        getPrice: async () => price,
        findPromotionCodes: async () => [],
        changeSubscriptionPlan: async (params: Record<string, unknown>) => {
          changed.push(params);
          return sub;
        },
      },
      settingsStore: { allowedPriceIds: () => [] },
      stripeCustomerId: "cus_a",
      idemScope: "scope-cp2",
    }) as unknown as ActionExecCtx;
  const parsed = def.parseParams({ subscriptionId: "sub_1", priceId: "price_custom" });
  assert.ok(parsed.ok);
  assert.match(
    (await def.revalidate(mkCtx(gitroomSub, PRICE_CUSTOM, []), (parsed as { params: unknown }).params)) ?? "",
    /canonical Postiz price/
  );
  // A plain (non-gitroom) sub can move anywhere and no metadata rides along.
  const plainSub = fakeSub();
  const changed: Array<Record<string, unknown>> = [];
  const ctx = mkCtx(plainSub, PRICE_CUSTOM, changed);
  assert.equal(await def.revalidate(ctx, (parsed as { params: unknown }).params), null);
  await def.execute(ctx, (parsed as { params: unknown }).params);
  assert.equal(changed[0].metadata, undefined);
});

// ---- registry: subscription.repair_sync ----

test("subscription.repair_sync: refuses already-synced/canceled/non-canonical, stamps the contract otherwise", async () => {
  const def = actionByKey("subscription.repair_sync")!;
  assert.equal(def.parseParams({ subscriptionId: "nope" }).ok, false);
  const parsed = def.parseParams({ subscriptionId: "sub_1" });
  assert.ok(parsed.ok);
  const updates: Array<[string, Record<string, string>]> = [];
  const mkCtx = (sub: Stripe.Subscription) =>
    ({
      stripe: {
        getSubscription: async () => sub,
        updateSubscriptionMetadata: async (id: string, metadata: Record<string, string>) => {
          updates.push([id, metadata]);
          return sub;
        },
      },
      stripeCustomerId: "cus_a",
      idemScope: "scope-fix",
    }) as unknown as ActionExecCtx;
  const params = (parsed as { params: unknown }).params;
  assert.match((await def.revalidate(mkCtx(fakeSub({ metadata: gitroomMeta() })), params)) ?? "", /already carries/);
  assert.match((await def.revalidate(mkCtx(fakeSub({ status: "canceled" })), params)) ?? "", /already canceled/);
  const customPrice = fakeSub({ items: { data: [{ id: "si_1", quantity: 1, price: PRICE_CUSTOM }] } });
  assert.match((await def.revalidate(mkCtx(customPrice), params)) ?? "", /cannot be derived|not a canonical/);
  assert.match((await def.revalidate(mkCtx(fakeSub({ customer: "cus_OTHER" })), params)) ?? "", /does not belong/);
  // Repairable: missing metadata, canonical price → full contract stamped.
  const missing = fakeSub();
  assert.equal(await def.revalidate(mkCtx(missing), params), null);
  const res = await def.execute(mkCtx(missing), params);
  assert.ok(res.ok);
  assert.deepEqual(updates[0][1], {
    service: "gitroom",
    billing: "STANDARD",
    period: "MONTHLY",
    uniqueId: postizUniqueId("scope-fix"),
  });
  // Mismatch repair preserves an existing uniqueId.
  const mismatch = fakeSub({ metadata: gitroomMeta("PRO", "MONTHLY", "KeepMe0000") });
  await def.execute(mkCtx(mismatch), params);
  assert.equal(updates[1][1].uniqueId, "KeepMe0000");
  assert.equal(updates[1][1].billing, "STANDARD");
});

// ---- registry: subscription.schedule ----

test("subscription.schedule set_phases: gitroom phases carry per-phase tier metadata; non-canonical phases refused", async () => {
  const def = actionByKey("subscription.schedule")!;
  const sub = fakeSub({ metadata: gitroomMeta("STANDARD", "MONTHLY", "KeepMe0000"), schedule: "sched_1" });
  const scheduleObj = {
    id: "sched_1",
    status: "active",
    phases: [
      {
        items: [{ price: "price_stdm", quantity: 1, discounts: [] }],
        start_date: 1,
        end_date: 2,
        discounts: [],
        metadata: gitroomMeta("STANDARD", "MONTHLY", "KeepMe0000"),
        trial_end: null,
        default_payment_method: null,
      },
    ],
  };
  const updated: Array<Record<string, unknown>> = [];
  const prices: Record<string, Stripe.Price> = { price_prom: PRICE_PRO_M, price_custom: PRICE_CUSTOM };
  const ctx = {
    stripe: {
      getSubscription: async () => sub,
      getSubscriptionSchedule: async () => scheduleObj,
      getPrice: async (id: string) => prices[id],
      updateSchedulePhases: async (_id: string, params: Record<string, unknown>) => {
        updated.push(params);
        return scheduleObj;
      },
    },
    settingsStore: { allowedPriceIds: () => [] },
    stripeCustomerId: "cus_a",
    idemScope: "scope-sched",
  } as unknown as ActionExecCtx;
  const good = def.parseParams({
    subscriptionId: "sub_1",
    op: "set_phases",
    phases: [{ priceId: "price_prom", quantity: 1, durationCount: 1, durationUnit: "month" }],
  });
  assert.ok(good.ok);
  assert.equal(await def.revalidate(ctx, (good as { params: unknown }).params), null);
  const res = await def.execute(ctx, (good as { params: unknown }).params);
  assert.ok(res.ok);
  const phases = (updated[0] as { phases: Array<{ metadata?: Record<string, string> }> }).phases;
  // Phase 0 (current, rebuilt) keeps its metadata; the future phase gets the
  // NEW price's tier with the same uniqueId.
  assert.deepEqual(phases[0].metadata, gitroomMeta("STANDARD", "MONTHLY", "KeepMe0000"));
  assert.deepEqual(phases[1].metadata, { service: "gitroom", billing: "PRO", period: "MONTHLY", uniqueId: "KeepMe0000" });

  const bad = def.parseParams({
    subscriptionId: "sub_1",
    op: "set_phases",
    phases: [{ priceId: "price_custom", quantity: 1, durationCount: 1, durationUnit: "month" }],
  });
  assert.ok(bad.ok);
  assert.match((await def.revalidate(ctx, (bad as { params: unknown }).params)) ?? "", /not a canonical Postiz price/);
});

// ---- sections ----

function sectionCtx(overrides: { sub?: Stripe.Subscription; prices?: Stripe.Price[] } = {}): DashboardCtx {
  const sub = overrides.sub ?? fakeSub();
  const prices = overrides.prices ?? [PRICE_STD_M, PRICE_PRO_M, PRICE_CUSTOM];
  return {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listAllSubscriptions: async () => ({
        subscriptions: [sub, fakeSub({ id: "sub_synced", metadata: gitroomMeta() })],
        hasMore: false,
      }),
      countBySearch: async () => null,
      listRecurringPrices: async () => prices,
      getSubscription: async () => sub,
      isTestMode: () => false,
      getCustomer: async () => ({
        id: "cus_a",
        name: "Ada Lovelace",
        email: "ada@example.com",
        invoice_settings: { default_payment_method: "pm_9" },
      }),
      getPaymentMethod: async () => ({ id: "pm_9", type: "card", card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 } }),
      previewNewSubscription: async () => ({
        amount_due: 4900,
        currency: "usd",
        lines: { data: [{ id: "il_n", description: "Postiz Pro", amount: 4900, currency: "usd" }] },
      }),
      previewUpcomingInvoice: async () => null,
      previewPlanChange: async () => ({
        amount_due: 2000,
        currency: "usd",
        lines: { data: [{ id: "il_a", description: "delta", amount: 2000, currency: "usd" }] },
      }),
    } as unknown as DashboardCtx["stripe"],
    settings: { allowedPriceIds: () => [] } as never,
    stores: { session: { findDiscordIdsByStripeId: async () => [] } } as unknown as DashboardCtx["stores"],
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never } as unknown as DashboardCtx["billing"],
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
}

function noticeTexts(blocks: Block[]): string[] {
  return blocks.filter((b) => b.type === "notice").map((b) => (b as NoticeBlock).text);
}

function findCreateButton(blocks: Block[]): { params?: Record<string, unknown>; summary?: string } | null {
  for (const b of blocks) {
    const actions = (b as { actions?: Array<{ key: string; params?: Record<string, unknown>; summary?: string }> }).actions;
    const hit = actions?.find((a) => a.key === "subscription.create");
    if (hit) return hit;
  }
  return null;
}

test("composer: canonical price → POSTIZ SYNC notice + postizSync baked true; No sync bakes false", async () => {
  const section = makeSubscriptionsSection();
  const page = await section.buildPage(sectionCtx(), {
    page: "subscriptions.new",
    filters: { customer: "cus_a", price: "price_prom" },
  });
  assert.ok(noticeTexts(page!.blocks).some((t) => t.includes("PRO / MONTHLY")));
  const btn = findCreateButton(page!.blocks)!;
  assert.equal(btn.params!.postizSync, true);

  const off = await section.buildPage(sectionCtx(), {
    page: "subscriptions.new",
    filters: { customer: "cus_a", price: "price_prom", postiz: "off" },
  });
  const offBtn = findCreateButton(off!.blocks)!;
  assert.equal(offBtn.params!.postizSync, false);
  assert.ok(noticeTexts(off!.blocks).some((t) => t.includes("NOT sync")));
});

test("composer: non-canonical price + sync → NOT SYNCABLE, confirm withheld (but allowed with No sync)", async () => {
  const section = makeSubscriptionsSection();
  const blocked = await section.buildPage(sectionCtx(), {
    page: "subscriptions.new",
    filters: { customer: "cus_a", price: "price_custom" },
  });
  assert.equal(findCreateButton(blocked!.blocks), null);
  assert.ok(noticeTexts(blocked!.blocks).some((t) => t.includes("not a canonical Postiz price")));
  const optOut = await section.buildPage(sectionCtx(), {
    page: "subscriptions.new",
    filters: { customer: "cus_a", price: "price_custom", postiz: "off" },
  });
  assert.ok(findCreateButton(optOut!.blocks));
});

test("detail: unsynced sub shows warn badge, repair button, sync rail card and warning-augmented cancel summaries", async () => {
  const section = makeSubscriptionsSection();
  const page = await section.buildPage(sectionCtx(), { page: "subscriptions.detail", params: { id: "sub_1" } });
  const header = page!.blocks[0] as { badges: Array<{ text: string }>; actions: Array<{ label: string; summary?: string }> };
  assert.ok(header.badges.some((b) => b.text === "No Postiz sync"));
  const repair = page!.blocks.find(
    (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.repair_sync")
  );
  assert.ok(repair, "expected a repair button");
  for (const label of ["Cancel at period end", "Cancel now"]) {
    const btn = header.actions.find((a) => a.label === label)!;
    assert.ok(btn.summary!.includes("NOT downgrade the Postiz org"), `${label} summary must warn`);
  }
  const railCard = page!.rail!.find((b) => b.type === "kv" && (b as KeyValueBlock).title === "Postiz sync") as KeyValueBlock;
  assert.ok(railCard, "expected the Postiz sync rail card");
  assert.ok(railCard.rows.some((r) => r.label === "uniqueId"));
});

test("detail: synced sub gets no repair button and clean cancel summaries; non-canonical price is called unrepairable", async () => {
  const section = makeSubscriptionsSection();
  const synced = await section.buildPage(sectionCtx({ sub: fakeSub({ metadata: gitroomMeta() }) }), {
    page: "subscriptions.detail",
    params: { id: "sub_1" },
  });
  assert.ok(
    !synced!.blocks.some(
      (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.repair_sync")
    )
  );
  const header = synced!.blocks[0] as { actions: Array<{ label: string; summary?: string }> };
  assert.ok(!header.actions.find((a) => a.label === "Cancel now")!.summary!.includes("Postiz"));
  // Unsynced AND non-canonical → notice explains it can't be repaired, no button.
  const custom = fakeSub({ items: { data: [{ id: "si_1", quantity: 1, current_period_end: 1_700_900_000, price: PRICE_CUSTOM }] } });
  const stuck = await section.buildPage(sectionCtx({ sub: custom }), { page: "subscriptions.detail", params: { id: "sub_1" } });
  assert.ok(noticeTexts(stuck!.blocks).some((t) => t.includes("cannot be derived")));
  assert.ok(
    !stuck!.blocks.some(
      (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.repair_sync")
    )
  );
});

test("list: Postiz column present and the unsynced filter hides synced subs", async () => {
  const section = makeSubscriptionsSection();
  const page = await section.buildPage(sectionCtx(), { page: "subscriptions", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.ok(table.columns.some((c) => c.key === "sync"));
  assert.equal(table.rows.length, 2);
  const filteredPage = await section.buildPage(sectionCtx(), { page: "subscriptions", filters: { sync: "unsynced" } });
  const filtered = filteredPage!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.deepEqual(filtered.rows.map((r) => r.id), ["sub_1"]); // sub_synced hidden
});

test("changeplan page: gitroom sub moving to canonical price shows the tier transition; custom price withholds confirm", async () => {
  const section = makeSubscriptionsSection();
  const gitroomSub = fakeSub({ metadata: gitroomMeta("STANDARD", "MONTHLY", "KeepMe0000") });
  const ok = await section.buildPage(sectionCtx({ sub: gitroomSub }), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { price: "price_prom" },
  });
  const reviewed = noticeTexts(ok!.blocks).find((t) => t.includes("Postiz sync"));
  assert.ok(reviewed && reviewed.includes("STANDARD → PRO/MONTHLY"), `expected transition line, got: ${reviewed}`);
  assert.ok(
    ok!.blocks.some(
      (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.change_plan")
    )
  );
  const blocked = await section.buildPage(sectionCtx({ sub: gitroomSub }), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { price: "price_custom" },
  });
  assert.ok(noticeTexts(blocked!.blocks).some((t) => t.includes("canonical Postiz price")));
  assert.ok(
    !blocked!.blocks.some(
      (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.change_plan")
    )
  );
});
