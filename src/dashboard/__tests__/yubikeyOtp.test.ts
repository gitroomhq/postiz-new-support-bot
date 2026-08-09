import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseYubiOtp, verifyYubiOtp, YUBICO_DEFAULT_VERIFY_URL, YubiFetch } from "../auth/yubikeyOtp";
import { StandingDashboardAuth } from "../DashboardAuth";
import type { SettingsStore } from "../../config/SettingsStore";
import type { DashboardTokens } from "../DashboardTokens";
import type { DashboardDbSessions } from "../auth/DashboardDbSessions";
import type { CredentialStore } from "../auth/CredentialStore";
import type { DashboardAudit } from "../auth/DashboardAudit";

// ---- parsing ----

const PUBLIC_ID = "ccccccbchvth";
const CIPHER = "livuitriujjifivbvtrjkjfirllluurj"; // 32 modhex chars
const OTP = PUBLIC_ID + CIPHER;

test("parseYubiOtp: accepts a 44-char modhex OTP and extracts the public id", () => {
  const parsed = parseYubiOtp(OTP);
  assert.ok(parsed);
  assert.equal(parsed.publicId, PUBLIC_ID);
  assert.equal(parsed.otp, OTP);
});

test("parseYubiOtp: normalizes case and surrounding whitespace", () => {
  const parsed = parseYubiOtp(`  ${OTP.toUpperCase()}  `);
  assert.ok(parsed);
  assert.equal(parsed.otp, OTP);
});

test("parseYubiOtp: rejects non-modhex, too-short and too-long inputs", () => {
  assert.equal(parseYubiOtp("a".repeat(44)), null); // 'a' is not modhex
  assert.equal(parseYubiOtp(CIPHER), null); // 32 chars = no public id
  assert.equal(parseYubiOtp("c".repeat(49)), null);
  assert.equal(parseYubiOtp(""), null);
  assert.equal(parseYubiOtp("123456"), null);
});

test("parseYubiOtp: supports short (non-12-char) public ids", () => {
  const parsed = parseYubiOtp("cb" + CIPHER);
  assert.ok(parsed);
  assert.equal(parsed.publicId, "cb");
});

// ---- remote verification (fake transport) ----

const SECRET_B64 = Buffer.from("test-secret-key!").toString("base64");

function sign(fields: Record<string, string>, secretB64: string): string {
  const message = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("&");
  return createHmac("sha1", Buffer.from(secretB64, "base64")).update(message).digest("base64");
}

// Builds a fake fetch that answers like a validation server. `mutate` can
// tamper with the response fields before (optional) signing.
function fakeServer(opts: {
  status: string;
  sign?: boolean;
  mutate?: (fields: Record<string, string>) => void;
  capture?: (url: URL) => void;
}): YubiFetch {
  return async (raw) => {
    const url = new URL(raw);
    opts.capture?.(url);
    const fields: Record<string, string> = {
      otp: url.searchParams.get("otp") ?? "",
      nonce: url.searchParams.get("nonce") ?? "",
      status: opts.status,
      t: "2026-08-09T00:00:00Z0000",
    };
    opts.mutate?.(fields);
    if (opts.sign) fields.h = sign(fields, SECRET_B64);
    const body = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .join("\r\n");
    return new Response(body, { status: 200 });
  };
}

const CONFIG = { clientId: "12345", apiSecret: null, verifyUrl: null };
const SIGNED_CONFIG = { clientId: "12345", apiSecret: SECRET_B64, verifyUrl: null };

test("verifyYubiOtp: OK response with matching echo verifies", async () => {
  const seen: URL[] = [];
  const result = await verifyYubiOtp(OTP, CONFIG, fakeServer({ status: "OK", capture: (u) => seen.push(u) }));
  assert.deepEqual(result, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].origin + seen[0].pathname, YUBICO_DEFAULT_VERIFY_URL);
  assert.equal(seen[0].searchParams.get("id"), "12345");
  assert.equal(seen[0].searchParams.get("otp"), OTP);
  assert.ok((seen[0].searchParams.get("nonce") ?? "").length >= 16);
});

