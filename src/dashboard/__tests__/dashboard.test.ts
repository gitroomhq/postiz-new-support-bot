import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type Stripe from "stripe";
import { DashboardTokens } from "../DashboardTokens";
import { DashboardAuthProvider, DashboardAuthResult } from "../DashboardAuth";
import { Dashboard } from "../Dashboard";
import { DashboardActionGateway } from "../DashboardActions";
import { DashboardCtx, DashboardSectionModule } from "../sections/types";
import { chargeBadge, estimateMrr, formatPerCurrency, refForId, sentence } from "../sections/cells";
import { makeCustomersSection } from "../sections/customersSection";
import { makePaymentsSection, buildGuardrailPanel } from "../sections/paymentsSection";
import { makeHomeSection } from "../sections/homeSection";
import { makeBalancesSection } from "../sections/balancesSection";
import { makeSubscriptionsSection } from "../sections/subscriptionsSection";
import { makeInvoicesSection } from "../sections/invoicesSection";
import { makeDisputesSection } from "../sections/disputesSection";
import { makeSecuritySection } from "../sections/securitySection";
import type { CachedRatioEngine } from "../../bot/billing/disputeRatio";
import {
  DisputeEvidenceService,
  EVIDENCE_FILE_SLOTS,
  EVIDENCE_GROUPS,
  recommendedGroupKeys,
} from "../../bot/billing/DisputeEvidenceService";
import { TEXT_EVIDENCE_KEYS } from "../../bot/billing/DisputeStore";
import { GlobalSearch } from "../search/GlobalSearch";
import { actionByKey, ActionExecCtx } from "../../bot/billing/actions/ActionRegistry";
import { BillingActionService } from "../../bot/billing/actions/BillingActionService";
import type { ApprovalStore, BillingApproval } from "../../bot/billing/ApprovalStore";
import type { SessionStore } from "../../auth/SessionStore";
import type { SettingsStore as SettingsStoreType } from "../../config/SettingsStore";
import type { BlockStore } from "../../bot/billing/BlockStore";
import type { CredentialStore } from "../auth/CredentialStore";
import type { DashboardDbSessions } from "../auth/DashboardDbSessions";
import type { DashboardAudit } from "../auth/DashboardAudit";
import { Block, EvidenceBlock, HeaderBlock, KeyValueBlock, NoticeBlock, TableBlock, TabsBlock, TimelineBlock } from "../renderer/contract";
import { renderDashboardShell } from "../html/shellHtml";
import { clientCore } from "../html/clientCore";
import { clientBlocks } from "../html/clientBlocks";
import { clientModal } from "../html/clientModal";
import { clientPalette } from "../html/clientPalette";
import { clientPeek } from "../html/clientPeek";
import { clientCharts } from "../html/clientCharts";
import { clientEvidence } from "../html/clientEvidence";
import { clientLogin } from "../html/clientLogin";
import { clientApp } from "../html/clientApp";
import { hashPassphrase, verifyPassphrase, MIN_PASSPHRASE_LENGTH } from "../auth/passphrase";
import { base32Decode, base32Encode, currentStep, newTotpSecret, otpauthUri, totpCode, verifyTotp } from "../auth/totp";
import { ChallengeStore } from "../auth/webauthnSupport";
import type { SettingsStore } from "../../config/SettingsStore";
import type { StripeClient } from "../../bot/StripeClient";

const SECRET = "dash-secret-0123456789abcdef";

// Fake SettingsStore covering exactly the surface the token layer touches.
function fakeSettings(overrides: { epoch?: number; baseUrl?: string | null; enabled?: boolean } = {}) {
  let epoch = overrides.epoch ?? 0;
  let enabled = overrides.enabled ?? true;
  return {
    store: {
      ensureDashboardTokenSecret: async () => SECRET,
      dashboardTokenSecret: () => SECRET,
      dashboardEpoch: () => epoch,
      dashboardEnabled: () => enabled,
      resolvedPublicBaseUrl: () => (overrides.baseUrl === undefined ? "https://bot.example.com" : overrides.baseUrl),
    } as unknown as SettingsStore,
    bumpEpoch: () => {
      epoch += 1;
    },
    disable: () => {
      enabled = false;
    },
  };
}

const MINT = { kind: "open" as const, userId: "42", adminName: "Ada" };

test("d1 mint → verify round-trip; kind separation; epoch revocation", async () => {
  const fake = fakeSettings();
  const tokens = new DashboardTokens(fake.store);
  const token = await tokens.mint(MINT);
  assert.ok(token.startsWith("d1."));
  const payload = tokens.verify(token, "open");
  assert.ok(payload);
  assert.equal(payload!.sub, "42");
  assert.equal(payload!.k, "open");
  // An "open" token can never verify as an "enroll" token.
  assert.equal(tokens.verify(token, "enroll"), null);
  fake.bumpEpoch();
  assert.equal(tokens.verify(token, "open"), null);
});

test("d1 tampering + wrong version + expiry are rejected", async () => {
  const fake = fakeSettings();
  const tokens = new DashboardTokens(fake.store);
  const token = await tokens.mint(MINT);
  const [version, body, mac] = token.split(".");
  assert.equal(tokens.verify(`a1.${body}.${mac}`, "open"), null); // admin-panel version tag
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  payload.sub = "999";
  const forged = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.equal(tokens.verify(`${version}.${forged}.${mac}`, "open"), null);
  // expiry (re-signed with the real secret so ONLY exp differs)
  payload.sub = "42";
  payload.exp = Date.now() - 1000;
  const expiredBody = `${version}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const expiredMac = createHmac("sha256", SECRET).update(expiredBody).digest("hex");
  assert.equal(tokens.verify(`${expiredBody}.${expiredMac}`, "open"), null);
});

test("minting refuses a non-https public base URL (localhost allowed)", async () => {
  const insecure = new DashboardTokens(fakeSettings({ baseUrl: "http://bot.example.com" }).store);
  await assert.rejects(() => insecure.mint(MINT), /https/);
  const local = new DashboardTokens(fakeSettings({ baseUrl: "http://localhost:3000" }).store);
  assert.ok(await local.mint(MINT));
});

// ---- auth primitives ----

test("passphrase: hash → verify round trip; wrong pass and null stored fail; format is self-describing", () => {
  const stored = hashPassphrase("correct horse battery");
  assert.match(stored, /^scrypt:N=32768,r=8,p=1:/);
  assert.equal(verifyPassphrase("correct horse battery", stored), true);
  assert.equal(verifyPassphrase("wrong", stored), false);
  // Anti-oracle: null/garbage stored still runs and returns false.
  assert.equal(verifyPassphrase("anything", null), false);
  assert.equal(verifyPassphrase("anything", "garbage"), false);
  assert.ok(MIN_PASSPHRASE_LENGTH >= 12);
});

test("totp: RFC round trip, ±1 window, replay guard, base32, otpauth uri", () => {
  const secret = newTotpSecret();
  assert.equal(secret.length, 20);
  const now = Date.now();
  const step = currentStep(now);
  const code = totpCode(secret, step);
  assert.match(code, /^\d{6}$/);
  // current + adjacent steps verify; two steps off fails
  assert.deepEqual(verifyTotp(secret, code, null, now), { ok: true, step });
  const prev = totpCode(secret, step - 1);
  assert.equal(verifyTotp(secret, prev, null, now).ok, true);
  const old = totpCode(secret, step - 2);
  assert.equal(verifyTotp(secret, old, null, now).ok, false);
  // replay guard: the accepted step can't be used again
  assert.equal(verifyTotp(secret, code, step, now).ok, false);
  // base32 round trip
  const b32 = base32Encode(secret);
  assert.deepEqual(base32Decode(b32), secret);
  // uri carries the secret + issuer
  const uri = otpauthUri("Ada", "Billing dashboard", secret);
  assert.ok(uri.startsWith("otpauth://totp/"));
  assert.ok(uri.includes(b32));
});

test("totp: RFC 6238 SHA-1 test vector (secret '12345678901234567890', T=59s → 94287082 → 6-digit 287082)", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  // RFC 6238 vector time 59s → step 1.
  assert.equal(totpCode(secret, 1), "287082");
});

test("webauthn challenge store: single-use, unknown rejected", () => {
  const store = new ChallengeStore();
  store.remember("chal-1");
  assert.equal(store.consume("chal-1"), true);
  assert.equal(store.consume("chal-1"), false); // replay
  assert.equal(store.consume("never-seen"), false);
});

// ---- Dashboard.api dispatch over a fake provider ----

function fakeSection(): DashboardSectionModule {
  return {
    nav: [{ key: "customers", label: "Customers", page: "customers" }],
    ownsPage: (p) => p === "customers",
    buildPage: async () => ({ title: "Customers", crumbs: [{ label: "Customers" }], blocks: [] }),
  };
}

function fakeAuthResult(state: "locked" | "active", overrides: Partial<DashboardAuthResult> = {}): DashboardAuthResult {
  return {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    state,
    ...(state === "locked" ? { activationCode: "AAAA-BBBB" } : {}),
    sessionIdHash: "hash-1",
    authMethod: "passkey",
    stepUpFresh: () => false,
    consumeReverse: () => false,
    logout: async () => {},
    ...overrides,
  };
}

function makeDashboard(fake: ReturnType<typeof fakeSettings>, provider: DashboardAuthProvider) {
  const stripe = { isTestMode: () => true } as unknown as StripeClient;
  return new Dashboard(fake.store, provider, [fakeSection()], {
    stripe,
    settings: fake.store,
    stores: {} as never,
    billing: {} as never,
  });
}

test("api: no session → login-mode activation-status + auth-* routing; anything else expired", async () => {
  const fake = fakeSettings();
  const seen: string[] = [];
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => null,
    publicEndpoint: async (endpoint) => {
      seen.push(endpoint);
      if (endpoint === "activation-status") return { status: 200, json: { state: "login", passkey: true } };
      if (endpoint === "auth-passkey-options") return { status: 200, json: { options: {} } };
      return null;
    },
    sessionEndpoint: async () => null,
  };
  const dashboard = makeDashboard(fake, provider);

  const status = await dashboard.api("activation-status", "", {});
  assert.deepEqual(status.json, { state: "login", passkey: true });
  const options = await dashboard.api("auth-passkey-options", "", {}, { ip: "1.2.3.4" });
  assert.equal(options.status, 200);
  const view = await dashboard.api("view", "", { page: "customers" });
  assert.equal((view.json as { state?: string }).state, "expired");
  assert.deepEqual(seen, ["activation-status", "auth-passkey-options"]);
});

test("api: locked session gates everything but activation-status (incl. auth-* endpoints)", async () => {
  const fake = fakeSettings();
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("locked"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => ({ status: 200, json: { ok: true } }),
  };
  const dashboard = makeDashboard(fake, provider);

  const status = await dashboard.api("activation-status", "cookie", {});
  assert.equal((status.json as { state: string }).state, "locked");
  assert.equal((status.json as { activationCode?: string }).activationCode, "AAAA-BBBB");
  const view = await dashboard.api("view", "cookie", { page: "customers" });
  assert.equal(view.status, 403);
  const stepup = await dashboard.api("auth-stepup", "cookie", {});
  assert.equal(stepup.status, 403);
});

test("api: active session serves views + session auth endpoints; disabled → 404", async () => {
  const fake = fakeSettings();
  let loggedOut = false;
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active", { logout: async () => void (loggedOut = true) }),
    publicEndpoint: async () => null,
    sessionEndpoint: async (endpoint) => (endpoint === "auth-stepup" ? { status: 200, json: { ok: true } } : null),
  };
  const dashboard = makeDashboard(fake, provider);

  const view = await dashboard.api("view", "cookie", { page: "customers" });
  assert.equal(view.status, 200);
  const v = view.json as { title: string; testMode: boolean; actorLabel: string };
  assert.equal(v.title, "Customers");
  assert.equal(v.testMode, true);
  assert.equal(v.actorLabel, "Ada · admin");

  const stepup = await dashboard.api("auth-stepup", "cookie", {});
  assert.deepEqual(stepup.json, { ok: true });
  const unknownAuth = await dashboard.api("auth-nope", "cookie", {});
  assert.equal(unknownAuth.status, 404);

  await dashboard.api("logout", "cookie", {});
  assert.equal(loggedOut, true);

  fake.disable();
  const disabled = await dashboard.api("view", "cookie", { page: "customers" });
  assert.equal(disabled.status, 404);
  const page = await dashboard.page("", "cookie");
  assert.ok(!("html" in page) && page.status === 404);
});

test("page: provider outcomes map to shell/reject; setCookie only when provided", async () => {
  const fake = fakeSettings();
  const provider: DashboardAuthProvider = {
    enter: async ({ token }) => {
      if (token === "bad") return { kind: "reject", status: 401, message: "no" };
      if (token === "mint") return { kind: "page", sessionCookie: "__Host-billing=abc; Path=/" };
      return { kind: "page" };
    },
    authenticate: async () => null,
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  const dashboard = makeDashboard(fake, provider);
  const rejected = await dashboard.page("bad", "");
  assert.ok(!("html" in rejected) && rejected.status === 401);
  const minted = await dashboard.page("mint", "");
  assert.ok("html" in minted && minted.sessionCookie?.startsWith("__Host-billing="));
  const login = await dashboard.page("", "");
  assert.ok("html" in login && login.sessionCookie === undefined);
});

// ---- Stripe atoms: cell/metric helpers ----

test("estimateMrr: normalizes intervals, honors quantity/interval_count, skips trials, buckets per currency", () => {
  const sub = (status: string, items: Array<Partial<Stripe.Price> & { quantity?: number }>) =>
    ({
      status,
      items: {
        data: items.map((p) => ({
          quantity: p.quantity ?? 1,
          price: {
            currency: p.currency ?? "eur",
            unit_amount: p.unit_amount,
            recurring: p.recurring,
          },
        })),
      },
    }) as unknown as Stripe.Subscription;
  const mrr = estimateMrr([
    sub("active", [{ unit_amount: 2900, recurring: { interval: "month", interval_count: 1 } as never }]),
    sub("active", [{ unit_amount: 12000, recurring: { interval: "year", interval_count: 1 } as never }]),
    sub("active", [{ unit_amount: 1200, recurring: { interval: "month", interval_count: 3 } as never }]),
    sub("past_due", [{ unit_amount: 500, recurring: { interval: "month", interval_count: 1 } as never, quantity: 2 }]),
    sub("trialing", [{ unit_amount: 99900, recurring: { interval: "month", interval_count: 1 } as never }]),
    sub("canceled", [{ unit_amount: 99900, recurring: { interval: "month", interval_count: 1 } as never }]),
    sub("active", [{ unit_amount: 1000, currency: "usd", recurring: { interval: "month", interval_count: 1 } as never }]),
  ]);
  // 2900 + 12000/12 + 1200/3 + 500*2 = 2900 + 1000 + 400 + 1000 = 5300
  assert.equal(mrr.get("eur"), 5300);
  assert.equal(mrr.get("usd"), 1000);
  const fmt = { formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}` };
  assert.equal(formatPerCurrency(fmt, mrr), "53.00 EUR + 10.00 USD");
  assert.equal(formatPerCurrency(fmt, new Map()), "—");
});

test("charge badges are sentence-case with refund/dispute precedence", () => {
  const c = (o: Partial<Stripe.Charge>) => ({ status: "succeeded", ...o }) as Stripe.Charge;
  assert.deepEqual(chargeBadge(c({ refunded: true })), { kind: "neutral", text: "Refunded" });
  assert.deepEqual(chargeBadge(c({ amount_refunded: 500 })), { kind: "warn", text: "Partial refund" });
  assert.deepEqual(chargeBadge(c({ disputed: true })), { kind: "error", text: "Disputed" });
  assert.deepEqual(chargeBadge(c({})), { kind: "ok", text: "Succeeded" });
  assert.deepEqual(chargeBadge(c({ status: "failed" })), { kind: "error", text: "Failed" });
  assert.equal(sentence("past_due"), "Past due");
});

// ---- Customer 360 renders the Stripe rail (Insights / Details / Linked accounts) ----

