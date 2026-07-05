import { PrismaClient, IntercomLink, IntercomOutboxEvent, IntercomInboxEvent } from "../generated/prisma/client";
import { OutboxEventType, OutboxPayload } from "./types";

// Relay body-hash dedup rides the echo-part table under this kind (partId =
// "<threadId>:<bodyHash>"). Fresh window: same body seen twice within it is a
// cross-topic duplicate.
const RELAY_KIND = "r";
const RELAY_FRESH_MS = 2 * 60 * 1000;

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

  // Rolls back a claimPart (used when the webhook handler defers a decision —
  // the retry must be able to claim the part again).
  async releaseClaim(kind: "c" | "t", partId: string): Promise<void> {
    await this.prisma.intercomEchoPart.deleteMany({ where: { kind, partId } });
  }

  async cleanupEchoParts(olderThan: Date): Promise<number> {
    const result = await this.prisma.intercomEchoPart.deleteMany({
      where: { createdAt: { lt: olderThan } },
    });
    return result.count;
  }

  // Cross-topic relay dedup (replaces the old in-memory map — survives
  // restarts). true = first sighting within the fresh window, relay it.
  async claimRelay(ticketThreadId: string, bodyHashHex: string): Promise<boolean> {
    const partId = `${ticketThreadId}:${bodyHashHex}`;
    try {
      await this.prisma.intercomEchoPart.create({ data: { kind: RELAY_KIND, partId, ticketThreadId } });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
      const existing = await this.prisma.intercomEchoPart.findUnique({
        where: { kind_partId: { kind: RELAY_KIND, partId } },
      });
      if (existing && Date.now() - existing.createdAt.getTime() < RELAY_FRESH_MS) return false;
      await this.prisma.intercomEchoPart.updateMany({
        where: { kind: RELAY_KIND, partId },
        data: { createdAt: new Date() },
      });
      return true;
    }
  }

  // ---- Pending posts (reserve → call → confirm echo handshake) ----
  // Written BEFORE the bridge posts to Intercom; deleted once the created
  // part id is in the echo ledger. The webhook handler treats a body-hash
  // match as "our own in-flight post".

  async reservePendingPost(ticketThreadId: string, kind: "c" | "t", bodyHashHex: string): Promise<string> {
    const row = await this.prisma.intercomPendingPost.create({
      data: { ticketThreadId, kind, bodyHash: bodyHashHex },
    });
    return row.id;
  }

  async deletePendingPost(id: string): Promise<void> {
    await this.prisma.intercomPendingPost.deleteMany({ where: { id } });
  }

  // Atomically consume a matching reservation (any kind — a ticket reply can
  // surface on the conversation topic). true = this part is the bridge's own.
  async matchAndDeletePendingPost(ticketThreadId: string, bodyHashHex: string): Promise<boolean> {
    const result = await this.prisma.intercomPendingPost.deleteMany({
      where: { ticketThreadId, bodyHash: bodyHashHex },
    });
    return result.count > 0;
  }

  async hasPendingPosts(ticketThreadId: string): Promise<boolean> {
    return (await this.prisma.intercomPendingPost.count({ where: { ticketThreadId } })) > 0;
  }

  // Crash leftovers (reserved, process died before confirm/delete).
  async cleanupPendingPosts(olderThan: Date): Promise<number> {
    const result = await this.prisma.intercomPendingPost.deleteMany({
      where: { createdAt: { lt: olderThan } },
    });
    return result.count;
  }

  // ---- Inbound inbox (durable webhook queue) ----

  // false = duplicate delivery (same notification event id) — already queued.
  async acceptInbound(deliveryId: string | null, topic: string, payload: object): Promise<boolean> {
    try {
      await this.prisma.intercomInboxEvent.create({
        data: { deliveryId: deliveryId || null, topic, payload },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return false;
      throw e;
    }
  }

  async listDueInbound(limit: number): Promise<IntercomInboxEvent[]> {
    return this.prisma.intercomInboxEvent.findMany({
      where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
      orderBy: { seq: "asc" },
      take: limit,
    });
  }

  async deleteInbound(id: string): Promise<void> {
    await this.prisma.intercomInboxEvent.deleteMany({ where: { id } });
  }

  async markInboundRetry(id: string, attempts: number, nextAttemptAt: Date, lastError: string): Promise<void> {
    await this.prisma.intercomInboxEvent.updateMany({
      where: { id },
      data: { attempts, nextAttemptAt, lastError: lastError.slice(0, 1000) },
    });
  }

  async markInboundDead(id: string, lastError: string): Promise<void> {
    await this.prisma.intercomInboxEvent.updateMany({
      where: { id },
      data: { status: "DEAD", lastError: lastError.slice(0, 1000) },
    });
  }

  async retryDeadInbound(): Promise<number> {
    const result = await this.prisma.intercomInboxEvent.updateMany({
      where: { status: "DEAD" },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date() },
    });
    return result.count;
  }

  async inboundCounts(): Promise<{ pending: number; dead: number }> {
    const [pending, dead] = await Promise.all([
      this.prisma.intercomInboxEvent.count({ where: { status: "PENDING" } }),
      this.prisma.intercomInboxEvent.count({ where: { status: "DEAD" } }),
    ]);
    return { pending, dead };
  }

  // ---- Inbound tag-diff damper ----

  async setLastTags(ticketThreadId: string, tags: string[]): Promise<void> {
    await this.prisma.intercomLink.updateMany({
      where: { ticketThreadId },
      data: { lastTagsJson: tags },
    });
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

  // Queued content-producing events for this thread (message/note) — the
  // webhook handler defers echo decisions while any are in flight.
  async hasPendingOutboundContent(ticketThreadId: string): Promise<boolean> {
    const count = await this.prisma.intercomOutboxEvent.count({
      where: { ticketThreadId, type: { in: ["message", "note", "ensure"] }, status: "PENDING" },
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
      this.prisma.intercomInboxEvent.deleteMany(),
      this.prisma.intercomPendingPost.deleteMany(),
    ]);
    return { links: links.count, events: events.count, parts: parts.count };
  }
}
