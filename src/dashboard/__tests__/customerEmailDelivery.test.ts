import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeyValueBlock } from "../renderer/contract";
import type { DashboardCtx } from "../sections/types";
import { makeCustomersSection, type CustomersDeps } from "../sections/customersSection";
import type { DeliveryStatus } from "../../resend/EmailDeliverabilityService";
import type { PostizOrgLookup } from "../../postiz/PostizIdentityService";

// The Email delivery rail card on the web customer page: which of the
// customer's addresses Postiz mail cannot reach, and the two repairs.

const CUSTOMER_ID = "cus_mail1";

function ctx(): DashboardCtx {
  const stripe = {
    getCustomer: async () => ({ id: CUSTOMER_ID, email: "billing@acme.com", name: "Acme", created: 1_700_000_000, metadata: {} }),
    listSubscriptions: async () => [],
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
    // An operator, not an admin: "any teammate" may remove.
    actor: { id: "42", name: "Ada", role: "operator", isAdmin: false },
    stripe,
    settings: {} as never,
    stores,
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never } as unknown as DashboardCtx["billing"],
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => false },
  } as unknown as DashboardCtx;
}

const lookup: PostizOrgLookup = {
  state: "found",
  via: "customer",
  orgs: [
    {
      orgId: "org_1",
      orgName: "Acme",
      tier: "PRO",
      paymentId: CUSTOMER_ID,
      orgDeleted: false,
      customerMatches: true,
      ownerEmail: "jane@acme.com",
      ownerRole: "SUPERADMIN",
      ownerMembershipId: "uo_1",
      ownerProvider: "LOCAL",
      ownerActivated: false,
      ownerIsLive: true,
      memberCount: 1,
      countIsFloor: false,
      subIdentifier: null,
      subPeriod: null,
      subIsLifetime: null,
      subCancelAt: null,
    },
  ],
};

function deps(statuses: Record<string, DeliveryStatus["state"]>) {
  const removed: string[] = [];
  const activated: string[] = [];
  const status = (email: string): DeliveryStatus =>
    statuses[email] === "suppressed"
      ? {
          email,
          state: "suppressed",
          suppression: { id: "s", email, origin: "complaint", sourceId: null, createdAt: new Date("2026-09-01T00:00:00Z") },
          source: null,
        }
      : { email, state: "clear" };
  const d: CustomersDeps = {
    postiz: { resolveOrgsForCustomer: async () => lookup } as never,
    emailDelivery: {
      enabled: () => true,
      statusFor: async (emails: string[]) => emails.map(status),
      remove: async (email: string) => {
        removed.push(email);
        return { kind: "removed", previous: null };
      },
      resendActivation: async (email: string) => {
        activated.push(email);
        return { ok: true };
      },
    } as never,
  };
  return { d, removed, activated };
}

test("customer page: every known address with its state; Remove for the suppressed, activation for the unactivated owner", async () => {
  const { d } = deps({ "billing@acme.com": "suppressed", "jane@acme.com": "clear" });
  const page = await makeCustomersSection(d).buildPage(ctx(), { page: "customers.detail", params: { id: CUSTOMER_ID } });
  const card = page!.rail!.find((b) => (b as KeyValueBlock).title === "Email delivery") as KeyValueBlock;
  assert.deepEqual(card.rows.map((r) => r.label), ["billing@acme.com", "jane@acme.com"]);
  assert.match((card.rows[0].cell as { v: string }).v, /suppressed since 2026-09-01 \(spam complaint\)/);
  const keys = card.actions!.map((a) => `${a.key}:${(a.params as { email: string }).email}`);
  assert.deepEqual(keys, [
    "section:customers.email_unsuppress:billing@acme.com",
    "section:customers.email_activation:jane@acme.com",
  ]);
  assert.equal(card.actions![0].dangerous, true, "removal is a typed-CONFIRM action");
});

test("customer page: removal needs CONFIRM, only reaches this customer's own addresses, and any teammate may", async () => {
  const { d, removed, activated } = deps({ "billing@acme.com": "suppressed" });
  const section = makeCustomersSection(d);
  const unsuppress = (email: string, confirmWord?: string) =>
    section.action!(ctx(), { key: "section:customers.email_unsuppress", params: { customerId: CUSTOMER_ID, email }, confirmWord });

  assert.equal((await unsuppress("billing@acme.com")).ok, false);
  const foreign = await unsuppress("someone@else.com", "CONFIRM");
  assert.equal(foreign.ok, false);
  assert.match(foreign.error ?? "", /does not belong to this customer/);
  assert.deepEqual(removed, []);

  const ok = await unsuppress("BILLING@acme.com", "CONFIRM");
  assert.equal(ok.ok, true);
  assert.deepEqual(removed, ["billing@acme.com"], "the stored spelling is used, not the typed one");

  const act = await section.action!(ctx(), {
    key: "section:customers.email_activation",
    params: { customerId: CUSTOMER_ID, email: "jane@acme.com" },
  });
  assert.equal(act.ok, true);
  assert.deepEqual(activated, ["jane@acme.com"]);
});
