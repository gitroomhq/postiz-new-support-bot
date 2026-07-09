import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { Client, ThreadChannel } from "discord.js";
import type { PrismaClient, StatusTag } from "../../generated/prisma/client";
import type { SettingsStore } from "../../config/SettingsStore";
import type { EscalationTierStore } from "../../config/EscalationTierStore";
import type { SessionStore } from "../../auth/SessionStore";
import type { TicketStore, TicketWithTag } from "../../bot/TicketStore";
import type { StatusService } from "../../bot/StatusService";
import type { AuditLogger } from "../../bot/AuditLogger";
import type { DiscordBot } from "../../bot/DiscordBot";
import type { KnowledgeBaseScheduler } from "../../bot/KnowledgeBaseScheduler";
import type { StatusReportScheduler } from "../../bot/StatusReportScheduler";
import type { StripeWebhookHandler } from "../../bot/StripeWebhookHandler";
import type { TicketAiRunStore } from "../../bot/TicketAiRunStore";
import { RESOLVED_EMOJI } from "../../bot/StatusService";
import type { BillingCategory } from "../../categories/BillingCategory";
import type { IntercomStore } from "../../intercom/IntercomStore";
import type { IntercomSyncService } from "../../intercom/IntercomSyncService";
import type { IntercomEventExecutor } from "../../intercom/IntercomEventExecutor";
import { IntercomHttpError } from "../../intercom/IntercomClient";
import { DeferEchoError, type IntercomWebhookHandler } from "../../intercom/IntercomWebhookHandler";
import type { EnsurePayload } from "../../intercom/types";
import type { SnapshotScheduler } from "../../metrics/SnapshotScheduler";
import { exportIntercomQueueDepth } from "../../metrics/MetricsExporter";
import { influxActive } from "../../metrics/InfluxWriter";
import type { TicketScoringService } from "../../scoring/TicketScoringService";
import type { VaultMigrator } from "../../vault/VaultMigrator";
import { reconfigureInflux } from "../../metrics/InfluxWriter";
import { embed, COLORS } from "../../util/embeds";
import { log } from "../../util/logger";
import type { TemporalProducers } from "../producers";
import {
  SIG_INBOUND_EVENT,
  SIG_INTERCOM_ENQUEUE,
  inboxWorkflowId,
  ticketWorkflowId,
  type CoreActivities,
  type IcEventType,
  type ImportTicketSeed,
  type TicketSnapshot,
  type TimerCheckResult,
} from "../types";

const actLog = log.child("temporal:activities");

const DAY_MS = 24 * 60 * 60 * 1000;
const RECLOSE_DELAY_MS = 30 * 60 * 1000;
const DEFAULT_RESOLVED_AUTO_CLOSE_DAYS = 3;
// Politeness pacing between Intercom API deliveries (was CALL_SPACING_MS in
// the legacy drain loop — now a worker-global limiter across activities).
const INTERCOM_CALL_SPACING_MS = 300;
// Retention sweeps folded into the cleanup loop (legacy outbox-scheduler values).
const ECHO_RETENTION_MS = 14 * DAY_MS;
const PENDING_POST_RETENTION_MS = 60 * 60 * 1000;

export interface ActivityDeps {
  prisma: PrismaClient;
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
  scoringService: TicketScoringService;
  kbScheduler: KnowledgeBaseScheduler;
  reportScheduler: StatusReportScheduler;
  snapshotScheduler: SnapshotScheduler;
  ticketAiRunStore: TicketAiRunStore;
  stripeWebhookHandler: StripeWebhookHandler;
  billingCategory: BillingCategory;
  vaultMigrator: VaultMigrator;
  bot: DiscordBot;
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
    scoringService,
    kbScheduler,
    reportScheduler,
    snapshotScheduler,
    ticketAiRunStore,
    stripeWebhookHandler,
    billingCategory,
    vaultMigrator,
    bot,
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
      tagClosesThread: tag?.closesThread ?? false,
      tagIsResolved: tag?.emoji === RESOLVED_EMOJI,
      tagReminderEnabled: tag?.reminderEnabled ?? false,
      tagReminderDays: tag?.reminderDays ?? 3,
      tagReminderTarget: tag?.reminderTarget === "CUSTOMER" ? "CUSTOMER" : "SUPPORT",
      tagAutoCloseAfter: tag?.autoCloseAfter ?? null,
      remindersPaused: ticket.remindersPaused,
      reminderCount: ticket.reminderCount,
      lastReminderAtMs: ticket.lastReminderAt?.getTime() ?? null,
      lastStatusChangeAtMs: ticket.lastStatusChangeAt.getTime(),
      recloseAtMs: ticket.recloseAt?.getTime() ?? null,
      hasIntercomLink: !!link,
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

