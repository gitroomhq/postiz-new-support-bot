import { Client, EmbedBuilder, ThreadChannel, Webhook } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { TicketStore } from "../bot/TicketStore";
import { StatusService } from "../bot/StatusService";
import { AuditLogger } from "../bot/AuditLogger";
import { COLORS } from "../util/embeds";
import { IntercomStore } from "./IntercomStore";
import { IntercomSyncService } from "./IntercomSyncService";
import { IntercomClient } from "./IntercomClient";
import { bodyHash } from "./renderDiscordMarkdown";
import { TemporalBufferedError, type TemporalProducers } from "../temporal/producers";
import { INTERCOM_MAX_ECHO_DEFERS } from "../temporal/types";
import { log } from "../util/logger";
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

// The webhook topics the bridge handles — the SINGLE source for every place
// that instructs the operator what to subscribe in the Developer Hub (panel,
// secrets-modal follow-up). Subscriptions are Developer-Hub-only (no public
// API), so drift between instruction texts silently disables features.
// Over-subscribing is harmless: accept() drops anything not in this list
// BEFORE it reaches Temporal, so "click everything" costs only the HTTP
// delivery itself (conversation.user.replied is the noisiest extra — it fires
// once per customer message the bridge mirrors).
export const INTERCOM_WEBHOOK_TOPICS = [
  "conversation.admin.replied",
  "conversation.operator.replied",
  "conversation.admin.noted",
  "conversation.admin.closed",
  "conversation.admin.opened",
  "conversation.admin.snoozed",
  "conversation.admin.unsnoozed",
  "conversation.admin.assigned",
  "conversation.priority.updated",
  "ticket.state.updated",
  "ticket.admin.replied",
  "ticket.note.created",
] as const;

// Shared with intercomInboxWorkflow's defer loop — see INTERCOM_MAX_ECHO_DEFERS.
const MAX_DEFER_ATTEMPTS = INTERCOM_MAX_ECHO_DEFERS;

const HANDLED_TOPICS: ReadonlySet<string> = new Set(INTERCOM_WEBHOOK_TOPICS);

