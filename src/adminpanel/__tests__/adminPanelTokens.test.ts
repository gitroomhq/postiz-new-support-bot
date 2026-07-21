import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminPanelTokens } from "../AdminPanelTokens";
import { AdminPanelSessions } from "../AdminPanelSessions";
import type { SettingsStore } from "../../config/SettingsStore";

// Fake SettingsStore covering exactly the surface AdminPanelTokens touches.
// NOTE the admin panel keys off adminPanelEpoch (separate revocation lever from
// the Stripe panel's panelTokenEpoch), but reuses panelTokenSecret as HMAC key.
function fakeSettings(overrides: { epoch?: number; baseUrl?: string | null } = {}) {
  let epoch = overrides.epoch ?? 0;
  const secret = "test-secret-0123456789abcdef";
  return {
    store: {
      ensurePanelTokenSecret: async () => secret,
      panelTokenSecret: () => secret,
      adminPanelEpoch: () => epoch,
      resolvedPublicBaseUrl: () => (overrides.baseUrl === undefined ? "https://bot.example.com" : overrides.baseUrl),
    } as unknown as SettingsStore,
    bumpEpoch: () => {
      epoch += 1;
    },
  };
}

const MINT_INPUT = { userId: "42", guildId: "g1", adminName: "Agent Ada", panel: "config" as const };

test("mint → verify round-trip carries user, guild, name, panel, adm, jti, epoch", async () => {
  const { store } = fakeSettings();
  const tokens = new AdminPanelTokens(store);
  const token = await tokens.mint(MINT_INPUT);
  const p = tokens.verify(token);
  assert.ok(p);
  assert.equal(p!.sub, "42");
  assert.equal(p!.gid, "g1");
  assert.equal(p!.an, "Agent Ada");
  assert.equal(p!.panel, "config");
  assert.equal(p!.adm, true);
  assert.equal(p!.epo, 0);
  assert.ok(p!.jti.length >= 16);
  assert.ok(p!.exp > Date.now());
});

test("admin tokens are version-bound (a1): a v1-tagged token is rejected", async () => {
  const { store } = fakeSettings();
  const tokens = new AdminPanelTokens(store);
  const token = await tokens.mint(MINT_INPUT);
  const [, body, mac] = token.split(".");
  // Same body/MAC but the Stripe panel's version tag → rejected (version is MAC'd).
  assert.equal(tokens.verify(`v1.${body}.${mac}`), null);
});

test("tampering with any segment invalidates the token", async () => {
  const { store } = fakeSettings();
  const tokens = new AdminPanelTokens(store);
  const token = await tokens.mint(MINT_INPUT);
  const [version, body, mac] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  payload.sub = "99";
  const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.equal(tokens.verify(`${version}.${forgedBody}.${mac}`), null);
  const flipped = mac.slice(0, -1) + (mac.endsWith("0") ? "1" : "0");
  assert.equal(tokens.verify(`${version}.${body}.${flipped}`), null);
  assert.equal(tokens.verify(""), null);
  assert.equal(tokens.verify("a1.only-two"), null);
});

test("expired tokens are rejected", async () => {
  const { store } = fakeSettings();
  const tokens = new AdminPanelTokens(store);
  const token = await tokens.mint(MINT_INPUT);
  const [version, body] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  payload.exp = Date.now() - 1000;
  const { createHmac } = await import("node:crypto");
  const newBody = `${version}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const mac = createHmac("sha256", "test-secret-0123456789abcdef").update(newBody).digest("hex");
  assert.equal(tokens.verify(`${newBody}.${mac}`), null);
});

test("adminPanelEpoch bump (Revoke Admin Panel Links) invalidates outstanding tokens", async () => {
  const fake = fakeSettings();
  const tokens = new AdminPanelTokens(fake.store);
  const token = await tokens.mint(MINT_INPUT);
  assert.ok(tokens.verify(token));
  fake.bumpEpoch();
  assert.equal(tokens.verify(token), null);
});

test("minting refuses a non-https public base URL (localhost allowed)", async () => {
  const insecure = new AdminPanelTokens(fakeSettings({ baseUrl: "http://bot.example.com" }).store);
  await assert.rejects(() => insecure.mint(MINT_INPUT), /https/);
  const local = new AdminPanelTokens(fakeSettings({ baseUrl: "http://localhost:3000" }).store);
  assert.ok(await local.mint(MINT_INPUT));
});

// ---- passcode state machine ----

const CREATE_INPUT = { discordUserId: "u1", guildId: "g1", adminName: "Ada", panel: "config" as const, epoch: 0 };

test("jti is single-use", () => {
  const s = new AdminPanelSessions();
  assert.equal(s.consumeJti("abc"), true);
  assert.equal(s.consumeJti("abc"), false);
});

test("create yields a LOCKED session + activation code; get honors epoch", () => {
  const s = new AdminPanelSessions();
  const { sessionId, activationCode } = s.create(CREATE_INPUT);
  assert.match(activationCode, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const got = s.get(sessionId, 0);
  assert.ok(got);
  assert.equal(got!.state, "locked");
  assert.equal(s.get("nope", 0), null);
  assert.equal(s.get(sessionId, 1), null); // epoch mismatch kills it
});

test("activation: wrong code fails, matching code flips locked → active", () => {
  const s = new AdminPanelSessions();
  const { sessionId, activationCode } = s.create(CREATE_INPUT);
  assert.deepEqual(s.activate("u1", "WRNG-CODE", 0), { ok: false, reason: "notfound" });
  assert.deepEqual(s.activate("u1", activationCode, 0), { ok: true });
  assert.equal(s.get(sessionId, 0)!.state, "active");
});

test("activation lockout after 5 wrong codes destroys the session", () => {
  const s = new AdminPanelSessions();
  const { sessionId } = s.create(CREATE_INPUT);
  for (let i = 0; i < 4; i++) assert.deepEqual(s.activate("u1", `NOPE-000${i}`, 0), { ok: false, reason: "notfound" });
  assert.deepEqual(s.activate("u1", "NOPE-0009", 0), { ok: false, reason: "locked_out" });
  assert.equal(s.get(sessionId, 0), null);
});

test("reverse challenge is 6 digits and single-use", () => {
  const s = new AdminPanelSessions();
  const { activationCode } = s.create(CREATE_INPUT);
  s.activate("u1", activationCode, 0);
  const active = s.activeForUser("u1", 0);
  assert.ok(active);
  const code = s.issueDestructiveChallenge(active!.session);
  assert.match(code, /^\d{6}$/);
  assert.equal(s.consumeDestructiveChallenge(active!.session, code), true);
  assert.equal(s.consumeDestructiveChallenge(active!.session, code), false); // consumed
  assert.equal(s.consumeDestructiveChallenge(active!.session, "000000"), false);
});

test("activeForUser only returns an ACTIVE session for that user", () => {
  const s = new AdminPanelSessions();
  s.create(CREATE_INPUT); // locked, not active
  assert.equal(s.activeForUser("u1", 0), null);
  const { activationCode } = s.create(CREATE_INPUT);
  s.activate("u1", activationCode, 0);
  assert.ok(s.activeForUser("u1", 0));
  assert.equal(s.activeForUser("someone-else", 0), null);
});
