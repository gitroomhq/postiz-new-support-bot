// Pure shared types + constants for the Temporal layer. This module is
// imported by BOTH workflow code (sandboxed, webpack-bundled) and Node-side
// code (producers, activities, panel) — it must never import anything beyond
// type-level TS. No Node builtins, no app modules.

// Type-only deep import: the SearchAttributeKey interface itself is not
// re-exported from the @temporalio/common package root (the pair/update
// types are). Erased at compile time, so the workflow bundle never sees it.
import type { SearchAttributeKey } from "@temporalio/common/lib/search-attributes";

export type KeywordSaKey = SearchAttributeKey<"KEYWORD">;

// ---- Workflow id scheme (id = dedup/collision semantics) ----

export const ticketWorkflowId = (threadId: string): string => `ticket-${threadId}`;
export const statusChangeChildId = (threadId: string, seq: number): string => `status-${threadId}-${seq}`;
export const intercomDeliveryChildId = (threadId: string, seq: number): string => `icd-${threadId}-${seq}`;
export const autoAnswerChildId = (threadId: string): string => `auto-answer-${threadId}`;
export const inboxWorkflowId = (conversationId: string): string => `icx-${conversationId}`;
export const stripeEventWorkflowId = (eventId: string): string => `stripe-evt-${eventId}`;
export const refundWorkflowId = (chargeId: string): string => `refund-${chargeId}`;

export const SINGLETONS = {
  kbRefresh: "kb-refresh",
  metricsSnapshot: "metrics-snapshot",
  cleanupLoop: "cleanup-loop",
  disputesLoop: "disputes-loop",
  slaSweep: "sla-sweep",
  slaEnforce: "sla-enforce",
  sentryFeedback: "sentry-feedback-sync",
  moneyOut: "money-out-sync",
} as const;

export const VAULT_UPGRADE_WORKFLOW_ID = "vault-upgrade";
export const STATUS_REPORT_SCHEDULE_ID = "status-report";

// ---- Retired workflows/schedules (agent-rip release) ----
// ensureBaseline terminates/deletes these BEFORE the worker starts, every boot
// (idempotent). A retired id must never reappear in SINGLETONS — their workflow
// types are no longer registered, so a surviving run would wedge on its next
// workflow task until the next boot retires it again.
export const RETIRED_SINGLETONS = [
  { workflowId: "scoring-loop", reason: "agent-rip: AI ticket scoring removed" },
  { workflowId: "intercom-inactivity-loop", reason: "inactivity sweep folded into the SLA enforce tick" },
] as const;
// Children of retired singletons that may have been orphaned by a crash race
// (parent-close TERMINATE normally kills them with the parent).
export const RETIRED_WORKFLOW_QUERIES = [
  { query: `WorkflowType="scoringBatchWorkflow" AND ExecutionStatus="Running"`, reason: "agent-rip: AI ticket scoring removed" },
] as const;
export const RETIRED_SCHEDULES = [STATUS_REPORT_SCHEDULE_ID] as const;

// ---- Looper generations ----
// Bump a looper's generation IN THE SAME COMMIT as any history-incompatible
// change to its workflow body (changed activity order/types, new children,
// different timers). ensureBaseline() terminates a running singleton whose
// memo generation differs and starts a fresh run stamped with the new one —
// that IS the upgrade path for loopers, because every deploy replays running
// workflows on the new bundle (AUTO_UPGRADE, single in-process worker) and a
// replay mismatch wedges the workflow with nondeterminism task failures.
// Safe: all loopers are stateless between iterations (state re-derived from
// Postgres each tick). Stateful long-lived workflows (ticketWorkflow,
// intercomInboxWorkflow) must use patched() instead — see README.
export const LOOPER_GEN_MEMO_KEY = "looperGen";
export const LOOPER_GENERATIONS: Record<string, number> = {
  [SINGLETONS.kbRefresh]: 1,
  [SINGLETONS.metricsSnapshot]: 1,
  [SINGLETONS.cleanupLoop]: 1,
  [SINGLETONS.disputesLoop]: 1,
  [SINGLETONS.slaSweep]: 1,
  [SINGLETONS.slaEnforce]: 1,
  [SINGLETONS.sentryFeedback]: 1,
  [SINGLETONS.moneyOut]: 1,
};

