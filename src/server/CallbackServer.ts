import express, { type Express, type Request } from "express";
import * as Sentry from "@sentry/node";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type Stripe from "stripe";
import { BotConfig } from "../config";
import { OAuthManager } from "../auth/OAuthManager";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";
import { exportIntercomWebhook } from "../metrics/MetricsExporter";
import { TemporalBufferedError } from "../temporal/producers";

const httpLog = log.child("http");

// Inbound Intercom webhook wiring. The client secret lives in BotSettings
// (editable via /config), so it's read per request through the getter.
// accept() must only do a durable insert (single DB write) — real handling
// runs in the IntercomInboxScheduler.
export interface IntercomWebhookRoute {
  getClientSecret: () => string | null;
  accept: (body: unknown) => Promise<boolean>;
}

// Canvas Kit inbox app (live context sidebar card in the Intercom inbox).
// Signed with the same app client secret, but HMAC-SHA256 in X-Body-Signature.
export interface IntercomCanvasRoute {
  getClientSecret: () => string | null;
  initialize: (body: unknown) => Promise<object>;
  submit: (body: unknown) => Promise<object>;
}

// Inbound Stripe webhook. constructEvent needs the RAW body (captured via the
// express.json verify hook, same as Intercom). The signing secret lives in
// BotSettings (set at programmatic registration), so it's read per request.
export interface StripeWebhookRoute {
  getSecret: () => string | null;
  constructEvent: (raw: Buffer, signature: string, secret: string) => Stripe.Event;
  handle: (event: Stripe.Event) => Promise<void>;
}

// Stripe panel (tokenized standalone page opened from the Intercom canvas).
// GET exchanges the SINGLE-USE HMAC link token for an HttpOnly session cookie
// (verified/consumed inside the route object); the API authenticates by that
// cookie. This layer adds the transport belts: per-IP throttle, security
// headers with a per-response CSP nonce, and CSRF checks on the API.
export interface IntercomPanelRoute {
  page: (token: string) => Promise<{ html: string; nonce: string; sessionCookie: string } | { status: number; message: string }>;
  api: (endpoint: string, sessionId: string, body: unknown) => Promise<{ status: number; json: object }>;
}

// Admin web panel (/config + /intercom) — same transport contract as the Stripe
// panel (token→cookie exchange on GET, cookie-authed API), but a separate route
// prefix and cookie so the two panels' sessions never collide.
export interface AdminPanelRoute {
  page: (token: string) => Promise<{ html: string; nonce: string; sessionCookie: string } | { status: number; message: string }>;
  api: (endpoint: string, sessionId: string, body: unknown) => Promise<{ status: number; json: object }>;
}

type RawBodyRequest = Request & { rawBody?: Buffer };

// Applied to every Stripe-panel response (page + API).
const PANEL_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // Harmless behind a TLS-terminating proxy; a no-op on plain http.
  "Strict-Transport-Security": "max-age=31536000",
} as const;

const PANEL_IP_LIMIT_PER_MIN = 60;
const PANEL_IP_WINDOW_MS = 60_000;
const PANEL_IP_MAX_KEYS = 2000;

export class CallbackServer {
  private app: Express;
  // Pre-authentication throttle for the panel routes: bounds token-guessing /
  // log-replay bursts before any HMAC or session work happens.
  private panelIpHits = new Map<string, number[]>();

