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
export const aiRunWorkflowId = (userId: string): string => `ai-run-${userId}`;
export const scoreOneWorkflowId = (threadId: string): string => `score-one-${threadId}`;
export const stripeEventWorkflowId = (eventId: string): string => `stripe-evt-${eventId}`;
export const scoringBatchWorkflowId = (batchId: string): string => `scoring-batch-${batchId}`;
export const refundWorkflowId = (chargeId: string): string => `refund-${chargeId}`;

export const SINGLETONS = {
  kbRefresh: "kb-refresh",
  scoringLoop: "scoring-loop",
  metricsSnapshot: "metrics-snapshot",
  cleanupLoop: "cleanup-loop",
} as const;

export const VAULT_UPGRADE_WORKFLOW_ID = "vault-upgrade";
export const STATUS_REPORT_SCHEDULE_ID = "status-report";

// ---- Looper generations ----
// Bump a looper's generation IN THE SAME COMMIT as any history-incompatible
// change to its workflow body (changed activity order/types, new children,
// different timers). ensureBaseline() terminates a running singleton whose
// memo generation differs and starts a fresh run stamped with the new one —
// that IS the upgrade path for loopers, because every deploy replays running
// workflows on the new bundle (AUTO_UPGRADE, single in-process worker) and a
// replay mismatch wedges the workflow with nondeterminism task failures.
// Safe: all four loopers are stateless between iterations (state re-derived
// from Postgres each tick; in-flight scoring batches are re-adopted via
// scoringGetState). Stateful long-lived workflows (ticketWorkflow,
// intercomInboxWorkflow) must use patched() instead — see README.
export const LOOPER_GEN_MEMO_KEY = "looperGen";
export const LOOPER_GENERATIONS: Record<string, number> = {
  [SINGLETONS.kbRefresh]: 1,
  [SINGLETONS.scoringLoop]: 2, // gen 2: scoringTick → getState/submit + per-batch children
  [SINGLETONS.metricsSnapshot]: 1,
  [SINGLETONS.cleanupLoop]: 1,
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
export const SIG_REMINDERS_PAUSED = "remindersPaused";
export const SIG_REQUEST_STATUS_CHANGE = "requestStatusChange";
export const SIG_NOOP = "noop";
export const SIG_INBOUND_EVENT = "inboundEvent";
export const SIG_KB_REFRESH_NOW = "kbRefreshNow";
export const SIG_SCORING_RUN_NOW = "scoringRunNow";
export const UPD_APPLY_STATUS = "applyStatus";
export const UPD_APPLY_PRIORITY = "applyPriority";
export const QRY_TICKET_STATE = "getState";

// ---- Intercom outbox events carried in ticket workflow state ----

export type IcEventType = "ensure" | "message" | "note" | "status" | "priority" | "csat";

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
}

export interface PriorityChangeRequest {
  priorityTagId: string;
  actorName: string;
  actorId?: string | null;
  actorIconUrl?: string | null;
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

// ---- Scoring (per-batch child workflows for full lifecycle visibility) ----

export interface ScoringState {
  enabled: boolean;
  // SUBMITTED Anthropic batch ids (restart/CAN adoption — each gets a child).
  pendingBatchIds: string[];
  due: boolean;
  backfill: boolean;
}

export interface ScoringSubmitOutcome {
  batchId: string | null;
  submitted: number;
  skipped: number;
  drained: boolean;
  budgetBlocked: boolean;
}

export interface ScoringBatchPoll {
  status: "running" | "processed" | "failed";
  processingStatus: string | null;
}

// scoringBatchWorkflow input; polls/deadlineAtMs are the Continue-As-New
// carry so a long-lived batch keeps its poll count and 26h deadline.
export interface ScoringBatchInput {
  batchId: string;
  polls?: number;
  deadlineAtMs?: number;
}

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
  applyPriorityStep(input: PriorityChangeRequest & { threadId: string }): Promise<void>;

  // intercom
  intercomEnabled(): Promise<boolean>;
  executeIntercomEvent(input: IntercomDeliveryInput): Promise<void>;
  intercomDeadLetterAudit(input: { threadId: string; type: IcEventType; attempts: number; message: string }): Promise<void>;
  processInboundEvent(input: { topic: string; payload: unknown; deferAttempts: number }): Promise<void>;
  inboundDeadLetterAudit(input: { topic: string; attempts: number; message: string }): Promise<void>;

  // loopers
  kbTick(force: boolean): Promise<KbTickResult>;
  scoringGetState(): Promise<ScoringState>;
  scoringSubmit(purpose: "interval" | "backfill"): Promise<ScoringSubmitOutcome>;
  scoringPollBatch(batchId: string): Promise<ScoringBatchPoll>;
  // Deadline backstop: fail a batch that outlived its processing window so
  // its tickets become retryable (no-op if already finalized).
  scoringExpireBatch(batchId: string): Promise<void>;
  snapshotTick(): Promise<void>;
  cleanupTick(): Promise<void>;
  publishStatusReport(force: boolean): Promise<ReportTickResult>;
  scoreOneNow(threadId: string): Promise<string>;

  // AI
  runAutoAnswer(input: AutoAnswerInput): Promise<{ ok: boolean; apiLimit: boolean }>;
  runStaffAiCommand(input: AiRunInput): Promise<void>;

  // stripe / billing / vault
  handleStripeEvent(input: StripeEventInput): Promise<void>;
  executeRefundCore(input: RefundWorkflowInput): Promise<RefundOutcome>;
  runVaultUpgradeJob(): Promise<void>;
}
