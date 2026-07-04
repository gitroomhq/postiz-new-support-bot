import { createHash } from "node:crypto";
import { Client, EmbedBuilder, ThreadChannel } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { TicketStore } from "../bot/TicketStore";
import { StatusService } from "../bot/StatusService";
import { COLORS } from "../util/embeds";
import { IntercomStore } from "./IntercomStore";
import { IntercomSyncService } from "./IntercomSyncService";
import {
  IntercomConversationItem,
  IntercomTicketItem,
  IntercomWebhookEvent,
  IntercomWebhookPart,
} from "./types";

// The same agent action can surface on two topics (e.g. a Fin reply on both
// conversation.operator.replied and conversation.admin.replied, or a ticket
// reply mirrored onto the conversation) with different part-id spaces — a
// short-lived body hash catches what the part-id ledger can't.
const RECENT_RELAY_TTL_MS = 120 * 1000;

// Handles inbound Intercom webhooks. Only conversations/tickets with an
// IntercomLink row are bridge-managed — everything else (Intercom-native
// conversations) is dropped untouched.
//
// Echo suppression is part-id based (identity-independent): the outbox records
// every part the bridge creates, and this handler atomically claims each part
// it sees. A failed claim = our own echo or a duplicate delivery.
//
// Constructed before the Discord client exists (CallbackServer needs the
// handler at bot construction time), so the client is bound late.
export class IntercomWebhookHandler {
  private client: Client | null = null;
  private recentRelays = new Map<string, number>();

