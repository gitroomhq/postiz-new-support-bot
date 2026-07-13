import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { Client, ThreadChannel } from "discord.js";
import type { StatusTag } from "../../generated/prisma/client";
import type { SettingsStore } from "../../config/SettingsStore";
import type { EscalationTierStore } from "../../config/EscalationTierStore";
import type { SessionStore } from "../../auth/SessionStore";
import type { TicketStore, TicketWithTag } from "../../bot/TicketStore";
import type { StatusService } from "../../bot/StatusService";
import type { AuditLogger } from "../../bot/AuditLogger";
import type { KnowledgeBaseScheduler } from "../../bot/KnowledgeBaseScheduler";
import type { StripeWebhookHandler } from "../../bot/StripeWebhookHandler";
import { RECLOSE_DELAY_MS } from "../../bot/StatusService";
import type { BillingCategory } from "../../categories/BillingCategory";
import type { DisputeMonitor } from "../../bot/billing/DisputeMonitor";
import type { IntercomStore } from "../../intercom/IntercomStore";
import type { IntercomSyncService } from "../../intercom/IntercomSyncService";
import type { IntercomEventExecutor } from "../../intercom/IntercomEventExecutor";
import type { InactivitySweeper } from "../../intercom/InactivitySweeper";
import { IntercomHttpError } from "../../intercom/IntercomClient";
import { DeferEchoError, type IntercomWebhookHandler } from "../../intercom/IntercomWebhookHandler";
import type { EnsurePayload } from "../../intercom/types";
import type { SnapshotScheduler } from "../../metrics/SnapshotScheduler";
import {
  exportIntercomQueueDepth,
  intercomDeadLetterCount,
  recordIntercomDeadLetter,
} from "../../metrics/MetricsExporter";
import { influxActive } from "../../metrics/InfluxWriter";
import type { VaultMigrator } from "../../vault/VaultMigrator";
import { reconfigureInflux } from "../../metrics/InfluxWriter";
import { embed, COLORS } from "../../util/embeds";
import { log } from "../../util/logger";
import type { TemporalProducers } from "../producers";
import { type CoreActivities, type IcEventType, type TicketSnapshot, type TimerCheckResult } from "../types";

const actLog = log.child("temporal:activities");

const DAY_MS = 24 * 60 * 60 * 1000;
// Politeness pacing between Intercom API deliveries (was CALL_SPACING_MS in
// the legacy drain loop — now a worker-global limiter across activities).
const INTERCOM_CALL_SPACING_MS = 300;
// Retention sweeps folded into the cleanup loop (legacy outbox-scheduler values).
const ECHO_RETENTION_MS = 14 * DAY_MS;
const PENDING_POST_RETENTION_MS = 60 * 60 * 1000;

export interface ActivityDeps {
  settingsStore: SettingsStore;
  ticketStore: TicketStore;
  statusService: StatusService;
  sessionStore: SessionStore;
  auditLogger: AuditLogger;
  tierStore: EscalationTierStore;
  intercomStore: IntercomStore;
  intercomSync: IntercomSyncService;
  intercomExecutor: IntercomEventExecutor;
  intercomWebhookHandler: IntercomWebhookHandler;
  inactivitySweeper: InactivitySweeper;
  kbScheduler: KnowledgeBaseScheduler;
  snapshotScheduler: SnapshotScheduler;
  stripeWebhookHandler: StripeWebhookHandler;
  billingCategory: BillingCategory;
  disputeMonitor: DisputeMonitor;
  vaultMigrator: VaultMigrator;
  client: Client;
  producers: TemporalProducers;
}