  // Port of ReminderScheduler.processTicket's reminder send for ONE ticket.
  const sendReminder = async (thread: ThreadChannel, ticket: TicketWithTag, tag: StatusTag, target: "SUPPORT" | "CUSTOMER"): Promise<void> => {
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
      const pingRoleId = tierStore.pingRoleIdFor(ticket.escalationTierId, settingsStore.supportRoleId());
      if (!pingRoleId) return;
      await thread.send({
        content: `<@&${pingRoleId}>`,
        embeds: [
          embed(
            `This ticket has gone ${tag.reminderDays} day(s) without a reply — please follow up.\n\nStatus: ${tag.emoji} ${tag.label}`,
            COLORS.warn
          ),
        ],
        allowedMentions: { roles: [pingRoleId] },
      });
    }
    await ticketStore.recordReminder(ticket.threadId);
    actLog.info("reminder.sent", {
      "ticket.thread_id": ticket.threadId,
      "reminder.target": target.toLowerCase(),
      "reminder.round": ticket.reminderCount + 1,
    });
    void auditLogger.log({
      title: "⏰ Reminder sent",
      severity: "warn",
      actor: "Automatic",
      threadId: ticket.threadId,
      fields: [
        { name: "Target", value: target.toLowerCase(), inline: true },
        { name: "Status", value: `${tag.emoji} ${tag.label}`, inline: true },
        { name: "Round", value: String(ticket.reminderCount + 1), inline: true },
      ],
    });
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
                await sendReminder(thread, ticket, tag, target);
                reminded = true;
              }
            }
          }
        }
      }

      // ---- resolved auto-close (ReminderScheduler.processResolvedTicket) ----
      if (!statusChange && tag && tag.emoji === RESOLVED_EMOJI && !ticket.remindersPaused) {
        const closingTag = settingsStore.closingTag();
        if (closingTag) {
          if (!thread) {
            await ticketStore.close(threadId);
          } else if (!thread.locked) {
            const days = tag.autoCloseAfter ?? DEFAULT_RESOLVED_AUTO_CLOSE_DAYS;
            // A customer reply normally reopens the ticket; if one slipped
            // through, don't auto-close on top of it.
            const awaitedAt = await lastAwaitedMessageAt(thread, "CUSTOMER", ticket.customerId);
            const repliedSinceChange = awaitedAt != null && awaitedAt > ticket.lastStatusChangeAt.getTime();
            if (!repliedSinceChange && now - ticket.lastStatusChangeAt.getTime() >= days * DAY_MS) {
              statusChange = { tagId: closingTag.id, actorName: "Automatic" };
            }
          }
        }
      }

      return { statusChange, reminded, reclosed, snapshot: await buildSnapshot(threadId) };
    },

    async pingStaffForNewTicket(threadId) {
      await bot.pingStaffForNewTicketThread(threadId);
    },

    // ================= status / priority =================

    // The whole transition via StatusService.applyStatusDirect — the exact
    // legacy implementation, serialized by the parent ticket workflow.
    async statusApplyDirect(input) {
      const ticket = await ticketStore.getByThreadId(input.threadId);
      const tag = settingsStore.tagById(input.tagId);
      if (!ticket) {
        return { applied: false, reason: "not a tracked ticket", closed: false, isResolved: false, closesThread: false, statusTagId: input.tagId };
      }
      if (!tag) {
        return { applied: false, reason: "unknown status tag", closed: ticket.closed, isResolved: false, closesThread: false, statusTagId: input.tagId };
      }
      const isResolved = tag.emoji === RESOLVED_EMOJI;
      const isDone = tag.closesThread || isResolved;
      // No-op guard mirrors handleThreadUpdate's backstop: already there.
      const thread = await fetchThread(input.threadId);
      if (!thread) {
        // Thread gone/unreachable — reconcile DB + mirror (the legacy
        // member-leave else-branch).
        await ticketStore.close(input.threadId).catch(() => {});
        await intercomSync
          .onStatusChanged(input.threadId, ticket.statusTag ?? null, tag, input.actorName)
          .catch(() => {});
        return { applied: true, closed: true, isResolved, closesThread: tag.closesThread, statusTagId: tag.id };
      }
      await statusService.applyStatusDirect(thread, ticket, tag, {
        actorName: input.actorName,
        actorId: input.actorId ?? undefined,
        actorIconUrl: input.actorIconUrl ?? undefined,
        silent: input.silent,
      });
      return { applied: true, closed: isDone, isResolved, closesThread: tag.closesThread, statusTagId: tag.id };
    },

    async applyPriorityStep(input) {
      const ticket = await ticketStore.getByThreadId(input.threadId);
      const priority = settingsStore.priorityById(input.priorityTagId);
      const thread = await fetchThread(input.threadId);
      if (!ticket || !priority || !thread) return;
      await statusService.applyPriorityDirect(thread, ticket, priority, {
        actorName: input.actorName,
        actorId: input.actorId ?? undefined,
        actorIconUrl: input.actorIconUrl ?? undefined,
      });
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
        await intercomExecutor.execute(threadId, event.type as IcEventType, payload);
      } catch (e) {
        if (e instanceof IntercomHttpError) {
          // 404 on a non-ensure event: a linked remote object was deleted —
          // self-heal inline (legacy handleFailure behavior), then retry.
          if (e.status === 404 && event.type !== "ensure") {
            await intercomExecutor.selfHeal404(threadId).catch((healError) => {
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
      if (force) {
        const r = await kbScheduler.refreshNow();
        return { refreshed: true, ...r };
      }
      await kbScheduler.tick();
      return { refreshed: false, ok: 0, failed: 0 };
    },

    // Verbatim ScoringScheduler.tick(): poll in-flight Anthropic batches,
    // submit when due / backfill pending, one batch in flight.
    async scoringTick() {
      if (!settingsStore.scoringEnabled()) return;
      if (!scoringService.hasDiscordClient()) return;
      heartbeat();
      await scoringService.pollBatches();
      if (await scoringService.hasPendingBatches()) return;

      const backfill = settingsStore.scoringBackfillPending();
      const lastRun = settingsStore.scoringLastRunAt();
      const intervalMs = Math.max(1, settingsStore.scoringIntervalHours()) * 60 * 60 * 1000;
      const due = !lastRun || Date.now() - lastRun.getTime() >= intervalMs;
      if (!backfill && !due) return;

      heartbeat();
      const result = await scoringService.submitBatch(backfill ? "backfill" : "interval");
      if (result.budgetBlocked) return;
      if (result.submitted > 0 || result.skipped > 0) {
        await settingsStore.recordScoringRun();
      }
      if (backfill && result.drained) {
        await settingsStore.setScoringBackfillPending(false);
        actLog.info("scoring.backfill_complete");
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
          exportIntercomQueueDepth({ queue: "outbox", pending: Number(outbox.count ?? 0), dead: 0 });
          exportIntercomQueueDepth({ queue: "inbox", pending: Number(inbox.count ?? 0), dead: 0 });
        }
      } catch {
        // visibility counts are best-effort gauges
      }
    },

    // 5-minute sweep: pending auths, old Stripe dedup rows, Intercom echo /
    // pending-post retention (the legacy outbox scheduler's hourly sweeps),
    // and the /ai run history purge (was its own hourly setInterval).
    async cleanupTick() {
      await sessionStore.cleanExpiredPending().catch((e) => actLog.error("clean pending auths failed", e));
      await sessionStore.cleanOldStripeEvents().catch((e) => actLog.error("clean stripe events failed", e));
      await intercomStore.cleanupEchoParts(new Date(Date.now() - ECHO_RETENTION_MS)).catch(() => {});
      await intercomStore.cleanupPendingPosts(new Date(Date.now() - PENDING_POST_RETENTION_MS)).catch(() => {});
      await ticketAiRunStore.purgeForClosedTickets().catch((e) => actLog.error("ai run history purge failed", e));
    },

    async publishStatusReport(force) {
      return reportScheduler.publishIfDue(force);
    },

    async scoreOneNow(threadId) {
      const result = await scoringService.scoreOneNow(threadId);
      return typeof result === "string" ? result : JSON.stringify(result);
    },

    // ================= AI =================

    async runAutoAnswer(input) {
      return bot.runAutoAnswerForTicket(input, () => heartbeat());
    },

    async runStaffAiCommand(input) {
      await bot.executeAiRunFromWorkflow(input, () => heartbeat());
    },

    // ================= stripe / billing / vault =================

    async handleStripeEvent(input) {
      await stripeWebhookHandler.handleDirect(JSON.parse(input.eventJson));
    },

    async executeRefundCore(input) {
      return billingCategory.executeRefundCore(input);
    },

    async runVaultUpgradeJob() {
      heartbeat();
      await vaultMigrator.runUpgradeJob();
      reconfigureInflux(settingsStore.influxConfig());
    },

    // ================= migration import =================

    // Open tickets + closed tickets that still owe work (pending re-close or
    // PENDING outbox rows) each get a ticket workflow.
    async importListTickets(): Promise<ImportTicketSeed[]> {
      heartbeat();
      const rows = await deps.prisma.ticket.findMany({
        where: { OR: [{ closed: false }, { recloseAt: { not: null } }] },
        select: { threadId: true },
      });
      const pendingOutbox = await deps.prisma.intercomOutboxEvent.findMany({
        where: { status: "PENDING" },
        select: { ticketThreadId: true },
        distinct: ["ticketThreadId"],
      });
      const ids = new Set<string>(rows.map((r) => r.threadId));
      for (const r of pendingOutbox) ids.add(r.ticketThreadId);
      return [...ids].map((threadId) => ({
        threadId,
        carry: { outbox: [], outboxSeq: 0, statusSeq: 0, hasIntercomLink: false, lastEventMs: null },
      }));
    },

    // signal-with-start(noop) per ticket: idempotent against already-running
    // workflows; a fresh start rehydrates from Postgres via loadTicketState.
    async importStartTicketWorkflows(seeds) {
      let started = 0;
      const c = await producers.service().client();
      if (!c) throw new Error("temporal client unavailable");
      for (const seed of seeds) {
        heartbeat();
        await c.workflow.signalWithStart("ticketWorkflow", {
          workflowId: ticketWorkflowId(seed.threadId),
          taskQueue: producers.service().envConfig().taskQueue,
          args: [{ threadId: seed.threadId }],
          signal: "noop",
          signalArgs: [],
        });
        started++;
      }
      return started;
    },

    // Replay PENDING outbox rows as intercomEnqueue signals in seq order per
    // ticket, then mark them IMPORTED so a re-run skips them. DEAD rows stay
    // as the audit record until the table is dropped in release N+1.
    async importOutboxRows() {
      const c = await producers.service().client();
      if (!c) throw new Error("temporal client unavailable");
      const rows = await deps.prisma.intercomOutboxEvent.findMany({
        where: { status: "PENDING" },
        orderBy: { seq: "asc" },
      });
      let imported = 0;
      for (const row of rows) {
        heartbeat();
        await c.workflow.signalWithStart("ticketWorkflow", {
          workflowId: ticketWorkflowId(row.ticketThreadId),
          taskQueue: producers.service().envConfig().taskQueue,
          args: [{ threadId: row.ticketThreadId }],
          signal: SIG_INTERCOM_ENQUEUE,
          signalArgs: [{ type: row.type as IcEventType, payload: row.payload }],
        });
        await deps.prisma.intercomOutboxEvent.update({ where: { id: row.id }, data: { status: "IMPORTED" } });
        imported++;
      }
      return imported;
    },

    // Same for the inbound queue → per-conversation inbox workflows.
    async importInboxRows() {
      const c = await producers.service().client();
      if (!c) throw new Error("temporal client unavailable");
      const rows = await deps.prisma.intercomInboxEvent.findMany({
        where: { status: "PENDING" },
        orderBy: { seq: "asc" },
      });
      let imported = 0;
      for (const row of rows) {
        heartbeat();
        const payload = row.payload as { data?: { item?: { id?: unknown } } } | null;
        const itemId = payload?.data?.item?.id;
        if (itemId != null) {
          await c.workflow.signalWithStart("intercomInboxWorkflow", {
            workflowId: inboxWorkflowId(String(itemId)),
            taskQueue: producers.service().envConfig().taskQueue,
            args: [{ conversationId: String(itemId) }],
            signal: SIG_INBOUND_EVENT,
            signalArgs: [{ deliveryId: row.deliveryId, topic: row.topic, payload: row.payload }],
          });
          imported++;
        }
        await deps.prisma.intercomInboxEvent.update({ where: { id: row.id }, data: { status: "IMPORTED" } });
      }
      return imported;
    },

    async importEnsureBaseline() {
      await producers.ensureBaseline();
    },

    async importWriteAudit(summary) {
      await settingsStore.updateTemporal({ temporalImportDoneAt: new Date() });
      void auditLogger.log({
        title: "⏱️ Temporal import completed",
        severity: "success",
        actor: "Temporal migration",
        fields: [
          { name: "Ticket workflows", value: String(summary.ticketWorkflowsStarted), inline: true },
          { name: "Outbox events imported", value: String(summary.outboxImported), inline: true },
          { name: "Inbox events imported", value: String(summary.inboxImported), inline: true },
        ],
      });
    },
  };
}
