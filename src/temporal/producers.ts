import { WithStartWorkflowOperation, type Client, type ScheduleSpec } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError, type SearchAttributePair } from "@temporalio/common";
import type { SettingsStore } from "../config/SettingsStore";
import { log } from "../util/logger";
import type { GatewayResult, TemporalService } from "./TemporalService";
import { looperStartOptions, reconcileLooperGeneration } from "./looperGeneration";
import {
  aiRunWorkflowId,
  inboxWorkflowId,
  LOOPER_GENERATIONS,
  refundWorkflowId,
  SA_AI_KIND,
  SA_CONVERSATION_ID,
  SA_TICKET_THREAD_ID,
  scoreOneWorkflowId,
  SIG_DISPUTES_RUN_NOW,
  SIG_HUMAN_MESSAGE,
  SIG_INBOUND_EVENT,
  SIG_INTERCOM_CLEAR_OUTBOX,
  SIG_INTERCOM_ENQUEUE,
  SIG_KB_REFRESH_NOW,
  SIG_NOOP,
  SIG_REMINDERS_PAUSED,
  SIG_REQUEST_STATUS_CHANGE,
  SIG_SCORING_ESCALATION_RUN_NOW,
  SIG_SCORING_RUN_NOW,
  SIG_TICKET_CREATED,
  SINGLETONS,
  STATUS_REPORT_SCHEDULE_ID,
  stripeEventWorkflowId,
  ticketWorkflowId,
  UPD_APPLY_PRIORITY,
  UPD_APPLY_STATUS,
  VAULT_UPGRADE_WORKFLOW_ID,
  type KeywordSaKey,
  type AiRunInput,
  type ApplyStatusResult,
  type HumanMessageSignal,
  type IcEventType,
  type InboundEventSignal,
  type PriorityChangeRequest,
  type RefundOutcome,
  type RefundWorkflowInput,
  type StatusChangeRequest,
  type TicketCreatedSignal,
} from "./types";

const prodLog = log.child("temporal:producers");

// Thrown by webhook seams when an operation was only buffered (Temporal
// unreachable): the HTTP route answers 5xx so the sender redelivers.
export class TemporalBufferedError extends Error {}

// Everything the /config → Temporal panel needs, bound into DiscordBot after
// the Temporal stack is constructed. Worker manager kept structural so this
// module never imports Node-heavy worker code.
export interface TemporalOpsBinding {
  producers: TemporalProducers;
  service: TemporalService;
  workerManager: {
    running(): boolean;
    deploymentVersion(): { deploymentName: string; buildId: string };
    promoted(): boolean | null;
  };
  // The temporalEnabled toggle is a worker PAUSE (there is no legacy regime):
  // ON = reconcile looper generations + start the worker, OFF = drain the
  // worker (background work pauses; signals keep landing server-side).
  // Persisting temporalEnabled is the caller's job (the /config toggle does both).
  setEnabled: (enabled: boolean) => Promise<void>;
}

// The thin facade every producer call site goes through (DiscordBot handlers,
// StatusService/IntercomSyncService seams, CallbackServer webhooks, Vault
// hooks). Two gates:
// - routable(): Temporal is configured — fire-and-forget signals are sent even
//   while the worker is paused (they land server-side and process on resume).
// - enabled(): the worker is meant to be active (pause toggle && configured) —
//   gates the synchronous seams whose callers need an immediate result and
//   fall back to their direct in-process path otherwise.

export class TemporalProducers {
  constructor(
    private temporal: TemporalService,
    private settings: SettingsStore
  ) {}

  // Worker-active gate (pause toggle AND prerequisites).
  enabled(): boolean {
    return this.temporal.enabled();
  }

  // Configured gate for fire-and-forget signals (ignores the pause toggle).
  routable(): boolean {
    return this.temporal.configured();
  }

  service(): TemporalService {
    return this.temporal;
  }

  // Typed-search-attribute start options, attached ONLY once registration is
  // confirmed — a start naming an unregistered attribute fails the whole
  // command, so this helper is how SAs stay unable to break anything. (A
  // buffered op enqueued while ready could flush against a re-pointed
  // namespace lacking SAs; the flush failure re-buffers — accepted edge.)
  private sa(
    pairs: Array<{ key: KeywordSaKey; value: string | null | undefined }>
  ): { typedSearchAttributes?: SearchAttributePair[] } {
    if (!this.temporal.searchAttributesReady()) return {};
    const list = pairs
      .filter((p): p is { key: KeywordSaKey; value: string } => p.value != null && p.value !== "")
      .map((p) => ({ key: p.key, value: p.value }));
    return list.length > 0 ? { typedSearchAttributes: list } : {};
  }

