import { Prisma, PrismaClient, BillingApproval } from "../../generated/prisma/client";

// Queued canvas/panel billing actions awaiting admin approval.
// State machine:
//   PENDING ──(admin approve: claimForExecution)──► EXECUTING ──ok──► EXECUTED
//      ├──(admin reject)──► REJECTED                    │ error
//      ├──(requester withdraws)──► WITHDRAWN            ▼
//      └──(7d lazy TTL)──► EXPIRED       FAILED ──(admin retry: claim again)──► EXECUTING
// An action whose revalidation refusal is final (the support dashboard's
// detail changes: the customer changed since the request) goes from EXECUTING
// to REFUSED instead of FAILED.
// EXECUTING rows stuck longer than the stale window (process died mid-execute)
// become claimable again — safe because every executor is idempotent
// (BillingAction locks + Stripe idempotency keys + live revalidation).
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXECUTING_STALE_MS = 10 * 60 * 1000;

export type { BillingApproval };

export type ApprovalOrigin = "intercom" | "dashboard" | "support";

// How a requester's own list groups the statuses (support dashboard, My
// requests). FAILED stays with Pending: it is still in the admins' queue.
export const REQUESTER_STATUS_GROUPS: Record<string, string[]> = {
  pending: ["PENDING", "EXECUTING", "FAILED"],
  approved: ["EXECUTED"],
  rejected: ["REJECTED"],
  closed: ["EXPIRED", "REFUSED"],
};

export interface CreateApprovalInput {
  actionKey: string;
  params: unknown;
  summary: string;
  // null for dashboard-origin requests (no Intercom conversation involved).
  conversationId: string | null;
  // Decides how the execution ctx is rebuilt at approval time (default intercom).
  origin?: ApprovalOrigin;
  ticketThreadId: string | null;
  stripeCustomerId: string | null;
  requestedById: string;
  requestedByName: string;
}