test("verifyYubiOtp: signs the request and accepts a correctly signed response", async () => {
  const seen: URL[] = [];
  const result = await verifyYubiOtp(
    OTP,
    SIGNED_CONFIG,
    fakeServer({ status: "OK", sign: true, capture: (u) => seen.push(u) })
  );
  assert.deepEqual(result, { ok: true });
  const params = Object.fromEntries(seen[0].searchParams.entries());
  const h = params.h;
  assert.ok(h);
  delete params.h;
  assert.equal(h, sign(params, SECRET_B64));
});

test("verifyYubiOtp: rejects a response with a wrong signature", async () => {
  const result = await verifyYubiOtp(
    OTP,
    SIGNED_CONFIG,
    fakeServer({ status: "OK", sign: false, mutate: (f) => (f.h = "AAAA") })
  );
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("verifyYubiOtp: rejects a response missing the signature when a secret is set", async () => {
  const result = await verifyYubiOtp(OTP, SIGNED_CONFIG, fakeServer({ status: "OK" }));
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("verifyYubiOtp: rejects a spliced response (otp echo mismatch)", async () => {
  const result = await verifyYubiOtp(
    OTP,
    CONFIG,
    fakeServer({ status: "OK", mutate: (f) => (f.otp = "cb" + CIPHER) })
  );
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("verifyYubiOtp: rejects a replayed nonce (nonce echo mismatch)", async () => {
  const result = await verifyYubiOtp(
    OTP,
    CONFIG,
    fakeServer({ status: "OK", mutate: (f) => (f.nonce = "0".repeat(32)) })
  );
  assert.deepEqual(result, { ok: false, reason: "bad_signature" });
});

test("verifyYubiOtp: maps validation statuses", async () => {
  assert.deepEqual(await verifyYubiOtp(OTP, CONFIG, fakeServer({ status: "REPLAYED_OTP" })), {
    ok: false,
    reason: "replayed_otp",
  });
  assert.deepEqual(await verifyYubiOtp(OTP, CONFIG, fakeServer({ status: "BAD_OTP" })), {
    ok: false,
    reason: "bad_otp",
  });
  assert.deepEqual(await verifyYubiOtp(OTP, CONFIG, fakeServer({ status: "BACKEND_ERROR" })), {
    ok: false,
    reason: "backend_error",
  });
});

test("verifyYubiOtp: fails closed on transport errors and non-200s", async () => {
  const throwing: YubiFetch = async () => {
    throw new Error("boom");
  };
  assert.deepEqual(await verifyYubiOtp(OTP, CONFIG, throwing), { ok: false, reason: "unreachable" });
  const http500: YubiFetch = async () => new Response("nope", { status: 500 });
  assert.deepEqual(await verifyYubiOtp(OTP, CONFIG, http500), { ok: false, reason: "backend_error" });
});

test("verifyYubiOtp: refuses to run without a client id", async () => {
  const result = await verifyYubiOtp(OTP, { clientId: "", apiSecret: null, verifyUrl: null }, fakeServer({ status: "OK" }));
  assert.deepEqual(result, { ok: false, reason: "not_configured" });
});

test("verifyYubiOtp: honors a custom validation server URL", async () => {
  const seen: URL[] = [];
  const result = await verifyYubiOtp(
    OTP,
    { clientId: "9", apiSecret: null, verifyUrl: "https://val.example.com/wsapi/2.0/verify" },
    fakeServer({ status: "OK", capture: (u) => seen.push(u) })
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(seen[0].hostname, "val.example.com");
});

// ---- auth-yubikey-login endpoint (real StandingDashboardAuth, fake deps) ----

function authFixture(opts: { serverStatus?: string; enrolledFor?: string | null; clientId?: string | null } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const notifications: Array<{ userId: string; info: { method: string; pending: boolean } }> = [];
  const fetchCalls: string[] = [];
  const settings = {
    dashboardEpoch: () => 3,
    dashboardAdmins: () => [{ id: "42", name: "Ada", role: "admin" }],
    dashboardAdminRole: (id: string) => (id === "42" ? "admin" : null),
    resolvedPublicBaseUrl: () => "https://bot.example.com",
    yubicoClientId: () => (opts.clientId === undefined ? "777" : opts.clientId),
    yubicoApiSecret: () => null,
    yubicoValidationUrl: () => null,
  } as unknown as SettingsStore;
  const sessions = {
    create: async (input: Record<string, unknown>) => {
      created.push(input);
      return { token: "tok-raw", activationCode: null };
    },
  } as unknown as DashboardDbSessions;
  const enrolledFor = opts.enrolledFor === undefined ? "42" : opts.enrolledFor;
  const credentials = {
    findYubikeyByPublicId: async (publicId: string) =>
      enrolledFor && publicId === PUBLIC_ID
        ? { id: "cred-1", discordUserId: enrolledFor, kind: "yubikey", credentialId: PUBLIC_ID, revokedAt: null }
        : null,
    recordYubikeyUse: async () => {},
  } as unknown as CredentialStore;
  const audit = { record: async () => {} } as unknown as DashboardAudit;
  const yubiFetch: YubiFetch = (url, o) => {
    fetchCalls.push(url);
    return fakeServer({ status: opts.serverStatus ?? "OK" })(url, o);
  };
  const auth = new StandingDashboardAuth(settings, {} as unknown as DashboardTokens, sessions, credentials, audit, yubiFetch);
  auth.bindNotifier({
    notifyLogin: async (userId, info) => void notifications.push({ userId, info }),
    notifyLockout: async () => {},
  });
  return { auth, created, notifications, fetchCalls };
}

test("auth-yubikey-login: enrolled key + OK verify → ACTIVE session, cookie, notify-only DM", async () => {
  const fx = authFixture();
  const res = await fx.auth.publicEndpoint("auth-yubikey-login", { otp: OTP }, { ip: "9.9.9.9", ua: "UA" });
  assert.ok(res);
  assert.deepEqual(res.json, { ok: true, state: "active" });
  assert.ok(res.setCookie?.startsWith("__Host-billing=tok-raw;"));
  assert.equal(fx.created.length, 1);
  assert.equal(fx.created[0].state, "active");
  assert.equal(fx.created[0].authMethod, "yubikey");
  assert.equal(fx.created[0].discordUserId, "42");
  assert.equal(fx.notifications.length, 1);
  assert.equal(fx.notifications[0].info.pending, false);
  assert.equal(fx.notifications[0].info.method, "yubikey");
});

test("auth-yubikey-login: unknown key fails generically WITHOUT a validation call", async () => {
  const fx = authFixture({ enrolledFor: null });
  const res = await fx.auth.publicEndpoint("auth-yubikey-login", { otp: OTP }, {});
  assert.deepEqual(res!.json, { ok: false, error: "Sign-in failed. Try again." });
  assert.equal(fx.fetchCalls.length, 0);
  assert.equal(fx.created.length, 0);
});

test("auth-yubikey-login: failed remote verification creates no session", async () => {
  const fx = authFixture({ serverStatus: "BAD_OTP" });
  const res = await fx.auth.publicEndpoint("auth-yubikey-login", { otp: OTP }, {});
  assert.deepEqual(res!.json, { ok: false, error: "Sign-in failed. Try again." });
  assert.equal(fx.created.length, 0);
  assert.equal(fx.notifications.length, 0);
});

test("auth-yubikey-login: dark when no client id is configured", async () => {
  const fx = authFixture({ clientId: null });
  const res = await fx.auth.publicEndpoint("auth-yubikey-login", { otp: OTP }, {});
  assert.deepEqual(res!.json, { ok: false, error: "Sign-in failed. Try again." });
  assert.equal(fx.fetchCalls.length, 0);
});

test("auth-yubikey-login: malformed OTP fails generically", async () => {
  const fx = authFixture();
  const res = await fx.auth.publicEndpoint("auth-yubikey-login", { otp: "not-an-otp" }, {});
  assert.deepEqual(res!.json, { ok: false, error: "Sign-in failed. Try again." });
  assert.equal(fx.fetchCalls.length, 0);
});
