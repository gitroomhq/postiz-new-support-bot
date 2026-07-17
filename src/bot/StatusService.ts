import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ThreadChannel } from "discord.js";
import { StatusTag } from "../generated/prisma/client";
import { TicketStore } from "./TicketStore";
import { AuditLogger } from "./AuditLogger";
import { SettingsStore } from "../config/SettingsStore";
import { IntercomSyncService } from "../intercom/IntercomSyncService";
import type { TemporalProducers } from "../temporal/producers";
import { embed, COLORS } from "../util/embeds";
import { log } from "../util/logger";
import { safe, metricCount } from "../util/instrument";

const statusLog = log.child("status");

// Chatter in a closed ticket re-locks the thread after this much silence
// (the ticket workflow's exact re-close deadline; every message pushes it).
export const RECLOSE_DELAY_MS = 30 * 60 * 1000;

// The subset of a Ticket that applyStatus needs. statusTag is the previous tag
// shown in the audit trail; the rating prompt is gated by a DB claim (once per
// close cycle — reopening re-arms it), not by a row field. Callers always pass
// full ticket rows, so this is type-only.
export interface StatusTicket {
  threadId: string;
  customerId: string | null;
  closed?: boolean;
  statusTag?: { emoji: string; label: string } | null;
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
  // Per-tag auto-close farewell (resolved from the tag being LEFT by the timer
  // that decided the close). Unset = default close notice.
  closeNoticeText?: string | null;
}

export class StatusService {
  // Serializes changes per thread so rapid updates don't interleave their messages.
  private chains = new Map<string, Promise<unknown>>();
  // Temporal seam: when the Temporal regime is active, status changes
  // run as workflow updates on the per-ticket workflow (serialized there, one
  // statusChangeWorkflow child per transition) — every call site stays put.
  private producers: TemporalProducers | null = null;
  // SLA manager — bound late (constructed after StatusService in index.ts).
  private slaService: { onTicketTrigger(threadId: string, reason: "status"): Promise<void> } | null = null;

  constructor(
    private ticketStore: TicketStore,
    private audit: AuditLogger,
    private settingsStore: SettingsStore,
    private intercomSync: IntercomSyncService
  ) {}

  setTemporalProducers(producers: TemporalProducers): void {
    this.producers = producers;
  }

  setSlaService(service: { onTicketTrigger(threadId: string, reason: "status"): Promise<void> }): void {
    this.slaService = service;
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
        closeNoticeText: options.closeNoticeText ?? null,
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
    // Open or closed only (the resolved middle state is gone): "done" = the
    // tag closes the thread (locks + archives).
    const isDone = tag.closesThread;
    const wasInactive = Boolean(thread.archived || thread.locked || ticket.closed);

    // Reopen when moving to an active status: unarchive first so it's editable, then unlock.
    if (!isDone && (thread.archived || thread.locked)) {
      await this.editWithGrace(thread.setArchived(false), "unarchive", ticket.threadId);
      await this.editWithGrace(thread.setLocked(false), "unlock", ticket.threadId);
    }

    // (No rename: thread titles no longer encode status — agents read state in
    // Intercom, and the rename rate-limit pain goes with it.)

    await this.ticketStore.setStatus(ticket.threadId, tag.id, isDone);

    // Covers every status path: /status, feedback buttons, reminder auto-closes,
    // member-leave, manual lock/archive, Intercom-initiated changes (converges —
    // the executor's lastSynced* guards make the echo push a no-op).
    safe(
      this.intercomSync.onStatusChanged(ticket.threadId, ticket.statusTag ?? null, tag, options.actorName),
      "intercom-sync",
      { "ticket.thread_id": ticket.threadId, "sync.event": "status_changed" }
    );

    // SLA manager: every status transition re-runs the rules (same choke
    // point as the Intercom mirror, so manual, auto-close, reopen and
    // Intercom-initiated changes are all covered).
    void this.slaService?.onTicketTrigger(ticket.threadId, "status").catch(() => undefined);

    // Boundary wide event for every status transition (doubles as the
    // ticket-closed signal via ticket.closes_thread).
    statusLog.info("ticket.status_changed", {
      "ticket.thread_id": ticket.threadId,
      "status.from": ticket.statusTag?.label ?? "",
      "status.to": tag.label,
      "status.actor": options.actorName,
      "ticket.closes_thread": tag.closesThread,
      "ticket.reopened": !isDone && wasInactive,
    });
    if (isDone) {
      metricCount("tickets.closed", 1, { via: options.actorName === "Automatic" ? "automatic" : "manual" });
    }
    const reopened = !isDone && wasInactive;
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

    // Plain status changes post nothing in-thread; only closing still
    // notifies the customer.
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

      const note =
        options.closeNoticeText || "This ticket has been closed. Reply here or open a new ticket if you still need help.";
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
