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
import { mountPanel, type MountedPanelRoute } from "./panelMount";

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
// cookie. The transport belts (per-IP throttle, security headers with a
// per-response CSP nonce, CSRF checks) live in panelMount.ts, shared by all
// tokenized panels.
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

// Stripe dashboard (account-wide, standing web surface). Same transport
// contract; page() additionally receives the session cookie so a standing
// session can resume without a fresh link token.
export type DashboardRoute = MountedPanelRoute;

type RawBodyRequest = Request & { rawBody?: Buffer };

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
    private adminPanel?: AdminPanelRoute,
    private dashboard?: DashboardRoute
  ) {
    this.app = express();
    // req.ip drives the panel per-IP throttle. Without this, req.ip is the
    // socket peer — behind a reverse proxy that is the proxy, collapsing the
    // throttle into one global bucket. Trust only proxies on loopback/private
    // ranges (a same-host or in-VPC LB): a public client's X-Forwarded-For is
    // never trusted (their source IP isn't in the set), so req.ip can't be
    // spoofed in either topology.
    this.app.set("trust proxy", "loopback, linklocal, uniquelocal");
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

    // Tokenized web panels — shared transport belt (panelMount.ts): per-IP
    // pre-auth throttle, CSP-nonced security headers, CSRF triple belt,
    // cookie-authed API. Panel semantics live in the mounted route objects.
    const allowIp = (ip: string | undefined) => this.allowPanelIp(ip);
    // Stripe panel: a tokenized standalone page (Canvas Kit sheets are
    // Messenger-only, so the canvas mints a 15-min personal link instead).
    mountPanel(this.app, allowIp, {
      pagePath: "/intercom/panel",
      apiPath: "/intercom/panel/api/:endpoint",
      cookieName: "__Host-icpanel",
      metricName: "intercom.panel_auth_failures",
      logLabel: "intercom panel",
      route: () => this.intercomPanel,
    });
    // Admin web panel (/config + /intercom): served locked, unlocks only after
    // the Discord-side passcode confirm (handled inside the route object).
    mountPanel(this.app, allowIp, {
      pagePath: "/admin/panel",
      apiPath: "/admin/panel/api/:endpoint",
      cookieName: "__Host-acpanel",
      metricName: "adminpanel.auth_failures",
      logLabel: "admin panel",
      route: () => this.adminPanel,
    });
    // Billing dashboard (account-wide standing surface). Lives at /billing —
    // it is the BILLING dashboard, not "the" bot dashboard (user decision).
    mountPanel(this.app, allowIp, {
      pagePath: "/billing",
      apiPath: "/billing/api/:endpoint",
      cookieName: "__Host-billing",
      metricName: "dashboard.auth_failures",
      logLabel: "billing dashboard",
      route: () => this.dashboard,
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
