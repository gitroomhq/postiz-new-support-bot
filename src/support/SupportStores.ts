import type { PrismaClient, SupportCredential, SupportLookup } from "../generated/prisma/client";

// Support dashboard passwords: one scrypt hash per Discord user, set at their
// first sign-in. Hashes are not secrets (no reversible material).
export class SupportCredentials {
  constructor(private prisma: Pick<PrismaClient, "supportCredential">) {}

  async get(discordUserId: string): Promise<SupportCredential | null> {
    return this.prisma.supportCredential.findUnique({ where: { discordUserId } });
  }

  // Only ever creates: a password is set once, and changed by an admin reset
  // (delete) followed by a new first sign-in. False when one already exists.
  async create(discordUserId: string, name: string, passwordHash: string): Promise<boolean> {
    try {
      await this.prisma.supportCredential.create({
        data: { discordUserId, name: name.slice(0, 200), passwordHash, lastLoginAt: new Date() },
      });
      return true;
    } catch {
      return false;
    }
  }

  async touchLogin(discordUserId: string, name: string): Promise<void> {
    await this.prisma.supportCredential
      .updateMany({ where: { discordUserId }, data: { lastLoginAt: new Date(), name: name.slice(0, 200) } })
      .catch(() => undefined);
  }

  async reset(discordUserId: string): Promise<boolean> {
    const res = await this.prisma.supportCredential.deleteMany({ where: { discordUserId } });
    return res.count > 0;
  }

  async list(offset: number, limit: number): Promise<{ rows: SupportCredential[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.supportCredential.findMany({ orderBy: { name: "asc" }, skip: offset, take: limit }),
      this.prisma.supportCredential.count(),
    ]);
    return { rows, total };
  }
}

export type LookupVia = "email" | "customer" | "postiz" | "card" | "link";

const LOOKUP_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
// The same teammate reopening the same customer (tab switches, paging) is one
// lookup, not ten.
const LOOKUP_DEDUPE_MS = 10 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;

// Which customer each support teammate opened. Kept 180 days.
export class SupportLookupLog {
  private lastPrune = 0;
  private recent = new Map<string, number>();

  constructor(
    private prisma: Pick<PrismaClient, "supportLookup">,
    private now: () => number = Date.now
  ) {}

  async record(entry: { discordUserId: string; actorName: string; customerId: string; customerName: string | null; via: LookupVia }): Promise<void> {
    const now = this.now();
    const key = `${entry.discordUserId}:${entry.customerId}`;
    const last = this.recent.get(key);
    if (last && now - last < LOOKUP_DEDUPE_MS) return;
    this.recent.set(key, now);
    if (this.recent.size > 2000) this.recent.clear();
    await this.prisma.supportLookup.create({
      data: {
        discordUserId: entry.discordUserId,
        actorName: entry.actorName.slice(0, 200),
        customerId: entry.customerId,
        customerName: entry.customerName?.slice(0, 256) ?? null,
        via: entry.via,
      },
    });
    if (now - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = now;
      await this.prisma.supportLookup.deleteMany({ where: { createdAt: { lt: new Date(now - LOOKUP_RETENTION_MS) } } });
    }
  }

  async list(offset: number, limit: number): Promise<{ rows: SupportLookup[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.supportLookup.findMany({ orderBy: { createdAt: "desc" }, skip: offset, take: limit }),
      this.prisma.supportLookup.count(),
    ]);
    return { rows, total };
  }
}