  constructor(
    private config: BotConfig,
    private oauthManager: OAuthManager,
    private onAuthSuccess?: (discordUserId: string, interactionToken: string | null) => Promise<void>,
    private intercomWebhook?: IntercomWebhookRoute,
    private intercomCanvas?: IntercomCanvasRoute,
    private stripeWebhook?: StripeWebhookRoute,
    private intercomPanel?: IntercomPanelRoute,
    private adminPanel?: AdminPanelRoute
  ) {
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.get("/callback", async (req, res) => {
      const { code, state, error } = req.query;

      if (error) {
        res.status(400).send("Authorization denied. You can close this window.");
        return;
      }

      if (!code || !state) {
        res.status(400).send("Missing code or state parameter.");
        return;
      }

      try {
        const { discordUserId, interactionToken } = await this.oauthManager.handleCallback(
          code as string,
          state as string
        );

        res.send("Successfully authenticated! You can close this window and return to Discord.");
        httpLog.info("oauth.callback.completed", { "discord.user_id": discordUserId });

        try {
          if (this.onAuthSuccess) {
            await this.onAuthSuccess(discordUserId, interactionToken);
          }
        } catch {
          // Interaction token may have expired — that's fine, they'll see it works when they click Start Here again
        }
      } catch (err) {
        httpLog.error("oauth callback failed", err);
        res.status(500).send("Authentication failed. Please try again.");
      }
    });

    this.app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });

    // Endpoint-URL validation probes (defensive — Intercom's documented ping
    // arrives as a normal signed POST, but a plain HEAD must not 404).
    this.app.head("/intercom/webhook", (_req, res) => {
      res.sendStatus(200);
    });

    // Intercom signs every webhook: X-Hub-Signature = "sha1=" + hex(HMAC-SHA1
    // of the RAW request body, keyed with the app's client secret). The raw
    // body is captured via express.json's verify hook (route-scoped so the
    // OAuth /callback stays untouched). The handler durably queues the event
    // (one DB insert) inside Intercom's 5s window; a failed insert answers 500
    // so Intercom's single retry redelivers instead of the event being lost.
    this.app.post(
      "/intercom/webhook",
      express.json({
        limit: "2mb",
        verify: (req, _res, buf) => {
          (req as RawBodyRequest).rawBody = buf;
        },
      }),
      async (req, res) => {
        const secret = this.intercomWebhook?.getClientSecret();
        const signature = req.header("x-hub-signature");
        const raw = (req as RawBodyRequest).rawBody;
        const topic = typeof (req.body as { topic?: unknown })?.topic === "string" ? (req.body as { topic: string }).topic : "unknown";
        if (!this.intercomWebhook || !secret || !signature || !raw || !signatureMatches(raw, secret, signature)) {
          metricCount("intercom.webhooks", 1, { topic, accepted: false });
          // Influx counter for Grafana alerting: a rotated client secret 403s
          // EVERY delivery silently (Intercom does not retry 4xx).
          exportIntercomWebhook("rejected");
          res.status(403).send("Forbidden");
          return;
        }
        try {
          const accepted = await this.intercomWebhook.accept(req.body);
          httpLog.info("intercom.webhook.received", { "webhook.topic": topic, "webhook.accepted": accepted });
          metricCount("intercom.webhooks", 1, { topic, accepted: true });
          exportIntercomWebhook("accepted");
          res.status(200).send("ok");
        } catch (e) {
          httpLog.error("intercom webhook enqueue failed", e, { "webhook.topic": topic });
          metricCount("intercom.webhooks", 1, { topic, accepted: false });
          // Sustained 500s risk Intercom auto-disabling the subscription —
          // alert on this (see README runbook).
          exportIntercomWebhook(e instanceof TemporalBufferedError ? "buffered" : "error");
          res.status(500).send("queueing failed");
        }
      }
    );

    // Canvas Kit inbox app: Intercom POSTs when an agent opens the sidebar
    // card (initialize) or clicks a submit button (Refresh). Signed with
    // X-Body-Signature = hex(HMAC-SHA256 of the raw body, app client secret).
    // Responses must land fast — the handlers time-box their external fetches.
    for (const [path, kind] of [
      ["/intercom/inbox-app/initialize", "initialize"],
      ["/intercom/inbox-app/submit", "submit"],
    ] as const) {
      this.app.post(
        path,
        express.json({
          limit: "1mb",
          verify: (req, _res, buf) => {
            (req as RawBodyRequest).rawBody = buf;
          },
        }),
        async (req, res) => {
          const secret = this.intercomCanvas?.getClientSecret();
          const signature = req.header("x-body-signature");
          const raw = (req as RawBodyRequest).rawBody;
          if (!this.intercomCanvas || !secret || !signature || !raw || !canvasSignatureMatches(raw, secret, signature)) {
            res.status(403).send("Forbidden");
            return;
          }
          try {
            const canvas = await this.intercomCanvas[kind](req.body);
            res.json(canvas);
          } catch (e) {
            httpLog.error("intercom canvas request failed", e, { "canvas.kind": kind });
            res.status(500).json({});
          }
        }
      );
    }

    // Stripe panel: a tokenized standalone page (Canvas Kit sheets are
    // Messenger-only, so the canvas mints a 15-min personal link instead).
    // The page is served self-contained (inline CSS/JS, no asset routes,
    // CSP-nonced); GET consumes the single-use link token and sets the
    // HttpOnly SameSite=Strict session cookie the API authenticates with.
    this.app.get("/intercom/panel", async (req, res) => {
      if (!this.intercomPanel) {
        res.status(404).send("Not found");
        return;
      }
      if (!this.allowPanelIp(req.ip)) {
        res.status(429).set("Cache-Control", "no-store").send("Too many requests.");
        return;
      }
      const token = typeof req.query.t === "string" ? req.query.t : "";
      try {
        const result = await this.intercomPanel.page(token);
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
              "Set-Cookie": result.sessionCookie,
            })
            .send(result.html);
        } else {
          metricCount("intercom.panel_auth_failures", 1, { where: "page" });
          res.status(result.status).set({ "Cache-Control": "no-store", ...PANEL_SECURITY_HEADERS }).send(result.message);
        }
      } catch (e) {
        httpLog.error("intercom panel page failed", e);
        res.status(500).send("Internal error");
      }
    });

    this.app.post(
      "/intercom/panel/api/:endpoint",
      express.json({ limit: "256kb" }),
      async (req, res) => {
        if (!this.intercomPanel) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (!this.allowPanelIp(req.ip)) {
          res.status(429).set("Cache-Control", "no-store").json({ error: "rate limited" });
          return;
        }
        // CSRF belts on top of SameSite=Strict. (1) Custom header: cross-site
        // forms can't send one without a CORS preflight, which nothing here
        // answers. (2) Sec-Fetch-Site, when the browser provides it, must be
        // same-origin. (3) An Origin header, when present, must match the
        // request host.
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
          httpLog.warn("intercom panel api cross-origin rejected", {
            "panel.endpoint": String(req.params.endpoint),
            "http.sec_fetch_site": secFetchSite ?? "",
            "http.origin": origin ?? "",
          });
          metricCount("intercom.panel_auth_failures", 1, { where: "csrf" });
          res.status(403).set({ "Cache-Control": "no-store", ...PANEL_SECURITY_HEADERS }).json({ error: "forbidden" });
          return;
        }
        const sessionId = parseCookies(req.headers.cookie)["__Host-icpanel"] ?? "";
        try {
          const result = await this.intercomPanel.api(String(req.params.endpoint), sessionId, req.body);
          if (result.status === 401) metricCount("intercom.panel_auth_failures", 1, { where: "api" });
          res.status(result.status).set({ "Cache-Control": "no-store", ...PANEL_SECURITY_HEADERS }).json(result.json);
        } catch (e) {
          httpLog.error("intercom panel api failed", e, { "panel.endpoint": String(req.params.endpoint) });
          res.status(500).json({ error: "internal" });
        }
      }
    );

    // Admin web panel (/config + /intercom). Same belts as the Stripe panel:
    // single-use link token → HttpOnly __Host-acpanel cookie on GET; the API is
    // cookie-authed with CSRF checks. The page is served locked and unlocks only
    // after the Discord-side passcode confirm (handled inside the route object).
    this.app.get("/admin/panel", async (req, res) => {
      if (!this.adminPanel) {
        res.status(404).send("Not found");
        return;
      }
      if (!this.allowPanelIp(req.ip)) {
        res.status(429).set("Cache-Control", "no-store").send("Too many requests.");
        return;
      }
      const token = typeof req.query.t === "string" ? req.query.t : "";
      try {
        const result = await this.adminPanel.page(token);
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
              "Set-Cookie": result.sessionCookie,
            })
            .send(result.html);
        } else {
          metricCount("adminpanel.auth_failures", 1, { where: "page" });
          res.status(result.status).set({ "Cache-Control": "no-store", ...PANEL_SECURITY_HEADERS }).send(result.message);
        }
      } catch (e) {
        httpLog.error("admin panel page failed", e);
        res.status(500).send("Internal error");
      }
    });

    this.app.post("/admin/panel/api/:endpoint", express.json({ limit: "256kb" }), async (req, res) => {
      if (!this.adminPanel) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (!this.allowPanelIp(req.ip)) {
        res.status(429).set("Cache-Control", "no-store").json({ error: "rate limited" });
        return;
      }
      // CSRF belts on top of SameSite=Strict — identical to the Stripe panel API.
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
        metricCount("adminpanel.auth_failures", 1, { where: "csrf" });
        res.status(403).set({ "Cache-Control": "no-store", ...PANEL_SECURITY_HEADERS }).json({ error: "forbidden" });
        return;
      }
      const sessionId = parseCookies(req.headers.cookie)["__Host-acpanel"] ?? "";
      try {
        const result = await this.adminPanel.api(String(req.params.endpoint), sessionId, req.body);
        res.status(result.status).set({ "Cache-Control": "no-store", ...PANEL_SECURITY_HEADERS }).json(result.json);
      } catch (e) {
        httpLog.error("admin panel api failed", e, { "adminpanel.endpoint": String(req.params.endpoint) });
        res.status(500).json({ error: "internal" });
      }
    });

    // Stripe webhook. Stripe signs with `Stripe-Signature` over the RAW body;
    // constructEvent verifies it with the endpoint's signing secret. We 200 fast
    // and process best-effort so a slow handler can't make Stripe retry (the
    // event-id dedup ledger also drops any redelivery). Raw body via the same
    // verify hook the Intercom route uses.
    this.app.head("/stripe/webhook", (_req, res) => {
      res.sendStatus(200);
    });
    this.app.post(
      "/stripe/webhook",
      express.json({
        limit: "1mb",
        verify: (req, _res, buf) => {
          (req as RawBodyRequest).rawBody = buf;
        },
      }),
      async (req, res) => {
        const secret = this.stripeWebhook?.getSecret();
        const signature = req.header("stripe-signature");
        const raw = (req as RawBodyRequest).rawBody;
        if (!this.stripeWebhook || !secret || !signature || !raw) {
          res.status(400).send("Bad Request");
          return;
        }
        let event: Stripe.Event;
        try {
          event = this.stripeWebhook.constructEvent(raw, signature, secret);
        } catch {
          metricCount("stripe.webhooks", 1, { accepted: false });
          res.status(400).send("Invalid signature");
          return;
        }
        metricCount("stripe.webhooks", 1, { accepted: true });
        // Awaited: the Temporal seam needs to answer 503 when it could only
        // buffer the event (server unreachable) so Stripe redelivers. The
        // legacy handler is quick (dedup claim + at most two embed sends) and
        // still fits Stripe's ack window; its own errors stay swallowed → 200.
        try {
          await this.stripeWebhook.handle(event);
          res.status(200).send("ok");
        } catch (e) {
          if (e instanceof TemporalBufferedError) {
            res.status(503).send("retry later");
            return;
          }
          httpLog.error("stripe webhook handle failed", e, { "stripe.event_type": event.type });
          res.status(200).send("ok");
        }
      }
    );

    // Last middleware: reports unhandled route errors to Sentry (Express 5
    // forwards rejected async handlers here automatically). The route-level
    // try/catches above still own the HTTP response shape.
    Sentry.setupExpressErrorHandler(this.app);
  }

  private allowPanelIp(ip: string | undefined): boolean {
    const key = ip ?? "unknown";
    const now = Date.now();
    if (this.panelIpHits.size > PANEL_IP_MAX_KEYS) this.panelIpHits.clear(); // crude cap — throttle state, not audit data
    const hits = (this.panelIpHits.get(key) ?? []).filter((t) => now - t < PANEL_IP_WINDOW_MS);
    if (hits.length >= PANEL_IP_LIMIT_PER_MIN) {
      this.panelIpHits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.panelIpHits.set(key, hits);
    return true;
  }

  start(): void {
    this.app.listen(this.config.server.port, () => {
      httpLog.info("callback server listening", { "server.port": this.config.server.port });
    });
  }
}

// Minimal cookie parse (no dependency): "a=b; c=d" → { a: "b", c: "d" }.
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// Constant-time comparison over hashes so differing lengths don't throw.
function signatureMatches(raw: Buffer, secret: string, header: string): boolean {
  const expected = `sha1=${createHmac("sha1", secret).update(raw).digest("hex")}`;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Canvas Kit signs with plain hex HMAC-SHA256 (no prefix) in X-Body-Signature.
function canvasSignatureMatches(raw: Buffer, secret: string, header: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = createHash("sha256").update(header.trim().toLowerCase()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