// ---- Custom search attributes ----
// Registered idempotently by ensureSearchAttributes() (operator gRPC API over
// the existing mTLS connection); producers attach them ONLY after
// TemporalService.searchAttributesReady() confirms registration — a start or
// upsert naming an UNREGISTERED attribute fails the whole command. Names are
// permanent: SQL visibility cannot rename or re-type an attribute.
export const SA_TICKET_THREAD_ID = { name: "ticketThreadId", type: "KEYWORD" } as const satisfies KeywordSaKey;
export const SA_TICKET_STATUS = { name: "ticketStatus", type: "KEYWORD" } as const satisfies KeywordSaKey;
export const SA_CONVERSATION_ID = { name: "conversationId", type: "KEYWORD" } as const satisfies KeywordSaKey;
export const SA_AI_KIND = { name: "aiKind", type: "KEYWORD" } as const satisfies KeywordSaKey;

export const CUSTOM_SEARCH_ATTRIBUTES: ReadonlyArray<KeywordSaKey> = [
  SA_TICKET_THREAD_ID,
  SA_TICKET_STATUS,
  SA_CONVERSATION_ID,
  SA_AI_KIND,
];

// ---- Signal / update names (string constants shared with producers) ----

export const SIG_TICKET_CREATED = "ticketCreated";
export const SIG_HUMAN_MESSAGE = "humanMessage";
export const SIG_INTERCOM_ENQUEUE = "intercomEnqueue";
export const SIG_INTERCOM_CLEAR_OUTBOX = "intercomClearOutbox";

// Echo-defer budget shared by intercomInboxWorkflow (its defer-retry loop) and
// IntercomWebhookHandler (which stops THROWING DeferEcho at this count). One
// constant on purpose: if the handler's cap ended lower the workflow's
// defer-exhaustion path would be unreachable; higher and defers would be
// misreported as real failures.
export const INTERCOM_MAX_ECHO_DEFERS = 24;
export const SIG_REMINDERS_PAUSED = "remindersPaused";
export const SIG_REQUEST_STATUS_CHANGE = "requestStatusChange";
export const SIG_NOOP = "noop";
export const SIG_INBOUND_EVENT = "inboundEvent";
export const SIG_KB_REFRESH_NOW = "kbRefreshNow";
export const SIG_DISPUTES_RUN_NOW = "disputesRunNow";
export const SIG_SLA_RUN_NOW = "slaRunNow";
export const SIG_SLA_ENFORCE_RUN_NOW = "slaEnforceRunNow";
export const SIG_SENTRY_FEEDBACK_RUN_NOW = "sentryFeedbackRunNow";
export const SIG_MONEY_OUT_RUN_NOW = "moneyOutRunNow";
export const UPD_APPLY_STATUS = "applyStatus";
export const QRY_TICKET_STATE = "getState";

// ---- Intercom outbox events carried in ticket workflow state ----

export type IcEventType =
  | "ensure"
  | "message"
  | "note"
  | "status"
  // Legacy skip-only member: the priority axis is removed, but events queued
  // in in-flight ticket workflows may still carry the type — the executor
  // skips them. Removable once no in-flight workflow can still carry it.
  | "priority"
  | "csat"
  // Retired bridged agent-idle reminder (internal note + reopen). No longer
  // emitted — the SLA enforcer owns agent nags — but the executor still handles
  // it so any event queued in an in-flight ticket outbox across the deploy
  // still delivers. Removable once no in-flight workflow can carry it.
  | "agent_reminder"
  | "message_edit"
  | "message_delete"
  // SLA re-evaluation: payload is always null — the target is computed at
  // delivery time from the then-current rules, so stale queued events
  // converge. Riding the outbox gives conversation-before-sla ordering for
  // free (ensure-head synthesis) and the delivery retry machinery.
  | "sla";

export interface IcEvent {
  seq: number;
  type: IcEventType;
  // The composed OutboxPayload (src/intercom/types.ts shape) — carried
  // verbatim because Discord message content is not re-fetchable from
  // Postgres. `null` for ensure: the delivery activity composes it fresh.
  payload: unknown | null;
}

// ---- Ticket workflow ----

export interface TicketWorkflowInput {
  threadId: string;
  // Continue-As-New / migration-import carry-over. Normal starts pass nothing;
  // the first activity loads state from the tickets row.
  carry?: TicketCarry;
}

export interface TicketCarry {
  outbox: IcEvent[];
  outboxSeq: number;
  statusSeq: number;
  hasIntercomLink: boolean;
  lastEventMs: number | null;
}

