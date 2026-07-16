import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SettingsStore } from "../../config/SettingsStore";

// Short-lived bearer tokens for the Stripe panel page and its JSON API.
// Format: "v1.<base64url(JSON payload)>.<hex HMAC-SHA256>", keyed with the
// auto-generated panelTokenSecret. The token authenticates IDENTITY + SCOPE
// only (which Intercom teammate, which conversation) — authorization (admin
// bit, per-action level) is re-read from settings on EVERY call, and the
// Stripe customer is always re-derived server-side from the conversation.
const TOKEN_TTL_MS = 15 * 60 * 1000;
const VERSION = "v1";

export interface PanelTokenPayload {
  aid: string; // Intercom admin (teammate) id
  an: string; // teammate display name (for the page banner)
  cid: string; // Intercom conversation id — the panel's scope
  iat: number; // ms epoch
  exp: number; // ms epoch
}

export class PanelTokens {
  constructor(private settingsStore: SettingsStore) {}

  async mint(input: { adminId: string; adminName: string; conversationId: string }): Promise<string> {
    const secret = await this.settingsStore.ensurePanelTokenSecret();
    const now = Date.now();
    const payload: PanelTokenPayload = {
      aid: input.adminId,
      an: input.adminName.slice(0, 100),
      cid: input.conversationId,
      iat: now,
      exp: now + TOKEN_TTL_MS,
    };
    const body = `${VERSION}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const mac = createHmac("sha256", secret).update(body).digest("hex");
    return `${body}.${mac}`;
  }

  // null = invalid or expired. Constant-time MAC compare (hash-then-compare,
  // same idiom as CallbackServer's webhook verification).
  verify(token: string): PanelTokenPayload | null {
    const secret = this.settingsStore.panelTokenSecret();
    if (!secret || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== VERSION) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const a = createHash("sha256").update(parts[2]).digest();
    const b = createHash("sha256").update(expected).digest();
    if (!timingSafeEqual(a, b)) return null;
    let payload: PanelTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as PanelTokenPayload;
    } catch {
      return null;
    }
    if (
      typeof payload?.aid !== "string" ||
      typeof payload?.an !== "string" ||
      typeof payload?.cid !== "string" ||
      typeof payload?.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() >= payload.exp) return null;
    return payload;
  }
}
