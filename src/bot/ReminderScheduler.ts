import { Client, ThreadChannel } from "discord.js";
import { StatusTag } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { TicketStore, TicketWithTag } from "./TicketStore";
import { StatusService, RESOLVED_EMOJI } from "./StatusService";
import { embed, COLORS } from "../util/embeds";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
// Days of customer silence after a ticket is marked Resolved before it auto-closes,
// used when the Resolved tag has no autoCloseAfter configured.
const DEFAULT_RESOLVED_AUTO_CLOSE_DAYS = 3;

export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private client: Client,
    private settings: SettingsStore,
    private ticketStore: TicketStore,
    private statusService: StatusService
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => console.error("Reminder scheduler error:", err));
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const tickets = await this.ticketStore.listRemindable();
    for (const ticket of tickets) {
      try {
        await this.processTicket(ticket);
      } catch (err) {
        console.error(`Reminder check failed for thread ${ticket.threadId}:`, err);
      }
    }
    await this.processResolvedAutoClose();
  }

  // Resolved tickets archive but stay unlocked so the customer can reply to reopen.
  // If they don't reply within the configured window, close (lock + archive) the ticket.
  private async processResolvedAutoClose(): Promise<void> {
    const resolvedTag = this.settings.tagByEmoji(RESOLVED_EMOJI);
    const closingTag = this.settings.closingTag();
    if (!resolvedTag || !closingTag) return;

    const days = resolvedTag.autoCloseAfter ?? DEFAULT_RESOLVED_AUTO_CLOSE_DAYS;
    const tickets = await this.ticketStore.listInStatus(resolvedTag.id);
    for (const ticket of tickets) {
      try {
        await this.processResolvedTicket(ticket, closingTag, days);
      } catch (err) {
        console.error(`Resolved auto-close failed for thread ${ticket.threadId}:`, err);
      }
    }
  }

  private async processResolvedTicket(
    ticket: TicketWithTag,
    closingTag: StatusTag,
    days: number
  ): Promise<void> {
    const channel = await this.client.channels.fetch(ticket.threadId).catch(() => null);
    if (!channel || !channel.isThread()) {
      await this.ticketStore.close(ticket.threadId);
      return;
    }
    const thread = channel as ThreadChannel;
    // Already locked → effectively closed; nothing to do.
    if (thread.locked) return;

    // A customer reply normally reopens the ticket (see DiscordBot.handleMessage); if one
    // slipped through, don't auto-close on top of an unanswered customer message.
    const awaitedAt = await this.lastAwaitedMessageAt(thread, "CUSTOMER", ticket.customerId);
    if (awaitedAt && awaitedAt > ticket.lastStatusChangeAt.getTime()) return;

    if (Date.now() - ticket.lastStatusChangeAt.getTime() < days * DAY_MS) return;

    await this.statusService.applyStatus(thread, ticket, closingTag, { actorName: "Automatic" });
  }

  private async processTicket(ticket: TicketWithTag): Promise<void> {
    const tag = ticket.statusTag;
    if (!tag) return;

    const channel = await this.client.channels.fetch(ticket.threadId).catch(() => null);
    if (!channel || !channel.isThread()) {
      await this.ticketStore.close(ticket.threadId);
      return;
    }
    const thread = channel as ThreadChannel;
    if (thread.archived || thread.locked) return;

    const target = tag.reminderTarget === "CUSTOMER" ? "CUSTOMER" : "SUPPORT";
    if (target === "CUSTOMER" && !ticket.customerId) return;

    const awaitedAt = await this.lastAwaitedMessageAt(thread, target, ticket.customerId);
    const reference = Math.max(
      ticket.lastStatusChangeAt.getTime(),
      awaitedAt ?? 0,
      ticket.lastReminderAt?.getTime() ?? 0
    );

    if (Date.now() - reference < tag.reminderDays * DAY_MS) return;

    // Auto-close stale Waiting-for-Customer tickets once N reminders have gone unanswered.
    if (target === "CUSTOMER" && tag.autoCloseAfter != null && ticket.reminderCount >= tag.autoCloseAfter) {
      const closingTag = this.settings.closingTag();
      if (closingTag) {
        await this.statusService.applyStatus(thread, ticket, closingTag, { actorName: "Automatic" });
        return;
      }
    }

    if (target === "CUSTOMER") {
      await thread.send({
        content: `<@${ticket.customerId}>`,
        embeds: [
          embed(
            `We're still waiting on your reply to keep helping you. This ticket may be closed if we don't hear back.\n\nStatus: ${tag.emoji} ${tag.label}`,
            COLORS.warn
          ),
        ],
        allowedMentions: { users: [ticket.customerId!] },
      });
    } else {
      const supportRoleId = this.settings.supportRoleId();
      if (!supportRoleId) return;
      await thread.send({
        content: `<@&${supportRoleId}>`,
        embeds: [
          embed(
            `This ticket has gone ${tag.reminderDays} day(s) without a reply — please follow up.\n\nStatus: ${tag.emoji} ${tag.label}`,
            COLORS.warn
          ),
        ],
        allowedMentions: { roles: [supportRoleId] },
      });
    }

    await this.ticketStore.recordReminder(ticket.threadId);
  }

  // Timestamp of the most recent message from the party we're waiting on; bot
  // messages never count. SUPPORT = any human who isn't the customer.
  private async lastAwaitedMessageAt(
    thread: ThreadChannel,
    target: "SUPPORT" | "CUSTOMER",
    customerId: string | null
  ): Promise<number | null> {
    const messages = await thread.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return null;

    let latest: number | null = null;
    for (const message of messages.values()) {
      if (message.author.bot) continue;
      const isMatch =
        target === "CUSTOMER" ? message.author.id === customerId : message.author.id !== customerId;
      if (isMatch && (latest === null || message.createdTimestamp > latest)) {
        latest = message.createdTimestamp;
      }
    }
    return latest;
  }
}
