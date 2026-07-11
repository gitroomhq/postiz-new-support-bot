import { PriorityTag, StatusTag } from "../generated/prisma/client";
import { TicketStore, TicketWithTag } from "../bot/TicketStore";
import { SettingsStore } from "../config/SettingsStore";
import { SessionStore } from "../auth/SessionStore";
import { IntercomStore } from "./IntercomStore";
import type { IntercomEventExecutor } from "./IntercomEventExecutor";
import { bodyHash } from "./renderDiscordMarkdown";
import { EnsurePayload, MessageAttachmentRef, OutboxEventType, OutboxPayload } from "./types";
import { log } from "../util/logger";
import type { TemporalProducers } from "../temporal/producers";

const syncLog = log.child("intercom:sync");

// A Discord message reduced to what the bridge needs (live mirror and backfill
// both map to this, so the composition logic stays free of discord.js types).
export interface BridgeSourceMessage {
  discordMessageId: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  attachments: MessageAttachmentRef[];
  createdAt: Date;
}

export const AGENT_WARNING_TEXT =
  "⚠️ One-way mirror: this conversation is pushed from Discord. Replies here are NOT delivered to the customer — answer in the Discord thread instead.";

// Posted on a push→bi flip into every conversation that previously received
// AGENT_WARNING_TEXT — that note is now the most prominent (and wrong)
// instruction agents see.
export const BI_CORRECTION_TEXT =
  "✅ Bi-directional sync is now ON: replies in this conversation ARE delivered to the customer in Discord. (An earlier note here said otherwise — it no longer applies.)";

// Composes and enqueues outbox events for everything the bridge mirrors.
// Enqueue-only and no-throw: Intercom being down or misconfigured must never
// break a Discord flow. All HTTP happens later, inside the per-ticket
// workflow's Intercom delivery children.
export class IntercomSyncService {
  // Per-thread promise chains so concurrent hooks enqueue in call order (the
  // outbox seq must match event order — same pattern as StatusService.chains).
  private chains = new Map<string, Promise<void>>();
  // Resolves a category id to its human label ("billing" → "💳 Billing").
  // Bound from index.ts once the CategoryRegistry exists.
  private categoryLabelResolver: (id: string | null) => string | null = (id) => id;
  // Builds https://discord.com/channels/{guildId}/{threadId}; bound lazily
  // (the guild id is only known once the Discord client is ready).
  private threadUrlBuilder: (threadId: string) => string | null = () => null;
  // Current Discord identity (display name + avatar) for the contact refresh;
  // bound lazily from index.ts once the client exists. Best-effort.
  private customerInfoResolver:
    | ((userId: string) => Promise<{ displayName: string | null; avatarUrl: string | null } | null>)
    | null = null;

  constructor(
    private settingsStore: SettingsStore,
    private store: IntercomStore,
    private sessionStore: SessionStore,
    private ticketStore: TicketStore
  ) {}

  setCategoryLabelResolver(resolver: (id: string | null) => string | null): void {
    this.categoryLabelResolver = resolver;
  }

  setThreadUrlBuilder(builder: (threadId: string) => string | null): void {
    this.threadUrlBuilder = builder;
  }

  setCustomerInfoResolver(
    resolver: (userId: string) => Promise<{ displayName: string | null; avatarUrl: string | null } | null>
  ): void {
    this.customerInfoResolver = resolver;
  }

  // Temporal seam: composed events are signalled into the per-ticket
  // workflow's outbox — every hook call site stays untouched. Signals are sent
  // whenever Temporal is CONFIGURED (routable), even while the worker is
  // paused: they land server-side and deliver on resume; outages buffer in the
  // gateway's RetryBuffer.
  private producers: TemporalProducers | null = null;
  // Direct fallback for the unconfigured bootstrap state: execute against the
  // Intercom API immediately (no queue, no retry). Bound late from index.ts
  // (the executor is constructed after this service).
  private executor: IntercomEventExecutor | null = null;

  setTemporalProducers(producers: TemporalProducers): void {
    this.producers = producers;
  }

  setExecutor(executor: IntercomEventExecutor): void {
    this.executor = executor;
  }

  private temporalRoutable(): boolean {
    return this.producers?.routable() ?? false;
  }

