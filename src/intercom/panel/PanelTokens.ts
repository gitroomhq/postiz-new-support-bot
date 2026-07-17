import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SettingsStore } from "../../config/SettingsStore";

// Short-lived SINGLE-USE link tokens for the Stripe panel page. Format:
// "v1.<base64url(JSON payload)>.<hex HMAC-SHA256>", keyed with the
// auto-generated panelTokenSecret.
//
// Security model (hardened):
//  - The link token is NOT the API credential. GET /intercom/panel exchanges
//    it exactly once (jti consumed server-side) for an HttpOnly SameSite=Strict
//    session cookie — a URL that leaked into proxy/access logs or was clicked
//    by another teammate from the stored canvas is dead after first use.
//  - Tokens and sessions embed the panelTokenEpoch; bumping it ("Revoke
//    Stripe Panel Links" in /intercom → Maintenance) invalidates everything
//    outstanding instantly.
//  - The token still authenticates IDENTITY + SCOPE only (teammate,
//    conversation) — authorization is re-read from settings on EVERY call,
//    and the Stripe customer is always re-derived server-side.
const TOKEN_TTL_MS = 15 * 60 * 1000;
const VERSION = "v1";

export interface PanelTokenPayload {
  aid: string; // Intercom admin (teammate) id
  an: string; // teammate display name (for the page banner)
  cid: string; // Intercom conversation id — the panel's scope
  jti: string; // single-use id — consumed at exchange
  epo: number; // panelTokenEpoch at mint — revocation lever
  iat: number; // ms epoch
  exp: number; // ms epoch
}

export class PanelTokens {
  constructor(private settingsStore: SettingsStore) {}

  async mint(input: { adminId: string; adminName: string; conversationId: string }): Promise<string> {
    // Panel links carry a bearer-ish secret in the URL for their one first
    // click — refuse to mint them onto plain http (localhost excepted for dev).
    const base = this.settingsStore.resolvedPublicBaseUrl();
    if (base && !base.startsWith("https://") && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(base)) {
      throw new Error("Stripe panel links require an https public base URL.");
    }
    const secret = await this.settingsStore.ensurePanelTokenSecret();
    const now = Date.now();
    const payload: PanelTokenPayload = {
      aid: input.adminId,
      an: input.adminName.slice(0, 100),
      cid: input.conversationId,
      jti: randomBytes(16).toString("base64url"),
      epo: this.settingsStore.panelTokenEpoch(),
      iat: now,
      exp: now + TOKEN_TTL_MS,
    };
    const body = `${VERSION}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const mac = createHmac("sha256", secret).update(body).digest("hex");
    return `${body}.${mac}`;
  }

  // null = invalid, expired, or revoked (epoch mismatch). Constant-time MAC
  // compare (hash-then-compare, same idiom as CallbackServer's webhook
  // verification). Single-use enforcement (jti) is the caller's job — verify
  // itself is pure.
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
      typeof payload?.jti !== "string" ||
      typeof payload?.epo !== "number" ||
      typeof payload?.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() >= payload.exp) return null;
    if (payload.epo !== this.settingsStore.panelTokenEpoch()) return null;
    return payload;
  }
}
