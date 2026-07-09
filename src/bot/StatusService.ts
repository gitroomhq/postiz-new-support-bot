import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ThreadChannel } from "discord.js";
import { StatusTag, PriorityTag } from "../generated/prisma/client";
import { TicketStore } from "./TicketStore";
import { AuditLogger } from "./AuditLogger";
import { SettingsStore } from "../config/SettingsStore";
import { IntercomSyncService } from "../intercom/IntercomSyncService";
import type { TemporalProducers } from "../temporal/producers";
import { TicketScoreStore } from "../scoring/TicketScoreStore";
import { embed, COLORS } from "../util/embeds";
import { applyTitleEmojis } from "../util/threadTitle";
import { log } from "../util/logger";
import { safe, metricCount } from "../util/instrument";
import { exportStatusChange, exportTicketClosed } from "../metrics/MetricsExporter";

const statusLog = log.child("status");

export const RESOLVED_EMOJI = "✅";

// The subset of a Ticket that applyStatus needs. statusTag is the previous tag
// shown in the audit trail; the rating prompt is gated by a DB claim (once per
// close cycle — reopening re-arms it), not by a row field. Callers always pass
// full ticket rows, so this is type-only.
export interface StatusTicket {
  threadId: string;
  customerId: string | null;
  closed?: boolean;
  statusTag?: { emoji: string; label: string } | null;
  priorityTagId?: string | null;
  // Used by the metrics export (resolution time / category tag); callers pass
  // full ticket rows, so these are type-only like the fields above.
  createdAt?: Date;
  categoryId?: string | null;
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
  // Temporal seam: when the Temporal regime is active, status/priority changes
  // run as workflow updates on the per-ticket workflow (serialized there, one
  // statusChangeWorkflow child per transition) — every call site stays put.
  private producers: TemporalProducers | null = null;

  constructor(
    private ticketStore: TicketStore,
    private audit: AuditLogger,
    private settingsStore: SettingsStore,
    private intercomSync: IntercomSyncService,
    // Optional: reopening a scored ticket resets its AI score for re-scoring.
    private scoreStore?: TicketScoreStore
  ) {}

  setTemporalProducers(producers: TemporalProducers): void {
    this.producers = producers;
  }

  // Discord caps thread renames at ~2 per 10 minutes per channel, and discord.js
  // QUEUES an over-limit edit instead of rejecting it — an awaited setName/setLocked/
  // setArchived can silently hang for minutes, wedging the whole per-thread chain
  // (symptom: resolve-after-reopen "does nothing", then every queued change floods
  // out at once when the limit clears). Wait briefly so the normal case stays
  // sequential, then detach: the edit still lands in order once Discord allows it
  // (discord.js drains its per-route queue FIFO), but the status pipeline — DB
  // write, notices, audit — moves on immediately.
  private static readonly EDIT_GRACE_MS = 3_000;

