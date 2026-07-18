import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mountPanel, parseCookies, MountedPanelRoute } from "../panelMount";

// The shared transport belt, exercised over a real ephemeral HTTP server:
// per-IP throttle hook, CSP/security headers, the CSRF triple belt, cookie
// parsing and the error shape — the invariants all three panels rely on.

const route: MountedPanelRoute = {
  page: async (token, cookie) => {
    if (token === "boom") throw new Error("kaboom");
    if (token === "good") {
      return {
        html: "<!doctype html><title>t</title>",
        nonce: "NONCE123",
        sessionCookie: "__Host-test=abc; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800",
      };
    }
    if (token === "resume" && cookie === "livecookie") {
      return { html: "<!doctype html><title>resumed</title>", nonce: "NONCE456" };
    }
    return { status: 401, message: "bad token" };
  },
  api: async (endpoint, sessionId) => {
    if (endpoint === "whoami") return { status: 200, json: { sessionId } };
    if (endpoint === "gone") return { status: 401, json: { error: "expired" } };
    return { status: 404, json: { error: "unknown endpoint" } };
  },
};

let allowNext = true;
const app = express();
mountPanel(app, () => allowNext, {
  pagePath: "/test/panel",
  apiPath: "/test/panel/api/:endpoint",
  cookieName: "__Host-test",
  metricName: "test.panel_auth_failures",
  logLabel: "test panel",
  route: () => route,
});
// A second mount whose route object is absent — must 404.
mountPanel(app, () => true, {
  pagePath: "/absent/panel",
  apiPath: "/absent/panel/api/:endpoint",
  cookieName: "__Host-absent",
  metricName: "absent.panel_auth_failures",
  logLabel: "absent panel",
  route: () => undefined,
});

let server: Server | undefined;
let base = "";

async function start(): Promise<void> {
  if (server) return;
  const s = app.listen(0, "127.0.0.1");
  server = s;
  await new Promise<void>((resolve) => s.once("listening", resolve));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

after(() => {
  server?.close();
});

const API_HEADERS = { "Content-Type": "application/json", "X-Panel-Request": "1" };

test("page: token exchange sets cookie, CSP nonce and the security headers", async () => {
  await start();
  const res = await fetch(`${base}/test/panel?t=good`, { redirect: "manual" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /nonce-NONCE123/);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("set-cookie") ?? "", /^__Host-test=abc/);
});

test("page: cookie is forwarded so a live session can resume without Set-Cookie", async () => {
  await start();
  const res = await fetch(`${base}/test/panel?t=resume`, { headers: { Cookie: "__Host-test=livecookie" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.match(await res.text(), /resumed/);
});

test("page: bad token → auth-failure status; thrown route error → 500 shape", async () => {
  await start();
  const bad = await fetch(`${base}/test/panel?t=nope`);
  assert.equal(bad.status, 401);
  const boom = await fetch(`${base}/test/panel?t=boom`);
  assert.equal(boom.status, 500);
  assert.equal(await boom.text(), "Internal error");
});

test("api CSRF belt: missing header, cross-site Sec-Fetch-Site and foreign Origin are all rejected", async () => {
  await start();
  // (1) missing X-Panel-Request
  const noHeader = await fetch(`${base}/test/panel/api/whoami`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(noHeader.status, 403);
  // (2) cross-site Sec-Fetch-Site
  const crossSite = await fetch(`${base}/test/panel/api/whoami`, {
    method: "POST",
    headers: { ...API_HEADERS, "Sec-Fetch-Site": "cross-site" },
    body: "{}",
  });
  assert.equal(crossSite.status, 403);
  // (3) Origin not matching the request host
  const foreignOrigin = await fetch(`${base}/test/panel/api/whoami`, {
    method: "POST",
    headers: { ...API_HEADERS, Origin: "https://evil.example.com" },
    body: "{}",
  });
  assert.equal(foreignOrigin.status, 403);
});

test("api: happy path passes the session cookie through and sets no-store headers", async () => {
  await start();
  const res = await fetch(`${base}/test/panel/api/whoami`, {
    method: "POST",
    headers: { ...API_HEADERS, "Sec-Fetch-Site": "same-origin", Cookie: "__Host-test=sess-1; other=x" },
    body: "{}",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sessionId: "sess-1" });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
});

test("api: matching same-host Origin is accepted", async () => {
  await start();
  const host = new URL(base).host;
  const res = await fetch(`${base}/test/panel/api/whoami`, {
    method: "POST",
    headers: { ...API_HEADERS, Origin: `http://${host}` },
    body: "{}",
  });
  assert.equal(res.status, 200);
});

test("per-IP throttle answers 429 on both routes", async () => {
  await start();
  allowNext = false;
  try {
    const page = await fetch(`${base}/test/panel?t=good`);
    assert.equal(page.status, 429);
    const api = await fetch(`${base}/test/panel/api/whoami`, { method: "POST", headers: API_HEADERS, body: "{}" });
    assert.equal(api.status, 429);
  } finally {
    allowNext = true;
  }
});

test("absent route object → 404 on both routes", async () => {
  await start();
  const page = await fetch(`${base}/absent/panel?t=x`);
  assert.equal(page.status, 404);
  const api = await fetch(`${base}/absent/panel/api/x`, { method: "POST", headers: API_HEADERS, body: "{}" });
  assert.equal(api.status, 404);
});

test("parseCookies handles the usual shapes", () => {
  assert.deepEqual(parseCookies("a=b; c=d"), { a: "b", c: "d" });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("noequals"), {});
});