  constructor(
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private statusService: StatusService,
    private store: IntercomStore,
    private sync: IntercomSyncService
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  // Never throws: the webhook route already answered 200 (Intercom's response
  // window is 5s and it retries only once) — a lost event must not crash anything.
  async handle(body: unknown): Promise<void> {
    try {
      const event = body as IntercomWebhookEvent;
      const item = event?.data?.item;
      switch (event?.topic) {
        case "conversation.admin.replied":
        case "conversation.operator.replied":
          await this.handleConversationReply(item as IntercomConversationItem);
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
        case "ticket.state.updated":
          await this.handleTicketStateUpdated(item as IntercomTicketItem);
          return;
        case "ticket.admin.replied":
          await this.handleTicketReply(item as IntercomTicketItem);
          return;
        default:
          return; // ping, conversation.admin.snoozed, … — out of scope
      }
    } catch (e) {
      console.error("Intercom webhook handling failed:", e);
    }
  }

  private async handleConversationReply(item: IntercomConversationItem | undefined): Promise<void> {
    const mode = this.settingsStore.intercomMode();
    if (mode === "none" || !item || item.id == null) return;

    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return; // Intercom-native conversation — not ours

    const parts = item.conversation_parts?.conversation_parts ?? [];
    for (const part of parts) {
      await this.processAgentPart("c", link.ticketThreadId, part);
    }
  }

  private async handleTicketReply(item: IntercomTicketItem | undefined): Promise<void> {
    const mode = this.settingsStore.intercomMode();
    if (mode === "none" || !item || item.id == null) return;

    const link = await this.store.getLinkByTicketId(String(item.id));
    if (!link) return;

    const parts = item.ticket_parts?.ticket_parts ?? [];
    for (const part of parts) {
      await this.processAgentPart("t", link.ticketThreadId, part);
    }
  }

  // Shared relay path for agent-authored comment parts, conversation- or
  // ticket-side. Claims each part exactly once; push mode warns instead of
  // relaying; bi mode posts the embed into the Discord thread.
  private async processAgentPart(kind: "c" | "t", threadId: string, part: IntercomWebhookPart): Promise<void> {
    if (part.id == null) return;
    if (part.part_type && part.part_type !== "comment" && part.part_type !== "quick_reply") return;
    // Contact-authored parts can only be our own mirror (customers have no
    // Intercom access) — relay only admin/bot/team authors.
    const authorType = part.author?.type;
    if (authorType && !["admin", "bot", "team"].includes(authorType)) return;

    // The route already answered 200; this brief wait closes the race where the
    // webhook for a bridge-created part arrives before the outbox has written
    // its recordEchoPart row (which the claim below relies on).
    await sleep(1500);

    // The claim is the echo/duplicate gate: false = the bridge created this
    // part (recorded at post time) or another delivery got here first.
    if (!(await this.store.claimPart(kind, String(part.id), threadId))) return;

    const mode = this.settingsStore.intercomMode();
    if (mode === "push") {
      // One-way mirror: warn the agent (once per conversation) that replies here
      // don't reach the customer. markAgentWarned is the race-safe claim.
      if (await this.store.markAgentWarned(threadId)) {
        await this.sync.enqueueAgentWarning(threadId);
      }
      return;
    }

    const body = htmlToText(part.body ?? "");
    const attachmentLinks = (part.attachments ?? [])
      .filter((a) => a.url)
      .map((a) => `📎 [${a.name ?? "attachment"}](${a.url})`)
      .join("\n");
    const description = [body, attachmentLinks].filter(Boolean).join("\n\n").slice(0, 4096);
    if (!description) return;

    // Cross-topic duplicate guard (same reply arriving with different part ids).
    const relayKey = createHash("sha256").update(`${threadId}:${description.replace(/\s+/g, " ")}`).digest("hex");
    const now = Date.now();
    for (const [key, at] of this.recentRelays) {
      if (now - at > RECENT_RELAY_TTL_MS) this.recentRelays.delete(key);
    }
    if (this.recentRelays.has(relayKey)) return;
    this.recentRelays.set(relayKey, now);

    const thread = await this.fetchThread(threadId);
    if (!thread) return;

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
    await thread
      .send({
        content: ticket?.customerId ? `<@${ticket.customerId}>` : undefined,
        embeds: [embed],
        allowedMentions: { users: ticket?.customerId ? [ticket.customerId] : [] },
      })
      .catch((e) => console.error(`Intercom relay to thread ${threadId} failed:`, e));
    if (wasArchived) await thread.setArchived(true).catch(() => {});
  }

  // Notes are never relayed (the customer sits in the Discord thread), but
  // claiming their part ids keeps the ledger consistent for duplicate topics.
  private async handleConversationNoted(item: IntercomConversationItem | undefined): Promise<void> {
    if (!item || item.id == null) return;
    const link = await this.store.getLinkByConversationId(String(item.id));
    if (!link) return;
    for (const part of item.conversation_parts?.conversation_parts ?? []) {
      if (part.id != null) await this.store.claimPart("c", String(part.id), link.ticketThreadId);
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

    const tag = this.settingsStore.tags().find((t) => t.intercomTicketStateId === stateId);
    if (!tag) return; // unmapped state — Intercom-only concept, ignore

    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket) return;
    if (ticket.statusTagId === tag.id) return; // already there (echo or no-op)

    // Pre-mark the synced state so the push-back triggered by applyStatus
    // skips its ticket update (Intercom already has this state).
    await this.store.setLastSyncedStateId(link.ticketThreadId, stateId);
    const thread = await this.fetchThread(link.ticketThreadId);
    if (!thread) return;
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
      if (!thread) return;
      await this.statusService.applyStatus(thread, ticket, closingTag, { actorName: "Intercom agent" });
      return;
    }

    // target === "open": reopen only if the ticket is actually done/closed.
    if (!ticket.closed) return;
    const initialTag = this.settingsStore.initialTag();
    if (!initialTag || ticket.statusTagId === initialTag.id) return;

    await this.store.setLastSyncedOpen(link.ticketThreadId, "open");
    const thread = await this.fetchThread(link.ticketThreadId);
    if (!thread) return;
    await this.statusService.applyStatus(thread, ticket, initialTag, { actorName: "Intercom agent" });
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
    if (!this.client) return null;
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel?.isThread() ? (channel as ThreadChannel) : null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Intercom part bodies are HTML (2.15 claims plain text in webhook payloads —
// strip defensively anyway).
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
