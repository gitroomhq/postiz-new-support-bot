import { PrismaClient, SentryFeedbackImport } from "../generated/prisma/client";

// Ledger accessors for sentry_feedback_imports: dedup by Sentry issue id,
// exemption lookups by Intercom conversation id, and the /config counters.
export class SentryFeedbackStore {
  constructor(private prisma: PrismaClient) {}

  getByIssueId(sentryIssueId: string): Promise<SentryFeedbackImport | null> {
    return this.prisma.sentryFeedbackImport.findUnique({ where: { sentryIssueId } });
  }

  getByConversationId(intercomConversationId: string): Promise<SentryFeedbackImport | null> {
    return this.prisma.sentryFeedbackImport.findUnique({ where: { intercomConversationId } });
  }

  async insertImported(data: {
    sentryIssueId: string;
    sentryShortId: string | null;
    projectSlug: string | null;
    contactEmail: string;
    contactName: string | null;
    intercomContactId: string;
    intercomConversationId: string;
    pageUrl: string | null;
    feedbackAt: Date;
  }): Promise<void> {
    await this.prisma.sentryFeedbackImport.create({ data: { ...data, status: "imported" } });
  }

  async insertSkipped(data: {
    sentryIssueId: string;
    sentryShortId: string | null;
    projectSlug: string | null;
    contactName: string | null;
    pageUrl: string | null;
    feedbackAt: Date;
  }): Promise<void> {
    await this.prisma.sentryFeedbackImport.create({ data: { ...data, status: "skipped_no_email" } });
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