function fakeCustomerCtx(): DashboardCtx {
  const fmt = (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`;
  const stripe = {
    formatAmount: fmt,
    getCustomer: async () => ({
      id: "cus_test1",
      created: 1_700_000_000,
      email: "ada@example.com",
      name: "Ada Lovelace",
      currency: "eur",
      balance: 0,
      delinquent: false,
      tax_exempt: "none",
      preferred_locales: [],
      invoice_settings: { default_payment_method: "pm_1" },
    }),
    listSubscriptions: async () => [
      {
        id: "sub_1",
        status: "active",
        pause_collection: null,
        cancel_at_period_end: false,
        items: {
          data: [
            {
              quantity: 1,
              current_period_end: 1_700_900_000,
              price: {
                id: "price_1",
                nickname: "Postiz Pro",
                product: "prod_1",
                currency: "eur",
                unit_amount: 2900,
                recurring: { interval: "month", interval_count: 1 },
              },
            },
          ],
        },
      },
    ],
    listInvoices: async () => ({
      invoices: [{ id: "in_1", number: "INV-0001", status: "paid", total: 2900, currency: "eur", created: 1_700_000_100 }],
      hasMore: false,
    }),
    listAllPaymentMethods: async () => [
      { id: "pm_1", type: "card", card: { brand: "visa", last4: "4242", exp_month: 7, exp_year: 2027 } },
    ],
    listCreditGrants: async () => [],
    listTaxIds: async () => [],
    listBalanceTransactions: async () => ({ data: [] }),
    getCashBalance: async () => null,
    listCharges: async () => ({
      charges: [
        {
          id: "ch_1",
          status: "succeeded",
          amount: 2900,
          amount_refunded: 500,
          currency: "eur",
          created: 1_700_000_200,
          description: "Subscription creation",
          refunded: false,
          disputed: false,
          payment_intent: "pi_1",
        },
      ],
      hasMore: false,
    }),
  } as unknown as DashboardCtx["stripe"];
  const stores = {
    session: { findDiscordIdsByStripeId: async () => ["111222333"], getSession: async () => ({ postizUserId: "pz_9" }) },
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

test("customer 360: Insights/Details/Linked accounts in the rail, atoms in the main tables", async () => {
  const section = makeCustomersSection();
  const page = await section.buildPage(fakeCustomerCtx(), { page: "customers.detail", params: { id: "cus_test1" } });
  assert.ok(page);
  // PA-8/PA-10 rail: Insights/Details/Tax IDs/Addresses/Linked + Manage.
  const railCard = (title: string) =>
    page!.rail!.find((b) => b.type === "kv" && (b as KeyValueBlock).title?.startsWith(title)) as KeyValueBlock;
  assert.ok(page!.rail && page!.rail.length === 6, "expected a 6-card rail");
  const manage = railCard("Manage");
  assert.equal(manage.title, "Manage");
  // Act-from-customer entries carry the customer into the composers.
  assert.deepEqual((manage.rows[0].cell as { ref?: unknown }).ref, { page: "subscriptions.new", filters: { customer: "cus_test1" } });
  assert.deepEqual((manage.rows[1].cell as { ref?: unknown }).ref, { page: "invoices.new", filters: { customer: "cus_test1" } });
  // Money surfaces + link/delete moved onto the Manage card.
  const manageKeys = (manage.actions ?? []).map((a) => a.key);
  assert.deepEqual(manageKeys, [
    "customer.balance",
    "section:customers.credit_grant",
    "section:customers.link",
    "section:customers.unlink",
    "section:customers.delete",
  ]);
  assert.equal(manage.actions![0].stepUp, true);
  const [insights, details] = page!.rail as KeyValueBlock[];
  const linked = railCard("Linked accounts");
  assert.equal(insights.title, "Insights");
  assert.equal(insights.big, true);
  // Spent = 2900 - 500 refunded; MRR from the active monthly sub; Refunds = 500.
  const insightRows = Object.fromEntries(insights.rows.map((r) => [r.label, r.cell]));
  assert.deepEqual(insightRows.Spent, { t: "text", v: "24.00 EUR" });
  assert.deepEqual(insightRows.MRR, { t: "text", v: "29.00 EUR" });
  assert.deepEqual(insightRows.Refunds, { t: "text", v: "5.00 EUR" });
  assert.equal(details.title, "Details");
  const detailRows = Object.fromEntries(details.rows.map((r) => [r.label, r.cell]));
  assert.deepEqual(detailRows["Customer ID"], { t: "id", v: "cus_test1", copy: true });
  assert.deepEqual(detailRows["Default payment method"], { t: "card", brand: "visa", last4: "4242" });
  assert.equal(linked.title, "Linked accounts");
  assert.equal(linked.rows.length, 2); // Discord + Postiz
  // Header: name title + email subline; no stats block anywhere (moved to rail).
  const header = page!.blocks[0];
  assert.equal(header.type, "header");
  assert.equal((header as { sub?: string }).sub, "ada@example.com");
  assert.ok(!page!.blocks.some((b) => b.type === "stats"));
  // Main tables use the atoms: payments amount cell carries the status pill
  // (+ the PA-4 numeric major value for client-side bulk totals).
  const payments = page!.blocks.find((b) => b.type === "table" && b.key === "charges") as TableBlock;
  assert.deepEqual(payments.rows[0].cells[0], {
    t: "amount",
    v: "29.00 EUR",
    cur: "EUR",
    major: 29,
    badge: { kind: "warn", text: "Partial refund" },
  });
  assert.equal(payments.footer, "1 result — view all");
  const subsTable = page!.blocks.find((b) => b.type === "table" && b.key === "subs") as TableBlock;
  assert.equal(subsTable.rows[0].cells[0].t, "avatar");
});

test("customers list: strong name cell, search filter, N items footer", async () => {
  const ctx = fakeCustomerCtx();
  (ctx.stripe as { listCustomersPage?: unknown }).listCustomersPage = async () => ({
    customers: [
      { id: "cus_a", name: "Ada Lovelace", email: "ada@example.com", created: 1_700_000_000, delinquent: false },
      { id: "cus_b", name: null, email: "grace@example.com", created: 1_700_000_001, delinquent: true },
    ],
    hasMore: true,
  });
  const section = makeCustomersSection();
  const page = await section.buildPage(ctx, { page: "customers" });
  // M7: blocks[0] is now the page header carrying "New customer".
  const header = page!.blocks[0] as HeaderBlock;
  assert.equal(header.actions![0].key, "section:customers.create");
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.deepEqual(table.rows[0].cells[0], { t: "text", v: "Ada Lovelace", strong: true });
  assert.equal(table.filters![0].kind, "search");
  assert.equal(table.footer, "2+ items");
  assert.equal(table.nextCursor, "cus_b");
});

// ---- Security page rail ----

test("security page: factors + emergency in the rail, tables in main", async () => {
  const section = makeSecuritySection({
    credentials: {
      listForUser: async () => [],
      hasPassphrase: async () => true,
    } as unknown as CredentialStore,
    sessions: { listForUser: async () => [] } as unknown as DashboardDbSessions,
    audit: { recent: async () => [] } as unknown as DashboardAudit,
  });
  const ctx = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    settings: { dashboardEpoch: () => 0 } as never,
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => false },
  } as unknown as DashboardCtx;
  const page = await section.buildPage(ctx, { page: "security" });
  assert.ok(page!.rail && page!.rail.length === 2);
  const [factors, emergency] = page!.rail as KeyValueBlock[];
  assert.equal(factors.title, "Sign-in factors");
  assert.equal(emergency.title, "Emergency");
  assert.ok(emergency.actions?.some((a) => a.key === "section:security.signout_everywhere"));
  // The main column keeps the tables + activity, and no kv cards remain there.
  const mainTables = page!.blocks.filter((b) => b.type === "table");
  assert.equal(mainTables.length, 2);
  assert.ok(!page!.blocks.some((b) => b.type === "kv"));
});

// ---- M2: gateway binding resolver (server-derived customer scope) ----

function gatewayFixture(overrides: { discordIds?: string[]; chargeRefunded?: number } = {}) {
  const stripe = {
    getCharge: async (id: string) => ({
      id,
      customer: "cus_bind",
      amount: 2900,
      amount_refunded: overrides.chargeRefunded ?? 0,
      currency: "eur",
    }),
    getPaymentIntent: async (id: string) => ({ id, customer: "cus_pi", currency: "eur" }),
    getSubscription: async (id: string) => ({ id, customer: "cus_sub" }),
    getInvoice: async (id: string) => ({ id, customer: "cus_inv" }),
  } as unknown as StripeClient;
  const sessionStore = {
    findDiscordIdsByStripeId: async () => overrides.discordIds ?? ["disc_1"],
    getPendingChargeReview: async (threadId: string) =>
      threadId === "12345678" ? { threadId, customerId: "disc_rev", chargeId: "ch_r" } : null,
  } as unknown as SessionStore;
  const captured: Array<{ binding: unknown; key: string; params: unknown }> = [];
  const actions = {
    requestScoped: async (binding: unknown, _actor: unknown, key: string, params: unknown) => {
      captured.push({ binding, key, params });
      return { kind: "executed", text: "ok" };
    },
  } as unknown as BillingActionService;
  return { gateway: new DashboardActionGateway(actions, stripe, sessionStore), captured };
}

test("gateway: each action derives its customer from the TARGET, never the client", async () => {
  const { gateway } = gatewayFixture();
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["charge.refund_partial", { chargeId: "ch_1", amountMinor: 500 }, "cus_bind"],
    ["payment_intent.cancel", { paymentIntentId: "pi_1" }, "cus_pi"],
    ["subscription.cancel", { subscriptionId: "sub_1", when: "now" }, "cus_sub"],
    ["subscription.change_plan", { subscriptionId: "sub_1", priceId: "price_1" }, "cus_sub"],
    ["customer.coupon", { subscriptionId: "sub_1", promoCode: "X" }, "cus_sub"],
    ["invoice.void", { invoiceId: "in_1", op: "void" }, "cus_inv"],
    ["invoice.credit_note", { invoiceId: "in_1", amountMinor: 100 }, "cus_inv"],
    ["customer.balance", { customerId: "cus_explicit", deltaMinor: -100, currency: "eur" }, "cus_explicit"],
  ];
  for (const [key, params, expected] of cases) {
    const r = await gateway.resolve(key, params);
    assert.ok(r.ok, `${key} should resolve`);
    assert.equal((r as { binding: { stripeCustomerId: string } }).binding.stripeCustomerId, expected, key);
    assert.equal((r as { binding: { origin: string } }).binding.origin, "dashboard");
  }
  // Hostile shapes are refused before any Stripe call.
  assert.equal((await gateway.resolve("charge.refund_full", { chargeId: "not-a-charge" })).ok, false);
  assert.equal((await gateway.resolve("customer.balance", { customerId: "ch_wrongprefix" })).ok, false);
  assert.equal((await gateway.resolve("nope.unknown", {})).ok, false);
});

test("gateway: amountMajor converts via the charge currency; unlinked full refund rewrites to partial-remaining", async () => {
  const linked = gatewayFixture({ chargeRefunded: 400 });
  const conv = await linked.gateway.resolve("charge.refund_partial", { chargeId: "ch_1", amountMajor: 5 });
  assert.ok(conv.ok);
  assert.equal((conv as { params: { amountMinor?: number } }).params.amountMinor, 500);
  // Linked customer: full refund stays full.
  const full = await linked.gateway.resolve("charge.refund_full", { chargeId: "ch_1" });
  assert.ok(full.ok && (full as { key: string }).key === "charge.refund_full");
  // Unlinked customer: rewritten to a partial refund of the remaining amount.
  const unlinked = gatewayFixture({ discordIds: [], chargeRefunded: 400 });
  const rewritten = await unlinked.gateway.resolve("charge.refund_full", { chargeId: "ch_1" });
  assert.ok(rewritten.ok);
  assert.equal((rewritten as { key: string }).key, "charge.refund_partial");
  assert.deepEqual((rewritten as { params: unknown }).params, { chargeId: "ch_1", amountMinor: 2500 });
});

test("gateway: charge_review binds the ticket thread from the PENDING review row", async () => {
  const { gateway } = gatewayFixture();
  const ok = await gateway.resolve("charge_review", { threadId: "12345678", decision: "approve" });
  assert.ok(ok.ok);
  const binding = (ok as { binding: { ticketThreadId: string | null; discordCustomerId: string | null } }).binding;
  assert.equal(binding.ticketThreadId, "12345678");
  assert.equal(binding.discordCustomerId, "disc_rev");
  assert.deepEqual((ok as { params: unknown }).params, { decision: "approve" });
  const missing = await gateway.resolve("charge_review", { threadId: "99999999", decision: "approve" });
  assert.equal(missing.ok, false);
});

// ---- M2: requestScoped level/queue/execute + idempotency + origin branch ----

function serviceFixture(opts: {
  level: "none" | "approval" | "admin" | "all";
  cancelImpl?: () => Promise<{ id: string; amount: number; currency: string }>;
}) {
  const created: unknown[] = [];
  const executed: string[] = [];
  const failed: string[] = [];
  const approvalRows = new Map<string, BillingApproval>();
  const approvalStore = {
    create: async (input: Record<string, unknown>) => {
      created.push(input);
      // Mirror the real store's column mapping: CreateApprovalInput.params
      // lands in the paramsJson column.
      const row = { id: `apr_${created.length}`, ...input, paramsJson: input.params } as unknown as BillingApproval;
      approvalRows.set(row.id, row);
      return row;
    },
    get: async (id: string) => approvalRows.get(id) ?? null,
    claimForExecution: async () => true,
    markExecuted: async (id: string) => void executed.push(id),
    markFailed: async (id: string) => void failed.push(id),
  } as unknown as ApprovalStore;
  const settings = {
    billingActionLevel: () => opts.level,
    billingAuditChannelId: () => null,
    auditLogChannelId: () => null,
  } as unknown as SettingsStoreType;
  const stripe = {
    formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
    getPaymentIntent: async (id: string) => ({ id, customer: "cus_1", status: "requires_capture", amount: 2900, currency: "eur" }),
    cancelPaymentIntent:
      opts.cancelImpl ?? (async () => ({ id: "pi_1", amount: 2900, currency: "eur" })),
  } as unknown as StripeClient;
  const sessionStore = {
    getSession: async () => null,
    findDiscordIdsByStripeId: async () => [],
  } as unknown as SessionStore;
  const service = new BillingActionService(
    approvalStore,
    settings,
    stripe,
    sessionStore,
    {} as never, // blockService — untouched by payment_intent.cancel
    {} as never, // refundCore — untouched
    { getLinkByConversationId: async () => null } as never, // intercomStore
    { getByThreadId: async () => null } as never, // ticketStore
    { postPanelNote: async () => {} } as never, // intercomExecutor
    { log: async () => {} } as never // audit
  );
  return { service, created, executed, failed };
}

const DASH_BINDING = {
  stripeCustomerId: "cus_1",
  discordCustomerId: null,
  ticketThreadId: null,
  conversationId: null,
  origin: "dashboard" as const,
};
const ADMIN_ACTOR = { kind: "dashboard" as const, id: "42", name: "Ada", isAdmin: true };
const OPERATOR_ACTOR = { kind: "dashboard" as const, id: "43", name: "Ola", isAdmin: false };

test("requestScoped: none denies everyone; approval queues operators (origin=dashboard, no conversation) and executes admins", async () => {
  const none = serviceFixture({ level: "none" });
  const denied = await none.service.requestScoped(DASH_BINDING, ADMIN_ACTOR, "payment_intent.cancel", { paymentIntentId: "pi_1" });
  assert.equal(denied.kind, "denied");

  const approval = serviceFixture({ level: "approval" });
  const queued = await approval.service.requestScoped(DASH_BINDING, OPERATOR_ACTOR, "payment_intent.cancel", { paymentIntentId: "pi_1" });
  assert.equal(queued.kind, "queued");
  const row = approval.created[0] as Record<string, unknown>;
  assert.equal(row.origin, "dashboard");
  assert.equal(row.conversationId, null);
  assert.equal(row.stripeCustomerId, "cus_1");

  const direct = await approval.service.requestScoped(DASH_BINDING, ADMIN_ACTOR, "payment_intent.cancel", { paymentIntentId: "pi_1" });
  assert.equal(direct.kind, "executed");
});

test("requestScoped: ownership revalidation refuses a target owned by another customer", async () => {
  const fx = serviceFixture({ level: "all" });
  const outcome = await fx.service.requestScoped(
    { ...DASH_BINDING, stripeCustomerId: "cus_OTHER" },
    ADMIN_ACTOR,
    "payment_intent.cancel",
    { paymentIntentId: "pi_1" }
  );
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { error: string }).error, /does not belong/);
});

test("requestScoped: concurrent double-submit is serialized by the in-flight guard", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fx = serviceFixture({
    level: "all",
    cancelImpl: async () => {
      await gate;
      return { id: "pi_1", amount: 2900, currency: "eur" };
    },
  });
  const first = fx.service.requestScoped(DASH_BINDING, ADMIN_ACTOR, "payment_intent.cancel", { paymentIntentId: "pi_1" });
  // Let the first request enter execution (claim the flight key) before the second fires.
  await new Promise((r) => setTimeout(r, 20));
  const second = await fx.service.requestScoped(DASH_BINDING, ADMIN_ACTOR, "payment_intent.cancel", { paymentIntentId: "pi_1" });
  assert.equal(second.kind, "failed");
  assert.match((second as { error: string }).error, /already running/);
  release();
  assert.equal((await first).kind, "executed");
});

test("actOnApproval: dashboard-origin approvals rebuild ctx from the row (cross-surface), intercom path untouched", async () => {
  const fx = serviceFixture({ level: "approval" });
  const queued = await fx.service.requestScoped(DASH_BINDING, OPERATOR_ACTOR, "payment_intent.cancel", { paymentIntentId: "pi_1" });
  assert.equal(queued.kind, "queued");
  const approvalId = (queued as { approvalId: string }).approvalId;
  // Non-admin cannot approve.
  const noAuth = await fx.service.actOnApproval(approvalId, OPERATOR_ACTOR, "approve");
  assert.equal(noAuth.kind, "denied");
  // Admin approves — even from another surface (intercom reviewer works too).
  const done = await fx.service.actOnApproval(approvalId, { kind: "intercom", id: "9", name: "Iva", isAdmin: true }, "approve");
  assert.equal(done.kind, "executed");
  assert.deepEqual(fx.executed, [approvalId]);
});

// ---- M2: guardrail dry-run panel ----

function guardrailDeps(opts: {
  maxAmount?: number | null;
  blocked?: boolean;
  refundsIn24h?: number;
  hasStripeRefund?: boolean;
}) {
  return {
    settings: {
      refundMaxAmount: () => opts.maxAmount ?? null,
      refundMaxAmountCurrency: () => "eur",
      refundMaxChargeAgeDays: () => null,
      refundMaxPer24h: () => (opts.refundsIn24h != null ? 5 : null),
      refundMaxPer24hPerUser: () => 2,
      // Member age is Discord-only → any configured value renders "unknown";
      // keep it off so the pass-case verdict stays clean.
      refundMinMemberAgeDays: () => null,
    } as unknown as SettingsStoreType,
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      customerHasAnyRefund: async () => ({ hasRefund: opts.hasStripeRefund ?? false, truncated: false }),
    } as unknown as StripeClient,
    sessionStore: {
      countRefundsSince: async () => opts.refundsIn24h ?? 0,
      countRefundsSinceForUser: async () => 0,
      hasEverBeenRefunded: async () => false,
    } as unknown as SessionStore,
    blockStore: {
      anyBlocked: async () => (opts.blocked ? { kind: "customer_id", reason: "fraud ring" } : null),
    } as unknown as BlockStore,
  };
}

const GUARDRAIL_CHARGE = {
  amount: 2900,
  currency: "eur",
  created: Math.floor(Date.now() / 1000) - 3600,
  customerId: "cus_1",
  email: "a@x.com",
};

test("guardrail panel: trips are counted into the verdict; missing Discord link degrades to uncertain", async () => {
  // Blocked + over-cap → WOULD TRIP (2).
  const tripped = await buildGuardrailPanel(guardrailDeps({ maxAmount: 1000, blocked: true }), GUARDRAIL_CHARGE, "disc_1");
  const verdict = tripped.rows[0];
  assert.equal(verdict.label, "Verdict");
  assert.match((verdict.cell as { b: { text: string } }).b.text, /WOULD TRIP \(2\)/);

  // All checks pass but the per-user cap can't run without a Discord link → uncertain.
  const unknown = await buildGuardrailPanel(guardrailDeps({ maxAmount: 5000 }), GUARDRAIL_CHARGE, null);
  assert.match((unknown.rows[0].cell as { b: { text: string } }).b.text, /uncertain/);

  // Fully linked, everything passes.
  const pass = await buildGuardrailPanel(guardrailDeps({ maxAmount: 5000, refundsIn24h: 1 }), GUARDRAIL_CHARGE, "disc_1");
  assert.match((pass.rows[0].cell as { b: { text: string } }).b.text, /would pass/);
});

// ---- M2: server-side ceremony belts on registry dispatch ----

test("api action: registry keys enforce T1 CONFIRM and T2 fresh-factor server-side", async () => {
  const fake = fakeSettings();
  const gatewayCalls: string[] = [];
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  const stripe = { isTestMode: () => true } as unknown as StripeClient;
  const dashboard = new Dashboard(fake.store, provider, [fakeSection()], {
    stripe,
    settings: fake.store,
    stores: {} as never,
    billing: {
      actions: {} as never,
      gateway: {
        request: async (_a: unknown, key: string) => {
          gatewayCalls.push(key);
          return { kind: "executed", text: "done" };
        },
      } as never,
    },
  });

  // T1: dangerous registry action without CONFIRM is refused before the gateway.
  const noConfirm = await dashboard.api("action", "c", { key: "charge.refund_full", params: { chargeId: "ch_1" } });
  assert.match((noConfirm.json as { error: string }).error, /CONFIRM/);
  // Non-flagged T1 keys (PI cancel) hit the same belt.
  const piNoConfirm = await dashboard.api("action", "c", { key: "payment_intent.cancel", params: { paymentIntentId: "pi_1" } });
  assert.match((piNoConfirm.json as { error: string }).error, /CONFIRM/);
  assert.deepEqual(gatewayCalls, []);
  // With CONFIRM the gateway runs.
  const confirmed = await dashboard.api("action", "c", {
    key: "charge.refund_full",
    params: { chargeId: "ch_1" },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(confirmed.json, { ok: true, text: "done" });
  assert.deepEqual(gatewayCalls, ["charge.refund_full"]);
  // T2: fraud refunds demand a fresh factor (stepUpFresh=false → needsStepUp).
  const t2 = await dashboard.api("action", "c", {
    key: "charge.refund_fraud",
    params: { chargeId: "ch_1", amountMajor: 5 },
    confirmWord: "CONFIRM",
  });
  assert.equal((t2.json as { needsStepUp?: boolean }).needsStepUp, true);
  // Cancel-NOW is T2 as well; period_end is not.
  const cancelNow = await dashboard.api("action", "c", {
    key: "subscription.cancel",
    params: { subscriptionId: "sub_1", when: "now" },
    confirmWord: "CONFIRM",
  });
  assert.equal((cancelNow.json as { needsStepUp?: boolean }).needsStepUp, true);
  assert.deepEqual(gatewayCalls, ["charge.refund_full"]);
});

// ---- M2: payments list/detail rendering ----

function paymentsCtx(): DashboardCtx {
  const charge = (over: Record<string, unknown>): Stripe.Charge =>
    ({
      id: "ch_x",
      status: "succeeded",
      captured: true,
      refunded: false,
      disputed: false,
      amount: 2900,
      amount_refunded: 0,
      currency: "eur",
      created: 1_700_000_000,
      customer: "cus_a",
      billing_details: { email: "a@x.com" },
      payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
      ...over,
    }) as unknown as Stripe.Charge;
  const stripe = {
    formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
    listAllCharges: async () => ({
      charges: [
        charge({ id: "ch_1" }),
        // Partial refund: keeps its badge but does NOT count as "Refunded"
        // (the chip matches Stripe's searchable refunded:"true" = full).
        charge({ id: "ch_2", amount_refunded: 500 }),
        charge({ id: "ch_3", status: "failed", customer: "cus_b", billing_details: { email: "b@x.com" } }),
      ],
      hasMore: false,
    }),
    listAllPaymentIntents: async () => ({
      paymentIntents: [
        { id: "pi_1", status: "requires_payment_method", amount: 4500, currency: "eur", created: 1_700_000_100, customer: "cus_b" },
        { id: "pi_2", status: "succeeded", amount: 100, currency: "eur", created: 1_700_000_200 },
      ],
      hasMore: false,
    }),
    listRecentEarlyFraudWarnings: async () => [{ charge: "ch_2" }],
    getChargeDetailed: async () =>
      charge({ id: "ch_1", amount_refunded: 400, balance_transaction: { fee: 119 } as never }),
    listRefunds: async () => ({
      refunds: [{ id: "re_1", amount: 400, currency: "eur", created: 1_700_050_000, status: "succeeded", reason: null }],
      hasMore: false,
    }),
    getCustomer: async () => ({ id: "cus_a", email: "a@x.com", name: "Ada" }),
    // PA-5 transactions-tab views:
    getBalance: async () => ({ available: [{ amount: 50000, currency: "eur" }], pending: [{ amount: 1000, currency: "eur" }] }),
    listPayouts: async () => ({
      payouts: [
        { id: "po_1", amount: 10000, currency: "eur", status: "pending", method: "standard", description: null, created: 1_699_900_000, arrival_date: 1_700_000_000 },
      ],
      hasMore: false,
    }),
    listTopUps: async () => ({
      topups: [{ id: "tu_1", amount: 5000, currency: "eur", status: "succeeded", description: "wire", created: 1_699_000_000 }],
      hasMore: false,
    }),
    listAccountBalanceTransactions: async () => ({
      transactions: [
        { id: "txn_9", amount: 2900, currency: "eur", fee: 119, net: 2781, type: "charge", available_on: 1_700_100_000, source: "ch_1", created: 1_700_000_000 },
      ],
      hasMore: false,
    }),
  } as unknown as DashboardCtx["stripe"];
  return {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe,
    settings: {} as never,
    stores: {
      block: {
        listPage: async () => ({ rows: [{ kind: "customer_id", value: "cus_a", customerId: "cus_a" }], total: 1 }),
        listForCustomer: async () => [],
      },
      session: { findDiscordIdsByStripeId: async () => [] },
      dispute: { listByCustomer: async () => [] },
      qol: { listNotes: async () => ({ rows: [], total: 0 }), isBookmarked: async () => false },
    } as unknown as DashboardCtx["stores"],
    billing: {
      actions: { effectiveMode: () => "direct" },
      gateway: {} as never,
    } as unknown as DashboardCtx["billing"],
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
}

test("payments list: count-cards over the window, flags, incomplete switches to PI rows", async () => {
  const section = makePaymentsSection();
  const page = await section.buildPage(paymentsCtx(), { page: "payments", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  const counts = Object.fromEntries(table.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(counts.All, 3);
  assert.equal(counts.Succeeded, 2);
  assert.equal(counts.Refunded, 0); // ch_2 is a PARTIAL refund — full refunds only
  assert.equal(counts.Failed, 1);
  assert.equal(counts.Incomplete, 1);
  // ch_1/ch_2 belong to the blocked customer; ch_2 also has an EFW.
  // Columns: [0]amount [1]pm [2]desc [3]customer [4]date [5]refunded [6]decline [7]flags.
  const row2 = table.rows.find((r) => r.id === "ch_2")!;
  const flags = row2.cells[7] as { t: "flags"; badges: Array<{ text: string }> };
  assert.deepEqual(flags.badges.map((b) => b.text).sort(), ["BLOCKED", "EFW"]);
  // Amount cell carries the status pill.
  assert.equal((row2.cells[0] as { badge?: { text: string } }).badge?.text, "Partial refund");
  // Refunded filter = FULLY refunded (chip parity) — the partial ch_2 is out.
  const refunded = await section.buildPage(paymentsCtx(), { page: "payments", filters: { status: "refunded" } });
  assert.equal((refunded!.blocks.find((b) => b.type === "table") as TableBlock).rows.length, 0);
  // Incomplete flips to PaymentIntent rows.
  const incomplete = await section.buildPage(paymentsCtx(), { page: "payments", filters: { status: "incomplete" } });
  const piTable = incomplete!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(piTable.rows.length, 1);
  assert.equal(piTable.rows[0].id, "pi_1");
});

test("payment detail: unlinked customer gets the partial-remaining refund button; breakdown nets fee+refund", async () => {
  const section = makePaymentsSection();
  const page = await section.buildPage(paymentsCtx(), { page: "payments.detail", params: { id: "ch_1" } });
  const header = page!.blocks[0] as HeaderBlock;
  assert.equal(header.titleSuffix, "EUR");
  assert.equal(header.sub, "Charged to Ada");
  const refundBtn = header.actions!.find((a) => a.label === "Refund remaining")!;
  assert.equal(refundBtn.key, "charge.refund_partial");
  assert.deepEqual(refundBtn.params, { chargeId: "ch_1", amountMinor: 2500 });
  // Rail: Details + Customer cards; guardrail dry-run link present.
  assert.equal(page!.rail!.length, 2);
  const details = page!.rail![0] as KeyValueBlock;
  assert.ok(details.rows.some((r) => r.label === "Guardrail dry run"));
  // Breakdown: 2900 − 119 fee − 400 refunded = 2381.
  const breakdown = page!.blocks.find((b) => b.type === "kv" && b.title === "Payment breakdown") as KeyValueBlock;
  const net = breakdown.rows.find((r) => r.label === "Net amount")!;
  assert.equal((net.cell as { v: string }).v, "23.81 EUR");
});

// ---- PA-2: list toolbar + dispute-on-charge ----

test("payments list: Stripe toolbar (select/export/edit-columns) + decline-reason column", async () => {
  const section = makePaymentsSection();
  const page = await section.buildPage(paymentsCtx(), { page: "payments", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.ok(table.selectable && table.exportable && table.editableColumns);
  assert.deepEqual(
    table.columns.map((c) => c.key),
    ["amount", "pm", "desc", "customer", "created", "refunded", "decline", "flags"]
  );
  // Every row carries cells for the new refunded-date (5) + decline (6) columns.
  const row1 = table.rows.find((r) => r.id === "ch_1")!;
  assert.equal(row1.cells.length, 8);
  assert.equal((row1.cells[6] as { v: string }).v, "—");
});

test("charge detail: an open dispute surfaces a banner + Dispute rail card + single Disputed pill", async () => {
  const section = makePaymentsSection();
  const ctx = paymentsCtx();
  (ctx.stripe as unknown as { getChargeDetailed: unknown }).getChargeDetailed = async () => ({
    id: "ch_2",
    status: "succeeded",
    captured: true,
    refunded: false,
    disputed: true,
    amount: 7900,
    amount_refunded: 0,
    currency: "eur",
    created: 1_700_000_000,
    customer: "cus_a",
    payment_method_details: { type: "card", card: { brand: "visa", last4: "0259" } },
  });
  (ctx.stores.dispute as unknown as { listByCustomer: unknown }).listByCustomer = async () => [
    {
      id: "dp_9",
      chargeId: "ch_2",
      customerId: "cus_a",
      amount: 7900,
      currency: "eur",
      reason: "fraudulent",
      status: "needs_response",
      evidenceDueBy: new Date(1_700_300_000 * 1000),
      disputeCreatedAt: new Date(1_700_000_000 * 1000),
    },
  ];
  const page = await section.buildPage(ctx, { page: "payments.detail", params: { id: "ch_2" } });
  // Header shows exactly one "Disputed" pill (no duplicate status+flag).
  const header = page!.blocks[0] as HeaderBlock;
  assert.equal(header.badges!.filter((b) => b.text === "Disputed").length, 1);
  // A dispute banner is present in the main column.
  assert.ok(
    page!.blocks.some((b) => b.type === "notice" && /disputed this payment/i.test((b as { text: string }).text))
  );
  // The right rail carries a Dispute card whose "Respond" row deep-links to the workbench.
  const disputeCard = page!.rail!.find(
    (b) => b.type === "kv" && (b as KeyValueBlock).title === "Dispute"
  ) as KeyValueBlock;
  assert.ok(disputeCard, "expected a Dispute rail card");
  const respond = disputeCard.rows.find((r) => r.label === "Respond")!;
  const respondRef = (respond.cell as unknown as { ref: { page: string; params: { id: string } } }).ref;
  assert.equal(respondRef.page, "disputes.detail");
  assert.equal(respondRef.params.id, "dp_9");
});

// ---- M4: global search ----

function searchFixture(overrides: { customersThrow?: boolean } = {}) {
  const stripe = {
    formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
    searchCustomersByTerm: async () => {
      if (overrides.customersThrow) throw new Error("stripe down");
      return [{ id: "cus_1", name: "Ada Lovelace", email: "ada@x.com" }];
    },
    searchChargesByTerm: async () => [
      { id: "ch_1", amount: 2900, currency: "eur", billing_details: { email: "ada@x.com" } },
    ],
    searchInvoicesByNumber: async () => [{ id: "in_1", number: "INV-0001", total: 2900, currency: "eur", status: "paid" }],
    searchChargesByCardLast4: async (_l4: string, _brand?: string, _limit?: number, _page?: string, status?: string) => ({
      charges:
        status === "failed"
          ? [
              {
                id: "ch_45",
                amount: 100,
                currency: "eur",
                payment_intent: "pi_fail",
                outcome: { seller_message: "Card declined." },
                billing_details: {},
              },
            ]
          : [{ id: "ch_44", amount: 100, currency: "eur", billing_details: {} }],
      nextPage: null,
    }),
    searchPaymentIntentsByAmount: async () => ({
      paymentIntents: [{ id: "pi_9", amount: 2900, currency: "eur", status: "succeeded" }],
      nextPage: null,
    }),
  } as unknown as StripeClient;
  const stores = {
    session: { getSession: async () => ({ stripeCustomerId: "cus_disc" }) },
    dispute: {},
    block: { listPage: async () => ({ rows: [], total: 0 }) },
    qol: { searchNotes: async () => [], listBookmarks: async () => ({ rows: [], total: 0 }) },
  } as unknown as ConstructorParameters<typeof GlobalSearch>[1];
  return new GlobalSearch(stripe, stores);
}

test("global search: id fast-path, last4/amount classification, discord link, failure tolerance", async () => {
  const search = searchFixture();
  // Pasted id → single go-to hit, no fan-out.
  const byId = await search.run("ch_3Tuchi");
  assert.equal(byId.groups.length, 1);
  assert.deepEqual(byId.groups[0].hits[0].ref, { page: "payments.detail", params: { id: "ch_3Tuchi" } });
  // Four digits → last4 hunt group + a failed-only group whose hits carry the
  // PaymentIntent id and decline reason.
  const last4 = await search.run("4242");
  assert.ok(last4.groups.some((g) => g.label === "Payments · card ····4242"));
  const failedGroup = last4.groups.find((g) => g.label === "Failed payments · card ····4242")!;
  assert.ok(failedGroup);
  assert.equal(failedGroup.hits[0].id, "pi_fail");
  assert.equal(failedGroup.hits[0].sub, "Card declined.");
  assert.deepEqual(failedGroup.hits[0].ref, { page: "payments.detail", params: { id: "pi_fail" } });
  // Amount-like → PI amount group.
  const amt = await search.run("29.00");
  assert.ok(amt.groups.some((g) => g.label.includes("amount 29.00")));
  // Free text → customers + payments + invoices.
  const free = await search.run("ada");
  const labels = free.groups.map((g) => g.label);
  assert.ok(labels.includes("Customers") && labels.includes("Payments") && labels.includes("Invoices"));
  // Discord id (local DB) → linked-customer hit.
  const disc = await search.run("123456789012345678");
  const discGroup = disc.groups.find((g) => g.label === "Discord link")!;
  assert.deepEqual(discGroup.hits[0].ref, { page: "customers.detail", params: { id: "cus_disc" } });
  // One Stripe group failing never kills the rest (allSettled).
  const degraded = await searchFixture({ customersThrow: true }).run("ada");
  const degradedLabels = degraded.groups.map((g) => g.label);
  assert.ok(!degradedLabels.includes("Customers") && degradedLabels.includes("Payments"));
});

// ---- M4: Home v1 + Balances rendering ----

function homeCtx(): DashboardCtx {
  const now = Math.floor(Date.now() / 1000);
  return {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      getBalance: async () => ({ available: [{ amount: 12000, currency: "eur" }], pending: [{ amount: 500, currency: "eur" }] }),
      countActiveSubscriptions: async () => ({ count: 100, truncated: true }),
      listEvents: async () => [
        { type: "charge.succeeded", created: now - 60, data: { object: { id: "ch_1", amount: 2900, currency: "eur" } } },
      ],
      listRecentEarlyFraudWarnings: async () => [
        { id: "issfr_1", charge: "ch_2", created: now - 3600, fraud_type: "made_with_stolen_card", actionable: true },
      ],
    } as unknown as DashboardCtx["stripe"],
    settings: {} as never,
    stores: {
      session: { countPendingChargeReviews: async () => 2 },
      dispute: {
        listOpen: async () => ({
          rows: [
            { id: "dp_1", amount: 4500, currency: "eur", reason: "fraudulent", evidenceDueBy: new Date(Date.now() + 24 * 3600_000) },
            { id: "dp_2", amount: 100, currency: "eur", reason: "general", evidenceDueBy: new Date(Date.now() + 200 * 3600_000) },
          ],
          total: 2,
        }),
      },
      block: {},
      qol: {},
    } as unknown as DashboardCtx["stores"],
    billing: {
      actions: {
        pendingPage: async () => ({
          rows: [{ id: "apr_1", summary: "Cancel sub", requestedByName: "Ola", origin: "dashboard", status: "PENDING", createdAt: new Date() }],
          total: 1,
        }),
      },
      gateway: {} as never,
    } as unknown as DashboardCtx["billing"],
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => false },
  } as unknown as DashboardCtx;
}

const fakeMetrics = {
  activeSubsCount: async () => ({ count: 137, truncated: false }),
} as unknown as import("../metrics/HomeMetrics").HomeMetrics;

test("home: stat tiles + needs-attention inbox (due dispute, approval, reviews, EFW) + activity feed + charts", async () => {
  const page = await makeHomeSection({ metrics: fakeMetrics }).buildPage(homeCtx(), { page: "home" });
  const stats = page!.blocks.find((b) => b.type === "stats") as { items: Array<{ label: string; value: string }> };
  const tile = Object.fromEntries(stats.items.map((i) => [i.label, i.value]));
  assert.equal(tile["Available balance"], "120.00 EUR");
  assert.equal(tile["Active subscriptions"], "137"); // real cached count, not the old per-view "100+"
  assert.equal(tile["Open approvals"], "3"); // 1 approval + 2 charge reviews
  // The five M5 charts ride along, honoring the window filter.
  const charts = page!.blocks.filter((b) => b.type === "chart") as Array<{ key: string; window: string }>;
  assert.deepEqual(charts.map((c) => c.key), ["gross_volume", "new_customers", "failed_payments", "mrr_by_plan", "dispute_ratio"]);
  assert.ok(charts.every((c) => c.window === "30d"));
  const inbox = page!.blocks.find((b) => b.type === "table") as TableBlock;
  const ids = inbox.rows.map((r) => r.id);
  // dp_1 due in 24h is in; dp_2 (200h away) is not.
  assert.ok(ids.includes("dispute-dp_1") && !ids.includes("dispute-dp_2"));
  assert.ok(ids.includes("approval-apr_1") && ids.includes("charge-reviews") && ids.includes("efw-issfr_1"));
  const activity = page!.blocks.find((b) => b.type === "timeline") as { items: Array<{ label: string; ref?: unknown }> };
  assert.equal(activity.items[0].label, "Charge succeeded · 29.00 EUR");
  assert.deepEqual(activity.items[0].ref, { page: "payments.detail", params: { id: "ch_1" } });
});

test("balances: buckets, paginated payouts, latest transactions with source links", async () => {
  const ctx = homeCtx();
  (ctx.stripe as { listPayouts?: unknown }).listPayouts = async () => ({
    payouts: [{ id: "po_1", amount: 10000, currency: "eur", status: "in_transit", method: "standard", arrival_date: 1_700_000_000, created: 1_699_900_000 }],
    hasMore: true,
  });
  (ctx.stripe as { listAccountBalanceTransactions?: unknown }).listAccountBalanceTransactions = async () => ({
    transactions: [
      { id: "txn_1", amount: 2900, currency: "eur", fee: 119, net: 2781, type: "charge", available_on: 1_700_000_000, source: "ch_1" },
    ],
    hasMore: false,
  });
  (ctx.stripe as { getAccount?: unknown }).getAccount = async () => ({
    id: "acct_1",
    settings: { payouts: { schedule: { interval: "daily", delay_days: 2 } } },
  });
  const page = await makeBalancesSection().buildPage(ctx, { page: "balances", filters: {} });
  const payouts = page!.blocks.find((b) => b.type === "table" && b.key === "payouts") as TableBlock;
  assert.equal(payouts.nextCursor, "po_1");
  assert.deepEqual(payouts.rows[0].ref, { page: "balances.detail", params: { id: "po_1" } });
  assert.equal((payouts.rows[0].cells[0] as { badge?: { text: string } }).badge?.text, "In transit");
  const txs = page!.blocks.find((b) => b.type === "table" && b.key === "transactions") as TableBlock;
  assert.deepEqual(txs.rows[0].ref, { page: "payments.detail", params: { id: "ch_1" } });
  assert.equal((txs.rows[0].cells[2] as { v: string }).v, "27.81 EUR");
});

test("api search: throttled per actor, delegates to GlobalSearch", async () => {
  const fake = fakeSettings();
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  const stripe = { isTestMode: () => true } as unknown as StripeClient;
  let calls = 0;
  const dashboard = new Dashboard(fake.store, provider, [fakeSection()], {
    stripe,
    settings: fake.store,
    stores: {} as never,
    billing: {} as never,
    search: { run: async (term: string) => { calls++; return { groups: [{ label: "Customers", hits: [{ title: term, ref: { page: "customers" } }] }] }; } } as unknown as GlobalSearch,
  });
  const first = await dashboard.api("search", "c", { term: "ada" });
  assert.equal(first.status, 200);
  assert.equal((first.json as { groups: unknown[] }).groups.length, 1);
  // 30/min per-actor budget: the 31st call inside the window degrades gracefully.
  for (let i = 0; i < 30; i++) await dashboard.api("search", "c", { term: "x" });
  const throttled = await dashboard.api("search", "c", { term: "x" });
  assert.match((throttled.json as { notice?: string }).notice ?? "", /rate limit/);
  assert.equal(calls, 30);
});

test("failed payment: timeline tells the real story (seller message + codes), no breakdown", async () => {
  const ctx = paymentsCtx();
  (ctx.stripe as { getChargeDetailed?: unknown }).getChargeDetailed = async () => ({
    id: "ch_f",
    status: "failed",
    captured: false,
    refunded: false,
    disputed: false,
    amount: 2900,
    amount_refunded: 0,
    currency: "usd",
    created: 1_700_000_000,
    customer: "cus_a",
    billing_details: { email: "a@x.com" },
    payment_method_details: { type: "link" },
    failure_message: "The payment failed.",
    failure_code: "card_declined",
    outcome: { seller_message: "The bank declined this payment.", reason: "insufficient_funds" },
  });
  (ctx.stripe as { listRefunds?: unknown }).listRefunds = async () => ({ refunds: [], hasMore: false });
  const section = makePaymentsSection();
  const page = await section.buildPage(ctx, { page: "payments.detail", params: { id: "ch_f" } });
  const timeline = page!.blocks.find((b) => b.type === "timeline" && b.title === "Recent activity") as {
    items: Array<{ label: string; text?: string }>;
  };
  assert.deepEqual(
    timeline.items.map((i) => i.label),
    ["Payment failed", "Payment started"]
  );
  assert.equal(timeline.items[0].text, "The bank declined this payment. (card_declined / insufficient_funds)");
  // No money moved → no breakdown block, no refund buttons.
  assert.ok(!page!.blocks.some((b) => b.type === "kv" && b.title === "Payment breakdown"));
  const header = page!.blocks[0] as HeaderBlock;
  assert.ok(!header.actions!.some((a) => a.key.startsWith("charge.refund")));
  // Wallet payment renders as a chip cell, labeled Type.
  const pm = page!.blocks.find((b) => b.type === "kv" && b.title === "Payment method") as KeyValueBlock;
  const typeRow = pm.rows.find((r) => r.label === "Type")!;
  assert.deepEqual(typeRow.cell, { t: "card", brand: "link", last4: "" });
});

// ---- M3: subscriptions + invoices ----

function subsCtx(overrides: { previewThrows?: boolean; testMode?: boolean; testClock?: string } = {}): DashboardCtx {
  const sub = {
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
    test_clock: overrides.testClock ?? null,
    discounts: [],
    latest_invoice: "in_9",
    items: {
      data: [
        {
          id: "si_1",
          quantity: 1,
          current_period_end: 1_700_900_000,
          price: {
            id: "price_old",
            nickname: "Postiz Pro",
            product: "prod_1",
            currency: "eur",
            unit_amount: 2900,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
  };
  return {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listAllSubscriptions: async () => ({
        subscriptions: [
          sub,
          { ...sub, id: "sub_2", status: "trialing" },
          { ...sub, id: "sub_3", status: "past_due" },
          { ...sub, id: "sub_4", status: "canceled" },
          { ...sub, id: "sub_5", pause_collection: { behavior: "void" } },
        ],
        hasMore: false,
      }),
      listRecurringPrices: async () => [
        { id: "price_old", nickname: "Postiz Pro", currency: "eur", unit_amount: 2900, recurring: { interval: "month", interval_count: 1 } },
        { id: "price_new", nickname: "Postiz Ultra", currency: "eur", unit_amount: 4900, recurring: { interval: "month", interval_count: 1 } },
      ],
      getSubscription: async () => sub,
      isTestMode: () => overrides.testMode === true,
      getCustomer: async () => ({
        id: "cus_a",
        name: "Ada Lovelace",
        email: "ada@example.com",
        invoice_settings: { default_payment_method: "pm_9" },
      }),
      getPaymentMethod: async () => ({
        id: "pm_9",
        type: "card",
        card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 },
      }),
      previewNewSubscription: async () => {
        if (overrides.previewThrows) throw new Error("currency mismatch");
        return {
          amount_due: 2900,
          currency: "eur",
          lines: { data: [{ id: "il_n", description: "Postiz Pro", amount: 2900, currency: "eur" }] },
        };
      },
      getTestClock: async () => ({ id: overrides.testClock ?? "clock_1", frozen_time: 1_700_000_000 }),
      advanceTestClock: async () => ({ id: overrides.testClock ?? "clock_1", frozen_time: 1_700_000_000 }),
      previewUpcomingInvoice: async () => ({
        amount_due: 2900,
        currency: "eur",
        subtotal: 2900,
        total: 2900,
        next_payment_attempt: 1_700_900_000,
        lines: { data: [{ id: "il_1", description: "Postiz Pro", amount: 2900, currency: "eur", quantity: 1 }] },
      }),
      previewPlanChange: async () => {
        if (overrides.previewThrows) throw new Error("incompatible");
        return {
          amount_due: 1550,
          currency: "eur",
          lines: {
            data: [
              { id: "il_a", description: "Unused time on Postiz Pro", amount: -1400, currency: "eur" },
              { id: "il_b", description: "Remaining time on Postiz Ultra", amount: 2950, currency: "eur" },
            ],
          },
        };
      },
    } as unknown as DashboardCtx["stripe"],
    settings: { allowedPriceIds: () => [] } as never,
    stores: {
      session: { findDiscordIdsByStripeId: async () => ["disc_1"] },
    } as unknown as DashboardCtx["stores"],
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never } as unknown as DashboardCtx["billing"],
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
}

test("subscriptions list: status count-cards incl. paused, avatar rows, customer links", async () => {
  const section = makeSubscriptionsSection();
  const page = await section.buildPage(subsCtx(), { page: "subscriptions", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  const counts = Object.fromEntries(table.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(counts.All, 5);
  assert.equal(counts.Active, 2); // sub_1 + the paused one (status stays active)
  assert.equal(counts.Paused, 1);
  assert.equal(counts.Canceled, 1);
  assert.equal(table.rows[0].cells[0].t, "avatar");
  assert.deepEqual(table.rows[0].ref, { page: "subscriptions.detail", params: { id: "sub_1" } });
  const paused = await section.buildPage(subsCtx(), { page: "subscriptions", filters: { status: "paused" } });
  assert.equal((paused!.blocks.find((b) => b.type === "table") as TableBlock).rows.length, 1);
});

test("subscription detail: stat strip, pricing footer → change-plan page, cancel-now is T2, no direct change-plan button", async () => {
  const section = makeSubscriptionsSection();
  const page = await section.buildPage(subsCtx(), { page: "subscriptions.detail", params: { id: "sub_1" } });
  const header = page!.blocks[0] as HeaderBlock;
  // No change-plan modal anywhere on the detail page — the preview subpage is mandatory.
  assert.ok(!header.actions!.some((a) => a.key === "subscription.change_plan"));
  const cancelNow = header.actions!.find((a) => a.label === "Cancel now")!;
  assert.equal(cancelNow.stepUp, true);
  const stats = page!.blocks.find((b) => b.type === "stats") as { items: Array<{ label: string; value: string }> };
  const strip = Object.fromEntries(stats.items.map((i) => [i.label, i.value]));
  assert.equal(strip["Next invoice"], "29.00 EUR");
  const pricing = page!.blocks.find((b) => b.type === "table" && b.key === "pricing") as TableBlock;
  assert.deepEqual(pricing.footerRef, { page: "subscriptions.changeplan", params: { id: "sub_1" } });
  assert.ok(page!.blocks.some((b) => b.type === "table" && b.key === "upcoming"));
  assert.equal(page!.rail!.length, 2);
});

test("change plan: confirm button exists ONLY after a successful proration preview", async () => {
  const section = makeSubscriptionsSection();
  const hasChangeButton = (page: { blocks: Block[] }): boolean =>
    page.blocks.some(
      (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.change_plan")
    );
  // No target price picked → picker only, no confirm anywhere.
  const picker = await section.buildPage(subsCtx(), { page: "subscriptions.changeplan", params: { id: "sub_1" }, filters: {} });
  assert.ok(!hasChangeButton(picker as never));
  assert.ok(!picker!.blocks.some((b) => b.type === "table" && b.key === "preview"));
  // Target picked → preview table + confirm with baked params.
  const previewed = await section.buildPage(subsCtx(), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { price: "price_new" },
  });
  assert.ok(previewed!.blocks.some((b) => b.type === "table" && b.key === "preview"));
  const confirmBlock = previewed!.blocks.find(
    (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.change_plan")
  ) as { actions: Array<{ key: string; params?: unknown; dangerous?: boolean }> };
  assert.ok(confirmBlock);
  const btn = confirmBlock.actions.find((a) => a.key === "subscription.change_plan")!;
  assert.deepEqual(btn.params, { subscriptionId: "sub_1", priceId: "price_new" });
  assert.equal(btn.dangerous, true);
  // Preview failure → no confirm button.
  const failed = await makeSubscriptionsSection().buildPage(subsCtx({ previewThrows: true }), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { price: "price_new" },
  });
  assert.ok(!hasChangeButton(failed as never));
});

function invoiceCtx(status: string): DashboardCtx {
  const invoice = {
    id: "in_1",
    number: "INV-0001",
    status,
    customer: "cus_a",
    customer_email: "ada@x.com",
    customer_name: "Ada",
    currency: "eur",
    subtotal: 2900,
    total: 2900,
    amount_paid: status === "paid" ? 2900 : 0,
    amount_due: status === "paid" ? 0 : 2900,
    created: 1_700_000_000,
    due_date: 1_700_900_000,
    collection_method: "send_invoice",
    customer_address: { line1: "Unter den Linden 1", city: "Berlin", postal_code: "10117", country: "DE" },
    status_transitions: {
      finalized_at: 1_700_050_000,
      paid_at: status === "paid" ? 1_700_060_000 : null,
      voided_at: null,
      marked_uncollectible_at: null,
    },
    hosted_invoice_url: "https://invoice.stripe.com/i/xyz",
    invoice_pdf: "https://pay.stripe.com/invoice/xyz/pdf",
    total_taxes: [],
    metadata: { order: "42" },
    payment_settings: { payment_method_types: ["card", "link"] },
    parent: { subscription_details: { subscription: "sub_1" } },
    lines: { data: [{ id: "il_1", description: "Postiz Pro", quantity: 1, amount: 2900, currency: "eur" }], has_more: false },
  };
  return {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listInvoicesByStatus: async () => ({ data: [invoice, { ...invoice, id: "in_2", status: "draft" }], has_more: false }),
      getInvoice: async () => invoice,
      listCreditNotes: async () => [{ id: "cn_1", total: 500, currency: "eur", status: "issued", memo: "goodwill", created: 1_700_100_000 }],
    } as unknown as DashboardCtx["stripe"],
    settings: {} as never,
    stores: { session: { findDiscordIdsByStripeId: async () => [] } } as unknown as DashboardCtx["stores"],
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never } as unknown as DashboardCtx["billing"],
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
}

test("invoices list: count-cards + draft builder header action; detail: status-gated lifecycle + hosted URL + rail sub link", async () => {
  const section = makeInvoicesSection();
  const page = await section.buildPage(invoiceCtx("open"), { page: "invoices", filters: {} });
  const header = page!.blocks[0] as HeaderBlock;
  // PA-8: the one-line modal became a link-button into the multi-line composer.
  assert.deepEqual(header.actions![0].ref, { page: "invoices.new" });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  const counts = Object.fromEntries(table.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(counts.All, 2);
  assert.equal(counts.Draft, 1);

  // OPEN invoice: send (T1) + off-session pay (T2) + void/uncollectible + credit note.
  const open = await section.buildPage(invoiceCtx("open"), { page: "invoices.detail", params: { id: "in_1" } });
  const openHeader = open!.blocks[0] as HeaderBlock;
  const labels = openHeader.actions!.map((a) => a.label);
  assert.deepEqual(labels, ["Send invoice", "Collect payment now", "Void", "Mark uncollectible", "Credit note", "Bookmark"]);
  assert.equal(openHeader.actions!.find((a) => a.label === "Collect payment now")!.stepUp, true);
  // Hosted URL renders as an external copy-field.
  const links = open!.blocks.find((b) => b.type === "kv" && b.title === "Links") as KeyValueBlock;
  assert.deepEqual(links.rows[0].cell, { t: "external", v: "Open payment page", href: "https://invoice.stripe.com/i/xyz", copy: true });
  // Rail carries the Basil parent.subscription_details link.
  const details = open!.rail![0] as KeyValueBlock;
  const subRow = details.rows.find((r) => r.label === "Subscription")!;
  assert.deepEqual((subRow.cell as { ref?: unknown }).ref, { page: "subscriptions.detail", params: { id: "sub_1" } });
  // Credit notes + summary + PM chips render.
  assert.ok(open!.blocks.some((b) => b.type === "table" && b.key === "creditnotes"));
  const pmChips = open!.blocks.find((b) => b.type === "kv" && b.title === "Enabled payment methods") as KeyValueBlock;
  assert.deepEqual(pmChips.rows.map((r) => r.cell), [
    { t: "card", brand: "card", last4: "" },
    { t: "card", brand: "link", last4: "" },
  ]);

  // DRAFT invoice: finalize + delete only.
  const draft = await section.buildPage(invoiceCtx("draft"), { page: "invoices.detail", params: { id: "in_1" } });
  assert.deepEqual((draft!.blocks[0] as HeaderBlock).actions!.map((a) => a.key), ["invoice.finalize", "invoice.void", "section:invoices.bookmark"]);
});

test("invoice detail (PA-3): Billing details block + Recent activity timeline", async () => {
  const section = makeInvoicesSection();
  const page = await section.buildPage(invoiceCtx("paid"), { page: "invoices.detail", params: { id: "in_1" } });
  const billing = page!.blocks.find((b) => b.type === "kv" && b.title === "Billing details") as KeyValueBlock;
  assert.ok(billing, "expected a Billing details block");
  assert.equal((billing.rows.find((r) => r.label === "Billed to")!.cell as { v: string }).v, "Ada");
  assert.equal((billing.rows.find((r) => r.label === "Billing method")!.cell as { v: string }).v, "Send invoice");
  assert.equal(
    (billing.rows.find((r) => r.label === "Billing address")!.cell as { v: string }).v,
    "Unter den Linden 1, 10117 Berlin, DE"
  );
  const activity = page!.blocks.find((b) => b.type === "timeline" && b.title === "Recent activity") as TimelineBlock;
  assert.ok(activity, "expected a Recent activity timeline");
  const labels = activity.items.map((i) => i.label);
  assert.ok(labels.includes("Invoice created") && labels.includes("Finalized") && labels.includes("Paid"));
  // Newest-first: Paid is above Invoice created.
  assert.ok(labels.indexOf("Paid") < labels.indexOf("Invoice created"));
});

test("gateway M3: finalize binds via invoice, credit-note amountMajor converts via invoice currency, draft builder folds items", async () => {
  const sessionStore = { findDiscordIdsByStripeId: async () => [] } as unknown as SessionStore;
  const stripe = {
    getInvoice: async () => ({ id: "in_1", customer: "cus_inv", currency: "eur" }),
  } as unknown as StripeClient;
  const gateway = new DashboardActionGateway({} as never, stripe, sessionStore);

  const fin = await gateway.resolve("invoice.finalize", { invoiceId: "in_1" });
  assert.ok(fin.ok && (fin as { binding: { stripeCustomerId: string } }).binding.stripeCustomerId === "cus_inv");

  const note = await gateway.resolve("invoice.credit_note", { invoiceId: "in_1", amountMajor: 5, mode: "credit" });
  assert.ok(note.ok);
  assert.equal((note as { params: { amountMinor?: number } }).params.amountMinor, 500);

  const draft = await gateway.resolve("invoice.create_draft", {
    customerId: "cus_x",
    description: "Consulting",
    amountMajor: 29,
    currency: "EUR",
    finalize: true,
  });
  assert.ok(draft.ok);
  assert.deepEqual((draft as { params: { items?: unknown } }).params.items, [
    { description: "Consulting", amountMinor: 2900, currency: "eur" },
  ]);
  const bad = await gateway.resolve("invoice.create_draft", { customerId: "cus_x", description: "", amountMajor: 0, currency: "eur" });
  assert.equal(bad.ok, false);
});

test("registry invoice.finalize: draft-only revalidation with ownership", async () => {
  const def = actionByKey("invoice.finalize")!;
  assert.equal(def.parseParams({ invoiceId: "nope" }).ok, false);
  const parsed = def.parseParams({ invoiceId: "in_1" });
  assert.ok(parsed.ok);
  const ctx = (status: string, owner: string) =>
    ({
      stripe: { getInvoice: async () => ({ id: "in_1", customer: owner, status }) },
      stripeCustomerId: "cus_1",
    }) as unknown as ActionExecCtx;
  assert.equal(await def.revalidate(ctx("draft", "cus_1"), (parsed as { params: unknown }).params), null);
  assert.match((await def.revalidate(ctx("open", "cus_1"), (parsed as { params: unknown }).params)) ?? "", /only drafts/);
  assert.match((await def.revalidate(ctx("draft", "cus_OTHER"), (parsed as { params: unknown }).params)) ?? "", /does not belong/);
});

test("api belts M3: off-session invoice pay demands a fresh factor; send does not", async () => {
  const fake = fakeSettings();
  const gatewayCalls: string[] = [];
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  const dashboard = new Dashboard(fake.store, provider, [fakeSection()], {
    stripe: { isTestMode: () => true } as unknown as StripeClient,
    settings: fake.store,
    stores: {} as never,
    billing: {
      actions: {} as never,
      gateway: { request: async (_a: unknown, key: string) => { gatewayCalls.push(key); return { kind: "executed", text: "ok" }; } } as never,
    },
  });
  const pay = await dashboard.api("action", "c", {
    key: "invoice.collect",
    params: { invoiceId: "in_1", op: "pay" },
    confirmWord: "CONFIRM",
  });
  assert.equal((pay.json as { needsStepUp?: boolean }).needsStepUp, true);
  const send = await dashboard.api("action", "c", {
    key: "invoice.collect",
    params: { invoiceId: "in_1", op: "send" },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(send.json, { ok: true, text: "ok" });
  assert.deepEqual(gatewayCalls, ["invoice.collect"]);
});

// ---- M5: HomeMetrics + series endpoint + integration refs ----

test("HomeMetrics: daily bucketing, truncation notes, TTL cache + singleflight, dispute-ratio bands", async () => {
  const { HomeMetrics } = await import("../metrics/HomeMetrics");
  const now = Math.floor(Date.now() / 1000);
  let txCalls = 0;
  const stripe = {
    listAccountBalanceTransactions: async () => {
      txCalls++;
      return {
        transactions: [
          { id: "txn_1", amount: 2900, currency: "eur", created: now - 3600, type: "charge" },
          { id: "txn_2", amount: 1100, currency: "eur", created: now - 90000, type: "charge" },
          { id: "txn_3", amount: 500, currency: "usd", created: now - 3600, type: "charge" },
        ],
        hasMore: false,
      };
    },
    listAllCharges: async () => ({
      charges: [
        { id: "ch_1", status: "failed", created: now - 3600 },
        { id: "ch_2", status: "succeeded", created: now - 3600 },
      ],
      hasMore: false,
    }),
    listCustomersPage: async () => ({ customers: [{ id: "cus_1", created: now - 3600 }], hasMore: false }),
    listAllSubscriptions: async () => ({
      subscriptions: [
        {
          id: "sub_1",
          items: {
            data: [
              { quantity: 2, price: { id: "p1", nickname: "Pro", currency: "eur", unit_amount: 2900, recurring: { interval: "month", interval_count: 1 } } },
            ],
          },
        },
      ],
      hasMore: false,
    }),
    countActiveSubscriptions: async () => ({ count: 137, truncated: false }),
    countSucceededCharges: async () => 200,
  } as unknown as StripeClient;
  const settings = { disputeRatioWarnPct: () => 0.75, disputeRatioCriticalPct: () => 1.5 } as unknown as SettingsStoreType;
  const disputes = { countCreatedBetween: async () => 1 } as never;
  const metrics = new HomeMetrics(stripe, settings, disputes);

  const gross = await metrics.series("gross_volume", "7d");
  assert.equal(gross!.unit, "currency");
  assert.equal(gross!.currency, "EUR"); // top-volume currency wins; USD noted
  assert.match(gross!.note ?? "", /USD/);
  assert.equal(gross!.points.length, 7);
  assert.equal(gross!.points[6].v, 29); // today's bucket in major units
  // Cache: a second read within the TTL does not re-hit Stripe.
  await metrics.series("gross_volume", "7d");
  assert.equal(txCalls, 1);

  const failed = await metrics.series("failed_payments", "7d");
  assert.equal(failed!.points.reduce((s, p) => s + p.v, 0), 1);

  const mrr = await metrics.series("mrr_by_plan", "30d");
  assert.deepEqual(mrr!.points[0], { label: "Pro", v: 58 }); // 2 × €29

  const ratio = await metrics.series("dispute_ratio", "30d");
  assert.equal(ratio!.points.length, 6);
  assert.equal(ratio!.points[5].v, 0.5); // 1/200
  assert.deepEqual(ratio!.bands!.map((b) => b.v), [0.75, 1.5]);

  assert.equal(await metrics.series("nope", "30d"), null);
  assert.equal(await metrics.series("gross_volume", "365d"), null);
});

test("api series: validates key/window and serves HomeMetrics", async () => {
  const fake = fakeSettings();
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  const dashboard = new Dashboard(fake.store, provider, [fakeSection()], {
    stripe: { isTestMode: () => true } as unknown as StripeClient,
    settings: fake.store,
    stores: {} as never,
    billing: {} as never,
    metrics: {
      series: async (key: string, window: string) =>
        key === "gross_volume" ? { key, unit: "currency", currency: "EUR", points: [{ label: "07-18", v: 29 }], window } : null,
    } as never,
  });
  const ok = await dashboard.api("series", "c", { key: "gross_volume", window: "7d" });
  assert.equal(ok.status, 200);
  assert.equal((ok.json as { points: unknown[] }).points.length, 1);
  const bad = await dashboard.api("series", "c", { key: "DROP TABLE", window: "7d" });
  assert.equal(bad.status, 404);
});

test("integration refs: change-plan rows self-select via filters; Customer-360 footers link filtered lists", async () => {
  // Change-plan rows navigate to the same page with the price filter applied.
  const picker = await makeSubscriptionsSection().buildPage(subsCtx(), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: {},
  });
  const prices = picker!.blocks.find((b) => b.type === "table" && b.key === "prices") as TableBlock;
  // PA-4: the picker includes the CURRENT price (row 0, marked) so qty/promo/
  // cycle-only updates are possible; every row still self-selects via filters.
  assert.deepEqual(prices.rows.map((r) => r.id), ["price_old", "price_new"]);
  assert.deepEqual(prices.rows[1].ref, {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { price: "price_new" },
  });
  assert.deepEqual(prices.rows[0].cells[1], { t: "badge", b: { kind: "neutral", text: "Current" } });
  assert.ok(prices.filters?.some((f) => f.key === "qty")); // the update knobs ride the filter bar
  // Selected badge appears once a price is picked.
  const picked = await makeSubscriptionsSection().buildPage(subsCtx(), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { price: "price_new" },
  });
  const pickedTable = picked!.blocks.find((b) => b.type === "table" && b.key === "prices") as TableBlock;
  const selectedRow = pickedTable.rows.find((r) => r.id === "price_new")!;
  assert.deepEqual(selectedRow.cells[1], { t: "badge", b: { kind: "info", text: "Selected" } });

  // Customer 360 footers land on customer-filtered lists.
  const customer = await makeCustomersSection().buildPage(fakeCustomerCtx(), {
    page: "customers.detail",
    params: { id: "cus_test1" },
  });
  const payments = customer!.blocks.find((b) => b.type === "table" && b.key === "charges") as TableBlock;
  assert.deepEqual(payments.footerRef, { page: "payments", filters: { customer: "cus_test1" } });
  const subsTable = customer!.blocks.find((b) => b.type === "table" && b.key === "subs") as TableBlock;
  assert.deepEqual(subsTable.footerRef, { page: "subscriptions", filters: { customer: "cus_test1" } });

  // Payments list honors the customer scope via per-customer listings.
  const listedIds: string[] = [];
  const pctx = paymentsCtx();
  (pctx.stripe as { listCharges?: unknown }).listCharges = async (id: string) => {
    listedIds.push(id);
    return { charges: [], hasMore: false };
  };
  (pctx.stripe as { listPaymentIntents?: unknown }).listPaymentIntents = async () => [];
  await makePaymentsSection().buildPage(pctx, { page: "payments", filters: { customer: "cus_a" } });
  assert.deepEqual(listedIds, ["cus_a"]);
});

// ---- M6.1/M6.2: disputes overview / workbench ----

// Real service over fakes: the section tests exercise the SAME code path the
// Discord hub runs (extraction parity is the point of M6.2).
// Faked AI runners + settings for the M6.3 pipelines. draftJson feeds the
// Claude CLI fake's final message; reviewText the light model's.
function fakeAiDeps(opts: { draftJson?: string; reviewText?: string; lightRun?: () => Promise<string[]> } = {}) {
  const seen = { draftPrompts: [] as string[], reviewAttachments: [] as number[] };
  return {
    seen,
    deps: {
      claudeRunner: {
        run: async (prompt: string) => {
          seen.draftPrompts.push(prompt);
          return ["research narration…", opts.draftJson ?? "{}"];
        },
      },
      lightAi: {
        run: async (_prompt: string, _sys: undefined, runOpts: { attachments?: unknown[] }) => {
          seen.reviewAttachments.push(runOpts.attachments?.length ?? 0);
          if (opts.lightRun) return opts.lightRun();
          return [opts.reviewText ?? "Solid package — stage the draft narrative too."];
        },
      },
      intercom: {},
      settingsStore: {
        aiModel: () => "claude-fable-5",
        aiModelLight: () => "claude-haiku-4-5",
        aiEffortAsk: () => "medium",
        aiMaxBudgetUsdAsk: () => 2,
        disputeAutoAttachReceipt: () => false,
        intercomMode: () => "none",
      },
    },
  };
}

function evidenceFakes(
  opts: {
    dispute?: Record<string, unknown>;
    row?: Record<string, unknown> | null;
    claims?: boolean[];
    ai?: ReturnType<typeof fakeAiDeps>["deps"];
    fileContents?: () => Promise<Record<string, unknown>>;
  } = {}
) {
  const nowSec = Math.floor(Date.now() / 1000);
  const dispute = {
    id: "dp_1",
    object: "dispute",
    amount: 4500,
    currency: "eur",
    reason: "fraudulent",
    status: "needs_response",
    charge: "ch_1",
    payment_intent: "pi_1",
    is_charge_refundable: true,
    created: nowSec - 48 * 3600,
    evidence: { product_description: "Staged description", uncategorized_file: "file_1" },
    evidence_details: { due_by: nowSec + 20 * 3600, has_evidence: true, past_due: false, submission_count: 0 },
    payment_method_details: { card: { network_reason_code: "10.4", case_type: "chargeback" } },
    balance_transactions: [],
    ...(opts.dispute ?? {}),
  };
  const calls = {
    update: [] as Array<{ id: string; evidence: Record<string, unknown>; submit: boolean; key: string }>,
    upload: [] as Array<{ name: string; size: number; type: string }>,
    close: [] as string[],
    claims: [] as Array<{ actor: string; id: string; action: string }>,
    releases: [] as string[],
    merged: [] as Array<Record<string, string>>,
    submittedMarks: 0,
  };
  const claims = opts.claims ?? [true, true];
  const stripe = {
    formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
    getDispute: async () => dispute,
    getChargeCustomerId: async () => "cus_a",
    getCharge: async () => ({
      id: "ch_1",
      created: Math.floor(Date.now() / 1000) - 30 * 86400,
      amount: 4500,
      currency: "eur",
      customer: "cus_a",
      description: "Postiz subscription",
      payment_method_details: { card: { brand: "visa", last4: "4242" } },
    }),
    getCustomer: async () => ({
      id: "cus_a",
      email: "grace@example.com",
      name: "Grace Hopper",
      created: Math.floor(Date.now() / 1000) - 90 * 86400,
    }),
    listSubscriptions: async () => [],
    listCharges: async () => ({ charges: [], hasMore: false }),
    getEvidenceFileWithContents: async () =>
      opts.fileContents
        ? opts.fileContents()
        : { filename: "proof.png", sizeBytes: 10, mimeType: "image/png", data: Buffer.from("png"), skipped: null },
    updateDisputeEvidence: async (id: string, evidence: Record<string, unknown>, submit: boolean, key: string) => {
      calls.update.push({ id, evidence, submit, key });
      if (submit && dispute.status === "won") throw new Error("stripe says no");
      return { ...dispute, status: submit ? "under_review" : dispute.status };
    },
    uploadDisputeEvidenceFile: async (name: string, data: Buffer, type: string) => {
      calls.upload.push({ name, size: data.length, type });
      return { id: "file_new" };
    },
    closeDispute: async (id: string) => {
      calls.close.push(id);
      return { ...dispute, status: "lost" };
    },
  };
  const rowState = { row: opts.row === undefined ? disputeRow({}) : opts.row };
  const disputeStore = {
    get: async () => rowState.row,
    mergeEvidenceDraft: async (_id: string, patch: Record<string, string>) => {
      calls.merged.push(patch);
      if (rowState.row) {
        rowState.row.evidenceDraft = { ...((rowState.row.evidenceDraft as Record<string, string>) ?? {}), ...patch };
      }
    },
    markSubmitted: async () => {
      calls.submittedMarks++;
    },
    upsertFromStripe: async (d: { status: string }) => disputeRow({ status: d.status }),
    isWatching: async () => false,
    watch: async () => {},
    unwatch: async () => {},
    countsByStatus: async () => [],
    wonEvidenceExemplars: async () => [],
  };
  const sessionStore = {
    claimBillingAction: async (actor: string, id: string, action: string) => {
      calls.claims.push({ actor, id, action });
      return claims.shift() ?? true;
    },
    releaseBillingAction: async (id: string) => {
      calls.releases.push(id);
    },
  };
  const svc = new DisputeEvidenceService(
    stripe as unknown as StripeClient,
    disputeStore as unknown as ConstructorParameters<typeof DisputeEvidenceService>[1],
    sessionStore as unknown as SessionStore,
    opts.ai as ConstructorParameters<typeof DisputeEvidenceService>[3]
  );
  return { svc, calls, dispute, stripe, disputeStore, sessionStore, rowState };
}

function disputeRow(over: Record<string, unknown>) {
  return {
    id: "dp_1",
    chargeId: "ch_1",
    paymentIntentId: "pi_1",
    customerId: "cus_a",
    amount: 4500,
    currency: "eur",
    reason: "fraudulent",
    status: "needs_response",
    evidenceDueBy: new Date(Date.now() + 20 * 3600_000),
    evidenceDraft: { product_description: "desc" },
    evidenceFinal: null,
    evidenceSubmittedAt: null,
    disputeCreatedAt: new Date(Date.now() - 48 * 3600_000),
    closedAt: null,
    ...over,
  };
}

function disputesCtx(fakes?: ReturnType<typeof evidenceFakes>): DashboardCtx {
  return {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      ...(fakes ? { getDispute: fakes.stripe.getDispute, getChargeCustomerId: fakes.stripe.getChargeCustomerId } : {}),
    } as unknown as DashboardCtx["stripe"],
    settings: {
      disputeRatioWarnPct: () => 0.75,
      disputeRatioCriticalPct: () => 1.5,
      aiModel: () => "claude-fable-5",
      aiModelLight: () => "claude-haiku-4-5",
      aiEffortAsk: () => "medium",
      aiMaxBudgetUsdAsk: () => 2,
    } as never,
    stores: {
      dispute: {
        countsByStatus: async () => [
          { status: "needs_response", count: 2 },
          { status: "warning_needs_response", count: 1 },
          { status: "under_review", count: 1 },
          { status: "won", count: 5 },
          { status: "lost", count: 2 },
        ],
        listOpen: async () => ({
          rows: [
            disputeRow({}),
            disputeRow({ id: "dp_2", status: "under_review" }), // filtered off the board
            disputeRow({ id: "dp_3", status: "warning_needs_response", evidenceDueBy: new Date(Date.now() - 3600_000) }),
          ],
          total: 3,
        }),
        listMirror: async (skip: number, _take: number, filter: { status?: string }, sort: string) => ({
          rows: [disputeRow({ id: `dp_all_${filter?.status ?? "any"}_${sort}_${skip}` })],
          total: 60,
        }),
        openReasons: async () => [{ reason: "fraudulent", count: 3 }],
        closedReasons: async () => [{ reason: "product_not_received", count: 2 }],
        outcomeStats: async () => ({
          won: 5,
          lost: 2,
          other: 1,
          winRatePct: 71.4,
          wonAmount: { eur: 12000 },
          lostAmount: { eur: 4000 },
          lostUnanswered: 1,
        }),
        statsByReason: async () => [{ reason: "fraudulent", won: 4, lost: 1, other: 0, winRatePct: 80 }],
        listClosed: async () => ({ rows: [disputeRow({ id: "dp_c", status: "won", closedAt: new Date() })], total: 7 }),
        get: async (id: string) => (fakes ? fakes.rowState.row : id === "dp_1" ? disputeRow({}) : null),
        ...(fakes
          ? {
              upsertFromStripe: fakes.disputeStore.upsertFromStripe,
              isWatching: fakes.disputeStore.isWatching,
              watch: fakes.disputeStore.watch,
              unwatch: fakes.disputeStore.unwatch,
            }
          : {}),
      },
      qol: {
        isBookmarked: async () => false,
        listNotes: async () => ({ rows: [{ authorName: "Ada", createdAt: new Date(), text: "watch this one" }], total: 1 }),
        addNote: async () => {},
        toggleBookmark: async () => ({ bookmarked: true }),
      },
    } as unknown as DashboardCtx["stores"],
    billing: { actions: { effectiveMode: () => "direct" } } as never,
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
}

// Deps bundle for makeDisputesSection with the real service over the fakes.
function disputesDeps(fakes?: ReturnType<typeof evidenceFakes>) {
  return { ratio: fakeRatio, evidence: (fakes ?? evidenceFakes()).svc };
}

const fakeRatio = {
  get: async () => ({
    computedAt: 1,
    truncated: false,
    month: { succeeded: 900, chargebacks: 8, inquiries: 1, fraudDisputes: 5, efws: 3, vampNumerator: 10, plainPct: 0.89, vampPct: 1.11 },
    d30: { succeeded: 1000, chargebacks: 5, inquiries: 1, fraudDisputes: 3, efws: 2, vampNumerator: 6, plainPct: 0.5, vampPct: 0.6 },
    d90: { succeeded: 3000, chargebacks: 50, inquiries: 2, fraudDisputes: 30, efws: 10, vampNumerator: 55, plainPct: 1.67, vampPct: 1.83 },
  }),
} as unknown as CachedRatioEngine;

test("disputes overview: tabs + level-tinted ratio strip + due-date board (respondable only, urgency badges)", async () => {
  const section = makeDisputesSection(disputesDeps());
  const page = await section.buildPage(disputesCtx(), { page: "disputes", filters: {} });
  const tabs = page!.blocks[0] as { type: string; items: Array<{ label: string; badge?: string }> };
  assert.equal(tabs.type, "tabs");
  assert.equal(tabs.items[0].badge, "3"); // 2 needs_response + 1 warning_needs_response
  const strip = page!.blocks[1] as { items: Array<{ label: string; value: string; badge?: { text: string } }> };
  const byLabel = Object.fromEntries(strip.items.map((i) => [i.label, i]));
  assert.equal(byLabel["This month"].value, "0.89%");
  assert.equal(byLabel["This month"].badge?.text, "warn"); // ≥0.75 warn threshold
  assert.equal(byLabel["Last 30 days"].badge?.text, "ok");
  assert.equal(byLabel["Last 90 days"].badge?.text, "critical"); // ≥1.5
  const board = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.deepEqual(board.rows.map((r) => r.id), ["dp_1", "dp_3"]); // under_review filtered out
  assert.deepEqual(board.rows[0].ref, { page: "disputes.detail", params: { id: "dp_1" } });
  const urgency = board.rows[1].cells[4] as { badges: Array<{ text: string }> };
  assert.equal(urgency.badges[0].text, "OVERDUE");
  assert.equal(await section.navBadge!(disputesCtx()), "3");
});

test("disputes all-tab: status count-cards + reason/sort filters flow into listMirror with offset cursors", async () => {
  const section = makeDisputesSection(disputesDeps());
  const page = await section.buildPage(disputesCtx(), {
    page: "disputes",
    filters: { view: "all", status: "won", sort: "amount" },
    cursor: "25",
  });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  const counts = Object.fromEntries(table.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(counts.All, 11);
  assert.equal(counts.Won, 5);
  // The fake encodes its inputs into the row id — proves filter/sort/offset flowed through.
  assert.equal(table.rows[0].id, "dp_all_won_amount_25");
  assert.equal(table.nextCursor, "50");
  assert.ok(table.filters!.some((f) => f.key === "reason"));
});

test("disputes history-tab: outcome tiles + win-rate-by-reason + closed list; detail is read-only with linked rail", async () => {
  const section = makeDisputesSection(disputesDeps());
  const history = await section.buildPage(disputesCtx(), { page: "disputes", filters: { view: "history" } });
  const tiles = history!.blocks.find((b) => b.type === "stats" && (b as { items: Array<{ label: string }> }).items.some((i) => i.label === "Won")) as {
    items: Array<{ label: string; value: string; sub?: string }>;
  };
  const tile = Object.fromEntries(tiles.items.map((i) => [i.label, i]));
  assert.equal(tile.Won.value, "5");
  assert.equal(tile.Won.sub, "120.00 EUR");
  assert.equal(tile["Win rate"].value, "71%");
  assert.ok(history!.blocks.some((b) => b.type === "table" && b.key === "byreason"));
  assert.ok(history!.blocks.some((b) => b.type === "table" && b.key === "closed"));
});

// ---- M6.2: evidence service extraction parity ----

test("evidence service: catalog covers every TEXT_EVIDENCE_KEY exactly once; recommended groups per reason", () => {
  const catalogKeys = EVIDENCE_GROUPS.flatMap((g) => g.fields.map((f) => f.key)).sort();
  assert.deepEqual(catalogKeys, [...TEXT_EVIDENCE_KEYS].sort());
  assert.equal(new Set(catalogKeys).size, 18);
  assert.deepEqual(recommendedGroupKeys("duplicate"), ["duplicate", "core"]);
  assert.deepEqual(recommendedGroupKeys("product_not_received"), ["core", "shipping"]);
  assert.deepEqual(recommendedGroupKeys("subscription_canceled"), ["core", "policy"]);
  assert.deepEqual(recommendedGroupKeys("fraudulent"), ["core"]);
  assert.equal(EVIDENCE_FILE_SLOTS.length, 6);
});

test("evidence service: saveDraft filters empty/unknown keys; stageFields stages submit:false with the billadmin idempotency prefix", async () => {
  const f = evidenceFakes();
  const { saved } = await f.svc.saveDraft("dp_1", {
    product_description: "  real text  ",
    bogus_key: "nope",
    customer_name: "   ",
  } as Record<string, string>);
  assert.equal(saved, 1);
  assert.deepEqual(f.calls.merged, [{ product_description: "real text" }]);

  await f.svc.stageFields("dp_1", { product_description: "real text" }, "abc123");
  assert.equal(f.calls.update.length, 1);
  assert.equal(f.calls.update[0].submit, false);
  assert.equal(f.calls.update[0].key, "billadmin-dpstage-abc123");
  assert.deepEqual(f.calls.update[0].evidence, { product_description: "real text" });
});

test("evidence service: uploadProof validates slot/type/size and live status; removeFile covers non-slot keys", async () => {
  const f = evidenceFakes();
  const big = Buffer.alloc(4 * 1024 * 1024 + 1);
  assert.equal((await f.svc.uploadProof("dp_1", "receipt", "a.png", big, "image/png", "x")).kind, "invalid");
  assert.equal((await f.svc.uploadProof("dp_1", "receipt", "a.gif", Buffer.from("x"), "image/gif", "x")).kind, "invalid");
  assert.equal((await f.svc.uploadProof("dp_1", "not_a_slot", "a.png", Buffer.from("x"), "image/png", "x")).kind, "invalid");
  const ok = await f.svc.uploadProof("dp_1", "receipt", "a.png", Buffer.from("png"), "image/png; charset=x", "x");
  assert.equal(ok.kind, "ok");
  assert.deepEqual(f.calls.upload, [{ name: "a.png", size: 3, type: "image/png" }]);
  assert.deepEqual(f.calls.update[0].evidence, { receipt: "file_new" });

  // customer_signature is not an upload slot but IS removable (webhook/Dashboard fills).
  const rm = await f.svc.removeFile("dp_1", "customer_signature", "y");
  assert.equal(rm.kind, "ok");
  assert.deepEqual(f.calls.update[1].evidence, { customer_signature: "" });

  const closed = evidenceFakes({ dispute: { status: "under_review" } });
  assert.deepEqual(await closed.svc.uploadProof("dp_1", "receipt", "a.png", Buffer.from("x"), "image/png", "x"), {
    kind: "not_respondable",
    status: "under_review",
  });
});

test("evidence service: submit — status guard, cross-admin claim, markSubmitted, claim release on Stripe failure", async () => {
  const f = evidenceFakes();
  const r1 = await f.svc.submit("dp_1", "42", "cus_a");
  assert.equal(r1.kind, "submitted");
  assert.deepEqual(f.calls.claims, [{ actor: "42", id: "dispute-submit-dp_1", action: "dispute_submit" }]);
  assert.equal(f.calls.update[0].submit, true);
  assert.equal(f.calls.update[0].key, "billadmin-dpsubmit-dp_1");
  assert.equal(f.calls.submittedMarks, 1);

  const lost = evidenceFakes({ claims: [false] });
  assert.equal((await lost.svc.submit("dp_1", "42", null)).kind, "already_claimed");

  const closed = evidenceFakes({ dispute: { status: "lost" } });
  assert.deepEqual(await closed.svc.submit("dp_1", "42", null), { kind: "not_respondable", status: "lost" });
  assert.equal(closed.calls.claims.length, 0); // no claim burned on a dead dispute

  // Stripe failure releases the claim so a retry stays possible.
  const failing = evidenceFakes({ dispute: { status: "needs_response" } });
  failing.stripe.updateDisputeEvidence = async () => {
    throw new Error("stripe down");
  };
  await assert.rejects(() => failing.svc.submit("dp_1", "42", null));
  assert.deepEqual(failing.calls.releases, ["dispute-submit-dp_1"]);
});

test("evidence service: accept claims, closes and upserts; packageFrom computes staged/files/unstaged diff", async () => {
  const f = evidenceFakes();
  const r = await f.svc.accept("dp_1", "42", "cus_a");
  assert.equal(r.kind, "accepted");
  assert.deepEqual(f.calls.claims, [{ actor: "42", id: "dispute-accept-dp_1", action: "dispute_accept" }]);
  assert.deepEqual(f.calls.close, ["dp_1"]);

  const pkg = f.svc.packageFrom(
    f.dispute as never,
    disputeRow({ evidenceDraft: { product_description: "Different draft", customer_name: "Ada" } }) as never
  );
  assert.deepEqual(pkg.textFields, [{ key: "product_description", value: "Staged description" }]);
  assert.deepEqual(pkg.files, [{ slot: "uncategorized_file", fileId: "file_1" }]);
  assert.deepEqual(pkg.unstagedDraft, ["customer_name", "product_description"]);
  assert.equal(pkg.respondable, true);
});

// ---- M6.2: the workbench page + section actions ----

test("dispute workbench: live detail — evidence widget states, submit ceremony, refund-to-prevent baked from the dispute's charge", async () => {
  const fakes = evidenceFakes();
  const section = makeDisputesSection(disputesDeps(fakes));
  const page = await section.buildPage(disputesCtx(fakes), { page: "disputes.detail", params: { id: "dp_1" } });

  const header = page!.blocks[0] as HeaderBlock;
  const byKey = Object.fromEntries(header.actions!.map((a) => [a.key, a]));
  const submit = byKey["section:disputes.submit"];
  assert.ok(submit.dangerous && submit.reverseConfirm);
  assert.deepEqual(submit.params, { disputeId: "dp_1" });
  assert.match(submit.summary!, /1 text field/);
  assert.match(submit.summary!, /exactly one submission/);
  const refund = byKey["charge.refund_full"];
  assert.deepEqual(refund.params, { chargeId: "ch_1" });
  assert.ok(byKey["section:disputes.accept"].reverseConfirm);

  const widget = page!.blocks.find((b) => b.type === "evidence") as EvidenceBlock;
  assert.equal(widget.editable, true);
  assert.equal(widget.disputeId, "dp_1");
  // Recommended (core) group first for reason=fraudulent.
  assert.equal(widget.groups[0].key, "core");
  assert.equal(widget.groups[0].recommended, true);
  const desc = widget.groups[0].fields.find((f) => f.key === "product_description")!;
  // Local draft "desc" differs from staged "Staged description" → draft state.
  assert.equal(desc.state, "draft");
  assert.equal(desc.draft, "desc");
  assert.equal(desc.staged, "Staged description");
  const uncategorized = widget.files.find((s) => s.key === "uncategorized_file")!;
  assert.equal(uncategorized.fileId, "file_1");
  assert.equal(widget.files.filter((s) => !s.fileId).length, 5); // the other upload slots stay offered

  // Unstaged-draft warning notice present (draft differs from staged).
  assert.ok(page!.blocks.some((b) => b.type === "notice" && /not staged at Stripe yet/.test((b as { text: string }).text)));
});

test("dispute workbench: closed dispute renders read-only (submit/accept disabled, widget not editable)", async () => {
  const fakes = evidenceFakes({ dispute: { status: "lost", is_charge_refundable: false }, row: disputeRow({ status: "lost", closedAt: new Date() }) });
  const section = makeDisputesSection(disputesDeps(fakes));
  const page = await section.buildPage(disputesCtx(fakes), { page: "disputes.detail", params: { id: "dp_1" } });
  const header = page!.blocks[0] as HeaderBlock;
  const byKey = Object.fromEntries(header.actions!.map((a) => [a.key, a]));
  assert.ok(byKey["section:disputes.submit"].disabledReason);
  assert.ok(byKey["section:disputes.accept"].disabledReason);
  assert.equal(byKey["charge.refund_full"], undefined);
  const widget = page!.blocks.find((b) => b.type === "evidence") as EvidenceBlock;
  assert.equal(widget.editable, false);
});

test("dispute actions: T3 gating — submit/accept demand the Discord reverse code, then run through the shared claims", async () => {
  const fakes = evidenceFakes();
  const section = makeDisputesSection(disputesDeps(fakes));

  const noReverse = await section.action!(disputesCtx(fakes), {
    key: "section:disputes.submit",
    params: { disputeId: "dp_1" },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(noReverse, { ok: false, needsReverse: true });
  assert.equal(fakes.calls.claims.length, 0);

  const noConfirm = await section.action!(disputesCtx(fakes), { key: "section:disputes.submit", params: { disputeId: "dp_1" } });
  assert.equal(noConfirm.ok, false);
  assert.match(noConfirm.error ?? "", /CONFIRM/);

  const ctxWithReverse = { ...disputesCtx(fakes), reverse: { satisfied: true } } as DashboardCtx;
  const ran = await section.action!(ctxWithReverse, {
    key: "section:disputes.submit",
    params: { disputeId: "dp_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal(ran.ok, true);
  assert.deepEqual(fakes.calls.claims, [{ actor: "42", id: "dispute-submit-dp_1", action: "dispute_submit" }]);

  const accept = await section.action!(ctxWithReverse, {
    key: "section:disputes.accept",
    params: { disputeId: "dp_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal(accept.ok, true);
  assert.deepEqual(fakes.calls.close, ["dp_1"]);
});

test("dispute actions: draft_save validates keys; stage_group stages exactly the drafted group fields", async () => {
  const fakes = evidenceFakes();
  const section = makeDisputesSection(disputesDeps(fakes));
  const ctx = disputesCtx(fakes);

  const bad = await section.action!(ctx, { key: "section:disputes.draft_save", params: { disputeId: "dp_1", key: "not_a_field", value: "x" } });
  assert.equal(bad.ok, false);
  const saved = await section.action!(ctx, {
    key: "section:disputes.draft_save",
    params: { disputeId: "dp_1", key: "customer_name", value: "Grace" },
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(fakes.calls.merged, [{ customer_name: "Grace" }]);

  // stage_group pulls the saved draft server-side — the client sends only the group key.
  const staged = await section.action!(ctx, {
    key: "section:disputes.stage_group",
    params: { disputeId: "dp_1", group: "customer" },
    confirmWord: "CONFIRM",
  });
  assert.equal(staged.ok, true);
  assert.equal(fakes.calls.update.length, 1);
  assert.equal(fakes.calls.update[0].submit, false);
  assert.deepEqual(fakes.calls.update[0].evidence, { customer_name: "Grace" });

  const emptyGroup = await section.action!(ctx, {
    key: "section:disputes.stage_group",
    params: { disputeId: "dp_1", group: "shipping" },
    confirmWord: "CONFIRM",
  });
  assert.equal(emptyGroup.ok, false);
  assert.match(emptyGroup.error ?? "", /Nothing drafted/);
});

test("dispute actions: file_upload takes base64 JSON (validated), file_remove clears the slot", async () => {
  const fakes = evidenceFakes();
  const section = makeDisputesSection(disputesDeps(fakes));
  const ctx = disputesCtx(fakes);

  const up = await section.action!(ctx, {
    key: "section:disputes.file_upload",
    params: {
      disputeId: "dp_1",
      slot: "receipt",
      filename: "../../proof.png",
      contentType: "image/png",
      dataB64: Buffer.from("png-bytes").toString("base64"),
    },
    confirmWord: "CONFIRM",
  });
  assert.equal(up.ok, true);
  assert.deepEqual(fakes.calls.upload, [{ name: ".._.._proof.png", size: 9, type: "image/png" }]);

  const noPayload = await section.action!(ctx, {
    key: "section:disputes.file_upload",
    params: { disputeId: "dp_1", slot: "receipt", filename: "a.png", contentType: "image/png", dataB64: "" },
    confirmWord: "CONFIRM",
  });
  assert.equal(noPayload.ok, false);

  const rm = await section.action!(ctx, {
    key: "section:disputes.file_remove",
    params: { disputeId: "dp_1", slot: "uncategorized_file" },
    confirmWord: "CONFIRM",
  });
  assert.equal(rm.ok, true);
  assert.deepEqual(fakes.calls.update.at(-1)!.evidence, { uncategorized_file: "" });
});

test("disputes review page: staged read-back tables, per-file remove actions, unstaged-draft warning", async () => {
  const fakes = evidenceFakes();
  fakes.rowState.row = disputeRow({ evidenceDraft: { customer_name: "Unstaged Ada" } });
  const section = makeDisputesSection(disputesDeps(fakes));
  const page = await section.buildPage(disputesCtx(fakes), { page: "disputes.review", params: { id: "dp_1" } });

  const fields = page!.blocks.find((b) => b.type === "table" && b.key === "stagedfields") as TableBlock;
  assert.equal(fields.rows.length, 1);
  assert.equal((fields.rows[0].cells[0] as { v: string }).v, "product_description");
  const files = page!.blocks.find((b) => b.type === "table" && b.key === "stagedfiles") as TableBlock;
  assert.equal(files.rows.length, 1);
  assert.equal(files.rows[0].actions![0].key, "section:disputes.file_remove");
  assert.ok(page!.blocks.some((b) => b.type === "notice" && /customer_name/.test((b as { text: string }).text)));
  // Header carries the same submit ceremony as the workbench.
  const header = page!.blocks[0] as HeaderBlock;
  assert.equal(header.actions![0].key, "section:disputes.submit");
});

// ---- M6.3: AI draft + review via the service seams ----

test("AI draft: faked runner — validators drop misshapen values, Stripe-sourced fields override the model, draft merges locally", async () => {
  const ai = fakeAiDeps({
    draftJson: JSON.stringify({
      product_description: "Postiz is a social scheduler…",
      uncategorized_text: "Narrative for the bank.",
      duplicate_charge_id: "the customer paid twice", // not a ch_ id → dropped
      duplicate_charge_explanation: "grace@example.com", // bare email is no explanation → dropped
      customer_email_address: "model-hallucinated@example.com", // overridden by Stripe
    }),
  });
  // reason=duplicate → requested fields = duplicate + core groups (the two
  // validator-guarded duplicate_* fields are in the requested set).
  const f = evidenceFakes({ ai: ai.deps, dispute: { reason: "duplicate" } });
  const result = await f.svc.aiDraft("dp_1", null);
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.rejected.sort(), ["duplicate_charge_explanation", "duplicate_charge_id"]);
  assert.equal(result.model, "claude-fable-5");
  const merged = f.calls.merged[0];
  // Deterministic email/service_date come from Stripe, not the model.
  assert.equal(merged.customer_email_address, "grace@example.com");
  assert.match(merged.service_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(merged.product_description, "Postiz is a social scheduler…");
  assert.equal(merged.uncategorized_text, "Narrative for the bank.");
  assert.equal(merged.duplicate_charge_id, undefined);
  assert.equal(merged.duplicate_charge_explanation, undefined);
  // The prompt carried the dispute + charge grounding.
  assert.match(ai.seen.draftPrompts[0], /dp_1/);
});

test("AI review: staged text + files go to the light model; skipped files reported; nothing_staged early-out", async () => {
  const ai = fakeAiDeps({ reviewText: "Weak: no activity log. Stage the draft." });
  const f = evidenceFakes({ ai: ai.deps });
  const r = await f.svc.aiReview("dp_1");
  assert.equal(r.kind, "ok");
  if (r.kind === "ok") {
    assert.equal(r.review, "Weak: no activity log. Stage the draft.");
    assert.equal(r.stagedFieldCount, 1);
    assert.equal(r.filesAttached, 1);
    assert.equal(r.filesTotal, 1);
    assert.equal(r.model, "claude-haiku-4-5");
  }
  assert.deepEqual(ai.seen.reviewAttachments, [1]);

  const skippy = evidenceFakes({
    ai: fakeAiDeps().deps,
    fileContents: async () => ({ filename: "big.pdf", sizeBytes: 9_999_999, mimeType: "application/pdf", data: null, skipped: "too_large" }),
  });
  const r2 = await skippy.svc.aiReview("dp_1");
  assert.equal(r2.kind, "ok");
  if (r2.kind === "ok") {
    assert.equal(r2.filesAttached, 0);
    assert.deepEqual(r2.skipped, [{ slot: "uncategorized_file", note: "too_large" }]);
  }

  const empty = evidenceFakes({ ai: fakeAiDeps().deps, dispute: { evidence: {}, evidence_details: { has_evidence: false, submission_count: 0 } } });
  assert.deepEqual(await empty.svc.aiReview("dp_1"), { kind: "nothing_staged" });
});

test("dashboard AI actions: per-dispute lock blocks concurrent runs; review verdict renders as kv+notice blocks", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ai = fakeAiDeps({
    lightRun: async () => {
      await gate;
      return ["Verdict: looks fine."];
    },
  });
  const fakes = evidenceFakes({ ai: ai.deps });
  const section = makeDisputesSection(disputesDeps(fakes));
  const ctx = disputesCtx(fakes);

  const first = section.action!(ctx, { key: "section:disputes.ai_review", params: { disputeId: "dp_1" } });
  await new Promise((r) => setImmediate(r)); // let the first run take the lock
  const second = await section.action!(ctx, { key: "section:disputes.ai_review", params: { disputeId: "dp_1" } });
  assert.equal(second.ok, false);
  assert.match(second.error ?? "", /already in progress/);
  release!();
  const done = await first;
  assert.equal(done.ok, true);

  // The verdict survives the reload: detail page renders the AI kv + notice.
  const page = await section.buildPage(ctx, { page: "disputes.detail", params: { id: "dp_1" } });
  const kv = page!.blocks.find((b) => b.type === "kv" && b.title === "AI evidence review") as KeyValueBlock;
  assert.ok(kv);
  assert.deepEqual(kv.rows.find((r) => r.label === "Model")!.cell, { t: "text", v: "claude-haiku-4-5" });
  assert.ok(page!.blocks.some((b) => b.type === "notice" && (b as { text: string }).text === "Verdict: looks fine."));
  // The AI tools row surfaces model + budget from settings.
  const tools = page!.blocks.find((b) => b.type === "notice" && /AI draft researches/.test((b as { text: string }).text)) as {
    actions: Array<{ key: string }>;
    text: string;
  };
  assert.match(tools.text, /claude-fable-5.*\$2.*claude-haiku-4-5/);
  assert.deepEqual(tools.actions.map((a) => a.key), ["section:disputes.ai_draft", "section:disputes.ai_review"]);
});

// ---- M7: fraud hunts ----

test("FraudHuntService: input validation is hard; fingerprint aggregates per customer w/ Discord links; amount hunt keeps declined PIs", async () => {
  const { FraudHuntService } = await import("../../bot/billing/FraudHuntService");
  const last4Statuses: Array<string | undefined> = [];
  const stripe = {
    searchChargesByCardFingerprint: async () => ({
      charges: [
        { customer: "cus_a", billing_details: { email: "a@x.com" } },
        { customer: "cus_a", billing_details: {} },
        { customer: { id: "cus_b" }, billing_details: { email: "b@x.com" } },
      ],
      nextPage: "np",
    }),
    searchChargesByCardLast4: async (_l4: string, _brand?: string, _limit?: number, _page?: string, status?: string) => {
      last4Statuses.push(status);
      const failedCharge = {
        id: "ch_fail",
        status: "failed",
        created: 99,
        payment_intent: "pi_fail",
        outcome: { seller_message: "Your card was declined." },
        customer: "cus_a",
        billing_details: {},
        payment_method_details: { card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2027, fingerprint: "fpA" } },
      };
      return {
        charges:
          status === "failed"
            ? [failedCharge]
            : [
                {
                  customer: "cus_a",
                  billing_details: { email: "a@x.com" },
                  payment_method_details: { card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2027, fingerprint: "fpA" } },
                },
                {
                  customer: "cus_b",
                  billing_details: {},
                  payment_method_details: { card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2027, fingerprint: "fpA" } },
                },
                failedCharge,
              ],
        nextPage: null,
      };
    },
    searchPaymentIntentsByAmount: async (amountMinor: number, currency?: string) => ({
      paymentIntents: [
        {
          id: "pi_ok",
          amount: amountMinor,
          currency: currency ?? "eur",
          status: "succeeded",
          created: 1,
          customer: "cus_a",
          latest_charge: { billing_details: { email: "a@x.com" }, payment_method_details: { card: { brand: "visa", last4: "4242" } } },
        },
        {
          id: "pi_declined",
          amount: amountMinor,
          currency: currency ?? "eur",
          status: "requires_payment_method",
          created: 2,
          customer: null,
          last_payment_error: { message: "Your card was declined." },
          latest_charge: null,
        },
      ],
      nextPage: null,
    }),
  } as unknown as StripeClient;
  const sessionStore = { findDiscordIdsByStripeId: async (id: string) => (id === "cus_a" ? ["111"] : []) } as unknown as SessionStore;
  const hunts = new FraudHuntService(stripe, sessionStore);

  assert.equal((await hunts.usersByFingerprint("bad fp!")).ok, false);
  assert.equal((await hunts.cardsByLast4("12a4")).ok, false);
  assert.equal((await hunts.cardsByLast4("4242", "vi$a")).ok, false);
  assert.equal((await hunts.cardsByLast4("4242", undefined, "declined")).ok, false);
  assert.equal((await hunts.paymentsByAmount("25,39")).ok, false);
  assert.equal((await hunts.paymentsByAmount("25.39", "euro")).ok, false);

  const fp = await hunts.usersByFingerprint("Xt5EWLLDS7FJjR1c");
  assert.ok(fp.ok);
  if (fp.ok) {
    assert.deepEqual(fp.rows, [
      { customerId: "cus_a", email: "a@x.com", count: 2, discordIds: ["111"] },
      { customerId: "cus_b", email: "b@x.com", count: 1, discordIds: [] },
    ]);
    assert.equal(fp.hasMore, true);
  }

  const l4 = await hunts.cardsByLast4("4242", "visa");
  assert.ok(l4.ok);
  if (l4.ok) {
    assert.equal(l4.rows.length, 1);
    assert.equal(l4.rows[0].fingerprint, "fpA");
    assert.deepEqual(l4.rows[0].customers.map((c) => c.id), ["cus_a", "cus_b"]);
    // Failed charges are counted per group and the freshest one is kept with
    // its PaymentIntent + decline reason.
    assert.equal(l4.rows[0].count, 3);
    assert.equal(l4.rows[0].failed, 1);
    assert.deepEqual(l4.rows[0].lastFailure, {
      chargeId: "ch_fail",
      piId: "pi_fail",
      reason: "Your card was declined.",
      created: 99,
    });
  }

  // The status filter reaches the Stripe query (undefined when blank).
  const l4Failed = await hunts.cardsByLast4("4242", undefined, "failed");
  assert.ok(l4Failed.ok);
  if (l4Failed.ok) {
    assert.equal(l4Failed.rows[0].count, 1);
    assert.equal(l4Failed.rows[0].failed, 1);
  }
  assert.deepEqual(last4Statuses, [undefined, "failed"]);

  const amt = await hunts.paymentsByAmount("25.39", "eur");
  assert.ok(amt.ok);
  if (amt.ok) {
    assert.equal(amt.rows[0].id, "pi_ok");
    assert.equal(amt.rows[1].status, "requires_payment_method");
    assert.equal(amt.rows[1].failureReason, "Your card was declined.");
  }
});

test("fraud page: EFW tab default with charge refs; card tab feeds the fingerprint filter into the hunt", async () => {
  const { FraudHuntService } = await import("../../bot/billing/FraudHuntService");
  const huntCalls: string[] = [];
  const stripe = {
    listRecentEarlyFraudWarnings: async () => [
      { id: "issfr_1", charge: "ch_1", actionable: true, fraud_type: "made_with_stolen_card", created: 1 },
    ],
    searchChargesByCardFingerprint: async (fp: string) => {
      huntCalls.push(fp);
      return { charges: [], nextPage: null };
    },
  } as unknown as StripeClient;
  const hunts = new FraudHuntService(stripe, { findDiscordIdsByStripeId: async () => [] } as unknown as SessionStore);
  const { makeFraudSection } = await import("../sections/fraudSection");
  const section = makeFraudSection({ hunts });
  const ctx = { stripe } as unknown as DashboardCtx;

  const efw = await section.buildPage(ctx, { page: "fraud", filters: {} });
  const efwTable = efw!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(efwTable.key, "efws");
  assert.deepEqual(efwTable.rows[0].ref, { page: "payments.detail", params: { id: "ch_1" } });

  await section.buildPage(ctx, { page: "fraud", filters: { view: "card", fp: "Xt5EWLLDS7FJjR1c" } });
  assert.deepEqual(huntCalls, ["Xt5EWLLDS7FJjR1c"]);
});

// ---- M7: blocklist ----

test("blocklist: raw-value add validates hard and runs BlockService; customer add is registry-only; unblock is T1-gated", async () => {
  const { makeBlocklistSection } = await import("../sections/blocklistSection");
  const blockCalls: Array<{ entries: unknown; opts: Record<string, unknown> }> = [];
  const unblockCalls: string[] = [];
  const blockService = {
    block: async (entries: unknown, opts: Record<string, unknown>) => {
      blockCalls.push({ entries, opts });
      return [{ kind: "email", value: "bad@x.com", ok: true, alreadyBlocked: false }];
    },
    unblock: async (id: string) => {
      unblockCalls.push(id);
      return { removed: { kind: "email", value: "bad@x.com", radarItemId: "rsli_1", customerId: null } };
    },
  } as never;
  const section = makeBlocklistSection({ blockService });
  const ctx = {
    actor: { id: "42", name: "Ada", isAdmin: true, role: "admin" },
    billing: { actions: { effectiveMode: () => "direct" } },
    stores: { block: { listPage: async () => ({ rows: [], total: 0 }) } },
    audit: async () => {},
  } as unknown as DashboardCtx;

  const noConfirm = await section.action!(ctx, {
    key: "section:blocklist.add",
    params: { kind: "email", value: "bad@x.com", reason: "fraud ring" },
  });
  assert.equal(noConfirm.ok, false);

  const badIp = await section.action!(ctx, {
    key: "section:blocklist.add",
    params: { kind: "ip_address", value: "999.1.2.3", reason: "r" },
    confirmWord: "CONFIRM",
  });
  assert.equal(badIp.ok, false);

  const customerKind = await section.action!(ctx, {
    key: "section:blocklist.add",
    params: { kind: "customer_id", value: "cus_x", reason: "r" },
    confirmWord: "CONFIRM",
  });
  assert.equal(customerKind.ok, false);
  assert.match(customerKind.error ?? "", /Block customer/);

  const added = await section.action!(ctx, {
    key: "section:blocklist.add",
    params: { kind: "email", value: "bad@x.com", reason: "fraud ring" },
    confirmWord: "CONFIRM",
  });
  assert.equal(added.ok, true);
  assert.equal(blockCalls.length, 1);
  assert.deepEqual(blockCalls[0].entries, [{ kind: "email", value: "bad@x.com" }]);
  assert.equal(blockCalls[0].opts.cancelSubs, false);

  const rmNoConfirm = await section.action!(ctx, { key: "section:blocklist.remove", params: { id: "row1" } });
  assert.equal(rmNoConfirm.ok, false);
  const rm = await section.action!(ctx, { key: "section:blocklist.remove", params: { id: "row1" }, confirmWord: "CONFIRM" });
  assert.equal(rm.ok, true);
  assert.deepEqual(unblockCalls, ["row1"]);

  // The page renders the registry customer.block header button (T2 step-up).
  const page = await section.buildPage(ctx, { page: "blocklist", filters: {} });
  const header = page!.blocks[0] as HeaderBlock;
  const custBtn = header.actions!.find((a) => a.key === "customer.block")!;
  assert.ok(custBtn.stepUp && custBtn.dangerous);
});

// ---- M7: catalog ----

test("catalog: products render avatar+default price with cursoring; coupon delete demands CONFIRM; create validates percent XOR amount", async () => {
  const { makeCatalogSection } = await import("../sections/catalogSection");
  const deleted: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const ctx = {
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listProducts: async (opts: { startingAfter?: string }) => ({
        products: [
          {
            id: "prod_1",
            name: "Postiz Pro",
            description: "The scheduler",
            active: true,
            created: 1,
            default_price: { unit_amount: 2900, currency: "eur", recurring: { interval: "month", interval_count: 1 } },
          },
        ],
        hasMore: true,
        _startedAfter: opts.startingAfter,
      }),
      listAllActivePrices: async () => [],
      listCoupons: async () => [
        { id: "SUMMER", name: "Summer", percent_off: 25, duration: "once", times_redeemed: 3, valid: true },
      ],
      deleteCoupon: async (id: string) => {
        deleted.push(id);
      },
      createCoupon: async (params: Record<string, unknown>) => {
        created.push(params);
        return { id: "NEW", duration: "once", percent_off: 10, times_redeemed: 0, valid: true };
      },
    },
    audit: async () => {},
  } as unknown as DashboardCtx;
  const section = makeCatalogSection();

  const products = await section.buildPage(ctx, { page: "catalog", filters: {} });
  const table = products!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.key, "products");
  assert.deepEqual(table.rows[0].ref, { page: "catalog.detail", params: { id: "prod_1" } });
  assert.equal((table.rows[0].cells[1] as { v: string }).v, "29.00 EUR / month");
  assert.equal(table.nextCursor, "prod_1");

  const coupons = await section.buildPage(ctx, { page: "catalog", filters: { view: "coupons" } });
  const couponTable = coupons!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(couponTable.rows[0].actions![0].key, "section:catalog.coupon_delete");
  assert.ok(couponTable.rows[0].actions![0].dangerous);

  const delNoConfirm = await section.action!(ctx, { key: "section:catalog.coupon_delete", params: { id: "SUMMER" } });
  assert.equal(delNoConfirm.ok, false);
  assert.deepEqual(deleted, []);
  const del = await section.action!(ctx, { key: "section:catalog.coupon_delete", params: { id: "SUMMER" }, confirmWord: "CONFIRM" });
  assert.equal(del.ok, true);
  assert.deepEqual(deleted, ["SUMMER"]);

  const both = await section.action!(ctx, {
    key: "section:catalog.coupon_create",
    params: { percentOff: "25", amountOff: "12.50 eur" },
  });
  assert.equal(both.ok, false);
  const good = await section.action!(ctx, { key: "section:catalog.coupon_create", params: { percentOff: "25", duration: "repeating:3" } });
  assert.equal(good.ok, true);
  assert.equal(created[0].percentOff, 25);
  assert.equal(created[0].durationInMonths, 3);
});

test("catalog (PA-3): products without default_price show a grouped price + 'N prices'; product detail gets an Insights/MRR rail + per-price sub counts", async () => {
  const { makeCatalogSection } = await import("../sections/catalogSection");
  const priceA = { id: "price_a", product: "prod_2", unit_amount: 1500, currency: "eur", active: true, recurring: { interval: "month", interval_count: 1 } };
  const priceB = { id: "price_b", product: "prod_2", unit_amount: 15000, currency: "eur", active: true, recurring: { interval: "year", interval_count: 1 } };
  const ctx = {
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listProducts: async () => ({
        products: [{ id: "prod_2", name: "Team", active: true, created: 1, default_price: null }],
        hasMore: false,
      }),
      listAllActivePrices: async () => [priceA, priceB],
      getProduct: async () => ({ id: "prod_2", name: "Team", active: true, created: 1, description: "Team plan", metadata: {} }),
      listPricesForProduct: async () => [priceA],
      countActiveSubscriptionsByPrice: async () => ({ counts: new Map([["price_a", 4]]), scanned: 4, truncated: false }),
    },
    audit: async () => {},
  } as unknown as DashboardCtx;
  const section = makeCatalogSection();

  // List: no default_price → grouped first price + "· N prices".
  const list = await section.buildPage(ctx, { page: "catalog", filters: {} });
  const table = list!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal((table.rows[0].cells[1] as { v: string }).v, "15.00 EUR / month · 2 prices");

  // Detail: Insights rail (MRR = 15.00 × 4 = 60.00) + per-price sub count column.
  const detail = await section.buildPage(ctx, { page: "catalog.detail", params: { id: "prod_2" } });
  const insights = detail!.rail!.find((b) => b.type === "kv" && (b as KeyValueBlock).title === "Insights") as KeyValueBlock;
  assert.ok(insights, "expected an Insights rail card");
  assert.equal((insights.rows.find((r) => r.label === "MRR")!.cell as { v: string }).v, "60.00 EUR");
  assert.equal((insights.rows.find((r) => r.label === "Active subscriptions")!.cell as { v: string }).v, "4");
  const priceTable = detail!.blocks.find((b) => b.type === "table" && b.key === "prices") as TableBlock;
  assert.equal((priceTable.rows[0].cells[2] as { v: string }).v, "4 active");
});

// ---- M7: customer editing ----

test("customer editing: create/update validation, '-' clears, delete is T1+T3 and unlinks Discord afterwards", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  let unlinked = 0;
  const ctx = {
    actor: { id: "42", name: "Ada", isAdmin: true, role: "admin" },
    stripe: {
      createCustomer: async (p: Record<string, unknown>) => ({ id: "cus_new", ...p }),
      updateCustomer: async (_id: string, p: Record<string, unknown>) => {
        updates.push(p);
        return {};
      },
      deleteCustomer: async (id: string) => {
        deleted.push(id);
      },
    },
    stores: {
      session: {
        updateStripeCustomerId: async () => true,
        unlinkStripeCustomerEverywhere: async () => {
          unlinked++;
          return 2;
        },
      },
    },
    audit: async () => {},
  } as unknown as DashboardCtx;
  const section = makeCustomersSection();

  const noIdentity = await section.action!(ctx, { key: "section:customers.create", params: {} });
  assert.equal(noIdentity.ok, false);
  const createdOk = await section.action!(ctx, { key: "section:customers.create", params: { email: "g@x.com" } });
  assert.equal(createdOk.ok, true);
  assert.match(createdOk.text ?? "", /cus_new/);

  const upd = await section.action!(ctx, {
    key: "section:customers.update",
    params: { customerId: "cus_1", name: "Grace", description: "-" },
  });
  assert.equal(upd.ok, true);
  assert.deepEqual(updates[0], { name: "Grace", description: "" });

  const badLink = await section.action!(ctx, {
    key: "section:customers.link",
    params: { customerId: "cus_1", discordUserId: "abc" },
    confirmWord: "CONFIRM",
  });
  assert.equal(badLink.ok, false);

  const delNoReverse = await section.action!(ctx, {
    key: "section:customers.delete",
    params: { customerId: "cus_1" },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(delNoReverse, { ok: false, needsReverse: true });
  assert.deepEqual(deleted, []);

  const ctxReverse = { ...ctx, reverse: { satisfied: true } } as DashboardCtx;
  const del = await section.action!(ctxReverse, {
    key: "section:customers.delete",
    params: { customerId: "cus_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal(del.ok, true);
  assert.deepEqual(deleted, ["cus_1"]);
  assert.equal(unlinked, 1);
});

// ---- M7: bookmarks board ----

test("bookmarks board: rows deep-link by object type and Remove toggles off", async () => {
  const { makeBookmarksSection } = await import("../sections/bookmarksSection");
  const toggles: Array<[string, string]> = [];
  const ctx = {
    actor: { id: "42", name: "Ada", isAdmin: true, role: "admin" },
    stores: {
      qol: {
        listBookmarks: async () => ({
          rows: [
            { id: "b1", objectType: "dispute", objectId: "dp_1", label: "45.00 EUR · fraudulent", addedByName: "Ada", createdAt: new Date() },
            { id: "b2", objectType: "charge", objectId: "ch_9", label: null, addedByName: "Bob", createdAt: new Date() },
          ],
          total: 2,
        }),
        toggleBookmark: async (type: string, id: string) => {
          toggles.push([type, id]);
          return { bookmarked: false };
        },
      },
    },
  } as unknown as DashboardCtx;
  const section = makeBookmarksSection();
  const page = await section.buildPage(ctx, { page: "bookmarks", filters: {} });
  const table = page!.blocks[0] as TableBlock;
  assert.deepEqual(table.rows[0].ref, { page: "disputes.detail", params: { id: "dp_1" } });
  assert.deepEqual(table.rows[1].ref, { page: "payments.detail", params: { id: "ch_9" } });
  const removed = await section.action!(ctx, { key: "section:bookmarks.remove", params: { type: "dispute", id: "dp_1" } });
  assert.equal(removed.ok, true);
  assert.deepEqual(toggles, [["dispute", "dp_1"]]);
});

test("client JS modules parse and the shell embeds them nonced", () => {
  const combined = `${clientCore}\n${clientBlocks}\n${clientModal}\n${clientPalette}\n${clientPeek}\n${clientCharts}\n${clientEvidence}\n${clientLogin}\nD.defaultPage="home";\n${clientApp}`;
  assert.doesNotThrow(() => new Function(combined));

  const html = renderDashboardShell({ nonce: "test-nonce-123" });
  assert.ok(html.includes('<style nonce="test-nonce-123">'));
  assert.ok(html.includes('<script nonce="test-nonce-123">'));
  assert.ok(html.includes('id="lock"'));
  assert.ok(html.includes('id="login"'));
  assert.ok(html.includes('id="stepup"'));
  assert.ok(html.includes('id="modal"'));
  // PA-13 chrome: bell, hamburger + scrim, help dialog, peek module.
  assert.ok(html.includes('id="bellbtn"'));
  assert.ok(html.includes('id="menubtn"'));
  assert.ok(html.includes('id="scrim"'));
  assert.ok(html.includes('id="helpmodal"'));
  assert.ok(html.includes("D.peekTarget"));
  // No unresolved template interpolations leaked into the page.
  assert.ok(!html.includes("${"));
});

// ---- PA-4: subscription writes + enablers ----

test("subscription detail (PA-4): 'Customer on Product' title, pm brand+last4, si_ id column, upcoming totals ladder, Simulation only in test mode", async () => {
  const section = makeSubscriptionsSection();
  const page = await section.buildPage(subsCtx(), { page: "subscriptions.detail", params: { id: "sub_1" } });
  const header = page!.blocks[0] as HeaderBlock;
  assert.equal(header.title, "Ada Lovelace on Postiz Pro");
  assert.equal(page!.title, "Ada Lovelace on Postiz Pro");
  // Pricing table surfaces the subscription-item id.
  const pricing = page!.blocks.find((b) => b.type === "table" && b.key === "pricing") as TableBlock;
  assert.equal(pricing.columns[pricing.columns.length - 1].key, "id");
  const idCellV = pricing.rows[0].cells[pricing.rows[0].cells.length - 1] as { t: string; v: string };
  assert.equal(idCellV.t, "id");
  assert.equal(idCellV.v, "si_1");
  assert.equal(pricing.footer, "Update subscription (proration preview)");
  // Payment method resolves to brand+last4 via the customer default (never a raw pm_ id).
  const details = page!.rail![0] as KeyValueBlock;
  const pmRow = details.rows.find((r) => r.label === "Payment method")!;
  assert.equal((pmRow.cell as { t: string }).t, "card");
  assert.equal((pmRow.cell as { brand: string; last4: string }).brand, "visa");
  // Upcoming invoice: line rows then the Subtotal/Total/Amount-due ladder.
  const upcoming = page!.blocks.find((b) => b.type === "table" && b.key === "upcoming") as TableBlock;
  assert.deepEqual(upcoming.columns.map((c) => c.key), ["desc", "qty", "amount"]);
  const rowIds = upcoming.rows.map((r) => r.id);
  assert.ok(rowIds.includes("t_subtotal") && rowIds.includes("t_total") && rowIds.includes("t_due"));
  // Live mode: no Simulation card.
  assert.ok(!page!.rail!.some((b) => b.type === "kv" && (b as KeyValueBlock).title === "Simulation"));
  // Test mode + clock: Simulation card with the advance action.
  const testPage = await section.buildPage(subsCtx({ testMode: true, testClock: "clock_1" }), {
    page: "subscriptions.detail",
    params: { id: "sub_1" },
  });
  const sim = testPage!.rail!.find((b) => b.type === "kv" && (b as KeyValueBlock).title === "Simulation") as KeyValueBlock;
  assert.ok(sim);
  assert.equal(sim.actions![0].key, "section:subscriptions.clock_advance");
});

test("subscriptions list (PA-4): header carries a Create-subscription link-button", async () => {
  const section = makeSubscriptionsSection();
  const page = await section.buildPage(subsCtx(), { page: "subscriptions", filters: {} });
  const header = page!.blocks[0] as HeaderBlock;
  const create = header.actions!.find((a) => a.label === "Create subscription")!;
  assert.deepEqual(create.ref, { page: "subscriptions.new" });
});

test("update subscription (PA-4): qty/promo/cycle ride the preview and the confirm params; current price alone is refused", async () => {
  const ctx = subsCtx();
  const seen: { args?: Record<string, unknown> } = {};
  (ctx.stripe as unknown as Record<string, unknown>).previewPlanChange = async (args: Record<string, unknown>) => {
    seen.args = args;
    return { amount_due: 8850, currency: "eur", lines: { data: [{ id: "il_a", description: "delta", amount: 5950, currency: "eur" }] } };
  };
  const section = makeSubscriptionsSection();
  const page = await section.buildPage(ctx, {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { price: "price_new", qty: "3", promo: "SAVE20", cycle: "now" },
  });
  assert.ok(seen.args);
  assert.equal(seen.args.quantity, 3);
  assert.equal(seen.args.billingCycleAnchor, "now");
  const confirm = page!.blocks.find(
    (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.change_plan")
  ) as { actions: Array<{ key: string; params?: Record<string, unknown> }> };
  assert.ok(confirm);
  assert.deepEqual(confirm.actions[0].params, {
    subscriptionId: "sub_1",
    priceId: "price_new",
    quantity: 3,
    promoCode: "SAVE20",
    cycleAnchor: "now",
  });
  // Current price with no other delta → NO CHANGE notice, no confirm button.
  const noop = await section.buildPage(subsCtx(), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { price: "price_old" },
  });
  assert.ok(!noop!.blocks.some((b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.change_plan")));
  assert.ok(noop!.blocks.some((b) => b.type === "notice" && (b as NoticeBlock).badge.text === "NO CHANGE"));
  // Qty-only update against the current price IS a valid change set.
  const qtyOnly = await section.buildPage(subsCtx(), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { qty: "5" },
  });
  const qtyConfirm = qtyOnly!.blocks.find(
    (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.change_plan")
  ) as { actions: Array<{ key: string; params?: Record<string, unknown> }> };
  assert.ok(qtyConfirm, "qty-only change must be confirmable");
  assert.deepEqual(qtyConfirm.actions[0].params, { subscriptionId: "sub_1", priceId: "price_old", quantity: 5 });
});

test("create-subscription composer (PA-4): confirm exists ONLY after a successful first-invoice preview; charge collection is step-up", async () => {
  const section = makeSubscriptionsSection();
  const hasCreate = (page: { blocks: Block[] }): boolean =>
    page.blocks.some((b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.create"));
  // No customer picked → price table renders, no preview/confirm.
  const empty = await section.buildPage(subsCtx(), { page: "subscriptions.new", filters: {} });
  assert.ok(empty!.blocks.some((b) => b.type === "table" && (b as TableBlock).key === "prices"));
  assert.ok(!hasCreate(empty as never));
  // Customer + price → customer card, preview table, confirm with baked params + stepUp (charge collection).
  const ready = await section.buildPage(subsCtx(), {
    page: "subscriptions.new",
    filters: { customer: "cus_a", price: "price_new", qty: "2", trial: "14" },
  });
  assert.ok(ready!.blocks.some((b) => b.type === "kv" && (b as KeyValueBlock).title === "Customer"));
  assert.ok(ready!.blocks.some((b) => b.type === "table" && (b as TableBlock).key === "preview"));
  const confirm = ready!.blocks.find(
    (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.create")
  ) as { actions: Array<{ key: string; params?: Record<string, unknown>; stepUp?: boolean; dangerous?: boolean }> };
  const btn = confirm.actions[0];
  assert.equal(btn.dangerous, true);
  assert.equal(btn.stepUp, true);
  assert.deepEqual(btn.params, { customerId: "cus_a", priceId: "price_new", quantity: 2, trialDays: 14, collection: "charge" });
  // Invoice collection → no step-up flag.
  const invoiceMode = await section.buildPage(subsCtx(), {
    page: "subscriptions.new",
    filters: { customer: "cus_a", price: "price_new", collection: "invoice" },
  });
  const invBtn = (invoiceMode!.blocks.find(
    (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.create")
  ) as { actions: Array<{ key: string; params?: Record<string, unknown>; stepUp?: boolean }> }).actions[0];
  assert.ok(!invBtn.stepUp);
  assert.equal((invBtn.params as { collection: string }).collection, "invoice");
  // Preview failure → no confirm.
  const failed = await section.buildPage(subsCtx({ previewThrows: true }), {
    page: "subscriptions.new",
    filters: { customer: "cus_a", price: "price_new" },
  });
  assert.ok(!hasCreate(failed as never));
});

test("test-clock advance (PA-4): refused on live keys; advances frozen_time by days on test keys", async () => {
  const section = makeSubscriptionsSection();
  const live = await section.action!(subsCtx({ testClock: "clock_1" }), {
    key: "section:subscriptions.clock_advance",
    params: { id: "sub_1", days: 30 },
  });
  assert.equal(live.ok, false);
  const ctx = subsCtx({ testMode: true, testClock: "clock_1" });
  const advanced: Array<[string, number]> = [];
  (ctx.stripe as unknown as Record<string, unknown>).advanceTestClock = async (clockId: string, frozen: number) => {
    advanced.push([clockId, frozen]);
    return { id: clockId, frozen_time: frozen };
  };
  const ok = await section.action!(ctx, { key: "section:subscriptions.clock_advance", params: { id: "sub_1", days: 30 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(advanced, [["clock_1", 1_700_000_000 + 30 * 86400]]);
});

test("payments list (PA-4/5): transactions tab row is a filter-driven view switch; bulk refund rides bulkActions (hidden when denied)", async () => {
  const section = makePaymentsSection();
  const page = await section.buildPage(paymentsCtx(), { page: "payments", filters: {} });
  const tabs = page!.blocks.find((b) => b.type === "tabs") as TabsBlock;
  assert.ok(tabs, "expected a tabs block");
  assert.equal(tabs.key, "txview");
  assert.deepEqual(tabs.items.map((i) => i.label), ["Payments", "Payouts", "Top-ups", "All activity"]);
  assert.deepEqual(tabs.items.map((i) => i.value), ["", "payouts", "topups", "activity"]);
  assert.ok(tabs.items.every((i) => i.ref === undefined)); // PA-5: real views, no forward refs
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.bulkActions!.length, 1);
  assert.equal(table.bulkActions![0].key, "section:payments.bulk_refund");
  assert.equal(table.bulkActions![0].dangerous, true);
  // Refunds disabled by /config → the bulk button disappears entirely.
  const deniedCtx = paymentsCtx();
  (deniedCtx.billing.actions as unknown as Record<string, unknown>).effectiveMode = () => "denied";
  const deniedPage = await section.buildPage(deniedCtx, { page: "payments", filters: {} });
  const deniedTable = deniedPage!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(deniedTable.bulkActions, undefined);
});

test("bulk refund (PA-4): typed CONFIRM enforced, ids validated+capped, every charge rides the gateway ladder individually", async () => {
  const section = makePaymentsSection();
  const ctx = paymentsCtx();
  const calls: Array<[string, Record<string, unknown>]> = [];
  (ctx.billing as unknown as Record<string, unknown>).gateway = {
    request: async (_actor: unknown, key: string, params: Record<string, unknown>) => {
      calls.push([key, params]);
      if (params.chargeId === "ch_2") return { kind: "failed", error: "already refunded" };
      if (params.chargeId === "ch_3") return { kind: "queued" };
      return { kind: "executed", text: "ok" };
    },
  };
  // No CONFIRM → refused before any gateway call.
  const noConfirm = await section.action!(ctx, { key: "section:payments.bulk_refund", params: { ids: ["ch_1"] } });
  assert.equal(noConfirm.ok, false);
  assert.equal(calls.length, 0);
  // Mixed outcomes: invalid ids are dropped, valid ones each hit the ladder.
  const run = await section.action!(ctx, {
    key: "section:payments.bulk_refund",
    params: { ids: ["ch_1", "ch_2", "ch_3", "nope", "ch_1"] },
    confirmWord: "CONFIRM",
  });
  assert.equal(run.ok, true);
  assert.deepEqual(calls.map(([, p]) => p.chargeId), ["ch_1", "ch_2", "ch_3"]);
  assert.ok(calls.every(([k]) => k === "charge.refund_full"));
  assert.ok(run.text!.includes("1 refunded") && run.text!.includes("1 queued") && run.text!.includes("1 skipped"));
  assert.ok(run.text!.includes("ch_2: already refunded"));
  // Cap: more than 25 ids is refused outright.
  const tooMany = await section.action!(ctx, {
    key: "section:payments.bulk_refund",
    params: { ids: Array.from({ length: 26 }, (_, i) => `ch_bulk${i}`) },
    confirmWord: "CONFIRM",
  });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.error!.includes("25"));
});

test("registry (PA-4): subscription.create / charge.create / pm-attach parse hostile input and gate tiers server-side", async () => {
  // subscription.create parse + revalidate surface.
  const subCreate = actionByKey("subscription.create")!;
  assert.equal(subCreate.dangerous, true);
  const parsed = subCreate.parseParams({ customerId: "cus_1", priceId: "price_1", collection: "charge", quantity: 3, promoCode: "X" });
  assert.ok(parsed.ok);
  assert.equal((parsed as { params: { quantity: number } }).params.quantity, 3);
  assert.equal(subCreate.parseParams({ customerId: "cus_1", priceId: "price_1", collection: "nope" }).ok, false);
  assert.equal(subCreate.parseParams({ customerId: "cus_1", priceId: "price_1", collection: "charge", trialDays: 9999 }).ok, false);
  // charge.create refuses garbage currencies/amounts.
  const chargeCreate = actionByKey("charge.create")!;
  assert.equal(chargeCreate.dangerous, true);
  assert.equal(chargeCreate.parseParams({ amountMinor: 500, currency: "eur" }).ok, true);
  assert.equal(chargeCreate.parseParams({ amountMinor: -5, currency: "eur" }).ok, false);
  assert.equal(chargeCreate.parseParams({ amountMinor: 500, currency: "euros" }).ok, false);
  // customer.payment_method attach accepts pm_/tok_, other ops stay pm_-only.
  const pmAction = actionByKey("customer.payment_method")!;
  assert.equal(pmAction.parseParams({ paymentMethodId: "tok_visa", op: "attach" }).ok, true);
  assert.equal(pmAction.parseParams({ paymentMethodId: "tok_visa", op: "detach" }).ok, false);
  assert.equal(pmAction.parseParams({ paymentMethodId: "pm_1", op: "set_default" }).ok, true);
  // change_plan still accepts the legacy 2-field shape AND the unified extras.
  const changePlan = actionByKey("subscription.change_plan")!;
  const legacy = changePlan.parseParams({ subscriptionId: "sub_1", priceId: "price_1" });
  assert.ok(legacy.ok);
  const unified = changePlan.parseParams({ subscriptionId: "sub_1", priceId: "price_1", quantity: 2, promoCode: "S", cycleAnchor: "now", itemId: "si_2" });
  assert.ok(unified.ok);
  assert.equal((unified as { params: { cycleAnchor: string } }).params.cycleAnchor, "now");
});

test("gateway (PA-4): subscription.create + charge.create bind from the explicit customer; charge.create converts major→minor via the typed currency", async () => {
  const { gateway, captured } = gatewayFixture();
  const sub = await gateway.resolve("subscription.create", { customerId: "cus_new", priceId: "price_1", collection: "charge" });
  assert.ok(sub.ok);
  assert.equal((sub as { binding: { stripeCustomerId: string } }).binding.stripeCustomerId, "cus_new");
  const charge = await gateway.resolve("charge.create", { customerId: "cus_new", amountMajor: 12.5, currency: "EUR" });
  assert.ok(charge.ok);
  const chargeParams = (charge as { params: { amountMinor?: number; currency?: string; amountMajor?: number } }).params;
  assert.equal(chargeParams.amountMinor, 1250);
  assert.equal(chargeParams.currency, "eur");
  assert.equal(chargeParams.amountMajor, undefined);
  // Garbage currency with a major amount is refused at the gateway.
  const bad = await gateway.resolve("charge.create", { customerId: "cus_new", amountMajor: 5, currency: "euros" });
  assert.equal(bad.ok, false);
  assert.equal(captured.length, 0); // resolve() never executes anything
});

test("catalog (PA-4): coupon restrictions (max redemptions / redeem-by / applies-to) and promo restrictions (min amount / first-time / customer) reach Stripe", async () => {
  const { makeCatalogSection } = await import("../sections/catalogSection");
  const coupons: Array<Record<string, unknown>> = [];
  const promos: Array<Record<string, unknown>> = [];
  const ctx = {
    stripe: {
      createCoupon: async (params: Record<string, unknown>) => {
        coupons.push(params);
        return { id: "NEW", duration: "once", percent_off: 10, times_redeemed: 0, valid: true };
      },
      createPromotionCode: async (params: Record<string, unknown>) => {
        promos.push(params);
        return { id: "promo_1", code: "SAVE", active: true };
      },
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
    },
    audit: async () => {},
  } as unknown as DashboardCtx;
  const section = makeCatalogSection();
  const coupon = await section.action!(ctx, {
    key: "section:catalog.coupon_create",
    params: { percentOff: "25", maxRedemptions: 50, redeemByDays: 30, appliesTo: "prod_1, prod_2" },
  });
  assert.equal(coupon.ok, true);
  assert.equal(coupons[0].maxRedemptions, 50);
  assert.ok(typeof coupons[0].redeemByUnix === "number" && (coupons[0].redeemByUnix as number) > Math.floor(Date.now() / 1000));
  assert.deepEqual(coupons[0].appliesToProducts, ["prod_1", "prod_2"]);
  const badApplies = await section.action!(ctx, {
    key: "section:catalog.coupon_create",
    params: { percentOff: "25", appliesTo: "price_1" },
  });
  assert.equal(badApplies.ok, false);
  const promo = await section.action!(ctx, {
    key: "section:catalog.promo_create",
    params: { coupon: "NEW", minimumAmount: "25.00 eur", firstTime: true, customer: "cus_9" },
  });
  assert.equal(promo.ok, true);
  assert.equal(promos[0].minimumAmountMinor, 2500);
  assert.equal(promos[0].minimumAmountCurrency, "eur");
  assert.equal(promos[0].firstTimeTransaction, true);
  assert.equal(promos[0].customerId, "cus_9");
  const badMin = await section.action!(ctx, {
    key: "section:catalog.promo_create",
    params: { coupon: "NEW", minimumAmount: "25 euros" },
  });
  assert.equal(badMin.ok, false);
});

test("customer 360 (PA-4): attach-PM + SetupIntent header actions; per-card Charge/Set-default/Detach ride the registry", async () => {
  const section = makeCustomersSection();
  const page = await section.buildPage(fakeCustomerCtx(), { page: "customers.detail", params: { id: "cus_test1" } });
  const header = page!.blocks[0] as HeaderBlock;
  const attach = header.actions!.find((a) => a.key === "customer.payment_method")!;
  assert.equal(attach.dangerous, true);
  assert.deepEqual(attach.params, { customerId: "cus_test1", op: "attach" });
  assert.ok(header.actions!.some((a) => a.key === "section:customers.setup_intent"));
  const pms = page!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "pms") as TableBlock;
  const rowActions = pms.rows[0].actions!;
  const chargeBtn = rowActions.find((a) => a.key === "charge.create")!;
  assert.equal(chargeBtn.stepUp, true);
  assert.deepEqual(chargeBtn.params, { customerId: "cus_test1", paymentMethodId: "pm_1" });
  // pm_1 IS the default → no Set-default button, but Detach present.
  assert.ok(!rowActions.some((a) => a.label === "Set default"));
  assert.ok(rowActions.some((a) => a.label === "Detach"));
  // SetupIntent action returns only the seti_ id, never a client secret.
  const ctx = fakeCustomerCtx();
  (ctx.stripe as unknown as Record<string, unknown>).createSetupIntent = async () => ({
    id: "seti_1",
    status: "requires_payment_method",
    client_secret: "seti_1_secret_SHOULD_NEVER_APPEAR",
  });
  const si = await section.action!(ctx, { key: "section:customers.setup_intent", params: { customerId: "cus_test1" } });
  assert.equal(si.ok, true);
  assert.ok(si.text!.includes("seti_1"));
  assert.ok(!si.text!.includes("secret_SHOULD_NEVER_APPEAR"));
});

test("dashboard belts (PA-4): charge.create always steps up; subscription.create steps up only for charge collection", async () => {
  const fake = fakeSettings();
  const gatewayCalls: string[] = [];
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  const stripe = { isTestMode: () => true } as unknown as StripeClient;
  const dashboard = new Dashboard(fake.store, provider, [fakeSection()], {
    stripe,
    settings: fake.store,
    stores: {} as never,
    billing: {
      actions: {} as never,
      gateway: {
        request: async (_a: unknown, key: string) => {
          gatewayCalls.push(key);
          return { kind: "executed", text: "ok" };
        },
      } as never,
    },
  });
  // charge.create without a fresh factor → needsStepUp, nothing executed.
  const charge = await dashboard.api("action", "sess", {
    key: "charge.create",
    params: { customerId: "cus_1", amountMinor: 500, currency: "eur" },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(charge.json, { ok: false, needsStepUp: true });
  // subscription.create with invoice collection skips step-up but still needs CONFIRM (T1: dangerous).
  const invoiceNoConfirm = await dashboard.api("action", "sess", {
    key: "subscription.create",
    params: { customerId: "cus_1", priceId: "price_1", collection: "invoice" },
  });
  assert.equal((invoiceNoConfirm.json as { ok: boolean }).ok, false);
  assert.ok((invoiceNoConfirm.json as { error?: string }).error?.includes("CONFIRM"));
  const invoiceConfirmed = await dashboard.api("action", "sess", {
    key: "subscription.create",
    params: { customerId: "cus_1", priceId: "price_1", collection: "invoice" },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(invoiceConfirmed.json, { ok: true, text: "ok" });
  // subscription.create with charge collection → the step-up gate fires first.
  const chargeMode = await dashboard.api("action", "sess", {
    key: "subscription.create",
    params: { customerId: "cus_1", priceId: "price_1", collection: "charge" },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(chargeMode.json, { ok: false, needsStepUp: true });
  assert.deepEqual(gatewayCalls, ["subscription.create"]);
});

// ---- PA-5: Payouts + transactions tab views ----

test("payments tabs (PA-5): payouts view = balance stats + payout rows → detail + T2 create; top-ups and all-activity render their ledgers", async () => {
  const section = makePaymentsSection();
  // Payouts view.
  const payouts = await section.buildPage(paymentsCtx(), { page: "payments", filters: { txview: "payouts" } });
  const header = payouts!.blocks[0] as HeaderBlock;
  const create = header.actions!.find((a) => a.key === "section:payments.payout_create")!;
  assert.equal(create.dangerous, true);
  assert.equal(create.stepUp, true);
  assert.ok(create.summary!.includes("500.00 EUR")); // available balance surfaced in the ceremony summary
  const tabs = payouts!.blocks.find((b) => b.type === "tabs") as TabsBlock;
  assert.equal(tabs.value, "payouts");
  assert.ok(payouts!.blocks.some((b) => b.type === "stats"));
  const potable = payouts!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(potable.key, "payouts");
  assert.deepEqual(potable.rows[0].ref, { page: "balances.detail", params: { id: "po_1" } });
  // Top-ups view.
  const topups = await section.buildPage(paymentsCtx(), { page: "payments", filters: { txview: "topups" } });
  const tutable = topups!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(tutable.key, "topups");
  assert.equal((tutable.rows[0].cells[0] as { badge?: { text: string } }).badge?.text, "Succeeded");
  // All-activity view: ledger with type filter + source links.
  const activity = await section.buildPage(paymentsCtx(), { page: "payments", filters: { txview: "activity" } });
  const acttable = activity!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(acttable.key, "activity");
  assert.ok(acttable.filters!.some((f) => f.key === "type"));
  assert.deepEqual(acttable.rows[0].ref, { page: "payments.detail", params: { id: "ch_1" } });
  assert.equal(acttable.nextCursor, null);
});

test("payout create (PA-5): CONFIRM + fresh factor + available-balance preflight, then createPayout in minor units", async () => {
  const section = makePaymentsSection();
  const ctx = paymentsCtx();
  const created: Array<Record<string, unknown>> = [];
  (ctx.stripe as unknown as Record<string, unknown>).createPayout = async (params: Record<string, unknown>) => {
    created.push(params);
    return { id: "po_new", arrival_date: 1_700_500_000 };
  };
  // No CONFIRM.
  const noConfirm = await section.action!(ctx, {
    key: "section:payments.payout_create",
    params: { amountMajor: 100, currency: "eur" },
  });
  assert.equal(noConfirm.ok, false);
  // Stale fresh-factor → needsStepUp before any Stripe call.
  const stale = paymentsCtx();
  (stale.security as unknown as Record<string, unknown>).stepUpFresh = () => false;
  const needsUp = await section.action!(stale, {
    key: "section:payments.payout_create",
    params: { amountMajor: 100, currency: "eur" },
    confirmWord: "CONFIRM",
  });
  assert.equal(needsUp.needsStepUp, true);
  // More than the available bucket → friendly refusal, nothing created.
  const tooMuch = await section.action!(ctx, {
    key: "section:payments.payout_create",
    params: { amountMajor: 9999, currency: "eur" },
    confirmWord: "CONFIRM",
  });
  assert.equal(tooMuch.ok, false);
  assert.ok(tooMuch.error!.includes("500.00 EUR"));
  assert.equal(created.length, 0);
  // Within balance → created with minor units.
  const ok = await section.action!(ctx, {
    key: "section:payments.payout_create",
    params: { amountMajor: 250.5, currency: "EUR", description: "ops sweep" },
    confirmWord: "CONFIRM",
  });
  assert.equal(ok.ok, true);
  assert.equal(created[0].amountMinor, 25050);
  assert.equal(created[0].currency, "eur");
  assert.ok(ok.text!.includes("po_new"));
});

function payoutWriteCtx(payout: Record<string, unknown>, opts: { stepUpFresh?: boolean; reverseSatisfied?: boolean } = {}) {
  const calls: Record<string, unknown[]> = { cancel: [], reverse: [] };
  const ctx = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      getPayout: async () => payout,
      cancelPayout: async (id: string) => {
        calls.cancel.push(id);
        return { ...payout, status: "canceled" };
      },
      reversePayout: async (id: string) => {
        calls.reverse.push(id);
        return { id: "po_rev", original_payout: id };
      },
      listAccountBalanceTransactions: async () => ({ transactions: [], hasMore: false }),
    },
    settings: {} as never,
    stores: {} as never,
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never },
    audit: async () => {},
    ...(opts.reverseSatisfied !== undefined ? { reverse: { satisfied: opts.reverseSatisfied } } : {}),
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => opts.stepUpFresh !== false },
  } as unknown as DashboardCtx;
  return { ctx, calls };
}

test("payout detail (PA-5): pending → T2 Cancel; paid → T3 Reverse; reversed → badge, no actions", async () => {
  const base = { id: "po_1", amount: 10000, currency: "eur", status: "pending", method: "standard", arrival_date: 1_700_000_000, created: 1_699_900_000, reversed_by: null, original_payout: null, destination: "ba_1" };
  const pending = await makeBalancesSection().buildPage(payoutWriteCtx(base).ctx, { page: "balances.detail", params: { id: "po_1" } });
  const pendingHeader = pending!.blocks[0] as HeaderBlock;
  const cancel = pendingHeader.actions!.find((a) => a.key === "section:balances.payout_cancel")!;
  assert.equal(cancel.stepUp, true);
  assert.ok(!pendingHeader.actions!.some((a) => a.key === "section:balances.payout_reverse"));
  const paid = await makeBalancesSection().buildPage(payoutWriteCtx({ ...base, status: "paid" }).ctx, { page: "balances.detail", params: { id: "po_1" } });
  const paidHeader = paid!.blocks[0] as HeaderBlock;
  const reverse = paidHeader.actions!.find((a) => a.key === "section:balances.payout_reverse")!;
  assert.equal(reverse.reverseConfirm, true);
  assert.equal(reverse.dangerous, true);
  const reversed = await makeBalancesSection().buildPage(payoutWriteCtx({ ...base, status: "paid", reversed_by: "po_rev" }).ctx, { page: "balances.detail", params: { id: "po_1" } });
  const reversedHeader = reversed!.blocks[0] as HeaderBlock;
  // Only the (always-present) Bookmark action remains — no money actions.
  assert.deepEqual(reversedHeader.actions!.map((a) => a.key), ["section:balances.bookmark"]);
  assert.ok(reversedHeader.badges!.some((b) => b.text === "Reversed"));
  const details = reversed!.rail![0] as KeyValueBlock;
  assert.ok(details.rows.some((r) => r.label === "Reversed by"));
});

test("payout cancel/reverse (PA-5): T2/T3 belts + live status revalidation before any Stripe write", async () => {
  const pendingPayout = { id: "po_1", amount: 10000, currency: "eur", status: "pending", reversed_by: null };
  const section = makeBalancesSection();
  // Cancel: CONFIRM → step-up → pending-only → cancelPayout.
  const staleCancel = payoutWriteCtx(pendingPayout, { stepUpFresh: false });
  const staleRes = await section.action!(staleCancel.ctx, {
    key: "section:balances.payout_cancel",
    params: { id: "po_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal(staleRes.needsStepUp, true);
  assert.equal(staleCancel.calls.cancel.length, 0);
  const okCancel = payoutWriteCtx(pendingPayout);
  const cancelRes = await section.action!(okCancel.ctx, {
    key: "section:balances.payout_cancel",
    params: { id: "po_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal(cancelRes.ok, true);
  assert.deepEqual(okCancel.calls.cancel, ["po_1"]);
  const paidCancel = payoutWriteCtx({ ...pendingPayout, status: "paid" });
  const refused = await section.action!(paidCancel.ctx, {
    key: "section:balances.payout_cancel",
    params: { id: "po_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal(refused.ok, false);
  assert.equal(paidCancel.calls.cancel.length, 0);
  // Reverse: CONFIRM → reverse code → paid-only + not-already-reversed → reversePayout.
  const noCode = payoutWriteCtx({ ...pendingPayout, status: "paid" }, { reverseSatisfied: false });
  const needsReverse = await section.action!(noCode.ctx, {
    key: "section:balances.payout_reverse",
    params: { id: "po_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal(needsReverse.needsReverse, true);
  assert.equal(noCode.calls.reverse.length, 0);
  const withCode = payoutWriteCtx({ ...pendingPayout, status: "paid" }, { reverseSatisfied: true });
  const reversedRes = await section.action!(withCode.ctx, {
    key: "section:balances.payout_reverse",
    params: { id: "po_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal(reversedRes.ok, true);
  assert.deepEqual(withCode.calls.reverse, ["po_1"]);
  const already = payoutWriteCtx({ ...pendingPayout, status: "paid", reversed_by: "po_x" }, { reverseSatisfied: true });
  const dupe = await section.action!(already.ctx, {
    key: "section:balances.payout_reverse",
    params: { id: "po_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal(dupe.ok, false);
  assert.equal(already.calls.reverse.length, 0);
});

// ---- PA-6: Radar reviews + customer portal + item add/remove ----

function reviewsCtx(overrides: { reviewOpen?: boolean } = {}) {
  const approved: string[] = [];
  const audits: string[] = [];
  const review = {
    id: "prv_1",
    open: overrides.reviewOpen !== false,
    opened_reason: "rule",
    created: 1_700_000_000,
    charge: { id: "ch_1", amount: 4900, currency: "eur", amount_refunded: 0, refunded: false },
    payment_intent: "pi_1",
  };
  const ctx = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listOpenReviews: async () => ({ reviews: [review], hasMore: false }),
      getReview: async () => review,
      approveReview: async (id: string) => {
        approved.push(id);
        return { ...review, open: false };
      },
    },
    settings: {} as never,
    stores: {} as never,
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never },
    audit: async (line: string) => {
      audits.push(line);
    },
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
  return { ctx, approved, audits };
}

test("radar reviews (PA-6): queue tab renders approve + fraud-refund decline path; approve is T1 and refuses closed reviews", async () => {
  const { makeFraudSection } = await import("../sections/fraudSection");
  const section = makeFraudSection({ hunts: {} as never });
  const { ctx, approved } = reviewsCtx();
  const page = await section.buildPage(ctx, { page: "fraud", filters: { view: "reviews" } });
  const tabs = page!.blocks.find((b) => b.type === "tabs") as TabsBlock;
  assert.ok(tabs.items.some((i) => i.value === "reviews"));
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.key, "reviews");
  const row = table.rows[0];
  assert.deepEqual(row.ref, { page: "payments.detail", params: { id: "ch_1" } });
  const approve = row.actions!.find((a) => a.key === "section:fraud.review_approve")!;
  assert.equal(approve.dangerous, true);
  const decline = row.actions!.find((a) => a.key === "charge.refund_fraud")!;
  assert.equal(decline.stepUp, true);
  assert.deepEqual(decline.params, { chargeId: "ch_1", amountMinor: 4900 });
  // Approve: CONFIRM required, then closes via approveReview.
  const noConfirm = await section.action!(ctx, { key: "section:fraud.review_approve", params: { id: "prv_1" } });
  assert.equal(noConfirm.ok, false);
  assert.equal(approved.length, 0);
  const ok = await section.action!(ctx, { key: "section:fraud.review_approve", params: { id: "prv_1" }, confirmWord: "CONFIRM" });
  assert.equal(ok.ok, true);
  assert.deepEqual(approved, ["prv_1"]);
  // Already closed → refusal, no Stripe write.
  const closed = reviewsCtx({ reviewOpen: false });
  const dupe = await section.action!(closed.ctx, { key: "section:fraud.review_approve", params: { id: "prv_1" }, confirmWord: "CONFIRM" });
  assert.equal(dupe.ok, false);
  assert.equal(closed.approved.length, 0);
});

test("customer portal config (PA-6): list w/ feature summary + T1 toggle edits; empty state offers create", async () => {
  const { makePortalSection } = await import("../sections/portalSection");
  const updates: Array<[string, Record<string, unknown>]> = [];
  const creates: Array<Record<string, unknown>> = [];
  const config = {
    id: "bpc_1",
    is_default: true,
    active: true,
    updated: 1_700_000_000,
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: false },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: { enabled: false },
      customer_update: { enabled: false },
    },
  };
  const mkCtx = (configs: unknown[]) =>
    ({
      actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
      stripe: {
        listPortalConfigurations: async () => configs,
        updatePortalConfiguration: async (id: string, features: Record<string, unknown>) => {
          updates.push([id, features]);
          return { ...config, features };
        },
        createPortalConfiguration: async (features: Record<string, unknown>) => {
          creates.push(features);
          return { ...config, id: "bpc_new", features };
        },
      },
      settings: {} as never,
      stores: {} as never,
      billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never },
      audit: async () => {},
      security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
    }) as unknown as DashboardCtx;
  const section = makePortalSection();
  const page = await section.buildPage(mkCtx([config]), { page: "portal", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.ok((table.rows[0].cells[2] as { v: string }).v.includes("invoice history"));
  const edit = table.rows[0].actions![0];
  assert.equal(edit.key, "section:portal.config_update");
  assert.equal(edit.dangerous, true);
  // Toggle values reflect the LIVE config in the modal.
  const inv = edit.inputs!.find((i) => i.key === "invoiceHistory") as { value?: boolean };
  assert.equal(inv.value, true);
  // Update action: CONFIRM + features mapped.
  const upd = await section.action!(mkCtx([config]), {
    key: "section:portal.config_update",
    params: { id: "bpc_1", invoiceHistory: true, pmUpdate: true, subCancel: false },
    confirmWord: "CONFIRM",
  });
  assert.equal(upd.ok, true);
  assert.equal(updates[0][0], "bpc_1");
  assert.deepEqual(updates[0][1], {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: false },
  });
  // Empty state → create affordance, and the create action works.
  const empty = await section.buildPage(mkCtx([]), { page: "portal", filters: {} });
  const createNotice = empty!.blocks.find((b) => b.type === "notice") as NoticeBlock;
  assert.equal(createNotice.actions![0].key, "section:portal.config_create");
  const created = await section.action!(mkCtx([]), {
    key: "section:portal.config_create",
    params: { invoiceHistory: true, pmUpdate: true, subCancel: true },
    confirmWord: "CONFIRM",
  });
  assert.equal(created.ok, true);
  assert.deepEqual(creates[0], {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
  });
});

test("customer portal link (PA-6): the page mints a short-lived session, renders it as a copyable external link, and audits", async () => {
  const ctx = fakeCustomerCtx();
  const audits: string[] = [];
  (ctx as unknown as Record<string, unknown>).audit = async (line: string) => {
    audits.push(line);
  };
  (ctx.stripe as unknown as Record<string, unknown>).createPortalSession = async (id: string) => ({
    id: "bps_1",
    url: `https://billing.stripe.com/p/session/${id}`,
  });
  const section = makeCustomersSection();
  const page = await section.buildPage(ctx, { page: "customers.portal", params: { id: "cus_test1" } });
  const kv = page!.blocks.find((b) => b.type === "kv") as KeyValueBlock;
  const link = kv.rows.find((r) => r.label === "Portal")!.cell as { t: string; href: string; copy?: boolean };
  assert.equal(link.t, "external");
  assert.equal(link.href, "https://billing.stripe.com/p/session/cus_test1");
  assert.equal(link.copy, true);
  assert.ok(audits.some((a) => a.includes("Portal login link minted for cus_test1")));
  // The Customer-360 Manage card links here.
  const detail = await section.buildPage(fakeCustomerCtx(), { page: "customers.detail", params: { id: "cus_test1" } });
  const manage = detail!.rail!.find((b) => b.type === "kv" && (b as KeyValueBlock).title === "Manage") as KeyValueBlock;
  const portalRow = manage.rows.find((r) => r.label === "Customer portal")!;
  assert.deepEqual((portalRow.cell as { ref?: unknown }).ref, { page: "customers.portal", params: { id: "cus_test1" } });
});

