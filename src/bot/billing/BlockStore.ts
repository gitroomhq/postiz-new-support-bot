import { BlockedEntity, PrismaClient } from "../../generated/prisma/client";

export type BlockKind = "card_fingerprint" | "email" | "customer_id" | "ip_address";

export const BLOCK_KINDS: BlockKind[] = ["card_fingerprint", "email", "customer_id", "ip_address"];

export const BLOCK_KIND_LABELS: Record<BlockKind, string> = {
  card_fingerprint: "Card fingerprint",
  email: "Email",
  customer_id: "Customer",
  ip_address: "IP address",
};

// Emails are matched case-insensitively by Radar; store one canonical form so
// the (kind, value) unique constraint dedupes properly.
export function normalizeBlockValue(kind: BlockKind, value: string): string {
  const v = value.trim();
  return kind === "email" ? v.toLowerCase() : v;
}

// Local half of the blocklist (the other half is the Stripe Radar value-list
// item referenced by radarItemId). Rows are hard-deleted on unblock; action
// history lives in the audit channel + Influx events.
export class BlockStore {
  constructor(private prisma: PrismaClient) {}

  async upsert(e: {
    kind: BlockKind;
    value: string;
    reason: string;
    source: "manual" | "auto_dispute";
    actorId?: string | null;
    actorName?: string | null;
    customerId?: string | null;
    disputeId?: string | null;
    radarItemId?: string | null;
  }): Promise<BlockedEntity> {
    const value = normalizeBlockValue(e.kind, e.value);
    return this.prisma.blockedEntity.upsert({
      where: { kind_value: { kind: e.kind, value } },
      // Re-blocking refreshes the context but keeps the original createdAt; a
      // null radarItemId never overwrites a real one (Radar item still live).
      update: {
        reason: e.reason,
        source: e.source,
        actorId: e.actorId ?? null,
        actorName: e.actorName ?? null,
        ...(e.customerId ? { customerId: e.customerId } : {}),
        ...(e.disputeId ? { disputeId: e.disputeId } : {}),
        ...(e.radarItemId ? { radarItemId: e.radarItemId } : {}),
      },
      create: {
        kind: e.kind,
        value,
        reason: e.reason,
        source: e.source,
        actorId: e.actorId ?? null,
        actorName: e.actorName ?? null,
        customerId: e.customerId ?? null,
        disputeId: e.disputeId ?? null,
        radarItemId: e.radarItemId ?? null,
      },
    });
  }

  async get(id: string): Promise<BlockedEntity | null> {
    return this.prisma.blockedEntity.findUnique({ where: { id } });
  }

  async getByKindValue(kind: BlockKind, value: string): Promise<BlockedEntity | null> {
    return this.prisma.blockedEntity.findUnique({
      where: { kind_value: { kind, value: normalizeBlockValue(kind, value) } },
    });
  }

  // Hard delete; returns the removed row (with its radarItemId) or null.
  async remove(id: string): Promise<BlockedEntity | null> {
    const row = await this.prisma.blockedEntity.findUnique({ where: { id } });
    if (!row) return null;
    await this.prisma.blockedEntity.deleteMany({ where: { id } });
    return row;
  }

  // First matching block for a customer/email/card — the enforcement + banner check.
  async anyBlocked(q: {
    customerId?: string | null;
    email?: string | null;
    fingerprint?: string | null;
  }): Promise<BlockedEntity | null> {
    const or: object[] = [];
    if (q.customerId) {
      or.push({ kind: "customer_id", value: q.customerId });
      or.push({ customerId: q.customerId });
    }
    if (q.email) or.push({ kind: "email", value: normalizeBlockValue("email", q.email) });
    if (q.fingerprint) or.push({ kind: "card_fingerprint", value: q.fingerprint });
    if (or.length === 0) return null;
    return this.prisma.blockedEntity.findFirst({ where: { OR: or }, orderBy: { createdAt: "asc" } });
  }

  // All blocks relevant to one customer (Customer-360 banner detail).
  async listForCustomer(customerId: string, email?: string | null): Promise<BlockedEntity[]> {
    const or: object[] = [{ customerId }, { kind: "customer_id", value: customerId }];
    if (email) or.push({ kind: "email", value: normalizeBlockValue("email", email) });
    return this.prisma.blockedEntity.findMany({ where: { OR: or }, orderBy: { createdAt: "desc" } });
  }

  async listPage(skip: number, take: number): Promise<{ rows: BlockedEntity[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.blockedEntity.findMany({ orderBy: { createdAt: "desc" }, skip, take }),
      this.prisma.blockedEntity.count(),
    ]);
    return { rows, total };
  }

  async count(): Promise<number> {
    return this.prisma.blockedEntity.count();
  }
}
