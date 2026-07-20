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

  // Preload for the inactivity sweeper: every imported conversation id in one
  // indexed query (the sweep pages ALL open conversations, so a Set beats
  // per-item lookups; ids-only memory is trivial at feedback volume).
  async listImportedConversationIds(): Promise<string[]> {
    const rows = await this.prisma.sentryFeedbackImport.findMany({
      where: { intercomConversationId: { not: null } },
      select: { intercomConversationId: true },
    });
    return rows.map((r) => r.intercomConversationId).filter((id): id is string => !!id);
  }

  // Chunk variant for the SLA enforcer's batched preload loop.
  async filterImportedConversationIds(conversationIds: string[]): Promise<string[]> {
    if (conversationIds.length === 0) return [];
    const rows = await this.prisma.sentryFeedbackImport.findMany({
      where: { intercomConversationId: { in: conversationIds } },
      select: { intercomConversationId: true },
    });
    return rows.map((r) => r.intercomConversationId).filter((id): id is string => !!id);
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