test("update page item modes (PA-6): add excludes on-sub prices and confirms op:add; remove picks an item and confirms op:remove", async () => {
  const section = makeSubscriptionsSection();
  // ADD: price_old is on the sub → only price_new is offered.
  const addCtx = subsCtx();
  (addCtx.stripe as unknown as Record<string, unknown>).previewItemsChange = async () => ({
    amount_due: 4900,
    currency: "eur",
    lines: { data: [{ id: "il_1", description: "Remaining time on Postiz Ultra", amount: 4900, currency: "eur" }] },
  });
  const addPicker = await section.buildPage(addCtx, {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { mode: "add" },
  });
  const addTable = addPicker!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.deepEqual(addTable.rows.map((r) => r.id), ["price_new"]);
  assert.ok(!addPicker!.blocks.some((b) => b.type === "table" && (b as TableBlock).key === "preview"));
  const addReady = await section.buildPage(addCtx, {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { mode: "add", price: "price_new", qty: "3" },
  });
  const addConfirm = addReady!.blocks.find(
    (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.items")
  ) as { actions: Array<{ key: string; params?: Record<string, unknown> }> };
  assert.ok(addConfirm, "add confirm only after preview");
  assert.deepEqual(addConfirm.actions[0].params, { subscriptionId: "sub_1", op: "add", priceId: "price_new", quantity: 3 });
  // REMOVE: needs a multi-item sub; single-item subs refuse.
  const rmCtx = subsCtx();
  const twoItems = {
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
    items: {
      data: [
        { id: "si_1", quantity: 1, price: { id: "price_old", nickname: "Pro", currency: "eur", unit_amount: 2900, recurring: { interval: "month", interval_count: 1 } } },
        { id: "si_2", quantity: 2, price: { id: "price_new", nickname: "Ultra", currency: "eur", unit_amount: 4900, recurring: { interval: "month", interval_count: 1 } } },
      ],
    },
  };
  (rmCtx.stripe as unknown as Record<string, unknown>).getSubscription = async () => twoItems;
  (rmCtx.stripe as unknown as Record<string, unknown>).previewItemsChange = async () => ({
    amount_due: -1200,
    currency: "eur",
    lines: { data: [{ id: "il_r", description: "Unused time on Ultra", amount: -1200, currency: "eur" }] },
  });
  const rmReady = await section.buildPage(rmCtx, {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { mode: "remove", item: "si_2" },
  });
  const rmTable = rmReady!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "items") as TableBlock;
  assert.deepEqual(rmTable.rows.map((r) => r.id), ["si_1", "si_2"]);
  const rmConfirm = rmReady!.blocks.find(
    (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.items")
  ) as { actions: Array<{ key: string; params?: Record<string, unknown> }> };
  assert.ok(rmConfirm);
  assert.deepEqual(rmConfirm.actions[0].params, { subscriptionId: "sub_1", op: "remove", itemId: "si_2" });
  // Single-item sub: remove mode renders but offers no confirm (last item).
  const single = await section.buildPage(subsCtx(), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: { mode: "remove", item: "si_1" },
  });
  assert.ok(
    !single!.blocks.some(
      (b) => "actions" in b && (b as { actions?: Array<{ key: string }> }).actions?.some((a) => a.key === "subscription.items")
    )
  );
});

