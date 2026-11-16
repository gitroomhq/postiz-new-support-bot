import type { PrismaClient, SupportAction, SupportCredential, SupportLookup } from "../generated/prisma/client";
import type { BillingApproval } from "../bot/billing/ApprovalStore";
import { changedFields, fieldPhrase, parseStoredDetails } from "../bot/billing/customerDetails";

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

export type LookupVia = "email" | "customer" | "postiz" | "card" | "reference" | "recent" | "link";

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

  // The customers one teammate opened, each once, most recent first.
  async recentCustomers(discordUserId: string, offset: number, limit: number): Promise<{ rows: RecentCustomer[]; total: number }> {
    const groups = await this.prisma.supportLookup.groupBy({
      by: ["customerId"],
      where: { discordUserId },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
    });
    const page = groups.slice(offset, offset + limit);
    if (!page.length) return { rows: [], total: groups.length };
    const latest = await this.prisma.supportLookup.findMany({
      where: { discordUserId, customerId: { in: page.map((g) => g.customerId) } },
      orderBy: { createdAt: "desc" },
      select: { customerId: true, customerName: true },
    });
    const names = new Map<string, string | null>();
    for (const r of latest) if (!names.has(r.customerId)) names.set(r.customerId, r.customerName);
    return {
      rows: page.map((g) => ({ customerId: g.customerId, customerName: names.get(g.customerId) ?? null, openedAt: g._max.createdAt ?? new Date(0) })),
      total: groups.length,
    };
  }
}

export interface RecentCustomer {
  customerId: string;
  customerName: string | null;
  openedAt: Date;
}

export type SupportActionKind = "refund" | "cancel" | "uncancel" | "details" | "unsuppress";
export type SupportActionStatus = "done" | "failed" | "queued" | "rejected" | "refused" | "expired" | "withdrawn";

// How My activity and the /config log group the statuses.
export const ACTIVITY_GROUPS: Record<string, SupportActionStatus[]> = {
  done: ["done"],
  pending: ["queued"],
  failed: ["failed"],
  closed: ["rejected", "refused", "expired", "withdrawn"],
};

export interface ApprovalReader {
  getMany(ids: string[]): Promise<BillingApproval[]>;
  listByOrigin(origin: "support", offset: number, limit: number): Promise<BillingApproval[]>;
}

const SETTLE_BATCH = 200;
const IMPORT_PAGE = 200;

// What each support teammate did from /support. A queued row follows its
// approval: it is settled (done, rejected, refused, expired, withdrawn) the
// first time it is read after an admin or the clock closed the approval.
export class SupportActionLog {
  constructor(
    private prisma: Pick<PrismaClient, "supportAction">,
    private approvals: ApprovalReader
  ) {}

  async record(entry: {
    discordUserId: string;
    actorName: string;
    customerId: string;
    customerName: string | null;
    kind: SupportActionKind;
    summary: string;
    status: SupportActionStatus;
    outcome?: string | null;
    approvalId?: string | null;
    reason?: string | null;
    intercomRef?: string | null;
  }): Promise<SupportAction> {
    return this.prisma.supportAction.create({
      data: {
        discordUserId: entry.discordUserId,
        actorName: entry.actorName.slice(0, 200),
        customerId: entry.customerId,
        customerName: entry.customerName?.slice(0, 256) ?? null,
        kind: entry.kind,
        summary: entry.summary.slice(0, 300),
        status: entry.status,
        outcome: entry.outcome?.slice(0, 500) ?? null,
        approvalId: entry.approvalId ?? null,
        reason: entry.reason?.slice(0, 500) ?? null,
        intercomRef: entry.intercomRef?.slice(0, 300) ?? null,
      },
    });
  }

  // One teammate's rows (or everyone's with null), newest first.
  async list(discordUserId: string | null, group: string | null, offset: number, limit: number): Promise<{ rows: SupportAction[]; total: number }> {
    await this.settle(discordUserId);
    const statuses = group ? ACTIVITY_GROUPS[group] : undefined;
    const where = { ...(discordUserId ? { discordUserId } : {}), ...(statuses ? { status: { in: statuses } } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.supportAction.findMany({ where, orderBy: { createdAt: "desc" }, skip: offset, take: limit }),
      this.prisma.supportAction.count({ where }),
    ]);
    return { rows, total };
  }

