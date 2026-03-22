import crypto from "crypto";
import { BotConfig } from "../config";
import { SessionStore } from "./SessionStore";

export class OAuthManager {
  constructor(
    private config: BotConfig,
    private sessionStore: SessionStore
  ) {}

  async generateAuthUrl(discordUserId: string, channelId: string, interactionToken?: string): Promise<string> {
    const state = crypto.randomBytes(32).toString("hex");
    await this.sessionStore.addPendingAuth(state, discordUserId, channelId, interactionToken);

    const params = new URLSearchParams({
      client_id: this.config.postiz.clientId,
      response_type: "code",
      state,
    });

    return `${this.config.postiz.frontendUrl}/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; postizUserId?: string; stripeCustomerId?: string }> {
    const response = await fetch(`${this.config.postiz.apiUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: this.config.postiz.clientId,
        client_secret: this.config.postiz.clientSecret,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Token exchange failed: ${(error as any).error || response.statusText}`);
    }

    const data = (await response.json()) as { access_token: string; id?: string; cus?: string };
    return { accessToken: data.access_token, postizUserId: data.id, stripeCustomerId: data.cus };
  }

  async handleCallback(code: string, state: string): Promise<{ discordUserId: string; channelId: string; interactionToken: string | null }> {
    const pending = await this.sessionStore.consumePendingAuth(state);
    if (!pending) {
      throw new Error("Invalid or expired state parameter");
    }

    const { accessToken, postizUserId, stripeCustomerId } = await this.exchangeCode(code);
    await this.sessionStore.setSession(pending.discordUserId, accessToken, postizUserId, stripeCustomerId);

    return { discordUserId: pending.discordUserId, channelId: pending.channelId, interactionToken: pending.interactionToken };
  }
}
