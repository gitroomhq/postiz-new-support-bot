import { PrismaClient, Ticket, StatusTag } from "../generated/prisma/client";

export type TicketWithTag = Ticket & { statusTag: StatusTag | null };

export type TagChangeKind = "STATUS";

export interface CreateTicketInput {
  threadId: string;
  channelId: string;
  statusTagId: string;
  customerId?: string | null;
  customerDisplayName?: string | null;
  categoryId?: string | null;
  question?: string | null;
  // Discord-only ticket — never mirrored to Intercom (refund-flow threads).
  intercomExempt?: boolean;
}

// All-time customer-satisfaction aggregates for the report and its Feedback drill-down.
export interface CsatStats {
  counts: Map<number, number>; // score (1-5) → number of ratings
  rated: number;
  prompted: number;
  average: number | null;
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
        question: input.question ?? null,
        intercomExempt: input.intercomExempt ?? false,
      },
    });
  }

  // Refund-ticket flip: clears the Discord-only exemption exactly once (the
  // intercomExempt:true guard makes concurrent messages single-winner) and
  // stamps intercomExemptLiftedAt so ensureSchema's boot backfill never
  // re-exempts the row. Returns true when this caller performed the lift.
  async liftIntercomExempt(threadId: string): Promise<boolean> {
    const result = await this.prisma.ticket.updateMany({
      where: { threadId, intercomExempt: true },
      data: { intercomExempt: false, intercomExemptLiftedAt: new Date() },
    });
    return result.count > 0;
  }

  // Most recent ticket a customer opened, regardless of state (creation-cooldown check).
  async latestByCustomerId(customerId: string): Promise<{ createdAt: Date } | null> {
    return this.prisma.ticket.findFirst({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
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
    // Remember where the ticket came from (skipped when re-applying the same status, so
    // the real previous status survives) — restores Waiting-for-Customer on reply.
    const current = await this.prisma.ticket.findUnique({
      where: { threadId },
      select: { statusTagId: true },
    });
    const cameFrom = current?.statusTagId;
    await this.prisma.ticket.update({
      where: { threadId },
      data: {
        statusTagId,
        ...(cameFrom && cameFrom !== statusTagId ? { prevStatusTagId: cameFrom } : {}),
        lastStatusChangeAt: new Date(),
        lastReminderAt: null,
        reminderCount: 0,
        // A /reminders off pause only lasts until the next status change.
        remindersPaused: false,
        closed: isDone,
        closedAt: isDone ? new Date() : null,
        // Any real status change supersedes a pending re-close: reopening cancels it,
        // closing locks the thread right away anyway.
        recloseAt: null,
      },
    });
  }

  // ---- Re-close after activity in a closed ticket ----

  // (Re)stamps the re-close deadline; called on every message, so the timer resets.
  async scheduleReclose(threadId: string, at: Date): Promise<void> {
    await this.prisma.ticket.update({ where: { threadId }, data: { recloseAt: at } });
  }

  async clearReclose(threadId: string): Promise<void> {
    await this.prisma.ticket.update({ where: { threadId }, data: { recloseAt: null } });
  }

  async recordReminder(threadId: string): Promise<void> {
    await this.prisma.ticket.update({
      where: { threadId },
      data: { lastReminderAt: new Date(), reminderCount: { increment: 1 } },
    });
  }

  // Best-effort identity stamp from the platform lookup. Scoped to the columns
  // the resolver owns so it can never disturb ticket state.
  async setPostizIdentity(
    threadId: string,
    stamp: {
      postizUserId: string;
      postizOrgId: string;
      postizTier: string | null;
      postizRole: string | null;
      postizLinkedAt: Date;
    }
  ): Promise<void> {
    await this.prisma.ticket.update({ where: { threadId }, data: stamp });
  }

  async close(threadId: string): Promise<void> {
    // Closing is a status transition, so it also ends a /reminders off pause.
    await this.prisma.ticket.update({
      where: { threadId },
      data: { closed: true, closedAt: new Date(), remindersPaused: false },
    });
  }

  // A customer's still-open tickets (used to close them out when the member leaves).
  async listOpenByCustomerId(customerId: string): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      where: { customerId, closed: false },
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
    filters: {
      categoryId?: string;
      statusTagId?: string;
      closed?: boolean;
      customerIds?: string[];
      // A Postiz identity matches a ticket two ways: through a Discord account
      // linked to that Postiz user, or through the identity stamped on the
      // ticket itself at creation. These are OR-ed together, then AND-ed with
      // every other filter, so combining them with a Discord/Stripe filter
      // still narrows rather than widens.
      postizMatch?: { discordIds: string[]; userIds: string[]; orgIds: string[] };
      text?: string;
      createdAfter?: Date;
      createdBefore?: Date;
    },
    page: number,
    pageSize: number
  ): Promise<{ tickets: TicketWithTag[]; total: number }> {
    const where: {
      categoryId?: string;
      statusTagId?: string;
      closed?: boolean;
      customerId?: { in: string[] };
      OR?: object[];
      AND?: object[];
      createdAt?: { gte?: Date; lt?: Date };
    } = {};
    if (filters.categoryId) where.categoryId = filters.categoryId;
    if (filters.statusTagId) where.statusTagId = filters.statusTagId;
    if (filters.closed !== undefined) where.closed = filters.closed;
    if (filters.customerIds) where.customerId = { in: filters.customerIds };
    if (filters.postizMatch) {
      const m = filters.postizMatch;
      const alternatives: object[] = [];
      if (m.discordIds.length) alternatives.push({ customerId: { in: m.discordIds } });
      if (m.userIds.length) alternatives.push({ postizUserId: { in: m.userIds } });
      if (m.orgIds.length) alternatives.push({ postizOrgId: { in: m.orgIds } });
      // Nothing to match on at all: force an empty result rather than dropping
      // the filter and returning every ticket.
      where.AND = [alternatives.length ? { OR: alternatives } : { threadId: { in: [] } }];
    }
    if (filters.text) {
      where.OR = [
        { question: { contains: filters.text, mode: "insensitive" } },
        { customerDisplayName: { contains: filters.text, mode: "insensitive" } },
      ];
    }
    if (filters.createdAfter || filters.createdBefore) {
      where.createdAt = {
        ...(filters.createdAfter ? { gte: filters.createdAfter } : {}),
        ...(filters.createdBefore ? { lt: filters.createdBefore } : {}),
      };
    }

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

  // All currently-open tickets, oldest first, with their status tag joined. Backs the
  // Overdue and Age-Breakdown drill-down buttons (both classify/bucket in memory).
  async listOpenWithTag(): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      where: { closed: false },
      include: { statusTag: true },
      orderBy: { createdAt: "asc" },
    });
  }

  // ---- Response-time metrics ----

  // ---- CSAT ----

  // Claims the per-close-cycle rating prompt. The null-guard makes it single-winner:
  // true = this caller won and should send the prompt, false = already prompted this
  // cycle (e.g. a Close landing right after a Resolve).
  async markCsatPrompted(threadId: string): Promise<boolean> {
    const result = await this.prisma.ticket.updateMany({
      where: { threadId, csatPromptedAt: null },
      data: { csatPromptedAt: new Date() },
    });
    return result.count > 0;
  }

  // Re-arm the rating prompt when a ticket reopens, so the next resolve/close
  // prompts again. Only for unrated tickets — a recorded score is final
  // (recordCsat is single-winner), so re-prompting a rated customer is noise.
  async resetCsatPrompt(threadId: string): Promise<void> {
    await this.prisma.ticket.updateMany({
      where: { threadId, csatScore: null },
      data: { csatPromptedAt: null },
    });
  }

  // Records a 1-5 rating. Returns false when the ticket was already rated (the null
  // guard makes double-clicks and parallel submissions single-winner).
  async recordCsat(threadId: string, score: number): Promise<boolean> {
    const result = await this.prisma.ticket.updateMany({
      where: { threadId, csatScore: null },
      data: { csatScore: score, csatRatedAt: new Date() },
    });
    return result.count > 0;
  }

  // Stores the optional free-text comment; only the first comment sticks.
  async setCsatComment(threadId: string, comment: string): Promise<boolean> {
    const result = await this.prisma.ticket.updateMany({
      where: { threadId, csatScore: { not: null }, csatComment: null },
      data: { csatComment: comment },
    });
    return result.count > 0;
  }

  // ---- Status change history ----
  // Emoji+label are snapshotted as text so history survives tag edits and
  // deletions. Legacy rows may carry kind "PRIORITY" — inert history from the
  // removed priority axis; nothing reads them.

  async addTagChange(input: {
    ticketThreadId: string;
    kind: TagChangeKind;
    fromEmoji?: string | null;
    fromLabel?: string | null;
    toEmoji: string;
    toLabel: string;
    actorId?: string | null;
    actorName: string;
  }): Promise<void> {
    await this.prisma.ticketTagChange.create({
      data: {
        ticketThreadId: input.ticketThreadId,
        kind: input.kind,
        fromEmoji: input.fromEmoji ?? null,
        fromLabel: input.fromLabel ?? null,
        toEmoji: input.toEmoji,
        toLabel: input.toLabel,
        actorId: input.actorId ?? null,
        actorName: input.actorName,
      },
    });
  }

}
