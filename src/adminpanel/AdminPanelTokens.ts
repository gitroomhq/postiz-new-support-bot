import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SettingsStore } from "../config/SettingsStore";

// Short-lived SINGLE-USE link tokens for the admin web panel (/config +
// /intercom). Format: "a1.<base64url(JSON payload)>.<hex HMAC-SHA256>", signed
// with the same auto-generated panelTokenSecret the Stripe panel uses.
//
// The VERSION tag ("a1" vs the Stripe panel's "v1") DOMAIN-SEPARATES the two
// token families even though they share an HMAC key: a Stripe-panel token can
// never verify here and vice versa, because the version byte is inside the
// MAC'd body.
//
// Security model (mirrors PanelTokens):
//  - The link token is NOT the API credential. GET /admin/panel exchanges it
//    exactly once (jti consumed server-side) for an HttpOnly SameSite=Strict
//    session cookie — a leaked URL is dead after first use.
//  - Tokens + sessions embed adminPanelEpoch; bumping it ("Revoke Admin Panel
//    Links") invalidates everything outstanding instantly, independently of the
//    Stripe-panel epoch.
//  - The token authenticates IDENTITY + SCOPE only (Discord admin + guild +
//    landing hub). adm:true is stamped because ONLY Discord Administrators can
//    mint one (the slash command re-checks). No per-request Discord re-check.
const TOKEN_TTL_MS = 15 * 60 * 1000;
const VERSION = "a1";

export type AdminPanelGroup = "config" | "intercom";

export interface AdminPanelTokenPayload {
  sub: string; // Discord user id (the admin who ran /config or /intercom)
  gid: string; // Discord guild id — scope for channel/role pickers
  an: string; // admin display name (page banner)
  panel: AdminPanelGroup; // landing hub group
  adm: true; // admin-at-mint (only admins can run the command)
  jti: string; // single-use id — consumed at exchange; also the pending correlation id
  epo: number; // adminPanelEpoch at mint — revocation lever
  iat: number; // ms epoch
  exp: number; // ms epoch
}

export class AdminPanelTokens {
  constructor(private settingsStore: SettingsStore) {}

  async mint(input: { userId: string; guildId: string; adminName: string; panel: AdminPanelGroup }): Promise<string> {
    // The link carries a bearer-ish secret in the URL for its one first click —
    // refuse to mint onto plain http (localhost excepted for dev).
    const base = this.settingsStore.resolvedPublicBaseUrl();
    if (base && !base.startsWith("https://") && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(base)) {
      throw new Error("Admin panel links require an https public base URL.");
    }
    const secret = await this.settingsStore.ensurePanelTokenSecret();
    const now = Date.now();
    const payload: AdminPanelTokenPayload = {
      sub: input.userId,
      gid: input.guildId,
      an: input.adminName.slice(0, 100),
      panel: input.panel,
      adm: true,
      jti: randomBytes(16).toString("base64url"),
      epo: this.settingsStore.adminPanelEpoch(),
      iat: now,
      exp: now + TOKEN_TTL_MS,
    };
    const body = `${VERSION}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const mac = createHmac("sha256", secret).update(body).digest("hex");
    return `${body}.${mac}`;
  }

  // null = invalid, expired, or revoked (epoch mismatch). Constant-time MAC
  // compare (hash-then-compare). Single-use enforcement (jti) is the caller's
  // job — verify itself is pure.
  verify(token: string): AdminPanelTokenPayload | null {
    const secret = this.settingsStore.panelTokenSecret();
    if (!secret || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== VERSION) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const a = createHash("sha256").update(parts[2]).digest();
    const b = createHash("sha256").update(expected).digest();
    if (!timingSafeEqual(a, b)) return null;
    let payload: AdminPanelTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as AdminPanelTokenPayload;
    } catch {
      return null;
    }
    if (
      typeof payload?.sub !== "string" ||
      typeof payload?.gid !== "string" ||
      typeof payload?.an !== "string" ||
      (payload?.panel !== "config" && payload?.panel !== "intercom") ||
      typeof payload?.jti !== "string" ||
      typeof payload?.epo !== "number" ||
      typeof payload?.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() >= payload.exp) return null;
    if (payload.epo !== this.settingsStore.adminPanelEpoch()) return null;
    return payload;
  }
}
