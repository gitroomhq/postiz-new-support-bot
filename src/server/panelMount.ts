import express, { type Express } from "express";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";

const httpLog = log.child("http");

// Shared transport belt for the tokenized web panels (Stripe panel, admin
// panel, dashboard). Each panel is a GET page route (single-use link token →
// HttpOnly __Host- session cookie) + a POST api route (cookie-authed). This
// helper owns everything transport-level so the three panels can never drift:
// per-IP pre-auth throttle, security headers with a per-response CSP nonce,
// the CSRF triple belt, cookie parsing and the error shape. Panel semantics
// (token verify, sessions, endpoints) stay inside the mounted route object.
//
// Deliberately adds ZERO global middleware: the webhook routes depend on
// route-scoped express.json({ verify }) raw-body capture, and every mount here
// registers its own route-scoped json parser exactly like the originals.

// Applied to every panel response (page + API).
export const PANEL_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // Harmless behind a TLS-terminating proxy; a no-op on plain http.
  "Strict-Transport-Security": "max-age=31536000",
} as const;

// What a mounted panel implements. page() may ignore the cookie/meta arguments
// (the two legacy panels do); the dashboard uses them to resume a standing
// session without burning a link token and to stamp login context (ip/ua).
// api() may return setCookie — the standing login sets its session cookie from
// an XHR response (browsers apply Set-Cookie on same-origin fetches).
export interface PanelRequestMeta {
  ip?: string;
  ua?: string;
}
export interface MountedPanelRoute {
  page(
    token: string,
    cookie: string,
    meta?: PanelRequestMeta
  ): Promise<{ html: string; nonce: string; sessionCookie?: string } | { status: number; message: string }>;
  api(
    endpoint: string,
    sessionId: string,
    body: unknown,
    meta?: PanelRequestMeta
  ): Promise<{ status: number; json: object; setCookie?: string }>;
}

export interface PanelMountSpec {
  pagePath: string; // e.g. "/admin/panel"
  apiPath: string; // e.g. "/admin/panel/api/:endpoint" (must declare :endpoint)
  cookieName: string; // e.g. "__Host-acpanel"
  metricName: string; // auth-failure counter, tagged { where: page|csrf|api }
  logLabel: string; // e.g. "admin panel"
  jsonLimit?: string; // default "256kb"
  // Late-bound: CallbackServer receives route objects as optional constructor
  // args, so the getter re-reads per request (404 while absent).
  route: () => MountedPanelRoute | undefined;
}

export function mountPanel(app: Express, allowIp: (ip: string | undefined) => boolean, spec: PanelMountSpec): void {
  app.get(spec.pagePath, async (req, res) => {
    const route = spec.route();
    if (!route) {
      res.status(404).send("Not found");
      return;
    }
    if (!allowIp(req.ip)) {
      res.status(429).set("Cache-Control", "no-store").send("Too many requests.");
      return;
    }
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const cookie = parseCookies(req.headers.cookie)[spec.cookieName] ?? "";
    try {
      const result = await route.page(token, cookie, { ip: req.ip, ua: req.header("user-agent") });
      if ("html" in result) {
        res
          .status(200)
          .set({
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy":
              `default-src 'none'; style-src 'nonce-${result.nonce}'; script-src 'nonce-${result.nonce}'; ` +
              "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
            "Referrer-Policy": "no-referrer",
            ...PANEL_SECURITY_HEADERS,
            ...(result.sessionCookie ? { "Set-Cookie": result.sessionCookie } : {}),
          })
          .send(result.html);
      } else {
        metricCount(spec.metricName, 1, { where: "page" });
        res.status(result.status).set({ "Cache-Control": "no-store", ...PANEL_SECURITY_HEADERS }).send(result.message);
      }
    } catch (e) {
      httpLog.error(`${spec.logLabel} page failed`, e);
      res.status(500).send("Internal error");
    }
  });

  app.post(spec.apiPath, express.json({ limit: spec.jsonLimit ?? "256kb" }), async (req, res) => {
    const route = spec.route();
    if (!route) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!allowIp(req.ip)) {
      res.status(429).set("Cache-Control", "no-store").json({ error: "rate limited" });
      return;
    }
    // CSRF belts on top of the SameSite cookie. (1) Custom header: cross-site
    // forms can't send one without a CORS preflight, which nothing here
    // answers. (2) Sec-Fetch-Site, when the browser provides it, must be
    // same-origin. (3) An Origin header, when present, must match the request
    // host.
    const secFetchSite = req.header("sec-fetch-site");
    const origin = req.header("origin");
    let originHostOk = true;
    if (origin) {
      try {
        originHostOk = new URL(origin).host === req.headers.host;
      } catch {
        originHostOk = false;
      }
    }
    if (req.header("x-panel-request") !== "1" || (secFetchSite && secFetchSite !== "same-origin") || !originHostOk) {
      httpLog.warn(`${spec.logLabel} api cross-origin rejected`, {
        "panel.endpoint": String(req.params.endpoint),
        "http.sec_fetch_site": secFetchSite ?? "",
        "http.origin": origin ?? "",
      });
      metricCount(spec.metricName, 1, { where: "csrf" });
      res.status(403).set({ "Cache-Control": "no-store", ...PANEL_SECURITY_HEADERS }).json({ error: "forbidden" });
      return;
    }
    const sessionId = parseCookies(req.headers.cookie)[spec.cookieName] ?? "";
    try {
      const result = await route.api(String(req.params.endpoint), sessionId, req.body, {
        ip: req.ip,
        ua: req.header("user-agent"),
      });
      if (result.status === 401) metricCount(spec.metricName, 1, { where: "api" });
      res
        .status(result.status)
        .set({
          "Cache-Control": "no-store",
          ...PANEL_SECURITY_HEADERS,
          ...(result.setCookie ? { "Set-Cookie": result.setCookie } : {}),
        })
        .json(result.json);
    } catch (e) {
      httpLog.error(`${spec.logLabel} api failed`, e, { "panel.endpoint": String(req.params.endpoint) });
      res.status(500).json({ error: "internal" });
    }
  });
}

// Minimal cookie parse (no dependency): "a=b; c=d" → { a: "b", c: "d" }.
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}
