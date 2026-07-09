import { PrismaClient, Ticket, StatusTag, TicketNote, TicketTagChange } from "../generated/prisma/client";

export type TicketWithTag = Ticket & { statusTag: StatusTag | null };

export type TagChangeKind = "STATUS" | "PRIORITY";

export interface CreateTicketInput {
  threadId: string;
  channelId: string;
  statusTagId: string;
  priorityTagId?: string | null;
  customerId?: string | null;
  customerDisplayName?: string | null;
  categoryId?: string | null;
  question?: string | null;
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
        priorityTagId: input.priorityTagId ?? null,
        customerId: input.customerId ?? null,
        customerDisplayName: input.customerDisplayName ?? null,
        categoryId: input.categoryId ?? null,
        question: input.question ?? null,
      },
    });
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

  // Closed tickets whose quiet period has elapsed. Guarded on closed + closesThread so a
  // ticket that was properly reopened (or whose tag changed) never re-locks by accident.
  // A ticket paused via /reminders off never re-locks until its status changes.
  async listRecloseDue(now: Date): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      where: { recloseAt: { lte: now }, closed: true, remindersPaused: false, statusTag: { closesThread: true } },
      include: { statusTag: true },
    });
  }

  // null = back to the base tier (tier 0 of the escalation ladder).
  async setEscalationTier(threadId: string, escalationTierId: string | null): Promise<void> {
    await this.prisma.ticket.update({ where: { threadId }, data: { escalationTierId } });
  }

  // Priority is a pure label: unlike setStatus it never touches reminder cadence,
  // closed state, or the re-close timer.
  async setPriority(threadId: string, priorityTagId: string): Promise<void> {
    await this.prisma.ticket.update({ where: { threadId }, data: { priorityTagId } });
  }

  // /reminders on|off. The pause suppresses reminders, auto-close and re-close for
  // this ticket; setStatus() clears it on the next status change.
  async setRemindersPaused(threadId: string, paused: boolean): Promise<void> {
    await this.prisma.ticket.update({ where: { threadId }, data: { remindersPaused: paused } });
  }

  async recordReminder(threadId: string): Promise<void> {
    await this.prisma.ticket.update({
      where: { threadId },
      data: { lastReminderAt: new Date(), reminderCount: { increment: 1 } },
    });
  }

  // Persist the verbatim final AI answer so a filed GitHub issue is just the
  // question + answer (no brittle re-scan of thread embeds).
  async setAiAnswer(threadId: string, aiAnswer: string): Promise<void> {
    await this.prisma.ticket.update({ where: { threadId }, data: { aiAnswer } });
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

  // Open tickets whose current status has reminders enabled and that aren't
  // paused via /reminders off.
  async listRemindable(): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      where: { closed: false, remindersPaused: false, statusTag: { reminderEnabled: true } },
      include: { statusTag: true },
    });
  }

  // Tickets currently sitting in a given status tag. Used to auto-close Resolved
  // tickets after a quiet period (Resolved tickets carry closed=true, so we key off
  // the status tag rather than the closed flag). Tickets paused via /reminders off
  // are excluded so they never auto-close.
  async listInStatus(statusTagId: string): Promise<TicketWithTag[]> {
    return this.prisma.ticket.findMany({
      where: { statusTagId, remindersPaused: false },
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
      priorityTagId?: string;
      closed?: boolean;
      customerIds?: string[];
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
      priorityTagId?: string;
      closed?: boolean;
      customerId?: { in: string[] };
      OR?: object[];
      createdAt?: { gte?: Date; lt?: Date };
    } = {};
    if (filters.categoryId) where.categoryId = filters.categoryId;
    if (filters.statusTagId) where.statusTagId = filters.statusTagId;
    if (filters.priorityTagId) where.priorityTagId = filters.priorityTagId;
    if (filters.closed !== undefined) where.closed = filters.closed;
    if (filters.customerIds) where.customerId = { in: filters.customerIds };
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

  // Ticket counts grouped by current status tag, category AND closed-state, in one pass.
  // The report treats the `closed` boolean as the source of truth for open/done (matching
  // every other metric) and derives every breakdown from this.
  async statusCategoryBreakdown(): Promise<
    { statusTagId: string | null; categoryId: string | null; closed: boolean; count: number }[]
  > {
    const rows = await this.prisma.ticket.groupBy({
      by: ["statusTagId", "categoryId", "closed"],
      _count: { _all: true },
    });
    return rows.map((r) => ({
      statusTagId: r.statusTagId,
      categoryId: r.categoryId,
      closed: r.closed,
      count: r._count._all,
    }));
  }

  async countOpenedSince(since: Date): Promise<number> {
    return this.prisma.ticket.count({ where: { createdAt: { gte: since } } });
  }

  async countClosedSince(since: Date): Promise<number> {
    return this.prisma.ticket.count({ where: { closedAt: { gte: since } } });
  }

  // Overdue = still open (closed=false covers both "resolved" and "closed") and created
  // more than the configured threshold ago. cutoff = now - thresholdDays.
  async countOverdue(cutoff: Date): Promise<number> {
    return this.prisma.ticket.count({ where: { closed: false, createdAt: { lt: cutoff } } });
  }

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

  // Stamps the first support reply. updateMany + null-guard makes it race-safe and
  // idempotent: only the first stamp ever wins.
  async setFirstResponse(threadId: string, at: Date): Promise<void> {
    await this.prisma.ticket.updateMany({
      where: { threadId, firstResponseAt: null },
      data: { firstResponseAt: at },
    });
  }

  // Median time-to-first-response and time-to-resolution (seconds) over tickets closed in
  // the window. percentile_cont skips NULL firstResponseAt rows for the first aggregate.
  async responseTimeMedians(since: Date): Promise<{ firstResponseS: number | null; resolutionS: number | null }> {
    const rows = await this.prisma.$queryRaw<{ first_response_s: number | null; resolution_s: number | null }[]>`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt"))) AS first_response_s,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("closedAt" - "createdAt"))) AS resolution_s
      FROM "tickets"
      WHERE "closedAt" >= ${since}`;
    const row = rows[0];
    return {
      firstResponseS: row?.first_response_s != null ? Number(row.first_response_s) : null,
      resolutionS: row?.resolution_s != null ? Number(row.resolution_s) : null,
    };
  }

  async countAwaitingFirstResponse(): Promise<number> {
    return this.prisma.ticket.count({
      where: { closed: false, firstResponseAt: null, customerId: { not: null } },
    });
  }

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

  // All-time rating aggregates (the Feedback drill-down shows the full history, not a window).
  async csatStats(): Promise<CsatStats> {
    const [grouped, prompted] = await Promise.all([
      this.prisma.ticket.groupBy({
        by: ["csatScore"],
        where: { csatScore: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.ticket.count({ where: { csatPromptedAt: { not: null } } }),
    ]);

    const counts = new Map<number, number>();
    let rated = 0;
    let sum = 0;
    for (const row of grouped) {
      if (row.csatScore == null) continue;
      counts.set(row.csatScore, row._count._all);
      rated += row._count._all;
      sum += row.csatScore * row._count._all;
    }
    return { counts, rated, prompted, average: rated > 0 ? sum / rated : null };
  }

  // Most recent CSAT feedback (rated tickets, with or without a comment), newest first,
  // for the paginated Feedback drill-down. Selects the thread + context so each row can
  // deep-link to its ticket. The WHERE mirrors csatStats() so their totals stay in sync —
  // change both together if the predicate ever moves.
  async recentCsatFeedback(
    limit: number,
    offset: number
  ): Promise<Pick<Ticket, "threadId" | "question" | "customerDisplayName" | "csatScore" | "csatComment" | "csatRatedAt">[]> {
    return this.prisma.ticket.findMany({
      where: { csatScore: { not: null } },
      orderBy: { csatRatedAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        threadId: true,
        question: true,
        customerDisplayName: true,
        csatScore: true,
        csatComment: true,
        csatRatedAt: true,
      },
    });
  }

  // ---- Staff notes ----

  async addNote(ticketThreadId: string, authorId: string, authorName: string, text: string): Promise<void> {
    await this.prisma.ticketNote.create({ data: { ticketThreadId, authorId, authorName, text } });
  }

  async listNotes(ticketThreadId: string, limit = 15): Promise<TicketNote[]> {
    return this.prisma.ticketNote.findMany({
      where: { ticketThreadId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  // Full note history oldest-first (Intercom backfill; listNotes caps at 15 for /note list).
  async listAllNotes(ticketThreadId: string): Promise<TicketNote[]> {
    return this.prisma.ticketNote.findMany({
      where: { ticketThreadId },
      orderBy: { createdAt: "asc" },
    });
  }

  // ---- Status/priority change history ----
  // Emoji+label are snapshotted as text so /status history and /priority history
  // survive tag edits and deletions.

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

  async listTagChanges(ticketThreadId: string, kind: TagChangeKind, limit = 15): Promise<TicketTagChange[]> {
    return this.prisma.ticketTagChange.findMany({
      where: { ticketThreadId, kind },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  // Full status+priority history oldest-first (Intercom backfill).
  async listAllTagChanges(ticketThreadId: string): Promise<TicketTagChange[]> {
    return this.prisma.ticketTagChange.findMany({
      where: { ticketThreadId },
      orderBy: { createdAt: "asc" },
    });
  }
}