export class ApprovalStore {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateApprovalInput): Promise<BillingApproval> {
    return this.prisma.billingApproval.create({
      data: {
        actionKey: input.actionKey,
        paramsJson: (input.params ?? {}) as Prisma.InputJsonValue,
        summary: input.summary,
        conversationId: input.conversationId,
        origin: input.origin ?? "intercom",
        ticketThreadId: input.ticketThreadId,
        stripeCustomerId: input.stripeCustomerId,
        requestedById: input.requestedById,
        requestedByName: input.requestedByName,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      },
    });
  }

  async get(id: string): Promise<BillingApproval | null> {
    return this.prisma.billingApproval.findUnique({ where: { id } });
  }

  // Lazy TTL: flip overdue PENDING rows to EXPIRED before every listing —
  // no scheduler needed, and admin views never show dead requests.
  async expireOverdue(): Promise<void> {
    await this.prisma.billingApproval.updateMany({
      where: { status: "PENDING", expiresAt: { lt: new Date() } },
      data: { status: "EXPIRED", resolvedAt: new Date() },
    });
  }

  // Pending + retryable (FAILED) rows, oldest first — what admins act on.
  async listActionable(offset: number, limit: number): Promise<{ rows: BillingApproval[]; total: number }> {
    await this.expireOverdue();
    const where = { status: { in: ["PENDING", "FAILED"] } };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.billingApproval.findMany({ where, orderBy: { createdAt: "asc" }, skip: offset, take: limit }),
      this.prisma.billingApproval.count({ where }),
    ]);
    return { rows, total };
  }

  async listActionableForConversation(conversationId: string, limit: number): Promise<BillingApproval[]> {
    await this.expireOverdue();
    return this.prisma.billingApproval.findMany({
      where: { conversationId, status: { in: ["PENDING", "FAILED"] } },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  }

  async countActionable(): Promise<number> {
    await this.expireOverdue();
    return this.prisma.billingApproval.count({ where: { status: { in: ["PENDING", "FAILED"] } } });
  }

  // Atomic single-winner claim — THE double-approve guard. Claimable:
  // unexpired PENDING, retryable FAILED, and stale EXECUTING (claimed >10min
  // ago = process died mid-execute). Returns false when another reviewer
  // already owns the row.
  async claimForExecution(id: string, reviewerId: string, reviewerName: string): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.billingApproval.updateMany({
      where: {
        id,
        OR: [
          { status: { in: ["PENDING", "FAILED"] }, expiresAt: { gt: now } },
          { status: "EXECUTING", claimedAt: { lt: new Date(now.getTime() - EXECUTING_STALE_MS) } },
        ],
      },
      data: { status: "EXECUTING", reviewerId, reviewerName, claimedAt: now },
    });
    return result.count === 1;
  }

  async markExecuted(id: string, resultText: string): Promise<void> {
    await this.prisma.billingApproval.updateMany({
      where: { id, status: "EXECUTING" },
      data: { status: "EXECUTED", resultText: resultText.slice(0, 1000), resolvedAt: new Date() },
    });
  }

  // FAILED keeps the reviewer and stays claimable (retry re-runs the full
  // revalidation).
  async markFailed(id: string, errorText: string): Promise<void> {
    await this.prisma.billingApproval.updateMany({
      where: { id, status: "EXECUTING" },
      data: { status: "FAILED", errorText: errorText.slice(0, 1000) },
    });
  }

  // Reject is only valid from PENDING/FAILED — an EXECUTING row is owned by
  // its claimer. Returns false when the row was not rejectable.
  async reject(id: string, reviewerId: string, reviewerName: string, note?: string | null): Promise<boolean> {
    const result = await this.prisma.billingApproval.updateMany({
      where: { id, status: { in: ["PENDING", "FAILED"] } },
      data: {
        status: "REJECTED",
        reviewerId,
        reviewerName,
        resolvedAt: new Date(),
        ...(note ? { reviewNote: note.slice(0, 500) } : {}),
      },
    });
    return result.count === 1;
  }

  // Final refusal: the action's revalidation said no, and a retry would say no
  // again. Leaves the admin queue.
  async markRefused(id: string, errorText: string): Promise<void> {
    await this.prisma.billingApproval.updateMany({
      where: { id, status: "EXECUTING" },
      data: { status: "REFUSED", errorText: errorText.slice(0, 1000), resolvedAt: new Date() },
    });
  }

  // The requester takes their own request back while nobody has acted on it.
  async withdraw(id: string, origin: ApprovalOrigin, requesterId: string): Promise<boolean> {
    const result = await this.prisma.billingApproval.updateMany({
      where: { id, origin, requestedById: requesterId, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "WITHDRAWN", resolvedAt: new Date() },
    });
    return result.count === 1;
  }

  // The open request of one kind for one customer (the support dashboard
  // allows one at a time).
  async findActionableFor(actionKey: string, stripeCustomerId: string): Promise<BillingApproval | null> {
    await this.expireOverdue();
    return this.prisma.billingApproval.findFirst({
      where: { actionKey, stripeCustomerId, status: { in: ["PENDING", "EXECUTING", "FAILED"] } },
      orderBy: { createdAt: "desc" },
    });
  }

  // One requester's own requests, newest first, optionally one status group.
  async listByRequester(
    origin: ApprovalOrigin,
    requesterId: string,
    group: string | null,
    offset: number,
    limit: number
  ): Promise<{ rows: BillingApproval[]; total: number }> {
    await this.expireOverdue();
    const statuses = group ? REQUESTER_STATUS_GROUPS[group] : undefined;
    const where = { origin, requestedById: requesterId, ...(statuses ? { status: { in: statuses } } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.billingApproval.findMany({ where, orderBy: { createdAt: "desc" }, skip: offset, take: limit }),
      this.prisma.billingApproval.count({ where }),
    ]);
    return { rows, total };
  }

  async countByRequesterStatus(origin: ApprovalOrigin, requesterId: string): Promise<Record<string, number>> {
    await this.expireOverdue();
    const rows = await this.prisma.billingApproval.groupBy({
      by: ["status"],
      where: { origin, requestedById: requesterId },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r._count._all;
    return out;
  }

  // Closed requests whose requester has not been told yet (outcome DMs),
  // closed after `since` (a requester whose DMs stay shut is not retried forever).
  async listUnnotified(origin: ApprovalOrigin, statuses: string[], since: Date, limit: number): Promise<BillingApproval[]> {
    await this.expireOverdue();
    return this.prisma.billingApproval.findMany({
      where: { origin, notifiedAt: null, status: { in: statuses }, resolvedAt: { gt: since } },
      orderBy: { resolvedAt: "asc" },
      take: limit,
    });
  }

  // A claimed notification that could not be delivered goes back for a retry.
  async releaseNotify(id: string): Promise<void> {
    await this.prisma.billingApproval.updateMany({ where: { id }, data: { notifiedAt: null } });
  }

  // Claims the notification: true for exactly one caller.
  async claimNotify(id: string): Promise<boolean> {
    const result = await this.prisma.billingApproval.updateMany({
      where: { id, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    return result.count === 1;
  }
}
