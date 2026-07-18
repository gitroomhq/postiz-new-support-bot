import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type Stripe from "stripe";
import { DashboardTokens } from "../DashboardTokens";
import { DashboardAuthProvider, DashboardAuthResult } from "../DashboardAuth";
import { Dashboard } from "../Dashboard";
import { DashboardActionGateway } from "../DashboardActions";
import { DashboardCtx, DashboardSectionModule } from "../sections/types";
import { chargeBadge, estimateMrr, formatPerCurrency, sentence } from "../sections/cells";
import { makeCustomersSection } from "../sections/customersSection";
import { makePaymentsSection, buildGuardrailPanel } from "../sections/paymentsSection";
import { makeSecuritySection } from "../sections/securitySection";
import { BillingActionService } from "../../bot/billing/actions/BillingActionService";
import type { ApprovalStore, BillingApproval } from "../../bot/billing/ApprovalStore";
import type { SessionStore } from "../../auth/SessionStore";
import type { SettingsStore as SettingsStoreType } from "../../config/SettingsStore";
import type { BlockStore } from "../../bot/billing/BlockStore";
import type { CredentialStore } from "../auth/CredentialStore";
import type { DashboardDbSessions } from "../auth/DashboardDbSessions";
import type { DashboardAudit } from "../auth/DashboardAudit";
import { HeaderBlock, KeyValueBlock, TableBlock } from "../renderer/contract";
import { renderDashboardShell } from "../html/shellHtml";
import { clientCore } from "../html/clientCore";
import { clientBlocks } from "../html/clientBlocks";
import { clientModal } from "../html/clientModal";
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
    billing: {} as never,
    audit: async () => {},
    security: { sessionIdHash: "h", authMethod: "passkey", stepUpFresh: () => false },
  } as unknown as DashboardCtx;
}

test("customer 360: Insights/Details/Linked accounts in the rail, atoms in the main tables", async () => {
  const section = makeCustomersSection();
  const page = await section.buildPage(fakeCustomerCtx(), { page: "customers.detail", params: { id: "cus_test1" } });
  assert.ok(page);
  assert.ok(page!.rail && page!.rail.length === 3, "expected a 3-card rail");
  const [insights, details, linked] = page!.rail as KeyValueBlock[];
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
  // Main tables use the atoms: payments amount cell carries the status pill.
  const payments = page!.blocks.find((b) => b.type === "table" && b.key === "charges") as TableBlock;
  assert.deepEqual(payments.rows[0].cells[0], {
    t: "amount",
    v: "29.00 EUR",
    cur: "EUR",
    badge: { kind: "warn", text: "Partial refund" },
  });
  assert.equal(payments.footer, "1 result");
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
  const table = page!.blocks[0] as TableBlock;
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
    getPaymentIntent: async (id: string) => ({ id, customer: "cus_pi" }),
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
  assert.equal(counts.Refunded, 1);
  assert.equal(counts.Failed, 1);
  assert.equal(counts.Incomplete, 1);
  // ch_1/ch_2 belong to the blocked customer; ch_2 also has an EFW.
  const row2 = table.rows.find((r) => r.id === "ch_2")!;
  const flags = row2.cells[5] as { t: "flags"; badges: Array<{ text: string }> };
  assert.deepEqual(flags.badges.map((b) => b.text).sort(), ["BLOCKED", "EFW"]);
  // Amount cell carries the status pill.
  assert.equal((row2.cells[0] as { badge?: { text: string } }).badge?.text, "Partial refund");
  // Refunded filter narrows within the window.
  const refunded = await section.buildPage(paymentsCtx(), { page: "payments", filters: { status: "refunded" } });
  assert.equal((refunded!.blocks.find((b) => b.type === "table") as TableBlock).rows.length, 1);
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

test("client JS modules parse and the shell embeds them nonced", () => {
  const combined = `${clientCore}\n${clientBlocks}\n${clientModal}\n${clientLogin}\nD.defaultPage="customers";\n${clientApp}`;
  assert.doesNotThrow(() => new Function(combined));

  const html = renderDashboardShell({ nonce: "test-nonce-123" });
  assert.ok(html.includes('<style nonce="test-nonce-123">'));
  assert.ok(html.includes('<script nonce="test-nonce-123">'));
  assert.ok(html.includes('id="lock"'));
  assert.ok(html.includes('id="login"'));
  assert.ok(html.includes('id="stepup"'));
  assert.ok(html.includes('id="modal"'));
  // No unresolved template interpolations leaked into the page.
  assert.ok(!html.includes("${"));
});
