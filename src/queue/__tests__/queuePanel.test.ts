import { test } from "node:test";
import assert from "node:assert/strict";
import { QueuePanel, viewRequest } from "../QueuePanel";
import { renderQueueShell } from "../html/queueShell";
import { renderQueueNavigation } from "../html/queueNavigation";
import { queueReadiness } from "../queueConfig";
import { makeQueueHub } from "../../adminpanel/sections/queueHub";
import type { QueueAuth, QueueActor } from "../QueueAuth";
import type { QueueViews } from "../queueViews";
import type { AdminHubContext } from "../../adminpanel/sections/types";
import type { QueueExclusions } from "../../config/SettingsStore";

// The /queue route object (kill switch, the session gate, request shaping),
// the shell, readiness, and the web Queue hub's validation.

test("OAuth navigation escapes destinations in the refresh and fallback link without running scripts", () => {
  const html = renderQueueNavigation('/queue?e=error&x="/><script>alert(1)</script>', "nonce1");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes('content="0;url=/queue?e=error&amp;x=&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
  assert.ok(html.includes('href="/queue?e=error&amp;x=&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'));
});

function readinessSettings(over: Partial<Record<string, unknown>> = {}) {
  return {
    queueEnabled: () => true,
    queueOauthClientId: () => "client-123",
    queueOauthClientSecret: () => "secret",
    intercomConfigured: () => true,
    resolvedPublicBaseUrl: () => "https://bot.example.com",
    ...over,
  } as Parameters<typeof queueReadiness>[0];
}

function panel(opts: { enabled?: boolean; actor?: QueueActor | null } = {}) {
  const settings = readinessSettings({ queueEnabled: () => opts.enabled ?? true });
  const seen: string[] = [];
  const auth = {
    authenticate: async () => opts.actor ?? null,
    logout: async () => void seen.push("logout"),
    start: () => ({ status: 404 as const }),
    callback: async () => ({ status: 404 as const }),
  } as unknown as QueueAuth;
  const views = {
    build: async (_a: QueueActor, req: { page: string }) => (req.page === "global" ? { page: "global", blocks: [] } : null),
    action: async () => ({ ok: true, text: "done" }),
    // The list sits at version "abcd0123.7".
    waitForChange: async (since: string, ms: number) => {
      seen.push(`wait:${since}:${ms}`);
      return since !== "abcd0123.7";
    },
    refresh: () => void seen.push("refresh"),
  } as unknown as QueueViews;
  return { p: new QueuePanel(settings, auth, views, 50), seen };
}

const ADA: QueueActor = { adminId: "11", name: "Ada", sessionIdHash: "h" };

test("off: the page and every endpoint answer 404", async () => {
  const { p } = panel({ enabled: false });
  assert.deepEqual(await p.page(), { status: 404, message: "Not found" });
  assert.equal((await p.api("status", "", {})).status, 404);
});

test("without a session only status answers (sign-in screen); everything else is expired", async () => {
  const { p } = panel();
  assert.deepEqual((await p.api("status", "", {})).json, { state: "login", ready: true });
  assert.deepEqual((await p.api("view", "", { page: "global" })).json, { state: "expired", error: "expired" });
  assert.deepEqual((await p.api("action", "", {})).json, { state: "expired", error: "expired" });
});

test("with a session: status, view, action, logout and unknowns", async () => {
  const { p, seen } = panel({ actor: ADA });
  assert.deepEqual((await p.api("status", "c", {})).json, { state: "active", name: "Ada" });
  assert.equal((await p.api("view", "c", { page: "global" })).status, 200);
  assert.equal((await p.api("view", "c", { page: "nope" })).status, 404);
  assert.equal((await p.api("view", "c", { page: "../etc" })).status, 400);
  assert.deepEqual((await p.api("action", "c", { key: "section:queue.roll", params: { scope: "global" } })).json, { ok: true, text: "done" });
  await p.api("logout", "c", {});
  assert.deepEqual(seen, ["logout"]);
  assert.equal((await p.api("whatever", "c", {})).status, 404);
});

test("viewRequest drops anything a hostile client might send", () => {
  assert.equal(viewRequest({ page: "A" }), null);
  assert.equal(viewRequest({ page: "x".repeat(40) }), null);
  const req = viewRequest({
    page: "inbox.detail",
    params: { id: "123", "bad key": "x", long: "y".repeat(100), n: 5 },
    filters: { view: "longest", __proto__: "x" },
    cursor: "25; drop",
  });
  assert.deepEqual(req, { page: "inbox.detail", params: { id: "123" }, filters: { view: "longest" }, cursor: null, since: null });
  assert.equal(viewRequest({ page: "global", cursor: "50" })?.cursor, "50");
  assert.equal(viewRequest({ page: "global", since: "abcd0123.7" })?.since, "abcd0123.7");
  assert.equal(viewRequest({ page: "global", since: "x".repeat(400) })?.since, null);
  assert.equal(viewRequest({ page: "global", since: 7 })?.since, null);
});

test("live updates: since waits for a change, unchanged answers small, refresh asks for a read", async () => {
  const { p, seen } = panel({ actor: ADA });
  assert.deepEqual((await p.api("view", "c", { page: "global", since: "abcd0123.7" })).json, { unchanged: true });
  assert.deepEqual((await p.api("view", "c", { page: "global", since: "abcd0123.6" })).json, { page: "global", blocks: [] });
  assert.deepEqual(seen, ["wait:abcd0123.7:50", "wait:abcd0123.6:50"]);
  await p.api("view", "c", { page: "global", refresh: true });
  assert.deepEqual(seen.slice(2), ["refresh"], "no since: answers at once");
});

test("the shell parses, carries the nonce on both tags and has no leftover template holes", () => {
  const html = renderQueueShell({ nonce: "NONCE1" });
  assert.match(html, /<style nonce="NONCE1">/);
  assert.match(html, /<script nonce="NONCE1">/);
  assert.ok(!html.includes("${"));
  const m = /<script nonce="NONCE1">([\s\S]*)<\/script>/.exec(html);
  assert.ok(m);
  assert.doesNotThrow(() => new Function(m[1]));
  for (const id of ["login", "loginGo", "app", "nav", "content", "expired", "lock", "modal", "refreshbtn", "logout"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /href="\/queue\/oauth\/start"/);
});

test("readiness names what is missing and only offers https URLs", () => {
  const ok = queueReadiness(readinessSettings());
  assert.deepEqual(ok, {
    ok: true,
    missing: [],
    pageUrl: "https://bot.example.com/queue",
    callbackUrl: "https://bot.example.com/queue/oauth/callback",
  });
  const bad = queueReadiness(
    readinessSettings({ queueOauthClientSecret: () => null, resolvedPublicBaseUrl: () => "http://bot.example.com" })
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.callbackUrl, null);
  assert.equal(bad.missing.length, 2);
});

// ---- web Queue hub ----

function hubCtx() {
  const state = {
    enabled: false,
    clientId: null as string | null,
    secret: null as string | null,
    exclusions: { teams: [], tags: [], ticketTypes: [] } as QueueExclusions,
  };
  const audits: string[] = [];
  const settings = {
    queueEnabled: () => state.enabled,
    queueOauthClientId: () => state.clientId,
    queueOauthClientSecret: () => state.secret,
    intercomConfigured: () => true,
    resolvedPublicBaseUrl: () => "https://bot.example.com",
    queueFinCountsAsReply: () => false,
    queueNotesCountAsReply: () => false,
    queueExclusions: () => state.exclusions,
    secretState: () => (state.secret ? "local" : "none"),
    updateQueue: async (d: Record<string, unknown>) => {
      if (d.queueEnabled !== undefined) state.enabled = d.queueEnabled as boolean;
      if (d.queueOauthClientId !== undefined) state.clientId = d.queueOauthClientId as string | null;
      if (d.queueOauthClientSecret !== undefined) state.secret = d.queueOauthClientSecret as string | null;
      if (d.queueExclusions !== undefined) state.exclusions = d.queueExclusions as QueueExclusions;
    },
  };
  const ctx = { settings, audit: async (c: string) => void audits.push(c), actor: { id: "1", name: "Admin", guildId: "g" } } as unknown as AdminHubContext;
  let signedOut = 0;
  const hub = makeQueueHub({
    listTeams: async () => [{ id: "22", name: "Support Team" }],
    listTags: async () => [{ id: "t1", name: "spam" }],
    listTicketTypes: async () => [
      { id: "8", name: "Billing", category: "Customer" },
      { id: "9", name: "Internal", category: "Back-office" },
    ],
    liveSessions: async () => 3,
    signOutAll: async () => (signedOut++, 3),
  });
  return { hub, ctx, state, audits, signedOut: () => signedOut };
}

test("web hub: the secret is write-only, blank keeps it, none clears it, junk is refused", async () => {
  const { hub, ctx, state, audits } = hubCtx();
  const sections = await hub.buildSections(ctx, {});
  const secretField = sections[0].fields.find((f) => f.key === "queueOauthClientSecret");
  assert.ok(secretField && secretField.type === "text" && secretField.value === "");
  assert.equal((await hub.save(ctx, { section: "queue", field: "queueOauthClientSecret", value: "good-secret-123" })).ok, true);
  assert.equal(state.secret, "good-secret-123");
  assert.equal((await hub.save(ctx, { section: "queue", field: "queueOauthClientSecret", value: "" })).ok, true);
  assert.equal(state.secret, "good-secret-123", "blank keeps");
  assert.equal((await hub.save(ctx, { section: "queue", field: "queueOauthClientSecret", value: "has spaces in it" })).ok, false);
  assert.equal((await hub.save(ctx, { section: "queue", field: "queueOauthClientSecret", value: "none" })).ok, true);
  assert.equal(state.secret, null);
  assert.ok(audits.every((a) => !a.includes("good-secret-123")), "the secret never reaches the audit trail");
});

test("web hub: exclusions accept only ids Intercom lists, and only Customer ticket types are offered", async () => {
  const { hub, ctx, state } = hubCtx();
  const sections = await hub.buildSections(ctx, {});
  const types = sections[2].fields.find((f) => f.key === "queueExcludedTicketTypes");
  assert.ok(types && types.type === "multiselect");
  assert.deepEqual(types.options.map((o) => o.value), ["8"]);
  await hub.save(ctx, { section: "queueExclusions", field: "queueExcludedTeams", value: ["22", "999", 5] });
  assert.deepEqual(state.exclusions.teams, [{ id: "22", name: "Support Team" }]);
  assert.equal((await hub.save(ctx, { section: "queueExclusions", field: "queueExcludedTags", value: "t1" })).ok, false);
});

test("web hub: sign everyone out needs the typed CONFIRM server-side", async () => {
  const { hub, ctx, signedOut } = hubCtx();
  assert.equal((await hub.action!(ctx, { key: "queue_sign_out_all" })).ok, false);
  assert.equal(signedOut(), 0);
  assert.equal((await hub.action!(ctx, { key: "queue_sign_out_all", confirmWord: "CONFIRM" })).ok, true);
  assert.equal(signedOut(), 1);
});