// Fresh per-ticket state as read from Postgres + StatusTag config. Returned by
// loadTicketState and refreshed by every checkTicketTimers call, so the
// workflow's wake computation always follows live /config tag edits.
export interface TicketSnapshot {
  exists: boolean;
  closed: boolean;
  closedAtMs: number | null;
  statusTagId: string | null;
  // Human status tag label (StatusTag.label) — the ticketStatus search
  // attribute value. Renames apply on the ticket's next transition/scan.
  statusLabel: string | null;
  tagClosesThread: boolean;
  tagIsResolved: boolean;
  tagReminderEnabled: boolean;
  tagReminderDays: number;
  tagReminderTarget: "SUPPORT" | "CUSTOMER";
  tagAutoCloseAfter: number | null;
  remindersPaused: boolean;
  reminderCount: number;
  lastReminderAtMs: number | null;
  lastStatusChangeAtMs: number;
  recloseAtMs: number | null;
  hasIntercomLink: boolean;
}

export interface TicketCreatedSignal {
  categoryId: string;
  question: string | null;
  customerId: string;
  displayName: string;
  aiSolve: boolean;
}

export interface HumanMessageSignal {
  atMs: number;
  isCustomer: boolean;
  isStaff: boolean;
}

export interface RemindersPausedSignal {
  paused: boolean;
}

export interface StatusChangeRequest {
  tagId: string;
  actorName: string;
  actorId?: string | null;
  actorIconUrl?: string | null;
  silent?: boolean;
  // Per-tag auto-close farewell, resolved by checkTicketTimers at decision
  // time (it belongs to the tag being LEFT, which may have changed by the
  // time the child executes). Absent/null = default close notice.
  closeNoticeText?: string | null;
}

export interface ApplyStatusResult {
  ok: boolean;
  reason?: string;
}

// ---- Status-change child workflow ----

export interface StatusChangeInput extends StatusChangeRequest {
  threadId: string;
}

export interface StatusChangeResult {
  applied: boolean;
  reason?: string;
  closed: boolean;
  isResolved: boolean;
  closesThread: boolean;
  statusTagId: string;
  // Label of the applied tag, for the ticketStatus search attribute.
  statusLabel: string | null;
}

// ---- Ticket timer evaluation (reminder / resolved auto-close / re-close) ----

export interface TimerCheckResult {
  // Auto-close decision the workflow must execute via a status-change child.
  statusChange: StatusChangeRequest | null;
  reminded: boolean;
  reclosed: boolean;
  snapshot: TicketSnapshot;
}

// ---- Intercom delivery / inbox ----

export interface IntercomDeliveryInput {
  threadId: string;
  event: IcEvent;
}

export interface IntercomDeliveryResult {
  outcome: "ok" | "dead" | "skipped";
  error?: string;
}

// Structured details thrown by the executeIntercomEvent activity (as
// ApplicationFailure details[0]) so the delivery workflow can classify without
// string parsing — mirrors the legacy outbox handleFailure() logic.
export interface IntercomFailureDetails {
  status: number | null;
  retryAfterSeconds: number | null;
  permanent: boolean;
}

export interface InboundEventSignal {
  deliveryId: string | null;
  topic: string;
  payload: unknown;
}

export interface InboxCarry {
  queue: InboundEventSignal[];
  seenDeliveryIds: string[];
}

// ---- AI ----

export interface AutoAnswerInput {
  threadId: string;
  categoryId: string;
  question: string | null;
  customerId: string;
  displayName: string;
}

export interface AiRunInput {
  // Key into the in-process live-interaction registry (interaction.id). The
  // activity edits the deferred ephemeral reply through it; after a process
  // crash the registry entry is gone and the run is lost — same behavior as
  // the legacy in-memory path (maximumAttempts: 1, deliberate).
  runKey: string;
  sub: "ask" | "cause" | "draft" | "summarize";
  threadId: string;
  userId: string;
}

// ---- Stripe / billing ----

export interface StripeEventInput {
  eventId: string;
  // The verified Stripe event object, carried verbatim (not re-fetchable).
  eventJson: string;
}

export interface RefundWorkflowInput {
  customerId: string;
  chargeId: string;
  subscriptionId: string | null;
  threadId: string | null;
}

export type RefundOutcome =
  | { outcome: "already_processed" }
  | { outcome: "refund_failed"; error: string }
  | {
      outcome: "ok";
      refundId: string;
      amount: number;
      currency: string;
      cancelFailed: boolean;
      cancelledSubscriptionId: string | null;
    };

// ---- Looper activity results ----

export interface KbTickResult {
  refreshed: boolean;
  ok: number;
  failed: number;
}

// One disputes-looper tick: Stripe→local reconciliation, evidence-due
// reminders posted, and the ratio threshold level after the check.
export interface DisputesTickResult {
  reconciled: number;
  reminders: number;
  ratioLevel: "ok" | "warn" | "critical" | "skipped";
}

