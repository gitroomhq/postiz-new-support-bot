import express, { type Express } from "express";
import { BotConfig } from "../config";
import { OAuthManager } from "../auth/OAuthManager";
import { Client } from "discord.js";

export class CallbackServer {
  private app: Express;

  constructor(
    private config: BotConfig,
    private oauthManager: OAuthManager,
    private discordClient: Client,
    private onAuthSuccess?: (discordUserId: string) => Promise<void>
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
        const { discordUserId, channelId } = await this.oauthManager.handleCallback(
          code as string,
          state as string
        );

        res.send("Successfully authenticated! You can close this window and return to Discord.");

        try {
          if (this.onAuthSuccess) {
            await this.onAuthSuccess(discordUserId);
          }
        } catch {
          // User may have DMs disabled — that's fine, they'll see it works when they click a button
        }
      } catch (err) {
        console.error("OAuth callback error:", err);
        res.status(500).send("Authentication failed. Please try again.");
      }
    });

    this.app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });
  }

  start(): void {
    this.app.listen(this.config.server.port, () => {
      console.log(`OAuth callback server listening on port ${this.config.server.port}`);
    });
  }
}
