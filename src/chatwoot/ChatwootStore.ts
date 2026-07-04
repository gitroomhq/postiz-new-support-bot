import { PrismaClient, ChatwootLink, ChatwootOutboxEvent } from "../generated/prisma/client";
import { OutboxEventType, OutboxPayload } from "./types";

// Persistence for the Chatwoot bridge: thread↔conversation links plus the
// durable outbox. Events are executed in per-ticket FIFO order — the drain
// query returns only the head (lowest seq) PENDING event per ticket, so a
// failing event blocks its own ticket's queue and nothing else.
export class ChatwootStore {
  constructor(private prisma: PrismaClient) {}

  // ---- Links ----

  async getLink(ticketThreadId: string): Promise<ChatwootLink | null> {
    return this.prisma.chatwootLink.findUnique({ where: { ticketThreadId } });
  }

  async getLinkByConversationId(conversationId: number): Promise<ChatwootLink | null> {
    return this.prisma.chatwootLink.findUnique({ where: { conversationId } });
  }

  async createLink(
    ticketThreadId: string,
    contactId: number,
    contactSourceId: string,
    conversationId: number
  ): Promise<ChatwootLink> {
    return this.prisma.chatwootLink.upsert({
      where: { ticketThreadId },
      create: { ticketThreadId, contactId, contactSourceId, conversationId },
      update: { contactId, contactSourceId, conversationId, lastSyncedStatus: null, agentWarnedAt: null },
    });
  }

  async deleteLink(ticketThreadId: string): Promise<void> {
    await this.prisma.chatwootLink.deleteMany({ where: { ticketThreadId } });
  }

  // Returns true only for the caller that claims the warning (null-guarded), so
  // concurrent webhook deliveries produce exactly one warning note.
  async markAgentWarned(ticketThreadId: string): Promise<boolean> {
    const result = await this.prisma.chatwootLink.updateMany({
      where: { ticketThreadId, agentWarnedAt: null },
      data: { agentWarnedAt: new Date() },
    });
    return result.count > 0;
  }

  async setLastSyncedStatus(ticketThreadId: string, status: "open" | "resolved"): Promise<void> {
    await this.prisma.chatwootLink.updateMany({
      where: { ticketThreadId },
      data: { lastSyncedStatus: status },
    });
  }

  async countLinks(): Promise<number> {
    return this.prisma.chatwootLink.count();
  }

  // ---- Outbox ----

  async enqueue(ticketThreadId: string, type: OutboxEventType, payload: OutboxPayload): Promise<void> {
    await this.prisma.chatwootOutboxEvent.create({
      data: { ticketThreadId, type, payload: payload as object },
    });
  }

  // Backfill uses this so a ticket is either fully enqueued or not at all —
  // re-runs after a crash can then safely key off hasLinkOrPendingEnsure.
  async enqueueMany(events: Array<{ ticketThreadId: string; type: OutboxEventType; payload: OutboxPayload }>): Promise<void> {
    await this.prisma.chatwootOutboxEvent.createMany({
      data: events.map((e) => ({ ticketThreadId: e.ticketThreadId, type: e.type, payload: e.payload as object })),
    });
  }

  async hasPendingEnsure(ticketThreadId: string): Promise<boolean> {
    const count = await this.prisma.chatwootOutboxEvent.count({
      where: { ticketThreadId, type: "ensure_conversation", status: "PENDING" },
    });
    return count > 0;
  }

  async hasLinkOrPendingEnsure(ticketThreadId: string): Promise<boolean> {
    if (await this.getLink(ticketThreadId)) return true;
    return this.hasPendingEnsure(ticketThreadId);
  }

  // Head (lowest seq) PENDING event per ticket, due now, oldest tickets first.
  async listDueHeads(limit: number): Promise<ChatwootOutboxEvent[]> {
    return this.prisma.$queryRawUnsafe<ChatwootOutboxEvent[]>(
      `SELECT * FROM (
         SELECT DISTINCT ON ("ticketThreadId") *
         FROM "chatwoot_outbox"
         WHERE "status" = 'PENDING'
         ORDER BY "ticketThreadId", "seq" ASC
       ) heads
       WHERE "nextAttemptAt" <= NOW()
       ORDER BY "seq" ASC
       LIMIT $1`,
      limit
    );
  }

  async markSuccess(id: string): Promise<void> {
    await this.prisma.chatwootOutboxEvent.deleteMany({ where: { id } });
  }

  async markRetry(id: string, attempts: number, nextAttemptAt: Date, lastError: string): Promise<void> {
    await this.prisma.chatwootOutboxEvent.updateMany({
      where: { id },
      data: { attempts, nextAttemptAt, lastError: lastError.slice(0, 1000) },
    });
  }

  async markDead(id: string, lastError: string): Promise<void> {
    await this.prisma.chatwootOutboxEvent.updateMany({
      where: { id },
      data: { status: "DEAD", lastError: lastError.slice(0, 1000) },
    });
  }

  // Re-queues dead-lettered events (config panel "Retry failed" button).
  async retryDead(): Promise<number> {
    const result = await this.prisma.chatwootOutboxEvent.updateMany({
      where: { status: "DEAD" },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date() },
    });
    return result.count;
  }

  async counts(): Promise<{ pending: number; dead: number }> {
    const [pending, dead] = await Promise.all([
      this.prisma.chatwootOutboxEvent.count({ where: { status: "PENDING" } }),
      this.prisma.chatwootOutboxEvent.count({ where: { status: "DEAD" } }),
    ]);
    return { pending, dead };
  }

  // Full bridge-state wipe (links + queue). Touches NOTHING in Chatwoot itself —
  // use when the Chatwoot side was cleared/recreated and the local bookkeeping
  // is stale; the next backfill rebuilds everything from Discord.
  async resetAll(): Promise<{ links: number; events: number }> {
    const [links, events] = await this.prisma.$transaction([
      this.prisma.chatwootLink.deleteMany(),
      this.prisma.chatwootOutboxEvent.deleteMany(),
    ]);
    return { links: links.count, events: events.count };
  }
}
