import { PrismaClient, SentryFeedbackImport } from "../generated/prisma/client";

// Attempts before a failing submission is parked. Five 15-minute ticks is ~an
// hour of transient-outage tolerance; past that the failure is structural and
// re-running it every tick only costs Intercom calls.
export const MAX_ITEM_ATTEMPTS = 5;

// Ledger accessors for sentry_feedback_imports: dedup by Sentry issue id,
// exemption lookups by Intercom conversation id, and the /config counters.
export class SentryFeedbackStore {
  constructor(private prisma: PrismaClient) {}

  getByIssueId(sentryIssueId: string): Promise<SentryFeedbackImport | null> {
    return this.prisma.sentryFeedbackImport.findUnique({ where: { sentryIssueId } });
  }

  // Ledger state for a whole listing page in ONE indexed query. The walk used
  // to issue a findUnique per listed item, which put the dedup cost on the
  // same budget as the imports themselves.
  async ledgerStates(sentryIssueIds: string[]): Promise<Map<string, { status: string; attempts: number }>> {
    if (sentryIssueIds.length === 0) return new Map();
    const rows = await this.prisma.sentryFeedbackImport.findMany({
      where: { sentryIssueId: { in: sentryIssueIds } },
      select: { sentryIssueId: true, status: true, attempts: true },
    });
    return new Map(rows.map((r) => [r.sentryIssueId, { status: r.status, attempts: r.attempts }]));
  }

  getByConversationId(intercomConversationId: string): Promise<SentryFeedbackImport | null> {
    return this.prisma.sentryFeedbackImport.findUnique({ where: { intercomConversationId } });
  }

  // Upsert, not create: an item that failed on an earlier tick already has a
  // row (that row is what let the watermark move past it), so the import that
  // finally succeeds must update it in place rather than hit the unique index.
  async recordImported(data: {
    sentryIssueId: string;
    sentryShortId: string | null;
    projectSlug: string | null;
    contactEmail: string;
    contactName: string | null;
    intercomContactId: string;
    intercomConversationId: string;
    pageUrl: string | null;
    feedbackAt: Date;
    postizUserId?: string | null;
    postizOrgId?: string | null;
    stripeCustomerId?: string | null;
  }): Promise<void> {
    const { sentryIssueId, ...rest } = data;
    await this.prisma.sentryFeedbackImport.upsert({
      where: { sentryIssueId },
      create: { sentryIssueId, ...rest, status: "imported" },
      // importedAt moves to the real import time; lastError is history now.
      update: { ...rest, status: "imported", lastError: null, importedAt: new Date() },
    });
  }

  async recordSkipped(data: {
    sentryIssueId: string;
    sentryShortId: string | null;
    projectSlug: string | null;
    contactName: string | null;
    pageUrl: string | null;
    feedbackAt: Date;
    postizUserId?: string | null;
    postizOrgId?: string | null;
    stripeCustomerId?: string | null;
  }): Promise<void> {
    const { sentryIssueId, ...rest } = data;
    await this.prisma.sentryFeedbackImport.upsert({
      where: { sentryIssueId },
      create: { sentryIssueId, ...rest, status: "skipped_no_email" },
      update: { ...rest, status: "skipped_no_email", lastError: null },
    });
  }

  // The failure ledger. Writing this row is what unblocks the queue: the walk
  // treats it as a processed item, so the watermark advances past a submission
  // that cannot be imported instead of re-walking it forever.
  async recordFailure(data: {
    sentryIssueId: string;
    sentryShortId: string | null;
    projectSlug: string | null;
    feedbackAt: Date;
    error: string;
  }): Promise<void> {
    const { sentryIssueId, error, ...rest } = data;
    await this.prisma.sentryFeedbackImport.upsert({
      where: { sentryIssueId },
      create: { sentryIssueId, ...rest, status: "failed", attempts: 1, lastError: error },
      // status is deliberately NOT written here: a decoration that failed
      // after a successful import must never downgrade an imported row.
      update: { attempts: { increment: 1 }, lastError: error },
    });
  }

  // Failed rows that still have attempts left, oldest first. The walk never
  // retries them (they are behind the watermark by then) — this drain owns
  // every retry, so an item is attempted exactly once per tick.
  listFailedForRetry(limit: number): Promise<SentryFeedbackImport[]> {
    return this.prisma.sentryFeedbackImport.findMany({
      where: { status: "failed", attempts: { lt: MAX_ITEM_ATTEMPTS } },
      orderBy: { feedbackAt: "asc" },
      take: limit,
    });
  }

  // Panel counters: still retrying vs parked for good.
  async countFailed(): Promise<{ retryable: number; parked: number }> {
    const [retryable, parked] = await Promise.all([
      this.prisma.sentryFeedbackImport.count({ where: { status: "failed", attempts: { lt: MAX_ITEM_ATTEMPTS } } }),
      this.prisma.sentryFeedbackImport.count({ where: { status: "failed", attempts: { gte: MAX_ITEM_ATTEMPTS } } }),
    ]);
    return { retryable, parked };
  }

