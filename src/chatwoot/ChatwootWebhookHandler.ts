import { Client, EmbedBuilder, ThreadChannel } from "discord.js";
import { SettingsStore } from "../config/SettingsStore";
import { TicketStore } from "../bot/TicketStore";
import { StatusService } from "../bot/StatusService";
import { COLORS } from "../util/embeds";
import { ChatwootStore } from "./ChatwootStore";
import { ChatwootSyncService } from "./ChatwootSyncService";
import { ChatwootWebhookEvent } from "./types";

// Handles inbound Chatwoot webhooks (message_created, conversation_status_changed).
// Only conversations with a ChatwootLink row are bridge-managed — everything else
// (email/live-chat conversations native to Chatwoot) is dropped untouched.
//
// Constructed before the Discord client exists (CallbackServer needs the handler
// at bot construction time), so the client is bound late — AuditLogger precedent.
export class ChatwootWebhookHandler {
  private client: Client | null = null;

  constructor(
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private statusService: StatusService,
    private store: ChatwootStore,
    private sync: ChatwootSyncService
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  // Never throws: the webhook route already answered 200 and Chatwoot doesn't
  // retry meaningfully — a lost event must not crash anything.
  async handle(body: unknown): Promise<void> {
    try {
      const event = body as ChatwootWebhookEvent;
      switch (event?.event) {
        case "message_created":
          await this.handleMessageCreated(event);
          return;
        case "conversation_status_changed":
          await this.handleStatusChanged(event);
          return;
        default:
          return; // conversation_updated, message_updated, … — out of scope
      }
    } catch (e) {
      console.error("Chatwoot webhook handling failed:", e);
    }
  }

  private async handleMessageCreated(event: ChatwootWebhookEvent): Promise<void> {
    const mode = this.settingsStore.chatwootMode();
    if (mode === "none") return;

    const conversationId = event.conversation?.display_id ?? event.conversation?.id;
    if (!conversationId) return;
    const link = await this.store.getLinkByConversationId(conversationId);
    if (!link) return; // Chatwoot-native conversation (email/live chat) — not ours

    // Our own mirrored messages echo back with the bridge stamp — drop them.
    if (event.content_attributes?.discord_bridge) return;
    // Belt and braces: anything sent by an agent bot is the bridge itself
    // (incoming contact-messages carry no stamp, but they fail the outgoing
    // check below anyway).
    if (event.sender?.type === "agent_bot") return;
    // Private notes are never relayed.
    if (event.private === true) return;
    // Only agent replies (outgoing) matter; contact messages can't originate in
    // an API-channel inbox except through us.
    const type = event.message_type;
    if (type !== "outgoing" && type !== 1) return;

    if (mode === "push") {
      // One-way mirror: warn the agent (once per conversation) that replies here
      // don't reach the customer. markAgentWarned is the race-safe claim.
      if (await this.store.markAgentWarned(link.ticketThreadId)) {
        await this.sync.enqueueAgentWarning(link.ticketThreadId);
      }
      return;
    }

    // bi: relay the agent reply into the Discord thread as an embed.
    const thread = await this.fetchThread(link.ticketThreadId);
    if (!thread) return;

    const senderName = event.sender?.available_name || event.sender?.name || "Chatwoot agent";
    const attachmentLinks = (event.attachments ?? [])
      .filter((a) => a.data_url)
      .map((a) => `📎 [${a.file_name ?? "attachment"}](${a.data_url})`)
      .join("\n");
    const description = [event.content ?? "", attachmentLinks].filter(Boolean).join("\n\n").slice(0, 4096);
    if (!description) return;

    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setAuthor({
        name: senderName,
        ...(event.sender?.avatar_url ? { iconURL: event.sender.avatar_url } : {}),
      })
      .setDescription(description)
      .setTimestamp();

    // Posting into an archived thread: un-archive, send, re-archive. The lock
    // state stays untouched, and the message is bot-authored, so handleMessage
    // ignores it (no reclose interference, no re-mirror to Chatwoot).
    const wasArchived = thread.archived === true;
    if (wasArchived) await thread.setArchived(false).catch(() => {});
    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    await thread
      .send({
        content: ticket?.customerId ? `<@${ticket.customerId}>` : undefined,
        embeds: [embed],
        allowedMentions: { users: ticket?.customerId ? [ticket.customerId] : [] },
      })
      .catch((e) => console.error(`Chatwoot relay to thread ${link.ticketThreadId} failed:`, e));
    if (wasArchived) await thread.setArchived(true).catch(() => {});
  }

  private async handleStatusChanged(event: ChatwootWebhookEvent): Promise<void> {
    if (this.settingsStore.chatwootMode() !== "bi") return;

    // For this event the payload IS the conversation object.
    const conversationId = event.display_id ?? event.id ?? event.conversation?.display_id ?? event.conversation?.id;
    const status = event.status ?? event.conversation?.status;
    if (!conversationId || !status) return;
    const link = await this.store.getLinkByConversationId(conversationId);
    if (!link) return;
    if (status !== "resolved" && status !== "open") return; // pending/snoozed ignored

    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket) return;

    if (status === "resolved") {
      // Chatwoot resolve → Closed (locked + archived), per bridge semantics.
      const closingTag = this.settingsStore.closingTag();
      if (!closingTag) return;
      // Damping: already in the target state → this is our own echo (or a no-op).
      if (ticket.statusTagId === closingTag.id) return;

      // Pre-mark the synced status so the push-back triggered by applyStatus
      // skips its toggle_status call (Chatwoot is already resolved).
      await this.store.setLastSyncedStatus(link.ticketThreadId, "resolved");
      const thread = await this.fetchThread(link.ticketThreadId);
      if (!thread) return;
      await this.statusService.applyStatus(thread, ticket, closingTag, { actorName: "Chatwoot agent" });
      return;
    }

    // status === "open": reopen only if the ticket is actually done/closed.
    if (!ticket.closed) return;
    const initialTag = this.settingsStore.initialTag();
    if (!initialTag || ticket.statusTagId === initialTag.id) return;

    await this.store.setLastSyncedStatus(link.ticketThreadId, "open");
    const thread = await this.fetchThread(link.ticketThreadId);
    if (!thread) return;
    await this.statusService.applyStatus(thread, ticket, initialTag, { actorName: "Chatwoot agent" });
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
    if (!this.client) return null;
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel?.isThread() ? (channel as ThreadChannel) : null;
  }
}
