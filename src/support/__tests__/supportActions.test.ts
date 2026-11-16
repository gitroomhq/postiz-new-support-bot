import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import type { StripeClient } from "../../bot/StripeClient";
import type { ApprovalStore, BillingApproval } from "../../bot/billing/ApprovalStore";
import { BillingActionService, type ScopedBinding } from "../../bot/billing/actions/BillingActionService";
import type { SettingsStore } from "../../config/SettingsStore";
import type { SessionStore } from "../../auth/SessionStore";
import type { PostizIdentityService, PostizOrgSummary } from "../../postiz/PostizIdentityService";
import type { EmailDeliverabilityService } from "../../resend/EmailDeliverabilityService";
import type { ActionButton, TableBlock } from "../../dashboard/renderer/contract";
import { SupportData } from "../SupportData";
import { SupportViews, declineReason, pastTense } from "../supportViews";
import { settledFrom, type SupportActionLog, type SupportLookupLog } from "../SupportStores";
import { outcomeMessage } from "../SupportDiscord";
import type { StripBlock, SupportBlock } from "../contract";

// What support may do from /support without an admin: refund, cancel and
// change details while the approval switch is off, queue all of it while it
// is on, and never run an action whose level is none or admin.

const SUPPORT = { kind: "support" as const, id: "111111111111111111", name: "Mara", isAdmin: false };
const BINDING: ScopedBinding = { stripeCustomerId: "cus_A1", discordCustomerId: null, ticketThreadId: null, conversationId: null, origin: "support" };

function service(level: "none" | "approval" | "admin" | "all", approvalOn: boolean) {
  const queued: unknown[] = [];
  const cancelled: string[] = [];
  const approvals = {
    create: async (input: Record<string, unknown>) => {
      queued.push(input);
      return { id: `apr_${queued.length}`, ...input } as unknown as BillingApproval;
    },
  } as unknown as ApprovalStore;
  const settings = {
    billingActionLevel: () => level,
    supportDashApproval: () => approvalOn,
    billingAuditChannelId: () => null,
    auditLogChannelId: () => null,
  } as unknown as SettingsStore;
  const stripe = {
    formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
    getSubscription: async (id: string) => ({ id, customer: "cus_A1", status: "active", cancel_at_period_end: false, cancel_at: null }),
    cancelSubscriptionAtPeriodEnd: async (id: string) => void cancelled.push(id),
  } as unknown as StripeClient;
  const svc = new BillingActionService(
    approvals,
    settings,
    stripe,
    { getSession: async () => null, findDiscordIdsByStripeId: async () => [] } as unknown as SessionStore,
    {} as never,
    {} as never,
    { getLinkByConversationId: async () => null } as never,
    { getByThreadId: async () => null } as never,
    { postPanelNote: async () => {} } as never,
    { log: async () => {} } as never
  );
  return { svc, queued, cancelled };
}

const CANCEL = { subscriptionId: "sub_1", when: "period_end" };

test("with the approval switch off, support runs an action at level approval at once", async () => {
  const { svc, queued, cancelled } = service("approval", false);
  const out = await svc.requestScoped(BINDING, SUPPORT, "subscription.cancel", CANCEL, { reason: "Moving to another tool" });
  assert.equal(out.kind, "executed");
  assert.deepEqual(cancelled, ["sub_1"]);
  assert.equal(queued.length, 0);
});

test("with the approval switch on, support queues even at level all", async () => {
  const { svc, queued, cancelled } = service("all", true);
  const out = await svc.requestScoped(BINDING, SUPPORT, "subscription.cancel", CANCEL);
  assert.equal(out.kind, "queued");
  assert.equal(queued.length, 1);
  assert.equal((queued[0] as { origin: string }).origin, "support");
  assert.deepEqual(cancelled, []);
});

test("levels none and admin switch an action off for support either way", async () => {
  for (const level of ["none", "admin"] as const) {
    for (const on of [false, true]) {
      const { svc, queued, cancelled } = service(level, on);
      const out = await svc.requestScoped(BINDING, SUPPORT, "subscription.cancel", CANCEL);
      assert.equal(out.kind, "denied", `${level}, approval ${on}`);
      assert.equal(queued.length + cancelled.length, 0);
    }
  }
});

