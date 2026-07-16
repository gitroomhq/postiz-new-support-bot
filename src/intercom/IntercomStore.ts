import { PrismaClient, IntercomLink, IntercomMessageMap } from "../generated/prisma/client";

// Relay body-hash dedup rides the echo-part table under this kind (partId =
// "<threadId>:<bodyHash>"). Fresh window: same body seen twice within it is a
// cross-topic duplicate.
const RELAY_KIND = "r";
const RELAY_FRESH_MS = 2 * 60 * 1000;
// Echo-handshake reservations are only meaningful while their post can still
// plausibly be in flight: reservations are created per delivery ATTEMPT and a
// call confirms (or its webhook lands) within seconds-to-minutes. Older rows
// are crash/dead-letter leftovers — matching or deferring against them delays
// and can even swallow genuine agent replies. The 1h sweep still deletes them.
const PENDING_POST_FRESH_MS = 10 * 60 * 1000;

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

  // 404 self-heal: the linked contact was merged/hard-deleted in Intercom and a
  // fresh one was resolved for the same conversation.
  async updateLinkContact(ticketThreadId: string, contactId: string, contactExternalId: string): Promise<void> {
    await this.prisma.intercomLink.updateMany({
      where: { ticketThreadId },
      data: { contactId, contactExternalId },
    });
  }

  // Returns the delete count so concurrent inbound handlers can tell who
  // actually disconnected the link (exactly-once disconnect note).
  async deleteLink(ticketThreadId: string): Promise<number> {
    const result = await this.prisma.intercomLink.deleteMany({ where: { ticketThreadId } });
    return result.count;
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

  async clearAgentWarned(ticketThreadId: string): Promise<void> {
    await this.prisma.intercomLink.updateMany({
      where: { ticketThreadId },
      data: { agentWarnedAt: null },
    });
  }

  // Conversations that received the push-mode agent warning (push→bi correction).
  async listWarnedLinks(): Promise<IntercomLink[]> {
    return this.prisma.intercomLink.findMany({ where: { agentWarnedAt: { not: null } } });
  }

  async setLastSyncedStateId(ticketThreadId: string, stateId: string | null): Promise<void> {
    await this.prisma.intercomLink.updateMany({
      where: { ticketThreadId },
      data: { lastSyncedStateId: stateId },
    });
  }

  // null restores the "never synced" state (inbound rollback after a failed apply).
  async setLastSyncedOpen(ticketThreadId: string, state: "open" | "closed" | null): Promise<void> {
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

  // Upsert with confirmed=true: if the webhook's transient claim row for the
  // same part won the insert race, this converts it into a confirmed record
  // instead of silently keeping an erasable claim (a deferring webhook's
  // releaseClaim must never delete the bridge's own confirm).
  async recordEchoPart(kind: "c" | "t" | "m", partId: string, ticketThreadId: string): Promise<void> {
    await this.prisma.intercomEchoPart.upsert({
      where: { kind_partId: { kind, partId } },
      create: { kind, partId, ticketThreadId, confirmed: true },
      update: { confirmed: true },
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

  // Rolls back a claimPart (defer or relay failure — the retry must be able to
  // claim again). Only unconfirmed rows: a confirm record is not a claim.
  async releaseClaim(kind: "c" | "t", partId: string): Promise<void> {
    await this.prisma.intercomEchoPart.deleteMany({ where: { kind, partId, confirmed: false } });
  }

  // ---- Outbound message delivery ledger (kind "m", partId = discordMessageId
  // [+ edit stamp]) ----
  // Intercom's API has no idempotency keys; a timeout-after-success retry would
  // double-post. The executor checks this before the API call and records after
  // success, shrinking the duplicate window to a crash between call and record.

  async hasDeliveredMessage(deliveryKey: string): Promise<boolean> {
    const row = await this.prisma.intercomEchoPart.findUnique({
      where: { kind_partId: { kind: "m", partId: deliveryKey } },
    });
    return row != null;
  }

  async recordDeliveredMessage(deliveryKey: string, ticketThreadId: string): Promise<void> {
    await this.recordEchoPart("m", deliveryKey, ticketThreadId);
  }

  // ---- Backfill-enqueued marker (kind "b", partId = threadId) ----
  // The link row only appears once the ensure DELIVERS, so it can't guard
  // against re-enqueueing a replay while the first is still queued.
  async claimBackfill(ticketThreadId: string): Promise<boolean> {
    try {
      await this.prisma.intercomEchoPart.create({
        data: { kind: "b", partId: ticketThreadId, ticketThreadId, confirmed: true },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return false;
      throw e;
    }
  }

  // Cheap existence probe for the "b" transcript-enqueued marker (refund-flip
  // crash-heal gate — avoids refetching thread history per message).
  async hasBackfillClaim(ticketThreadId: string): Promise<boolean> {
    const row = await this.prisma.intercomEchoPart.findUnique({
      where: { kind_partId: { kind: "b", partId: ticketThreadId } },
    });
    return row != null;
  }

  // Rolls back a claimBackfill when the enqueue failed partway (the ticket must
  // stay retryable).
  async releaseBackfill(ticketThreadId: string): Promise<void> {
    await this.prisma.intercomEchoPart.deleteMany({ where: { kind: "b", partId: ticketThreadId } });
  }

  // Threads with a backfill replay enqueued (link may not exist yet) — these
  // hold the deepest workflow outboxes, so reset/wipe must clear them too.
  async listBackfillClaimedThreadIds(): Promise<string[]> {
    const rows = await this.prisma.intercomEchoPart.findMany({
      where: { kind: "b" },
      select: { ticketThreadId: true },
    });
    return rows.map((r) => r.ticketThreadId);
  }

  // Sweeps only the ECHO kinds (c/t webhook claims, r relay dedup) — the "m"
  // delivery ledger and "b" backfill markers carry indefinite-lifetime
  // semantics: edit/delete mirroring gates on hasDeliveredMessage, and sweeping
  // an "m" row would silently disable corrections for any message older than
  // the retention window (the leaked-secret case this feature exists for).
  async cleanupEchoParts(olderThan: Date): Promise<number> {
    const result = await this.prisma.intercomEchoPart.deleteMany({
      where: { createdAt: { lt: olderThan }, kind: { in: ["c", "t", "r"] } },
    });
    return result.count;
  }

  // Cross-topic relay dedup (replaces the old in-memory map — survives
  // restarts). true = first sighting within the fresh window, relay it.
  // relayKey is caller-built (content kind prefix + body/attachment hash) so
  // notes vs replies and different attachment sets never collide.
  async claimRelay(ticketThreadId: string, relayKey: string): Promise<boolean> {
    const partId = `${ticketThreadId}:${relayKey}`;
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

  // Rolls back a claimRelay when the Discord-side relay failed after claiming
  // (the retry must be able to claim again).
  async releaseRelay(ticketThreadId: string, relayKey: string): Promise<void> {
    await this.prisma.intercomEchoPart.deleteMany({
      where: { kind: RELAY_KIND, partId: `${ticketThreadId}:${relayKey}` },
    });
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
  // Consumes AT MOST ONE row: two identical in-flight staff messages hold two
  // reservations, and each echo part may only eat one of them.
  async matchAndDeletePendingPost(ticketThreadId: string, bodyHashHex: string): Promise<boolean> {
    const row = await this.prisma.intercomPendingPost.findFirst({
      where: {
        ticketThreadId,
        bodyHash: bodyHashHex,
        createdAt: { gt: new Date(Date.now() - PENDING_POST_FRESH_MS) },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!row) return false;
    const result = await this.prisma.intercomPendingPost.deleteMany({ where: { id: row.id } });
    return result.count > 0;
  }

  async hasPendingPosts(ticketThreadId: string): Promise<boolean> {
    return (
      (await this.prisma.intercomPendingPost.count({
        where: { ticketThreadId, createdAt: { gt: new Date(Date.now() - PENDING_POST_FRESH_MS) } },
      })) > 0
    );
  }

  // A dead-lettered outbound event can leave one reservation per attempt (kept
  // on ambiguous failures so a late-landing part still hash-matches). Once the
  // event is DEAD nothing will land anymore — sweep them immediately instead of
  // letting them defer/false-match inbound replies for up to an hour.
  async deletePendingPostsForThread(ticketThreadId: string): Promise<void> {
    await this.prisma.intercomPendingPost.deleteMany({ where: { ticketThreadId } });
  }

  // Crash leftovers (reserved, process died before confirm/delete).
  async cleanupPendingPosts(olderThan: Date): Promise<number> {
    const result = await this.prisma.intercomPendingPost.deleteMany({
      where: { createdAt: { lt: olderThan } },
    });
    return result.count;
  }

  // ---- Message map (Discord message ↔ Intercom part, delete/edit reflection) ----
  // "out" rows are upserted by [direction, discordMessageId]: an edit's
  // redact+repost replaces the partId so later deletes hit the CURRENT part.
  // "in"/"note" rows are keyed the same way but never repost, so the upsert is
  // effectively insert-or-refresh (idempotent under webhook redelivery).

  async recordMessageMap(input: {
    ticketThreadId: string;
    direction: "out" | "in" | "note";
    discordMessageId: string;
    partId: string;
    via?: "webhook" | "bot" | null;
  }): Promise<void> {
    await this.prisma.intercomMessageMap.upsert({
      where: { direction_discordMessageId: { direction: input.direction, discordMessageId: input.discordMessageId } },
      create: {
        ticketThreadId: input.ticketThreadId,
        direction: input.direction,
        discordMessageId: input.discordMessageId,
        partId: input.partId,
        via: input.via ?? null,
      },
      update: { partId: input.partId, via: input.via ?? null, redactedAt: null },
    });
  }

  async getMessageMapByPartId(partId: string): Promise<IntercomMessageMap | null> {
    return this.prisma.intercomMessageMap.findUnique({ where: { partId } });
  }

  async getOutboundMessageMap(discordMessageId: string): Promise<IntercomMessageMap | null> {
    return this.prisma.intercomMessageMap.findUnique({
      where: { direction_discordMessageId: { direction: "out", discordMessageId } },
    });
  }

  // Damper for the redact-webhook echo: whichever side deleted first stamps the
  // row; the other side's handler sees the stamp and stops. null rolls back a
  // pre-mark after a definite redact failure (same pattern as lastSynced*).
  async setMessageMapRedactedAt(id: string, at: Date | null): Promise<void> {
    await this.prisma.intercomMessageMap.updateMany({ where: { id }, data: { redactedAt: at } });
  }

  // Newest relayed-agent-message stamp for a thread — the ping-cadence anchor
  // (mention the customer only on the first agent reply after their activity).
  async getLatestInboundRelayAt(ticketThreadId: string): Promise<Date | null> {
    const row = await this.prisma.intercomMessageMap.findFirst({
      where: { ticketThreadId, direction: "in" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  }

  // ---- Inbound tag-diff damper ----

  async setLastTags(ticketThreadId: string, tags: string[]): Promise<void> {
    await this.prisma.intercomLink.updateMany({
      where: { ticketThreadId },
      data: { lastTagsJson: tags },
    });
  }

  // ---- Inactivity sweeper damper state (native/unbridged objects) ----

  async getSweepState(id: string): Promise<{
    lastAgentRemindedAt: Date | null;
    customerNagCount: number;
    lastCustomerNagAt: Date | null;
    sweepClosedAt: Date | null;
  } | null> {
    return this.prisma.intercomSweepState.findUnique({
      where: { id },
      select: { lastAgentRemindedAt: true, customerNagCount: true, lastCustomerNagAt: true, sweepClosedAt: true },
    });
  }

  async upsertSweepState(
    id: string,
    kind: "conversation" | "ticket",
    data: {
      lastAgentRemindedAt?: Date | null;
      customerNagCount?: number;
      lastCustomerNagAt?: Date | null;
      sweepClosedAt?: Date | null;
    }
  ): Promise<void> {
    await this.prisma.intercomSweepState.upsert({
      where: { id },
      create: { id, kind, ...data },
      update: data,
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
      this.prisma.intercomMessageMap.deleteMany(),
      this.prisma.intercomSweepState.deleteMany(),
    ]);
    return { links: links.count, parts: parts.count };
  }
}
