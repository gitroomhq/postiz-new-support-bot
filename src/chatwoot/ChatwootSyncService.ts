import { PriorityTag, StatusTag, TicketNote, TicketTagChange } from "../generated/prisma/client";
import { TicketStore, TicketWithTag } from "../bot/TicketStore";
import { SettingsStore } from "../config/SettingsStore";
import { SessionStore } from "../auth/SessionStore";
import { ChatwootStore } from "./ChatwootStore";
import {
  ChatwootPriority,
  EnsureConversationPayload,
  MessageAttachmentRef,
  OutboxEventType,
  OutboxPayload,
} from "./types";

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
// Enqueue-only and no-throw: Chatwoot being down or misconfigured must never
// break a Discord flow. All HTTP happens later in the ChatwootOutboxScheduler.
export class ChatwootSyncService {
  // Per-thread promise chains so concurrent hooks enqueue in call order (the
  // outbox seq must match event order — same pattern as StatusService.chains).
  private chains = new Map<string, Promise<void>>();

  constructor(
    private settingsStore: SettingsStore,
    private store: ChatwootStore,
    private sessionStore: SessionStore,
    private ticketStore: TicketStore
  ) {}

  enabled(): boolean {
    return this.settingsStore.chatwootMode() !== "none" && this.settingsStore.chatwootConfigured();
  }

  // ---- Live hooks (called fire-and-forget from DiscordBot/StatusService) ----
  // All hooks are threadId-based and refetch the ticket row themselves: they run
  // as `void` side-effects after the DB write, so the refetched state is current.