test("registry subscription.items (PA-6): parse + gateway binding from the subscription", async () => {
  const def = actionByKey("subscription.items")!;
  assert.equal(def.dangerous, true);
  assert.ok(def.parseParams({ subscriptionId: "sub_1", op: "add", priceId: "price_1", quantity: 2 }).ok);
  assert.ok(def.parseParams({ subscriptionId: "sub_1", op: "remove", itemId: "si_1" }).ok);
  assert.equal(def.parseParams({ subscriptionId: "sub_1", op: "add" }).ok, false); // add needs a price
  assert.equal(def.parseParams({ subscriptionId: "sub_1", op: "remove" }).ok, false); // remove needs an item
  const { gateway } = gatewayFixture();
  const resolved = await gateway.resolve("subscription.items", { subscriptionId: "sub_1", op: "remove", itemId: "si_1" });
  assert.ok(resolved.ok);
  assert.equal((resolved as { binding: { stripeCustomerId: string } }).binding.stripeCustomerId, "cus_sub");
});

// ---- PA-7a: Payment Links + Tax rates ----

function linksCtx() {
  const created: Array<Record<string, unknown>> = [];
  const toggled: Array<[string, boolean]> = [];
  const link = {
    id: "plink_1",
    url: "https://buy.stripe.com/test_abc",
    active: true,
    allow_promotion_codes: false,
    after_completion: { type: "hosted_confirmation" },
    line_items: {
      data: [{ id: "li_1", description: "Postiz Pro", quantity: 1, amount_total: 2900, currency: "eur" }],
    },
  };
  const ctx = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listPaymentLinks: async () => ({ links: [link, { ...link, id: "plink_2", active: false }], hasMore: false }),
      getPaymentLink: async () => link,
      listAllActivePrices: async () => [
        { id: "price_1", nickname: "Pro monthly", unit_amount: 2900, currency: "eur", recurring: { interval: "month" } },
      ],
      createPaymentLink: async (params: Record<string, unknown>) => {
        created.push(params);
        return { id: "plink_new", url: "https://buy.stripe.com/new", active: true };
      },
      setPaymentLinkActive: async (id: string, active: boolean) => {
        toggled.push([id, active]);
        return { ...link, id, active };
      },
    },
    settings: {} as never,
    stores: {} as never,
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never },
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
  return { ctx, created, toggled };
}