// Discord "Unknown Channel" — the thread was deleted, not a transient failure.
const DISCORD_UNKNOWN_CHANNEL = 10003;

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

  // Throttle for the webhook-health stamp (one settings write per minute, not
  // per event).
  private lastInboundStampMs = 0;
  private wbLog = log.child("intercom:webhook");

  constructor(
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private statusService: StatusService,
    private store: IntercomStore,
    private sync: IntercomSyncService,
    private audit: AuditLogger,
    private intercomClient: IntercomClient
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
    // Webhook-health stamp: this call only happens after HMAC verification, so
    // it proves subscription + secret are alive (shown on the /config panel).
    const nowMs = Date.now();
    if (nowMs - this.lastInboundStampMs > 60_000) {
      this.lastInboundStampMs = nowMs;
      void this.settingsStore.setIntercomLastInboundAt(new Date()).catch(() => {});
    }
    const event = body as IntercomWebhookEvent;
    const topic = event?.topic;
    if (!topic || topic === "ping") return true;
    // Door filter: operators may subscribe every topic in the Developer Hub —
    // anything the bridge doesn't handle is dropped HERE, before it costs a
    // Temporal signal / inbox workflow (conversation.user.replied alone would
    // otherwise fire once per mirrored customer message). process() keeps its
    // unknown-topic default as a backstop.
    if (!HANDLED_TOPICS.has(topic)) return true;
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
      case "conversation.admin.assigned":
        await this.handleConversationAssigned(item as IntercomConversationItem);
        return;
      case "conversation.priority.updated":
        await this.handleConversationPriorityUpdated(item as IntercomConversationItem);
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

    // Everything past the claim can fail transiently (Discord fetch/send). Any
    // throw must roll the claims back, or the Temporal retry finds the part
    // already claimed, early-returns, and the reply is silently lost while the
    // activity reports success.
    let relayKey: string | null = null;
    try {
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
        // could produce this exact part. The catch below rolls the claim back so
        // the retry can claim again. `attempt` here is the echo-defer count
        // (tracked separately from real-failure attempts), so deferral can't
        // exhaust the retry budget.
        if (attempt < MAX_DEFER_ATTEMPTS && (await this.hasPendingOutboundContent(threadId))) {
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
      const attachmentRefs = (part.attachments ?? []).filter((a) => a.url);
      const attachmentLinks = attachmentRefs.map((a) => `📎 [${a.name ?? "attachment"}](${a.url})`).join("\n");
      const description = truncateEmbedText([body, attachmentLinks].filter(Boolean).join("\n\n"), 4096);
      if (!description) return; // genuinely empty part — nothing to relay, keep the claim

      // Layer 4 — cross-topic duplicate guard (same reply arriving on another
      // topic with a different part id). DB-backed: survives restarts. Keyed on
      // content kind + body + attachments so a repeated short reply ("done"),
      // image-only replies and note-vs-reply text can never collide.
      relayKey = `reply:${bodyHash([part.body ?? "", ...attachmentRefs.map((a) => a.url ?? "")].join("\n"))}`;
      if (!(await this.store.claimRelay(threadId, relayKey))) return;

      const thread = await this.requireThread(threadId);
      if (!thread) return; // thread permanently deleted — link disconnected

      const avatar = part.author?.avatar;
      const avatarUrl = typeof avatar === "string" ? avatar : avatar?.image_url ?? null;
      const authorName = part.author?.name || "Intercom agent";

      // Posting into an archived thread: un-archive, send, re-archive. The lock
      // state stays untouched, and the message is bot/webhook-authored, so
      // handleMessage ignores it (no reclose interference, no re-mirror).
      const wasArchived = thread.archived === true;
      if (wasArchived) await thread.setArchived(false).catch(() => {});
      const ticket = await this.ticketStore.getByThreadId(threadId);
      try {
        // Preferred: webhook impersonation — the reply renders as if the agent
        // wrote natively in Discord (their name + Intercom avatar as the
        // message author). Falls back to the neutral embed when the bot lacks
        // Manage Webhooks or the webhook send fails.
        const mention = ticket?.customerId ? `<@${ticket.customerId}> ` : "";
        const sent = await this.relayViaWebhook(thread, ticket?.customerId ?? null, authorName, avatarUrl, {
          content: truncateEmbedText(`${mention}${description}`, 2000),
        });
        if (!sent) {
          const embed = new EmbedBuilder()
            .setColor(COLORS.brand)
            .setAuthor({ name: authorName, ...(avatarUrl ? { iconURL: avatarUrl } : {}) })
            .setDescription(description)
            .setTimestamp();
          await thread.send({
            content: ticket?.customerId ? `<@${ticket.customerId}>` : undefined,
            embeds: [embed],
            allowedMentions: { users: ticket?.customerId ? [ticket.customerId] : [] },
          });
        }
      } finally {
        if (wasArchived) await thread.setArchived(true).catch(() => {});
      }
    } catch (e) {
      await this.releaseClaim(kind, String(part.id));
      if (relayKey) await this.store.releaseRelay(threadId, relayKey).catch(() => {});
      throw e;
    }
  }

  private isBridgeAuthor(part: IntercomWebhookPart): boolean {
    const authorId = part.author?.id != null ? String(part.author.id) : null;
    if (!authorId) return false;
    return (
      authorId === this.settingsStore.intercomOperatorAdminId() || authorId === this.settingsStore.intercomAdminId()
    );
  }

  // Positive attribution gate for inbound events that would REOPEN a closed
  // Discord ticket: true only when the newest authored part is a non-bridge
  // admin/team. Contact ("user"/"lead") activity is by definition the bridge's
  // own mirror (customers have no Intercom access), bot/workflow and
  // unattributed parts are Intercom reacting to bridge activity — none of
  // those may boot a closed ticket. Better to drop a rare ambiguous agent
  // action (they can reopen in Discord) than to mass-reopen on every replay.
  private attributedToRealAgent(parts: IntercomWebhookPart[] | undefined): boolean {
    const author = [...(parts ?? [])].reverse().find((p) => p.author?.type)?.author;
    if (!author || (author.type !== "admin" && author.type !== "team")) return false;
    const id = author.id != null ? String(author.id) : null;
    if (!id) return false;
    return id !== this.settingsStore.intercomOperatorAdminId() && id !== this.settingsStore.intercomAdminId();
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
    // Same rollback contract as processAgentPart: a throw after the claim must
    // release it or the retried delivery silently drops the note.
    let relayKey: string | null = null;
    try {
      if (
        this.isBridgeAuthor(part) &&
        (await this.store.matchAndDeletePendingPost(threadId, bodyHash(part.body ?? "")))
      ) {
        await this.store.recordEchoPart(kind, String(part.id), threadId).catch(() => {});
        return;
      }
      if (this.settingsStore.intercomMode() !== "bi") {
        // Not relayed in push/none — release so a real agent note isn't
        // permanently consumed while the mode is off. Bridge-authored notes
        // (agent warning, context card) stay claimed: a redelivery landing
        // after a flip to bi must never relay the bridge's own note as a
        // "Staff note (from Intercom)".
        if (!this.isBridgeAuthor(part)) await this.releaseClaim(kind, String(part.id));
        return;
      }

      const text = truncateEmbedText(htmlToDiscordText(part.body ?? ""), 1900);
      if (!text) return;
      // The same note can surface on both the conversation and the ticket topic.
      // Distinct key space from replies ("note:" vs "reply:") — identical text
      // in a note and a reply must not collide.
      relayKey = `note:${bodyHash(part.body ?? "")}`;
      if (!(await this.store.claimRelay(threadId, relayKey))) return;

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
    } catch (e) {
      await this.releaseClaim(kind, String(part.id));
      if (relayKey) await this.store.releaseRelay(threadId, relayKey).catch(() => {});
      throw e;
    }
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

    // Resolving the ticket in Intercom (resolved-category state) also closes
    // the conversation — agents expect resolve to clear it from the inbox,
    // and Intercom itself leaves it open. Damper-first so the close's own
    // webhook echo is suppressed; safe for any author (closing is never the
    // boot-a-ticket-open failure mode).
    const stateCategory =
      state && typeof state === "object" && typeof state.category === "string" ? state.category : null;
    if (stateCategory === "resolved" && link.lastSyncedOpen !== "closed") {
      const adminId = this.settingsStore.intercomAuthorAdminId();
      if (adminId) {
        const prevOpen = link.lastSyncedOpen === "open" ? ("open" as const) : null;
        await this.store.setLastSyncedOpen(link.ticketThreadId, "closed");
        try {
          await this.intercomClient.setConversationOpen(link.conversationId, false, adminId);
        } catch {
          await this.store.setLastSyncedOpen(link.ticketThreadId, prevOpen).catch(() => {});
        }
      }
    }

    const tag = this.settingsStore.tags().find((t) => t.intercomTicketStateId === stateId);
    if (!tag) return; // unmapped state — Intercom-only concept, ignore

    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket) return;
    if (ticket.statusTagId === tag.id) return; // already there (echo or no-op)

    // Intercom auto-transitions ticket states on conversation activity —
    // INCLUDING every message the bridge itself mirrors (customer reply →
    // in_progress, staff reply → waiting_on_customer). Those must never drive
    // the Discord status: the bot owns its own waiting-for-customer/team
    // logic, and the auto-transitions would shuffle every ticket on every
    // mirrored message. Positive agent attribution required for ALL inbound
    // state changes; the damper above only covers states the bridge pushed.
    if (!this.attributedToRealAgent(item.ticket_parts?.ticket_parts)) {
      this.wbLog.info("inbound state change dropped — no non-bridge agent attribution", {
        "intercom.ticket_id": String(item.id),
        "ticket.thread_id": link.ticketThreadId,
        "intercom.state_id": stateId,
      });
      return;
    }

    // Pre-mark the synced state so the push-back triggered by applyStatus
    // skips its ticket update (Intercom already has this state). Rolled back on
    // failure — otherwise the retry short-circuits on the damper above and the
    // Intercom-side state change is silently lost.
    const prevStateId = link.lastSyncedStateId;
    await this.store.setLastSyncedStateId(link.ticketThreadId, stateId);
    try {
      const thread = await this.requireThread(link.ticketThreadId);
      if (!thread) return;
      await this.statusService.applyStatus(thread, ticket, tag, { actorName: "Intercom agent" });
    } catch (e) {
      await this.store.setLastSyncedStateId(link.ticketThreadId, prevStateId).catch(() => {});
      throw e;
    }
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

    const prevOpen = link.lastSyncedOpen === "open" || link.lastSyncedOpen === "closed" ? link.lastSyncedOpen : null;

    if (target === "closed") {
      const closingTag = this.settingsStore.closingTag();
      if (!closingTag) return;
      if (ticket.statusTagId === closingTag.id) return;

      // Damper pre-mark with rollback on failure (see handleTicketStateUpdated).
      await this.store.setLastSyncedOpen(link.ticketThreadId, "closed");
      try {
        const thread = await this.requireThread(link.ticketThreadId);
        if (!thread) return;
        await this.statusService.applyStatus(thread, ticket, closingTag, { actorName: "Intercom agent" });
      } catch (e) {
        await this.store.setLastSyncedOpen(link.ticketThreadId, prevOpen).catch(() => {});
        throw e;
      }
      return;
    }

    // target === "open": Intercom auto-reopens conversations on all kinds of
    // activity the bridge itself causes (mirrored contact replies, ticket
    // state/attribute writes) — and payload shapes vary, so the rule is
    // POSITIVE ATTRIBUTION: only a reopen provably authored by a real,
    // non-bridge agent may touch the Discord status. Everything else is the
    // bridge's own echo or ambiguous — drop it (and if it was our own admin
    // write that reopened a closed conversation, restore the close).
    const openParts = item.conversation_parts?.conversation_parts ?? [];
    const openPart = openParts.find((p) => p.part_type === "open") ?? openParts[openParts.length - 1];
    if (openPart && this.isBridgeAuthor(openPart)) {
      if (link.lastSyncedOpen === "closed") {
        const adminId = this.settingsStore.intercomAuthorAdminId();
        if (adminId) {
          await this.intercomClient.setConversationOpen(link.conversationId, false, adminId).catch(() => {});
        }
      }
      return;
    }
    if (!this.attributedToRealAgent(openParts)) {
      this.wbLog.info("inbound reopen dropped — not attributable to a non-bridge agent", {
        "intercom.conversation_id": String(item.id),
        "ticket.thread_id": link.ticketThreadId,
      });
      return;
    }

    // Reopen only if the ticket is actually done/closed.
    if (!ticket.closed) return;
    const initialTag = this.settingsStore.initialTag();
    if (!initialTag || ticket.statusTagId === initialTag.id) return;

    await this.store.setLastSyncedOpen(link.ticketThreadId, "open");
    try {
      const thread = await this.requireThread(link.ticketThreadId);
      if (!thread) return;
      await this.statusService.applyStatus(thread, ticket, initialTag, { actorName: "Intercom agent" });
    } catch (e) {
      await this.store.setLastSyncedOpen(link.ticketThreadId, prevOpen).catch(() => {});
      throw e;
    }
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

    const thread = await this.requireThread(link.ticketThreadId);
    if (!thread) return;
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

    const thread = await this.requireThread(link.ticketThreadId);
    if (!thread) return;
    await this.statusService.applyStatus(thread, ticket, restoreTag, { actorName: "Intercom agent" });
    await thread
      .send({
        embeds: [new EmbedBuilder().setColor(COLORS.neutral).setDescription("▶️ Unsnoozed in Intercom.")],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  // Agent took (or was handed) the conversation in Intercom → one neutral
  // embed in the Discord thread so staff know who owns it. Damped by
  // lastAssigneeId; the damper is set before the send — losing one cosmetic
  // embed to a transient failure beats duplicating it on retry.
  private async handleConversationAssigned(item: IntercomConversationItem | undefined): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    if (!item || item.id == null) return;

    const assigneeId = item.admin_assignee_id != null ? String(item.admin_assignee_id) : null;
    if (!assigneeId || assigneeId === "0") return; // unassigned / team-only routing

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    if (link.lastAssigneeId === assigneeId) return; // echo or duplicate delivery
    await this.store.setLastAssigneeId(link.ticketThreadId, assigneeId);

    const name = await this.lookupAdminName(assigneeId);

    const thread = await this.requireThread(link.ticketThreadId);
    if (!thread) return;
    await thread
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.neutral)
            .setDescription(`👤 Assigned to ${name ?? "an Intercom agent"} in Intercom.`),
        ],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  // Agent set the NATIVE priority level in Intercom → the Discord priority tag
  // with the matching label (Urgent/High/Medium/Low, case-insensitive). The
  // level is read-only via the public API, so this can never be an echo of the
  // bridge's own writes (outbound priority lives in the custom "Priority"
  // ticket attribute). The resulting Discord change pushes back only to that
  // custom attribute — no loop.
  private async handleConversationPriorityUpdated(item: IntercomConversationItem | undefined): Promise<void> {
    if (this.settingsStore.intercomMode() !== "bi") return;
    if (!item || item.id == null) return;
    const level = typeof item.priority === "string" ? item.priority.toLowerCase() : null;
    // "none" (cleared) has no Discord counterpart; legacy binary
    // "priority"/"not_priority" payloads match no label and fall out below.
    if (!level || level === "none") return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    const priority = this.settingsStore.priorities().find((p) => p.label.toLowerCase() === level);
    if (!priority) return; // no Discord priority tag with that label — ignore
    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket || ticket.priorityTagId === priority.id) return;

    const thread = await this.requireThread(link.ticketThreadId);
    if (!thread) return;
    await this.statusService.applyPriority(thread, ticket, priority, { actorName: "Intercom agent" });
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

  // ---- Agent-reply webhook impersonation ----
  // One bot-owned webhook per parent channel (cached; threads post through the
  // parent with threadId). Webhook messages carry author.bot=true, so the
  // messageCreate mirror skips them — same loop safety as the embed path.

  private static readonly RELAY_WEBHOOK_NAME = "Intercom Agent Relay";
  private relayWebhooks = new Map<string, Webhook>();

  private async relayViaWebhook(
    thread: ThreadChannel,
    customerId: string | null,
    authorName: string,
    avatarUrl: string | null,
    message: { content: string }
  ): Promise<boolean> {
    const send = async (webhook: Webhook): Promise<void> => {
      await webhook.send({
        content: message.content,
        username: sanitizeWebhookUsername(authorName),
        ...(avatarUrl ? { avatarURL: avatarUrl } : {}),
        threadId: thread.id,
        allowedMentions: { users: customerId ? [customerId] : [] },
      });
    };
    try {
      const webhook = await this.getRelayWebhook(thread);
      if (!webhook) return false;
      await send(webhook);
      return true;
    } catch {
      // Stale cache (webhook deleted by a mod) — refetch once, then give up to
      // the embed fallback. Never throw: the caller's fallback owns failure.
      this.relayWebhooks.delete(thread.parentId ?? "");
      try {
        const webhook = await this.getRelayWebhook(thread);
        if (!webhook) return false;
        await send(webhook);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async getRelayWebhook(thread: ThreadChannel): Promise<Webhook | null> {
    const parentId = thread.parentId;
    if (!parentId || !this.client) return null;
    const cached = this.relayWebhooks.get(parentId);
    if (cached) return cached;

    const parent = thread.parent ?? (await this.client.channels.fetch(parentId).catch(() => null));
    if (!parent || parent.isThread() || !("fetchWebhooks" in parent)) return null;
    try {
      const hooks = await parent.fetchWebhooks();
      const mine =
        hooks.find(
          (h) => h.owner?.id === this.client?.user?.id && h.name === IntercomWebhookHandler.RELAY_WEBHOOK_NAME
        ) ??
        (await parent.createWebhook({
          name: IntercomWebhookHandler.RELAY_WEBHOOK_NAME,
          reason: "Intercom bridge: agent replies render under the agent's own name",
        }));
      this.relayWebhooks.set(parentId, mine);
      return mine;
    } catch {
      return null; // Missing Manage Webhooks — embed fallback
    }
  }

  // Admin id → display name, cached 10 min (assignment events would otherwise
  // pay a full /admins listing each; the lookup is purely cosmetic).
  private adminNamesCache: { at: number; names: Map<string, string> } | null = null;

  private async lookupAdminName(adminId: string): Promise<string | null> {
    const now = Date.now();
    if (!this.adminNamesCache || now - this.adminNamesCache.at > 10 * 60 * 1000) {
      try {
        const admins = await this.intercomClient.listAdmins();
        this.adminNamesCache = {
          at: now,
          names: new Map(admins.filter((a) => a.name).map((a) => [a.id, a.name!] as const)),
        };
      } catch {
        return this.adminNamesCache?.names.get(adminId) ?? null; // stale beats nothing
      }
    }
    return this.adminNamesCache.names.get(adminId) ?? null;
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
    if (!this.client) return null;
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel?.isThread() ? (channel as ThreadChannel) : null;
  }

  // Strict thread fetch for relay/state handlers: throws on transient Discord
  // failures (the inbox workflow retries); a permanently-deleted thread
  // (Unknown Channel) disconnects the link and returns null so the event —
  // and every future event on this conversation — stops dead-lettering.
  private async requireThread(threadId: string): Promise<ThreadChannel | null> {
    if (!this.client) throw new Error("Discord client not bound yet");
    let channel;
    try {
      channel = await this.client.channels.fetch(threadId);
    } catch (e) {
      if ((e as { code?: number }).code === DISCORD_UNKNOWN_CHANNEL) {
        await this.disconnectDeletedThread(threadId);
        return null;
      }
      throw e;
    }
    if (channel?.isThread()) return channel as ThreadChannel;
    await this.disconnectDeletedThread(threadId);
    return null;
  }

  // The Discord thread is gone for good: drop the link (deleteLink's count
  // makes this exactly-once under concurrent inbound events), leave a note in
  // the Intercom conversation, and audit.
  private async disconnectDeletedThread(threadId: string): Promise<void> {
    const link = await this.store.getLink(threadId);
    if (!link) return;
    const removed = await this.store.deleteLink(threadId);
    if (removed === 0) return; // another handler already disconnected it

    const adminId = this.settingsStore.intercomAuthorAdminId();
    if (adminId) {
      await this.intercomClient
        .replyAsAdmin(link.conversationId, {
          adminId,
          body: "<p>⚠️ The linked Discord thread was deleted — this conversation is no longer bridged. Replies here will not reach the customer.</p>",
          note: true,
        })
        .catch(() => {});
    }
    void this.audit.log({
      title: "🔌 Intercom bridge disconnected",
      severity: "warn",
      actor: "Intercom bridge",
      threadId,
      fields: [
        { name: "Reason", value: "Discord thread deleted", inline: false },
        { name: "Conversation", value: link.conversationId, inline: true },
      ],
    });
  }
}

// Intercom part bodies are HTML → readable Discord text for embeds/notes.
function htmlToDiscordText(html: string): string {
  return (
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<blockquote[^>]*>/gi, "\n> ")
      .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, "*$2*")
      // Inline-pasted screenshots live in the body as <img>, not in
      // `attachments` — without this an image-only agent reply renders empty
      // and the customer receives nothing.
      .replace(/<img[^>]*src="([^"]+)"[^>]*\/?>/gi, (_m, src) => `📷 [image](${src})`)
      .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, url, text) => (url === text ? url : `[${text}](${url})`))
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      // &amp; must decode LAST: decoding it first turns "&amp;lt;" into "&lt;"
      // which the next rule then double-decodes into "<".
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .trim()
  );
}

// Discord rejects webhook usernames containing "discord"/"clyde" (any case)
// and caps them at 80 chars.
function sanitizeWebhookUsername(name: string): string {
  const cleaned = name.replace(/discord|clyde/gi, "").trim().slice(0, 80);
  return cleaned || "Intercom agent";
}

// Embed-safe truncation: ellipsis marker, never splits a surrogate pair (a
// lone surrogate makes Discord reject the whole embed).
function truncateEmbedText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