  // Single enqueue choke point: workflow signal when Temporal is configured,
  // best-effort direct delivery otherwise (a failure only costs this one
  // mirror event — the bridge stays no-throw either way).
  private async emit(threadId: string, type: OutboxEventType, payload: OutboxPayload): Promise<void> {
    if (this.temporalRoutable()) {
      await this.producers!.intercomEnqueue(threadId, type, payload);
      return;
    }
    if (!this.executor) {
      syncLog.warn("intercom mirror event dropped — temporal unconfigured, no executor bound", {
        "ticket.thread_id": threadId,
        "queue.event_type": type,
      });
      return;
    }
    try {
      await this.executor.execute(threadId, type, payload);
    } catch (e) {
      syncLog.warn("intercom direct delivery failed — event dropped (temporal unconfigured)", {
        "ticket.thread_id": threadId,
        "queue.event_type": type,
        "error.message": e instanceof Error ? e.message : String(e),
      });
    }
  }

  enabled(): boolean {
    return this.settingsStore.intercomMode() !== "none" && this.settingsStore.intercomConfigured();
  }

  // ---- Live hooks (called fire-and-forget from DiscordBot/StatusService) ----
  // All hooks are threadId-based and refetch the ticket row themselves: they run
  // as `void` side-effects after the DB write, so the refetched state is current.