test("payment links (PA-7a): list w/ status counts + copyable URL + toggle; detail line items; create validates the price", async () => {
  const { makeLinksSection } = await import("../sections/linksSection");
  const section = makeLinksSection();
  const { ctx, created, toggled } = linksCtx();
  const page = await section.buildPage(ctx, { page: "links", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.rows.length, 2);
  const urlCell = table.rows[0].cells[2] as { t: string; href: string; copy?: boolean };
  assert.equal(urlCell.t, "external");
  assert.equal(urlCell.href, "https://buy.stripe.com/test_abc");
  assert.equal(urlCell.copy, true);
  assert.deepEqual(table.rows[0].ref, { page: "links.detail", params: { id: "plink_1" } });
  assert.equal(table.rows[0].actions![0].label, "Deactivate");
  assert.equal(table.rows[1].actions![0].label, "Reactivate");
  const counts = Object.fromEntries(table.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(counts.Active, 1);
  assert.equal(counts.Deactivated, 1);
  // Detail: line items + external URL in the rail.
  const detail = await section.buildPage(ctx, { page: "links.detail", params: { id: "plink_1" } });
  const items = detail!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal((items.rows[0].cells[0] as { v: string }).v, "Postiz Pro");
  // Create: bad price refused, good one passes quantity + adjustable through.
  const bad = await section.action!(ctx, { key: "section:links.create", params: { price: "nope" } });
  assert.equal(bad.ok, false);
  assert.equal(created.length, 0);
  const ok = await section.action!(ctx, {
    key: "section:links.create",
    params: { price: "price_1", quantity: 3, adjustable: true },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(created[0], { priceId: "price_1", quantity: 3, adjustableQuantity: true });
  assert.ok(ok.text!.includes("https://buy.stripe.com/new"));
  // Toggle.
  const off = await section.action!(ctx, { key: "section:links.toggle", params: { id: "plink_1", active: false } });
  assert.equal(off.ok, true);
  assert.deepEqual(toggled, [["plink_1", false]]);
});

test("tax rates (PA-7a): catalog tab lists rates w/ archive/restore; create validates name+percentage and archives never delete", async () => {
  const { makeCatalogSection } = await import("../sections/catalogSection");
  const createdRates: Array<Record<string, unknown>> = [];
  const toggledRates: Array<[string, boolean]> = [];
  const ctx = {
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listTaxRates: async () => [
        { id: "txr_1", display_name: "VAT", description: "Germany", percentage: 19, inclusive: true, country: "DE", active: true },
        { id: "txr_2", display_name: "Old VAT", percentage: 16, inclusive: true, country: "DE", active: false },
      ],
      createTaxRate: async (params: Record<string, unknown>) => {
        createdRates.push(params);
        return { id: "txr_new", display_name: params.displayName, percentage: params.percentage, inclusive: params.inclusive, active: true };
      },
      setTaxRateActive: async (id: string, active: boolean) => {
        toggledRates.push([id, active]);
        return { id, display_name: "VAT", active };
      },
    },
    audit: async () => {},
  } as unknown as DashboardCtx;
  const section = makeCatalogSection();
  const page = await section.buildPage(ctx, { page: "catalog", filters: { view: "tax" } });
  const tabs = page!.blocks.find((b) => b.type === "tabs") as TabsBlock;
  assert.ok(tabs.items.some((i) => i.value === "tax"));
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.key, "taxrates");
  assert.equal((table.rows[0].cells[1] as { v: string }).v, "19% incl.");
  assert.equal(table.rows[0].actions![0].label, "Archive");
  assert.equal(table.rows[1].actions![0].label, "Restore");
  // Create: percentage validation + param mapping.
  const badPct = await section.action!(ctx, {
    key: "section:catalog.tax_create",
    params: { displayName: "VAT", percentage: "190" },
  });
  assert.equal(badPct.ok, false);
  const ok = await section.action!(ctx, {
    key: "section:catalog.tax_create",
    params: { displayName: "VAT", percentage: "7.7", inclusive: true, country: "ch" },
  });
  assert.equal(ok.ok, true);
  assert.equal(createdRates[0].percentage, 7.7);
  assert.equal(createdRates[0].country, "CH");
  assert.equal(createdRates[0].inclusive, true);
  // Archive is a toggle, never a delete.
  const archived = await section.action!(ctx, { key: "section:catalog.tax_toggle", params: { id: "txr_1", active: false } });
  assert.equal(archived.ok, true);
  assert.deepEqual(toggledRates, [["txr_1", false]]);
});

// ---- PA-7b: Quotes + Usage/Meters ----

function quotesCtx(opts: { stepUpFresh?: boolean } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const ops: Array<[string, string]> = []; // [op, quoteId]
  const customer = { id: "cus_q1", name: "Ada Lovelace", email: "ada@example.com" };
  const quotes: Record<string, Record<string, unknown>> = {
    qt_draft: {
      id: "qt_draft",
      status: "draft",
      amount_subtotal: 2900,
      amount_total: 2900,
      currency: "eur",
      number: null,
      customer,
      expires_at: 1_700_900_000,
      created: 1_700_000_000,
      subscription: null,
      invoice: null,
      line_items: { data: [{ id: "li_q1", description: "Postiz Pro", quantity: 1, amount_total: 2900, currency: "eur" }] },
    },
    qt_open: {
      id: "qt_open",
      status: "open",
      amount_subtotal: 4900,
      amount_total: 4900,
      currency: "eur",
      number: "QT-0002",
      customer,
      expires_at: 1_700_900_000,
      created: 1_700_000_000,
      subscription: null,
      invoice: null,
      line_items: { data: [{ id: "li_q2", description: "Postiz Ultra", quantity: 1, amount_total: 4900, currency: "eur" }] },
    },
    qt_done: {
      id: "qt_done",
      status: "accepted",
      amount_subtotal: 4900,
      amount_total: 4900,
      currency: "eur",
      number: "QT-0001",
      customer: "cus_q1",
      expires_at: 1_700_900_000,
      created: 1_700_000_000,
      subscription: "sub_from_quote",
      invoice: "in_from_quote",
      line_items: { data: [] },
    },
  };
  const ctx = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listQuotes: async () => ({ quotes: Object.values(quotes), hasMore: false }),
      getQuote: async (id: string) => {
        if (!quotes[id]) throw new Error("no such quote");
        return quotes[id];
      },
      listAllActivePrices: async () => [
        { id: "price_1", nickname: "Pro monthly", unit_amount: 2900, currency: "eur", recurring: { interval: "month" } },
      ],
      createQuote: async (params: Record<string, unknown>) => {
        created.push(params);
        return { id: "qt_new", status: "draft" };
      },
      finalizeQuote: async (id: string) => {
        ops.push(["finalize", id]);
        return { ...quotes[id], status: "open", number: "QT-0009" };
      },
      cancelQuote: async (id: string) => {
        ops.push(["cancel", id]);
        return { ...quotes[id], status: "canceled" };
      },
      acceptQuote: async (id: string) => {
        ops.push(["accept", id]);
        return { ...quotes[id], status: "accepted", subscription: "sub_minted", invoice: "in_minted" };
      },
    },
    settings: {} as never,
    stores: {} as never,
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never },
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => opts.stepUpFresh !== false },
  } as unknown as DashboardCtx;
  return { ctx, created, ops };
}

test("quotes (PA-7b): list w/ status counts + customer links; detail actions are status-aware; lifecycle ops revalidate live status; accept is T2", async () => {
  const { makeQuotesSection } = await import("../sections/quotesSection");
  const section = makeQuotesSection();
  const { ctx, created, ops } = quotesCtx();

  // List: 3 quotes, count-cards per status, expanded customer renders as a link.
  const page = await section.buildPage(ctx, { page: "quotes", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.rows.length, 3);
  const counts = Object.fromEntries(table.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(counts.Draft, 1);
  assert.equal(counts.Open, 1);
  assert.equal(counts.Accepted, 1);
  assert.equal(counts.Canceled, 0);
  const custCell = table.rows[0].cells[1] as { t: string; v: string; ref: { page: string } };
  assert.equal(custCell.t, "link");
  assert.equal(custCell.v, "Ada Lovelace");
  assert.equal(custCell.ref.page, "customers.detail");
  assert.deepEqual(table.rows[0].ref, { page: "quotes.detail", params: { id: "qt_draft" } });

  // Detail (draft): Finalize + Cancel, no Accept.
  const draft = await section.buildPage(ctx, { page: "quotes.detail", params: { id: "qt_draft" } });
  const draftHeader = draft!.blocks.find((b) => b.type === "header") as HeaderBlock;
  assert.deepEqual(draftHeader.actions!.map((a) => a.key), ["section:quotes.finalize", "section:quotes.cancel", "section:quotes.bookmark"]);
  // Detail (open): PDF download offered; Accept requires step-up, Cancel still offered.
  const open = await section.buildPage(ctx, { page: "quotes.detail", params: { id: "qt_open" } });
  const openHeader = open!.blocks.find((b) => b.type === "header") as HeaderBlock;
  assert.deepEqual(openHeader.actions!.map((a) => a.key), ["section:quotes.pdf", "section:quotes.accept", "section:quotes.cancel", "section:quotes.bookmark"]);
  assert.equal(openHeader.actions![1].stepUp, true);
  // Detail (accepted): no lifecycle actions (PDF only); rail links the minted subscription + invoice.
  const done = await section.buildPage(ctx, { page: "quotes.detail", params: { id: "qt_done" } });
  const doneHeader = done!.blocks.find((b) => b.type === "header") as HeaderBlock;
  assert.deepEqual(doneHeader.actions!.map((a) => a.key), ["section:quotes.pdf", "section:quotes.bookmark"]);
  const doneRail = done!.rail!.find((b) => b.type === "kv") as KeyValueBlock;
  const railLabels = doneRail.rows.map((r) => r.label);
  assert.ok(railLabels.includes("Subscription"));
  assert.ok(railLabels.includes("Invoice"));

  // Create: bad customer/price refused, valid params pass through.
  const badCust = await section.action!(ctx, { key: "section:quotes.create", params: { customer: "nope", price: "price_1" } });
  assert.equal(badCust.ok, false);
  assert.equal(created.length, 0);
  const okCreate = await section.action!(ctx, {
    key: "section:quotes.create",
    params: { customer: "cus_q1", price: "price_1", quantity: 2 },
  });
  assert.equal(okCreate.ok, true);
  assert.deepEqual(created[0], { customerId: "cus_q1", priceId: "price_1", quantity: 2 });

  // Finalize: CONFIRM required; live status revalidated (open quote refused).
  const noConfirm = await section.action!(ctx, { key: "section:quotes.finalize", params: { id: "qt_draft" } });
  assert.equal(noConfirm.ok, false);
  const wrongState = await section.action!(ctx, {
    key: "section:quotes.finalize",
    params: { id: "qt_open" },
    confirmWord: "CONFIRM",
  });
  assert.equal(wrongState.ok, false);
  assert.ok(wrongState.error!.includes("open"));
  const finalized = await section.action!(ctx, {
    key: "section:quotes.finalize",
    params: { id: "qt_draft" },
    confirmWord: "CONFIRM",
  });
  assert.equal(finalized.ok, true);

  // Accept: stale factor → needsStepUp before any Stripe write; fresh factor
  // accepts OPEN only (draft refused); result names the minted objects.
  const stale = quotesCtx({ stepUpFresh: false });
  const needStep = await section.action!(stale.ctx, {
    key: "section:quotes.accept",
    params: { id: "qt_open" },
    confirmWord: "CONFIRM",
  });
  assert.equal(needStep.ok, false);
  assert.equal(needStep.needsStepUp, true);
  assert.equal(stale.ops.length, 0);
  const draftAccept = await section.action!(ctx, {
    key: "section:quotes.accept",
    params: { id: "qt_draft" },
    confirmWord: "CONFIRM",
  });
  assert.equal(draftAccept.ok, false);
  const accepted = await section.action!(ctx, {
    key: "section:quotes.accept",
    params: { id: "qt_open" },
    confirmWord: "CONFIRM",
  });
  assert.equal(accepted.ok, true);
  assert.ok(accepted.text!.includes("sub_minted"));

  // Cancel: accepted quotes are immutable history.
  const cancelDone = await section.action!(ctx, {
    key: "section:quotes.cancel",
    params: { id: "qt_done" },
    confirmWord: "CONFIRM",
  });
  assert.equal(cancelDone.ok, false);
  assert.deepEqual(ops, [["finalize", "qt_draft"], ["accept", "qt_open"]]);
});

function metersCtx() {
  const created: Array<Record<string, unknown>> = [];
  const toggled: Array<[string, boolean]> = [];
  const summaryQueries: Array<Record<string, unknown>> = [];
  const meters: Record<string, Record<string, unknown>> = {
    mtr_1: {
      id: "mtr_1",
      display_name: "API requests",
      status: "active",
      event_name: "api_requests",
      default_aggregation: { formula: "sum" },
      customer_mapping: { event_payload_key: "stripe_customer_id", type: "by_id" },
      value_settings: { event_payload_key: "value" },
      event_time_window: null,
      created: 1_700_000_000,
      status_transitions: { deactivated_at: null },
    },
    mtr_2: {
      id: "mtr_2",
      display_name: "Old meter",
      status: "inactive",
      event_name: "legacy_units",
      default_aggregation: { formula: "count" },
      created: 1_700_000_000,
      status_transitions: { deactivated_at: 1_700_500_000 },
    },
  };
  const ctx = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listMeters: async () => Object.values(meters),
      getMeter: async (id: string) => {
        if (!meters[id]) throw new Error("no such meter");
        return meters[id];
      },
      createMeter: async (params: Record<string, unknown>) => {
        created.push(params);
        return { id: "mtr_new", event_name: params.eventName };
      },
      setMeterActive: async (id: string, active: boolean) => {
        toggled.push([id, active]);
        return { ...meters[id], status: active ? "active" : "inactive" };
      },
      listMeterEventSummaries: async (id: string, params: Record<string, unknown>) => {
        summaryQueries.push({ id, ...params });
        return [
          { id: "mtrusg_1", start_time: 1_752_800_400, end_time: 1_752_804_000, aggregated_value: 42 },
          { id: "mtrusg_2", start_time: 1_752_804_000, end_time: 1_752_807_600, aggregated_value: 7.5 },
        ];
      },
    },
    settings: {} as never,
    stores: {} as never,
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never },
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
  return { ctx, created, toggled, summaryQueries };
}

