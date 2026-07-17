import { test } from "node:test";
import assert from "node:assert/strict";
import { PanelTokens } from "../PanelTokens";
import { PanelSessions } from "../PanelSessions";
import type { SettingsStore } from "../../../config/SettingsStore";

// Fake SettingsStore covering exactly the surface PanelTokens touches.
function fakeSettings(overrides: { epoch?: number; baseUrl?: string | null } = {}) {
  let epoch = overrides.epoch ?? 0;
  const secret = "test-secret-0123456789abcdef";
  return {
    store: {
      ensurePanelTokenSecret: async () => secret,
      panelTokenSecret: () => secret,
      panelTokenEpoch: () => epoch,
      resolvedPublicBaseUrl: () => (overrides.baseUrl === undefined ? "https://bot.example.com" : overrides.baseUrl),
    } as unknown as SettingsStore,
    bumpEpoch: () => {
      epoch += 1;
    },
  };
}

const MINT_INPUT = { adminId: "42", adminName: "Agent Ada", conversationId: "777" };

test("mint → verify round-trip carries identity, scope, jti and epoch", async () => {
  const { store } = fakeSettings();
  const tokens = new PanelTokens(store);
  const token = await tokens.mint(MINT_INPUT);
  const payload = tokens.verify(token);
  assert.ok(payload);
  assert.equal(payload!.aid, "42");
  assert.equal(payload!.an, "Agent Ada");
  assert.equal(payload!.cid, "777");
  assert.equal(payload!.epo, 0);
  assert.ok(payload!.jti.length >= 16);
  assert.ok(payload!.exp > Date.now());
});

test("tampering with any of the three segments invalidates the token", async () => {
  const { store } = fakeSettings();
  const tokens = new PanelTokens(store);
  const token = await tokens.mint(MINT_INPUT);
  const [version, body, mac] = token.split(".");

  // version
  assert.equal(tokens.verify(`v2.${body}.${mac}`), null);
  // payload (swap the admin id inside the base64url JSON)
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  payload.aid = "99";
  const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.equal(tokens.verify(`${version}.${forgedBody}.${mac}`), null);
  // mac
  const flipped = mac.slice(0, -1) + (mac.endsWith("0") ? "1" : "0");
  assert.equal(tokens.verify(`${version}.${body}.${flipped}`), null);
  // garbage shapes
  assert.equal(tokens.verify(""), null);
  assert.equal(tokens.verify("v1.only-two"), null);
});

test("expired tokens are rejected", async () => {
  const { store } = fakeSettings();
  const tokens = new PanelTokens(store);
  const token = await tokens.mint(MINT_INPUT);
  const [version, body] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  payload.exp = Date.now() - 1000;
  // Re-sign with the real secret so ONLY expiry differs.
  const { createHmac } = await import("node:crypto");
  const newBody = `${version}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const mac = createHmac("sha256", "test-secret-0123456789abcdef").update(newBody).digest("hex");
  assert.equal(tokens.verify(`${newBody}.${mac}`), null);
});

test("epoch bump (Revoke Stripe Panel Links) invalidates outstanding tokens", async () => {
  const fake = fakeSettings();
  const tokens = new PanelTokens(fake.store);
  const token = await tokens.mint(MINT_INPUT);
  assert.ok(tokens.verify(token));
  fake.bumpEpoch();
  assert.equal(tokens.verify(token), null);
});

test("minting refuses a non-https public base URL (localhost allowed)", async () => {
  const insecure = new PanelTokens(fakeSettings({ baseUrl: "http://bot.example.com" }).store);
  await assert.rejects(() => insecure.mint(MINT_INPUT), /https/);
  const local = new PanelTokens(fakeSettings({ baseUrl: "http://localhost:3000" }).store);
  assert.ok(await local.mint(MINT_INPUT));
  const unset = new PanelTokens(fakeSettings({ baseUrl: null }).store);
  assert.ok(await unset.mint(MINT_INPUT));
});

test("jti is single-use", () => {
  const sessions = new PanelSessions();
  assert.equal(sessions.consumeJti("abc"), true);
  assert.equal(sessions.consumeJti("abc"), false); // replay
  assert.equal(sessions.consumeJti("def"), true);
});

test("sessions: create/get, epoch revocation, unknown ids", () => {
  const sessions = new PanelSessions();
  const id = sessions.create({ aid: "42", an: "Ada", cid: "777", epoch: 0 });
  const got = sessions.get(id, 0);
  assert.ok(got);
  assert.equal(got!.aid, "42");
  assert.equal(got!.cid, "777");
  // wrong/unknown id
  assert.equal(sessions.get("nope", 0), null);
  // epoch bump kills it
  assert.equal(sessions.get(id, 1), null);
  // and it stays dead even at the old epoch (deleted on mismatch)
  assert.equal(sessions.get(id, 0), null);
});

test("session ids are unpredictable and unique", () => {
  const sessions = new PanelSessions();
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const id = sessions.create({ aid: "1", an: "x", cid: "1", epoch: 0 });
    assert.ok(id.length >= 40);
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});
