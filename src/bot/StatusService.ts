import { ThreadChannel } from "discord.js";
import { StatusTag } from "../generated/prisma/client";
import { TicketStore } from "./TicketStore";
import { embed, COLORS } from "../util/embeds";

export const RESOLVED_EMOJI = "✅";

export interface ApplyStatusOptions {
  actorName: string;
  actorIconUrl?: string;
  silent?: boolean; // skip the audit line + customer notice (used for bulk reassignment)
}

export class StatusService {
  // Serializes changes per thread so rapid updates don't interleave their messages.
  private chains = new Map<string, Promise<unknown>>();

  constructor(private ticketStore: TicketStore) {}

  async applyStatus(
    thread: ThreadChannel,
    ticket: { threadId: string; customerId: string | null },
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

  // Replaces the leading emoji of "{emoji} {user} — {label}" with the new one.
  buildThreadName(currentName: string, emoji: string): string {
    const rest = currentName.includes(" ") ? currentName.replace(/^\S+\s+/, "") : currentName;
    return `${emoji} ${rest}`.slice(0, 100);
  }

  private async runApplyStatus(
    thread: ThreadChannel,
    ticket: { threadId: string; customerId: string | null },
    tag: StatusTag,
    options: ApplyStatusOptions
  ): Promise<void> {
    // "Done" = a tag that closes the thread (📁, locks + archives) or marks it resolved
    // (✅, stays open and unlocked so the customer can reply to reopen; the scheduler
    // closes it after N quiet days). This also drives closedAt bookkeeping for the status
    // report (resolved counts alongside closed).
    const isResolved = tag.emoji === RESOLVED_EMOJI;
    const isDone = tag.closesThread || isResolved;

    // Reopen when moving to an active status: unarchive first so it's editable, then unlock.
    if (!isDone && (thread.archived || thread.locked)) {
      await thread.setArchived(false).catch(() => {});
      await thread.setLocked(false).catch(() => {});
    }

    // Renames can hit Discord's per-thread rename rate limit; keep going on failure
    // so the DB + audit line stay consistent.
    await thread.setName(this.buildThreadName(thread.name, tag.emoji)).catch(() => {});

    await this.ticketStore.setStatus(ticket.threadId, tag.id, isDone);

    if (!options.silent) {
      const auditEmbed = embed(`Status changed to **${tag.emoji} ${tag.label}**`).setAuthor({
        name: options.actorName,
        ...(options.actorIconUrl ? { iconURL: options.actorIconUrl } : {}),
      });
      await thread.send({ embeds: [auditEmbed] }).catch(() => {});

      if (isDone) {
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
}
