import { Prisma, PrismaClient, TicketScore, ScoringBatch, Ticket } from "../generated/prisma/client";
import { TicketScoreResultType } from "./scoringPrompt";

const MAX_ATTEMPTS = 3;

export interface ScoreAggregateStats {
  scoredCount: number;
  avgCx: number | null;
  avgTone: number | null;
  avgClarity: number | null;
  avgCorrectness: number | null;
  resolved: number;
  workaround: number;
  unresolved: number;
  fcrCount: number;
}

export class TicketScoreStore {
  constructor(private prisma: PrismaClient) {}

  // Closed tickets that still need scoring: no score row at all, or a FAILED row
  // below the attempt cap. Oldest-first so the historical backfill drains
  // chronologically (interval batches are small enough that order is moot).
  async listUnscoredClosed(limit: number): Promise<Ticket[]> {
    const rows = await this.prisma.$queryRaw<{ threadId: string }[]>`
      SELECT t."threadId"
      FROM "tickets" t
      LEFT JOIN "ticket_scores" s ON s."ticketThreadId" = t."threadId"
      WHERE t."closed" = true
        AND (s."id" IS NULL OR (s."status" = 'FAILED' AND s."attempts" < ${MAX_ATTEMPTS}))
      ORDER BY t."createdAt" ASC
      LIMIT ${limit}`;
    if (rows.length === 0) return [];
    const tickets = await this.prisma.ticket.findMany({
      where: { threadId: { in: rows.map((r) => r.threadId) } },
    });
    const order = new Map(rows.map((r, i) => [r.threadId, i]));
    return tickets.sort((a, b) => (order.get(a.threadId) ?? 0) - (order.get(b.threadId) ?? 0));
  }

