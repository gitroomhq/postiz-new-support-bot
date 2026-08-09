import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DashboardSession as DbRow, PrismaClient } from "../../generated/prisma/client";

// DB-backed standing sessions for the dashboard (dashboard_sessions): survive
// deploy restarts, 7d sliding idle / 30d absolute (user-chosen), row id =
// SHA-256 hex of the cookie token so a DB dump yields nothing usable. An
// in-memory read-through cache keeps the hot path off the DB; lastSeenAt is
// written behind (≥60s between writes).

export const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const MAX_SESSIONS_PER_ADMIN = 10;
const MAX_SESSIONS_GLOBAL = 50;
const MAX_ACTIVATION_ATTEMPTS = 5;
const LOCKED_TTL_MS = 10 * 60 * 1000; // unactivated sessions die after 10 min

// Crockford base32 (no I/L/O/U).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type StandingAuthMethod = "passkey" | "totp" | "breakglass" | "yubikey";

export interface StandingSession {
  idHash: string;
  discordUserId: string;
  adminName: string;
  epoch: number;
  state: "locked" | "active";
  authMethod: StandingAuthMethod;
  activationCode: string | null;
  uaFirst: string | null;
  ipFirst: string | null;
  ipLast: string | null;
  stepUpAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class DashboardDbSessions {
  private cache = new Map<string, { row: DbRow; cachedAt: number; lastWriteAt: number }>();

  constructor(private prisma: PrismaClient) {}

  // Creates a session and returns the raw cookie token (exists only in the
  // Set-Cookie header from here on). state "locked" sessions carry an
  // activation code for the Discord ceremony; "active" sessions (trusted
  // factors: trusted passkey, yubikey) are usable immediately.
  async create(input: {
    discordUserId: string;
    adminName: string;
    epoch: number;
    state: "locked" | "active";
    authMethod: StandingAuthMethod;
    credentialIdUsed?: string | null;
    ua?: string | null;
    ip?: string | null;
  }): Promise<{ token: string; activationCode: string | null }> {
    await this.enforceCaps(input.discordUserId);
    const token = randomBytes(32).toString("base64url");
    const activationCode = input.state === "locked" ? newActivationCode() : null;
    const now = new Date();
    await this.prisma.dashboardSession.create({
      data: {
        id: hashSessionToken(token),
        discordUserId: input.discordUserId,
        adminName: input.adminName,
        epoch: input.epoch,
        state: input.state,
        authMethod: input.authMethod,
        credentialIdUsed: input.credentialIdUsed ?? null,
        activationCode,
        uaFirst: input.ua?.slice(0, 300) ?? null,
        ipFirst: input.ip?.slice(0, 60) ?? null,
        ipLast: input.ip?.slice(0, 60) ?? null,
        absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_TTL_MS),
      },
    });
    return { token, activationCode };
  }

  // null = missing/expired/revoked/epoch-mismatch (row is deleted on the way
  // out so revocation is immediate and storage stays bounded).
  async get(token: string, currentEpoch: number, meta?: { ip?: string | null }): Promise<StandingSession | null> {
    if (!token) return null;
    const idHash = hashSessionToken(token);
    const now = Date.now();

    const cached = this.cache.get(idHash);
    let row: DbRow | null;
    if (cached && now - cached.cachedAt < 5_000) {
      row = cached.row;
    } else {
      row = await this.prisma.dashboardSession.findUnique({ where: { id: idHash } });
      if (row) this.cache.set(idHash, { row, cachedAt: now, lastWriteAt: cached?.lastWriteAt ?? 0 });
    }
    if (!row || row.revokedAt) {
      this.cache.delete(idHash);
      return null;
    }
    const idleCutoff = row.state === "locked" ? LOCKED_TTL_MS : IDLE_TTL_MS;
    if (
      row.epoch !== currentEpoch ||
      now - row.lastSeenAt.getTime() > idleCutoff ||
      now > row.absoluteExpiresAt.getTime()
    ) {
      await this.delete(idHash);
      return null;
    }

    // Sliding idle: write-behind, ≥60s apart.
    const entry = this.cache.get(idHash);
    row.lastSeenAt = new Date(now);
    if (meta?.ip) row.ipLast = meta.ip.slice(0, 60);
    if (!entry || now - entry.lastWriteAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      this.cache.set(idHash, { row, cachedAt: now, lastWriteAt: now });
      await this.prisma.dashboardSession
        .update({ where: { id: idHash }, data: { lastSeenAt: row.lastSeenAt, ipLast: row.ipLast } })
        .catch(() => this.cache.delete(idHash));
    } else {
      entry.row = row;
      entry.cachedAt = now;
    }
    return toStanding(idHash, row);
  }