// All activity implementations, closed over the live in-process services (the
// worker runs inside the bot process — user decision). Payloads carry IDs;
// activities re-read rows so retries and Continue-As-New always see fresh
// state.
export function createActivities(deps: ActivityDeps): CoreActivities {
  const {
    settingsStore,
    ticketStore,
    statusService,
    sessionStore,
    auditLogger,
    tierStore,
    intercomStore,
    intercomSync,
    intercomExecutor,
    intercomWebhookHandler,
    inactivitySweeper,
    kbScheduler,
    snapshotScheduler,
    stripeWebhookHandler,
    billingCategory,
    disputeMonitor,
    vaultMigrator,
    client,
    producers,
  } = deps;

  // ---- shared helpers ----

  const fetchThread = async (threadId: string): Promise<ThreadChannel | null> => {
    const channel = await client.channels.fetch(threadId).catch(() => null);
    return channel?.isThread() ? (channel as ThreadChannel) : null;
  };

  const buildSnapshot = async (threadId: string): Promise<TicketSnapshot> => {
    const ticket = await ticketStore.getByThreadId(threadId);
    if (!ticket) {
      return {
        exists: false,
        closed: false,
        closedAtMs: null,
        statusTagId: null,
        statusLabel: null,
        tagClosesThread: false,
        tagIsResolved: false,
        tagReminderEnabled: false,
        tagReminderDays: 0,
        tagReminderTarget: "SUPPORT",
        tagAutoCloseAfter: null,
        remindersPaused: false,
        reminderCount: 0,
        lastReminderAtMs: null,
        lastStatusChangeAtMs: 0,
        recloseAtMs: null,
        hasIntercomLink: false,
      };
    }
    const tag = ticket.statusTag;
    const link = await intercomStore.getLink(threadId).catch(() => null);
    return {
      exists: true,
      closed: ticket.closed,
      closedAtMs: ticket.closedAt?.getTime() ?? null,
      statusTagId: ticket.statusTagId,
      statusLabel: tag?.label ?? null,
      tagClosesThread: tag?.closesThread ?? false,
      // The resolved state was removed (agent-rip): tickets are open or
      // closed. Forced false so in-flight workflow runs stop scanning closed
      // tickets for the old resolved-auto-close; the field itself is slimmed
      // out of the snapshot in a later release (workflow code reads it).
      tagIsResolved: false,
      tagReminderEnabled: tag?.reminderEnabled ?? false,
      tagReminderDays: tag?.reminderDays ?? 3,
      tagReminderTarget: tag?.reminderTarget === "CUSTOMER" ? "CUSTOMER" : "SUPPORT",
      tagAutoCloseAfter: tag?.autoCloseAfter ?? null,
      remindersPaused: ticket.remindersPaused,
      reminderCount: ticket.reminderCount,
      lastReminderAtMs: ticket.lastReminderAt?.getTime() ?? null,
      lastStatusChangeAtMs: ticket.lastStatusChangeAt.getTime(),
      recloseAtMs: ticket.recloseAt?.getTime() ?? null,
      // A ticketId-less link is a half-built bridge (ensure died between
      // conversation-create and convert). Report it as no-link so the pump
      // keeps synthesizing the ensure that finishes the convert — requireLink
      // no longer inline-rebuilds, so nothing else would ever retry it.
      hasIntercomLink: !!link?.ticketId,
    };
  };

  // Timestamp of the most recent message from the party we're waiting on; bot
  // messages never count. SUPPORT = any human who isn't the customer.
  // (Port of ReminderScheduler.lastAwaitedMessageAt.)
  const lastAwaitedMessageAt = async (
    thread: ThreadChannel,
    target: "SUPPORT" | "CUSTOMER",
    customerId: string | null,
    limit = 50
  ): Promise<number | null> => {
    const messages = await thread.messages.fetch({ limit }).catch(() => null);
    if (!messages) return null;
    let latest: number | null = null;
    for (const message of messages.values()) {
      if (message.author.bot) continue;
      const isMatch = target === "CUSTOMER" ? message.author.id === customerId : message.author.id !== customerId;
      if (isMatch && (latest === null || message.createdTimestamp > latest)) latest = message.createdTimestamp;
    }
    return latest;
  };

  const lastHumanMessageAt = async (thread: ThreadChannel, limit = 20): Promise<number | null> => {
    const messages = await thread.messages.fetch({ limit }).catch(() => null);
    if (!messages) return null;
    let latest: number | null = null;
    for (const message of messages.values()) {
      if (message.author.bot) continue;
      if (latest === null || message.createdTimestamp > latest) latest = message.createdTimestamp;
    }
    return latest;
  };

  // One reminder for one ticket. CUSTOMER reminders still ping the customer in
  // the Discord thread (they never left Discord). SUPPORT reminders no longer
  // ping a Discord role — agents live in Intercom, so the nag is an internal
  // note + reopen on the linked conversation (intercomSync.onAgentReminder);
  // unmirrored tickets (excluded category / bridge off) fall back to the
  // legacy staff-role ping, the only place Intercom can't see the ticket.
  // Returns false when there was no route (unmirrored + no staff role): the
  // caller must not report a reminder that never went out.
  const sendReminder = async (
    thread: ThreadChannel,
    ticket: TicketWithTag,
    tag: StatusTag,
    target: "SUPPORT" | "CUSTOMER",
    idleDays: number
  ): Promise<boolean> => {
    let route: "customer" | "intercom" | "discord" = "customer";
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
      const enqueued = await intercomSync
        .onAgentReminder(ticket, { idleDays, threadUrl: thread.url })
        .catch(() => false);
      route = enqueued ? "intercom" : "discord";
      if (!enqueued) {
        const pingRoleId = tierStore.newTicketRoleId(settingsStore.supportRoleId());
        if (!pingRoleId) return false;
        await thread.send({
          content: `<@&${pingRoleId}>`,
          embeds: [
            embed(
              `This ticket has gone ${idleDays} day(s) without a reply — please follow up.\n\nStatus: ${tag.emoji} ${tag.label}`,
              COLORS.warn
            ),
          ],
          allowedMentions: { roles: [pingRoleId] },
        });
      }
    }
    await ticketStore.recordReminder(ticket.threadId);
    actLog.info("reminder.sent", {
      "ticket.thread_id": ticket.threadId,
      "reminder.target": target.toLowerCase(),
      "reminder.route": route,
      "reminder.round": ticket.reminderCount + 1,
    });
    void auditLogger.log({
      title: target === "CUSTOMER" ? "⏰ Reminder sent" : route === "intercom" ? "⏰ Agent reminder → Intercom" : "⏰ Agent reminder → Discord (unmirrored)",
      severity: "warn",
      actor: "Automatic",
      threadId: ticket.threadId,
      fields: [
        { name: "Target", value: target.toLowerCase(), inline: true },
        { name: "Status", value: `${tag.emoji} ${tag.label}`, inline: true },
        { name: "Round", value: String(ticket.reminderCount + 1), inline: true },
      ],
    });
    return true;
  };

  // Worker-global Intercom call pacing (replaces the drain loop's spacing).
  let lastIntercomCallAt = 0;
  const paceIntercom = async (): Promise<void> => {
    const wait = lastIntercomCallAt + INTERCOM_CALL_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastIntercomCallAt = Date.now();
  };

  return {
    // ================= ticket lifecycle =================

    async loadTicketState(threadId) {
      return buildSnapshot(threadId);
    },

    // One evaluation pass for one ticket: reminder / waiting-auto-close /
    // resolved-auto-close / re-close — verbatim ports of the legacy
    // ReminderScheduler + RecloseScheduler per-ticket logic. Auto-closes are
    // RETURNED as a status-change request; the workflow runs them as a
    // statusChangeWorkflow child so the transition is durable + serialized.
    async checkTicketTimers(threadId): Promise<TimerCheckResult> {
      let statusChange: TimerCheckResult["statusChange"] = null;
      let reminded = false;
      let reclosed = false;

      const ticket = await ticketStore.getByThreadId(threadId);
      if (!ticket) {
        return { statusChange, reminded, reclosed, snapshot: await buildSnapshot(threadId) };
      }
      const thread = await fetchThread(threadId);
      const tag = ticket.statusTag;
      const now = Date.now();

      // ---- re-close (Ticket.recloseAt due; RecloseScheduler.processTicket) ----
      // Same gating as listRecloseDue: closed + closesThread + not paused.
      if (
        ticket.recloseAt &&
        ticket.recloseAt.getTime() <= now &&
        ticket.closed &&
        !ticket.remindersPaused &&
        tag?.closesThread
      ) {
        if (!thread) {
          await ticketStore.clearReclose(threadId);
        } else {
          // Stale-deadline guard: a message that arrived while the bot was
          // down pushes the deadline instead of re-closing mid-conversation.
          const lastHumanAt = await lastHumanMessageAt(thread);
          if (lastHumanAt && lastHumanAt + RECLOSE_DELAY_MS > now) {
            await ticketStore.scheduleReclose(threadId, new Date(lastHumanAt + RECLOSE_DELAY_MS));
          } else {
            const alreadyShut = thread.locked && thread.archived;
            if (!alreadyShut) {
              await thread.setLocked(true).catch(() => {});
              await thread.setArchived(true).catch(() => {});
            }
            await ticketStore.clearReclose(threadId);
            reclosed = true;
            if (!alreadyShut) {
              void auditLogger.log({
                title: "🔁 Ticket re-closed",
                severity: "neutral",
                actor: "Automatic",
                threadId,
                fields: [{ name: "Reason", value: "30 min of silence after activity in a closed ticket", inline: true }],
              });
            }
          }
        }
      }

      // ---- reminders (ReminderScheduler.processTicket) ----
      if (tag && !ticket.closed && !ticket.remindersPaused && tag.reminderEnabled) {
        if (!thread) {
          await ticketStore.close(threadId);
        } else if (!thread.archived && !thread.locked) {
          const target = tag.reminderTarget === "CUSTOMER" ? "CUSTOMER" : "SUPPORT";
          if (!(target === "CUSTOMER" && !ticket.customerId)) {
            const awaitedAt = await lastAwaitedMessageAt(thread, target, ticket.customerId);
            const reference = Math.max(
              ticket.lastStatusChangeAt.getTime(),
              awaitedAt ?? 0,
              ticket.lastReminderAt?.getTime() ?? 0
            );
            if (now - reference >= tag.reminderDays * DAY_MS) {
              // Auto-close stale Waiting-for-Customer tickets once N reminders
              // went unanswered.
              const closingTag = settingsStore.closingTag();
              if (target === "CUSTOMER" && tag.autoCloseAfter != null && ticket.reminderCount >= tag.autoCloseAfter && closingTag) {
                statusChange = { tagId: closingTag.id, actorName: "Automatic" };
              } else {
                // Real idle time for the reminder copy: elapsed since the
                // awaited party last acted (status changes count as
                // activity). Deliberately EXCLUDES lastReminderAt — the fire
                // reference includes it so the cadence re-arms, but counting
                // it here would pin the displayed number at reminderDays
                // forever ("1 day(s)" every day).
                const idleDays = Math.max(
                  1,
                  Math.floor((now - Math.max(ticket.lastStatusChangeAt.getTime(), awaitedAt ?? 0)) / DAY_MS)
                );
                reminded = await sendReminder(thread, ticket, tag, target, idleDays);
              }
            }
          }
        }
      }

      // (The resolved-auto-close pass is gone with the resolved state itself —
      // tickets are open or closed; a closing tag locks+archives immediately.)

      return { statusChange, reminded, reclosed, snapshot: await buildSnapshot(threadId) };
    },

    // Tombstone stub (agent-rip): only reachable from the autoAnswerWorkflow
    // repair path of runs in flight across the deploy — new tickets never
    // spawn that child (aiSolve is always false).
    async pingStaffForNewTicket(threadId) {
      actLog.info("pingStaffForNewTicket skipped (agent-rip tombstone)", { "ticket.thread_id": threadId });
    },

    // ================= status / priority =================

    // The whole transition via StatusService.applyStatusDirect — the exact
    // legacy implementation, serialized by the parent ticket workflow.
    async statusApplyDirect(input) {
      const ticket = await ticketStore.getByThreadId(input.threadId);
      const tag = settingsStore.tagById(input.tagId);
      if (!ticket) {
        return { applied: false, reason: "not a tracked ticket", closed: false, isResolved: false, closesThread: false, statusTagId: input.tagId, statusLabel: null };
      }
      if (!tag) {
        return { applied: false, reason: "unknown status tag", closed: ticket.closed, isResolved: false, closesThread: false, statusTagId: input.tagId, statusLabel: null };
      }
      // Resolved state removed (agent-rip): done = the tag closes the thread.
      // isResolved is pinned false — in-flight workflow runs still read the
      // field; the shape slims out in a later release.
      const isDone = tag.closesThread;
      // No-op guard mirrors handleThreadUpdate's backstop: already there.
      const thread = await fetchThread(input.threadId);
      if (!thread) {
        // Thread gone/unreachable — reconcile DB + mirror (the legacy
        // member-leave else-branch).
        await ticketStore.close(input.threadId).catch(() => {});
        await intercomSync
          .onStatusChanged(input.threadId, ticket.statusTag ?? null, tag, input.actorName)
          .catch(() => {});
        return { applied: true, closed: true, isResolved: false, closesThread: tag.closesThread, statusTagId: tag.id, statusLabel: tag.label };
      }
      await statusService.applyStatusDirect(thread, ticket, tag, {
        actorName: input.actorName,
        actorId: input.actorId ?? undefined,
        actorIconUrl: input.actorIconUrl ?? undefined,
        silent: input.silent,
      });
      return { applied: true, closed: isDone, isResolved: false, closesThread: tag.closesThread, statusTagId: tag.id, statusLabel: tag.label };
    },

    // Inert stub (agent-rip): the Discord priority axis is unbridged — nothing
    // issues the applyPriority update anymore, but the workflow keeps the
    // handler registered (byte-identical ticketWorkflow), so the activity name
    // must stay implemented for any in-flight update at deploy time.
    async applyPriorityStep(input) {
      actLog.info("applyPriorityStep skipped (priority axis retired)", { "ticket.thread_id": input.threadId });
    },

    // ================= Intercom =================

    async intercomEnabled() {
      return settingsStore.intercomMode() !== "none" && settingsStore.intercomConfigured();
    },

    // One queued event → the shared executor (ensure ladder / message / note /
    // status / priority / csat). Throws ApplicationFailure with structured
    // details so the delivery workflow replicates the legacy retry policy.
    async executeIntercomEvent(input) {
      const { threadId, event } = input;
      heartbeat();
      await paceIntercom();
      try {
        let payload = event.payload;
        if (event.type === "ensure" && payload == null) {
          // Synthesized ensure head: compose fresh at delivery time.
          const ticket = await ticketStore.getByThreadId(threadId);
          if (!ticket) {
            throw new IntercomHttpError(410, `No ticket for thread ${threadId}`);
          }
          payload = (await intercomSync.buildEnsurePayloadWithSession(ticket)) as EnsurePayload;
        }
        heartbeat();
        // Heartbeat between the executor's API calls: a multi-call ensure can
        // outlive the 45s heartbeatTimeout and retry CONCURRENTLY with the
        // still-running attempt (duplicate conversations).
        await intercomExecutor.execute(threadId, event.type as IcEventType, payload, () => heartbeat());
      } catch (e) {
        if (e instanceof IntercomHttpError) {
          // 404 on a non-ensure event: a linked remote object was deleted —
          // self-heal inline (legacy handleFailure behavior), then retry.
          if (e.status === 404 && event.type !== "ensure") {
            await intercomExecutor.selfHeal404(threadId, () => heartbeat()).catch((healError) => {
              actLog.error("404 self-heal failed", healError, { "ticket.thread_id": threadId });
            });
            throw ApplicationFailure.create({
              message: `404 — remote object recreated, retrying: ${e.message}`,
              type: "IntercomHttpError",
              nonRetryable: true, // the delivery workflow owns retries
              details: [{ status: e.status, retryAfterSeconds: null, permanent: false }],
            });
          }
          const permanent = e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
          throw ApplicationFailure.create({
            message: e.message,
            type: "IntercomHttpError",
            nonRetryable: true,
            details: [{ status: e.status, retryAfterSeconds: e.retryAfterSeconds ?? null, permanent }],
          });
        }
        throw ApplicationFailure.create({
          message: e instanceof Error ? e.message : String(e),
          type: "IntercomError",
          nonRetryable: true,
          details: [{ status: null, retryAfterSeconds: null, permanent: false }],
        });
      }
    },

    async intercomDeadLetterAudit(input) {
      recordIntercomDeadLetter("outbox");
      // The dead event's kept-on-ambiguous-failure reservations can no longer
      // match anything — drop them so they stop deferring inbound replies.
      await intercomStore.deletePendingPostsForThread(input.threadId).catch(() => {});
      actLog.warn("intercom.delivery.dead_letter", {
        "queue.event_type": input.type,
        "ticket.thread_id": input.threadId,
        "queue.attempts": input.attempts,
        "error.message": input.message.slice(0, 512),
      });
      void auditLogger.log({
        title: "🌉 Intercom push dead-lettered",
        severity: "warn",
        actor: "Intercom bridge",
        threadId: input.threadId,
        fields: [
          { name: "Event", value: input.type, inline: true },
          { name: "Attempts", value: String(input.attempts), inline: true },
          { name: "Error", value: input.message.slice(0, 1024), inline: false },
        ],
      });
      // A dead MESSAGE is a silent transcript gap: the staff member who typed
      // the reply must find out in the thread, not (only) in the audit channel.
      if (input.type === "message" || input.type === "message_edit" || input.type === "message_delete") {
        const thread = await fetchThread(input.threadId).catch(() => null);
        await thread
          ?.send({
            embeds: [
              embed(
                "⚠️ A message in this thread could not be synced to Intercom (all retries failed). " +
                  "Agents working in Intercom will not see it — check /config → Intercom.",
                COLORS.warn
              ),
            ],
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
    },

    // Inbound webhook event → the legacy handler. DeferEchoError becomes a
    // non-retryable failure the inbox workflow converts into its own 10s defer
    // loop; real failures use the activity RetryPolicy (legacy backoff).
    async processInboundEvent(input) {
      try {
        await intercomWebhookHandler.process(input.topic, input.payload, input.deferAttempts);
      } catch (e) {
        if (e instanceof DeferEchoError) {
          throw ApplicationFailure.create({ message: e.message, type: "DeferEcho", nonRetryable: true });
        }
        throw e;
      }
    },

    async inboundDeadLetterAudit(input) {
      recordIntercomDeadLetter("inbox");
      actLog.error("intercom.inbound.dead_letter", new Error(input.message), {
        "queue.event_topic": input.topic,
        "queue.attempts": input.attempts,
      });
      void auditLogger.log({
        title: "🌉 Intercom inbound event dead-lettered",
        severity: "warn",
        actor: "Intercom bridge",
        fields: [
          { name: "Topic", value: input.topic, inline: true },
          { name: "Attempts", value: String(input.attempts), inline: true },
          { name: "Error", value: input.message.slice(0, 1024), inline: false },
        ],
      });
    },

    // ================= loopers =================

    // KB refresh (legacy KnowledgeBaseScheduler semantics): tick() applies the
    // enabled/interval due-check itself; force = the /config "Refresh now"
    // signal, which bypasses the due-check.
    async kbTick(force) {
      heartbeat();
      // Tarball downloads can outlast the 90s heartbeatTimeout — keep the
      // activity alive while a refresh is in flight.
      const keepalive = setInterval(() => {
        try {
          heartbeat();
        } catch {
          /* worker shutting down — the refresh finishes on its own */
        }
      }, 30_000);
      try {
        if (force) {
          const r = await kbScheduler.refreshNow();
          return { refreshed: true, ...r };
        }
        await kbScheduler.tick();
        return { refreshed: false, ok: 0, failed: 0 };
      } finally {
        clearInterval(keepalive);
      }
    },

    // Workspace inactivity sweep: native (unbridged) conversations/tickets get
    // the agent-idle note+reopen and customer-idle nag/auto-close treatment.
    // The sweeper applies the enable + intercomConfigured gate itself.
    async inactivitySweepTick(force) {
      heartbeat();
      const keepalive = setInterval(() => {
        try {
          heartbeat();
        } catch {
          /* worker shutting down — the sweep finishes on its own */
        }
      }, 30_000);
      try {
        return await inactivitySweeper.sweep(force);
      } finally {
        clearInterval(keepalive);
      }
    },

    // Influx gauge snapshots; queue-depth gauges re-sourced from Temporal
    // visibility (the legacy DB queues are empty under this regime).
    async snapshotTick() {
      if (!influxActive()) return;
      await snapshotScheduler.tick();
      try {
        const c = await producers.service().client();
        if (c) {
          const svc = (await producers.service().connection())!.workflowService;
          const ns = producers.service().envConfig().namespace;
          const [outbox, inbox] = await Promise.all([
            svc.countWorkflowExecutions({ namespace: ns, query: `WorkflowType="intercomDeliveryWorkflow" AND ExecutionStatus="Running"` }),
            svc.countWorkflowExecutions({ namespace: ns, query: `WorkflowType="intercomInboxWorkflow" AND ExecutionStatus="Running"` }),
          ]);
          exportIntercomQueueDepth({
            queue: "outbox",
            pending: Number(outbox.count ?? 0),
            dead: intercomDeadLetterCount("outbox"),
          });
          exportIntercomQueueDepth({
            queue: "inbox",
            pending: Number(inbox.count ?? 0),
            dead: intercomDeadLetterCount("inbox"),
          });
        }
      } catch {
        // visibility counts are best-effort gauges
      }
    },

    // 5-minute sweep: pending auths, old Stripe dedup rows, Intercom echo /
    // pending-post retention (the legacy outbox scheduler's hourly sweeps).
    async cleanupTick() {
      await sessionStore.cleanExpiredPending().catch((e) => actLog.error("clean pending auths failed", e));
      await sessionStore.cleanOldStripeEvents().catch((e) => actLog.error("clean stripe events failed", e));
      await intercomStore.cleanupEchoParts(new Date(Date.now() - ECHO_RETENTION_MS)).catch(() => {});
      await intercomStore.cleanupPendingPosts(new Date(Date.now() - PENDING_POST_RETENTION_MS)).catch(() => {});
    },

    // ================= agent-rip tombstone stubs =================
    // In-flight runs at deploy time still proxy these activity names; the
    // tombstone workflows + stubs are removed in the follow-up release.

    async publishStatusReport() {
      actLog.info("publishStatusReport skipped (status report retired)");
      return { published: false };
    },

    async scoreOneNow(threadId) {
      actLog.info("scoreOneNow skipped (scoring retired)", { "ticket.thread_id": threadId });
      return JSON.stringify({ outcome: "retired" });
    },

    async runAutoAnswer(input) {
      actLog.info("runAutoAnswer skipped (AI retired)", { "ticket.thread_id": input.threadId });
      return { ok: true, apiLimit: false };
    },

    async runStaffAiCommand(input) {
      actLog.info("runStaffAiCommand skipped (/ai retired)", { "ticket.thread_id": input.threadId });
    },

    // ================= stripe / billing / vault =================

    async handleStripeEvent(input) {
      await stripeWebhookHandler.handleDirect(JSON.parse(input.eventJson));
    },

    async executeRefundCore(input) {
      return billingCategory.executeRefundCore(input);
    },

    // Dispute console tick: reconcile the local mirror, post evidence-due
    // reminders, check the ratio thresholds (all idempotent per tick).
    async disputesTick(force) {
      heartbeat();
      return disputeMonitor.tick(force);
    },

    async runVaultUpgradeJob() {
      heartbeat();
      await vaultMigrator.runUpgradeJob();
      reconfigureInflux(settingsStore.influxConfig());
    },
  };
}
