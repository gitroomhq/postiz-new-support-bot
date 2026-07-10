import type Stripe from "stripe";
import { PrismaClient, StripeDispute } from "../../generated/prisma/client";

// Statuses with staff work left to do — everything the overview lists.
export const OPEN_DISPUTE_STATUSES = [
  "warning_needs_response",
  "warning_under_review",
  "needs_response",
  "under_review",
] as const;

// A response can still be submitted only in these two.
export const RESPONDABLE_DISPUTE_STATUSES = ["needs_response", "warning_needs_response"] as const;

// Terminal states never regress: a late-delivered charge.dispute.updated must
// not flip a closed dispute back to under_review (webhooks are unordered).
const TERMINAL_STATUSES = new Set(["won", "lost", "prevented", "warning_closed"]);

export const DAY_MS = 24 * 60 * 60 * 1000;

// Local mirror of Stripe disputes. Stripe's disputes.list can't filter by
// status, so the open-disputes overview and the reminder looper read from
// here; webhooks and the looper reconciliation keep it fresh.
export class DisputeStore {
  constructor(private prisma: PrismaClient) {}

  // Idempotent upsert from a live Stripe dispute (webhook or reconciliation).
  // due_by can be null or 0 (bank allows no response) — both map to null.
  async upsertFromStripe(d: Stripe.Dispute, customerId: string | null): Promise<StripeDispute> {
    const chargeId = typeof d.charge === "string" ? d.charge : (d.charge?.id ?? "");
    const paymentIntentId =
      typeof d.payment_intent === "string" ? d.payment_intent : (d.payment_intent?.id ?? null);
    const evidenceDueBy = d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000) : null;
    const submitted = (d.evidence_details?.submission_count ?? 0) > 0;
    const terminal = TERMINAL_STATUSES.has(d.status);

    const existing = await this.prisma.stripeDispute.findUnique({ where: { id: d.id } });
    if (existing && TERMINAL_STATUSES.has(existing.status) && !terminal) return existing; // stale event

    const shared = {
      chargeId,
      paymentIntentId,
      customerId: customerId ?? existing?.customerId ?? null,
      amount: d.amount,
      currency: d.currency,
      reason: d.reason || "unknown",
      status: d.status,
      evidenceDueBy,
      // Evidence submitted outside the bot (Dashboard) still gets stamped here.
      evidenceSubmittedAt: submitted ? (existing?.evidenceSubmittedAt ?? new Date()) : existing?.evidenceSubmittedAt ?? null,
      closedAt: terminal ? (existing?.closedAt ?? new Date()) : null,
    };
    return this.prisma.stripeDispute.upsert({
      where: { id: d.id },
      update: shared,
      create: { ...shared, id: d.id, disputeCreatedAt: new Date(d.created * 1000) },
    });
  }

  async get(id: string): Promise<StripeDispute | null> {
    return this.prisma.stripeDispute.findUnique({ where: { id } });
  }

  // Overview page: open disputes, most urgent (earliest evidence deadline) first.
  async listOpen(skip: number, take: number): Promise<{ rows: StripeDispute[]; total: number }> {
    const where = { status: { in: [...OPEN_DISPUTE_STATUSES] } };
    const [rows, total] = await Promise.all([
      this.prisma.stripeDispute.findMany({
        where,
        orderBy: [{ evidenceDueBy: { sort: "asc", nulls: "last" } }, { disputeCreatedAt: "desc" }],
        skip,
        take,
      }),
      this.prisma.stripeDispute.count({ where }),
    ]);
    return { rows, total };
  }

  async countOpen(): Promise<number> {
    return this.prisma.stripeDispute.count({ where: { status: { in: [...OPEN_DISPUTE_STATUSES] } } });
  }

  async countDueWithin(days: number, now: Date = new Date()): Promise<number> {
    return this.prisma.stripeDispute.count({
      where: {
        status: { in: [...RESPONDABLE_DISPUTE_STATUSES] },
        evidenceSubmittedAt: null,
        evidenceDueBy: { gte: now, lte: new Date(now.getTime() + days * DAY_MS) },
      },
    });
  }

  // Reminder work-list: respondable, unsubmitted, due within the window (past-due
  // excluded — the response window is already over), not pinged in the last 24h.
  async listNeedingReminder(withinDays: number, now: Date = new Date()): Promise<StripeDispute[]> {
    return this.prisma.stripeDispute.findMany({
      where: {
        status: { in: [...RESPONDABLE_DISPUTE_STATUSES] },
        evidenceSubmittedAt: null,
        evidenceDueBy: { gte: now, lte: new Date(now.getTime() + withinDays * DAY_MS) },
        OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: new Date(now.getTime() - DAY_MS) } }],
      },
      orderBy: { evidenceDueBy: "asc" },
    });
  }

  async recordReminder(id: string): Promise<void> {
    await this.prisma.stripeDispute.updateMany({ where: { id }, data: { lastReminderAt: new Date() } });
  }

  async saveEvidenceDraft(id: string, draft: Record<string, string>): Promise<void> {
    await this.prisma.stripeDispute.updateMany({ where: { id }, data: { evidenceDraft: draft } });
  }

  async markSubmitted(id: string): Promise<void> {
    await this.prisma.stripeDispute.updateMany({ where: { id }, data: { evidenceSubmittedAt: new Date() } });
  }

  // Reconciliation: local-open ids to re-check against Stripe (catches closes
  // older than the sweep window and missed webhooks).
  async listOpenIds(): Promise<string[]> {
    const rows = await this.prisma.stripeDispute.findMany({
      where: { status: { in: [...OPEN_DISPUTE_STATUSES] } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // Overview footer context: outcome tallies of NON-open disputes created in
  // the trailing window (won / lost / prevented+closed-inquiry).
  async closedSummarySince(days: number, now: Date = new Date()): Promise<{ won: number; lost: number; otherClosed: number }> {
    const rows = await this.prisma.stripeDispute.groupBy({
      by: ["status"],
      where: {
        status: { notIn: [...OPEN_DISPUTE_STATUSES] },
        disputeCreatedAt: { gte: new Date(now.getTime() - days * DAY_MS) },
      },
      _count: { _all: true },
    });
    const summary = { won: 0, lost: 0, otherClosed: 0 };
    for (const row of rows) {
      const count = row._count._all;
      if (row.status === "won") summary.won += count;
      else if (row.status === "lost") summary.lost += count;
      else summary.otherClosed += count;
    }
    return summary;
  }

  // ---- Watch subscriptions (DM on status change) ----

  async watch(disputeId: string, userId: string): Promise<void> {
    try {
      await this.prisma.disputeWatch.create({ data: { disputeId, userId } });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error; // already watching
    }
  }

  async unwatch(disputeId: string, userId: string): Promise<void> {
    await this.prisma.disputeWatch.deleteMany({ where: { disputeId, userId } });
  }

  async isWatching(disputeId: string, userId: string): Promise<boolean> {
    return (await this.prisma.disputeWatch.findFirst({ where: { disputeId, userId } })) !== null;
  }

  async watchers(disputeId: string): Promise<string[]> {
    const rows = await this.prisma.disputeWatch.findMany({ where: { disputeId }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }
}
