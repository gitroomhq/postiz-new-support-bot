import { PrismaClient } from "../generated/prisma/client";

// One ticket_ai_runs row per successful staff /ai run (ask|cause|draft|summarize),
// replayed as a "Previous AI runs" context section into later runs on the same
// ticket. Distinct from ai_runs, which is the metrics-only cost ledger.
export interface TicketAiRunRecord {
  ticketThreadId: string;
  subcommand: string; // "ask" | "cause" | "draft" | "summarize"
  input?: string | null; // the ask question / draft instructions
  result: string;
  invokerId: string;
  invokerName: string;
  model: string;
}

export interface TicketAiRunRow extends TicketAiRunRecord {
  id: string;
  createdAt: Date;
}

// How long run history survives after the ticket closes. A reopen inside the
// window flips `closed` back off, which keeps the rows.
export const TICKET_AI_RUN_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export class TicketAiRunStore {
  constructor(private prisma: PrismaClient) {}

  async record(run: TicketAiRunRecord): Promise<string> {
    const row = await this.prisma.ticketAiRun.create({
      data: {
        ticketThreadId: run.ticketThreadId,
        subcommand: run.subcommand,
        input: run.input ?? null,
        result: run.result,
        invokerId: run.invokerId,
        invokerName: run.invokerName,
        model: run.model,
      },
    });
    return row.id;
  }

  // Newest-first — the prompt renderer re-sorts chronologically for display.
  async listRecent(ticketThreadId: string, limit: number): Promise<TicketAiRunRow[]> {
    return this.prisma.ticketAiRun.findMany({
      where: { ticketThreadId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  // A posted draft lands in the thread transcript, so its history row would
  // only duplicate context — drop it. Discarded drafts stay (rejected angles
  // are still signal for the next run).
  async delete(id: string): Promise<void> {
    await this.prisma.ticketAiRun.deleteMany({ where: { id } });
  }

  // Purge sweep: drop run history once the ticket has been closed for the full
  // retention window. The run-age condition keeps a fresh run on a long-closed
  // ticket alive for its own 3 days instead of vanishing on the next sweep.
  async purgeForClosedTickets(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - TICKET_AI_RUN_RETENTION_MS);
    return this.prisma.$executeRaw`
      DELETE FROM "ticket_ai_runs"
      WHERE "createdAt" < ${cutoff}
        AND "ticketThreadId" IN (
          SELECT "threadId" FROM "tickets" WHERE "closed" = true AND "closedAt" < ${cutoff}
        )`;
  }
}