  // Row count per group for one teammate (keys of ACTIVITY_GROUPS, plus all).
  async counts(discordUserId: string): Promise<Record<string, number>> {
    await this.settle(discordUserId);
    const rows = await this.prisma.supportAction.groupBy({ by: ["status"], where: { discordUserId }, _count: { _all: true } });
    const out: Record<string, number> = { all: 0 };
    for (const [group, statuses] of Object.entries(ACTIVITY_GROUPS)) out[group] = 0;
    for (const r of rows) {
      out.all += r._count._all;
      const group = Object.entries(ACTIVITY_GROUPS).find(([, statuses]) => statuses.includes(r.status as SupportActionStatus))?.[0];
      if (group) out[group] += r._count._all;
    }
    return out;
  }

  async byApproval(approvalId: string): Promise<SupportAction | null> {
    return this.prisma.supportAction.findUnique({ where: { approvalId } });
  }

  // Queued rows whose approval has closed take its outcome.
  async settle(discordUserId: string | null): Promise<void> {
    const queued = await this.prisma.supportAction.findMany({
      where: { status: "queued", approvalId: { not: null }, ...(discordUserId ? { discordUserId } : {}) },
      select: { id: true, approvalId: true, outcome: true },
      take: SETTLE_BATCH,
    });
    if (!queued.length) return;
    const approvals = new Map((await this.approvals.getMany(queued.map((q) => q.approvalId!))).map((a) => [a.id, a]));
    for (const q of queued) {
      const a = approvals.get(q.approvalId!);
      if (!a) continue;
      const next = settledFrom(a);
      if (next.status === "queued" && next.outcome === q.outcome) continue;
      await this.prisma.supportAction.updateMany({ where: { id: q.id, status: "queued" }, data: next });
    }
  }

  // Support requests filed before this log existed become rows once.
  async importLegacy(): Promise<number> {
    let imported = 0;
    for (let offset = 0; ; offset += IMPORT_PAGE) {
      const page = await this.approvals.listByOrigin("support", offset, IMPORT_PAGE);
      if (!page.length) break;
      const res = await this.prisma.supportAction.createMany({ data: page.map(legacyRow), skipDuplicates: true });
      imported += res.count;
      if (page.length < IMPORT_PAGE) break;
    }
    return imported;
  }
}

// The row state an approval implies. Open approvals keep the row queued; a
// retryable failure says so in the outcome.
export function settledFrom(a: BillingApproval): { status: SupportActionStatus; outcome: string | null } {
  switch (a.status) {
    case "EXECUTED":
      return { status: "done", outcome: a.reviewerName ? `Approved by ${a.reviewerName}` : null };
    case "REJECTED":
      return { status: "rejected", outcome: a.reviewNote ? `${a.reviewerName ?? "Admin"}: ${a.reviewNote}` : a.reviewerName ? `Rejected by ${a.reviewerName}` : null };
    case "REFUSED":
      return { status: "refused", outcome: a.errorText ?? "The customer changed since the request." };
    case "EXPIRED":
      return { status: "expired", outcome: "No decision within 7 days" };
    case "WITHDRAWN":
      return { status: "withdrawn", outcome: null };
    case "FAILED":
      return { status: "queued", outcome: `Stripe refused it, an admin can retry: ${(a.errorText ?? "").slice(0, 160)}` };
    default:
      return { status: "queued", outcome: null };
  }
}

const LEGACY_KIND: Record<string, SupportActionKind> = {
  "customer.update_details": "details",
  "charge.refund_partial": "refund",
  "subscription.cancel": "cancel",
};

function legacyRow(a: BillingApproval) {
  const p = a.paramsJson && typeof a.paramsJson === "object" && !Array.isArray(a.paramsJson) ? (a.paramsJson as Record<string, unknown>) : {};
  const before = parseStoredDetails(p.before);
  const after = parseStoredDetails(p.after);
  const settled = settledFrom(a);
  return {
    discordUserId: a.requestedById,
    actorName: a.requestedByName.slice(0, 200),
    customerId: a.stripeCustomerId ?? "",
    customerName: typeof p.customerName === "string" ? p.customerName.slice(0, 256) : null,
    kind: LEGACY_KIND[a.actionKey] ?? "details",
    summary: before && after ? `Change ${fieldPhrase(changedFields(before, after))}` : a.summary.slice(0, 300),
    status: settled.status,
    outcome: settled.outcome,
    approvalId: a.id,
    reason: typeof p.reason === "string" ? p.reason.slice(0, 500) : null,
    intercomRef: typeof p.intercomRef === "string" ? p.intercomRef.slice(0, 300) : null,
    createdAt: a.createdAt,
  };
}
