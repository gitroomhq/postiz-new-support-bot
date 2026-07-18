import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DashboardTokens } from "../DashboardTokens";
import { DashboardAuthProvider, DashboardAuthResult } from "../DashboardAuth";
import { Dashboard } from "../Dashboard";
import { DashboardSectionModule } from "../sections/types";
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
      if (token === "mint") return { kind: "page", sessionCookie: "__Host-dash=abc; Path=/" };
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
  assert.ok("html" in minted && minted.sessionCookie?.startsWith("__Host-dash="));
  const login = await dashboard.page("", "");
  assert.ok("html" in login && login.sessionCookie === undefined);
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
