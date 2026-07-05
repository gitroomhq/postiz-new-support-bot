import { PriorityTag, StatusTag } from "../generated/prisma/client";
import { TicketStore, TicketWithTag } from "../bot/TicketStore";
import { SettingsStore } from "../config/SettingsStore";
import { SessionStore } from "../auth/SessionStore";
import { IntercomStore } from "./IntercomStore";
import { EnsurePayload, MessageAttachmentRef, OutboxEventType, OutboxPayload } from "./types";

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

// Composes and enqueues outbox events for everything the bridge mirrors.
// Enqueue-only and no-throw: Intercom being down or misconfigured must never
// break a Discord flow. All HTTP happens later in the IntercomOutboxScheduler.
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
      await this.store.enqueue(ticket.threadId, "message", { ...composed, attachmentMode: "urls" });
    });
  }

  async onAiAnswer(threadId: string, finalText: string): Promise<void> {
    if (!this.enabled() || !finalText.trim()) return;
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return;
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket);
      await this.store.enqueue(ticket.threadId, "message", {
        direction: "outgoing",
        content: `🤖 AI:\n${finalText}`,
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
      await this.store.enqueue(ticket.threadId, "status", {
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
      await this.store.enqueue(ticket.threadId, "priority", {
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
      await this.store.enqueue(ticket.threadId, "csat", { score, comment: comment ?? null });
    });
  }

  // Push-mode "replies here don't reach the customer" note. Deliberately skips
  // ensureLink — it is only ever called for conversations that already have one.
  async enqueueAgentWarning(ticketThreadId: string): Promise<void> {
    await this.chained(ticketThreadId, async () => {
      await this.store.enqueue(ticketThreadId, "note", { content: AGENT_WARNING_TEXT });
    });
  }

  // ---- Backfill ----

  // Enqueues a full historical replay for one ticket in a single transaction
  // (all-or-nothing, so re-runs can key off hasLinkOrPendingEnsure). Returns the
  // number of events enqueued, or null when the ticket is already bridged.
  // Messages-only mirroring: the transcript replays messages; status/priority/
  // CSAT land as ticket state + attributes, never as notes. Timestamps come
  // from the native created_at backdating — no text prefixes.
  async backfillTicket(
    ticket: TicketWithTag,
    messages: BridgeSourceMessage[] | null // null = thread no longer exists
  ): Promise<number | null> {
    if (await this.store.hasLinkOrPendingEnsure(ticket.threadId)) return null;

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

    // Tail: final state + attributes (no transcript notes).
    const tag = ticket.statusTag;
    if (tag) {
      add("status", {
        statusTagId: tag.id,
        statusLabel: `${tag.emoji} ${tag.label}`,
        actorName: "Backfill",
        closed: tag.closesThread,
        resolved: tag.closesThread || isResolvedTag(tag),
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

    await this.store.enqueueMany(events);
    return events.length;
  }

  // ---- Composition helpers ----

  // Also used by the outbox executor's 404 self-heal to rebuild the remote objects.
  async buildEnsurePayloadWithSession(ticket: TicketWithTag): Promise<EnsurePayload> {
    const payload = this.buildEnsurePayload(ticket, categoryLabelOf(ticket, this.categoryLabelResolver));
    if (ticket.customerId) {
      const session = await this.sessionStore.getSession(ticket.customerId).catch(() => null);
      payload.postizUserId = session?.postizUserId ?? null;
      payload.stripeCustomerId = session?.stripeCustomerId ?? null;
    }
    return payload;
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
    if (await this.store.hasLinkOrPendingEnsure(ticket.threadId)) return;
    const payload = this.buildEnsurePayload(ticket, categoryLabel ?? categoryLabelOf(ticket, this.categoryLabelResolver));
    if (ticket.customerId) {
      const session = await this.sessionStore.getSession(ticket.customerId).catch(() => null);
      payload.postizUserId = session?.postizUserId ?? null;
      payload.stripeCustomerId = session?.stripeCustomerId ?? null;
    }
    await this.store.enqueue(ticket.threadId, "ensure", payload);
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
      direction = "outgoing";
      content = text;
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
      .catch((e) => console.error(`Intercom enqueue failed for ${threadId}:`, e));
    this.chains.set(threadId, next);
    void next.finally(() => {
      if (this.chains.get(threadId) === next) this.chains.delete(threadId);
    });
    await next;
  }
}

// external_id derivation: Postiz user id when the opener's session carried one
// (ticket creation requires OAuth, so this is the overwhelmingly common case),
// discord:{userId} otherwise, thread-scoped as the last resort.
export function externalIdFor(payload: EnsurePayload, threadId: string): string {
  if (payload.postizUserId) return payload.postizUserId;
  if (payload.customerId) return `discord:${payload.customerId}`;
  return `discord-thread:${threadId}`;
}

// The Resolved tag is identified by convention (✅, matching RESOLVED_EMOJI in
// StatusService) — resolved tickets close the Intercom conversation without the
// Discord thread being locked.
function isResolvedTag(tag: StatusTag): boolean {
  return tag.emoji === "✅";
}

function categoryLabelOf(ticket: TicketWithTag, resolve: (id: string | null) => string | null): string | null {
  return resolve(ticket.categoryId ?? null);
}