test("meters (PA-7b): list w/ toggle; detail summaries REQUIRE a customer scope w/ aligned windows; toggle is T1 + live-status; create validates the event name", async () => {
  const { makeMetersSection } = await import("../sections/metersSection");
  const section = makeMetersSection();
  const { ctx, created, toggled, summaryQueries } = metersCtx();

  // List: rows + status-aware toggle labels.
  const page = await section.buildPage(ctx, { page: "meters", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].actions![0].label, "Deactivate");
  assert.equal(table.rows[1].actions![0].label, "Reactivate");
  assert.deepEqual(table.rows[0].ref, { page: "meters.detail", params: { id: "mtr_1" } });

  // Detail without a customer: NO summary API call, hint explains the scoping.
  const unscoped = await section.buildPage(ctx, { page: "meters.detail", params: { id: "mtr_1" }, filters: {} });
  const emptyTable = unscoped!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(emptyTable.rows.length, 0);
  assert.ok(emptyTable.empty!.includes("cus_"));
  assert.equal(summaryQueries.length, 0);

  // Detail with customer + 24h window: hour granularity, boundaries aligned to
  // full hours, exactly 24h span, and summary rows render.
  const scoped = await section.buildPage(ctx, {
    page: "meters.detail",
    params: { id: "mtr_1" },
    filters: { customer: "cus_q1", window: "24h" },
  });
  assert.equal(summaryQueries.length, 1);
  const q = summaryQueries[0] as { customerId: string; startTime: number; endTime: number; granularity: string };
  assert.equal(q.customerId, "cus_q1");
  assert.equal(q.granularity, "hour");
  assert.equal(q.endTime % 3600, 0);
  assert.equal(q.endTime - q.startTime, 24 * 3600);
  const sumTable = scoped!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(sumTable.rows.length, 2);
  assert.equal((sumTable.rows[0].cells[2] as { v: string }).v, "42");

  // Toggle: CONFIRM required; live status refuses a no-op; then executes.
  const noConfirm = await section.action!(ctx, { key: "section:meters.toggle", params: { id: "mtr_1", active: false } });
  assert.equal(noConfirm.ok, false);
  const noop = await section.action!(ctx, {
    key: "section:meters.toggle",
    params: { id: "mtr_1", active: true },
    confirmWord: "CONFIRM",
  });
  assert.equal(noop.ok, false);
  assert.ok(noop.error!.includes("already"));
  const off = await section.action!(ctx, {
    key: "section:meters.toggle",
    params: { id: "mtr_1", active: false },
    confirmWord: "CONFIRM",
  });
  assert.equal(off.ok, true);
  assert.deepEqual(toggled, [["mtr_1", false]]);

  // Create: event name + formula validated, params mapped.
  const badEvent = await section.action!(ctx, {
    key: "section:meters.create",
    params: { displayName: "API", eventName: "bad name!", formula: "sum" },
  });
  assert.equal(badEvent.ok, false);
  assert.equal(created.length, 0);
  const okCreate = await section.action!(ctx, {
    key: "section:meters.create",
    params: { displayName: "API requests", eventName: "api_requests", formula: "sum" },
  });
  assert.equal(okCreate.ok, true);
  assert.deepEqual(created[0], { displayName: "API requests", eventName: "api_requests", formula: "sum" });
});

// ---- PA-9: money-op gaps ----

test("payment_intent.capture (PA-9): revalidation matrix + idem key; gateway binds via the PI and folds amountMajor", async () => {
  const def = actionByKey("payment_intent.capture")!;
  assert.equal(def.dangerous, true);
  assert.equal(def.parseParams({}).ok, false);
  assert.equal(def.parseParams({ paymentIntentId: "pi_1", amountMinor: -5 }).ok, false);
  const full = def.parseParams({ paymentIntentId: "pi_1" });
  assert.ok(full.ok);
  const partial = def.parseParams({ paymentIntentId: "pi_1", amountMinor: 500 });
  assert.ok(partial.ok);

  const captures: Array<[string, number | undefined, string | undefined]> = [];
  const ctx = (status: string, owner: string, capturable = 2900) =>
    ({
      stripe: {
        getPaymentIntent: async () => ({ id: "pi_1", customer: owner, status, amount: 2900, amount_capturable: capturable, currency: "eur" }),
        capturePaymentIntent: async (id: string, amt?: number, idem?: string) => {
          captures.push([id, amt, idem]);
          return { id, amount: 2900, amount_received: amt ?? 2900, currency: "eur" };
        },
        formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      },
      stripeCustomerId: "cus_1",
      idemScope: "scope1",
    }) as unknown as ActionExecCtx;
  const p = (partial as { params: unknown }).params as Record<string, unknown>;
  assert.match((await def.revalidate(ctx("requires_capture", "cus_OTHER"), p)) ?? "", /does not belong/);
  assert.match((await def.revalidate(ctx("succeeded", "cus_1"), p)) ?? "", /only requires_capture/);
  assert.match((await def.revalidate(ctx("requires_capture", "cus_1", 400), p)) ?? "", /capturable remainder/);
  assert.equal(await def.revalidate(ctx("requires_capture", "cus_1"), p), null);
  const done = await def.execute(ctx("requires_capture", "cus_1"), p);
  assert.equal(done.ok, true);
  assert.equal(captures[0][0], "pi_1");
  assert.equal(captures[0][1], 500);
  assert.ok(captures[0][2]!.startsWith("panel-picapture-pi_1-"));

  // Gateway: binds from the PI's customer and folds major→minor via pi.currency.
  const { gateway } = gatewayFixture();
  const resolved = await gateway.resolve("payment_intent.capture", { paymentIntentId: "pi_1", amountMajor: 5 });
  assert.ok(resolved.ok);
  const rp = (resolved as { params: Record<string, unknown>; binding: { stripeCustomerId: string } });
  assert.equal(rp.params.amountMinor, 500);
  assert.ok(!("amountMajor" in rp.params));
  assert.equal(rp.binding.stripeCustomerId, "cus_pi");
});

test("api belts (PA-9): capture is unconditional T2; endTrialNow is param-aware T2; coupon remove is param-aware T1", async () => {
  const fake = fakeSettings();
  const gatewayCalls: string[] = [];
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  const dashboard = new Dashboard(fake.store, provider, [fakeSection()], {
    stripe: { isTestMode: () => true } as unknown as StripeClient,
    settings: fake.store,
    stores: {} as never,
    billing: {
      actions: {} as never,
      gateway: { request: async (_a: unknown, key: string) => { gatewayCalls.push(key); return { kind: "executed", text: "ok" }; } } as never,
    },
  });
  // Capture: CONFIRM given, factor stale → needsStepUp (belt before the gateway).
  const cap = await dashboard.api("action", "c", {
    key: "payment_intent.capture",
    params: { paymentIntentId: "pi_1" },
    confirmWord: "CONFIRM",
  });
  assert.equal((cap.json as { needsStepUp?: boolean }).needsStepUp, true);
  // Terms WITHOUT endTrialNow: no step-up (T1 only) → reaches the gateway.
  const terms = await dashboard.api("action", "c", {
    key: "subscription.terms",
    params: { subscriptionId: "sub_1", quantity: 2 },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(terms.json, { ok: true, text: "ok" });
  // Terms WITH endTrialNow: T2.
  const trialNow = await dashboard.api("action", "c", {
    key: "subscription.terms",
    params: { subscriptionId: "sub_1", endTrialNow: true },
    confirmWord: "CONFIRM",
  });
  assert.equal((trialNow.json as { needsStepUp?: boolean }).needsStepUp, true);
  // Coupon apply: T0 — no CONFIRM needed.
  const apply = await dashboard.api("action", "c", {
    key: "customer.coupon",
    params: { subscriptionId: "sub_1", promoCode: "X" },
  });
  assert.deepEqual(apply.json, { ok: true, text: "ok" });
  // Coupon remove: T1 param-aware — refused without CONFIRM.
  const removeNoConfirm = await dashboard.api("action", "c", {
    key: "customer.coupon",
    params: { subscriptionId: "sub_1", op: "remove" },
  });
  assert.match((removeNoConfirm.json as { error?: string }).error ?? "", /CONFIRM/);
  assert.deepEqual(gatewayCalls, ["subscription.terms", "customer.coupon"]);
});

test("customer.coupon op:remove (PA-9): revalidates discount presence; gateway binds customer-level removes via customerId", async () => {
  const def = actionByKey("customer.coupon")!;
  // Legacy apply payload (no op) still parses — Intercom canvas compatibility.
  const legacy = def.parseParams({ subscriptionId: "sub_1", promoCode: "X" });
  assert.ok(legacy.ok);
  assert.equal((legacy as { params: { op: string } }).params.op, "apply");
  assert.equal(def.parseParams({ op: "remove" }).ok, false); // needs exactly one target
  assert.equal(def.parseParams({ op: "remove", subscriptionId: "sub_1", customerId: "cus_1" }).ok, false);
  const subRemove = (def.parseParams({ op: "remove", subscriptionId: "sub_1" }) as { params: unknown }).params;
  const cusRemove = (def.parseParams({ op: "remove", customerId: "cus_1" }) as { params: unknown }).params;
  const removed: string[] = [];
  const mkCtx = (discounts: unknown[], customerDiscount: unknown) =>
    ({
      stripe: {
        getSubscription: async () => ({ id: "sub_1", customer: "cus_1", status: "active", discounts }),
        getCustomer: async () => ({ id: "cus_1", discount: customerDiscount }),
        removeSubscriptionDiscount: async (id: string) => removed.push(`sub:${id}`),
        removeCustomerDiscount: async (id: string) => removed.push(`cus:${id}`),
      },
      stripeCustomerId: "cus_1",
      idemScope: "s",
    }) as unknown as ActionExecCtx;
  assert.match((await def.revalidate(mkCtx([], null), subRemove)) ?? "", /No discount on this subscription/);
  assert.equal(await def.revalidate(mkCtx(["di_1"], null), subRemove), null);
  assert.match((await def.revalidate(mkCtx([], null), cusRemove)) ?? "", /No customer-level discount/);
  assert.equal(await def.revalidate(mkCtx([], { id: "di_2" }), cusRemove), null);
  await def.execute(mkCtx(["di_1"], null), subRemove);
  await def.execute(mkCtx([], { id: "di_2" }), cusRemove);
  assert.deepEqual(removed, ["sub:sub_1", "cus:cus_1"]);
  // Gateway: customer-level remove binds via the explicit customerId.
  const { gateway } = gatewayFixture();
  const resolved = await gateway.resolve("customer.coupon", { op: "remove", customerId: "cus_x1" });
  assert.ok(resolved.ok);
  assert.equal((resolved as { binding: { stripeCustomerId: string } }).binding.stripeCustomerId, "cus_x1");
});

test("subscription.terms endTrialNow (PA-9): trialing-only revalidation, executes trial_end 'now'", async () => {
  const def = actionByKey("subscription.terms")!;
  assert.equal(def.parseParams({ subscriptionId: "sub_1", endTrialNow: true, trialEndUnix: 999999999999 }).ok, false);
  const parsed = (def.parseParams({ subscriptionId: "sub_1", endTrialNow: true }) as { params: unknown }).params;
  const trialCalls: Array<[string, unknown]> = [];
  const mkCtx = (status: string) =>
    ({
      stripe: {
        getSubscription: async () => ({ id: "sub_1", customer: "cus_1", status, items: { data: [{ id: "si_1" }] } }),
        setTrialEnd: async (id: string, end: unknown) => trialCalls.push([id, end]),
      },
      stripeCustomerId: "cus_1",
      idemScope: "s",
    }) as unknown as ActionExecCtx;
  assert.match((await def.revalidate(mkCtx("active"), parsed)) ?? "", /no trial to end/);
  assert.equal(await def.revalidate(mkCtx("trialing"), parsed), null);
  const done = await def.execute(mkCtx("trialing"), parsed);
  assert.equal(done.ok, true);
  assert.deepEqual(trialCalls, [["sub_1", "now"]]);
});

test("charge detail (PA-9): uncaptured auth renders Capture/Capture-partial/Cancel-authorization; captured renders refunds instead", async () => {
  const section = makePaymentsSection();
  const ctx = paymentsCtx();
  (ctx.stripe as unknown as Record<string, unknown>).getChargeDetailed = async () => ({
    id: "ch_1",
    status: "succeeded",
    captured: false,
    refunded: false,
    disputed: false,
    amount: 2900,
    amount_refunded: 0,
    currency: "eur",
    created: 1_700_000_000,
    customer: "cus_a",
    payment_intent: "pi_9",
    billing_details: { email: "a@x.com" },
    payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
  });
  const page = await section.buildPage(ctx, { page: "payments.detail", params: { id: "ch_1" } });
  const header = page!.blocks[0] as HeaderBlock;
  const labels = header.actions!.map((a) => a.label);
  assert.ok(labels.includes("Capture"));
  assert.ok(labels.includes("Capture partial"));
  assert.ok(labels.includes("Cancel authorization"));
  assert.ok(!labels.some((l) => l.startsWith("Refund")));
  const capture = header.actions!.find((a) => a.label === "Capture")!;
  assert.equal(capture.stepUp, true);
  assert.deepEqual(capture.params, { paymentIntentId: "pi_9" });
  // Captured charge (default fixture): refunds render, capture does not.
  const captured = await section.buildPage(paymentsCtx(), { page: "payments.detail", params: { id: "ch_1" } });
  const capturedLabels = (captured!.blocks[0] as HeaderBlock).actions!.map((a) => a.label);
  assert.ok(!capturedLabels.includes("Capture"));
  assert.ok(capturedLabels.some((l) => l.startsWith("Refund") || l === "Partial refund"));
});

test("draft invoice editor (PA-9): draft-only + one-off-only gates, foreign-line refusal, T1 remove, details/date validation", async () => {
  const section = makeInvoicesSection();
  const created: Array<Record<string, unknown>> = [];
  const updatedItems: Array<[string, Record<string, unknown>]> = [];
  const deletedItems: string[] = [];
  const detailUpdates: Array<Record<string, unknown>> = [];
  const mkCtx = (invoiceOver: Record<string, unknown> = {}) =>
    ({
      actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
      billing: { actions: { effectiveMode: () => "direct" } },
      stripe: {
        formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
        getInvoice: async () => ({ id: "in_1", status: "draft", currency: "eur", customer: "cus_1", parent: null, ...invoiceOver }),
        getPrice: async () => ({ id: "price_1", nickname: "Pro", unit_amount: 2900, currency: "eur", product: "prod_1" }),
        createInvoiceItem: async (p: Record<string, unknown>) => created.push(p),
        getInvoiceItem: async (id: string) =>
          id === "ii_mine"
            ? { id, invoice: "in_1", amount: 2900, quantity: 1, pricing: null }
            : { id, invoice: "in_OTHER", amount: 100, quantity: 1, pricing: null },
        updateInvoiceItem: async (id: string, p: Record<string, unknown>) => updatedItems.push([id, p]),
        deleteInvoiceItem: async (id: string) => deletedItems.push(id),
        updateInvoiceDetails: async (_id: string, p: Record<string, unknown>) => detailUpdates.push(p),
      },
      audit: async () => {},
    }) as unknown as DashboardCtx;

  // Non-draft and subscription-cycle drafts are refused for every key.
  const open = await section.action!(mkCtx({ status: "open" }), { key: "section:invoices.line_add_custom", params: { invoiceId: "in_1" } });
  assert.match(open.error ?? "", /only drafts/);
  const cycle = await section.action!(mkCtx({ parent: { subscription_details: { subscription: "sub_1" } } }), {
    key: "section:invoices.line_add_custom",
    params: { invoiceId: "in_1" },
  });
  assert.match(cycle.error ?? "", /subscription cycle/);

  // Price line add flattens price × qty into an amount.
  const ctx = mkCtx();
  const added = await section.action!(ctx, {
    key: "section:invoices.line_add",
    params: { invoiceId: "in_1", price: "price_1", quantity: 3 },
  });
  assert.equal(added.ok, true);
  assert.equal(created[0].amountMinor, 8700);
  assert.equal(created[0].description, "Pro ×3");

  // Foreign line refused for edit AND remove; remove demands CONFIRM.
  const foreignEdit = await section.action!(ctx, {
    key: "section:invoices.line_edit",
    params: { invoiceId: "in_1", itemId: "ii_foreign", amountMajor: 5 },
  });
  assert.match(foreignEdit.error ?? "", /does not belong/);
  const noConfirm = await section.action!(ctx, { key: "section:invoices.line_remove", params: { invoiceId: "in_1", itemId: "ii_mine" } });
  assert.match(noConfirm.error ?? "", /CONFIRM/);
  const removed = await section.action!(ctx, {
    key: "section:invoices.line_remove",
    params: { invoiceId: "in_1", itemId: "ii_mine" },
    confirmWord: "CONFIRM",
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(deletedItems, ["ii_mine"]);

  // Amount-based line refuses qty edits; amount edit folds major→minor.
  const qtyOnAmount = await section.action!(ctx, {
    key: "section:invoices.line_edit",
    params: { invoiceId: "in_1", itemId: "ii_mine", quantity: 2 },
  });
  assert.equal(qtyOnAmount.ok, false);
  const amountEdit = await section.action!(ctx, {
    key: "section:invoices.line_edit",
    params: { invoiceId: "in_1", itemId: "ii_mine", amountMajor: 12.5 },
  });
  assert.equal(amountEdit.ok, true);
  assert.deepEqual(updatedItems[0], ["ii_mine", { amountMinor: 1250 }]);

  // Details: past due date refused; memo '-' clears.
  const pastDue = await section.action!(ctx, {
    key: "section:invoices.details_edit",
    params: { invoiceId: "in_1", dueDate: "2020-01-01" },
  });
  assert.equal(pastDue.ok, false);
  const cleared = await section.action!(ctx, { key: "section:invoices.details_edit", params: { invoiceId: "in_1", memo: "-" } });
  assert.equal(cleared.ok, true);
  assert.deepEqual(detailUpdates[0], { memo: null });

  // Detail page: editable drafts render the invoiceItems table with row actions.
  (ctx.stripe as unknown as Record<string, unknown>).listCreditNotes = async () => [];
  (ctx.stripe as unknown as Record<string, unknown>).listInvoiceItems = async () => [
    { id: "ii_mine", amount: 2900, quantity: 1, currency: "eur", description: "Pro", pricing: null },
  ];
  (ctx.stripe as unknown as Record<string, unknown>).listAllActivePrices = async () => [
    { id: "price_1", nickname: "Pro", unit_amount: 2900, currency: "eur" },
  ];
  (ctx.stripe as unknown as Record<string, unknown>).getInvoice = async () => ({
    id: "in_1",
    status: "draft",
    currency: "eur",
    customer: "cus_1",
    parent: null,
    total: 2900,
    amount_paid: 0,
    amount_due: 2900,
    subtotal: 2900,
    created: 1_700_000_000,
    lines: { data: [] },
  });
  (ctx as unknown as { billing: unknown }).billing = { actions: { effectiveMode: () => "direct" } };
  const page = await section.buildPage(ctx, { page: "invoices.detail", params: { id: "in_1" } });
  const linesTable = page!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "lines") as TableBlock;
  assert.ok(linesTable.title!.includes("editable"));
  assert.deepEqual(linesTable.rows[0].actions!.map((a) => a.label), ["Edit", "Remove"]);
  const headerLabels = (page!.blocks[0] as HeaderBlock).actions!.map((a) => a.label);
  for (const l of ["Add line", "Add custom line", "Edit details", "Metadata", "Finalize"]) {
    assert.ok(headerLabels.includes(l), `missing ${l}`);
  }
});

test("payments section actions (PA-9): top-up belts + Stripe error surfacing; instant payout preflights instant_available", async () => {
  const section = makePaymentsSection();
  const base = paymentsCtx();
  // Top-up: CONFIRM first, then a fresh factor.
  const noConfirm = await section.action!(base, {
    key: "section:payments.topup_create",
    params: { amountMajor: 100, currency: "eur" },
  });
  assert.match(noConfirm.error ?? "", /CONFIRM/);
  const staleCtx = paymentsCtx();
  (staleCtx as unknown as { security: Record<string, unknown> }).security = {
    sessionIdHash: "h",
    authMethod: "passkey",
    stepUpFresh: () => false,
  };
  const stale = await section.action!(staleCtx, {
    key: "section:payments.topup_create",
    params: { amountMajor: 100, currency: "eur" },
    confirmWord: "CONFIRM",
  });
  assert.equal(stale.needsStepUp, true);
  const fresh = paymentsCtx();
  (fresh as unknown as { security: Record<string, unknown> }).security = { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true };
  (fresh.stripe as unknown as Record<string, unknown>).createTopUp = async () => {
    throw new Error("Top-ups to this account are not allowed (no verified bank).");
  };
  const refused = await section.action!(fresh, {
    key: "section:payments.topup_create",
    params: { amountMajor: 100, currency: "eur" },
    confirmWord: "CONFIRM",
  });
  assert.match(refused.error ?? "", /no verified bank/);
  const okTopup = paymentsCtx();
  (okTopup as unknown as { security: Record<string, unknown> }).security = { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true };
  const topups: Array<Record<string, unknown>> = [];
  (okTopup.stripe as unknown as Record<string, unknown>).createTopUp = async (p: Record<string, unknown>) => {
    topups.push(p);
    return { id: "tu_1", status: "pending" };
  };
  const made = await section.action!(okTopup, {
    key: "section:payments.topup_create",
    params: { amountMajor: 100, currency: "eur", statementDescriptor: "POSTIZ TOPUP" },
    confirmWord: "CONFIRM",
  });
  assert.equal(made.ok, true);
  assert.equal(topups[0].amountMinor, 10000);

  // Instant payout: missing instant_available bucket → friendly refusal.
  const instant = paymentsCtx();
  (instant as unknown as { security: Record<string, unknown> }).security = { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true };
  const noBucket = await section.action!(instant, {
    key: "section:payments.payout_create",
    params: { amountMajor: 10, currency: "eur", method: "instant" },
    confirmWord: "CONFIRM",
  });
  assert.match(noBucket.error ?? "", /Instant/);
  (instant.stripe as unknown as Record<string, unknown>).getBalance = async () => ({
    available: [{ amount: 50000, currency: "eur" }],
    pending: [],
    instant_available: [{ amount: 20000, currency: "eur" }],
  });
  const payouts: Array<Record<string, unknown>> = [];
  (instant.stripe as unknown as Record<string, unknown>).createPayout = async (p: Record<string, unknown>) => {
    payouts.push(p);
    return { id: "po_9", arrival_date: 1_700_900_000 };
  };
  const instantOk = await section.action!(instant, {
    key: "section:payments.payout_create",
    params: { amountMajor: 10, currency: "eur", method: "instant" },
    confirmWord: "CONFIRM",
  });
  assert.equal(instantOk.ok, true);
  assert.equal(payouts[0].method, "instant");
});

// ---- PA-10: customer depth ----

test("customer 360 (PA-10): tax IDs + addresses rail cards, balance history, cash balance in Insights", async () => {
  const section = makeCustomersSection();
  const ctx = fakeCustomerCtx();
  (ctx.stripe as unknown as Record<string, unknown>).listTaxIds = async () => [
    { id: "txi_1", type: "eu_vat", value: "DE123456789", verification: { status: "verified" } },
    { id: "txi_2", type: "gb_vat", value: "GB999999973", verification: null },
  ];
  (ctx.stripe as unknown as Record<string, unknown>).listBalanceTransactions = async () => ({
    data: [
      { id: "cbtxn_1", amount: -1000, currency: "eur", created: 1_700_000_000, description: "Support credit", ending_balance: -1000, type: "adjustment" },
    ],
  });
  (ctx.stripe as unknown as Record<string, unknown>).getCashBalance = async () => ({ available: { eur: 5000 } });
  const page = await section.buildPage(ctx, { page: "customers.detail", params: { id: "cus_test1" } });
  const card = (title: string) =>
    page!.rail!.find((b) => b.type === "kv" && (b as KeyValueBlock).title?.startsWith(title)) as KeyValueBlock;

  const taxCard = card("Tax IDs");
  assert.equal(taxCard.rows.length, 2);
  assert.deepEqual(taxCard.rows[0].cell, { t: "text", v: "DE123456789", sub: "Verified" });
  const removeAction = taxCard.actions!.find((a) => a.key === "section:customers.tax_id_remove")!;
  const removeOptions = (removeAction.inputs![0] as { options: Array<{ value: string }> }).options;
  assert.deepEqual(removeOptions.map((o) => o.value), ["txi_1", "txi_2"]);

  const addrCard = card("Addresses");
  assert.deepEqual(addrCard.actions!.map((a) => a.key), ["section:customers.address_billing", "section:customers.address_shipping"]);

  const history = page!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "balancehistory") as TableBlock;
  assert.equal(history.rows.length, 1);

  const insights = page!.rail![0] as KeyValueBlock;
  const cashRow = insights.rows.find((r) => r.label === "Cash balance");
  assert.ok(cashRow);
  assert.equal((cashRow!.cell as { v: string }).v, "50.00 EUR");

  // Without any of it: no history table, no cash row, tax card shows "none".
  const bare = await section.buildPage(fakeCustomerCtx(), { page: "customers.detail", params: { id: "cus_test1" } });
  assert.ok(!bare!.blocks.some((b) => b.type === "table" && (b as TableBlock).key === "balancehistory"));
  assert.ok(!(bare!.rail![0] as KeyValueBlock).rows.some((r) => r.label === "Cash balance"));
});

test("customer tax-id + address actions (PA-10): curated-type spoof refused, live re-list on remove, address parse matrix", async () => {
  const section = makeCustomersSection();
  const added: Array<[string, string]> = [];
  const removed: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const ctx = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      addTaxId: async (_c: string, type: string, value: string) => {
        added.push([type, value]);
        return { id: "txi_new" };
      },
      listTaxIds: async () => [{ id: "txi_mine", type: "eu_vat", value: "DE1" }],
      removeTaxId: async (_c: string, id: string) => {
        removed.push(id);
      },
      updateCustomer: async (_c: string, p: Record<string, unknown>) => updates.push(p),
    },
    audit: async () => {},
  } as unknown as DashboardCtx;

  // Tax add: CONFIRM, curated type only, Stripe error → fieldErrors.value.
  const noConfirm = await section.action!(ctx, {
    key: "section:customers.tax_id_add",
    params: { customerId: "cus_1", type: "eu_vat", value: "DE123" },
  });
  assert.match(noConfirm.error ?? "", /CONFIRM/);
  const spoof = await section.action!(ctx, {
    key: "section:customers.tax_id_add",
    params: { customerId: "cus_1", type: "xx_evil", value: "DE123" },
    confirmWord: "CONFIRM",
  });
  assert.equal(spoof.ok, false);
  assert.equal(added.length, 0);
  const okAdd = await section.action!(ctx, {
    key: "section:customers.tax_id_add",
    params: { customerId: "cus_1", type: "eu_vat", value: "DE123456789" },
    confirmWord: "CONFIRM",
  });
  assert.equal(okAdd.ok, true);
  assert.deepEqual(added, [["eu_vat", "DE123456789"]]);
  (ctx.stripe as unknown as Record<string, unknown>).addTaxId = async () => {
    throw new Error("Invalid value for eu_vat.");
  };
  const stripeErr = await section.action!(ctx, {
    key: "section:customers.tax_id_add",
    params: { customerId: "cus_1", type: "eu_vat", value: "BADVALUE" },
    confirmWord: "CONFIRM",
  });
  assert.match(stripeErr.fieldErrors?.value ?? "", /Invalid value/);

  // Tax remove: foreign id refused via the live re-list.
  const foreign = await section.action!(ctx, {
    key: "section:customers.tax_id_remove",
    params: { customerId: "cus_1", taxIdId: "txi_other" },
    confirmWord: "CONFIRM",
  });
  assert.equal(foreign.ok, false);
  const okRemove = await section.action!(ctx, {
    key: "section:customers.tax_id_remove",
    params: { customerId: "cus_1", taxIdId: "txi_mine" },
    confirmWord: "CONFIRM",
  });
  assert.equal(okRemove.ok, true);
  assert.deepEqual(removed, ["txi_mine"]);

  // Addresses: parse matrix.
  const billing = await section.action!(ctx, {
    key: "section:customers.address_billing",
    params: { customerId: "cus_1", address: "1 Main St | | Berlin | | 10115 | de" },
  });
  assert.equal(billing.ok, true);
  assert.deepEqual(updates[0], { address: { line1: "1 Main St", city: "Berlin", postal_code: "10115", country: "DE" } });
  const cleared = await section.action!(ctx, {
    key: "section:customers.address_billing",
    params: { customerId: "cus_1", address: "-" },
  });
  assert.equal(cleared.ok, true);
  assert.deepEqual(updates[1], { address: "" });
  const noCountry = await section.action!(ctx, {
    key: "section:customers.address_billing",
    params: { customerId: "cus_1", address: "1 Main St | | Berlin" },
  });
  assert.equal(noCountry.ok, false);
  const noName = await section.action!(ctx, {
    key: "section:customers.address_shipping",
    params: { customerId: "cus_1", address: "| 1 Main St | | Berlin | | 10115 | de" },
  });
  assert.equal(noName.ok, false);
  const shipping = await section.action!(ctx, {
    key: "section:customers.address_shipping",
    params: { customerId: "cus_1", address: "Ada Lovelace | 1 Main St | | Berlin | | 10115 | de" },
  });
  assert.equal(shipping.ok, true);
  assert.deepEqual(updates[2], {
    shipping: { name: "Ada Lovelace", address: { line1: "1 Main St", city: "Berlin", postal_code: "10115", country: "DE" } },
  });
});

// ---- PA-11: subscription schedules ----

test("rebuildCurrentPhase (PA-11): preserves trial_end + coupon discounts, flags unsupported settings", async () => {
  const { rebuildCurrentPhase } = await import("../../bot/StripeClient");
  const base = {
    phases: [
      {
        items: [{ price: "price_a", quantity: 2, discounts: [] }],
        start_date: 100,
        end_date: 200,
        trial_end: 150,
        discounts: [{ coupon: "co_1" }, { coupon: { id: "co_2" } }],
        default_payment_method: null,
      },
    ],
  } as unknown as Stripe.SubscriptionSchedule;
  const ok = rebuildCurrentPhase(base);
  assert.deepEqual(ok.unsupported, []);
  assert.deepEqual(ok.phase, {
    items: [{ price: "price_a", quantity: 2 }],
    start_date: 100,
    end_date: 200,
    trial_end: 150,
    discounts: [{ coupon: "co_1" }, { coupon: "co_2" }],
  });
  const bad = rebuildCurrentPhase({
    phases: [
      {
        items: [{ price: "price_a", quantity: 1, discounts: [{ coupon: "co_x" }] }],
        start_date: 100,
        end_date: 200,
        trial_end: null,
        discounts: [{ coupon: null }],
        default_payment_method: "pm_1",
      },
    ],
  } as unknown as Stripe.SubscriptionSchedule);
  assert.equal(bad.unsupported.length, 3);
});