  // The customer's question becomes the conversation's opening message (the
  // ensure event carries it) — no separate message enqueue, no duplicate.
  async onTicketCreated(threadId: string, categoryLabel: string | null, _question: string | null): Promise<void> {
    if (!this.enabled()) return;
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return;
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket, categoryLabel);
    });
  }

  async onHumanMessage(ticket: TicketWithTag, message: BridgeSourceMessage, isStaff: boolean): Promise<void> {
    if (!this.enabled()) return;
    const composed = this.composeMessage(ticket, message, isStaff);
    if (!composed) return;
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket);
      await this.emit(ticket.threadId, "message", { ...composed, attachmentMode: "urls" });
    });
  }

  async onAiAnswer(threadId: string, finalText: string): Promise<void> {
    if (!this.enabled() || !finalText.trim()) return;
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return;
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket);
      await this.emit(ticket.threadId, "message", {
        direction: "outgoing",
        content: `🤖 AI:\n${finalText}`,
        // Synthetic delivery-ledger key (there's no Discord message id here):
        // a timeout-after-success retry must not double-post the AI answer.
        discordMessageId: `ai:${threadId}:${bodyHash(finalText)}`,
      });
    });
  }

  // Discord message edited → appended "✏️ edited" part (Intercom can't edit
  // parts in place). The executor drops it unless the original was mirrored.
  async onMessageEdited(
    ticket: TicketWithTag,
    message: BridgeSourceMessage,
    isStaff: boolean,
    editedAtIso: string
  ): Promise<void> {
    if (!this.enabled()) return;
    // Never enqueue for an unbridged ticket: the pump's ensure-first synthesis
    // would mint a ghost conversation just to have the executor drop the event
    // (original never mirrored). The executor's ledger check stays the authority.
    if (!(await this.store.getLink(ticket.threadId))) return;
    const composed = this.composeMessage(ticket, message, isStaff);
    if (!composed) return;
    await this.chained(ticket.threadId, async () => {
      await this.emit(ticket.threadId, "message_edit", {
        discordMessageId: message.discordMessageId,
        editedAtIso,
        direction: composed.direction,
        authorName: message.authorName,
        content: message.content.trim(),
        ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      });
    });
  }

  // Discord message deleted → appended "🗑️ deleted" part. authorName/direction
  // may be unknown for uncached messages (null → generic wording).
  async onMessageDeleted(
    ticket: TicketWithTag,
    discordMessageId: string,
    author: { id: string; name: string } | null
  ): Promise<void> {
    if (!this.enabled()) return;
    // See onMessageEdited — no ghost ensure for unbridged tickets.
    if (!(await this.store.getLink(ticket.threadId))) return;
    const isCustomer = author != null && ticket.customerId != null && author.id === ticket.customerId;
    await this.chained(ticket.threadId, async () => {
      await this.emit(ticket.threadId, "message_delete", {
        discordMessageId,
        direction: isCustomer ? "incoming" : "outgoing",
        authorName: author?.name ?? null,
      });
    });
  }

  // fromTag is passed explicitly (a {emoji,label} snapshot) because the ticket
  // row is refetched after the transition, when statusTag is already the new one.
  async onStatusChanged(
    threadId: string,
    fromTag: { emoji: string; label: string } | null | undefined,
    toTag: StatusTag,
    actorName: string
  ): Promise<void> {
    if (!this.enabled()) return;
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return;
    const resolved = toTag.closesThread || isResolvedTag(toTag);
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket);
      await this.emit(ticket.threadId, "status", {
        statusTagId: toTag.id,
        statusLabel: `${toTag.emoji} ${toTag.label}`,
        fromLabel: fromTag ? `${fromTag.emoji} ${fromTag.label}` : null,
        actorName,
        closed: toTag.closesThread,
        resolved,
      });
    });
  }

  async onPriorityChanged(
    threadId: string,
    fromTag: { emoji: string; label: string } | null | undefined,
    toTag: PriorityTag,
    actorName: string
  ): Promise<void> {
    if (!this.enabled()) return;
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return;
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket);
      await this.emit(ticket.threadId, "priority", {
        priorityLabel: `${toTag.emoji} ${toTag.label}`,
        fromLabel: fromTag ? `${fromTag.emoji} ${fromTag.label}` : null,
        actorName,
      });
    });
  }

  // Discord staff notes are NOT mirrored to Intercom (messages-only mirroring;
  // agents working Intercom-first read their own notes there). The inverse —
  // Intercom notes → TicketNote rows — lives in IntercomWebhookHandler and
  // must never re-enter the bridge.

  async onCsat(threadId: string, score: number, comment?: string | null): Promise<void> {
    if (!this.enabled()) return;
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return;
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket);
      await this.emit(ticket.threadId, "csat", { score, comment: comment ?? null });
    });
  }

  // Push-mode "replies here don't reach the customer" note. Deliberately skips
  // ensureLink — it is only ever called for conversations that already have one.
  async enqueueAgentWarning(ticketThreadId: string): Promise<void> {
    await this.chained(ticketThreadId, async () => {
      await this.emit(ticketThreadId, "note", { content: AGENT_WARNING_TEXT });
    });
  }

  // push→bi flip: corrective note into every OPEN conversation that got the
  // push-mode warning; agentWarnedAt is cleared so a later return to push mode
  // re-warns. Returns the number of conversations corrected.
  async enqueueBiModeCorrections(): Promise<number> {
    const links = await this.store.listWarnedLinks();
    let count = 0;
    for (const link of links) {
      const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
      if (!ticket || ticket.closed) {
        // Closed tickets: no note (nobody is working them), but still reset the
        // warning so a reopened ticket under a later push window re-warns.
        await this.store.clearAgentWarned(link.ticketThreadId);
        continue;
      }
      await this.chained(link.ticketThreadId, async () => {
        await this.emit(link.ticketThreadId, "note", { content: BI_CORRECTION_TEXT });
      });
      await this.store.clearAgentWarned(link.ticketThreadId);
      count++;
    }
    return count;
  }

  // ---- Backfill ----

  // Sends a full historical replay for one ticket through emit(). Guarded twice:
  // the link row (ticket already bridged) AND the backfill-enqueued marker —
  // the link only appears once the ensure DELIVERS, which can be minutes away
  // on a slow drain, so a re-click (or a second backfill run) would otherwise
  // enqueue the whole transcript again with no message-level dedup. Returns the
  // number of events sent, or null when the ticket is already bridged/enqueued.
  // Messages-only mirroring: the transcript replays messages; status/priority/
  // CSAT land as ticket state + attributes, never as notes. Timestamps come
  // from the native created_at backdating — no text prefixes.
  async backfillTicket(
    ticket: TicketWithTag,
    messages: BridgeSourceMessage[] | null // null = thread no longer exists
  ): Promise<number | null> {
    if (await this.store.getLink(ticket.threadId)) return null;
    if (!(await this.store.claimBackfill(ticket.threadId))) return null;

    const events: Array<{ ticketThreadId: string; type: OutboxEventType; payload: OutboxPayload }> = [];
    const add = (type: OutboxEventType, payload: OutboxPayload) =>
      events.push({ ticketThreadId: ticket.threadId, type, payload });

    add("ensure", { ...this.buildEnsurePayload(ticket, categoryLabelOf(ticket, this.categoryLabelResolver)), questionAsOpening: false });

    if (messages === null) {
      add("note", { content: "Discord thread no longer exists; transcript unavailable." });
      if (ticket.question) {
        add("message", {
          direction: "incoming",
          content: ticket.question,
          externalCreatedAtIso: ticket.createdAt.toISOString(),
          attachmentMode: "links",
        });
      }
    } else {
      for (const message of messages) {
        const composed = this.composeMessage(ticket, message, !message.authorIsBot && message.authorId !== ticket.customerId);
        if (!composed) continue;
        add("message", {
          ...composed,
          // Backfilled Discord CDN links are signed and likely expired —
          // never hand them to attachment_urls, only as text.
          attachmentMode: "links",
        });
      }
    }

    // Tail: final state + attributes (no transcript notes). forceOpenSync: the
    // replayed contact messages auto-reopen the conversation in Intercom, so
    // the close must be re-asserted past the lastSyncedOpen damper — without it
    // every backfilled closed ticket floods the inbox as an open conversation.
    const tag = ticket.statusTag;
    if (tag) {
      add("status", {
        statusTagId: tag.id,
        statusLabel: `${tag.emoji} ${tag.label}`,
        actorName: "Backfill",
        closed: tag.closesThread,
        resolved: tag.closesThread || isResolvedTag(tag),
        forceOpenSync: true,
      });
    }
    const priorityTag = ticket.priorityTagId ? this.settingsStore.priorityById(ticket.priorityTagId) : undefined;
    if (priorityTag) {
      add("priority", {
        priorityLabel: `${priorityTag.emoji} ${priorityTag.label}`,
        actorName: "Backfill",
      });
    }
    if (ticket.csatScore != null) {
      add("csat", { score: ticket.csatScore, comment: ticket.csatComment });
    }

    try {
      for (const event of events) {
        await this.emit(event.ticketThreadId, event.type, event.payload);
      }
    } catch (e) {
      // Enqueue failed partway — release the marker so the ticket can be
      // retried (delivered messages are still deduped by the m-ledger).
      await this.store.releaseBackfill(ticket.threadId).catch(() => {});
      throw e;
    }
    return events.length;
  }

  // ---- Composition helpers ----

  // Also used by the outbox executor's 404 self-heal to rebuild the remote objects.
  async buildEnsurePayloadWithSession(ticket: TicketWithTag): Promise<EnsurePayload> {
    const payload = this.buildEnsurePayload(ticket, categoryLabelOf(ticket, this.categoryLabelResolver));
    await this.enrichPayload(payload, ticket);
    return payload;
  }

  // Session ids (Postiz/Stripe) + current Discord identity (name/avatar drift).
  private async enrichPayload(payload: EnsurePayload, ticket: TicketWithTag): Promise<void> {
    if (!ticket.customerId) return;
    const session = await this.sessionStore.getSession(ticket.customerId).catch(() => null);
    payload.postizUserId = session?.postizUserId ?? null;
    payload.stripeCustomerId = session?.stripeCustomerId ?? null;
    if (this.customerInfoResolver) {
      const info = await this.customerInfoResolver(ticket.customerId).catch(() => null);
      if (info) {
        payload.customerAvatarUrl = info.avatarUrl;
        if (info.displayName) payload.customerDisplayName = info.displayName;
      }
    }
  }

  private buildEnsurePayload(ticket: TicketWithTag, categoryLabel: string | null): EnsurePayload {
    const tag = ticket.statusTag;
    const priorityTag = ticket.priorityTagId ? this.settingsStore.priorityById(ticket.priorityTagId) : undefined;
    return {
      customerId: ticket.customerId,
      customerDisplayName: ticket.customerDisplayName,
      categoryId: ticket.categoryId,
      categoryLabel,
      question: ticket.question ?? null,
      questionAsOpening: true,
      threadUrl: this.threadUrlBuilder(ticket.threadId),
      statusTagId: tag?.id ?? null,
      statusLabel: tag ? `${tag.emoji} ${tag.label}` : "Open",
      closed: ticket.closed && (tag?.closesThread ?? true),
      resolved: ticket.closed || (tag ? isResolvedTag(tag) : false),
      priorityLabel: priorityTag ? `${priorityTag.emoji} ${priorityTag.label}` : null,
      createdAtIso: ticket.createdAt.toISOString(),
    };
  }

  private async ensureLink(ticket: TicketWithTag, categoryLabel?: string | null): Promise<void> {
    // Temporal path: the per-ticket workflow synthesizes the ensure event
    // itself (ensure-first pump invariant, payload composed fresh at delivery
    // time) — nothing to send here.
    if (this.temporalRoutable()) return;
    // Direct fallback: create the remote objects now so the following
    // message/note event has something to land on.
    if (await this.store.getLink(ticket.threadId)) return;
    const payload = this.buildEnsurePayload(ticket, categoryLabel ?? categoryLabelOf(ticket, this.categoryLabelResolver));
    await this.enrichPayload(payload, ticket);
    await this.emit(ticket.threadId, "ensure", payload);
  }

  // Customer → incoming verbatim; staff/other humans → outgoing with a name
  // prefix (single bridge author can't attribute per-agent); bot → outgoing
  // (historical AI answers during backfill). Returns null for empty messages.
  private composeMessage(
    ticket: TicketWithTag,
    message: BridgeSourceMessage,
    isStaff: boolean
  ): { direction: "incoming" | "outgoing"; content: string; discordMessageId: string; externalCreatedAtIso: string; attachments?: MessageAttachmentRef[] } | null {
    const text = message.content.trim();
    if (!text && message.attachments.length === 0) return null;

    const isCustomer = ticket.customerId != null && message.authorId === ticket.customerId;
    let direction: "incoming" | "outgoing";
    let content: string;
    if (message.authorIsBot) {
      // Bot messages only reach this path via backfill (live handleMessage
      // filters bots) — mark them so the imported transcript doesn't read as a
      // human staff reply. Historical AI answers may already carry the marker.
      direction = "outgoing";
      content = text.startsWith("🤖") ? text : `🤖 ${text}`;
    } else if (isCustomer || (!isStaff && ticket.customerId == null)) {
      direction = "incoming";
      content = text;
    } else {
      direction = "outgoing";
      content = `**${message.authorName}:**\n${text}`;
    }
    if (!content.trim() && message.attachments.length > 0) {
      content = direction === "outgoing" ? `**${message.authorName}:** (attachment)` : "(attachment)";
    }

    return {
      direction,
      content,
      discordMessageId: message.discordMessageId,
      externalCreatedAtIso: message.createdAt.toISOString(),
      ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
    };
  }

  private async chained(threadId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(threadId) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((e) => syncLog.error("enqueue failed", e, { "ticket.thread_id": threadId }));
    this.chains.set(threadId, next);
    void next.finally(() => {
      if (this.chains.get(threadId) === next) this.chains.delete(threadId);
    });
    await next;
  }
}