export interface MoneyOutTickResult {
  scanned: number;
  created: number;
  errors: number;
  // The sweep hit its page cap and has NOT seen everything up to now — the
  // cursor deliberately does not advance on a truncated pass.
  truncated: boolean;
  skipped: boolean; // the money-out ledger is disabled in /config
}

export interface SentryFeedbackTickResult {
  listed: number;
  imported: number;
  skippedNoEmail: number;
  deduped: number;
  // Previously-anonymous submissions re-examined this tick: `replayed` were
  // imported after all, `replayExhausted` had no identity and stay skipped.
  replayed: number;
  replayExhausted: number;
  errors: number;
  capped: boolean; // per-tick import cap hit — remainder picked up next tick
  skipped: boolean; // disabled / not configured / no watermark / Intercom unconfigured
}

export interface SlaSweepResult {
  scanned: number;
  written: number;
  unchanged: number;
  errors: number;
  skipped: boolean; // SLA disabled or Intercom unconfigured
  // Forwarders detached from natively-converted forwarded emails, which this
  // sweep also heals (Intercom attaches the customer asynchronously, so the
  // webhook triggers can fire before there is anything to detach).
  forwardersDetached: number;
}

// Bot-native SLA enforcement + assignment stray sweep + customer-idle
// nag/auto-close (5-min looper — the former inactivity sweep folded in).
export interface SlaEnforceResult {
  scanned: number;
  assigned: number;
  statusWrites: number;
  tagged: number;
  untagged: number;
  notes: number; // recurring agent nag notes posted this tick
  customerNags: number; // outbound customer-idle nags
  closed: number; // conversations auto-closed after N unanswered nags
  verifies: number;
  errors: number;
  capped: boolean; // write budget exhausted — later ticks finish
  skipped: boolean; // all passes disabled or Intercom unconfigured
}

// Kept for the publishStatusReport tombstone stub (goes away with the
// tombstone workflow).
export interface ReportTickResult {
  published: boolean;
}

// ---- The full activity surface (implemented by createActivities) ----
// Workflow code proxies this via proxyActivities<CoreActivities>.

export interface CoreActivities {
  // ticket lifecycle
  loadTicketState(threadId: string): Promise<TicketSnapshot>;
  checkTicketTimers(threadId: string): Promise<TimerCheckResult>;
  pingStaffForNewTicket(threadId: string): Promise<void>;

  // status change: the whole transition (StatusService.applyStatusDirect —
  // one implementation shared with the legacy chain; the child workflow owns
  // durability + serialization)
  statusApplyDirect(input: StatusChangeInput): Promise<StatusChangeResult>;

  // intercom
  intercomEnabled(): Promise<boolean>;
  executeIntercomEvent(input: IntercomDeliveryInput): Promise<void>;
  intercomDeadLetterAudit(input: { threadId: string; type: IcEventType; attempts: number; message: string }): Promise<void>;
  processInboundEvent(input: { topic: string; payload: unknown; deferAttempts: number }): Promise<void>;
  inboundDeadLetterAudit(input: { topic: string; attempts: number; message: string }): Promise<void>;

  // loopers
  kbTick(force: boolean): Promise<KbTickResult>;
  disputesTick(force: boolean): Promise<DisputesTickResult>;
  slaSweepTick(force: boolean): Promise<SlaSweepResult>;
  slaEnforceTick(force: boolean): Promise<SlaEnforceResult>;
  sentryFeedbackTick(force: boolean): Promise<SentryFeedbackTickResult>;
  moneyOutTick(): Promise<MoneyOutTickResult>;
  snapshotTick(): Promise<void>;
  cleanupTick(): Promise<void>;
  // Tombstone stubs (agent-rip): in-flight runs at deploy time still proxy
  // these; the workflows + stubs are removed in the follow-up release.
  publishStatusReport(force: boolean): Promise<ReportTickResult>;
  scoreOneNow(threadId: string): Promise<string>;

  // AI (tombstone stubs — see above)
  runAutoAnswer(input: AutoAnswerInput): Promise<{ ok: boolean; apiLimit: boolean }>;
  runStaffAiCommand(input: AiRunInput): Promise<void>;

  // stripe / billing / vault
  handleStripeEvent(input: StripeEventInput): Promise<void>;
  executeRefundCore(input: RefundWorkflowInput): Promise<RefundOutcome>;
  runVaultUpgradeJob(): Promise<void>;
}