test("registry subscription.schedule (PA-11): parse/revalidate matrix; set_phases rebuilds phase 0 and maps durations; cancel is T2", async () => {
  const def = actionByKey("subscription.schedule")!;
  assert.equal(def.dangerous, true);
  assert.equal(def.parseParams({ subscriptionId: "sub_1", op: "set_phases", phases: [] }).ok, false);
  assert.equal(
    def.parseParams({ subscriptionId: "sub_1", op: "set_phases", phases: [{ priceId: "price_a", quantity: 1, durationCount: 99, durationUnit: "month" }] }).ok,
    false
  );
  const parsed = def.parseParams({
    subscriptionId: "sub_1",
    op: "set_phases",
    endBehavior: "cancel",
    phases: [
      { priceId: "price_a", quantity: 1, durationCount: 3, durationUnit: "month", trial: true },
      { priceId: "price_b", quantity: 2, durationCount: 1, durationUnit: "year", proration: "none" },
    ],
  });
  assert.ok(parsed.ok);
  const p = (parsed as { params: unknown }).params as Record<string, unknown>;

  const scheduleUpdates: Array<Record<string, unknown>> = [];
  const created: string[] = [];
  const mkCtx = (over: { subStatus?: string; schedule?: string | null; schedStatus?: string; priceRecurring?: boolean; allow?: string[] } = {}) =>
    ({
      stripe: {
        getSubscription: async () => ({ id: "sub_1", customer: "cus_1", status: over.subStatus ?? "active", schedule: over.schedule ?? null }),
        getSubscriptionSchedule: async () => ({
          id: "sched_1",
          status: over.schedStatus ?? "active",
          phases: [
            { items: [{ price: "price_old", quantity: 1, discounts: [] }], start_date: 100, end_date: 200, trial_end: null, discounts: [], default_payment_method: null },
          ],
        }),
        getPrice: async (id: string) => ({ id, active: true, recurring: over.priceRecurring === false ? null : { interval: "month" } }),
        createScheduleFromSubscription: async (subId: string) => {
          created.push(subId);
          return { id: "sched_new" };
        },
        updateSchedulePhases: async (schedId: string, params: Record<string, unknown>) => {
          scheduleUpdates.push({ schedId, ...params });
          return { id: schedId };
        },
        releaseSchedule: async (schedId: string, idem: string) => {
          scheduleUpdates.push({ released: schedId, idem });
          return { id: schedId };
        },
        cancelSchedule: async (schedId: string, idem: string) => {
          scheduleUpdates.push({ canceled: schedId, idem });
          return { id: schedId };
        },
      },
      settingsStore: { allowedPriceIds: () => over.allow ?? [] },
      stripeCustomerId: "cus_1",
      idemScope: "s1",
    }) as unknown as ActionExecCtx;

  assert.match((await def.revalidate(mkCtx({ subStatus: "canceled" }), p)) ?? "", /Subscription is canceled/);
  assert.match((await def.revalidate(mkCtx({ priceRecurring: false }), p)) ?? "", /not recurring/);
  assert.match((await def.revalidate(mkCtx({ allow: ["price_other"] }), p)) ?? "", /allowlist/);
  assert.match((await def.revalidate(mkCtx({ schedule: "sched_1", schedStatus: "released" }), p)) ?? "", /release/);
  assert.equal(await def.revalidate(mkCtx(), p), null);

  // Execute without a schedule: create → rebuild phase 0 → append mapped futures.
  const done = await def.execute(mkCtx(), p);
  assert.equal(done.ok, true);
  assert.deepEqual(created, ["sub_1"]);
  const update = scheduleUpdates[0] as { phases: Array<Record<string, unknown>>; endBehavior: string };
  assert.equal(update.endBehavior, "cancel");
  assert.equal(update.phases.length, 3);
  assert.deepEqual(update.phases[0], { items: [{ price: "price_old", quantity: 1 }], start_date: 100, end_date: 200 });
  assert.deepEqual(update.phases[1], {
    items: [{ price: "price_a", quantity: 1 }],
    duration: { interval: "month", interval_count: 3 },
    trial: true,
    proration_behavior: "create_prorations",
  });
  assert.deepEqual(update.phases[2], {
    items: [{ price: "price_b", quantity: 2 }],
    duration: { interval: "year", interval_count: 1 },
    proration_behavior: "none",
  });

  // Release / cancel need an attached schedule; cancel revalidation matrix.
  const relParsed = (def.parseParams({ subscriptionId: "sub_1", op: "release" }) as { params: unknown }).params;
  assert.match((await def.revalidate(mkCtx(), relParsed)) ?? "", /No schedule/);
  assert.equal(await def.revalidate(mkCtx({ schedule: "sched_1" }), relParsed), null);
  await def.execute(mkCtx({ schedule: "sched_1" }), relParsed);
  assert.ok((scheduleUpdates.at(-1) as { released?: string }).released === "sched_1");

  // Dashboard belts: op cancel = T2, set_phases = T1 only.
  const fake = fakeSettings();
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  const gatewayCalls: string[] = [];
  const dashboard = new Dashboard(fake.store, provider, [fakeSection()], {
    stripe: { isTestMode: () => true } as unknown as StripeClient,
    settings: fake.store,
    stores: {} as never,
    billing: {
      actions: {} as never,
      gateway: { request: async (_a: unknown, key: string) => { gatewayCalls.push(key); return { kind: "executed", text: "ok" }; } } as never,
    },
  });
  const cancel = await dashboard.api("action", "c", {
    key: "subscription.schedule",
    params: { subscriptionId: "sub_1", op: "cancel" },
    confirmWord: "CONFIRM",
  });
  assert.equal((cancel.json as { needsStepUp?: boolean }).needsStepUp, true);
  const setPhases = await dashboard.api("action", "c", {
    key: "subscription.schedule",
    params: { subscriptionId: "sub_1", op: "set_phases", phases: [{ priceId: "price_a", quantity: 1, durationCount: 1, durationUnit: "month" }] },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(setPhases.json, { ok: true, text: "ok" });
  assert.deepEqual(gatewayCalls, ["subscription.schedule"]);
});

test("schedule editor page (PA-11): token grammar, add/remove refs, baked server-parsed confirm, live-schedule panel + detail wiring", async () => {
  const section = makeSubscriptionsSection();

  // No schedule: locked current-phase card, picker adds tokens.
  const empty = await section.buildPage(subsCtx(), { page: "subscriptions.schedule", params: { id: "sub_1" }, filters: {} });
  assert.ok(empty!.blocks.some((b) => b.type === "kv" && (b as KeyValueBlock).title === "Current phase (locked)"));
  const picker = empty!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "schedpicker") as TableBlock;
  const addRef = picker.rows[0].actions![0].ref!;
  assert.equal(addRef.filters!.phases, "price_old*1*1m");

  // Composed tokens render, reorder/remove refs rewrite the token list, and
  // the confirm bakes the SERVER-parsed phases.
  const composed = await section.buildPage(subsCtx(), {
    page: "subscriptions.schedule",
    params: { id: "sub_1" },
    filters: { phases: "price_old*1*3m*t,price_new*2*1y*pn,garbage", end: "cancel" },
  });
  const table = composed!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "composed") as TableBlock;
  assert.equal(table.rows.length, 2);
  assert.ok(table.notice!.includes("1 invalid"));
  const downRef = table.rows[0].actions!.find((a) => a.label === "Down")!.ref!;
  assert.equal(downRef.filters!.phases, "price_new*2*1y*pn,price_old*1*3m*t");
  const removeRef = table.rows[1].actions!.find((a) => a.label === "Remove")!.ref!;
  assert.equal(removeRef.filters!.phases, "price_old*1*3m*t");
  const confirm = composed!.blocks.find((b) => b.type === "kv" && (b as KeyValueBlock).title === "Confirm") as KeyValueBlock;
  assert.deepEqual(confirm.actions![0].params, {
    subscriptionId: "sub_1",
    op: "set_phases",
    endBehavior: "cancel",
    phases: [
      { priceId: "price_old", quantity: 1, durationCount: 3, durationUnit: "month", trial: true, proration: "create_prorations" },
      { priceId: "price_new", quantity: 2, durationCount: 1, durationUnit: "year", proration: "none" },
    ],
  });
  assert.ok(composed!.blocks.some((b) => b.type === "timeline"));

  // With a live schedule: read-only phases panel + Release/Cancel header
  // actions (cancel = stepUp); the sub DETAIL gains the panel + edit link.
  const schedCtx = subsCtx();
  const liveSchedule = {
    id: "sched_1",
    status: "active",
    end_behavior: "release",
    current_phase: { start_date: 100, end_date: 200 },
    phases: [
      { items: [{ price: "price_old", quantity: 1 }], start_date: 100, end_date: 200, trial_end: null, discounts: [] },
      { items: [{ price: "price_new", quantity: 1 }], start_date: 200, end_date: 300, trial_end: null, discounts: [] },
    ],
  };
  (schedCtx.stripe as unknown as Record<string, unknown>).getSubscription = async () => ({
    ...(await (subsCtx().stripe as unknown as { getSubscription: () => Promise<Record<string, unknown>> }).getSubscription()),
    schedule: "sched_1",
  });
  (schedCtx.stripe as unknown as Record<string, unknown>).getSubscriptionSchedule = async () => liveSchedule;
  const withSched = await section.buildPage(schedCtx, { page: "subscriptions.schedule", params: { id: "sub_1" }, filters: {} });
  const header = withSched!.blocks[0] as HeaderBlock;
  assert.deepEqual(header.actions!.map((a) => a.label), ["Release schedule", "Cancel schedule"]);
  assert.equal(header.actions![1].stepUp, true);
  const panel = withSched!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "schedulephases") as TableBlock;
  assert.equal(panel.rows.length, 2);
  assert.deepEqual((panel.rows[0].cells[4] as { badges: Array<{ text: string }> }).badges.map((b) => b.text), ["Current"]);

  const detail = await section.buildPage(schedCtx, { page: "subscriptions.detail", params: { id: "sub_1" } });
  const detailPanel = detail!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "schedulephases") as TableBlock;
  assert.ok(detailPanel);
  assert.deepEqual(detailPanel.footerRef, { page: "subscriptions.schedule", params: { id: "sub_1" } });
  const detailHeader = detail!.blocks.find((b) => b.type === "header") as HeaderBlock;
  assert.ok(detailHeader.actions!.some((a) => a.label === "Edit schedule"));
});

// ---- PA-8: router fix, +Create, invoice composer, Customer-360 writes ----

test("client router (PA-8/13): real /billing paths round-trip (id-less subpages, filters as query params, legacy #/ links) and the shell ships the +Create menu", () => {
  // Exercise the REAL shipped client code: extract BASE/parseRoute/hrefFor
  // from the clientApp module string and run them with a stubbed location.
  const start = clientApp.indexOf("D.BASE");
  const end = clientApp.indexOf("D.go =");
  assert.ok(start >= 0 && end > start);
  const makeD = new Function(
    "location",
    `var D = { defaultPage: "home" };\n${clientApp.slice(start, end)}\nreturn D;`
  ) as (location: { pathname: string; search: string; hash: string }) => {
    parseRoute(): { page: string; params: Record<string, string>; filters: Record<string, string> };
    hrefFor(page: string, params: Record<string, string>, filters: Record<string, string>): string;
  };
  const locFor = (href: string) => {
    const qi = href.indexOf("?");
    return { pathname: qi < 0 ? href : href.slice(0, qi), search: qi < 0 ? "" : href.slice(qi), hash: "" };
  };
  const roundTrip = (page: string, params: Record<string, string> = {}, filters: Record<string, string> = {}) => {
    const D = makeD({ pathname: "/billing", search: "", hash: "" });
    const href = D.hrefFor(page, params, filters);
    assert.ok(href.startsWith("/billing/"), `href ${href} must be a real path`);
    return makeD(locFor(href)).parseRoute();
  };
  assert.deepEqual(roundTrip("subscriptions.new"), { page: "subscriptions.new", params: {}, filters: {} });
  assert.deepEqual(roundTrip("invoices.new"), { page: "invoices.new", params: {}, filters: {} });
  assert.deepEqual(roundTrip("customers.detail", { id: "cus_1" }), { page: "customers.detail", params: { id: "cus_1" }, filters: {} });
  assert.deepEqual(roundTrip("customers.portal", { id: "cus_1" }), { page: "customers.portal", params: { id: "cus_1" }, filters: {} });
  assert.deepEqual(roundTrip("subscriptions.changeplan", { id: "sub_1" }), {
    page: "subscriptions.changeplan",
    params: { id: "sub_1" },
    filters: {},
  });
  // Filters ride real query params — copyable URLs (PA-13 user decision).
  const withFilters = makeD({ pathname: "/billing", search: "", hash: "" }).hrefFor("payments", {}, { status: "failed", date: "7d" });
  assert.equal(withFilters, "/billing/payments?f_status=failed&f_date=7d");
  assert.deepEqual(makeD(locFor(withFilters)).parseRoute().filters, { status: "failed", date: "7d" });
  // Panel root → default page; legacy #/… links still parse.
  assert.equal(makeD({ pathname: "/billing", search: "", hash: "" }).parseRoute().page, "home");
  assert.deepEqual(makeD({ pathname: "/billing", search: "", hash: "#/customers/cus_9?f_x=1" }).parseRoute(), {
    page: "customers.detail",
    params: { id: "cus_9" },
    filters: { x: "1" },
  });
  // SPA glue exists: pushState navigation, popstate handling, link interception.
  assert.ok(clientApp.includes("history.pushState"));
  assert.ok(clientApp.includes('window.addEventListener("popstate", D.onRouteChange)'));
  assert.ok(clientApp.includes("D.bindLinks"));
  // Every sidebar entry ships a nav icon — icon-less items render misaligned.
  const iconsBlock = clientApp.slice(clientApp.indexOf("D.NAV_ICONS"), clientApp.indexOf("D.navIcon ="));
  const NAV_ROOTS = [
    "home", "balances", "payments", "customers", "subscriptions", "invoices", "disputes", "catalog",
    "links", "quotes", "approvals", "blocklist", "fraud", "portal", "meters", "events", "webhooks",
    "reports", "bookmarks", "security",
  ];
  for (const root of NAV_ROOTS) {
    assert.ok(new RegExp(`\\b${root}: "`).test(iconsBlock), `nav page "${root}" has no icon in D.NAV_ICONS`);
  }

  // Topbar + Create: markup in the shell, bind + items in the client.
  const html = renderDashboardShell({ nonce: "n" });
  assert.ok(html.includes('id="createbtn"'));
  assert.ok(html.includes('id="createmenu"'));
  assert.ok(clientApp.includes("D.bindCreate"));
  for (const label of ["New customer", "New invoice", "New subscription", "New payment link", "New quote"]) {
    assert.ok(clientApp.includes(label), `missing +Create item ${label}`);
  }
});

test("gateway (PA-8): customer.balance folds direction+major into signed deltaMinor; baked invoice items[] pass through untouched", async () => {
  const { gateway } = gatewayFixture();
  const credit = await gateway.resolve("customer.balance", {
    customerId: "cus_1",
    mode: "credit",
    amountMajor: 12.5,
    currency: "EUR",
  });
  assert.ok(credit.ok);
  const creditParams = (credit as { params: Record<string, unknown> }).params;
  assert.equal(creditParams.deltaMinor, -1250);
  assert.equal(creditParams.currency, "eur");
  assert.ok(!("mode" in creditParams) && !("amountMajor" in creditParams));
  const debit = await gateway.resolve("customer.balance", { customerId: "cus_1", mode: "debit", amountMajor: 5, currency: "jpy" });
  assert.ok(debit.ok);
  assert.equal((debit as { params: Record<string, unknown> }).params.deltaMinor, 5); // zero-decimal
  const bad = await gateway.resolve("customer.balance", { customerId: "cus_1", mode: "credit", amountMajor: -3, currency: "eur" });
  assert.equal(bad.ok, false);
  // Composer-baked multi-line items skip the one-line folding entirely.
  const items = [
    { description: "Pro ×2", amountMinor: 5800, currency: "eur" },
    { description: "Setup fee", amountMinor: 4900, currency: "eur" },
  ];
  const draft = await gateway.resolve("invoice.create_draft", { customerId: "cus_1", daysUntilDue: 30, items });
  assert.ok(draft.ok);
  assert.deepEqual((draft as { params: Record<string, unknown> }).params.items, items);
});

function invoiceComposerCtx() {
  const ctx = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listAllActivePrices: async () => [
        { id: "price_a", nickname: "Pro", unit_amount: 2900, currency: "eur", product: "prod_1", recurring: { interval: "month" } },
        { id: "price_b", nickname: "US One-off", unit_amount: 900, currency: "usd", product: "prod_2", recurring: null },
      ],
      getCustomer: async (id: string) => ({ id, name: "Ada Lovelace", email: "ada@example.com", deleted: false }),
    },
    settings: {} as never,
    stores: {} as never,
    billing: { actions: { effectiveMode: () => "direct" }, gateway: {} as never },
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
  return ctx;
}

test("invoice composer (PA-8): lines accumulate via URL tokens, currency-locks the picker, and bakes registry items[] server-side", async () => {
  const section = makeInvoicesSection();
  const ctx = invoiceComposerCtx();

  // No customer yet: guidance notice, no Create block, full picker.
  const empty = await section.buildPage(ctx, { page: "invoices.new", filters: {} });
  assert.ok(empty!.blocks.some((b) => b.type === "notice" && (b as NoticeBlock).text.includes("cus_")));
  assert.ok(!empty!.blocks.some((b) => b.type === "kv" && (b as KeyValueBlock).title === "Create"));
  const picker = empty!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "picker") as TableBlock;
  assert.equal(picker.rows.length, 2);
  // Add-ref carries the price token plus the whole filter state.
  const addRef = picker.rows[0].actions![0].ref!;
  assert.equal(addRef.page, "invoices.new");
  assert.equal(addRef.filters!.lines, "price_a*1");

  // Customer + 2× price_a: line table, totals, Create bakes items[] + due days.
  const built = await section.buildPage(ctx, {
    page: "invoices.new",
    filters: { customer: "cus_1", lines: "price_a*2", due: "14" },
  });
  const lines = built!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "lines") as TableBlock;
  assert.equal(lines.rows.length, 1);
  assert.deepEqual(lines.rows[0].cells[3], { t: "money", v: "58.00 EUR" });
  // Remove-ref drops the token (empty lines filter is omitted entirely).
  assert.equal(lines.rows[0].actions![0].ref!.filters!.lines, undefined);
  const totals = built!.blocks.find((b) => b.type === "kv" && (b as KeyValueBlock).title === "Totals") as KeyValueBlock;
  assert.deepEqual(totals.rows[1].cell, { t: "money", v: "58.00 EUR" });
  const create = built!.blocks.find((b) => b.type === "kv" && (b as KeyValueBlock).title === "Create") as KeyValueBlock;
  const confirm = create.actions![0];
  assert.equal(confirm.key, "invoice.create_draft");
  assert.deepEqual(confirm.params, {
    customerId: "cus_1",
    daysUntilDue: 14,
    items: [{ description: "Pro ×2", amountMinor: 5800, currency: "eur" }],
  });
  // Picker is currency-locked to EUR (the USD price disappears).
  const lockedPicker = built!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "picker") as TableBlock;
  assert.deepEqual(lockedPicker.rows.map((r) => r.id), ["price_a"]);

  // Pending custom line parses "desc | amount | cur" into an encoded token.
  const custom = await section.buildPage(ctx, {
    page: "invoices.new",
    filters: { customer: "cus_1", lines: "price_a*1", custom: "Setup fee | 49.00 | eur" },
  });
  const customNotice = custom!.blocks.find((b) => b.type === "notice" && (b as NoticeBlock).actions?.length) as NoticeBlock;
  assert.ok(customNotice);
  assert.equal(customNotice.actions![0].ref!.filters!.lines, "price_a*1,c:Setup%20fee:4900:eur");
  assert.equal(customNotice.actions![0].ref!.filters!.custom, undefined); // consumed on add

  // Mixed currencies refuse to compose.
  const mixed = await section.buildPage(ctx, {
    page: "invoices.new",
    filters: { customer: "cus_1", lines: "price_a*1,c:Extra:500:usd" },
  });
  assert.ok(mixed!.blocks.some((b) => b.type === "notice" && (b as NoticeBlock).badge.text === "Mixed currencies"));
  assert.ok(!mixed!.blocks.some((b) => b.type === "kv" && (b as KeyValueBlock).title === "Create"));

  // The invoices-list entry is now a link-button into the composer.
  const invCtx = {
    ...ctx,
    stripe: {
      ...(ctx.stripe as object),
      listInvoicesByStatus: async () => ({ data: [], has_more: false }),
    },
  } as unknown as DashboardCtx;
  const list = await section.buildPage(invCtx, { page: "invoices", filters: {} });
  const listHeader = list!.blocks[0] as HeaderBlock;
  assert.deepEqual(listHeader.actions![0].ref, { page: "invoices.new" });
});

test("customer 360 (PA-8): inline edit on the Details card, row actions on subs/invoices, credit grants table + T1/T2 belts", async () => {
  const section = makeCustomersSection();
  const ctx = fakeCustomerCtx();
  (ctx.stripe as unknown as Record<string, unknown>).listInvoices = async () => ({
    invoices: [
      { id: "in_open", number: "INV-2", status: "open", total: 900, currency: "eur", created: 1_700_000_300 },
      { id: "in_paid", number: "INV-1", status: "paid", total: 2900, currency: "eur", created: 1_700_000_100 },
    ],
    hasMore: false,
  });
  (ctx.stripe as unknown as Record<string, unknown>).listCreditGrants = async () => [
    {
      id: "credgr_live",
      amount: { type: "monetary", monetary: { value: 2500, currency: "eur" } },
      category: "promotional",
      name: "Goodwill",
      customer: "cus_test1",
      effective_at: 1_700_000_000,
      expires_at: null,
      voided_at: null,
    },
    {
      id: "credgr_dead",
      amount: { type: "monetary", monetary: { value: 1000, currency: "eur" } },
      category: "paid",
      name: null,
      customer: "cus_test1",
      effective_at: 1_700_000_000,
      expires_at: null,
      voided_at: 1_700_100_000,
    },
  ];
  const page = await section.buildPage(ctx, { page: "customers.detail", params: { id: "cus_test1" } });

  // Inline edit: the Details rail card carries the three edit modals.
  const details = page!.rail!.find((b) => b.type === "kv" && (b as KeyValueBlock).title === "Details") as KeyValueBlock;
  assert.deepEqual(
    (details.actions ?? []).map((a) => a.key),
    ["section:customers.update", "section:customers.tax_locale", "section:customers.metadata"]
  );
  // The edit page is gone.
  assert.equal(section.ownsPage("customers.edit"), false);

  // Subscription rows: Update link into the change-plan flow.
  const subsTable = page!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "subs") as TableBlock;
  assert.deepEqual(subsTable.rows[0].actions![0].ref, { page: "subscriptions.changeplan", params: { id: "sub_1" } });

  // Invoice rows: state actions on OPEN (Collect now = T2), none on PAID.
  const invTable = page!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "invoices") as TableBlock;
  const openActions = invTable.rows[0].actions!;
  assert.deepEqual(openActions.map((a) => a.label), ["Send", "Collect now", "Void"]);
  assert.equal(openActions[1].stepUp, true);
  assert.equal(invTable.rows[1].actions!.length, 0);

  // Credit grants table: active row voidable, voided row shows no action.
  const grants = page!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "creditgrants") as TableBlock;
  assert.equal(grants.rows.length, 2);
  assert.equal(grants.rows[0].actions![0].key, "section:customers.credit_grant_void");
  assert.equal(grants.rows[1].actions!.length, 0);
  const grantAmount = grants.rows[0].cells[0] as { badge?: { text: string } };
  assert.equal(grantAmount.badge!.text, "Active");
  assert.equal((grants.rows[1].cells[0] as { badge?: { text: string } }).badge!.text, "Voided");

  // Grant belts: CONFIRM first, then a fresh factor (fixture is stale) —
  // no Stripe write happens before the gates pass.
  const grantsCreated: Array<Record<string, unknown>> = [];
  (ctx.stripe as unknown as Record<string, unknown>).createCreditGrant = async (p: Record<string, unknown>) => {
    grantsCreated.push(p);
    return { id: "credgr_new" };
  };
  const noConfirm = await section.action!(ctx, {
    key: "section:customers.credit_grant",
    params: { customerId: "cus_test1", amountMajor: 25, currency: "eur" },
  });
  assert.equal(noConfirm.ok, false);
  const stale = await section.action!(ctx, {
    key: "section:customers.credit_grant",
    params: { customerId: "cus_test1", amountMajor: 25, currency: "eur" },
    confirmWord: "CONFIRM",
  });
  assert.deepEqual(stale, { ok: false, needsStepUp: true });
  assert.equal(grantsCreated.length, 0);
  (ctx as unknown as { security: Record<string, unknown> }).security = {
    sessionIdHash: "h",
    authMethod: "passkey",
    stepUpFresh: () => true,
  };
  const granted = await section.action!(ctx, {
    key: "section:customers.credit_grant",
    params: { customerId: "cus_test1", amountMajor: 25, currency: "eur", category: "promotional", expiresDays: 30 },
    confirmWord: "CONFIRM",
  });
  assert.equal(granted.ok, true);
  assert.equal(grantsCreated[0].amountMinor, 2500);
  assert.equal(grantsCreated[0].category, "promotional");
  assert.ok(typeof grantsCreated[0].expiresAt === "number");

  // Void belts: live revalidation refuses voided grants and foreign customers.
  const voided: string[] = [];
  (ctx.stripe as unknown as Record<string, unknown>).getCreditGrant = async (id: string) =>
    id === "credgr_dead"
      ? { id, customer: "cus_test1", voided_at: 1_700_100_000, expires_at: null }
      : id === "credgr_foreign"
        ? { id, customer: "cus_other", voided_at: null, expires_at: null }
        : { id, customer: "cus_test1", voided_at: null, expires_at: null };
  (ctx.stripe as unknown as Record<string, unknown>).voidCreditGrant = async (id: string) => {
    voided.push(id);
    return { id };
  };
  const deadVoid = await section.action!(ctx, {
    key: "section:customers.credit_grant_void",
    params: { customerId: "cus_test1", grantId: "credgr_dead" },
    confirmWord: "CONFIRM",
  });
  assert.equal(deadVoid.ok, false);
  const foreignVoid = await section.action!(ctx, {
    key: "section:customers.credit_grant_void",
    params: { customerId: "cus_test1", grantId: "credgr_foreign" },
    confirmWord: "CONFIRM",
  });
  assert.equal(foreignVoid.ok, false);
  const okVoid = await section.action!(ctx, {
    key: "section:customers.credit_grant_void",
    params: { customerId: "cus_test1", grantId: "credgr_live" },
    confirmWord: "CONFIRM",
  });
  assert.equal(okVoid.ok, true);
  assert.deepEqual(voided, ["credgr_live"]);
});

// ---- real count-cards (search totals instead of window-capped numbers) ----

test("count-cards: payments chips use search totals (scoped by customer+date), cap renders '10,000+', search failure falls back to windowed 'N+'", async () => {
  const section = makePaymentsSection();
  const queries: Array<[string, string]> = [];
  const ctx = paymentsCtx();
  (ctx.stripe as unknown as Record<string, unknown>).countBySearch = async (kind: string, q: string) => {
    queries.push([kind, q]);
    if (q === "created>0") return 12_345; // the All chip — over the search cap
    if (q.includes('status:"succeeded"') && kind === "charges") return 431;
    return 7;
  };
  const page = await section.buildPage(ctx, { page: "payments", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  const counts = Object.fromEntries(table.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(counts.All, "10,000+"); // capped totals are floors, never fake exact numbers
  assert.equal(counts.Succeeded, 431);
  assert.equal(counts.Incomplete, 5 * 7); // one search per incomplete PI status, summed
  // Customer + date filters scope the queries (client-side filters don't).
  (ctx.stripe as unknown as Record<string, unknown>).listCharges = async () => ({ charges: [], hasMore: false });
  (ctx.stripe as unknown as Record<string, unknown>).listPaymentIntents = async () => [];
  queries.length = 0;
  await section.buildPage(ctx, { page: "payments", filters: { customer: "cus_a", date: "7d" } });
  assert.ok(queries.length > 0);
  assert.ok(queries.every(([, q]) => q.includes('customer:"cus_a"') && q.includes("created>=")));

  // No countBySearch on the client (or it throws) → windowed counts, "+" when
  // the window overflowed instead of a bare wrong number.
  const stale = paymentsCtx();
  (stale.stripe as unknown as Record<string, unknown>).listAllCharges = async () => ({
    charges: [
      {
        id: "ch_1",
        status: "succeeded",
        captured: true,
        refunded: false,
        disputed: false,
        amount: 100,
        amount_refunded: 0,
        currency: "eur",
        created: 1,
        billing_details: {},
      },
    ],
    hasMore: true,
  });
  const fallback = await section.buildPage(stale, { page: "payments", filters: {} });
  const fbTable = fallback!.blocks.find((b) => b.type === "table") as TableBlock;
  const fbCounts = Object.fromEntries(fbTable.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(fbCounts.All, "1+");
  assert.equal(fbCounts.Succeeded, "1+");
});

test("count-cards: invoices chips use invoices.search per status; subscriptions search only unscoped (Paused/scoped stay windowed)", async () => {
  // Invoices: per-status totals + customer scoping.
  const invSection = makeInvoicesSection();
  const invQueries: string[] = [];
  const invCtx2 = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listInvoicesByStatus: async () => ({
        data: [{ id: "in_1", status: "open", total: 100, currency: "eur", created: 1, customer: "cus_1", number: "I-1" }],
        has_more: true,
      }),
      countBySearch: async (kind: string, q: string) => {
        assert.equal(kind, "invoices");
        invQueries.push(q);
        return q.includes('status:"open"') ? 42 : 500;
      },
    },
    billing: { actions: { effectiveMode: () => "direct" } },
    audit: async () => {},
  } as unknown as DashboardCtx;
  const invPage = await invSection.buildPage(invCtx2, { page: "invoices", filters: { customer: "cus_1" } });
  const invTable = invPage!.blocks.find((b) => b.type === "table") as TableBlock;
  const invCounts = Object.fromEntries(invTable.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(invCounts.All, 500);
  assert.equal(invCounts.Open, 42);
  assert.ok(invQueries.every((q) => q.includes('customer:"cus_1"')));

  // Subscriptions: search totals account-wide; Paused chip is windowed; a
  // customer/price scope disables search entirely (fields aren't indexed).
  const subSection = makeSubscriptionsSection();
  const subQueries: string[] = [];
  const subCtx2 = subsCtx();
  (subCtx2.stripe as unknown as Record<string, unknown>).countBySearch = async (kind: string, q: string) => {
    assert.equal(kind, "subscriptions");
    subQueries.push(q);
    return 99;
  };
  const subPage = await subSection.buildPage(subCtx2, { page: "subscriptions", filters: {} });
  const subTable = subPage!.blocks.find((b) => b.type === "table") as TableBlock;
  const subCounts = Object.fromEntries(subTable.counts!.items.map((i) => [i.label, i.count]));
  assert.equal(subCounts.All, 99);
  assert.equal(subCounts.Active, 99);
  assert.ok(typeof subCounts.Paused === "number"); // pause_collection is not searchable
  assert.ok(subQueries.length > 0);
  subQueries.length = 0;
  await subSection.buildPage(subCtx2, { page: "subscriptions", filters: { customer: "cus_1" } });
  assert.equal(subQueries.length, 0); // scoped view never searches
});

// ---- PA-12: ops & observability ----

test("groundwork (PA-12): CSV export rides saveBlob (no data: URI); the modal handles ActionResult.file/link; flash links are noopener and survive the reload", () => {
  // 12.0 + 13.7 in one implementation: Blob download sink, CSV swapped onto it.
  assert.ok(clientBlocks.includes("D.saveBlob = function"));
  assert.ok(clientBlocks.includes("URL.createObjectURL"));
  assert.ok(!clientBlocks.includes("data:text/csv"));
  // Modal ok-branch: file → bytes → saveBlob; link → flashOk's second arg.
  assert.ok(clientModal.includes("j.file"));
  assert.ok(clientModal.includes("D.saveBlob(j.file.name"));
  assert.ok(clientModal.includes("j.link || null"));
  // loadPage clears the flash on entry — the flash call must come AFTER it or
  // the message (and the short-lived link anchor) is wiped instantly.
  assert.ok(clientModal.indexOf("D.loadPage();") < clientModal.indexOf("D.flashOk(j.queued"));
  // Link anchors: child nodes with textContent + rel=noopener, never innerHTML.
  assert.ok(clientCore.includes('a.rel = "noopener"'));
  assert.ok(clientCore.includes("a.textContent = link.label"));
});

test("quote PDF (PA-12): open/accepted only, cap/magic failure degrades friendly, success returns ActionResult.file", async () => {
  const { makeQuotesSection: makeQuotes12 } = await import("../sections/quotesSection");
  const section = makeQuotes12();
  const { ctx } = quotesCtx();
  const stripe = ctx.stripe as unknown as Record<string, unknown>;
  stripe.getQuotePdf = async () => Buffer.from("%PDF-1.4 fake quote");
  // Draft → refused on the live status re-read, before any PDF fetch.
  const draft = await section.action!(ctx, { key: "section:quotes.pdf", params: { id: "qt_draft" } });
  assert.equal(draft.ok, false);
  assert.match(draft.error!, /open or accepted/);
  // Open → file payload named after the quote number.
  const ok = await section.action!(ctx, { key: "section:quotes.pdf", params: { id: "qt_open" } });
  assert.equal(ok.ok, true);
  assert.equal(ok.file!.name, "QT-0002.pdf");
  assert.equal(ok.file!.mime, "application/pdf");
  assert.equal(Buffer.from(ok.file!.b64, "base64").toString(), "%PDF-1.4 fake quote");
  // Over-cap / non-PDF (StripeClient returns null) → friendly pointer.
  stripe.getQuotePdf = async () => null;
  const overCap = await section.action!(ctx, { key: "section:quotes.pdf", params: { id: "qt_open" } });
  assert.equal(overCap.ok, false);
  assert.match(overCap.error!, /Stripe Dashboard/);
});

test("events page (PA-12): curated select + validated typeq pill (custom wins, garbage dropped), object refs via shared refForId, evt_ cursor", async () => {
  const { makeEventsSection } = await import("../sections/eventsSection");
  const section = makeEventsSection();
  const calls: Array<Record<string, unknown>> = [];
  const ctx = {
    stripe: {
      listEventsPage: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          events: [
            { id: "evt_1", type: "invoice.paid", created: 1_700_000_000, data: { object: { id: "in_9", object: "invoice" } } },
            { id: "evt_2", type: "customer.created", created: 1_700_000_100, data: { object: { id: "cus_9", object: "customer" } } },
          ],
          hasMore: true,
        };
      },
    },
  } as unknown as DashboardCtx;
  const page = await section.buildPage(ctx, { page: "events", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.rows.length, 2);
  const objCell = table.rows[0].cells[1] as { t: string; ref?: { page: string } };
  assert.equal(objCell.ref!.page, "invoices.detail");
  assert.equal(table.nextCursor, "evt_2");
  assert.equal(calls[0].type, undefined);
  // typeq wins over the curated select.
  await section.buildPage(ctx, { page: "events", filters: { type: "invoice.paid", typeq: "charge.*" } });
  assert.equal(calls[1].type, "charge.*");
  // Garbage typeq is dropped server-side (it would flow into the Stripe param).
  await section.buildPage(ctx, { page: "events", filters: { typeq: "DROP TABLE; --" } });
  assert.equal(calls[2].type, undefined);
  // The select value must come from the curated set.
  await section.buildPage(ctx, { page: "events", filters: { type: "evil.type" } });
  assert.equal(calls[3].type, undefined);
  // refForId moved to cells.ts and grew the PA-7 object families.
  assert.equal(refForId("plink_1")!.page, "links.detail");
  assert.equal(refForId("qt_1")!.page, "quotes.detail");
  assert.equal(refForId("prod_1")!.page, "catalog.detail");
  assert.equal(refForId("evt_1"), null);
});

function webhooksCtx(opts: { botManagedId?: string | null } = {}) {
  const audits: string[] = [];
  const updates: Array<[string, Record<string, unknown>]> = [];
  const deletes: string[] = [];
  const endpoints = [
    {
      id: "we_bot",
      url: "https://bot.example.com/stripe",
      status: "enabled",
      enabled_events: ["charge.refunded", "charge.dispute.created", "invoice.paid", "invoice.payment_failed"],
      api_version: "2026-06-01",
      created: 1_700_000_000,
    },
    { id: "we_other", url: "https://ext.example.com/hook", status: "enabled", enabled_events: ["*"], api_version: null, created: 1_700_000_100 },
  ];
  const ctx = {
    actor: { id: "42", name: "Ada", role: "admin", isAdmin: true },
    stripe: {
      listWebhookEndpoints: async () => endpoints,
      createWebhookEndpoint: async () => ({ id: "we_new", secret: "whsec_SUPERSECRET123" }),
      updateWebhookEndpoint: async (id: string, params: Record<string, unknown>) => {
        updates.push([id, params]);
        return {};
      },
      deleteWebhookEndpoint: async (id: string) => {
        deletes.push(id);
      },
    },
    settings: { stripeWebhookEndpointId: () => (opts.botManagedId === undefined ? "we_bot" : opts.botManagedId) },
    audit: async (c: string) => {
      audits.push(c);
    },
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => true },
  } as unknown as DashboardCtx;
  return { ctx, audits, updates, deletes };
}

test("webhooks (PA-12): bot-managed row is badged + actionless and the SERVER refuses disable/delete on it; whsec_ shows once in text and never in the audit", async () => {
  const { makeWebhooksSection } = await import("../sections/webhooksSection");
  const section = makeWebhooksSection();
  const f = webhooksCtx();
  const page = await section.buildPage(f.ctx, { page: "webhooks", filters: {} });
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  const botRow = table.rows.find((r) => r.id === "we_bot")!;
  assert.equal(botRow.actions, undefined);
  const flags = botRow.cells[1] as { t: string; badges: Array<{ text: string }> };
  assert.equal(flags.t, "flags");
  assert.ok(flags.badges.some((b) => b.text === "Bot-managed"));
  const otherRow = table.rows.find((r) => r.id === "we_other")!;
  assert.equal(otherRow.actions!.length, 2);
  const evCell = otherRow.cells[2] as { v: string };
  assert.equal(evCell.v, "All events");

  // Server-side bot-managed refusal regardless of what the client baked.
  const disable = await section.action!(f.ctx, {
    key: "section:webhooks.toggle",
    params: { id: "we_bot", enabled: false },
    confirmWord: "CONFIRM",
  });
  assert.equal(disable.ok, false);
  assert.match(disable.error!, /bot-managed/i);
  const del = await section.action!(f.ctx, { key: "section:webhooks.delete", params: { id: "we_bot" }, confirmWord: "CONFIRM" });
  assert.equal(del.ok, false);
  assert.equal(f.deletes.length, 0);
  assert.equal(f.updates.length, 0);

  // T1: writes refuse without CONFIRM.
  const noConfirm = await section.action!(f.ctx, { key: "section:webhooks.create", params: { url: "https://x.example/hook", all: true } });
  assert.equal(noConfirm.ok, false);

  // Create: http URL and bad event tokens refused; success discloses the
  // secret ONCE in text while the audit records only that a disclosure happened.
  const httpUrl = await section.action!(f.ctx, {
    key: "section:webhooks.create",
    params: { url: "http://x.example/hook", all: true },
    confirmWord: "CONFIRM",
  });
  assert.equal(httpUrl.ok, false);
  const badEvents = await section.action!(f.ctx, {
    key: "section:webhooks.create",
    params: { url: "https://x.example/hook", events: "invoice.paid NOT-VALID!" },
    confirmWord: "CONFIRM",
  });
  assert.equal(badEvents.ok, false);
  const created = await section.action!(f.ctx, {
    key: "section:webhooks.create",
    params: { url: "https://x.example/hook", events: "invoice.paid charge.*" },
    confirmWord: "CONFIRM",
  });
  assert.equal(created.ok, true);
  assert.ok(created.text!.includes("whsec_SUPERSECRET123"));
  assert.ok(f.audits.length > 0);
  assert.ok(f.audits.every((a) => !a.includes("whsec_")));
  assert.match(f.audits[f.audits.length - 1], /disclosed once to Ada/);

  // Toggle (non-managed): live re-read refuses a no-op enable, disable works.
  const already = await section.action!(f.ctx, {
    key: "section:webhooks.toggle",
    params: { id: "we_other", enabled: true },
    confirmWord: "CONFIRM",
  });
  assert.equal(already.ok, false);
  const disabled = await section.action!(f.ctx, {
    key: "section:webhooks.toggle",
    params: { id: "we_other", enabled: false },
    confirmWord: "CONFIRM",
  });
  assert.equal(disabled.ok, true);
  assert.deepEqual(f.updates, [["we_other", { disabled: true }]]);
});

test("reports (PA-12): run validates curated type + dates; download link only for succeeded runs (10-min expiry) via ActionResult.link; Refresh is a no-op ok", async () => {
  const { makeReportsSection } = await import("../sections/reportsSection");
  const section = makeReportsSection();
  const links: Array<[string, number]> = [];
  const created: Array<[string, Record<string, unknown>]> = [];
  const runs: Record<string, Record<string, unknown>> = {
    frr_ok: {
      id: "frr_ok",
      report_type: "balance.summary.1",
      status: "succeeded",
      created: 1_700_000_000,
      result: { id: "file_1" },
      parameters: { interval_start: 1_680_000_000, interval_end: 1_690_000_000 },
    },
    frr_wip: { id: "frr_wip", report_type: "balance.summary.1", status: "pending", created: 1_700_000_050, result: null, parameters: {} },
  };
  const ctx = {
    stripe: {
      listReportRuns: async () => Object.values(runs),
      getReportRun: async (id: string) => {
        if (!runs[id]) throw new Error("nope");
        return runs[id];
      },
      createReportRun: async (type: string, params: Record<string, unknown>) => {
        created.push([type, params]);
        return { id: "frr_new" };
      },
      createFileLink: async (fileId: string, expiresAt: number) => {
        links.push([fileId, expiresAt]);
        return { url: "https://files.stripe.com/links/x" };
      },
    },
    audit: async () => {},
  } as unknown as DashboardCtx;

  // Page: Refresh in the header; the download row action only on the succeeded run.
  const page = await section.buildPage(ctx, { page: "reports", filters: {} });
  const header = page!.blocks[0] as HeaderBlock;
  assert.ok(header.actions!.some((a) => a.key === "section:reports.refresh"));
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.rows.find((r) => r.id === "frr_ok")!.actions!.length, 1);
  assert.equal(table.rows.find((r) => r.id === "frr_wip")!.actions, undefined);

  // Run: curated types only; YYYY-MM-DD; start<end≤now.
  const badType = await section.action!(ctx, { key: "section:reports.run", params: { reportType: "evil.1", start: "2026-06-01", end: "2026-07-01" } });
  assert.equal(badType.ok, false);
  const badDate = await section.action!(ctx, { key: "section:reports.run", params: { reportType: "balance.summary.1", start: "junk", end: "2026-07-01" } });
  assert.equal(badDate.ok, false);
  const reversed = await section.action!(ctx, { key: "section:reports.run", params: { reportType: "balance.summary.1", start: "2026-07-01", end: "2026-06-01" } });
  assert.equal(reversed.ok, false);
  const future = await section.action!(ctx, { key: "section:reports.run", params: { reportType: "balance.summary.1", start: "2026-06-01", end: "2099-01-01" } });
  assert.equal(future.ok, false);
  assert.equal(created.length, 0);
  const okRun = await section.action!(ctx, { key: "section:reports.run", params: { reportType: "balance.summary.1", start: "2026-06-01", end: "2026-07-01" } });
  assert.equal(okRun.ok, true);
  assert.equal(created.length, 1);

  // Link: live re-read refuses pending; succeeded mints a ~600s FileLink.
  const pending = await section.action!(ctx, { key: "section:reports.link", params: { id: "frr_wip" } });
  assert.equal(pending.ok, false);
  assert.equal(links.length, 0);
  const linked = await section.action!(ctx, { key: "section:reports.link", params: { id: "frr_ok" } });
  assert.equal(linked.ok, true);
  assert.equal(linked.link!.label, "Download report");
  assert.equal(links[0][0], "file_1");
  const ttl = links[0][1] - Math.floor(Date.now() / 1000);
  assert.ok(ttl > 590 && ttl <= 600, `link TTL ${ttl}s should be ~600s`);

  // Refresh: bare ok — dispatchAction reloads the page on ok, zero client code.
  const refreshed = await section.action!(ctx, { key: "section:reports.refresh", params: {} });
  assert.equal(refreshed.ok, true);
});

