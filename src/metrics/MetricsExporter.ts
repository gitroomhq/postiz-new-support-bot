import { PrismaClient, Ticket, TicketTagChange } from "../generated/prisma/client";
import { influxActive, writePoint, flushInflux } from "./InfluxWriter";

// Typed, fire-and-forget domain-event exporters over writePoint. Every helper
// no-ops when the exporter is inactive and never throws — call sites stay
// one-liners that cannot break the feature they instrument.
//
// Cardinality rule: tags only for bounded sets (event names, category ids,
// status labels, a small staff team, model ids). Thread/charge/session ids are
// always fields.

export function exportTicketCreated(p: { threadId: string; category: string | null; ts?: Date }): void {
  writePoint(
    "ticket_events",
    { event: "created", category: p.category ?? "unknown" },
    { count: 1, thread_id: p.threadId },
    p.ts
  );
}

export function exportStatusChange(p: {
  threadId: string;
  category: string | null;
  statusTo: string;
  reopened: boolean;
  ts?: Date;
}): void {
  writePoint(
    "ticket_events",
    { event: p.reopened ? "reopened" : "status_change", category: p.category ?? "unknown", status_to: p.statusTo },
    { count: 1, thread_id: p.threadId },
    p.ts
  );
}

export function exportTicketClosed(p: {
  threadId: string;
  category: string | null;
  resolutionSeconds: number | null;
  ts?: Date;
}): void {
  writePoint(
    "ticket_events",
    { event: "closed", category: p.category ?? "unknown" },
    { count: 1, thread_id: p.threadId, resolution_seconds: p.resolutionSeconds },
    p.ts
  );
}

export function exportFirstResponse(p: {
  threadId: string;
  category: string | null;
  seconds: number;
  ts?: Date;
}): void {
  writePoint(
    "ticket_events",
    { event: "first_response", category: p.category ?? "unknown" },
    { count: 1, thread_id: p.threadId, first_response_seconds: p.seconds },
    p.ts
  );
}

export function exportCsat(p: { threadId: string; category: string | null; score: number; ts?: Date }): void {
  writePoint(
    "ticket_events",
    { event: "csat", category: p.category ?? "unknown" },
    { count: 1, thread_id: p.threadId, csat_score: p.score },
    p.ts
  );
}

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

// Sentiment enum → ordinal for averaging in Grafana.
const SENTIMENT_ORDINAL: Record<string, number> = {
  very_negative: -2,
  negative: -1,
  neutral: 0,
  positive: 1,
  very_positive: 2,
};

export function exportTicketScore(p: {
  threadId: string;
  category: string | null;
  cxScore: number;
  sentimentStart: string;
  sentimentEnd: string;
  agentTone: number;
  agentClarity: number;
  agentCorrectness: number;
  resolution: string;
  fcr: boolean;
  escalationNeeded: boolean;
  topic: string;
  staff: Array<{ name: string; tone: number; clarity: number; correctness: number }>;
  // Timestamped at the ticket's closedAt so backfilled scores land correctly.
  ts?: Date;
}): void {
  writePoint(
    "ai_scores",
    {
      category: p.category ?? "unknown",
      resolution: p.resolution,
      topic: p.topic,
      fcr: String(p.fcr),
      escalation: String(p.escalationNeeded),
    },
    {
      count: 1,
      thread_id: p.threadId,
      cx_score: p.cxScore,
      sentiment_start: SENTIMENT_ORDINAL[p.sentimentStart] ?? 0,
      sentiment_end: SENTIMENT_ORDINAL[p.sentimentEnd] ?? 0,
      agent_tone: p.agentTone,
      agent_clarity: p.agentClarity,
      agent_correctness: p.agentCorrectness,
    },
    p.ts
  );
  for (const s of p.staff) {
    writePoint(
      "ai_staff_scores",
      { staff: s.name },
      { count: 1, thread_id: p.threadId, tone: s.tone, clarity: s.clarity, correctness: s.correctness },
      p.ts
    );
  }
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

export function exportSnapshotGauge(dim: "status" | "category", value: string, openCount: number): void {
  writePoint("ticket_snapshot", { dim, value }, { open_count: openCount });
}

export function exportSnapshotTotals(p: {
  open: number;
  overdue: number;
  awaitingFirstResponse: number;
  pendingChargeReviews: number;
}): void {
  writePoint(
    "ticket_snapshot_totals",
    {},
    {
      open: p.open,
      overdue: p.overdue,
      awaiting_first_response: p.awaitingFirstResponse,
      pending_charge_reviews: p.pendingChargeReviews,
    }
  );
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

// One-time export of all historical tickets from Postgres, emitting points at
// their HISTORICAL timestamps (createdAt/closedAt/firstResponseAt/csatRatedAt)
// plus the status-change history from ticket_tag_changes. Triggered from
// /config → Analytics → "Backfill history".
export async function backfillTicketHistory(
  prisma: PrismaClient
): Promise<{ tickets: number; points: number }> {
  if (!influxActive()) throw new Error("Influx exporter is not active.");
  const PAGE = 500;
  let cursor: string | null = null;
  let tickets = 0;
  let points = 0;

  for (;;) {
    const page: Ticket[] = await prisma.ticket.findMany({
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const t of page) {
      tickets++;
      exportTicketCreated({ threadId: t.threadId, category: t.categoryId, ts: t.createdAt });
      points++;
      if (t.firstResponseAt) {
        exportFirstResponse({
          threadId: t.threadId,
          category: t.categoryId,
          seconds: (t.firstResponseAt.getTime() - t.createdAt.getTime()) / 1000,
          ts: t.firstResponseAt,
        });
        points++;
      }
      if (t.closed && t.closedAt) {
        exportTicketClosed({
          threadId: t.threadId,
          category: t.categoryId,
          resolutionSeconds: (t.closedAt.getTime() - t.createdAt.getTime()) / 1000,
          ts: t.closedAt,
        });
        points++;
      }
      if (t.csatScore != null && t.csatRatedAt) {
        exportCsat({ threadId: t.threadId, category: t.categoryId, score: t.csatScore, ts: t.csatRatedAt });
        points++;
      }
    }
  }

  // Status-change history (emoji+label snapshots). Category isn't stored on the
  // change rows; "unknown" keeps cardinality flat rather than joining per row.
  let changeCursor: string | null = null;
  for (;;) {
    const page: TicketTagChange[] = await prisma.ticketTagChange.findMany({
      where: { kind: "STATUS" },
      take: PAGE,
      ...(changeCursor ? { skip: 1, cursor: { id: changeCursor } } : {}),
      orderBy: { id: "asc" },
    });
    if (page.length === 0) break;
    changeCursor = page[page.length - 1].id;
    for (const c of page) {
      exportStatusChange({
        threadId: c.ticketThreadId,
        category: null,
        statusTo: c.toLabel,
        reopened: false,
        ts: c.createdAt,
      });
      points++;
    }
  }

  await flushInflux();
  return { tickets, points };
}
