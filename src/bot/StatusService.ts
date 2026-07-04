import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ThreadChannel } from "discord.js";
import { StatusTag, PriorityTag } from "../generated/prisma/client";
import { TicketStore } from "./TicketStore";
import { AuditLogger } from "./AuditLogger";
import { SettingsStore } from "../config/SettingsStore";
import { embed, COLORS } from "../util/embeds";
import { applyTitleEmojis } from "../util/threadTitle";

export const RESOLVED_EMOJI = "✅";

// The subset of a Ticket that applyStatus needs. csatPromptedAt gates the one-time
// rating prompt, statusTag is the previous tag shown in the audit trail; callers
// always pass full ticket rows, so this is type-only.
export interface StatusTicket {
  threadId: string;
  customerId: string | null;
  csatPromptedAt?: Date | null;
  closed?: boolean;
  statusTag?: { emoji: string; label: string } | null;
  priorityTagId?: string | null;
}

export interface ApplyStatusOptions {
  actorName: string;
  actorIconUrl?: string;
  actorId?: string; // recorded in the per-ticket change history
  silent?: boolean; // skip the customer notice (used for bulk reassignment)
}

export class StatusService {
  // Serializes changes per thread so rapid updates don't interleave their messages.
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private ticketStore: TicketStore,
    private audit: AuditLogger,
    private settingsStore: SettingsStore
  ) {}

  async applyStatus(
    thread: ThreadChannel,
    ticket: StatusTicket,
    tag: StatusTag,
    options: ApplyStatusOptions
  ): Promise<void> {
    const prev = this.chains.get(ticket.threadId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.runApplyStatus(thread, ticket, tag, options));
    this.chains.set(ticket.threadId, next);
    try {
      await next;
    } finally {
      if (this.chains.get(ticket.threadId) === next) this.chains.delete(ticket.threadId);
    }
  }

  // Replaces the leading status emoji of "{status} {priority?} {user} — {label}",
  // leaving a priority emoji in the second slot untouched.
  buildThreadName(currentName: string, emoji: string): string {
    return applyTitleEmojis(currentName, { statusEmoji: emoji }, (t) => !!this.settingsStore.priorityByEmoji(t));
  }

  // Mirror of applyStatus for the priority axis: rename + persist + history + audit.
  // Shares the same per-thread chain so concurrent status/priority renames don't
  // clobber each other's thread.name reads.
  async applyPriority(
    thread: ThreadChannel,
    ticket: StatusTicket,
    priority: PriorityTag,
    options: ApplyStatusOptions
  ): Promise<void> {
    const prev = this.chains.get(ticket.threadId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.runApplyPriority(thread, ticket, priority, options));
    this.chains.set(ticket.threadId, next);
    try {
      await next;
    } finally {
      if (this.chains.get(ticket.threadId) === next) this.chains.delete(ticket.threadId);
    }
  }

  private async runApplyPriority(
    thread: ThreadChannel,
    ticket: StatusTicket,
    priority: PriorityTag,
    options: ApplyStatusOptions
  ): Promise<void> {
    const prevPriority = ticket.priorityTagId ? this.settingsStore.priorityById(ticket.priorityTagId) : undefined;

    await thread
      .setName(applyTitleEmojis(thread.name, { priorityEmoji: priority.emoji }, (t) => !!this.settingsStore.priorityByEmoji(t)))
      .catch(() => {});

    await this.ticketStore.setPriority(ticket.threadId, priority.id);

    void this.ticketStore
      .addTagChange({
        ticketThreadId: ticket.threadId,
        kind: "PRIORITY",
        fromEmoji: prevPriority?.emoji ?? null,
        fromLabel: prevPriority?.label ?? null,
        toEmoji: priority.emoji,
        toLabel: priority.label,
        actorId: options.actorId ?? null,
        actorName: options.actorName,
      })
      .catch((e) => console.error("Failed to record priority change:", e));

    const prevText = prevPriority ? `${prevPriority.emoji} ${prevPriority.label}` : "—";
    void this.audit.log({
      title: "⚡ Priority changed",
      severity: "info",
      actor: options.actorName,
      actorIconUrl: options.actorIconUrl,
      threadId: ticket.threadId,
      fields: [{ name: "Priority", value: `${prevText} → ${priority.emoji} ${priority.label}`, inline: true }],
    });
  }

  private async runApplyStatus(
    thread: ThreadChannel,
    ticket: StatusTicket,
    tag: StatusTag,
    options: ApplyStatusOptions
  ): Promise<void> {
    // "Done" = a tag that closes the thread (📁, locks + archives) or marks it resolved
    // (✅, stays open and unlocked so the customer can reply to reopen; the scheduler
    // closes it after N quiet days). This also drives closedAt bookkeeping for the status
    // report (resolved counts alongside closed).
    const isResolved = tag.emoji === RESOLVED_EMOJI;
    const isDone = tag.closesThread || isResolved;
    // Resolved tickets stay unarchived but are marked closed in the DB, so the
    // reopen detection needs both signals.
    const wasInactive = Boolean(thread.archived || thread.locked || ticket.closed);

    // Reopen when moving to an active status: unarchive first so it's editable, then unlock.
    if (!isDone && (thread.archived || thread.locked)) {
      await thread.setArchived(false).catch(() => {});
      await thread.setLocked(false).catch(() => {});
    }

    // Renames can hit Discord's per-thread rename rate limit; keep going on failure
    // so the DB + audit line stay consistent.
    await thread.setName(this.buildThreadName(thread.name, tag.emoji)).catch(() => {});

    await this.ticketStore.setStatus(ticket.threadId, tag.id, isDone);

    // Per-ticket history backing /status history — recorded for silent changes too,
    // same philosophy as the audit channel: the record is complete, silent only
    // mutes the thread.
    void this.ticketStore
      .addTagChange({
        ticketThreadId: ticket.threadId,
        kind: "STATUS",
        fromEmoji: ticket.statusTag?.emoji ?? null,
        fromLabel: ticket.statusTag?.label ?? null,
        toEmoji: tag.emoji,
        toLabel: tag.label,
        actorId: options.actorId ?? null,
        actorName: options.actorName,
      })
      .catch((e) => console.error("Failed to record status change:", e));

    // Audit trail — runs even for silent changes (bulk reassignment, member-left
    // closes): the channel is the complete record, silent only mutes the thread.
    const [title, severity]: [string, "info" | "success" | "warn" | "neutral"] =
      tag.closesThread && options.actorName === "Automatic"
        ? ["📁 Ticket auto-closed", "neutral"]
        : tag.closesThread
          ? ["📁 Ticket closed", "neutral"]
          : isResolved
            ? ["✅ Ticket resolved", "success"]
            : wasInactive
              ? ["🔓 Ticket reopened", "warn"]
              : ["🔄 Status changed", "info"];
    const prevTag = ticket.statusTag ? `${ticket.statusTag.emoji} ${ticket.statusTag.label}` : "—";
    void this.audit.log({
      title,
      severity,
      actor: options.actorName,
      actorIconUrl: options.actorIconUrl,
      threadId: ticket.threadId,
      fields: [{ name: "Status", value: `${prevTag} → ${tag.emoji} ${tag.label}`, inline: true }],
    });

    // Plain status changes post nothing in-thread (history lives in /status history);
    // only closing/resolving still notifies the customer.
    if (!options.silent && isDone) {
      const note = tag.closesThread
        ? "This ticket has been closed. Reply here or open a new ticket if you still need help."
        : `This ticket has been marked **${tag.label}**. Reply here if you still need help.`;
      // The customer mention stays in content so they actually get notified.
      await thread
        .send({
          content: ticket.customerId ? `<@${ticket.customerId}>` : undefined,
          embeds: [embed(note, tag.closesThread ? COLORS.neutral : COLORS.success)],
          allowedMentions: { users: ticket.customerId ? [ticket.customerId] : [] },
        })
        .catch(() => {});

      // One-time satisfaction prompt. Must run BEFORE the lock/archive below so the
      // in-thread fallback (customer has DMs closed) can still post its message.
      if (ticket.customerId && !ticket.csatPromptedAt) {
        await this.sendCsatPrompt(thread, ticket).catch((e) => console.error("CSAT prompt failed:", e));
      }
    }

    if (tag.closesThread) {
      // Lock while the thread is still active, then archive in a separate call —
      // doing both in one edit can leave it locked but not archived.
      await thread.setLocked(true).catch(() => {});
      await thread.setArchived(true).catch(() => {});
    }
    // Resolved deliberately leaves the thread open (not archived, not locked) so the
    // customer can reply right where they are; the scheduler closes it after N quiet days.
  }

  // 1-5 star rating prompt, sent by DM so it survives the thread being locked/archived.
  // The customerId rides in the customId so the click handler needs no DB read before
  // acking, and the threadId because the click arrives from the DM channel.
  private async sendCsatPrompt(thread: ThreadChannel, ticket: StatusTicket): Promise<void> {
    if (!ticket.customerId) return;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      [1, 2, 3, 4, 5].map((score) =>
        new ButtonBuilder()
          .setCustomId(`csat:${ticket.threadId}:${ticket.customerId}:${score}`)
          .setLabel(`${score} ⭐`)
          .setStyle(ButtonStyle.Secondary)
      )
    );

    try {
      const user = await thread.client.users.fetch(ticket.customerId);
      await user.send({
        embeds: [
          embed(
            `Your support ticket [**${thread.name}**](${thread.url}) has been completed.\n\nHow was your support experience? Tap a rating below.`
          ),
        ],
        components: [row],
      });
    } catch {
      // DMs closed — fall back to the thread (we're still pre-lock here).
      await thread
        .send({
          content: `<@${ticket.customerId}>`,
          embeds: [embed("How was your support experience? Tap a rating below.")],
          components: [row],
          allowedMentions: { users: [ticket.customerId] },
        })
        .catch(() => {});
    }

    await this.ticketStore.markCsatPrompted(ticket.threadId);
  }
}
