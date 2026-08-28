import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeyValueBlock } from "../renderer/contract";
import type { DashboardCtx } from "../sections/types";
import { makeCustomersSection, type CustomersDeps } from "../sections/customersSection";
import type { PostizOrgLookup, PostizOrgSummary } from "../../postiz/PostizIdentityService";

const CUSTOMER_ID = "cus_test1";

// A subscription the platform would recognise: service:"gitroom" plus the four
// contract keys, and the userId the platform's own checkout adds.
function gitroomSub(over: Record<string, string> = {}, status = "active") {
  return {
    id: "sub_1",
    status,
    created: 1_700_000_000,
    currency: "usd",
    items: { data: [{ price: { id: "price_1", currency: "usd", unit_amount: 2900, recurring: { interval: "month", interval_count: 1 } } }] },
    metadata: { service: "gitroom", billing: "STANDARD", period: "MONTHLY", uniqueId: "aB3xK9mQ2p", userId: "usr_meta", ...over },
  };
}

function org(over: Partial<PostizOrgSummary> = {}): PostizOrgSummary {
  return {
    orgId: "org_7c1e",
    orgName: "Acme Social",
    tier: "STANDARD",
    paymentId: CUSTOMER_ID,
    orgDeleted: false,
    customerMatches: true,
    ownerEmail: "jane@acme.com",
    ownerRole: "SUPERADMIN",
    ownerMembershipId: "uo_owner",
    ownerProvider: "LOCAL",
    ownerActivated: true,
    ownerIsLive: true,
    memberCount: 3,
    countIsFloor: false,
    subIdentifier: "aB3xK9mQ2p",
    subPeriod: "MONTHLY",
    subIsLifetime: false,
    subCancelAt: null,
    ...over,
  };
}

function fakeCtx(subs: unknown[]): DashboardCtx {
  const stripe = {
    getCustomer: async () => ({ id: CUSTOMER_ID, email: "olly@example.com", name: "Olly", created: 1_700_000_000, metadata: {} }),
    listSubscriptions: async () => subs,
    listInvoices: async () => ({ invoices: [], hasMore: false }),
    listAllPaymentMethods: async () => [],
    listCharges: async () => ({ charges: [], hasMore: false }),
    listCreditGrants: async () => [],
    listTaxIds: async () => [],
    listBalanceTransactions: async () => ({ data: [] }),
    getCashBalance: async () => null,
    formatAmount: (v: number, cur: string) => `${(v / 100).toFixed(2)} ${cur.toUpperCase()}`,
  } as unknown as DashboardCtx["stripe"];
  const stores = {
    session: { findDiscordIdsByStripeId: async () => [], listByDiscordIds: async () => [] },
    dispute: { listByCustomer: async () => [] },
    block: { listForCustomer: async () => [] },
    qol: { listNotes: async () => ({ rows: [], total: 0 }) },
  } as unknown as DashboardCtx["stores"];
  return {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe,
    settings: {} as never,
    stores,
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never } as unknown as DashboardCtx["billing"],
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => false },
  } as unknown as DashboardCtx;
}

// Records the terms the section asked the platform about, so the fallback
// ordering can be asserted rather than inferred.
function fakePostiz(lookup: PostizOrgLookup, seen: string[][] = []): CustomersDeps {
  return {
    postiz: {
      async resolveOrgsForCustomer(customerId: string, uniqueIds: string[] = []) {
        seen.push([customerId, ...uniqueIds]);
        return lookup;
      },
    } as unknown as NonNullable<CustomersDeps["postiz"]>,
  };
}

async function linkedCard(subs: unknown[], deps?: CustomersDeps): Promise<KeyValueBlock> {
  const page = await makeCustomersSection(deps).buildPage(fakeCtx(subs), {
    page: "customers.detail",
    params: { id: CUSTOMER_ID },
  });
  assert.ok(page, "expected a customer detail page");
  const card = page!.rail!.find(
    (b) => b.type === "kv" && (b as KeyValueBlock).title === "Linked accounts"
  ) as KeyValueBlock;
  assert.ok(card, "expected a Linked accounts rail card");
  return card;
}

function rowMap(card: KeyValueBlock): Record<string, { v?: string; sub?: string }> {
  const out: Record<string, { v?: string; sub?: string }> = {};
  for (const r of card.rows) out[r.label] = r.cell as { v?: string; sub?: string };
  return out;
}

function labels(card: KeyValueBlock): string[] {
  return card.rows.map((r) => r.label);
}

test("postiz rail: metadata alone renders plan + ids with no platform client", async () => {
  const card = await linkedCard([gitroomSub()]);
  const rows = rowMap(card);
  assert.equal(rows["Postiz plan"].v, "STANDARD · MONTHLY");
  assert.equal(rows["Postiz uniqueId"].v, "aB3xK9mQ2p");
  // The platform-written userId stands in when no Discord session is linked.
  assert.equal(rows["Postiz user"].v, "usr_meta");
  // No client, so nothing claims anything about an organization either way.
  assert.ok(!labels(card).includes("Postiz org"), "must not report on orgs without a client");
});

test("postiz rail: a non-Postiz customer gets no Postiz rows at all", async () => {
  const card = await linkedCard([{ id: "sub_x", status: "active", created: 1, items: { data: [] }, metadata: {} }], fakePostiz({ state: "none", orgs: [], via: null }));
  assert.deepEqual(labels(card), ["Discord user"]);
  assert.equal((card.rows[0].cell as { v?: string }).v, "not linked");
});

