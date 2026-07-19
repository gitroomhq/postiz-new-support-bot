import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Server-side session store for the Stripe panel: the single-use link token is
// exchanged for one of these (id delivered as an HttpOnly SameSite=Strict
// __Host- cookie), so no credential ever lives in a URL or in page JS.
// In-memory by design (single-process bot): a restart just means reopening the
// panel from the Intercom conversation.
//
// Sessions now start LOCKED with an activation code shown on the web page;
// the teammate confirms that code back in the Intercom canvas ("Unlock panel")
// to flip it ACTIVE — the same web→origin passcode binding the admin panel uses.

export type PanelSessionState = "locked" | "active";

export interface PanelSession {
  aid: string;
  an: string;
  cid: string;
  epoch: number; // panelTokenEpoch at creation — revocation lever
  state: PanelSessionState;
  activationCode: string; // shown on the locked page; confirmed in the canvas
  codeAttempts: number;
  createdAt: number;
  lastSeenAt: number;
}

const IDLE_TTL_MS = 10 * 60 * 1000; // sliding
const ABSOLUTE_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 500;
const JTI_RETENTION_MS = 20 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class PanelSessions {
  private sessions = new Map<string, PanelSession>();
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
  create(input: { aid: string; an: string; cid: string; epoch: number }): { sessionId: string; activationCode: string } {
    this.prune();
    // Insertion-ordered Map → evict-oldest at the cap.
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    const now = Date.now();
    const activationCode = newCode();
    this.sessions.set(id, { ...input, state: "locked", activationCode, codeAttempts: 0, createdAt: now, lastSeenAt: now });
    return { sessionId: id, activationCode };
  }

  // null = missing/expired/revoked. Returns LOCKED sessions too (the web poll
  // reads activation state). Sliding idle TTL + absolute cap; epoch mismatch
  // (Revoke Stripe Panel Links) kills the session immediately.
  get(id: string, currentEpoch: number): PanelSession | null {
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

  // Canvas "Unlock panel": flip the LOCKED session for this teammate whose code
  // matches to ACTIVE. Constant-time compare; ≥5 misses kills it.
  activate(aid: string, code: string, currentEpoch: number): boolean {
    for (const [id, s] of this.sessions) {
      if (s.aid !== aid || s.state !== "locked") continue;
      if (s.epoch !== currentEpoch || Date.now() - s.createdAt > ABSOLUTE_TTL_MS) {
        this.sessions.delete(id);
        continue;
      }
      if (ctEqual(code, s.activationCode)) {
        s.state = "active";
        s.lastSeenAt = Date.now();
        return true;
      }
      s.codeAttempts += 1;
      if (s.codeAttempts >= MAX_CODE_ATTEMPTS) this.sessions.delete(id);
    }
    return false;
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

function newCode(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CROCKFORD[bytes[i] & 31];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function ctEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
