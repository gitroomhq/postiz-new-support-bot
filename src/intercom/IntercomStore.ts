import { PrismaClient, IntercomLink, IntercomOutboxEvent } from "../generated/prisma/client";
import { OutboxEventType, OutboxPayload } from "./types";

// Persistence for the Intercom bridge: thread↔conversation/ticket links, the
// durable outbox, and the echo-part ledger. Events are executed in per-ticket
// FIFO order — the drain query returns only the head (lowest seq) PENDING
// event per ticket, so a failing event blocks its own ticket's queue and
// nothing else.
export class IntercomStore {
  constructor(private prisma: PrismaClient) {}

  // ---- Links ----

  async getLink(ticketThreadId: string): Promise<IntercomLink | null> {
    return this.prisma.intercomLink.findUnique({ where: { ticketThreadId } });
  }

  async getLinkByConversationId(conversationId: string): Promise<IntercomLink | null> {
    return this.prisma.intercomLink.findUnique({ where: { conversationId } });
  }

  async getLinkByTicketId(ticketId: string): Promise<IntercomLink | null> {
    return this.prisma.intercomLink.findUnique({ where: { ticketId } });
  }

  // Written as soon as the conversation exists; ticketId follows once the
  // convert step succeeds (setTicketId). Upsert so a 404 self-heal rebuild
  // replaces the stale row and resets the dampers.
  async createLink(
    ticketThreadId: string,
    contactId: string,
    contactExternalId: string,
    conversationId: string
  ): Promise<IntercomLink> {
    return this.prisma.intercomLink.upsert({
      where: { ticketThreadId },
      create: { ticketThreadId, contactId, contactExternalId, conversationId },
      update: {
        contactId,
        contactExternalId,
        conversationId,
        ticketId: null,
        lastSyncedStateId: null,
        lastSyncedOpen: null,
        agentWarnedAt: null,
      },
    });
  }

  // null clears the ticket half of the link (404 self-heal re-converts afterwards).
  async setTicketId(ticketThreadId: string, ticketId: string | null): Promise<void> {
    await this.prisma.intercomLink.updateMany({ where: { ticketThreadId }, data: { ticketId } });
  }

  async deleteLink(ticketThreadId: string): Promise<void> {
    await this.prisma.intercomLink.deleteMany({ where: { ticketThreadId } });
  }

  // Returns true only for the caller that claims the warning (null-guarded), so
  // concurrent webhook deliveries produce exactly one warning note.
  async markAgentWarned(ticketThreadId: string): Promise<boolean> {
    const result = await this.prisma.intercomLink.updateMany({
      where: { ticketThreadId, agentWarnedAt: null },
      data: { agentWarnedAt: new Date() },
    });
    return result.count > 0;
  }

  async setLastSyncedStateId(ticketThreadId: string, stateId: string | null): Promise<void> {
    await this.prisma.intercomLink.updateMany({
      where: { ticketThreadId },
      data: { lastSyncedStateId: stateId },
    });
  }

  async setLastSyncedOpen(ticketThreadId: string, state: "open" | "closed"): Promise<void> {
    await this.prisma.intercomLink.updateMany({
      where: { ticketThreadId },
      data: { lastSyncedOpen: state },
    });
  }

  async countLinks(): Promise<number> {
    return this.prisma.intercomLink.count();
  }

  // Snapshot of every bridged object (the remote-wipe walks this).
  async listAllLinks(): Promise<IntercomLink[]> {
    return this.prisma.intercomLink.findMany({ orderBy: { createdAt: "asc" } });
  }

  // ---- Echo-part ledger ----
  // Intercom has no writable content stamp, so echo suppression is id-based:
  // the outbox records every part it creates, and the webhook handler claims
  // each part it sees exactly once. A claim conflict = our own echo or a
  // duplicate delivery — drop it. Identity-independent by design (the bridge
  // may author as Operator OR as a real human admin).

  async recordEchoPart(kind: "c" | "t", partId: string, ticketThreadId: string): Promise<void> {
    await this.prisma.intercomEchoPart
      .create({ data: { kind, partId, ticketThreadId } })
      .catch((e) => {
        if ((e as { code?: string }).code === "P2002") return; // already recorded
        throw e;
      });
  }