  // Discord [Activate session] modal — flip the caller's most recent LOCKED
  // session whose code matches. ≥5 misses kills that session.
  async activate(
    discordUserId: string,
    code: string,
    currentEpoch: number
  ): Promise<{ ok: true } | { ok: false; reason: "notfound" | "locked_out" }> {
    const rows = await this.prisma.dashboardSession.findMany({
      where: { discordUserId, state: "locked", revokedAt: null, epoch: currentEpoch },
      orderBy: { createdAt: "desc" },
    });
    const now = Date.now();
    for (const row of rows) {
      if (now - row.createdAt.getTime() > LOCKED_TTL_MS) continue;
      if (row.activationCode && ctEqual(code, row.activationCode)) {
        await this.prisma.dashboardSession.update({
          where: { id: row.id },
          data: { state: "active", activationCode: null, lastSeenAt: new Date() },
        });
        this.cache.delete(row.id);
        return { ok: true };
      }
    }
    // No match — burn an attempt on the most recent locked session.
    const newest = rows[0];
    if (newest) {
      const attempts = newest.activationAttempts + 1;
      if (attempts >= MAX_ACTIVATION_ATTEMPTS) {
        await this.delete(newest.id);
        return { ok: false, reason: "locked_out" };
      }
      await this.prisma.dashboardSession.update({ where: { id: newest.id }, data: { activationAttempts: attempts } });
    }
    return { ok: false, reason: "notfound" };
  }

  // Security page: every live session for one admin, newest first.
  async listForUser(discordUserId: string, currentEpoch: number): Promise<StandingSession[]> {
    const rows = await this.prisma.dashboardSession.findMany({
      where: { discordUserId, revokedAt: null, epoch: currentEpoch },
      orderBy: { createdAt: "desc" },
    });
    const now = Date.now();
    return rows
      .filter(
        (r) =>
          now - r.lastSeenAt.getTime() <= (r.state === "locked" ? LOCKED_TTL_MS : IDLE_TTL_MS) &&
          now <= r.absoluteExpiresAt.getTime()
      )
      .map((r) => toStanding(r.id, r));
  }

  async revokeByIdHash(discordUserId: string, idHash: string): Promise<boolean> {
    const res = await this.prisma.dashboardSession.updateMany({
      // Owner-scoped — the Security page can only revoke the caller's own sessions.
      where: { id: idHash, discordUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.cache.delete(idHash);
    return res.count > 0;
  }

  async delete(idHash: string): Promise<void> {
    this.cache.delete(idHash);
    await this.prisma.dashboardSession.deleteMany({ where: { id: idHash } });
  }

  // T2 step-up stamp (fresh factor re-assert) — valid for a short window.
  async markStepUp(idHash: string): Promise<void> {
    this.cache.delete(idHash);
    await this.prisma.dashboardSession.updateMany({ where: { id: idHash }, data: { stepUpAt: new Date() } });
  }

  // Bounded storage: evict dead rows, cap per-admin and global live sessions
  // (oldest first — the new login wins over a forgotten one).
  private async enforceCaps(discordUserId: string): Promise<void> {
    const cutoff = new Date(Date.now() - ABSOLUTE_TTL_MS);
    await this.prisma.dashboardSession.deleteMany({
      where: { OR: [{ absoluteExpiresAt: { lt: new Date() } }, { createdAt: { lt: cutoff } }, { revokedAt: { not: null } }] },
    });
    const mine = await this.prisma.dashboardSession.findMany({
      where: { discordUserId },
      orderBy: { createdAt: "asc" },
    });
    if (mine.length >= MAX_SESSIONS_PER_ADMIN) {
      const drop = mine.slice(0, mine.length - MAX_SESSIONS_PER_ADMIN + 1);
      await this.prisma.dashboardSession.deleteMany({ where: { id: { in: drop.map((r) => r.id) } } });
      for (const r of drop) this.cache.delete(r.id);
    }
    const total = await this.prisma.dashboardSession.count();
    if (total >= MAX_SESSIONS_GLOBAL) {
      const oldest = await this.prisma.dashboardSession.findMany({
        orderBy: { createdAt: "asc" },
        take: total - MAX_SESSIONS_GLOBAL + 1,
      });
      await this.prisma.dashboardSession.deleteMany({ where: { id: { in: oldest.map((r) => r.id) } } });
      for (const r of oldest) this.cache.delete(r.id);
    }
  }
}

function toStanding(idHash: string, row: DbRow): StandingSession {
  return {
    idHash,
    discordUserId: row.discordUserId,
    adminName: row.adminName,
    epoch: row.epoch,
    state: row.state === "active" ? "active" : "locked",
    authMethod: (row.authMethod as StandingAuthMethod) ?? "breakglass",
    activationCode: row.activationCode,
    uaFirst: row.uaFirst,
    ipFirst: row.ipFirst,
    ipLast: row.ipLast,
    stepUpAt: row.stepUpAt,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
  };
}

function newActivationCode(): string {
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
