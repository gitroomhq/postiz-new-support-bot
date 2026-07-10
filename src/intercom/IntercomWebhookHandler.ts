import { Client, EmbedBuilder, ThreadChannel } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { TicketStore } from "../bot/TicketStore";
import { StatusService } from "../bot/StatusService";
import { AuditLogger } from "../bot/AuditLogger";
import { COLORS } from "../util/embeds";
import { IntercomStore } from "./IntercomStore";
import { IntercomSyncService } from "./IntercomSyncService";
import { bodyHash } from "./renderDiscordMarkdown";
import { TemporalBufferedError, type TemporalProducers } from "../temporal/producers";
import {
  IntercomConversationItem,
  IntercomTicketItem,
  IntercomWebhookEvent,
  IntercomWebhookPart,
} from "./types";

// Thrown while the thread still has in-flight outbound content that could be
// the origin of this part — the inbox workflow retries shortly instead of
// risking a double-post. Bounded: after MAX_DEFER_ATTEMPTS the part is relayed
// anyway (a rare duplicate beats a lost agent reply).
export class DeferEchoError extends Error {
  constructor() {
    super("outbound content in flight — deferring echo decision");
    this.name = "DeferEchoError";
  }
}

const MAX_DEFER_ATTEMPTS = 12;

// Handles inbound Intercom webhooks. The HTTP route only calls accept()
// (a signal into the per-conversation workflow); the processInboundEvent
// activity drives process(), which THROWS on transient failures so the
// workflow retries — nothing is lost to a crash mid-handle.
//
// Echo suppression is layered: part-id ledger (claimPart) → pending-post
// body-hash match (reserve→confirm handshake with the outbox) → bounded defer
// while outbound content is in flight → relay.
//
// Constructed before the Discord client exists (CallbackServer needs the
// handler at bot construction time), so the client is bound late.
export class IntercomWebhookHandler {
  private client: Client | null = null;

