import { PrismaClient } from "../generated/prisma/client";

// One ai_runs row per AI run: interactive CLI runs, direct-API light runs, and
// one aggregated row per scoring batch. Powers historical cost queries (the
// scoring daily-budget cap) alongside the Influx export.
export interface AiRunRecord {
  agentName: string;
  kind: string; // customer_qa | staff_command | ticket_scoring
  source: string; // cli | api | batch
  model: string;
  outcome: string;
  sessionId?: string | null;
  batchId?: string | null;
  numTurns?: number | null;
  durationMs?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  toolCalls?: number;
  toolErrors?: number;
}

export class AiRunStore {
  constructor(private prisma: PrismaClient) {}

  async record(run: AiRunRecord): Promise<void> {
    await this.prisma.aiRun.create({
      data: {
        agentName: run.agentName,
        kind: run.kind,
        source: run.source,
        model: run.model,
        outcome: run.outcome,
        sessionId: run.sessionId ?? null,
        batchId: run.batchId ?? null,
        numTurns: run.numTurns ?? null,
        durationMs: run.durationMs ?? null,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cacheReadTokens: run.cacheReadTokens,
        cacheCreationTokens: run.cacheCreationTokens,
        costUsd: run.costUsd,
        toolCalls: run.toolCalls ?? 0,
        toolErrors: run.toolErrors ?? 0,
      },
    });
  }

  // Total spend since `since`, optionally per kind — backs the scoring
  // daily-budget guardrail.
  async costSince(since: Date, kind?: string): Promise<number> {
    const agg = await this.prisma.aiRun.aggregate({
      _sum: { costUsd: true },
      where: { createdAt: { gte: since }, ...(kind ? { kind } : {}) },
    });
    return agg._sum.costUsd ?? 0;
  }
}
