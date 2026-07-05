import express, { type Express, type Request } from "express";
import * as Sentry from "@sentry/node";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BotConfig } from "../config";
import { OAuthManager } from "../auth/OAuthManager";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";

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

type RawBodyRequest = Request & { rawBody?: Buffer };

export class CallbackServer {
  private app: Express;

  constructor(
    private config: BotConfig,
    private oauthManager: OAuthManager,
    private onAuthSuccess?: (discordUserId: string, interactionToken: string | null) => Promise<void>,
    private intercomWebhook?: IntercomWebhookRoute,
    private intercomCanvas?: IntercomCanvasRoute
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
          res.status(403).send("Forbidden");
          return;
        }
        try {
          const accepted = await this.intercomWebhook.accept(req.body);
          httpLog.info("intercom.webhook.received", { "webhook.topic": topic, "webhook.accepted": accepted });
          metricCount("intercom.webhooks", 1, { topic, accepted: true });
          res.status(200).send("ok");
        } catch (e) {
          httpLog.error("intercom webhook enqueue failed", e, { "webhook.topic": topic });
          metricCount("intercom.webhooks", 1, { topic, accepted: false });
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

    // Last middleware: reports unhandled route errors to Sentry (Express 5
    // forwards rejected async handlers here automatically). The route-level
    // try/catches above still own the HTTP response shape.
    Sentry.setupExpressErrorHandler(this.app);
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