test("postiz rail: an org found by customer id renders identity + impersonate handle", async () => {
  const card = await linkedCard([gitroomSub()], fakePostiz({ state: "found", orgs: [org()], via: "customer" }));
  const rows = rowMap(card);
  assert.equal(rows["Postiz org"].v, "Acme Social");
  assert.equal(rows["Postiz org"].sub, "3 members");
  assert.equal(rows["Postiz org ID"].v, "org_7c1e");
  assert.equal(rows["Postiz owner"].v, "jane@acme.com");
  assert.equal(rows["Postiz owner"].sub, "SUPERADMIN · LOCAL");
  assert.equal(rows["Impersonate id"].v, "uo_owner");
});

test("postiz rail: the fallback term is the metadata uniqueId, never a sub_ id", async () => {
  const seen: string[][] = [];
  await linkedCard([gitroomSub()], fakePostiz({ state: "found", orgs: [org()], via: "uniqueId" }, seen));
  assert.deepEqual(seen, [[CUSTOMER_ID, "aB3xK9mQ2p"]]);
  assert.ok(!seen[0].includes("sub_1"), "a Stripe sub_ id must never be sent as a search term");
});

test("postiz rail: an org reached only by subscription id says so", async () => {
  const card = await linkedCard(
    [gitroomSub()],
    fakePostiz({ state: "found", orgs: [org({ customerMatches: null, paymentId: null })], via: "uniqueId" })
  );
  assert.equal(rowMap(card)["Postiz org"].sub, "3 members · matched on subscription id");
});

test("postiz rail: an org pointing at another Stripe customer is flagged", async () => {
  const card = await linkedCard(
    [gitroomSub()],
    fakePostiz({ state: "found", orgs: [org({ paymentId: "cus_other", customerMatches: false })], via: "uniqueId" })
  );
  assert.match(rowMap(card)["Postiz org"].sub ?? "", /points at a different Stripe customer/);
});

test("postiz rail: capped member counts read as a floor, deleted orgs are marked", async () => {
  const card = await linkedCard(
    [gitroomSub()],
    fakePostiz({ state: "found", orgs: [org({ memberCount: 25, countIsFloor: true, orgDeleted: true })], via: "customer" })
  );
  assert.equal(rowMap(card)["Postiz org"].sub, "25+ members · deleted");
});

test("postiz rail: tier drift, lifetime and cancel date ride the plan row", async () => {
  const card = await linkedCard(
    [gitroomSub()],
    fakePostiz({
      state: "found",
      orgs: [org({ tier: "ULTIMATE", subIsLifetime: true, subCancelAt: "2026-12-01T00:00:00.000Z" })],
      via: "customer",
    })
  );
  assert.equal(rowMap(card)["Postiz plan"].sub, "platform says ULTIMATE · lifetime deal · cancels 2026-12-01");
});

test("postiz rail: an identifier disagreeing with Stripe metadata is surfaced", async () => {
  const card = await linkedCard(
    [gitroomSub()],
    fakePostiz({ state: "found", orgs: [org({ subIdentifier: "zZ9other01" })], via: "customer" })
  );
  const rows = rowMap(card);
  assert.equal(rows["Platform identifier"].v, "zZ9other01");
  assert.equal(rows["Platform identifier"].sub, "does not match the Stripe metadata");
});

test("postiz rail: more than two organizations collapse into a count", async () => {
  const card = await linkedCard(
    [gitroomSub()],
    fakePostiz({
      state: "found",
      orgs: [org({ orgId: "org_a" }), org({ orgId: "org_b" }), org({ orgId: "org_c" }), org({ orgId: "org_d" })],
      via: "customer",
    })
  );
  const ids = card.rows.filter((r) => r.label === "Postiz org ID").map((r) => (r.cell as { v?: string }).v);
  assert.deepEqual(ids, ["org_a", "org_b"]);
  assert.equal(rowMap(card)["More organizations"].v, "+2 not shown");
});

test("postiz rail: degraded lookups are distinguishable from a real miss", async () => {
  for (const [state, expected] of [
    ["timeout", "lookup timed out"],
    ["error", "platform unreachable"],
    ["none", "no account found"],
  ] as const) {
    const card = await linkedCard([gitroomSub()], fakePostiz({ state, orgs: [], via: null }));
    assert.equal(rowMap(card)["Postiz org"].v, expected, `state ${state}`);
    // The free metadata rows survive a dead platform.
    assert.equal(rowMap(card)["Postiz plan"].v, "STANDARD · MONTHLY", `state ${state} keeps the plan`);
  }
});

test("postiz rail: a disabled lookup stays silent rather than reporting a miss", async () => {
  const card = await linkedCard([gitroomSub()], fakePostiz({ state: "off", orgs: [], via: null }));
  assert.ok(!labels(card).includes("Postiz org"), "an off lookup must not claim 'no account found'");
  assert.equal(rowMap(card)["Postiz plan"].v, "STANDARD · MONTHLY");
});

test("postiz rail: the live subscription supplies the plan, not a stale cancelled one", async () => {
  const card = await linkedCard([
    gitroomSub({ billing: "TEAM", uniqueId: "old0000000" }, "canceled"),
    gitroomSub({ billing: "PRO", uniqueId: "new1111111" }, "active"),
  ]);
  const rows = rowMap(card);
  assert.equal(rows["Postiz plan"].v, "PRO · MONTHLY");
  assert.equal(rows["Postiz uniqueId"].v, "new1111111");
});