  // ---- ticket workflow signals (buffered fire-and-forget) ----

  private signalTicket(threadId: string, signalName: string, ...signalArgs: unknown[]): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "ticketWorkflow",
      workflowId: ticketWorkflowId(threadId),
      args: [{ threadId }],
      signalName,
      signalArgs,
      options: { ...this.sa([{ key: SA_TICKET_THREAD_ID, value: threadId }]) },
    });
  }

  async ticketCreated(threadId: string, payload: TicketCreatedSignal): Promise<GatewayResult> {
    return this.signalTicket(threadId, SIG_TICKET_CREATED, payload);
  }

  async humanMessage(threadId: string, payload: HumanMessageSignal): Promise<GatewayResult> {
    return this.signalTicket(threadId, SIG_HUMAN_MESSAGE, payload);
  }

  async intercomEnqueue(threadId: string, type: IcEventType, payload: unknown | null): Promise<GatewayResult> {
    return this.signalTicket(threadId, SIG_INTERCOM_ENQUEUE, { type, payload });
  }

  // Bridge reset/wipe: drop this ticket's queued (pre-wipe) Intercom events so
  // they can't resurrect the data the operator just wiped.
  async intercomClearOutbox(threadId: string): Promise<GatewayResult> {
    return this.signalTicket(threadId, SIG_INTERCOM_CLEAR_OUTBOX);
  }

  async remindersPaused(threadId: string, paused: boolean): Promise<GatewayResult> {
    return this.signalTicket(threadId, SIG_REMINDERS_PAUSED, { paused });
  }

  async requestStatusChange(threadId: string, req: StatusChangeRequest): Promise<GatewayResult> {
    return this.signalTicket(threadId, SIG_REQUEST_STATUS_CHANGE, req);
  }

  // ---- updates (synchronous result; NOT buffered — null = Temporal
  // unavailable right now, caller runs its legacy path) ----

  async applyStatus(threadId: string, req: StatusChangeRequest): Promise<ApplyStatusResult | null> {
    return this.updateTicket<ApplyStatusResult>(threadId, UPD_APPLY_STATUS, req);
  }

  async applyPriority(threadId: string, req: PriorityChangeRequest): Promise<{ ok: boolean } | null> {
    return this.updateTicket<{ ok: boolean }>(threadId, UPD_APPLY_PRIORITY, req);
  }

  private async updateTicket<R>(threadId: string, updateName: string, arg: unknown): Promise<R | null> {
    const client = await this.temporal.client();
    if (!client) return null;
    try {
      const startOp = new WithStartWorkflowOperation("ticketWorkflow", {
        workflowId: ticketWorkflowId(threadId),
        taskQueue: this.temporal.envConfig().taskQueue,
        args: [{ threadId }],
        workflowIdConflictPolicy: "USE_EXISTING",
        ...this.sa([{ key: SA_TICKET_THREAD_ID, value: threadId }]),
      });
      return await client.workflow.executeUpdateWithStart(updateName, {
        args: [arg],
        startWorkflowOperation: startOp,
      }) as R;
    } catch (e) {
      prodLog.warn("temporal update failed — caller falls back to legacy path", {
        "temporal.update": updateName,
        "ticket.thread_id": threadId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  // ---- inbound Intercom webhook ----

  async inboundIntercomEvent(conversationId: string, evt: InboundEventSignal): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "intercomInboxWorkflow",
      workflowId: inboxWorkflowId(conversationId),
      args: [{ conversationId }],
      signalName: SIG_INBOUND_EVENT,
      signalArgs: [evt],
      options: { ...this.sa([{ key: SA_CONVERSATION_ID, value: conversationId }]) },
    });
  }

  // ---- Stripe webhook (dedup by workflow id) ----

  async stripeEvent(eventId: string, eventJson: string, eventType?: string): Promise<GatewayResult> {
    return this.temporal.startWorkflow({
      workflowType: "stripeEventWorkflow",
      workflowId: stripeEventWorkflowId(eventId),
      args: [{ eventId, eventJson }],
      options: {
        workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
        // UI context only — the event type in the workflow list beats opening
        // the input payload.
        ...(eventType ? { memo: { eventType } } : {}),
      },
    });
  }

  // ---- AI ----

  // The workflow id (per user) + REJECT_DUPLICATE conflict policy IS the
  // per-user /ai mutex. NOT buffered: the invoker is waiting on an ephemeral.
  async startAiRun(input: AiRunInput): Promise<"started" | "already_running" | "unavailable"> {
    const client = await this.temporal.client();
    if (!client) return "unavailable";
    try {
      await client.workflow.start("aiRunWorkflow", {
        workflowId: aiRunWorkflowId(input.userId),
        taskQueue: this.temporal.envConfig().taskQueue,
        args: [input],
        workflowIdConflictPolicy: "FAIL",
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        memo: { sub: input.sub, threadId: input.threadId },
        ...this.sa([
          { key: SA_TICKET_THREAD_ID, value: input.threadId },
          { key: SA_AI_KIND, value: input.sub },
        ]),
      });
      return "started";
    } catch (e) {
      if (e instanceof WorkflowExecutionAlreadyStartedError) return "already_running";
      prodLog.warn("ai run start failed", { "error.message": e instanceof Error ? e.message : String(e) });
      return "unavailable";
    }
  }

  // /config "Score one now": synchronous outcome; null = Temporal unavailable
  // or the workflow failed — the caller falls back to the direct in-process
  // call (same seam shape as executeRefund). USE_EXISTING joins a double-click
  // onto the already-running score for that thread.
  async executeScoreOne(threadId: string): Promise<string | null> {
    const client = await this.temporal.client();
    if (!client) return null;
    try {
      return (await client.workflow.execute("scoreOneWorkflow", {
        workflowId: scoreOneWorkflowId(threadId),
        taskQueue: this.temporal.envConfig().taskQueue,
        args: [{ threadId }],
        workflowIdConflictPolicy: "USE_EXISTING",
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        ...this.sa([
          { key: SA_TICKET_THREAD_ID, value: threadId },
          { key: SA_AI_KIND, value: "score_one" },
        ]),
      })) as string;
    } catch (e) {
      prodLog.warn("score-one workflow failed — caller falls back to direct call", {
        "ticket.thread_id": threadId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  // ---- billing (synchronous outcome; null = Temporal unavailable) ----

  async executeRefund(input: RefundWorkflowInput): Promise<RefundOutcome | null> {
    const client = await this.temporal.client();
    if (!client) return null;
    try {
      return await client.workflow.execute("refundWorkflow", {
        workflowId: refundWorkflowId(input.chargeId),
        taskQueue: this.temporal.envConfig().taskQueue,
        args: [input],
        workflowIdConflictPolicy: "USE_EXISTING",
        ...this.sa([{ key: SA_TICKET_THREAD_ID, value: input.threadId }]),
      });
    } catch (e) {
      prodLog.warn("refund workflow failed", { "error.message": e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  // ---- ops ----

  async startVaultUpgrade(): Promise<GatewayResult> {
    return this.temporal.startWorkflow({
      workflowType: "vaultUpgradeWorkflow",
      workflowId: VAULT_UPGRADE_WORKFLOW_ID,
      options: { workflowIdConflictPolicy: "USE_EXISTING" },
    });
  }

  async kbRefreshNow(): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "kbRefreshWorkflow",
      workflowId: SINGLETONS.kbRefresh,
      signalName: SIG_KB_REFRESH_NOW,
      // A race-start from this button must stamp the generation memo too.
      options: looperStartOptions(SINGLETONS.kbRefresh),
    });
  }

  async scoringRunNow(): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "scoringLoopWorkflow",
      workflowId: SINGLETONS.scoringLoop,
      signalName: SIG_SCORING_RUN_NOW,
      options: looperStartOptions(SINGLETONS.scoringLoop),
    });
  }

  async scoringEscalationRunNow(): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "scoringLoopWorkflow",
      workflowId: SINGLETONS.scoringLoop,
      signalName: SIG_SCORING_ESCALATION_RUN_NOW,
      options: looperStartOptions(SINGLETONS.scoringLoop),
    });
  }

  async disputesRunNow(): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "disputesLoopWorkflow",
      workflowId: SINGLETONS.disputesLoop,
      signalName: SIG_DISPUTES_RUN_NOW,
      options: looperStartOptions(SINGLETONS.disputesLoop),
    });
  }

  async runReportNow(): Promise<GatewayResult> {
    return this.temporal.startWorkflow({
      workflowType: "publishStatusReportWorkflow",
      workflowId: `${STATUS_REPORT_SCHEDULE_ID}-manual`,
      args: [{ force: true }],
      options: { workflowIdReusePolicy: "ALLOW_DUPLICATE" },
    });
  }

  // ---- baseline: singleton loopers + the status-report Schedule ----

  // Idempotent; runs before the worker starts (boot / toggle ON) and on
  // Temporal recovery. Reconciles each singleton's generation first — a
  // running looper whose workflow body changed shape this release
  // (LOOPER_GENERATIONS bump) is terminated so the signal-with-start below
  // brings up a fresh run on the new code; see the note in types.ts.
  async ensureBaseline(): Promise<void> {
    const singles: Array<[string, string]> = [
      ["kbRefreshWorkflow", SINGLETONS.kbRefresh],
      ["scoringLoopWorkflow", SINGLETONS.scoringLoop],
      ["metricsSnapshotWorkflow", SINGLETONS.metricsSnapshot],
      ["cleanupLoopWorkflow", SINGLETONS.cleanupLoop],
      ["disputesLoopWorkflow", SINGLETONS.disputesLoop],
    ];
    const client = await this.temporal.client();
    for (const [type, id] of singles) {
      if (client) {
        try {
          const r = await reconcileLooperGeneration(client, id, LOOPER_GENERATIONS[id] ?? 1);
          if (r.action === "terminated") {
            prodLog.info("looper generation changed — restarting singleton", {
              "temporal.workflow_id": id,
              "looper.gen_from": r.runningGen ?? 0,
              "looper.gen_to": r.wantedGen,
            });
          }
        } catch (e) {
          prodLog.warn("looper generation check failed — leaving running instance", {
            "temporal.workflow_id": id,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
      await this.temporal.signalWithStart({
        workflowType: type,
        workflowId: id,
        signalName: SIG_NOOP,
        options: looperStartOptions(id),
      });
    }
    await this.syncReportSchedule().catch((e) =>
      prodLog.warn("status-report schedule sync failed", {
        "error.message": e instanceof Error ? e.message : String(e),
      })
    );
  }

  // Creates/updates the status-report Schedule from the /config report
  // settings. Called from ensureBaseline and whenever /config → Report saves.
  async syncReportSchedule(): Promise<void> {
    const client = await this.temporal.client();
    if (!client) throw new Error("temporal unavailable");
    const spec = this.reportScheduleSpec();
    const desiredPaused = !this.settings.reportEnabled() || !this.settings.reportChannelId();
    try {
      const handle = client.schedule.getHandle(STATUS_REPORT_SCHEDULE_ID);
      await handle.update((prev) => ({
        ...prev,
        spec,
        state: { ...prev.state, paused: desiredPaused },
      }));
    } catch {
      await client.schedule.create({
        scheduleId: STATUS_REPORT_SCHEDULE_ID,
        spec,
        action: {
          type: "startWorkflow",
          workflowType: "publishStatusReportWorkflow",
          args: [{ force: false }],
          taskQueue: this.temporal.envConfig().taskQueue,
        },
        policies: {
          // The activity's own once-per-day guard is the real protection;
          // SKIP just avoids pointless overlapping runs.
          overlap: "SKIP",
          catchupWindow: "1 day",
        },
        state: { paused: desiredPaused },
      });
    }
  }

  // Wall-clock mode (reportHour/Minute in reportTimezone) or interval mode —
  // same duality as the legacy StatusReportScheduler.
  private reportScheduleSpec(): ScheduleSpec {
    const hour = this.settings.reportHour();
    const minute = this.settings.reportMinute();
    if (hour != null && minute != null) {
      return {
        calendars: [{ hour, minute, comment: "daily status report (/config → Report)" }],
        timezone: this.settings.reportTimezone(),
      };
    }
    const hours = Math.max(1, this.settings.reportIntervalHours());
    return { intervals: [{ every: `${hours}h` }] };
  }
}

// Small helper for panel code that needs the raw client.
export type { Client };
