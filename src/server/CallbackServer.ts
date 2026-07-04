import express, { type Express, type Request } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BotConfig } from "../config";
import { OAuthManager } from "../auth/OAuthManager";

// Inbound Intercom webhook wiring. The client secret lives in BotSettings
// (editable via /config), so it's read per request through the getter.
export interface IntercomWebhookRoute {
  getClientSecret: () => string | null;
  handle: (body: unknown) => Promise<void>;
}

type RawBodyRequest = Request & { rawBody?: Buffer };

export class CallbackServer {
  private app: Express;

  constructor(
    private config: BotConfig,
    private oauthManager: OAuthManager,
    private onAuthSuccess?: (discordUserId: string, interactionToken: string | null) => Promise<void>,
    private intercomWebhook?: IntercomWebhookRoute
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

        try {
          if (this.onAuthSuccess) {
            await this.onAuthSuccess(discordUserId, interactionToken);
          }
        } catch {
          // Interaction token may have expired — that's fine, they'll see it works when they click Start Here again
        }
      } catch (err) {
        console.error("OAuth callback error:", err);
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
    // OAuth /callback stays untouched). Answer 200 inside Intercom's 5s window
    // and process async — it retries only once, and a 429/410 response
    // throttles or disables the subscription.
    this.app.post(
      "/intercom/webhook",
      express.json({
        limit: "2mb",
        verify: (req, _res, buf) => {
          (req as RawBodyRequest).rawBody = buf;
        },
      }),
      (req, res) => {
        const secret = this.intercomWebhook?.getClientSecret();
        const signature = req.header("x-hub-signature");
        const raw = (req as RawBodyRequest).rawBody;
        if (!this.intercomWebhook || !secret || !signature || !raw || !signatureMatches(raw, secret, signature)) {
          res.status(403).send("Forbidden");
          return;
        }
        res.status(200).send("ok");
        void this.intercomWebhook.handle(req.body).catch((e) => console.error("Intercom webhook error:", e));
      }
    );
  }

  start(): void {
    this.app.listen(this.config.server.port, () => {
      console.log(`OAuth callback server listening on port ${this.config.server.port}`);
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
