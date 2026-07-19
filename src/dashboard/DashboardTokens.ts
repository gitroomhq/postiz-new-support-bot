import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SettingsStore } from "../config/SettingsStore";

// Short-lived SINGLE-USE link tokens for the Stripe dashboard (/billing).
// Format: "d1.<base64url(JSON payload)>.<hex HMAC-SHA256>".
//
// Unlike the Stripe/admin panels (which share panelTokenSecret and rely on the
// version tag for domain separation), the dashboard signs with its OWN
// dashboardTokenSecret: d1 tokens will later include ENROLL links — the one
// token class whose forgery could plant an attacker credential — so the secret
// gets an independent blast radius and rotation lever (clear the column →
// auto re-seed).
//
// Security model (mirrors AdminPanelTokens):
//  - The link token is NOT the API credential. GET /billing exchanges it
//    exactly once (jti consumed server-side) for an HttpOnly session cookie.
//  - Tokens + sessions embed dashboardEpoch; bumping it ("Revoke dashboard
//    links" / LOCKDOWN) invalidates everything outstanding instantly.
//  - The token authenticates IDENTITY only; the dashboard allowlist + role is
//    re-checked per request (never stamped into the token).
const TOKEN_TTL_MS = 15 * 60 * 1000;
const VERSION = "d1";

// "open" = break-glass panel link; "enroll" = credential-enrollment link
// for operators without the Discord Administrator bit. Both live in the
// MAC'd body so one can never verify as the other.
export type DashboardTokenKind = "open" | "enroll";

export interface DashboardTokenPayload {
  k: DashboardTokenKind;
  sub: string; // Discord user id
  an: string; // display name (page banner)
  jti: string; // single-use id — consumed at exchange
  epo: number; // dashboardEpoch at mint — revocation lever
  iat: number; // ms epoch
  exp: number; // ms epoch
}

export class DashboardTokens {
  constructor(private settingsStore: SettingsStore) {}

  async mint(input: { kind: DashboardTokenKind; userId: string; adminName: string }): Promise<string> {
    // The link carries a bearer-ish secret in the URL for its one first click —
    // refuse to mint onto plain http (localhost excepted for dev).
    const base = this.settingsStore.resolvedPublicBaseUrl();
    if (base && !base.startsWith("https://") && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(base)) {
      throw new Error("Dashboard links require an https public base URL.");
    }
    const secret = await this.settingsStore.ensureDashboardTokenSecret();
    const now = Date.now();
    const payload: DashboardTokenPayload = {
      k: input.kind,
      sub: input.userId,
      an: input.adminName.slice(0, 100),
      jti: randomBytes(16).toString("base64url"),
      epo: this.settingsStore.dashboardEpoch(),
      iat: now,
      exp: now + TOKEN_TTL_MS,
    };
    const body = `${VERSION}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const mac = createHmac("sha256", secret).update(body).digest("hex");
    return `${body}.${mac}`;
  }

  // null = invalid, expired, revoked (epoch mismatch) or the wrong kind.
  // Constant-time MAC compare (hash-then-compare). Single-use enforcement
  // (jti) is the caller's job — verify itself is pure.
  verify(token: string, expectKind: DashboardTokenKind): DashboardTokenPayload | null {
    const secret = this.settingsStore.dashboardTokenSecret();
    if (!secret || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== VERSION) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const a = createHash("sha256").update(parts[2]).digest();
    const b = createHash("sha256").update(expected).digest();
    if (!timingSafeEqual(a, b)) return null;
    let payload: DashboardTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as DashboardTokenPayload;
    } catch {
      return null;
    }
    if (
      payload?.k !== expectKind ||
      typeof payload?.sub !== "string" ||
      typeof payload?.an !== "string" ||
      typeof payload?.jti !== "string" ||
      typeof payload?.epo !== "number" ||
      typeof payload?.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() >= payload.exp) return null;
    if (payload.epo !== this.settingsStore.dashboardEpoch()) return null;
    return payload;
  }
}