  constructor(
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private statusService: StatusService,
    private store: IntercomStore,
    private sync: IntercomSyncService,
    private audit: AuditLogger
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  // Temporal seam: inbound events are signalled into the per-conversation
  // intercomInboxWorkflow (dedup via its deliveryId ring) whenever Temporal is
  // configured — even while the worker is paused, the signal parks server-side
  // and processes on resume. A buffered signal (Temporal down) throws so the
  // route answers 500 and Intercom's single retry redelivers.
  private temporalProducers: TemporalProducers | null = null;

  setTemporalProducers(producers: TemporalProducers): void {
    this.temporalProducers = producers;
  }

  // HTTP-route half: durably queue the event and return. Never relays inline
  // while Temporal is configured. Returns false for duplicate deliveries.
  async accept(body: unknown): Promise<boolean> {
    const event = body as IntercomWebhookEvent;
    const topic = event?.topic;
    if (!topic || topic === "ping") return true;
    if (this.temporalProducers?.routable()) {
      // Per-item serialization key: conversation id for conversation.* topics,
      // ticket id for ticket.* — handlers are convergent/damped, so distinct
      // workflows per kind are fine (matches the old durable queue's guarantees).
      const itemId = (event?.data?.item as { id?: unknown } | undefined)?.id;
      const key = itemId != null ? String(itemId) : null;
      if (!key) return true; // nothing to key on — same as an unknown topic: drop
      const r = await this.temporalProducers.inboundIntercomEvent(key, {
        deliveryId: event.id ?? null,
        topic,
        payload: body,
      });
      if (!r.ok && r.buffered) {
        throw new TemporalBufferedError("intercom event buffered — Intercom should redeliver");
      }
      return r.ok;
    }
    // Direct fallback (Temporal unconfigured — bootstrap state): best-effort
    // inline handling with no durable queue. Echo decisions can't defer here,
    // so process with the defer budget exhausted (a rare duplicate beats a
    // lost agent reply); a transient throw becomes a 500 and Intercom's single
    // retry redelivers.
    await this.process(topic, body, MAX_DEFER_ATTEMPTS);
    return true;
  }

  // Scheduler half: dispatch one queued event. Throws on transient failure
  // (retried by the inbox scheduler with backoff).
  async process(topic: string, body: unknown, attempt: number): Promise<void> {
    const event = body as IntercomWebhookEvent;
    const item = event?.data?.item;
    switch (topic) {
      case "conversation.admin.replied":
      case "conversation.operator.replied":
        await this.handleConversationReply(item as IntercomConversationItem, attempt);
        return;
      case "conversation.admin.noted":
        await this.handleConversationNoted(item as IntercomConversationItem);
        return;
      case "conversation.admin.closed":
        await this.handleConversationOpenState(item as IntercomConversationItem, "closed");
        return;
      case "conversation.admin.opened":
        await this.handleConversationOpenState(item as IntercomConversationItem, "open");
        return;
      case "conversation.admin.snoozed":
        await this.handleConversationSnoozed(item as IntercomConversationItem);
        return;
      case "conversation.admin.unsnoozed":
        await this.handleConversationUnsnoozed(item as IntercomConversationItem);
        return;
      case "ticket.state.updated":
        await this.handleTicketStateUpdated(item as IntercomTicketItem);
        return;
      case "ticket.admin.replied":
        await this.handleTicketReply(item as IntercomTicketItem, attempt);
        return;
      case "ticket.note.created":
        await this.handleTicketNoteCreated(item as IntercomTicketItem);
        return;
      default:
        return; // unknown topic — drop
    }
  }

  private async handleConversationReply(item: IntercomConversationItem | undefined, attempt: number): Promise<void> {
    const mode = this.settingsStore.intercomMode();
    if (mode === "none" || !item || item.id == null) return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return; // Intercom-native conversation — not ours

    const parts = item.conversation_parts?.conversation_parts ?? [];
    for (const part of parts) {
      await this.processAgentPart("c", link.ticketThreadId, part, attempt);
    }
    await this.diffTags(link.ticketThreadId, item);
  }

  private async handleTicketReply(item: IntercomTicketItem | undefined, attempt: number): Promise<void> {
    const mode = this.settingsStore.intercomMode();
    if (mode === "none" || !item || item.id == null) return;

    const link = await this.store.getLinkByTicketId(String(item.id));
    if (!link) return;

    const parts = item.ticket_parts?.ticket_parts ?? [];
    for (const part of parts) {
      await this.processAgentPart("t", link.ticketThreadId, part, attempt);
    }
  }

  // Shared relay path for agent-authored comment parts, conversation- or
  // ticket-side. Claims each part exactly once; push mode warns instead of
  // relaying; bi mode posts the embed into the Discord thread.
  private async processAgentPart(kind: "c" | "t", threadId: string, part: IntercomWebhookPart, attempt: number): Promise<void> {
    if (part.id == null) return;
    if (part.part_type && part.part_type !== "comment" && part.part_type !== "quick_reply") return;
    // Contact-authored parts can only be our own mirror (customers have no
    // Intercom access) — relay only admin/bot/team authors.
    const authorType = part.author?.type;
    if (authorType && !["admin", "bot", "team"].includes(authorType)) return;

    // Layer 1 — part-id ledger: false = the bridge created this part (recorded
    // at post time) or another delivery already claimed it.
    if (!(await this.store.claimPart(kind, String(part.id), threadId))) return;

    const partHash = bodyHash(part.body ?? "");
    const bridgeAuthor = this.isBridgeAuthor(part);

    if (bridgeAuthor) {
      // Layer 2 — reserve→confirm handshake: a matching pending-post row means
      // this is our own in-flight post whose confirm hasn't landed yet. Record
      // the part id so a duplicate delivery is also caught, then drop.
      if (await this.store.matchAndDeletePendingPost(threadId, partHash)) {
        await this.store.recordEchoPart(kind, String(part.id), threadId).catch(() => {});
        return;
      }
      // Layer 3 — bounded defer: outbound content still queued for this thread
      // could produce this exact part. claimPart above already succeeded, so
      // roll the claim back before deferring — the retry must be able to claim
      // again. `attempt` here is the echo-defer count (tracked separately from
      // real-failure attempts), so deferral can't exhaust the retry budget.
      if (attempt < MAX_DEFER_ATTEMPTS && (await this.hasPendingOutboundContent(threadId))) {
        await this.releaseClaim(kind, String(part.id));
        throw new DeferEchoError();
      }
    }

    const mode = this.settingsStore.intercomMode();
    if (mode === "push") {
      // One-way mirror: warn the agent (once per conversation) that replies here
      // don't reach the customer. markAgentWarned is the race-safe claim.
      if (await this.store.markAgentWarned(threadId)) {
        await this.sync.enqueueAgentWarning(threadId);
      }
      return;
    }

    const body = htmlToDiscordText(part.body ?? "");
    const attachmentLinks = (part.attachments ?? [])
      .filter((a) => a.url)
      .map((a) => `📎 [${a.name ?? "attachment"}](${a.url})`)
      .join("\n");
    const description = [body, attachmentLinks].filter(Boolean).join("\n\n").slice(0, 4096);
    if (!description) return;

    // Layer 4 — cross-topic duplicate guard (same reply arriving on another
    // topic with a different part id). DB-backed: survives restarts.
    if (!(await this.store.claimRelay(threadId, partHash))) return;

    const thread = await this.fetchThread(threadId);
    if (!thread) throw new Error(`Discord thread ${threadId} not fetchable`);

    const avatar = part.author?.avatar;
    const avatarUrl = typeof avatar === "string" ? avatar : avatar?.image_url ?? null;
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setAuthor({
        name: part.author?.name || "Intercom agent",
        ...(avatarUrl ? { iconURL: avatarUrl } : {}),
      })
      .setDescription(description)
      .setTimestamp();

    // Posting into an archived thread: un-archive, send, re-archive. The lock
    // state stays untouched, and the message is bot-authored, so handleMessage
    // ignores it (no reclose interference, no re-mirror to Intercom).
    const wasArchived = thread.archived === true;
    if (wasArchived) await thread.setArchived(false).catch(() => {});
    const ticket = await this.ticketStore.getByThreadId(threadId);
    try {
      await thread.send({
        content: ticket?.customerId ? `<@${ticket.customerId}>` : undefined,
        embeds: [embed],
        allowedMentions: { users: ticket?.customerId ? [ticket.customerId] : [] },
      });
    } finally {
      if (wasArchived) await thread.setArchived(true).catch(() => {});
    }
  }

  private isBridgeAuthor(part: IntercomWebhookPart): boolean {
    const authorId = part.author?.id != null ? String(part.author.id) : null;
    if (!authorId) return false;
    return (
      authorId === this.settingsStore.intercomOperatorAdminId() || authorId === this.settingsStore.intercomAdminId()
    );
  }

  private async hasPendingOutboundContent(threadId: string): Promise<boolean> {
    // Pending-posts (the reserve→confirm handshake) is the in-flight signal;
    // queued-but-unsent workflow outbox events can't have created a part yet,
    // so they don't need to defer the echo decision.
    return this.store.hasPendingPosts(threadId);
  }

  // Rolls back a claimPart so a deferred retry can claim again.
  private async releaseClaim(kind: "c" | "t", partId: string): Promise<void> {
    await this.store.releaseClaim(kind, partId).catch(() => {});
  }

  // Intercom internal notes → the existing staff-note store (visible via
  // /note list + the staff-only audit channel; never in the customer-visible
  // thread). These rows must never mirror back to Intercom — Discord→Intercom
  // note mirroring no longer exists, keep it that way.
  private async handleConversationNoted(item: IntercomConversationItem | undefined): Promise<void> {
    if (!item || item.id == null) return;
    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    for (const part of item.conversation_parts?.conversation_parts ?? []) {
      await this.processNotePart("c", link.ticketThreadId, part);
    }
  }

  private async handleTicketNoteCreated(item: IntercomTicketItem | undefined): Promise<void> {
    if (!item || item.id == null) return;
    const link = await this.store.getLinkByTicketId(String(item.id));
    if (!link) return;
    for (const part of item.ticket_parts?.ticket_parts ?? []) {
      await this.processNotePart("t", link.ticketThreadId, part);
    }
  }

  private async processNotePart(kind: "c" | "t", threadId: string, part: IntercomWebhookPart): Promise<void> {
    if (part.id == null) return;
    // Claim first: bridge-authored notes (context card, agent warning,
    // convert fallback) were recorded at post time and fail the claim here.
    if (!(await this.store.claimPart(kind, String(part.id), threadId))) return;
    if (this.isBridgeAuthor(part) && (await this.store.matchAndDeletePendingPost(threadId, bodyHash(part.body ?? "")))) {
      return;
    }
    if (this.settingsStore.intercomMode() !== "bi") return;

    const text = htmlToDiscordText(part.body ?? "").slice(0, 1900);
    if (!text) return;
    // The same note can surface on both the conversation and the ticket topic.
    if (!(await this.store.claimRelay(threadId, bodyHash(part.body ?? "")))) return;

    const authorName = part.author?.name || "Intercom agent";
    const authorId = part.author?.id != null ? `intercom:${part.author.id}` : "intercom";
    await this.ticketStore.addNote(threadId, authorId, `${authorName} (Intercom)`, text);
    void this.audit.log({
      title: "📝 Staff note (from Intercom)",
      severity: "info",
      actor: authorName,
      threadId,
      fields: [{ name: "Note", value: text.slice(0, 1024), inline: false }],
    });
  }

  // Agent changed the ticket's (custom) state in Intercom → map back to the
  // status tag configured for that state.
  private async handleTicketStateUpdated(item: IntercomTicketItem | undefined): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    if (!item || item.id == null) return;

    const state = item.ticket_state;
    const stateId = state && typeof state === "object" && state.id != null ? String(state.id) : null;
    if (!stateId) return; // system enum only — nothing to map

    const link = await this.store.getLinkByTicketId(String(item.id));
    if (!link) return;
    // Our own PUT echoes back as this topic — the pushed state id marks it.
    if (link.lastSyncedStateId === stateId) return;

    const tag = this.settingsStore.tags().find((t) => t.intercomTicketStateId === stateId);
    if (!tag) return; // unmapped state — Intercom-only concept, ignore

    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket) return;
    if (ticket.statusTagId === tag.id) return; // already there (echo or no-op)

