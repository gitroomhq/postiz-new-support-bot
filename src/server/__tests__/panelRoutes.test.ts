import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CallbackServer } from "../CallbackServer";
import type { MountedPanelRoute } from "../panelMount";

// Route ORDER on the merged admin surface. Express matches in registration
// order and the dashboard mounts with spaWildcard, so every assertion here
// fails silently in production if the order slips: a redirect registered after
// the mount it shadows is simply never reached, and /panel/*splat swallows
// /panel/config and serves the wrong shell behind the right URL.
//
// The shells are stubbed: this is about which handler answers, not what it
// renders.

function shell(name: string): MountedPanelRoute {
  return {
    page: async (token, cookie) => ({
      html: `<!doctype html><title>${name}</title><p>token=${token || "-"} cookie=${cookie || "-"}</p>`,
      nonce: "N",
    }),
    api: async (endpoint, sessionId) => ({ status: 200, json: { shell: name, endpoint, sessionId } }),
  };
}

const server = new CallbackServer(
  { server: { port: 0 } } as never,
  {} as never,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  shell("admin"),
  shell("dashboard"),
  undefined
);
// The express app is private only to discourage reaching past the class; a
// route-ordering test has no other way to see the routing table.
const app = (server as unknown as { app: Express }).app;

let http: Server | undefined;
let base = "";

async function start(): Promise<void> {
  if (http) return;
  const s = app.listen(0, "127.0.0.1");
  http = s;
  await new Promise<void>((resolve) => s.once("listening", resolve));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

after(() => {
  http?.close();
});

test("/billing redirects to the merged panel, query string intact", async () => {
  await start();
  const res = await fetch(`${base}/billing`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/panel");

  const deep = await fetch(`${base}/billing?t=abc&x=1`, { redirect: "manual" });
  assert.equal(deep.status, 302);
  assert.equal(deep.headers.get("location"), "/panel?t=abc&x=1");
});

test("/admin/panel without a token redirects to /panel/config", async () => {
  await start();
  const res = await fetch(`${base}/admin/panel`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/panel/config");

  // An empty token is not a token.
  const empty = await fetch(`${base}/admin/panel?t=`, { redirect: "manual" });
  assert.equal(empty.status, 302);
  assert.equal(empty.headers.get("location"), "/panel/config?t=");
});

test("/admin/panel?t= keeps serving: it is the Discord bootstrap link", async () => {
  // This is how a box whose dashboard login is not configured yet gets
  // repaired. If the redirect ever swallows it, the box is unrecoverable from
  // Discord.
  await start();
  const res = await fetch(`${base}/admin/panel?t=linktoken`, { redirect: "manual" });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>admin<\/title>/);
  assert.match(body, /token=linktoken/);
});

test("/panel/config serves the admin shell, not the dashboard wildcard", async () => {
  await start();
  const res = await fetch(`${base}/panel/config`, { redirect: "manual" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>admin<\/title>/);
});

test("/panel/config reads the DASHBOARD cookie, which is what makes one login cover both", async () => {
  await start();
  const res = await fetch(`${base}/panel/config`, {
    headers: { Cookie: "__Host-billing=dash-session; __Host-acpanel=native" },
  });
  assert.match(await res.text(), /cookie=dash-session/);

  const api = await fetch(`${base}/panel/config/api/activation-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Panel-Request": "1", Cookie: "__Host-billing=dash-session" },
    body: "{}",
  });
  assert.deepEqual(await api.json(), { shell: "admin", endpoint: "activation-status", sessionId: "dash-session" });
});

test("/panel and its deep links still reach the dashboard", async () => {
  await start();
  const root = await fetch(`${base}/panel`);
  assert.match(await root.text(), /<title>dashboard<\/title>/);
  const deep = await fetch(`${base}/panel/customers/cus_123`);
  assert.match(await deep.text(), /<title>dashboard<\/title>/);
});
