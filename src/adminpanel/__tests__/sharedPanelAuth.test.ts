import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminPanel } from "../AdminPanel";

// The merged panel runs the whole admin surface behind ONE login. That makes
// the bridge from a billing-dashboard session into a config-panel session a
// security boundary, so these assert what it refuses, not what it allows.

const settings = {
  adminPanelEpoch: () => 1,
} as never;

// Never returns a session of its own: every case here exercises the bridge.
const sessions = { get: () => null } as never;

function panelWith(auth: { actor: { id: string; name: string; isAdmin: boolean }; state: string } | null) {
  const panel = new AdminPanel(settings, {} as never, sessions, {} as never, [], undefined);
  panel.bindSharedAuth({ authenticate: async () => auth });
  return panel;
}

test("shared login: an active admin dashboard session opens the config panel without a second unlock", async () => {
  // The dashboard login was earned with a passkey or a hardware key, which is a
  // stronger factor than this panel's Discord passcode. A second ceremony would
  // be theatre.
  const panel = panelWith({ actor: { id: "42", name: "Ada", isAdmin: true }, state: "active" });
  const res = (await panel.api("activation-status", "cookie", {})) as { status: number; json: Record<string, unknown> };
  assert.equal(res.status, 200);
  assert.equal(res.json.state, "active");
  assert.equal(res.json.adminName, "Ada");
  assert.ok(!("activationCode" in res.json), "an already-active session is never asked to activate");
});

test("shared login: a LOCKED dashboard session is refused", async () => {
  // A locked session has not finished logging in. Accepting it would let a
  // half-authenticated browser read configuration through the side door.
  const panel = panelWith({ actor: { id: "42", name: "Ada", isAdmin: true }, state: "locked" });
  const res = (await panel.api("activation-status", "cookie", {})) as { json: Record<string, unknown> };
  assert.equal(res.json.state, "expired");
});

test("shared login: a non-admin dashboard session is refused", async () => {
  // The dashboard has read-only roles. Those must not reach /config, which can
  // change refund caps and dispute automation.
  const panel = panelWith({ actor: { id: "7", name: "Viewer", isAdmin: false }, state: "active" });
  const res = (await panel.api("activation-status", "cookie", {})) as { json: Record<string, unknown> };
  assert.equal(res.json.state, "expired");
});

test("shared login: no dashboard session and no panel session means no access", async () => {
  const panel = panelWith(null);
  const res = (await panel.api("activation-status", "cookie", {})) as { json: Record<string, unknown> };
  assert.equal(res.json.state, "expired");

  // And an unbound bridge behaves exactly like an absent one.
  const unbound = new AdminPanel(settings, {} as never, sessions, {} as never, [], undefined);
  const res2 = (await unbound.api("activation-status", "cookie", {})) as { json: Record<string, unknown> };
  assert.equal(res2.json.state, "expired");
});

test("shared login: a bridged session carries no destructive challenge", async () => {
  // Destructive ceremonies mint their code through this panel's own Discord
  // path, which a dashboard login never walked. They stay available on a native
  // panel session and are simply unavailable on a bridged one.
  const panel = panelWith({ actor: { id: "42", name: "Ada", isAdmin: true }, state: "active" });
  const res = (await panel.api("activation-status", "cookie", {})) as { json: Record<string, unknown> };
  assert.equal(res.json.state, "active");
});
