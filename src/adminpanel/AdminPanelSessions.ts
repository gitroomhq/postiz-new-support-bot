import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AdminPanelGroup } from "./AdminPanelTokens";

// Server-side session store for the admin web panel. The single-use link token
// is exchanged (GET /admin/panel) for one of these, whose id is delivered as an
// HttpOnly SameSite=Strict __Host- cookie — no credential ever lives in a URL
// or in page JS. In-memory by design (single-process bot, same as PanelSessions);
// a restart just means re-running /config.
//
// This adds the PASSCODE handshake the Stripe panel doesn't have:
//  - A session is created LOCKED with an activation code shown on the web page.
//    The admin types that code back in Discord ([Activate session] modal) to
//    flip it ACTIVE (web→Discord binding). A leaked link is useless without the
//    Discord confirm.
//  - Destructive actions additionally require a fresh, per-action reverse code
//    issued in Discord ([Show destructive-action code]) and typed into the web
//    page (Discord→web binding) — "force both".

export type AdminSessionState = "locked" | "active";

export interface AdminSession {
  discordUserId: string;
  guildId: string;
  adminName: string;
  panel: AdminPanelGroup;
  epoch: number; // adminPanelEpoch at creation — revocation lever
  state: AdminSessionState;
  activationCode: string; // shown on the locked page; typed back in Discord
  activationAttempts: number; // Discord-side wrong-code attempts
  destructiveChallenge: { code: string; issuedAt: number; attempts: number } | null;
  createdAt: number;
  lastSeenAt: number;
}

const IDLE_TTL_MS = 10 * 60 * 1000; // sliding
const ABSOLUTE_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 500;
const JTI_RETENTION_MS = 20 * 60 * 1000;
const MAX_ACTIVATION_ATTEMPTS = 5;
const DESTRUCTIVE_TTL_MS = 5 * 60 * 1000;
const MAX_DESTRUCTIVE_ATTEMPTS = 5;

// Crockford base32 (no I/L/O/U) — unambiguous when read off a screen and typed.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class AdminPanelSessions {
  private sessions = new Map<string, AdminSession>();
  private usedJtis = new Map<string, number>();

  // Single-use enforcement: true exactly once per jti. Second call = replay.
  consumeJti(jti: string): boolean {
    this.pruneJtis();
    if (this.usedJtis.has(jti)) return false;
    this.usedJtis.set(jti, Date.now());
    return true;
  }

  // Creates a LOCKED session; returns the cookie id + the activation code to
  // render on the locked page.
  create(input: {
    discordUserId: string;
    guildId: string;
    adminName: string;
    panel: AdminPanelGroup;
    epoch: number;
  }): { sessionId: string; activationCode: string } {
    this.prune();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    const now = Date.now();
    const activationCode = this.newActivationCode();
    this.sessions.set(id, {
      ...input,
      state: "locked",
      activationCode,
      activationAttempts: 0,
      destructiveChallenge: null,
      createdAt: now,
      lastSeenAt: now,
    });
    return { sessionId: id, activationCode };
  }

  // null = missing/expired/revoked. Returns LOCKED sessions too (the web poll
  // needs to read activation state). Sliding idle + absolute cap; epoch mismatch
  // (Revoke Admin Panel Links) kills it immediately.
  get(id: string, currentEpoch: number): AdminSession | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const now = Date.now();
    if (
      session.epoch !== currentEpoch ||
      now - session.lastSeenAt > IDLE_TTL_MS ||
      now - session.createdAt > ABSOLUTE_TTL_MS
    ) {
      this.sessions.delete(id);
      return null;
    }
    session.lastSeenAt = now;
    return session;
  }

  // Discord [Activate session] modal: flip the LOCKED session for this user
  // whose code matches to ACTIVE. Constant-time compare; ≥5 misses kills it.
  activate(
    userId: string,
    code: string,
    currentEpoch: number
  ): { ok: true } | { ok: false; reason: "notfound" | "locked_out" } {
    let mostRecentLocked: AdminSession | null = null;
    for (const [id, s] of this.sessions) {
      if (s.discordUserId !== userId || s.state !== "locked") continue;
      if (s.epoch !== currentEpoch || Date.now() - s.createdAt > ABSOLUTE_TTL_MS) {
        this.sessions.delete(id);
        continue;
      }
      if (ctEqual(code, s.activationCode)) {
        s.state = "active";
        s.lastSeenAt = Date.now();
        return { ok: true };
      }
      if (!mostRecentLocked || s.createdAt > mostRecentLocked.createdAt) mostRecentLocked = s;
    }
    // No code match — burn an attempt on the caller's most-recent locked session.
    if (mostRecentLocked) {
      mostRecentLocked.activationAttempts += 1;
      if (mostRecentLocked.activationAttempts >= MAX_ACTIVATION_ATTEMPTS) {
        for (const [id, s] of this.sessions) {
          if (s === mostRecentLocked) this.sessions.delete(id);
        }
        return { ok: false, reason: "locked_out" };
      }
    }
    return { ok: false, reason: "notfound" };
  }

  // Reverse-code button: the caller's most-recent ACTIVE session (so a re-run
  // /config or a dismissed ephemeral can still service an existing session).
  activeForUser(userId: string, currentEpoch: number): { id: string; session: AdminSession } | null {
    let best: { id: string; session: AdminSession } | null = null;
    for (const [id, s] of this.sessions) {
      if (s.discordUserId !== userId || s.state !== "active") continue;
      const now = Date.now();
      if (s.epoch !== currentEpoch || now - s.lastSeenAt > IDLE_TTL_MS || now - s.createdAt > ABSOLUTE_TTL_MS) {
        this.sessions.delete(id);
        continue;
      }
      if (!best || s.createdAt > best.session.createdAt) best = { id, session: s };
    }
    return best;
  }

  // Mint a fresh single-use destructive-confirmation code onto a session.
  issueDestructiveChallenge(session: AdminSession): string {
    const code = this.newNumericCode(6);
    session.destructiveChallenge = { code, issuedAt: Date.now(), attempts: 0 };
    return code;
  }

  // Verify + consume the reverse code: single-use, 5-min TTL, ≤5 attempts.
  consumeDestructiveChallenge(session: AdminSession, code: string): boolean {
    const ch = session.destructiveChallenge;
    if (!ch) return false;
    if (Date.now() - ch.issuedAt > DESTRUCTIVE_TTL_MS || ch.attempts >= MAX_DESTRUCTIVE_ATTEMPTS) {
      session.destructiveChallenge = null;
      return false;
    }
    if (ctEqual(code, ch.code)) {
      session.destructiveChallenge = null; // single-use
      return true;
    }
    ch.attempts += 1;
    if (ch.attempts >= MAX_DESTRUCTIVE_ATTEMPTS) session.destructiveChallenge = null;
    return false;
  }

  private newActivationCode(): string {
    const bytes = randomBytes(8);
    let s = "";
    for (let i = 0; i < 8; i++) s += CROCKFORD[bytes[i] & 31];
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  }

  private newNumericCode(digits: number): string {
    const bytes = randomBytes(digits);
    let s = "";
    for (let i = 0; i < digits; i++) s += String(bytes[i] % 10);
    return s;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeenAt > IDLE_TTL_MS || now - s.createdAt > ABSOLUTE_TTL_MS) this.sessions.delete(id);
    }
  }

  private pruneJtis(): void {
    const cutoff = Date.now() - JTI_RETENTION_MS;
    for (const [jti, at] of this.usedJtis) {
      if (at < cutoff) this.usedJtis.delete(jti);
    }
  }
}

// Constant-time comparison over hashes so differing lengths don't throw.
function ctEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
