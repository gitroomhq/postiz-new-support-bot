import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, SupportSession as DbRow } from "../generated/prisma/client";

// DB-backed support dashboard sign-ins (support_sessions), the queue_sessions
// pattern: survive deploys, 7d sliding idle / 30d absolute, row id = SHA-256
// hex of the cookie token so a DB dump yields nothing usable. A short
// read-through cache keeps the hot path off the DB; lastSeenAt is written
// behind (at least 60s apart).

export const SUPPORT_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SUPPORT_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const MAX_SESSIONS_PER_USER = 10;
const MAX_SESSIONS_GLOBAL = 300;

export interface SupportSessionView {
  idHash: string;
  discordUserId: string;
  name: string;
  lastVerifiedAt: Date;
  createdAt: Date;
}

export function hashSupportToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SupportSessionDb = Pick<PrismaClient, "supportSession">;

export class SupportSessions {
  private cache = new Map<string, { row: DbRow; cachedAt: number; lastWriteAt: number }>();

  constructor(
    private prisma: SupportSessionDb,
    private now: () => number = Date.now
  ) {}

  // Returns the raw cookie token (it exists only in the Set-Cookie header from
  // here on).
  async create(input: { discordUserId: string; name: string; epoch: number; ip?: string | null; ua?: string | null }): Promise<string> {
    await this.enforceCaps(input.discordUserId);
    const token = randomBytes(32).toString("base64url");
    const now = new Date(this.now());
    await this.prisma.supportSession.create({
      data: {
        id: hashSupportToken(token),
        discordUserId: input.discordUserId,
        name: input.name.slice(0, 200),
        epoch: input.epoch,
        uaFirst: input.ua?.slice(0, 300) ?? null,
        ipFirst: input.ip?.slice(0, 60) ?? null,
        ipLast: input.ip?.slice(0, 60) ?? null,
        createdAt: now,
        lastSeenAt: now,
        lastVerifiedAt: now,
        absoluteExpiresAt: new Date(now.getTime() + SUPPORT_ABSOLUTE_TTL_MS),
      },
    });
    return token;
  }

  // null = missing, expired or signed out by an epoch bump (the row is deleted
  // on the way out so revocation is immediate and storage stays bounded).
  async get(token: string, currentEpoch: number, meta?: { ip?: string | null }): Promise<SupportSessionView | null> {
    if (!token || token.length > 200) return null;
    const idHash = hashSupportToken(token);
    const now = this.now();
    const cached = this.cache.get(idHash);
    let row: DbRow | null;
    if (cached && now - cached.cachedAt < 5_000) {
      row = cached.row;
    } else {
      row = await this.prisma.supportSession.findUnique({ where: { id: idHash } });
      if (row) this.cache.set(idHash, { row, cachedAt: now, lastWriteAt: cached?.lastWriteAt ?? 0 });
    }
    if (!row) {
      this.cache.delete(idHash);
      return null;
    }
    if (row.epoch !== currentEpoch || now - row.lastSeenAt.getTime() > SUPPORT_IDLE_TTL_MS || now > row.absoluteExpiresAt.getTime()) {
      await this.delete(idHash);
      return null;
    }
    const entry = this.cache.get(idHash);
    row.lastSeenAt = new Date(now);
    if (meta?.ip) row.ipLast = meta.ip.slice(0, 60);
    if (!entry || now - entry.lastWriteAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      this.cache.set(idHash, { row, cachedAt: now, lastWriteAt: now });
      await this.prisma.supportSession
        .update({ where: { id: idHash }, data: { lastSeenAt: row.lastSeenAt, ipLast: row.ipLast } })
        .catch(() => this.cache.delete(idHash));
    } else {
      entry.row = row;
      entry.cachedAt = now;
    }
    return { idHash, discordUserId: row.discordUserId, name: row.name, lastVerifiedAt: row.lastVerifiedAt, createdAt: row.createdAt };
  }

  // The teammate was confirmed again (still in the server, still staff).
  async markVerified(idHash: string, name: string): Promise<void> {
    const at = new Date(this.now());
    const entry = this.cache.get(idHash);
    if (entry) {
      entry.row.lastVerifiedAt = at;
      entry.row.name = name.slice(0, 200);
    }
    await this.prisma.supportSession
      .updateMany({ where: { id: idHash }, data: { lastVerifiedAt: at, name: name.slice(0, 200) } })
      .catch(() => this.cache.delete(idHash));
  }

  async delete(idHash: string): Promise<void> {
    this.cache.delete(idHash);
    await this.prisma.supportSession.deleteMany({ where: { id: idHash } });
  }

  // Every session of one teammate (password reset, lost staff role).
  async deleteForUser(discordUserId: string): Promise<number> {
    for (const [id, entry] of this.cache) if (entry.row.discordUserId === discordUserId) this.cache.delete(id);
    const res = await this.prisma.supportSession.deleteMany({ where: { discordUserId } });
    return res.count;
  }

  async countLive(currentEpoch: number): Promise<number> {
    const now = new Date(this.now());
    return this.prisma.supportSession.count({
      where: {
        epoch: currentEpoch,
        absoluteExpiresAt: { gt: now },
        lastSeenAt: { gt: new Date(now.getTime() - SUPPORT_IDLE_TTL_MS) },
      },
    });
  }

  // "Sign everyone out": the epoch bump already invalidates every row; this
  // also clears the storage.
  async deleteAll(): Promise<number> {
    this.cache.clear();
    const res = await this.prisma.supportSession.deleteMany({});
    return res.count;
  }

  // Bounded storage: evict dead rows, cap per-teammate and global sessions
  // (oldest first: the new sign-in wins over a forgotten one).
  private async enforceCaps(discordUserId: string): Promise<void> {
    const now = new Date(this.now());
    await this.prisma.supportSession.deleteMany({
      where: {
        OR: [{ absoluteExpiresAt: { lt: now } }, { lastSeenAt: { lt: new Date(now.getTime() - SUPPORT_IDLE_TTL_MS) } }],
      },
    });
    const mine = await this.prisma.supportSession.findMany({ where: { discordUserId }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (mine.length >= MAX_SESSIONS_PER_USER) {
      const drop = mine.slice(0, mine.length - MAX_SESSIONS_PER_USER + 1).map((r) => r.id);
      await this.prisma.supportSession.deleteMany({ where: { id: { in: drop } } });
      for (const id of drop) this.cache.delete(id);
    }
    const total = await this.prisma.supportSession.count();
    if (total >= MAX_SESSIONS_GLOBAL) {
      const oldest = await this.prisma.supportSession.findMany({
        orderBy: { createdAt: "asc" },
        take: total - MAX_SESSIONS_GLOBAL + 1,
        select: { id: true },
      });
      await this.prisma.supportSession.deleteMany({ where: { id: { in: oldest.map((r) => r.id) } } });
      for (const r of oldest) this.cache.delete(r.id);
    }
  }
}
