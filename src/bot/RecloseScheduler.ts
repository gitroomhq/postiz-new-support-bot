import { Client, ThreadChannel } from "discord.js";
import { TicketStore, TicketWithTag } from "./TicketStore";
import { AuditLogger } from "./AuditLogger";

// Posting in a closed (locked + archived) thread un-archives it. Instead of slamming it
// shut mid-conversation, the message handler stamps recloseAt = last message + 30m — every
// new message pushes the deadline back — and this scheduler re-locks the thread once the
// conversation has actually gone quiet.
export const RECLOSE_DELAY_MS = 30 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

export class RecloseScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private client: Client,
    private ticketStore: TicketStore,
    private audit: AuditLogger
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error("Reclose scheduler error:", err));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const due = await this.ticketStore.listRecloseDue(new Date());
    for (const ticket of due) {
      try {
        await this.processTicket(ticket);
      } catch (err) {
        console.error(`Re-close failed for thread ${ticket.threadId}:`, err);
      }
    }
  }

  private async processTicket(ticket: TicketWithTag): Promise<void> {
    const channel = await this.client.channels.fetch(ticket.threadId).catch(() => null);
    if (!channel || !channel.isThread()) {
      // Thread gone — nothing left to re-close.
      await this.ticketStore.clearReclose(ticket.threadId);
      return;
    }
    const thread = channel as ThreadChannel;

    // If a message arrived while the bot was down, the stored deadline is stale —
    // push it to lastMessage + 30m instead of re-closing mid-conversation.
    const lastHumanAt = await this.lastHumanMessageAt(thread);
    if (lastHumanAt && lastHumanAt + RECLOSE_DELAY_MS > Date.now()) {
      await this.ticketStore.scheduleReclose(ticket.threadId, new Date(lastHumanAt + RECLOSE_DELAY_MS));
      return;
    }

    const alreadyShut = thread.locked && thread.archived;
    if (!alreadyShut) {
      // Same order as StatusService: lock while still active, then archive separately.
      await thread.setLocked(true).catch(() => {});
      await thread.setArchived(true).catch(() => {});
    }
    await this.ticketStore.clearReclose(ticket.threadId);

    if (!alreadyShut) {
      void this.audit.log({
        title: "🔁 Ticket re-closed",
        severity: "neutral",
        actor: "Automatic",
        threadId: ticket.threadId,
        fields: [{ name: "Reason", value: "30 min of silence after activity in a closed ticket", inline: true }],
      });
    }
  }

  private async lastHumanMessageAt(thread: ThreadChannel): Promise<number | null> {
    const messages = await thread.messages.fetch({ limit: 20 }).catch(() => null);
    if (!messages) return null;

    let latest: number | null = null;
    for (const message of messages.values()) {
      if (message.author.bot) continue;
      if (latest === null || message.createdTimestamp > latest) latest = message.createdTimestamp;
    }
    return latest;
  }
}