// ---- the support views ----

const NOW = Date.UTC(2026, 10, 16, 12);
const DAY = 86_400;
const T = Math.floor(NOW / 1000);

function charge(id: string, over: Partial<Stripe.Charge> = {}): Stripe.Charge {
  return {
    id,
    customer: "cus_A1",
    amount: 4900,
    amount_refunded: 0,
    currency: "usd",
    status: "succeeded",
    captured: true,
    refunded: false,
    disputed: false,
    created: T - 12 * DAY,
    payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
    ...over,
  } as unknown as Stripe.Charge;
}

const ORG: PostizOrgSummary = {
  orgId: "clx8k2m0a0001qz7h3v9d2r4e",
  orgName: "Nordlicht Media",
  tier: "PRO",
  paymentId: "cus_A1",
  orgDeleted: false,
  customerMatches: true,
  ownerEmail: "anna@nordlicht-media.de",
  ownerRole: "SUPERADMIN",
  ownerMembershipId: "clx8k2m4b0003qz7hp1l0w6tn",
  ownerProvider: "LOCAL",
  ownerActivated: true,
  ownerIsLive: true,
  memberCount: 2,
  countIsFloor: false,
  subIdentifier: null,
  subPeriod: null,
  subIsLifetime: null,
  subCancelAt: null,
};

interface Fixture {
  charges?: Stripe.Charge[];
  subs?: Array<Partial<Stripe.Subscription>>;
  approvalOn?: boolean;
  denied?: string[];
  outcome?: "executed" | "queued" | "failed";
}

function views(fx: Fixture = {}) {
  const charges = fx.charges ?? [charge("ch_ok"), charge("ch_part", { amount_refunded: 900 }), charge("ch_disp", { disputed: true }), charge("ch_fail", { status: "failed", captured: false, outcome: { reason: "insufficient_funds" } as Stripe.Charge.Outcome })];
  const subs = (fx.subs ?? [{ id: "sub_1", status: "active", created: T - 90 * DAY, cancel_at_period_end: false, cancel_at: null }]).map((s) => ({
    metadata: {},
    items: { data: [{ current_period_end: T + 18 * DAY, price: { nickname: "Pro" } }] },
    ...s,
  }));
  const stripe = {
    getCustomer: async (id: string) => ({ id, name: "Nordlicht Media GmbH", email: "billing@nordlicht-media.de", address: { country: "DE" } }),
    listTaxIds: async () => [],
    listAllSubscriptions: async () => ({ subscriptions: subs }),
    listInvoices: async () => ({
      invoices: [{ id: "in_1", number: "7C1F-0011", status: "paid", total: 4900, currency: "usd", created: T - DAY, hosted_invoice_url: "https://invoice.stripe.com/i/abc", invoice_pdf: "https://pay.stripe.com/invoice/abc/pdf" }],
      hasMore: false,
    }),
    listCharges: async () => ({ charges, hasMore: false }),
    getCharge: async (id: string) => {
      const c = charges.find((x) => x.id === id);
      if (!c) throw Object.assign(new Error("missing"), { code: "resource_missing" });
      return c;
    },
    formatAmount: (a: number, c: string) => `$${(a / 100).toFixed(2)}${c === "usd" ? "" : ` ${c}`}`,
  } as unknown as StripeClient & { formatAmount(a: number, c: string): string };
  const postiz = { resolveOrgsForCustomer: async () => ({ state: "found", orgs: [ORG], via: "customer" }) } as unknown as PostizIdentityService;
  const calls: Array<{ key: string; params: Record<string, unknown>; context: unknown }> = [];
  const recorded: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const actions = {
    effectiveMode: (key: string) => (fx.denied?.includes(key) ? "denied" : "queue"),
    requestScoped: async (_b: unknown, _a: unknown, key: string, params: Record<string, unknown>, context: unknown) => {
      calls.push({ key, params, context });
      const kind = fx.outcome ?? (fx.approvalOn ? "queued" : "executed");
      if (kind === "queued") return { kind, approvalId: `apr_${calls.length}` };
      if (kind === "failed") return { kind, error: "Stripe said no" };
      return { kind, text: "ok" };
    },
  } as unknown as BillingActionService;
  const email = {
    enabled: () => true,
    statusFor: async (emails: string[]) =>
      emails.map((e) =>
        e === ORG.ownerEmail ? { email: e, state: "suppressed", suppression: { origin: "bounce", createdAt: new Date(NOW - 14 * DAY * 1000) }, source: null } : { email: e, state: "clear" }
      ),
    remove: async (e: string) => {
      removed.push(e);
      return { kind: "removed", previous: null };
    },
  } as unknown as EmailDeliverabilityService;
  const v = new SupportViews({
    data: new SupportData(stripe, postiz, () => NOW),
    approvals: { findActionableFor: async () => null, listActionableFor: async () => [] } as unknown as ApprovalStore,
    actions,
    lookups: {
      record: async () => {},
      recentCustomers: async () => ({ rows: [{ customerId: "cus_A1", customerName: "Nordlicht Media GmbH", openedAt: new Date(NOW - 3600_000) }], total: 1 }),
    } as unknown as SupportLookupLog,
    activity: { counts: async () => ({ pending: 0 }), record: async (e: Record<string, unknown>) => void recorded.push(e) } as unknown as SupportActionLog,
    settings: { supportDashApproval: () => !!fx.approvalOn },
    email,
    money: stripe,
    now: () => NOW,
  });
  return { v, calls, recorded, removed };
}