  // Atomically claim a part. true = first sighting (process it); false = the
  // bridge created it (echo) or another delivery already claimed it (duplicate).
  async claimPart(kind: "c" | "t", partId: string, ticketThreadId: string): Promise<boolean> {
    try {
      await this.prisma.intercomEchoPart.create({ data: { kind, partId, ticketThreadId } });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return false;
      throw e;
    }
  }

  async cleanupEchoParts(olderThan: Date): Promise<number> {
    const result = await this.prisma.intercomEchoPart.deleteMany({
      where: { createdAt: { lt: olderThan } },
    });
    return result.count;
  }

  // ---- Outbox ----

  async enqueue(ticketThreadId: string, type: OutboxEventType, payload: OutboxPayload): Promise<void> {
    await this.prisma.intercomOutboxEvent.create({
      data: { ticketThreadId, type, payload: payload as object },
    });
  }

  // Backfill uses this so a ticket is either fully enqueued or not at all —
  // re-runs after a crash can then safely key off hasLinkOrPendingEnsure.
  async enqueueMany(events: Array<{ ticketThreadId: string; type: OutboxEventType; payload: OutboxPayload }>): Promise<void> {
    await this.prisma.intercomOutboxEvent.createMany({
      data: events.map((e) => ({ ticketThreadId: e.ticketThreadId, type: e.type, payload: e.payload as object })),
    });
  }

  async hasPendingEnsure(ticketThreadId: string): Promise<boolean> {
    const count = await this.prisma.intercomOutboxEvent.count({
      where: { ticketThreadId, type: "ensure", status: "PENDING" },
    });
    return count > 0;
  }

  async hasLinkOrPendingEnsure(ticketThreadId: string): Promise<boolean> {
    if (await this.getLink(ticketThreadId)) return true;
    return this.hasPendingEnsure(ticketThreadId);
  }

  // Head (lowest seq) PENDING event per ticket, due now, oldest tickets first.
  async listDueHeads(limit: number): Promise<IntercomOutboxEvent[]> {
    return this.prisma.$queryRawUnsafe<IntercomOutboxEvent[]>(
      `SELECT * FROM (
         SELECT DISTINCT ON ("ticketThreadId") *
         FROM "intercom_outbox"
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
    await this.prisma.intercomOutboxEvent.deleteMany({ where: { id } });
  }

  async markRetry(id: string, attempts: number, nextAttemptAt: Date, lastError: string): Promise<void> {
    await this.prisma.intercomOutboxEvent.updateMany({
      where: { id },
      data: { attempts, nextAttemptAt, lastError: lastError.slice(0, 1000) },
    });
  }

  async markDead(id: string, lastError: string): Promise<void> {
    await this.prisma.intercomOutboxEvent.updateMany({
      where: { id },
      data: { status: "DEAD", lastError: lastError.slice(0, 1000) },
    });
  }

  // Re-queues dead-lettered events (config panel "Retry failed" button).
  async retryDead(): Promise<number> {
    const result = await this.prisma.intercomOutboxEvent.updateMany({
      where: { status: "DEAD" },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date() },
    });
    return result.count;
  }

  async counts(): Promise<{ pending: number; dead: number }> {
    const [pending, dead] = await Promise.all([
      this.prisma.intercomOutboxEvent.count({ where: { status: "PENDING" } }),
      this.prisma.intercomOutboxEvent.count({ where: { status: "DEAD" } }),
    ]);
    return { pending, dead };
  }

  // Full bridge-state wipe (links + queue + echo ledger). Touches NOTHING in
  // Intercom itself — use when the Intercom side was cleared/recreated and the
  // local bookkeeping is stale; the next backfill rebuilds everything.
  async resetAll(): Promise<{ links: number; events: number; parts: number }> {
    const [links, events, parts] = await this.prisma.$transaction([
      this.prisma.intercomLink.deleteMany(),
      this.prisma.intercomOutboxEvent.deleteMany(),
      this.prisma.intercomEchoPart.deleteMany(),
    ]);
    return { links: links.count, events: events.count, parts: parts.count };
  }
}