  // The newest failure reason, for the /config line that says WHY.
  async lastFailure(): Promise<{ sentryShortId: string | null; sentryIssueId: string; error: string | null } | null> {
    const row = await this.prisma.sentryFeedbackImport.findFirst({
      where: { status: "failed" },
      orderBy: { feedbackAt: "desc" },
      select: { sentryShortId: true, sentryIssueId: true, lastError: true },
    });
    return row ? { sentryShortId: row.sentryShortId, sentryIssueId: row.sentryIssueId, error: row.lastError } : null;
  }

  // Replay candidates: submissions dropped as anonymous that have never been
  // re-examined. Once the event reader understands the identity tags, most of
  // these have an email after all. Oldest first so the backlog drains in
  // submission order.
  listSkippedForRetry(limit: number): Promise<SentryFeedbackImport[]> {
    return this.prisma.sentryFeedbackImport.findMany({
      where: { status: "skipped_no_email", retriedAt: null },
      orderBy: { feedbackAt: "asc" },
      take: limit,
    });
  }

  countSkippedForRetry(): Promise<number> {
    return this.prisma.sentryFeedbackImport.count({ where: { status: "skipped_no_email", retriedAt: null } });
  }

  // One-shot marker: a row that still has no identity stays skipped instead of
  // being re-read on every tick for the rest of time.
  async markRetried(sentryIssueId: string, at: Date): Promise<void> {
    await this.prisma.sentryFeedbackImport.update({ where: { sentryIssueId }, data: { retriedAt: at } });
  }

  // A skipped row that turned out to have an identity after all: it becomes a
  // normal imported row in place, keeping its original id and feedbackAt.
  async promoteToImported(
    sentryIssueId: string,
    data: {
      contactEmail: string;
      contactName: string | null;
      intercomContactId: string;
      intercomConversationId: string;
      postizUserId?: string | null;
      postizOrgId?: string | null;
      stripeCustomerId?: string | null;
      retriedAt: Date;
    }
  ): Promise<void> {
    await this.prisma.sentryFeedbackImport.update({
      where: { sentryIssueId },
      data: { ...data, status: "imported", lastError: null },
    });
  }

  // Stamps the customer-ticket conversion onto the ledger row (powers the
  // sweeper's ticket-loop exemption and assignment parity).
  async setTicketId(sentryIssueId: string, intercomTicketId: string): Promise<void> {
    await this.prisma.sentryFeedbackImport.update({ where: { sentryIssueId }, data: { intercomTicketId } });
  }

  // Preload for the inactivity sweeper: every imported conversation/ticket id
  // pair in one indexed query (the sweep pages ALL open objects, so Sets beat
  // per-item lookups; ids-only memory is trivial at feedback volume).
  async listImportedRefs(): Promise<Array<{ conversationId: string; ticketId: string | null }>> {
    const rows = await this.prisma.sentryFeedbackImport.findMany({
      where: { intercomConversationId: { not: null } },
      select: { intercomConversationId: true, intercomTicketId: true },
    });
    return rows
      .filter((r): r is typeof r & { intercomConversationId: string } => !!r.intercomConversationId)
      .map((r) => ({ conversationId: r.intercomConversationId, ticketId: r.intercomTicketId }));
  }

  // Chunk variant for the SLA enforcer's batched preload loop.
  async mapImportedRefs(conversationIds: string[]): Promise<Array<{ conversationId: string; ticketId: string | null }>> {
    if (conversationIds.length === 0) return [];
    const rows = await this.prisma.sentryFeedbackImport.findMany({
      where: { intercomConversationId: { in: conversationIds } },
      select: { intercomConversationId: true, intercomTicketId: true },
    });
    return rows
      .filter((r): r is typeof r & { intercomConversationId: string } => !!r.intercomConversationId)
      .map((r) => ({ conversationId: r.intercomConversationId, ticketId: r.intercomTicketId }));
  }

  async statusCounts(): Promise<{ imported: number; skippedNoEmail: number }> {
    const groups = await this.prisma.sentryFeedbackImport.groupBy({ by: ["status"], _count: { _all: true } });
    const count = (status: string) => groups.find((g) => g.status === status)?._count._all ?? 0;
    return { imported: count("imported"), skippedNoEmail: count("skipped_no_email") };
  }

  async lastImportedAt(): Promise<Date | null> {
    const row = await this.prisma.sentryFeedbackImport.findFirst({
      where: { status: "imported" },
      orderBy: { importedAt: "desc" },
      select: { importedAt: true },
    });
    return row?.importedAt ?? null;
  }
}