test("checkout sessions (PA-12): Links page grows tabs; session URL renders only while open; setup-mode amount is a bare status pill; status filter validated", async () => {
  const { makeLinksSection: makeLinks12 } = await import("../sections/linksSection");
  const section = makeLinks12();
  const calls: Array<Record<string, unknown>> = [];
  const ctx = {
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listPaymentLinks: async () => ({ links: [], hasMore: false }),
      listAllActivePrices: async () => [],
      listCheckoutSessions: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          sessions: [
            {
              id: "cs_open",
              status: "open",
              mode: "payment",
              amount_total: 2900,
              currency: "eur",
              customer: "cus_1",
              customer_details: null,
              created: 1_700_000_000,
              url: "https://checkout.stripe.com/c/pay/x",
            },
            {
              id: "cs_done",
              status: "complete",
              mode: "subscription",
              amount_total: 4900,
              currency: "eur",
              customer: null,
              customer_details: { email: "a@b.c" },
              created: 1_700_000_100,
              url: null,
            },
            {
              id: "cs_setup",
              status: "expired",
              mode: "setup",
              amount_total: null,
              currency: null,
              customer: null,
              customer_details: null,
              created: 1_700_000_200,
              url: null,
            },
          ],
          hasMore: false,
        };
      },
    },
  } as unknown as DashboardCtx;

  // Both views ship the tab row.
  const linksPage = await section.buildPage(ctx, { page: "links", filters: {} });
  const linkTabs = linksPage!.blocks.find((b) => b.type === "tabs") as TabsBlock;
  assert.deepEqual(linkTabs.items.map((i) => i.value), ["", "sessions"]);

  const page = await section.buildPage(ctx, { page: "links", filters: { view: "sessions" } });
  const tabs = page!.blocks.find((b) => b.type === "tabs") as TabsBlock;
  assert.equal(tabs.value, "sessions");
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.rows.length, 3);
  const urlOpen = table.rows[0].cells[4] as { t: string };
  assert.equal(urlOpen.t, "external");
  const urlDone = table.rows[1].cells[4] as { t: string; v: string };
  assert.equal(urlDone.v, "—");
  const amountSetup = table.rows[2].cells[0] as { t: string };
  assert.equal(amountSetup.t, "badge");
  const custLink = table.rows[0].cells[2] as { t: string; ref: { page: string } };
  assert.equal(custLink.t, "link");
  assert.equal(custLink.ref.page, "customers.detail");

  // Status filter flows into the Stripe param; garbage is dropped.
  await section.buildPage(ctx, { page: "links", filters: { view: "sessions", status: "open" } });
  assert.equal(calls[1].status, "open");
  await section.buildPage(ctx, { page: "links", filters: { view: "sessions", status: "evil" } });
  assert.equal(calls[2].status, undefined);
});

test("shipping rates (PA-12): 5th Catalog tab; create parses the amount idiom (zero-decimal guard); toggle validates shr_ and archives", async () => {
  const { makeCatalogSection: makeCatalog12 } = await import("../sections/catalogSection");
  const section = makeCatalog12();
  const created: Array<Record<string, unknown>> = [];
  const toggled: Array<[string, boolean]> = [];
  const ctx = {
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listShippingRates: async () => [
        {
          id: "shr_1",
          display_name: "Standard",
          active: true,
          created: 1_700_000_000,
          fixed_amount: { amount: 500, currency: "eur" },
          tax_behavior: "exclusive",
        },
      ],
      createShippingRate: async (params: Record<string, unknown>) => {
        created.push(params);
        return { id: "shr_new" };
      },
      setShippingRateActive: async (id: string, active: boolean) => {
        toggled.push([id, active]);
        return { id, active, display_name: "Standard" };
      },
    },
    audit: async () => {},
  } as unknown as DashboardCtx;

  const page = await section.buildPage(ctx, { page: "catalog", filters: { view: "shipping" } });
  const tabs = page!.blocks.find((b) => b.type === "tabs") as TabsBlock;
  assert.ok(tabs.items.some((i) => i.value === "shipping"));
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].actions![0].label, "Archive");

  const badAmount = await section.action!(ctx, { key: "section:catalog.shipping_create", params: { displayName: "X", amount: "five euro" } });
  assert.equal(badAmount.ok, false);
  const zeroDec = await section.action!(ctx, { key: "section:catalog.shipping_create", params: { displayName: "X", amount: "5.50 jpy" } });
  assert.equal(zeroDec.ok, false);
  assert.equal(created.length, 0);
  const ok = await section.action!(ctx, {
    key: "section:catalog.shipping_create",
    params: { displayName: "Standard", amount: "5.00 eur", taxBehavior: "exclusive" },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(created[0], { displayName: "Standard", amountMinor: 500, currency: "eur", taxBehavior: "exclusive" });

  const badId = await section.action!(ctx, { key: "section:catalog.shipping_toggle", params: { id: "prod_1", active: false } });
  assert.equal(badId.ok, false);
  const arch = await section.action!(ctx, { key: "section:catalog.shipping_toggle", params: { id: "shr_1", active: false } });
  assert.equal(arch.ok, true);
  assert.deepEqual(toggled, [["shr_1", false]]);
});

test("payout schedule (PA-12): T1+T2 belts run before any write; anchor/manual validation; Stripe refusal maps friendly; read-only card renders", async () => {
  const { makeBalancesSection: makeBalances12 } = await import("../sections/balancesSection");
  const section = makeBalances12();
  const updates: Array<Record<string, unknown>> = [];
  let failUpdate = false;
  const mk = (stepUpFresh: boolean) =>
    ({
      stripe: {
        formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
        getBalance: async () => ({ available: [], pending: [] }),
        listPayouts: async () => ({ payouts: [], hasMore: false }),
        listAccountBalanceTransactions: async () => ({ transactions: [], hasMore: false }),
        getAccount: async () => ({ id: "acct_1", settings: { payouts: { schedule: { interval: "daily", delay_days: 2 } } } }),
        updatePayoutSchedule: async (s: Record<string, unknown>) => {
          if (failUpdate) throw new Error("not allowed for this account");
          updates.push(s);
          return {};
        },
      },
      audit: async () => {},
      security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => stepUpFresh },
    }) as unknown as DashboardCtx;
  const ctx = mk(true);

  // List: explicit header with the T1+T2 editor + the read-only schedule card.
  const page = await section.buildPage(ctx, { page: "balances", filters: {} });
  const header = page!.blocks[0] as HeaderBlock;
  assert.equal(header.actions![0].key, "section:balances.payout_schedule");
  assert.equal(header.actions![0].dangerous, true);
  assert.equal(header.actions![0].stepUp, true);
  const kv = page!.blocks.find((b) => b.type === "kv") as KeyValueBlock;
  assert.equal(kv.title, "Payout schedule");
  assert.ok(kv.rows.some((r) => r.label === "Delay"));

  // Belts before writes.
  const noConfirm = await section.action!(ctx, { key: "section:balances.payout_schedule", params: { interval: "daily" } });
  assert.equal(noConfirm.ok, false);
  const needsStep = await section.action!(mk(false), {
    key: "section:balances.payout_schedule",
    params: { interval: "daily" },
    confirmWord: "CONFIRM",
  });
  assert.equal(needsStep.needsStepUp, true);
  assert.equal(updates.length, 0);

  // Validation matrix: weekly/monthly need anchors, manual takes no delay.
  const weeklyNoAnchor = await section.action!(ctx, { key: "section:balances.payout_schedule", params: { interval: "weekly" }, confirmWord: "CONFIRM" });
  assert.equal(weeklyNoAnchor.ok, false);
  const monthlyNoAnchor = await section.action!(ctx, { key: "section:balances.payout_schedule", params: { interval: "monthly" }, confirmWord: "CONFIRM" });
  assert.equal(monthlyNoAnchor.ok, false);
  const manualDelay = await section.action!(ctx, {
    key: "section:balances.payout_schedule",
    params: { interval: "manual", delayDays: 5 },
    confirmWord: "CONFIRM",
  });
  assert.equal(manualDelay.ok, false);
  assert.equal(updates.length, 0);
  const ok = await section.action!(ctx, {
    key: "section:balances.payout_schedule",
    params: { interval: "weekly", weeklyAnchor: "monday", delayDays: 7 },
    confirmWord: "CONFIRM",
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(updates, [{ interval: "weekly", weeklyAnchor: "monday", delayDays: 7 }]);

  // ⚠ own-account accounts.update can be Connect-only — refusal degrades.
  failUpdate = true;
  const refused = await section.action!(ctx, { key: "section:balances.payout_schedule", params: { interval: "daily" }, confirmWord: "CONFIRM" });
  assert.equal(refused.ok, false);
  assert.match(refused.error!, /Connect-only/);
});

// ---- PA-13: design polish ----

test("bell (PA-13): nav-badges collects attention items (iso-sorted newest first, capped at 15); home attention() mirrors the inbox", async () => {
  const fake = fakeSettings();
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  // A section whose attention() over-produces on purpose (cap check).
  const noisy: DashboardSectionModule = {
    nav: [{ key: "customers", label: "Customers", page: "customers" }],
    ownsPage: (p) => p === "customers",
    buildPage: async () => ({ title: "Customers", crumbs: [{ label: "Customers" }], blocks: [] }),
    navBadge: async () => "3",
    attention: async () =>
      Array.from({ length: 20 }, (_, i) => ({
        label: `item ${i}`,
        badge: { kind: "warn" as const, text: "W" },
        iso: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        ref: { page: "customers" },
      })),
  };
  const stripe = { isTestMode: () => true } as unknown as StripeClient;
  const dashboard = new Dashboard(fake.store, provider, [noisy], {
    stripe,
    settings: fake.store,
    stores: {} as never,
    billing: {} as never,
  });
  const res = await dashboard.api("nav-badges", "cookie", {});
  const json = res.json as { badges: Record<string, string>; attention?: Array<{ label: string; iso: string }> };
  assert.equal(json.badges.customers, "3");
  assert.equal(json.attention!.length, 15);
  // Newest first: item 19 leads.
  assert.equal(json.attention![0].label, "item 19");
  assert.ok(json.attention![0].iso > json.attention![14].iso);

  // Home's attention() is the SAME computation as the inbox rows.
  const homeModule = makeHomeSection({ metrics: fakeMetrics });
  const ctx = homeCtx();
  const items = await homeModule.attention!(ctx);
  const page = await homeModule.buildPage(ctx, { page: "home" });
  const inbox = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.equal(items.length, inbox.rows.length);
  const rowIds = inbox.rows.map((r) => r.id);
  assert.ok(rowIds.includes("dispute-dp_1") && rowIds.includes("approval-apr_1") && rowIds.includes("efw-issfr_1"));
  // Every bell item navigates somewhere.
  assert.ok(items.every((it) => typeof it.ref?.page === "string" && it.ref.page.length > 0));
  // Client side: bell bind + popover renderer + poll wiring exist.
  assert.ok(clientApp.includes("D.bindBell"));
  assert.ok(clientApp.includes("Nothing needs attention."));
  assert.ok(clientApp.includes("res.j.attention || []"));
});

test("peek (PA-13): endpoint allowlists pages, validates ids per kind, caches 30s; section peeks are last4-only plain text", async () => {
  const fake = fakeSettings();
  const provider: DashboardAuthProvider = {
    enter: async () => ({ kind: "page" }),
    authenticate: async () => fakeAuthResult("active"),
    publicEndpoint: async () => null,
    sessionEndpoint: async () => null,
  };
  let customerReads = 0;
  const peekSection: DashboardSectionModule = {
    nav: [{ key: "customers", label: "Customers", page: "customers" }],
    ownsPage: (p) => p === "customers" || p === "customers.detail",
    buildPage: async () => ({ title: "Customers", crumbs: [{ label: "Customers" }], blocks: [] }),
    peek: async (_ctx, _page, id) => {
      customerReads++;
      return { title: `Peek ${id}`, lines: ["ada@example.com"] };
    },
  };
  const stripe = { isTestMode: () => true } as unknown as StripeClient;
  const dashboard = new Dashboard(fake.store, provider, [peekSection], {
    stripe,
    settings: fake.store,
    stores: {} as never,
    billing: {} as never,
  });
  // Unknown page + malformed ids never reach the module.
  const badPage = await dashboard.api("peek", "cookie", { page: "security", id: "cus_1" });
  assert.equal(badPage.status, 404);
  const badId = await dashboard.api("peek", "cookie", { page: "customers.detail", id: "ch_1" });
  assert.equal(badId.status, 404);
  assert.equal(customerReads, 0);
  // Valid → module runs once; the second hit is served from the 30s cache.
  const first = await dashboard.api("peek", "cookie", { page: "customers.detail", id: "cus_1" });
  assert.equal(first.status, 200);
  assert.equal((first.json as { title: string }).title, "Peek cus_1");
  const second = await dashboard.api("peek", "cookie", { page: "customers.detail", id: "cus_1" });
  assert.equal(second.status, 200);
  assert.equal(customerReads, 1);

  // Real section peeks: one retrieve each, last4 at most, plain-text lines.
  const custSection = makeCustomersSection();
  const custPeek = await custSection.peek!(
    {
      stripe: {
        formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
        getCustomer: async () => ({
          id: "cus_1",
          name: "Ada Lovelace",
          email: "ada@example.com",
          created: 1_700_000_000,
          balance: -500,
          currency: "eur",
          delinquent: false,
        }),
      },
    } as unknown as DashboardCtx,
    "customers.detail",
    "cus_1"
  );
  assert.equal(custPeek!.title, "Ada Lovelace");
  assert.ok(custPeek!.lines.includes("ada@example.com"));
  assert.ok(custPeek!.lines.some((l) => l.includes("credit")));

  const paySection = makePaymentsSection();
  const payPeek = await paySection.peek!(
    {
      stripe: {
        formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
        getChargeDetailed: async () => ({
          id: "ch_1",
          amount: 2900,
          currency: "eur",
          status: "failed",
          refunded: false,
          disputed: false,
          created: 1_700_000_000,
          billing_details: { email: "ada@example.com" },
          payment_method_details: { card: { brand: "visa", last4: "4242", number: "4242424242424242" } },
          outcome: { seller_message: "The bank declined the payment." },
        }),
      },
    } as unknown as DashboardCtx,
    "payments.detail",
    "ch_1"
  );
  assert.equal(payPeek!.title, "29.00 EUR");
  assert.equal(payPeek!.badge!.text, "Failed");
  assert.ok(payPeek!.lines.some((l) => l.includes("···· 4242")));
  assert.ok(payPeek!.lines.every((l) => !l.includes("4242424242424242")));
  assert.ok(payPeek!.lines.length <= 5);

  // Client module: allowlist + hover-intent + textContent-only rendering.
  assert.ok(clientPeek.includes('"customers.detail": 1'));
  assert.ok(clientPeek.includes("setTimeout"));
  assert.ok(clientPeek.includes("peekline"));
  assert.ok(!clientPeek.includes("innerHTML"));
});

test("daterange (PA-13): parse matrix (presets, custom inclusive end, garbage), search upper bound, list threading, client pill", async () => {
  const { parseDateFilter: parse13 } = await import("../sections/paymentsSection");
  const now = Math.floor(Date.now() / 1000);
  // Presets → gte only.
  const preset = parse13("7d");
  assert.ok(preset.createdGte! > now - 8 * 86400 && preset.createdGte! < now - 6 * 86400);
  assert.equal(preset.createdLt, undefined);
  // Custom range: inclusive end (+86400).
  const range = parse13("2026-06-01..2026-06-30");
  assert.equal(range.createdGte, Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000));
  assert.equal(range.createdLt, Math.floor(Date.parse("2026-06-30T00:00:00Z") / 1000) + 86400);
  // Garbage / inverted ranges parse to NO bounds.
  assert.deepEqual(parse13("evil"), {});
  assert.deepEqual(parse13("2026-06-30..2026-06-01"), {});
  assert.deepEqual(parse13("2026-06-01..evil"), {});

  // End-to-end: the range reaches the charge/PI listings AND the chip search
  // queries (upper bound included).
  const section = makePaymentsSection();
  const listCalls: Array<Record<string, unknown>> = [];
  const searchQueries: string[] = [];
  const ctx = paymentsCtx();
  const stripeFake = ctx.stripe as unknown as Record<string, unknown>;
  stripeFake.listAllCharges = async (opts: Record<string, unknown>) => {
    listCalls.push(opts);
    return { charges: [], hasMore: false };
  };
  stripeFake.listAllPaymentIntents = async (opts: Record<string, unknown>) => {
    listCalls.push(opts);
    return { paymentIntents: [], hasMore: false };
  };
  stripeFake.countBySearch = async (_kind: string, q: string) => {
    searchQueries.push(q);
    return 1;
  };
  const page = await section.buildPage(ctx, { page: "payments", filters: { date: "2026-06-01..2026-06-30" } });
  const expectedGte = Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000);
  const expectedLt = Math.floor(Date.parse("2026-06-30T00:00:00Z") / 1000) + 86400;
  assert.ok(listCalls.every((c) => c.createdGte === expectedGte && c.createdLt === expectedLt));
  assert.ok(searchQueries.length > 0);
  assert.ok(searchQueries.every((q) => q.includes(`created>=${expectedGte}`) && q.includes(`created<${expectedLt}`)));
  // The filter def is a daterange pill echoing the range value.
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  const dateFilter = table.filters!.find((f) => f.key === "date")!;
  assert.equal(dateFilter.kind, "daterange");
  assert.equal(dateFilter.value, "2026-06-01..2026-06-30");

  // Client pill: preset select + Custom two-date row; label joins the range.
  assert.ok(clientBlocks.includes('f.kind === "daterange"'));
  assert.ok(clientBlocks.includes('d1.type = "date"'));
  assert.ok(clientBlocks.includes('d1.value + ".." + d2.value'));
});

test("polish (PA-13): sticky thead CSS (desktop overflow trade), g-then-key shortcuts + help dialog, mobile drawer bindings", () => {
  const { dashboardCss } = require("../html/styles") as { dashboardCss(): string };
  const css = dashboardCss();
  // Sticky headers: desktop swaps overflow-x for sticky; th background is opaque.
  assert.ok(css.includes("overflow-x:visible"));
  assert.ok(css.includes("thead th { position:sticky; top:56px"));
  // Mobile drawer + scrim.
  assert.ok(css.includes(".side.open { transform:translateX(0)"));
  assert.ok(css.includes("#scrim.show"));
  // Shortcuts: guards for modifiers/inputs/dialogs, 1.5s arm, palette untouched.
  assert.ok(clientApp.includes("D.SHORTCUT_PAGES"));
  assert.ok(clientApp.includes("e.ctrlKey || e.metaKey || e.altKey"));
  assert.ok(clientApp.includes('t.tagName === "INPUT"'));
  assert.ok(clientApp.includes("dialog[open]"));
  assert.ok(clientApp.includes("1500"));
  // Hamburger bindings: aria-expanded + close on nav/hashchange/scrim.
  assert.ok(clientApp.includes("D.bindMenu"));
  assert.ok(clientApp.includes("aria-expanded"));
});

test("bookmark everything (PA-13 user ask): every object family toggles via the shared helper; the board routes rows through refForId", async () => {
  const { BOOKMARK_ID_RES, toggleBookmarkAction, isBookmarkedSafe } = await import("../sections/bookmarks");
  // Every family has an id shape and a board route.
  const samples: Record<string, string> = {
    dispute: "dp_1", customer: "cus_1", charge: "ch_1", subscription: "sub_1", invoice: "in_1",
    payout: "po_1", link: "plink_1", quote: "qt_1", product: "prod_1",
  };
  for (const [type, id] of Object.entries(samples)) {
    assert.ok(BOOKMARK_ID_RES[type as keyof typeof BOOKMARK_ID_RES].test(id), `${type} id shape`);
    assert.ok(refForId(id), `${type} id must route to a page on the board`);
  }
  // Toggle validates the id per type; a mismatched id never reaches the store.
  const toggles: Array<[string, string, string | null]> = [];
  const ctx = {
    actor: { id: "42", name: "Ada" },
    stores: {
      qol: {
        toggleBookmark: async (type: string, id: string, label: string | null) => {
          toggles.push([type, id, label]);
          return { bookmarked: true };
        },
        isBookmarked: async () => true,
      },
    },
  } as unknown as DashboardCtx;
  const bad = await toggleBookmarkAction(ctx, "subscription", { id: "cus_1" });
  assert.equal(bad.ok, false);
  assert.equal(toggles.length, 0);
  const ok = await toggleBookmarkAction(ctx, "subscription", { id: "sub_1", label: "Ada on Pro" });
  assert.equal(ok.ok, true);
  assert.deepEqual(toggles, [["subscription", "sub_1", "Ada on Pro"]]);
  // The safe read never throws, even without a qol store in the fixture.
  assert.equal(await isBookmarkedSafe({ stores: {} } as unknown as DashboardCtx, "quote", "qt_1"), false);
  assert.equal(await isBookmarkedSafe(ctx, "quote", "qt_1"), true);
});

// ---- PA-13 filter expansion (user ask): fingerprint reverse search + Stripe filter parity ----

test("payments filters (PA-13): fingerprint/email flip the rows into a whole-account search sweep; decline reason + invoice slice the window", async () => {
  const section = makePaymentsSection();
  const searches: string[] = [];
  const countQs: string[] = [];
  const ctx = paymentsCtx();
  const stripe = ctx.stripe as unknown as Record<string, unknown>;
  const hit = {
    id: "ch_hit",
    status: "succeeded",
    captured: true,
    refunded: false,
    disputed: false,
    amount: 2900,
    amount_refunded: 0,
    currency: "eur",
    created: 1_600_000_000,
    customer: "cus_other",
    billing_details: { email: "other@x.com" },
    payment_method_details: { type: "card", card: { brand: "visa", last4: "4242", fingerprint: "Xt5EWLLDS7FJjR1c" } },
  };
  stripe.searchChargesForList = async (query: string) => {
    searches.push(query);
    return { charges: [hit], totalCount: 1 };
  };
  stripe.countBySearch = async (_k: string, q: string) => {
    countQs.push(q);
    return 1;
  };

  // Fingerprint = the reverse-card sweep: rows come from Stripe Search (whole
  // account), no cursor, and the chip-count queries carry the same scope.
  const page = await section.buildPage(ctx, { page: "payments", filters: { fingerprint: "Xt5EWLLDS7FJjR1c" } });
  const table = page!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "payments") as TableBlock;
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].id, "ch_hit");
  assert.equal(table.nextCursor, null);
  assert.ok(searches[0].includes('payment_method_details.card.fingerprint:"Xt5EWLLDS7FJjR1c"'));
  assert.ok(countQs.some((q) => q.includes('payment_method_details.card.fingerprint:"Xt5EWLLDS7FJjR1c"')));
  assert.match(table.notice!, /WHOLE account/);

  // Garbage fingerprints are dropped server-side — normal window mode.
  searches.length = 0;
  await section.buildPage(ctx, { page: "payments", filters: { fingerprint: "!!nope!!" } });
  assert.equal(searches.length, 0);

  // Email mode: billing_details.email is NOT a supported charges.search
  // field (prod-confirmed) — the sweep goes customers-first and merges their
  // charge histories; chip search is skipped entirely (windowed chips).
  const emailLookups: string[] = [];
  const chargeLists: string[] = [];
  stripe.searchCustomersByEmail = async (email: string) => {
    emailLookups.push(email);
    return [{ id: "cus_l1" }, { id: "cus_l2" }];
  };
  stripe.listCharges = async (cus: string) => {
    chargeLists.push(cus);
    return { charges: [{ ...hit, id: `ch_${cus}`, customer: cus, created: cus === "cus_l2" ? 1_700_000_500 : 1_600_000_000 }], hasMore: false };
  };
  countQs.length = 0;
  const emailPage = await section.buildPage(ctx, { page: "payments", filters: { email: 'Other@X.com"\\' } });
  assert.deepEqual(emailLookups, ["other@x.com"]);
  assert.deepEqual(chargeLists.sort(), ["cus_l1", "cus_l2"]);
  assert.equal(countQs.length, 0); // email can't scope chip searches — honest windowed chips
  const emailTable = emailPage!.blocks.find((b) => b.type === "table") as TableBlock;
  // Merged newest-first across both matched customers.
  assert.deepEqual(emailTable.rows.map((r) => r.id), ["ch_cus_l2", "ch_cus_l1"]);
  assert.equal(emailTable.nextCursor, null);
  assert.match(emailTable.notice!, /matched 2 customers/);

  // Window slicers: decline reason (outcome/failure_code contains) + invoice.
  stripe.listAllCharges = async () => ({
    charges: [
      { ...hit, id: "ch_d1", status: "failed", outcome: { reason: "insufficient_funds" }, failure_code: "card_declined" },
      { ...hit, id: "ch_d2", invoice: "in_77" },
    ],
    hasMore: false,
  });
  const declined = await section.buildPage(ctx, { page: "payments", filters: { declineReason: "insufficient" } });
  const declinedTable = declined!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.deepEqual(declinedTable.rows.map((r) => r.id), ["ch_d1"]);
  const byInvoice = await section.buildPage(ctx, { page: "payments", filters: { invoice: "in_77" } });
  const invoiceTable = byInvoice!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.deepEqual(invoiceTable.rows.map((r) => r.id), ["ch_d2"]);
});

test("PM fingerprint (PA-13): the 360 payment-methods table exposes the fingerprint and links into the reverse-card hunt", async () => {
  const ctx = fakeCustomerCtx();
  (ctx.stripe as unknown as Record<string, unknown>).listAllPaymentMethods = async () => [
    { id: "pm_1", type: "card", card: { brand: "visa", last4: "4242", exp_month: 7, exp_year: 2027, fingerprint: "Xt5EWLLDS7FJjR1c" } },
    { id: "pm_2", type: "link", link: { email: "ada@example.com" } },
    { id: "pm_3", type: "sepa_debit", sepa_debit: { last4: "3000", fingerprint: "SepaFp123" } },
  ];
  const page = await makeCustomersSection().buildPage(ctx, { page: "customers.detail", params: { id: "cus_test1" } });
  const pms = page!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "pms") as TableBlock;
  assert.equal(pms.columns.some((c) => c.label === "Identity"), true);
  const fpCell = pms.rows[0].cells[3] as { t: string; v: string; ref?: { page: string; filters?: Record<string, string> } };
  assert.equal(fpCell.v, "Xt5EWLLDS7FJjR1c");
  assert.deepEqual(fpCell.ref, { page: "fraud", filters: { view: "card", fp: "Xt5EWLLDS7FJjR1c" } });
  // Wallet PMs (Link/PayPal…) have no fingerprint — the wallet ACCOUNT EMAIL
  // is the cross-customer identity, linking into the Payments email sweep.
  const walletCell = pms.rows[1].cells[3] as { t: string; v: string; ref?: { page: string; filters?: Record<string, string> } };
  assert.equal(walletCell.t, "link");
  assert.equal(walletCell.v, "ada@example.com");
  assert.deepEqual(walletCell.ref, { page: "payments", filters: { email: "ada@example.com" } });
  // Bank-debit rails DO expose fingerprints — copyable, but no card hunt link
  // (charges.search only indexes card fingerprints).
  const sepaCell = pms.rows[2].cells[3] as { t: string; v: string; ref?: unknown; copy?: boolean };
  assert.equal(sepaCell.v, "SepaFp123");
  assert.equal(sepaCell.ref, undefined);
});

test("customers list filters (PA-13): created is a server param; delinquent/country/has-subscription slice the page", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const ctx = {
    stripe: {
      listCustomersPage: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          customers: [
            { id: "cus_1", name: "Ada", email: "a@x.com", delinquent: false, created: 1_700_000_000, address: { country: "DE" }, subscriptions: { data: [{ id: "sub_1" }] } },
            { id: "cus_2", name: "Bob", email: "b@x.com", delinquent: true, created: 1_700_000_100, address: { country: "US" }, subscriptions: { data: [] } },
          ],
          hasMore: false,
        };
      },
      searchCustomersByTerm: async () => [],
    },
  } as unknown as DashboardCtx;
  const section = makeCustomersSection();
  const page = await section.buildPage(ctx, { page: "customers", filters: { created: "2026-06-01..2026-06-30", delinquent: "yes" } });
  assert.equal(calls[0].createdGte, Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000));
  assert.equal(calls[0].createdLt, Math.floor(Date.parse("2026-06-30T00:00:00Z") / 1000) + 86400);
  const table = page!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.deepEqual(table.rows.map((r) => r.id), ["cus_2"]);
  const hasSub = await section.buildPage(ctx, { page: "customers", filters: { hassub: "yes" } });
  assert.deepEqual((hasSub!.blocks.find((b) => b.type === "table") as TableBlock).rows.map((r) => r.id), ["cus_1"]);
  const byCountry = await section.buildPage(ctx, { page: "customers", filters: { country: "us" } });
  assert.deepEqual((byCountry!.blocks.find((b) => b.type === "table") as TableBlock).rows.map((r) => r.id), ["cus_2"]);
});

test("invoices + subscriptions filters (PA-13): server params thread through; non-searchable filters force honest windowed chips", async () => {
  // Invoices: collection/subscription/created are SERVER list params;
  // frequency slices; chips skip search when non-searchable filters are set.
  const invOpts: Array<Record<string, unknown>> = [];
  let invSearches = 0;
  const invCtx = {
    stripe: {
      formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
      listInvoicesByStatus: async (...args: unknown[]) => {
        invOpts.push(args[4] as Record<string, unknown>);
        return {
          data: [
            { id: "in_r", status: "paid", total: 2900, currency: "eur", created: 1_700_000_000, customer: "cus_1", customer_email: "a@x.com", due_date: null, parent: { subscription_details: { subscription: "sub_1" } } },
            { id: "in_o", status: "open", total: 500, currency: "eur", created: 1_700_000_100, customer: "cus_1", customer_email: "a@x.com", due_date: null, parent: null },
          ],
          has_more: false,
        };
      },
      countBySearch: async () => {
        invSearches++;
        return 5;
      },
    },
  } as unknown as DashboardCtx;
  const invSection = makeInvoicesSection();
  const recurring = await invSection.buildPage(invCtx, {
    page: "invoices",
    filters: { frequency: "recurring", collection: "send_invoice", subscription: "sub_1", created: "2026-06-01..2026-06-30" },
  });
  assert.equal(invSearches, 0); // non-searchable filters → windowed chips
  assert.equal(invOpts[0].collectionMethod, "send_invoice");
  assert.equal(invOpts[0].subscriptionId, "sub_1");
  assert.equal(invOpts[0].createdGte, Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000));
  const invTable = recurring!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.deepEqual(invTable.rows.map((r) => r.id), ["in_r"]);
  assert.match(invTable.notice!, /window only/);

  // Subscriptions: created threads into the listing AND the chip searches;
  // collection method slices the window and turns chips windowed.
  const subCalls: Array<Record<string, unknown>> = [];
  const subQs: string[] = [];
  const subCtx2 = subsCtx();
  const subStripe = subCtx2.stripe as unknown as Record<string, unknown>;
  const subRow = (id: string, collection: string) => ({
    id,
    status: "active",
    collection_method: collection,
    pause_collection: null,
    cancel_at_period_end: false,
    customer: "cus_1",
    created: 1_700_000_000,
    items: { data: [{ quantity: 1, current_period_end: 1_700_900_000, price: { id: "price_1", nickname: "Pro", currency: "eur", unit_amount: 2900, recurring: { interval: "month", interval_count: 1 } } }] },
  });
  subStripe.listAllSubscriptions = async (opts: Record<string, unknown>) => {
    subCalls.push(opts);
    return { subscriptions: [subRow("sub_auto", "charge_automatically"), subRow("sub_manual", "send_invoice")], hasMore: false };
  };
  subStripe.countBySearch = async (_k: string, q: string) => {
    subQs.push(q);
    return 9;
  };
  const subSection = makeSubscriptionsSection();
  await subSection.buildPage(subCtx2, { page: "subscriptions", filters: { created: "7d" } });
  assert.ok(subCalls[0].createdGte != null);
  assert.ok(subQs.length > 0 && subQs.every((q) => q.includes("created>=")));
  subQs.length = 0;
  const manualOnly = await subSection.buildPage(subCtx2, { page: "subscriptions", filters: { collection: "send_invoice" } });
  assert.equal(subQs.length, 0); // collection isn't searchable → windowed chips
  const subTable = manualOnly!.blocks.find((b) => b.type === "table") as TableBlock;
  assert.deepEqual(subTable.rows.map((r) => r.id), ["sub_manual"]);
});

test("search sweep resilience (PA-13.F): a refused charges.search renders an empty table + honest notice, never a 500", async () => {
  const section = makePaymentsSection();
  const ctx = paymentsCtx();
  const stripe = ctx.stripe as unknown as Record<string, unknown>;
  stripe.searchChargesForList = async () => {
    throw new Error("expand[0] cannot be data.refunds on search");
  };
  stripe.countBySearch = async () => 0;
  const page = await section.buildPage(ctx, { page: "payments", filters: { fingerprint: "Xt5EWLLDS7FJjR1c" } });
  const table = page!.blocks.find((b) => b.type === "table" && (b as TableBlock).key === "payments") as TableBlock;
  assert.equal(table.rows.length, 0);
  assert.match(table.notice!, /Search failed/);
  // Stripe's exact refusal reaches the operator (deploys have no log access).
  assert.match(table.notice!, /expand\[0\] cannot be data\.refunds on search/);
  assert.match(table.empty!, /refused this sweep/);
});
