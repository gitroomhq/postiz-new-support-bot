import { PrismaClient, Ticket, StatusTag } from "../generated/prisma/client";

export type TicketWithTag = Ticket & { statusTag: StatusTag | null };

export interface CreateTicketInput {
  threadId: string;
  channelId: string;
  statusTagId: string;
  customerId?: string | null;
  customerDisplayName?: string | null;
  categoryId?: string | null;
}

// Fields the Re-Verify sweep may repair. Only the ones actually present are written.
export interface ReconcileChanges {
  statusTagId?: string;
  categoryId?: string;
  closed?: boolean;
  closedAt?: Date | null; // only passed on an actual open↔closed transition
}

export class TicketStore {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateTicketInput): Promise<Ticket> {
    return this.prisma.ticket.create({
      data: {
        threadId: input.threadId,
        channelId: input.channelId,
        statusTagId: input.statusTagId,
        customerId: input.customerId ?? null,
        customerDisplayName: input.customerDisplayName ?? null,
        categoryId: input.categoryId ?? null,
      },
    });
  }

  async getByThreadId(threadId: string): Promise<TicketWithTag | null> {
    return this.prisma.ticket.findUnique({
      where: { threadId },
      include: { statusTag: true },
    });
  }

  // Every ticket with its status tag joined, for the Re-Verify reconciliation sweep.
  async getAllWithTag(): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      include: { statusTag: true },
      orderBy: { createdAt: "asc" },
    });
  }

  // Silent DB repair used by Re-Verify to make a ticket match its Discord thread. Unlike
  // setStatus(), this deliberately does NOT touch reminderCount / lastReminderAt /
  // lastStatusChangeAt, so reminder cadence and auto-close-after-quiet-period timers keep
  // their real values. Writes only the provided fields; a no-op when nothing changed.
  async reconcile(threadId: string, changes: ReconcileChanges): Promise<void> {
    const data: ReconcileChanges = {};
    if (changes.statusTagId !== undefined) data.statusTagId = changes.statusTagId;
    if (changes.categoryId !== undefined) data.categoryId = changes.categoryId;
    if (changes.closed !== undefined) data.closed = changes.closed;
    if (changes.closedAt !== undefined) data.closedAt = changes.closedAt;
    if (Object.keys(data).length === 0) return;
    await this.prisma.ticket.update({ where: { threadId }, data });
  }

  // isDone: the new status closes the thread or marks it resolved. We stamp closedAt
  // (and the closed flag) so the status report can count "closed since X" accurately, and
  // clear them when a ticket is moved back to an active status.
  async setStatus(threadId: string, statusTagId: string, isDone: boolean): Promise<void> {
    await this.prisma.ticket.update({
      where: { threadId },
      data: {
        statusTagId,
        lastStatusChangeAt: new Date(),
        lastReminderAt: null,
        reminderCount: 0,
        closed: isDone,
        closedAt: isDone ? new Date() : null,
      },
    });
  }

  async recordReminder(threadId: string): Promise<void> {
    await this.prisma.ticket.update({
      where: { threadId },
      data: { lastReminderAt: new Date(), reminderCount: { increment: 1 } },
    });
  }

  async close(threadId: string): Promise<void> {
    await this.prisma.ticket.update({ where: { threadId }, data: { closed: true, closedAt: new Date() } });
  }

  // A customer's still-open tickets (used to close them out when the member leaves).
  async listOpenByCustomerId(customerId: string): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      where: { customerId, closed: false },
      include: { statusTag: true },
    });
  }

  // Open tickets whose current status has reminders enabled.
  async listRemindable(): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      where: { closed: false, statusTag: { reminderEnabled: true } },
      include: { statusTag: true },
    });
  }

  // Tickets currently sitting in a given status tag. Used to auto-close Resolved
  // tickets after a quiet period (Resolved tickets carry closed=true, so we key off
  // the status tag rather than the closed flag).
  async listInStatus(statusTagId: string): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      where: { statusTagId },
      include: { statusTag: true },
    });
  }

  async existsForThread(threadId: string): Promise<boolean> {
    return (await this.prisma.ticket.count({ where: { threadId } })) > 0;
  }

  // Operator-facing search for /search-tickets. Every filter is optional and combines with
  // AND; customerIds (already resolved from user/postiz/stripe filters) restricts to those
  // Discord customers. Returns one page plus the total match count for pagination.
  async search(
    filters: { categoryId?: string; statusTagId?: string; closed?: boolean; customerIds?: string[] },
    page: number,
    pageSize: number
  ): Promise<{ tickets: TicketWithTag[]; total: number }> {
    const where: {
      categoryId?: string;
      statusTagId?: string;
      closed?: boolean;
      customerId?: { in: string[] };
    } = {};
    if (filters.categoryId) where.categoryId = filters.categoryId;
    if (filters.statusTagId) where.statusTagId = filters.statusTagId;
    if (filters.closed !== undefined) where.closed = filters.closed;
    if (filters.customerIds) where.customerId = { in: filters.customerIds };

    const [tickets, total] = await this.prisma.$transaction([
      this.prisma.ticket.findMany({
        where,
        include: { statusTag: true },
        orderBy: { createdAt: "desc" },
        skip: page * pageSize,
        take: pageSize,
      }),
      this.prisma.ticket.count({ where }),
    ]);
    return { tickets, total };
  }

  // ---- Aggregates for the status report ----

  // Ticket counts grouped by current status tag AND category, in one pass. The report
  // classifies each statusTagId as open/done and derives every breakdown from this.
  async statusCategoryBreakdown(): Promise<
    { statusTagId: string | null; categoryId: string | null; count: number }[]
  > {
    const rows = await this.prisma.ticket.groupBy({
      by: ["statusTagId", "categoryId"],
      _count: { _all: true },
    });
    return rows.map((r) => ({
      statusTagId: r.statusTagId,
      categoryId: r.categoryId,
      count: r._count._all,
    }));
  }

  async countOpenedSince(since: Date): Promise<number> {
    return this.prisma.ticket.count({ where: { createdAt: { gte: since } } });
  }

  async countClosedSince(since: Date): Promise<number> {
    return this.prisma.ticket.count({ where: { closedAt: { gte: since } } });
  }
}