  private editWithGrace(op: Promise<unknown>, edit: string, threadId: string): Promise<void> {
    const settled = op.then(
      () => true as const,
      () => true as const // failures are non-fatal, same as the old .catch(() => {})
    );
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), StatusService.EDIT_GRACE_MS);
      timer.unref?.();
    });
    return Promise.race([settled, grace]).then((finished) => {
      clearTimeout(timer);
      if (!finished) {
        statusLog.warn("thread edit rate-limited — continuing without it, it lands when the limit clears", {
          "thread.edit": edit,
          "ticket.thread_id": threadId,
        });
      }
    });
  }

  async applyStatus(
    thread: ThreadChannel,
    ticket: StatusTicket,
    tag: StatusTag,
    options: ApplyStatusOptions
  ): Promise<void> {
    if (this.producers?.enabled()) {
      const res = await this.producers.applyStatus(ticket.threadId, {
        tagId: tag.id,
        actorName: options.actorName,
        actorId: options.actorId ?? null,
        actorIconUrl: options.actorIconUrl ?? null,
        silent: options.silent,
      });
      // null = Temporal unreachable right now — fall through to the legacy
      // in-process path so a status change never silently vanishes.
      if (res != null) return;
    }
    const prev = this.chains.get(ticket.threadId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.applyStatusDirect(thread, ticket, tag, options));
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
    if (this.producers?.enabled()) {
      const res = await this.producers.applyPriority(ticket.threadId, {
        priorityTagId: priority.id,
        actorName: options.actorName,
        actorId: options.actorId ?? null,
        actorIconUrl: options.actorIconUrl ?? null,
      });
      if (res != null) return;
    }
    const prev = this.chains.get(ticket.threadId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.applyPriorityDirect(thread, ticket, priority, options));
    this.chains.set(ticket.threadId, next);
    try {
      await next;
    } finally {
      if (this.chains.get(ticket.threadId) === next) this.chains.delete(ticket.threadId);
    }
  }

  // The un-serialized transition body. Public because the Temporal
  // applyPriorityStep activity calls it directly (serialization then comes
  // from the per-ticket workflow, not the in-process chain).
  async applyPriorityDirect(
    thread: ThreadChannel,
    ticket: StatusTicket,
    priority: PriorityTag,
    options: ApplyStatusOptions
  ): Promise<void> {
    const prevPriority = ticket.priorityTagId ? this.settingsStore.priorityById(ticket.priorityTagId) : undefined;

    await this.editWithGrace(
      thread.setName(applyTitleEmojis(thread.name, { priorityEmoji: priority.emoji }, (t) => !!this.settingsStore.priorityByEmoji(t))),
      "rename",
      ticket.threadId
    );

    await this.ticketStore.setPriority(ticket.threadId, priority.id);

    safe(
      this.intercomSync.onPriorityChanged(ticket.threadId, prevPriority ?? null, priority, options.actorName),
      "intercom-sync",
      { "ticket.thread_id": ticket.threadId, "sync.event": "priority_changed" }
    );

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
      .catch((e) => statusLog.error("priority change record failed", e, { "ticket.thread_id": ticket.threadId }));

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

  // The un-serialized transition body. Public because the Temporal
  // statusApplyDirect activity calls it directly (one statusChangeWorkflow
  // child per transition owns the serialization there). Every side effect —
  // Intercom mirror (via the sync seam), history row, audit, metrics, CSAT
  // claim, lock/archive — lives here exactly once for both regimes.
  async applyStatusDirect(
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
      await this.editWithGrace(thread.setArchived(false), "unarchive", ticket.threadId);
      await this.editWithGrace(thread.setLocked(false), "unlock", ticket.threadId);
    }

    // Renames can hit Discord's per-thread rename rate limit; keep going regardless
    // so the DB + audit line stay consistent.
    await this.editWithGrace(thread.setName(this.buildThreadName(thread.name, tag.emoji)), "rename", ticket.threadId);

    await this.ticketStore.setStatus(ticket.threadId, tag.id, isDone);

    // Covers every status path: /status, feedback buttons, reminder auto-closes,
    // member-leave, manual lock/archive, Intercom-initiated changes (converges —
    // the executor's lastSynced* guards make the echo push a no-op).
    safe(
      this.intercomSync.onStatusChanged(ticket.threadId, ticket.statusTag ?? null, tag, options.actorName),
      "intercom-sync",
      { "ticket.thread_id": ticket.threadId, "sync.event": "status_changed" }
    );

    // Boundary wide event for every status transition (doubles as the
    // ticket-closed signal via ticket.closes_thread / ticket.resolved).
    statusLog.info("ticket.status_changed", {
      "ticket.thread_id": ticket.threadId,
      "status.from": ticket.statusTag?.label ?? "",
      "status.to": tag.label,
      "status.actor": options.actorName,
      "ticket.closes_thread": tag.closesThread,
      "ticket.resolved": isResolved,
      "ticket.reopened": !isDone && wasInactive,
    });
    if (isDone) {
      metricCount("tickets.closed", 1, { via: options.actorName === "Automatic" ? "automatic" : "manual" });
    }
    const reopened = !isDone && wasInactive;
    exportStatusChange({
      threadId: ticket.threadId,
      category: ticket.categoryId ?? null,
      statusTo: tag.label,
      reopened,
    });
    // ticket.closed reflects the state BEFORE this change, so a done→done
    // transition (Resolved → Closed) exports only one close.
    if (isDone && !ticket.closed) {
      exportTicketClosed({
        threadId: ticket.threadId,
        category: ticket.categoryId ?? null,
        resolutionSeconds: ticket.createdAt ? (Date.now() - ticket.createdAt.getTime()) / 1000 : null,
      });
    }
    // Re-score on re-close: a reopened ticket's score is stale — drop it so the
    // next scoring batch after the eventual re-close evaluates the full story.
    if (reopened && this.scoreStore) {
      safe(this.scoreStore.resetForRescore(ticket.threadId), "score-rescore", {
        "ticket.thread_id": ticket.threadId,
      });
    }
    // Re-arm the rating prompt on reopen (unrated tickets only): the customer's
    // reply means the previous resolve wasn't the end of the story, so the next
    // resolve/close should ask again. Awaited so a resolve racing right behind
    // this reopen can't read the stale stamp.
    if (reopened) {
      await this.ticketStore
        .resetCsatPrompt(ticket.threadId)
        .catch((e) => statusLog.error("csat prompt reset failed", e, { "ticket.thread_id": ticket.threadId }));
    }

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
      .catch((e) => statusLog.error("status change record failed", e, { "ticket.thread_id": ticket.threadId }));

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
      // Satisfaction prompt — once per close cycle (reopening re-arms it above).
      // The DB claim is the sole gate (single-winner), NOT the caller's ticket row:
      // rapid transitions (Resolve then Close) each carry a row fetched before the
      // other ran, so an in-memory csatPromptedAt check double-prompts or skips.
      const promptCsat =
        !!ticket.customerId &&
        (await this.ticketStore.markCsatPrompted(ticket.threadId).catch((e) => {
          statusLog.error("csat prompt claim failed", e, { "ticket.thread_id": ticket.threadId });
          return false;
        }));

      const note = tag.closesThread
        ? "This ticket has been closed. Reply here or open a new ticket if you still need help."
        : `This ticket has been marked **${tag.label}**. Reply here if you still need help.`;
      // One message: notice + rating buttons together (a separate prompt message
      // would ping the customer twice). Sent BEFORE the lock/archive below so it
      // still lands on closing statuses.
      await thread
        .send({
          content: ticket.customerId ? `<@${ticket.customerId}>` : undefined,
          embeds: [
            embed(
              promptCsat ? `${note}\n\nHow was your support experience? Tap a rating below.` : note,
              tag.closesThread ? COLORS.neutral : COLORS.success
            ),
          ],
          components: promptCsat ? [this.buildCsatRow(ticket)] : [],
          allowedMentions: { users: ticket.customerId ? [ticket.customerId] : [] },
        })
        .catch(() => {});

      // The DM copy survives the thread being locked/archived; best-effort.
      if (promptCsat) {
        await this.sendCsatDm(thread, ticket).catch(() => {});
      }
    }

    if (tag.closesThread) {
      // Lock while the thread is still active, then archive in a separate call —
      // doing both in one edit can leave it locked but not archived. Issued in
      // order; discord.js keeps the order even when the grace detaches them.
      await this.editWithGrace(thread.setLocked(true), "lock", ticket.threadId);
      await this.editWithGrace(thread.setArchived(true), "archive", ticket.threadId);
    }
    // Resolved deliberately leaves the thread open (not archived, not locked) so the
    // customer can reply right where they are; the scheduler closes it after N quiet days.
  }

  // 1-5 star rating row, attached to the in-thread close notice AND the DM copy.
  // recordCsat is single-winner, so whichever copy the customer taps first wins.
  // The customerId rides in the customId so the click handler needs no DB read
  // before acking, and the threadId because the click can arrive from the DM
  // channel. Built fresh per message — discord.js builders are mutated on send.
  private buildCsatRow(ticket: StatusTicket): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      [1, 2, 3, 4, 5].map((score) =>
        new ButtonBuilder()
          .setCustomId(`csat:${ticket.threadId}:${ticket.customerId}:${score}`)
          .setLabel(`${score} ⭐`)
          .setStyle(ButtonStyle.Secondary)
      )
    );
  }

  private async sendCsatDm(thread: ThreadChannel, ticket: StatusTicket): Promise<void> {
    if (!ticket.customerId) return;
    const user = await thread.client.users.fetch(ticket.customerId);
    await user.send({
      embeds: [
        embed(
          `Your support ticket [**${thread.name}**](${thread.url}) has been completed.\n\nHow was your support experience? Tap a rating below.`
        ),
      ],
      components: [this.buildCsatRow(ticket)],
    });
  }
}