// external_id derivation, most-canonical first: Postiz user id when the opener's
// session carried one (ticket creation requires OAuth, so this is the
// overwhelmingly common case), then discord:{userId}, then a thread-scoped last
// resort. The contact resolver cascades down this list when a higher id is
// unusable (e.g. locked inside a prior wipe's 7-day permanent-deletion grace) —
// the thread-scoped tail is unique per ticket, so it is effectively always free.
export function externalIdCandidates(payload: EnsurePayload, threadId: string): string[] {
  const ids: string[] = [];
  if (payload.postizUserId) ids.push(payload.postizUserId);
  if (payload.customerId) ids.push(`discord:${payload.customerId}`);
  ids.push(`discord-thread:${threadId}`);
  return ids;
}

export function externalIdFor(payload: EnsurePayload, threadId: string): string {
  return externalIdCandidates(payload, threadId)[0];
}

// A resolved-style tag closes the Intercom conversation without the Discord
// thread being locked. Matched by the ✅ convention (RESOLVED_EMOJI in
// StatusService) OR by label — the emoji-only convention silently stopped
// closing conversations the moment a Resolved tag was re-emojied.
function isResolvedTag(tag: StatusTag): boolean {
  return tag.emoji === "✅" || /\b(resolved|solved)\b/i.test(tag.label);
}

function categoryLabelOf(ticket: TicketWithTag, resolve: (id: string | null) => string | null): string | null {
  return resolve(ticket.categoryId ?? null);
}