  async countUnscoredClosed(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "tickets" t
      LEFT JOIN "ticket_scores" s ON s."ticketThreadId" = t."threadId"
      WHERE t."closed" = true
        AND (s."id" IS NULL OR (s."status" = 'FAILED' AND s."attempts" < ${MAX_ATTEMPTS}))`;
    return Number(rows[0]?.count ?? 0);
  }

  async get(ticketThreadId: string): Promise<TicketScore | null> {
    return this.prisma.ticketScore.findUnique({ where: { ticketThreadId } });
  }

  async getTicket(threadId: string): Promise<Ticket | null> {
    return this.prisma.ticket.findUnique({ where: { threadId } });
  }

  // PENDING rows are written at submit time; the unique ticketThreadId +
  // skipDuplicates makes concurrent submits single-winner. Retried FAILED rows
  // are flipped back to PENDING instead (createMany would skip them). Each row
  // snapshots the transcript's staff display names so the model's staff[]
  // output can be validated when the batch result arrives (possibly after a
  // restart — the transcript itself is not persisted).
  async markPending(
    entries: Array<{ ticketThreadId: string; staffNames: string[] }>,
    batchId: string,
    model: string
  ): Promise<void> {
    const ids = entries.map((e) => e.ticketThreadId);
    await this.prisma.$transaction([
      this.prisma.ticketScore.updateMany({
        where: { ticketThreadId: { in: ids }, status: "FAILED" },
        data: { status: "PENDING", batchId, model, error: null },
      }),
      this.prisma.ticketScore.createMany({
        data: entries.map((e) => ({
          ticketThreadId: e.ticketThreadId,
          status: "PENDING",
          batchId,
          model,
          staffNames: e.staffNames,
        })),
        skipDuplicates: true,
      }),
      // Pre-existing rows (the retried-FAILED path) were skipped by createMany;
      // refresh their snapshot. Scoped to this batch so rows claimed by a
      // concurrent submit are left alone.
      ...entries.map((e) =>
        this.prisma.ticketScore.updateMany({
          where: { ticketThreadId: e.ticketThreadId, batchId },
          data: { staffNames: e.staffNames },
        })
      ),
    ]);
  }

  // staffNames snapshots for a batch's rows: threadId → names, or null when the
  // row predates the snapshot column (reconciliation passes those through).
  async staffNamesForBatch(batchId: string): Promise<Map<string, string[] | null>> {
    const rows = await this.prisma.ticketScore.findMany({
      where: { batchId },
      select: { ticketThreadId: true, staffNames: true },
    });
    return new Map(
      rows.map((r) => [
        r.ticketThreadId,
        Array.isArray(r.staffNames) ? r.staffNames.filter((n): n is string => typeof n === "string") : null,
      ])
    );
  }

  async recordScored(
    ticketThreadId: string,
    parsed: TicketScoreResultType,
    usage: { inputTokens: number; outputTokens: number },
    costUsd: number
  ): Promise<void> {
    await this.prisma.ticketScore.update({
      where: { ticketThreadId },
      data: {
        status: "SCORED",
        attempts: { increment: 1 },
        cxScore: parsed.cx_score,
        sentimentStart: parsed.customer_sentiment_start,
        sentimentEnd: parsed.customer_sentiment_end,
        agentTone: parsed.agent_overall.tone,
        agentClarity: parsed.agent_overall.clarity,
        agentCorrectness: parsed.agent_overall.correctness,
        resolution: parsed.resolution,
        fcr: parsed.first_contact_resolution,
        escalationNeeded: parsed.escalation_needed,
        topic: parsed.topic,
        rootCause: parsed.root_cause,
        summary: parsed.summary,
        staffScores: parsed.staff as unknown as Prisma.InputJsonValue,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
        error: null,
        scoredAt: new Date(),
      },
    });
  }

  async recordFailed(ticketThreadId: string, error: string): Promise<void> {
    await this.prisma.ticketScore.update({
      where: { ticketThreadId },
      data: { status: "FAILED", attempts: { increment: 1 }, error: error.slice(0, 1_000) },
    });
  }

  // Terminal skip (deleted thread, trivial transcript) — never retried.
  async recordSkipped(ticketThreadId: string, reason: string): Promise<void> {
    await this.prisma.ticketScore.upsert({
      where: { ticketThreadId },
      create: { ticketThreadId, status: "SKIPPED", error: reason },
      update: { status: "SKIPPED", error: reason },
    });
  }

  // Re-score on re-close: a reopened ticket's score is stale — drop the row so
  // the next batch after re-close scores the fuller transcript.
  async resetForRescore(ticketThreadId: string): Promise<void> {
    await this.prisma.ticketScore.deleteMany({ where: { ticketThreadId } });
  }

  async createBatch(input: {
    anthropicBatchId: string;
    purpose: string;
    model: string;
    requestCount: number;
  }): Promise<ScoringBatch> {
    return this.prisma.scoringBatch.create({ data: input });
  }

  async pendingBatches(): Promise<ScoringBatch[]> {
    return this.prisma.scoringBatch.findMany({ where: { status: "SUBMITTED" }, orderBy: { submittedAt: "asc" } });
  }

  async closeBatch(
    anthropicBatchId: string,
    counts: { succeeded: number; errored: number; expired: number },
    costUsd: number
  ): Promise<void> {
    await this.prisma.scoringBatch.update({
      where: { anthropicBatchId },
      data: {
        status: "ENDED",
        succeededCount: counts.succeeded,
        erroredCount: counts.errored,
        expiredCount: counts.expired,
        costUsd,
        endedAt: new Date(),
      },
    });
  }

  async failBatch(anthropicBatchId: string, error: string): Promise<void> {
    await this.prisma.scoringBatch.update({
      where: { anthropicBatchId },
      data: { status: "FAILED", endedAt: new Date() },
    });
    // Their PENDING rows become retryable in a later batch.
    await this.prisma.ticketScore.updateMany({
      where: { batchId: anthropicBatchId, status: "PENDING" },
      data: { status: "FAILED", attempts: { increment: 1 }, error: error.slice(0, 1_000) },
    });
  }

  // PENDING rows left behind by an ended batch (result missing for their
  // custom_id) — flip to FAILED/retryable so they can't wedge forever.
  async resetOrphanedPending(anthropicBatchId: string): Promise<number> {
    const res = await this.prisma.ticketScore.updateMany({
      where: { batchId: anthropicBatchId, status: "PENDING" },
      data: { status: "FAILED", attempts: { increment: 1 }, error: "no result in ended batch" },
    });
    return res.count;
  }

  // Aggregates for /report: all-time when since is undefined, else the window.
  async aggregateStats(since?: Date): Promise<ScoreAggregateStats> {
    const where = { status: "SCORED", ...(since ? { scoredAt: { gte: since } } : {}) };
    const [agg, resolutionGroups, fcrCount] = await Promise.all([
      this.prisma.ticketScore.aggregate({
        where,
        _count: { _all: true },
        _avg: { cxScore: true, agentTone: true, agentClarity: true, agentCorrectness: true },
      }),
      this.prisma.ticketScore.groupBy({ by: ["resolution"], where, _count: { _all: true } }),
      this.prisma.ticketScore.count({ where: { ...where, fcr: true } }),
    ]);
    const byResolution = new Map(resolutionGroups.map((g) => [g.resolution, g._count._all]));
    return {
      scoredCount: agg._count._all,
      avgCx: agg._avg.cxScore,
      avgTone: agg._avg.agentTone,
      avgClarity: agg._avg.agentClarity,
      avgCorrectness: agg._avg.agentCorrectness,
      resolved: byResolution.get("resolved") ?? 0,
      workaround: byResolution.get("workaround") ?? 0,
      unresolved: byResolution.get("unresolved") ?? 0,
      fcrCount,
    };
  }

  // Worst-scored recent tickets for the /report drill-down.
  async worstRecent(limit: number, since?: Date): Promise<TicketScore[]> {
    return this.prisma.ticketScore.findMany({
      where: { status: "SCORED", ...(since ? { scoredAt: { gte: since } } : {}) },
      orderBy: [{ cxScore: "asc" }, { scoredAt: "desc" }],
      take: limit,
    });
  }

  // Total scoring spend since `since` (budget guardrail input, summed from the
  // per-ticket costs so single scoreOneNow runs count too).
  async scoringCostSince(since: Date): Promise<number> {
    const agg = await this.prisma.ticketScore.aggregate({
      _sum: { costUsd: true },
      where: { scoredAt: { gte: since } },
    });
    return agg._sum.costUsd ?? 0;
  }
}
