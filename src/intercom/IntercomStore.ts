import { PrismaClient, IntercomLink } from "../generated/prisma/client";

// Relay body-hash dedup rides the echo-part table under this kind (partId =
// "<threadId>:<bodyHash>"). Fresh window: same body seen twice within it is a
// cross-topic duplicate.
const RELAY_KIND = "r";
const RELAY_FRESH_MS = 2 * 60 * 1000;

// Persistence for the Intercom bridge: thread↔conversation/ticket links and
// the echo-part / pending-post ledgers. The durable outbox/inbox queue tables
// are gone — per-ticket FIFO delivery lives in the ticket workflow's outbox
// and the per-conversation inbox workflow.
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

  // ---- Inbound tag-diff damper ----

  async setLastTags(ticketThreadId: string, tags: string[]): Promise<void> {
    await this.prisma.intercomLink.updateMany({
      where: { ticketThreadId },
      data: { lastTagsJson: tags },
    });
  }

  // Full bridge-state wipe (links + echo/pending ledgers). Touches NOTHING in
  // Intercom itself — use when the Intercom side was cleared/recreated and the
  // local bookkeeping is stale; the next backfill rebuilds everything.
  async resetAll(): Promise<{ links: number; parts: number }> {
    const [links, parts] = await this.prisma.$transaction([
      this.prisma.intercomLink.deleteMany(),
      this.prisma.intercomEchoPart.deleteMany(),
      this.prisma.intercomPendingPost.deleteMany(),
    ]);
    return { links: links.count, parts: parts.count };
  }
}