const ACTOR = { id: SUPPORT.id, name: "Mara", sessionIdHash: "h" };
const WHY = { reason: "Did not use October", intercomRef: "146041426" };

async function customerPage(v: SupportViews, tab = "") {
  const page = await v.build(ACTOR, { page: "customer", params: { id: "cus_A1" }, filters: tab ? { tab } : {}, cursor: null });
  assert.ok(page);
  return page.blocks;
}

function strip(blocks: SupportBlock[], title: string): StripBlock {
  const s = blocks.find((b) => b.type === "strip" && b.title === title) as StripBlock | undefined;
  assert.ok(s, `strip ${title}`);
  return s;
}

test("the customer page shows the Postiz ids with copy and the owner's suppression with Remove", async () => {
  const { v } = views();
  const p = strip(await customerPage(v), "Postiz");
  const byLabel = Object.fromEntries(p.items.map((i) => [i.label, i]));
  assert.deepEqual(Object.keys(byLabel), ["Organisation", "Org ID", "Owner", "Impersonate id"]);
  assert.equal(byLabel["Org ID"].value, ORG.orgId);
  assert.equal(byLabel["Org ID"].copy, true);
  assert.equal(byLabel["Impersonate id"].value, ORG.ownerMembershipId);
  assert.deepEqual(byLabel["Owner"].badge, { kind: "warn", text: "Suppressed, hard bounce" });
  assert.deepEqual(byLabel["Owner"].action?.params, { customerId: "cus_A1", email: ORG.ownerEmail });
});

test("charges offer a refund prefilled with what is left, never on a disputed or failed charge", async () => {
  const { v } = views();
  const table = (await customerPage(v, "charges")).find((b) => b.type === "table") as TableBlock;
  const row = (id: string) => table.rows.find((r) => r.id === id)!;
  const full = row("ch_ok").actions?.[0] as ActionButton;
  const amountInput = full.inputs?.find((i) => i.key === "amountMajor") as { value?: string; label: string };
  assert.equal(amountInput.value, "49.00");
  assert.equal(amountInput.label, "Amount (USD, up to 49.00)");
  assert.ok(full.inputs?.some((i) => i.key === "cancelSub" && i.type === "toggle"));
  assert.equal(full.submitLabel, "Refund");
  const part = row("ch_part").actions?.[0]?.inputs?.find((i) => i.key === "amountMajor") as { value?: string };
  assert.equal(part.value, "40.00");
  assert.equal(row("ch_disp").actions?.[0]?.disabledReason, "Disputed charges cannot be refunded.");
  assert.equal(row("ch_fail").actions, undefined);
  assert.deepEqual(row("ch_fail").cells[1], { t: "badge", b: { kind: "error", text: "Failed" }, sub: "Insufficient funds" });
});

