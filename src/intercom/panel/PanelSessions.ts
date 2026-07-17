import { randomBytes } from "node:crypto";

// Server-side session store for the Stripe panel: the single-use link token
// is exchanged for one of these (id delivered as an HttpOnly SameSite=Strict
// __Host- cookie), so no credential ever lives in a URL or in page JS.
// In-memory by design (single-process bot): a restart just means reopening
// the panel from the Intercom conversation.

export interface PanelSession {
  aid: string;
  an: string;
  cid: string;
  epoch: number; // panelTokenEpoch at creation — revocation lever
  createdAt: number;
  lastSeenAt: number;
}

const IDLE_TTL_MS = 10 * 60 * 1000; // sliding
const ABSOLUTE_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 500;
// Used-jti entries only need to outlive the token TTL (15 min) — kept a bit
// longer to be safe against clock skew.
const JTI_RETENTION_MS = 20 * 60 * 1000;

export class PanelSessions {
  private sessions = new Map<string, PanelSession>();
  private usedJtis = new Map<string, number>();

  // Single-use enforcement: true exactly once per jti. Second call = replay
  // (stored canvas link clicked again, or a URL recovered from logs).
  consumeJti(jti: string): boolean {
    this.pruneJtis();
    if (this.usedJtis.has(jti)) return false;
    this.usedJtis.set(jti, Date.now());
    return true;
  }

  create(input: { aid: string; an: string; cid: string; epoch: number }): string {
    this.prune();
    // Insertion-ordered Map → evict-oldest at the cap.
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.sessions.set(id, { ...input, createdAt: now, lastSeenAt: now });
    return id;
  }

  // null = missing/expired/revoked. Sliding idle TTL + absolute cap; epoch
  // mismatch (Revoke Stripe Panel Links) kills the session immediately.
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
