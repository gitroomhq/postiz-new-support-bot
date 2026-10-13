import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, QueueSession as DbRow } from "../generated/prisma/client";

// DB-backed Intercom Queue sign-ins (queue_sessions), the dashboard_sessions
// pattern: survive deploys, 7d sliding idle / 30d absolute, row id = SHA-256
// hex of the cookie token so a DB dump yields nothing usable. A short
// read-through cache keeps the hot path off the DB; lastSeenAt is written
// behind (at least 60s apart).

export const QUEUE_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const QUEUE_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const MAX_SESSIONS_PER_ADMIN = 10;
const MAX_SESSIONS_GLOBAL = 200;

export interface QueueSessionView {
  idHash: string;
  adminId: string;
  adminName: string;
  lastVerifiedAt: Date;
  createdAt: Date;
}

export function hashQueueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The slice of PrismaClient the store touches (a fake in tests).
export type QueueSessionDb = Pick<PrismaClient, "queueSession">;

export class QueueSessions {
  private cache = new Map<string, { row: DbRow; cachedAt: number; lastWriteAt: number }>();

  constructor(
    private prisma: QueueSessionDb,
    private now: () => number = Date.now
  ) {}

  // Returns the raw cookie token (it exists only in the Set-Cookie header from
  // here on).
  async create(input: { adminId: string; adminName: string; epoch: number; ip?: string | null; ua?: string | null }): Promise<string> {
    await this.enforceCaps(input.adminId);
    const token = randomBytes(32).toString("base64url");
    const now = new Date(this.now());
    await this.prisma.queueSession.create({
      data: {
        id: hashQueueToken(token),
        adminId: input.adminId,
        adminName: input.adminName.slice(0, 200),
        epoch: input.epoch,
        uaFirst: input.ua?.slice(0, 300) ?? null,
        ipFirst: input.ip?.slice(0, 60) ?? null,
        ipLast: input.ip?.slice(0, 60) ?? null,
        createdAt: now,
        lastSeenAt: now,
        lastVerifiedAt: now,
        absoluteExpiresAt: new Date(now.getTime() + QUEUE_ABSOLUTE_TTL_MS),
      },
    });
    return token;
  }

  // null = missing, expired or signed out by an epoch bump (the row is deleted
  // on the way out so revocation is immediate and storage stays bounded).
  async get(token: string, currentEpoch: number, meta?: { ip?: string | null }): Promise<QueueSessionView | null> {
    if (!token || token.length > 200) return null;
    const idHash = hashQueueToken(token);
    const now = this.now();
    const cached = this.cache.get(idHash);
    let row: DbRow | null;
    if (cached && now - cached.cachedAt < 5_000) {
      row = cached.row;
    } else {
      row = await this.prisma.queueSession.findUnique({ where: { id: idHash } });
      if (row) this.cache.set(idHash, { row, cachedAt: now, lastWriteAt: cached?.lastWriteAt ?? 0 });
    }
    if (!row) {
      this.cache.delete(idHash);
      return null;
    }
    if (row.epoch !== currentEpoch || now - row.lastSeenAt.getTime() > QUEUE_IDLE_TTL_MS || now > row.absoluteExpiresAt.getTime()) {
      await this.delete(idHash);
      return null;
    }
    const entry = this.cache.get(idHash);
    row.lastSeenAt = new Date(now);
    if (meta?.ip) row.ipLast = meta.ip.slice(0, 60);
    if (!entry || now - entry.lastWriteAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      this.cache.set(idHash, { row, cachedAt: now, lastWriteAt: now });
      await this.prisma.queueSession
        .update({ where: { id: idHash }, data: { lastSeenAt: row.lastSeenAt, ipLast: row.ipLast } })
        .catch(() => this.cache.delete(idHash));
    } else {
      entry.row = row;
      entry.cachedAt = now;
    }
    return { idHash, adminId: row.adminId, adminName: row.adminName, lastVerifiedAt: row.lastVerifiedAt, createdAt: row.createdAt };
  }

  // The teammate was confirmed again (still in the workspace, still seated).
  async markVerified(idHash: string, name: string): Promise<void> {
    const at = new Date(this.now());
    const entry = this.cache.get(idHash);
    if (entry) {
      entry.row.lastVerifiedAt = at;
      entry.row.adminName = name.slice(0, 200);
    }
    await this.prisma.queueSession
      .updateMany({ where: { id: idHash }, data: { lastVerifiedAt: at, adminName: name.slice(0, 200) } })
      .catch(() => this.cache.delete(idHash));
  }

  async delete(idHash: string): Promise<void> {
    this.cache.delete(idHash);
    await this.prisma.queueSession.deleteMany({ where: { id: idHash } });
  }

  // Every live sign-in (the config panels' status line).
  async countLive(currentEpoch: number): Promise<number> {
    const now = new Date(this.now());
    return this.prisma.queueSession.count({
      where: {
        epoch: currentEpoch,
        absoluteExpiresAt: { gt: now },
        lastSeenAt: { gt: new Date(now.getTime() - QUEUE_IDLE_TTL_MS) },
      },
    });
  }

  // "Sign everyone out": the epoch bump already invalidates every row; this
  // also clears the storage.
  async deleteAll(): Promise<number> {
    this.cache.clear();
    const res = await this.prisma.queueSession.deleteMany({});
    return res.count;
  }

  // Bounded storage: evict dead rows, cap per-teammate and global sessions
  // (oldest first: the new sign-in wins over a forgotten one).
  private async enforceCaps(adminId: string): Promise<void> {
    const now = new Date(this.now());
    await this.prisma.queueSession.deleteMany({
      where: {
        OR: [{ absoluteExpiresAt: { lt: now } }, { lastSeenAt: { lt: new Date(now.getTime() - QUEUE_IDLE_TTL_MS) } }],
      },
    });
    const mine = await this.prisma.queueSession.findMany({ where: { adminId }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (mine.length >= MAX_SESSIONS_PER_ADMIN) {
      const drop = mine.slice(0, mine.length - MAX_SESSIONS_PER_ADMIN + 1).map((r) => r.id);
      await this.prisma.queueSession.deleteMany({ where: { id: { in: drop } } });
      for (const id of drop) this.cache.delete(id);
    }
    const total = await this.prisma.queueSession.count();
    if (total >= MAX_SESSIONS_GLOBAL) {
      const oldest = await this.prisma.queueSession.findMany({
        orderBy: { createdAt: "asc" },
        take: total - MAX_SESSIONS_GLOBAL + 1,
        select: { id: true },
      });
      await this.prisma.queueSession.deleteMany({ where: { id: { in: oldest.map((r) => r.id) } } });
      for (const r of oldest) this.cache.delete(r.id);
    }
  }
}
