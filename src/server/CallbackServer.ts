import express, { type Express } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { BotConfig } from "../config";
import { OAuthManager } from "../auth/OAuthManager";

// Inbound Chatwoot webhook wiring. The secret lives in BotSettings (editable via
// /config), so it's read per request through the getter.
export interface ChatwootWebhookRoute {
  getSecret: () => string | null;
  handle: (body: unknown) => Promise<void>;
}

export class CallbackServer {
  private app: Express;

  constructor(
    private config: BotConfig,
    private oauthManager: OAuthManager,
    private onAuthSuccess?: (discordUserId: string, interactionToken: string | null) => Promise<void>,
    private chatwootWebhook?: ChatwootWebhookRoute
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

    // Chatwoot has no webhook HMAC — authentication is a shared secret in the URL
    // (…/chatwoot/webhook?secret=…). Answer 200 immediately and process async:
    // Chatwoot doesn't retry reliably, and a slow handler must not block it.
    // express.json() is route-scoped so the OAuth /callback stays untouched.
    this.app.post("/chatwoot/webhook", express.json({ limit: "2mb" }), (req, res) => {
      const expected = this.chatwootWebhook?.getSecret();
      const provided = req.query.secret;
      if (!this.chatwootWebhook || !expected || typeof provided !== "string" || !secretsMatch(provided, expected)) {
        res.status(403).send("Forbidden");
        return;
      }
      res.status(200).send("ok");
      void this.chatwootWebhook.handle(req.body).catch((e) => console.error("Chatwoot webhook error:", e));
    });
  }

  start(): void {
    this.app.listen(this.config.server.port, () => {
      console.log(`OAuth callback server listening on port ${this.config.server.port}`);
    });
  }
}

// Constant-time comparison over hashes so differing lengths don't throw.
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