  async onTicketCreated(threadId: string, categoryLabel: string | null, question: string | null): Promise<void> {
    if (!this.enabled()) return;
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return;
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket, categoryLabel);
      if (question) {
        await this.store.enqueue(ticket.threadId, "message", {
          direction: "incoming",
          content: question,
          externalCreatedAtIso: ticket.createdAt.toISOString(),
        });
      }
    });
  }

  async onHumanMessage(ticket: TicketWithTag, message: BridgeSourceMessage, isStaff: boolean): Promise<void> {
    if (!this.enabled()) return;
    const composed = this.composeMessage(ticket, message, isStaff);
    if (!composed) return;
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket);
      await this.store.enqueue(ticket.threadId, "message", composed);
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
        statusSlug: slugify(toTag.label),
        statusLabel: `${toTag.emoji} ${toTag.label}`,
        fromLabel: fromTag ? `${fromTag.emoji} ${fromTag.label}` : null,
        actorName,
        closed: toTag.closesThread,
        resolved,
        note: true,
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
        priority: this.mapPriority(toTag.id),
        priorityLabel: `${toTag.emoji} ${toTag.label}`,
        fromLabel: fromTag ? `${fromTag.emoji} ${fromTag.label}` : null,
        actorName,
        note: true,
      });
    });
  }

  async onNoteAdded(threadId: string, authorName: string, text: string): Promise<void> {
    if (!this.enabled()) return;
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket) return;
    await this.chained(ticket.threadId, async () => {
      await this.ensureLink(ticket);
      await this.store.enqueue(ticket.threadId, "note", {
        content: `📝 Staff note by ${authorName}:\n${text}`,
      });
    });
  }

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
  async backfillTicket(
    ticket: TicketWithTag,
    messages: BridgeSourceMessage[] | null, // null = thread no longer exists
    notes: TicketNote[],
    tagChanges: TicketTagChange[]
  ): Promise<number | null> {
    if (await this.store.hasLinkOrPendingEnsure(ticket.threadId)) return null;

    const events: Array<{ ticketThreadId: string; type: OutboxEventType; payload: OutboxPayload }> = [];
    const add = (type: OutboxEventType, payload: OutboxPayload) =>
      events.push({ ticketThreadId: ticket.threadId, type, payload });

    add("ensure_conversation", this.buildEnsurePayload(ticket, categoryLabelOf(ticket)));

    // One chronological stream: messages + staff notes + status/priority history.
    type Entry = { at: Date; type: OutboxEventType; payload: OutboxPayload };
    const entries: Entry[] = [];

    if (messages === null) {
      entries.push({
        at: ticket.createdAt,
        type: "note",
        payload: { content: "Discord thread no longer exists; transcript unavailable." },
      });
      if (ticket.question) {
        entries.push({
          at: ticket.createdAt,
          type: "message",
          payload: {
            direction: "incoming",
            content: `${formatTimestamp(ticket.createdAt)} ${ticket.question}`,
            externalCreatedAtIso: ticket.createdAt.toISOString(),
          },
        });
      }
    } else {
      for (const message of messages) {
        const composed = this.composeMessage(ticket, message, !message.authorIsBot && message.authorId !== ticket.customerId);
        if (!composed) continue;
        entries.push({
          at: message.createdAt,
          type: "message",
          payload: { ...composed, content: `${formatTimestamp(message.createdAt)} ${composed.content}` },
        });
      }
    }

    for (const note of notes) {
      entries.push({
        at: note.createdAt,
        type: "note",
        payload: {
          content: `${formatTimestamp(note.createdAt)} 📝 Staff note by ${note.authorName}:\n${note.text}`,
          externalCreatedAtIso: note.createdAt.toISOString(),
        },
      });
    }

    for (const change of tagChanges) {
      const kind = change.kind === "PRIORITY" ? "Priority" : "Status";
      const from = change.fromLabel ? `${change.fromEmoji ?? ""} ${change.fromLabel}`.trim() : "—";
      entries.push({
        at: change.createdAt,
        type: "note",
        payload: {
          content: `${formatTimestamp(change.createdAt)} ${kind}: ${from} → ${change.toEmoji} ${change.toLabel} — by ${change.actorName}`,
          externalCreatedAtIso: change.createdAt.toISOString(),
        },
      });
    }

    entries.sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const entry of entries) add(entry.type, entry.payload);

    // Tail: final state. History notes above already narrate transitions, so note:false.
    const tag = ticket.statusTag;
    if (tag) {
      add("status", {
        statusSlug: slugify(tag.label),
        statusLabel: `${tag.emoji} ${tag.label}`,
        actorName: "Backfill",
        closed: tag.closesThread,
        resolved: tag.closesThread || isResolvedTag(tag),
        note: false,
      });
    }
    const priorityTag = ticket.priorityTagId ? this.settingsStore.priorityById(ticket.priorityTagId) : undefined;
    if (priorityTag) {
      add("priority", {
        priority: this.mapPriority(priorityTag.id),
        priorityLabel: `${priorityTag.emoji} ${priorityTag.label}`,
        actorName: "Backfill",
        note: false,
      });
    }
    if (ticket.csatScore != null) {
      add("csat", { score: ticket.csatScore, comment: ticket.csatComment });
    }

    await this.store.enqueueMany(events);
    return events.length;
  }

  // ---- Composition helpers ----

  // Also used by the outbox executor's 404 self-heal to rebuild a conversation.
  async buildEnsurePayloadWithSession(ticket: TicketWithTag): Promise<EnsureConversationPayload> {
    const payload = this.buildEnsurePayload(ticket, categoryLabelOf(ticket));
    if (ticket.customerId) {
      const session = await this.sessionStore.getSession(ticket.customerId).catch(() => null);
      payload.postizUserId = session?.postizUserId ?? null;
      payload.stripeCustomerId = session?.stripeCustomerId ?? null;
    }
    return payload;
  }

  private buildEnsurePayload(ticket: TicketWithTag, categoryLabel: string | null): EnsureConversationPayload {
    const tag = ticket.statusTag;
    const priorityTag = ticket.priorityTagId ? this.settingsStore.priorityById(ticket.priorityTagId) : undefined;
    return {
      customerId: ticket.customerId,
      customerDisplayName: ticket.customerDisplayName,
      categoryLabel,
      statusSlug: tag ? slugify(tag.label) : "open",
      statusLabel: tag ? `${tag.emoji} ${tag.label}` : "Open",
      closed: ticket.closed && (tag?.closesThread ?? true),
      resolved: ticket.closed || (tag ? isResolvedTag(tag) : false),
      priority: priorityTag ? this.mapPriority(priorityTag.id) : null,
      createdAtIso: ticket.createdAt.toISOString(),
    };
  }

  private async ensureLink(ticket: TicketWithTag, categoryLabel?: string | null): Promise<void> {
    if (await this.store.hasLinkOrPendingEnsure(ticket.threadId)) return;
    const payload = this.buildEnsurePayload(ticket, categoryLabel ?? categoryLabelOf(ticket));
    if (ticket.customerId) {
      const session = await this.sessionStore.getSession(ticket.customerId).catch(() => null);
      payload.postizUserId = session?.postizUserId ?? null;
      payload.stripeCustomerId = session?.stripeCustomerId ?? null;
    }
    await this.store.enqueue(ticket.threadId, "ensure_conversation", payload);
  }

  // Customer → incoming verbatim; staff/other humans → outgoing with a name
  // prefix (single bridge token can't attribute per-agent); bot → outgoing
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

  // 6→4 mapping by sortOrder quantile over the currently configured priorities,
  // so custom priority lists degrade sensibly. Default list: Very Low/Low → low,
  // Medium → medium, High → high, Very High/Critical → urgent.
  mapPriority(priorityTagId: string): ChatwootPriority {
    const list = [...this.settingsStore.priorities()].sort((a, b) => a.sortOrder - b.sortOrder);
    const index = list.findIndex((p) => p.id === priorityTagId);
    if (index < 0 || list.length <= 1) return "medium";
    const q = index / (list.length - 1);
    if (q < 0.25) return "low";
    if (q < 0.5) return "medium";
    if (q < 0.75) return "high";
    return "urgent";
  }

  private async chained(threadId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(threadId) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((e) => console.error(`Chatwoot enqueue failed for ${threadId}:`, e));
    this.chains.set(threadId, next);
    void next.finally(() => {
      if (this.chains.get(threadId) === next) this.chains.delete(threadId);
    });
    await next;
  }
}

export function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `[${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC]`;
}

// The Resolved tag is identified by convention (✅, matching RESOLVED_EMOJI in
// StatusService) — resolved tickets map to Chatwoot "resolved" without closing.
function isResolvedTag(tag: StatusTag): boolean {
  return tag.emoji === "✅";
}

function categoryLabelOf(ticket: TicketWithTag): string | null {
  return ticket.categoryId ?? null;
}
