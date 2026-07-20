import { WithStartWorkflowOperation, type Client } from "@temporalio/client";
import type { SearchAttributePair } from "@temporalio/common";
import type { SettingsStore } from "../config/SettingsStore";
import { log } from "../util/logger";
import type { GatewayResult, TemporalService } from "./TemporalService";
import { looperStartOptions, reconcileLooperGeneration, retireByQuery, retireWorkflowId } from "./looperGeneration";
import {
  inboxWorkflowId,
  LOOPER_GENERATIONS,
  refundWorkflowId,
  RETIRED_SCHEDULES,
  RETIRED_SINGLETONS,
  RETIRED_WORKFLOW_QUERIES,
  SA_CONVERSATION_ID,
  SA_TICKET_THREAD_ID,
  SIG_DISPUTES_RUN_NOW,
  SIG_HUMAN_MESSAGE,
  SIG_INACTIVITY_RUN_NOW,
  SIG_SLA_RUN_NOW,
  SIG_SLA_ENFORCE_RUN_NOW,
  SIG_SENTRY_FEEDBACK_RUN_NOW,
  SIG_INBOUND_EVENT,
  SIG_INTERCOM_CLEAR_OUTBOX,
  SIG_INTERCOM_ENQUEUE,
  SIG_KB_REFRESH_NOW,
  SIG_NOOP,
  SIG_REQUEST_STATUS_CHANGE,
  SIG_TICKET_CREATED,
  SINGLETONS,
  stripeEventWorkflowId,
  ticketWorkflowId,
  UPD_APPLY_STATUS,
  VAULT_UPGRADE_WORKFLOW_ID,
  type KeywordSaKey,
  type ApplyStatusResult,
  type HumanMessageSignal,
  type IcEventType,
  type InboundEventSignal,
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

  async requestStatusChange(threadId: string, req: StatusChangeRequest): Promise<GatewayResult> {
    return this.signalTicket(threadId, SIG_REQUEST_STATUS_CHANGE, req);
  }

  // ---- updates (synchronous result; NOT buffered — null = Temporal
  // unavailable right now, caller runs its legacy path) ----

  async applyStatus(threadId: string, req: StatusChangeRequest): Promise<ApplyStatusResult | null> {
    return this.updateTicket<ApplyStatusResult>(threadId, UPD_APPLY_STATUS, req);
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

  async disputesRunNow(): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "disputesLoopWorkflow",
      workflowId: SINGLETONS.disputesLoop,
      signalName: SIG_DISPUTES_RUN_NOW,
      options: looperStartOptions(SINGLETONS.disputesLoop),
    });
  }

  async inactivityRunNow(): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "inactivityLoopWorkflow",
      workflowId: SINGLETONS.inactivityLoop,
      signalName: SIG_INACTIVITY_RUN_NOW,
      options: looperStartOptions(SINGLETONS.inactivityLoop),
    });
  }

  async slaRunNow(): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "slaSweepWorkflow",
      workflowId: SINGLETONS.slaSweep,
      signalName: SIG_SLA_RUN_NOW,
      options: looperStartOptions(SINGLETONS.slaSweep),
    });
  }

  async slaEnforceRunNow(): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "slaEnforceWorkflow",
      workflowId: SINGLETONS.slaEnforce,
      signalName: SIG_SLA_ENFORCE_RUN_NOW,
      options: looperStartOptions(SINGLETONS.slaEnforce),
    });
  }

  // /config "Sync Now" button + the POST /sentry/webhook accelerator.
  async sentryFeedbackRunNow(): Promise<GatewayResult> {
    return this.temporal.signalWithStart({
      workflowType: "sentryFeedbackWorkflow",
      workflowId: SINGLETONS.sentryFeedback,
      signalName: SIG_SENTRY_FEEDBACK_RUN_NOW,
      options: looperStartOptions(SINGLETONS.sentryFeedback),
    });
  }

  // ---- baseline: retire dead singletons/schedules, then ensure the live ones ----

  // Idempotent; runs before the worker starts (boot / toggle ON) and on
  // Temporal recovery. Retires agent-rip leftovers first (their workflow
  // types are no longer registered — a surviving run would wedge on its next
  // workflow task), then reconciles each live singleton's generation — a
  // running looper whose workflow body changed shape this release
  // (LOOPER_GENERATIONS bump) is terminated so the signal-with-start below
  // brings up a fresh run on the new code; see the note in types.ts.
  async ensureBaseline(): Promise<void> {
    const client = await this.temporal.client();
    if (client) await this.retireDead(client);
    const singles: Array<[string, string]> = [
      ["kbRefreshWorkflow", SINGLETONS.kbRefresh],
      ["metricsSnapshotWorkflow", SINGLETONS.metricsSnapshot],
      ["cleanupLoopWorkflow", SINGLETONS.cleanupLoop],
      ["disputesLoopWorkflow", SINGLETONS.disputesLoop],
      ["inactivityLoopWorkflow", SINGLETONS.inactivityLoop],
      ["slaSweepWorkflow", SINGLETONS.slaSweep],
      ["slaEnforceWorkflow", SINGLETONS.slaEnforce],
      ["sentryFeedbackWorkflow", SINGLETONS.sentryFeedback],
    ];
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
  }

  // Agent-rip retirement: terminate retired singletons + orphaned children,
  // delete retired Schedules. Every step is idempotent and per-step
  // best-effort — a Temporal hiccup here must never block the boot; the next
  // ensureBaseline (recovery / toggle) converges.
  private async retireDead(client: Client): Promise<void> {
    for (const { workflowId, reason } of RETIRED_SINGLETONS) {
      try {
        if (await retireWorkflowId(client, workflowId, reason)) {
          prodLog.info("retired singleton terminated", { "temporal.workflow_id": workflowId, "retire.reason": reason });
        }
      } catch (e) {
        prodLog.warn("retired-singleton terminate failed — retried on next baseline", {
          "temporal.workflow_id": workflowId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }
    for (const { query, reason } of RETIRED_WORKFLOW_QUERIES) {
      try {
        const n = await retireByQuery(client, query, reason);
        if (n > 0) prodLog.info("retired workflows terminated by query", { "retire.query": query, "retire.count": n });
      } catch (e) {
        prodLog.warn("retired-query terminate failed — retried on next baseline", {
          "retire.query": query,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }
    for (const scheduleId of RETIRED_SCHEDULES) {
      try {
        await client.schedule.getHandle(scheduleId).delete();
        prodLog.info("retired schedule deleted", { "temporal.schedule_id": scheduleId });
      } catch {
        // Not found (already deleted) or transient — either way the next
        // baseline pass settles it.
      }
    }
  }
}

// Small helper for panel code that needs the raw client.
export type { Client };
