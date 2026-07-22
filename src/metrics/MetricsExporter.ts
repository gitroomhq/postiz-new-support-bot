import { writePoint } from "./InfluxWriter";

// Typed, fire-and-forget domain-event exporters over writePoint. Every helper
// no-ops when the exporter is inactive and never throws — call sites stay
// one-liners that cannot break the feature they instrument.
//
// Cardinality rule: tags only for bounded sets (event names, category ids,
// status labels, a small staff team, model ids). Thread/charge/session ids are
// always fields.

// One point per AI run — interactive CLI runs, direct-API light runs, and one
// aggregated point per scoring batch. Mirrors the ai_runs Postgres row.
export interface AiRunExport {
  agentName: string;
  kind: string; // customer_qa | staff_command | ticket_scoring
  source: string; // cli | api | batch
  model: string;
  outcome: string;
  sessionId?: string | null;
  numTurns?: number | null;
  durationMs?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  toolCalls?: number;
  toolErrors?: number;
}

export function exportAiRun(run: AiRunExport): void {
  writePoint(
    "ai_runs",
    { kind: run.kind, agent: run.agentName, model: run.model, outcome: run.outcome, source: run.source },
    {
      count: 1,
      input_tokens: run.inputTokens,
      output_tokens: run.outputTokens,
      cache_read_tokens: run.cacheReadTokens,
      cache_creation_tokens: run.cacheCreationTokens,
      cost_usd: run.costUsd,
      duration_ms: run.durationMs,
      num_turns: run.numTurns,
      tool_calls: run.toolCalls ?? 0,
      tool_errors: run.toolErrors ?? 0,
      session_id: run.sessionId ?? undefined,
    }
  );
}

export type BillingEventKind =
  | "refund"
  | "discount"
  | "charge_review_created"
  | "charge_review_approved"
  | "charge_review_denied"
  | "dispute"
  | "fraud_warning"
  | "dispute_updated"
  | "dispute_won"
  | "dispute_lost"
  | "dispute_accepted"
  | "evidence_submitted"
  | "dispute_reminder"
  | "block"
  | "unblock";

export function exportBillingEvent(p: {
  event: BillingEventKind;
  amountMinor?: number | null;
  currency?: string | null;
  chargeId?: string | null;
  threadId?: string | null;
}): void {
  writePoint(
    "billing_events",
    { event: p.event, currency: (p.currency ?? "unknown").toLowerCase() },
    {
      count: 1,
      amount_minor: p.amountMinor,
      charge_id: p.chargeId ?? undefined,
      thread_id: p.threadId ?? undefined,
    }
  );
}

// One point per dispute OUTCOME (terminal transition), reason-tagged so
// Grafana can split win rate by fraudulent / subscription_canceled / etc.
// Live emissions stamp "now"; the history backfill passes the historical
// closedAt so pre-bot outcomes chart correctly. Identical points (same tags +
// timestamp) overwrite on re-runs, so the backfill is idempotent.
export function exportDisputeOutcome(p: {
  outcome: string; // won | lost | prevented | warning_closed
  reason: string;
  amountMinor: number;
  currency: string;
  submitted: boolean; // evidence was submitted before it closed
  ts?: Date;
}): void {
  writePoint(
    "dispute_outcomes",
    { outcome: p.outcome, reason: p.reason, currency: p.currency.toLowerCase() },
    { count: 1, amount_minor: p.amountMinor, submitted: p.submitted ? 1 : 0 },
    p.ts
  );
}

export function exportIntercomQueueDepth(p: { queue: "outbox" | "inbox"; pending: number; dead: number }): void {
  writePoint("intercom_queue", { queue: p.queue }, { pending: p.pending, dead: p.dead });
}

// Since-boot dead-letter counters. Temporal visibility has no cheap "dead"
// query (dead letters are terminal workflow RESULTS), so the dead-letter audit
// activities increment these and the snapshot tick exports them alongside the
// queue depths. Grafana reads deltas, so a restart reset is harmless.
const intercomDeadCounts = { outbox: 0, inbox: 0 };

export function recordIntercomDeadLetter(queue: "outbox" | "inbox"): void {
  intercomDeadCounts[queue]++;
}

export function intercomDeadLetterCount(queue: "outbox" | "inbox"): number {
  return intercomDeadCounts[queue];
}

// Inbound webhook outcome counter — "rejected" (bad HMAC) is the one to alert
// on: a rotated client secret 403s every delivery silently, and Intercom does
// not retry 4xx.
export function exportIntercomWebhook(outcome: "accepted" | "rejected" | "buffered" | "error"): void {
  writePoint("intercom_webhook", { outcome }, { count: 1 });
}

// One point per workspace inactivity sweep (native/unbridged conversations +
// tickets) — errors > 0 is the alertable field.
// One point per SLA enforcement tick (bot-native clocks + assignment +
// customer-idle nag/auto-close, the former inactivity sweep folded in) —
// errors > 0 is the alertable field; capped = the write budget ran out.
export function exportSlaEnforce(p: {
  scanned: number;
  statusWrites: number;
  breaches: number;
  recoveries: number;
  assigned: number;
  customerNags: number;
  closed: number;
  errors: number;
  capped: number;
}): void {
  writePoint(
    "sla_enforce",
    {},
    {
      scanned: p.scanned,
      status_writes: p.statusWrites,
      breaches: p.breaches,
      recoveries: p.recoveries,
      assigned: p.assigned,
      customer_nags: p.customerNags,
      closed: p.closed,
      errors: p.errors,
      capped: p.capped,
    }
  );
}

// The dispute console's blocked-charge review queue — the one ticket-adjacent
// gauge that survived the agent-rip (it feeds /charge staffing).
export function exportPendingChargeReviews(pending: number): void {
  writePoint("ticket_snapshot_totals", {}, { pending_charge_reviews: pending });
}

// Dispute-console gauges. Counts come from the 5-minute snapshot tick; the
// ratio percentages only from the (6-hourly) dispute monitor tick — computing
// them needs Stripe sweeps that would be abusive at snapshot cadence. No
// identifier values in tags (cardinality + PII).
export function exportDisputeSnapshot(p: {
  open: number;
  dueSoon: number;
  blocked: number;
  plain30dPct?: number | null;
  vamp30dPct?: number | null;
  vampMonthPct?: number | null;
}): void {
  writePoint(
    "dispute_snapshot",
    {},
    {
      open: p.open,
      due_soon: p.dueSoon,
      blocked: p.blocked,
      plain_30d_pct: p.plain30dPct ?? undefined,
      vamp_30d_pct: p.vamp30dPct ?? undefined,
      vamp_month_pct: p.vampMonthPct ?? undefined,
    }
  );
}

export function exportBotHealth(): void {
  writePoint("bot_health", {}, { up: 1 });
}

// Vault reachability gauge, written by the VaultService probe loop on every
// tick plus immediately on up/down transitions (numbers become floats in
// writePoint, keeping the bucket's fields float-typed).
export function exportVaultHealth(up: boolean): void {
  writePoint("vault_health", {}, { up: up ? 1 : 0 });
}