    // Pre-mark the synced state so the push-back triggered by applyStatus
    // skips its ticket update (Intercom already has this state).
    await this.store.setLastSyncedStateId(link.ticketThreadId, stateId);
    const thread = await this.fetchThread(link.ticketThreadId);
    if (!thread) throw new Error(`Discord thread ${link.ticketThreadId} not fetchable`);
    await this.statusService.applyStatus(thread, ticket, tag, { actorName: "Intercom agent" });
  }

  // Conversation closed/reopened in Intercom (bi): minimum close/reopen parity.
  // Converges with ticket.state.updated — whichever arrives first wins, the
  // other becomes a no-op via the statusTagId damper.
  private async handleConversationOpenState(
    item: IntercomConversationItem | undefined,
    target: "open" | "closed"
  ): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    if (!item || item.id == null) return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    // The bridge's own close/open (status parity push) echoes back here.
    if (link.lastSyncedOpen === target) return;

    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket) return;

    if (target === "closed") {
      const closingTag = this.settingsStore.closingTag();
      if (!closingTag) return;
      if (ticket.statusTagId === closingTag.id) return;

      await this.store.setLastSyncedOpen(link.ticketThreadId, "closed");
      const thread = await this.fetchThread(link.ticketThreadId);
      if (!thread) throw new Error(`Discord thread ${link.ticketThreadId} not fetchable`);
      await this.statusService.applyStatus(thread, ticket, closingTag, { actorName: "Intercom agent" });
      return;
    }

    // target === "open": reopen only if the ticket is actually done/closed.
    if (!ticket.closed) return;
    const initialTag = this.settingsStore.initialTag();
    if (!initialTag || ticket.statusTagId === initialTag.id) return;

    await this.store.setLastSyncedOpen(link.ticketThreadId, "open");
    const thread = await this.fetchThread(link.ticketThreadId);
    if (!thread) throw new Error(`Discord thread ${link.ticketThreadId} not fetchable`);
    await this.statusService.applyStatus(thread, ticket, initialTag, { actorName: "Intercom agent" });
  }

  // Agent snoozed in Intercom → configurable snooze status tag in Discord.
  // TicketStore.setStatus persists prevStatusTagId, which unsnooze restores.
  // The snooze tag must be reminder-free, non-closing and unmapped to an
  // Intercom state (the /config picker enforces/warns) — that keeps the
  // reminder scheduler quiet and the executeStatus echo a no-op.
  private async handleConversationSnoozed(item: IntercomConversationItem | undefined): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    if (!item || item.id == null) return;

    const snoozeTagId = this.settingsStore.intercomSnoozeStatusTagId();
    if (!snoozeTagId) return;
    const snoozeTag = this.settingsStore.tagById(snoozeTagId);
    if (!snoozeTag) return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket || ticket.closed || ticket.statusTagId === snoozeTag.id) return;

    const thread = await this.fetchThread(link.ticketThreadId);
    if (!thread) throw new Error(`Discord thread ${link.ticketThreadId} not fetchable`);
    await this.statusService.applyStatus(thread, ticket, snoozeTag, { actorName: "Intercom agent" });

    const until = item.snoozed_until ? `<t:${item.snoozed_until}:f>` : "later";
    await thread
      .send({
        embeds: [
          new EmbedBuilder().setColor(COLORS.neutral).setDescription(`⏸️ Snoozed in Intercom until ${until}.`),
        ],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  // Unsnooze (agent action or customer-reply auto-unsnooze) → restore the tag
  // the ticket had before the snooze. Note the loop: a customer reply in
  // Discord mirrors as a contact reply → Intercom auto-unsnoozes → this
  // handler restores the Discord tag. That is the desired end state.
  private async handleConversationUnsnoozed(item: IntercomConversationItem | undefined): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    if (!item || item.id == null) return;

    const snoozeTagId = this.settingsStore.intercomSnoozeStatusTagId();
    if (!snoozeTagId) return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket || ticket.statusTagId !== snoozeTagId) return;

    const restoreTag =
      (ticket.prevStatusTagId ? this.settingsStore.tagById(ticket.prevStatusTagId) : undefined) ??
      this.settingsStore.initialTag();
    if (!restoreTag || restoreTag.id === snoozeTagId) return;

    const thread = await this.fetchThread(link.ticketThreadId);
    if (!thread) throw new Error(`Discord thread ${link.ticketThreadId} not fetchable`);
    await this.statusService.applyStatus(thread, ticket, restoreTag, { actorName: "Intercom agent" });
    await thread
      .send({
        embeds: [new EmbedBuilder().setColor(COLORS.neutral).setDescription("▶️ Unsnoozed in Intercom.")],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  // Tag changes made in Intercom → one diff embed in the Discord thread.
  // There is no untag webhook topic, so the diff runs on every conversation
  // event that carries tags. Bridge-managed names are skipped; the bridge's
  // own tagging updates lastTagsJson at tag time so it never echoes here.
  private async diffTags(threadId: string, item: IntercomConversationItem): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    const tagList = item.tags?.tags;
    if (!tagList) return;

    const current = tagList.map((t) => t.name).filter((n): n is string => Boolean(n));
    const link = await this.store.getLink(threadId);
    if (!link) return;
    const previous = Array.isArray(link.lastTagsJson) ? (link.lastTagsJson as string[]) : null;

    // First sighting: just baseline, don't narrate history.
    if (previous === null) {
      await this.store.setLastTags(threadId, current);
      return;
    }

    const isManaged = (name: string) => name === "Discord";
    const added = current.filter((t) => !previous.includes(t) && !isManaged(t));
    const removed = previous.filter((t) => !current.includes(t) && !isManaged(t));
    if (added.length === 0 && removed.length === 0) return;

    await this.store.setLastTags(threadId, current);
    const thread = await this.fetchThread(threadId);
    if (!thread) return;
    const parts = [...added.map((t) => `+${t}`), ...removed.map((t) => `−${t}`)].join(" ");
    await thread
      .send({
        embeds: [new EmbedBuilder().setColor(COLORS.neutral).setDescription(`🏷️ Intercom tags: ${parts}`)],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
    if (!this.client) return null;
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel?.isThread() ? (channel as ThreadChannel) : null;
  }
}

// Intercom part bodies are HTML → readable Discord text for embeds/notes.
function htmlToDiscordText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<b>(.*?)<\/b>/gi, "**$1**")
    .replace(/<i>(.*?)<\/i>/gi, "*$1*")
    .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, url, text) => (url === text ? url : `[${text}](${url})`))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