test("refunds and the cancel button disappear when their level is off", async () => {
  const { v } = views({ denied: ["charge.refund_partial", "subscription.cancel"] });
  const blocks = await customerPage(v, "charges");
  const table = blocks.find((b) => b.type === "table") as TableBlock;
  assert.ok(table.rows.every((r) => !r.actions));
  const header = blocks.find((b) => b.type === "header") as { actions?: ActionButton[] };
  assert.deepEqual(header.actions?.map((a) => a.label), ["Change details"]);
});

test("invoices carry a copy-link and a PDF button", async () => {
  const { v } = views();
  const table = (await customerPage(v)).find((b) => b.type === "table") as TableBlock;
  assert.equal(table.inlineActions, true);
  assert.deepEqual(
    table.rows[0].actions?.map((a) => [a.label, a.copyText ?? a.href]),
    [
      ["Copy link", "https://invoice.stripe.com/i/abc"],
      ["PDF", "https://pay.stripe.com/invoice/abc/pdf"],
    ]
  );
});

test("a refund runs as a partial refund of the typed amount and is logged", async () => {
  const { v, calls, recorded } = views();
  const res = await v.action(ACTOR, "refund", { customerId: "cus_A1", chargeId: "ch_ok", amountMajor: 49, ...WHY });
  assert.deepEqual(res, { ok: true, text: "Refunded $49.00." });
  assert.deepEqual(calls.map((c) => [c.key, c.params]), [["charge.refund_partial", { chargeId: "ch_ok", amountMinor: 4900 }]]);
  assert.deepEqual(calls[0].context, WHY);
  assert.equal(recorded[0].summary, "Refund $49.00, Visa 4242");
  assert.equal(recorded[0].status, "done");
  assert.equal(recorded[0].kind, "refund");
});

test("a refund with the cancel box ticked cancels the one live subscription now", async () => {
  const { v, calls, recorded } = views();
  const res = await v.action(ACTOR, "refund", { customerId: "cus_A1", chargeId: "ch_part", amountMajor: 10, cancelSub: true, ...WHY });
  assert.equal(res.ok, true);
  assert.equal(res.text, "Refunded $10.00. The subscription is cancelled.");
  assert.deepEqual(calls.map((c) => [c.key, c.params]), [
    ["charge.refund_partial", { chargeId: "ch_part", amountMinor: 1000 }],
    ["subscription.cancel", { subscriptionId: "sub_1", when: "now" }],
  ]);
  assert.equal(recorded[0].summary, "Refund $10.00 of $49.00, Visa 4242");
  assert.equal(recorded[1].summary, "Cancel the subscription now");
});

test("a refund is refused before Stripe for a bad amount, a disputed charge, a stranger's charge or no reason", async () => {
  const { v, calls } = views();
  const over = await v.action(ACTOR, "refund", { customerId: "cus_A1", chargeId: "ch_part", amountMajor: 45, ...WHY });
  assert.equal(over.ok, false);
  assert.deepEqual(over.fieldErrors, { amountMajor: "Up to $40.00." });
  const disputed = await v.action(ACTOR, "refund", { customerId: "cus_A1", chargeId: "ch_disp", amountMajor: 1, ...WHY });
  assert.equal(disputed.error, "Disputed charges cannot be refunded.");
  const stranger = await v.action(ACTOR, "refund", { customerId: "cus_B2", chargeId: "ch_ok", amountMajor: 1, ...WHY });
  assert.equal(stranger.error, "That charge does not belong to this customer.");
  const noReason = await v.action(ACTOR, "refund", { customerId: "cus_A1", chargeId: "ch_ok", amountMajor: 1, reason: " " });
  assert.deepEqual(noReason.fieldErrors, { reason: "Required." });
  assert.equal(calls.length, 0);
});

test("with the approval switch on, actions say they wait and the row points at the approval", async () => {
  const { v, recorded } = views({ approvalOn: true });
  const res = await v.action(ACTOR, "cancel_sub", { customerId: "cus_A1", subscriptionId: "sub_1", when: "period_end", ...WHY });
  assert.deepEqual(res, { ok: true, queued: true, text: "Sent for approval." });
  assert.equal(recorded[0].status, "queued");
  assert.equal(recorded[0].approvalId, "apr_1");
  const header = (await customerPage(v)).find((b) => b.type === "header") as { actions?: ActionButton[] };
  assert.deepEqual(header.actions?.map((a) => [a.label, a.submitLabel]), [
    ["Cancel subscription", "Send for approval"],
    ["Request change", "Send for approval"],
  ]);
});

test("a scheduled cancel offers Cancel now and Undo cancel", async () => {
  const { v, calls } = views({ subs: [{ id: "sub_1", status: "active", created: T - 90 * DAY, cancel_at_period_end: true, cancel_at: null }] });
  const header = (await customerPage(v)).find((b) => b.type === "header") as { actions?: ActionButton[] };
  assert.deepEqual(header.actions?.map((a) => a.label), ["Cancel now", "Undo cancel", "Change details"]);
  const res = await v.action(ACTOR, "keep_sub", { customerId: "cus_A1", subscriptionId: "sub_1", ...WHY });
  assert.equal(res.text, "The subscription keeps renewing.");
  assert.deepEqual(calls[0].params, { subscriptionId: "sub_1", when: "never" });
});

test("Remove takes only an address this customer is known by off the list", async () => {
  const { v, removed, recorded } = views();
  const res = await v.action(ACTOR, "unsuppress", { customerId: "cus_A1", email: "ANNA@nordlicht-media.de" });
  assert.equal(res.ok, true);
  assert.deepEqual(removed, ["anna@nordlicht-media.de"]);
  assert.equal(recorded[0].summary, "Remove anna@nordlicht-media.de from suppression");
  const other = await v.action(ACTOR, "unsuppress", { customerId: "cus_A1", email: "someone@else.com" });
  assert.equal(other.error, "That address does not belong to this customer.");
  assert.equal(removed.length, 1);
});

test("an empty search lists the customers this teammate opened", async () => {
  const { v } = views();
  const page = await v.build(ACTOR, { page: "lookup", params: {}, filters: {}, cursor: null });
  const table = page?.blocks.find((b) => b.type === "table") as TableBlock | undefined;
  assert.equal(table?.title, "Recently opened");
  assert.deepEqual(table?.rows[0].ref, { page: "customer", params: { id: "cus_A1" }, filters: { via: "recent" } });
});

test("activity rows read in the past once done, and settle from their approval", () => {
  assert.equal(pastTense("Refund $49.00, Visa 4242"), "Refunded $49.00, Visa 4242");
  assert.equal(pastTense("Undo the scheduled cancel"), "Undid the scheduled cancel");
  const a = (over: Partial<BillingApproval>) => ({ status: "PENDING", reviewerName: "Enno", reviewNote: null, errorText: null, ...over }) as BillingApproval;
  assert.deepEqual(settledFrom(a({ status: "EXECUTED" })), { status: "done", outcome: "Approved by Enno" });
  assert.deepEqual(settledFrom(a({ status: "REJECTED", reviewNote: "wrong customer" })), { status: "rejected", outcome: "Enno: wrong customer" });
  assert.equal(settledFrom(a({ status: "PENDING" })).status, "queued");
  assert.equal(settledFrom(a({ status: "FAILED", errorText: "card_declined" })).status, "queued");
});

test("a failed charge names the bank's reason in a few words", () => {
  assert.equal(declineReason(charge("c", { status: "failed", failure_code: "card_declined", outcome: { reason: "expired_card" } as Stripe.Charge.Outcome })), "Expired card");
  assert.equal(declineReason(charge("c", { status: "failed", failure_code: "some_new_code" })), "Some new code");
  assert.equal(declineReason(charge("c")), null);
});

test("an outcome DM names the activity line", () => {
  const row = { status: "EXECUTED", reviewerName: "Enno", paramsJson: { customerName: "Nordlicht" }, stripeCustomerId: "cus_A1" } as unknown as BillingApproval;
  assert.equal(
    outcomeMessage(row, "https://bot.example/support", "Refund $49.00, Visa 4242"),
    "**Approved:** Enno approved your request for Nordlicht (refund $49.00, Visa 4242).\nhttps://bot.example/support/customer/cus_A1"
  );
});
