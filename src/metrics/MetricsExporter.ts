import { writePoint } from "./InfluxWriter";
import { segmentTags, type MoneySegments } from "../bot/billing/segments";

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
  | "credit_note"
  | "write_off"
  | "credit_grant"
  | "balance_credit"
  | "charge_review_created"
  // ATTRIBUTION ONLY — charge_review_approved fires for a refund that ALSO
  // emits "refund" from the refund core. Never sum both: for money totals use
  // the money_out measurement, which is deduplicated at the ledger.
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

// Which surface a staff member acted from. Bounded set, so it is safe as a tag.
export type BillingEventSurface = "discord" | "panel" | "dashboard";

// Staff-action attribution: WHO did WHAT from WHERE. This measurement answers
// "what is our team doing"; it is deliberately NOT the money-total source (see
// exportMoneyOut) because several of its events describe the same money.
export function exportBillingEvent(p: {
  event: BillingEventKind;
  amountMinor?: number | null;
  currency?: string | null;
  chargeId?: string | null;
  threadId?: string | null;
  surface?: BillingEventSurface;
  // Refunds only: true when a specific amount was refunded rather than the
  // full remainder. A field, not a tag — it is only meaningful for one event.
  partial?: boolean;
  reason?: string | null;
}): void {
  writePoint(
    "billing_events",
    {
      event: p.event,
      currency: (p.currency ?? "unknown").toLowerCase(),
      ...(p.surface ? { surface: p.surface } : {}),
    },
    {
      count: 1,
      amount_minor: p.amountMinor,
      charge_id: p.chargeId ?? undefined,
      thread_id: p.threadId ?? undefined,
      partial: p.partial == null ? undefined : p.partial ? 1 : 0,
      reason: p.reason ?? undefined,
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
  // Who disputed us, described without identifying anyone: card brand and
  // funding type, issuing country, the plan they were on, the network's own
  // reason code, and how long they had been a customer. See segments.ts.
  segments?: MoneySegments | null;
  ts?: Date;
}): void {
  writePoint(
    "dispute_outcomes",
    {
      outcome: p.outcome,
      reason: p.reason,
      currency: p.currency.toLowerCase(),
      ...segmentTags(p.segments),
    },
    { count: 1, amount_minor: p.amountMinor, submitted: p.submitted ? 1 : 0 },
    p.ts
  );
}

// One point per money-out ledger row. This is the measurement to SUM when the
// question is "how much money left the account" — billing_events answers the
// different question of "what did our staff do", and its refund/
// charge_review_approved events overlap by design.
//
// amount_minor is signed (positive = out, negative = returned), so a window sum
// is already net of reversals. Live emissions stamp "now"; the sweep and the
// all-time backfill pass the real occurrence time, so identical points (same
// tags + timestamp) overwrite instead of double-counting on a re-run.
export function exportMoneyOut(p: {
  bucket: string; // CASH | FEES | CONCESSION
  category: string;
  currency: string;
  source: string; // webhook | sweep | backfill | action
  amountMinor: number;
  feeMinor?: number;
  netMinor?: number;
  // Descriptive axes: which plan, which card, which country, why, how old the
  // charge was, how long the customer had been paying. Always ALL of them —
  // segmentTags fills what the caller did not know with "unknown", because a
  // tag present on some points and missing on others splits a Grafana group-by
  // into two disjoint answers to one question. Never any PII: see segments.ts.
  segments?: MoneySegments | null;
  ts?: Date;
}): void {
  writePoint(
    "money_out",
    {
      bucket: p.bucket,
      category: p.category,
      currency: p.currency.toLowerCase(),
      source: p.source,
      ...segmentTags(p.segments),
    },
    {
      count: 1,
      amount_minor: p.amountMinor,
      fee_minor: p.feeMinor ?? 0,
      net_minor: p.netMinor ?? p.amountMinor,
    },
    p.ts
  );
}

// One point per subscription lifecycle movement: a signup, a plan change, a
// scheduled or completed cancellation, a trial converting, a payment starting
// or stopping to fail.
//
// This is the churn measurement, and it is NOT a money_out measurement: a
// cancellation moves no money on the day it happens, it removes future revenue.
// Mixing the two would double-count a refund-and-cancel as two losses.
//
// mrr_delta_minor is SIGNED and normalised to a month (a yearly plan counts a
// twelfth per month), so a window sum is net revenue movement: signups and
// upgrades positive, downgrades and churn negative. mrr_at_risk_minor is the
// separate "scheduled to leave but has not left yet" number, which must never
// be added to the delta or a cancellation counts twice.
export type SubscriptionEventKind =
  | "created"
  | "trial_started"
  | "trial_converted"
  | "upgraded"
  | "downgraded"
  | "cancel_scheduled"
  | "cancel_reverted"
  | "canceled"
  | "paused"
  | "resumed"
  | "payment_failing"
  | "payment_recovered";

export function exportSubscriptionEvent(p: {
  event: SubscriptionEventKind;
  planTier: string;
  planPeriod: string;
  // Plan change only: where it moved from. "none" on everything else, so the
  // tag key stays present on every point in the measurement.
  fromTier?: string | null;
  fromPeriod?: string | null;
  currency: string;
  // voluntary | involuntary | unknown — a dunning failure and a decision to
  // leave are different problems and must never share a number.
  churnType?: string | null;
  // Stripe's own bounded enums. The customer's free-text comment is a FIELD
  // below, never a tag.
  cancelReason?: string | null;
  cancelFeedback?: string | null;
  cardCountry?: string | null;
  mrrDeltaMinor?: number | null;
  mrrAtRiskMinor?: number | null;
  // Scrubbed and truncated by segments.scrubFreeText. Free text written by a
  // customer, so it is stored only as a field and only after redaction.
  comment?: string | null;
  ts?: Date;
}): void {
  writePoint(
    "subscription_events",
    {
      event: p.event,
      plan_tier: p.planTier,
      plan_period: p.planPeriod,
      from_tier: p.fromTier || "none",
      from_period: p.fromPeriod || "none",
      currency: p.currency.toLowerCase(),
      churn_type: p.churnType || "unknown",
      cancel_reason: p.cancelReason || "none",
      cancel_feedback: p.cancelFeedback || "none",
      card_country: p.cardCountry || "unknown",
    },
    {
      count: 1,
      mrr_delta_minor: p.mrrDeltaMinor ?? 0,
      mrr_at_risk_minor: p.mrrAtRiskMinor ?? 0,
      has_comment: p.comment ? 1 : 0,
      comment: p.comment ?? undefined,
    },
    p.ts
  );
}

// Gauge of the installed base, one point per tier/period on every snapshot
// tick. Churn counts are meaningless without it: ten cancellations out of
// twenty customers and ten out of two thousand are not the same event.
export function exportPlanMix(p: {
  planTier: string;
  planPeriod: string;
  subscriptions: number;
  mrrMinor: number;
}): void {
  writePoint(
    "plan_mix",
    { plan_tier: p.planTier, plan_period: p.planPeriod },
    { subscriptions: p.subscriptions, mrr_minor: p.mrrMinor }
  );
}

// Gauge from the money-out reconcile tick: how far behind the ledger mirror is
// and whether the last sweep errored. Lag climbing is the alertable signal — it
// means Stripe outflows are happening that the mirror has not seen.
// Written on EVERY tick, including one that did nothing because the ledger is
// switched off. That is deliberate: if this measurement is silent, the tick
// itself is not running (looper down, Temporal off), which is a different
// problem from "the ledger is disabled" and needs a different fix.
export function exportMoneyOutSweep(p: {
  scanned: number;
  created: number;
  errors: number;
  lagSeconds: number;
  skipped: boolean;
}): void {
  writePoint(
    "money_out_sweep",
    {},
    {
      scanned: p.scanned,
      created: p.created,
      errors: p.errors,
      lag_seconds: p.lagSeconds,
      skipped: p.skipped ? 1 : 0,
      alive: 1,
    }
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
  // Queue depth of the dispute auto-resolve engine: everything it still owes an
  // outcome. Written only by the 5-minute snapshot tick, never by the dispute
  // looper — one gauge, one writer, or the series sawtooths between two
  // cadences and nobody can tell which reading is current.
  autoResolvePending?: number | null;
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
      auto_resolve_pending: p.autoResolvePending ?? undefined,
    }
  );
}

// ---- dispute auto-resolve engine ----

// One point per decision the auto-resolve engine makes: a refund it proposed,
// executed, had vetoed by staff, or refused to make.
//
// `reason` is a union of TWO bounded vocabularies keyed by `stage`: a Stripe
// dispute reason at the inquiry stage, and an early-fraud-warning fraud_type at
// the EFW stage (an EFW has no dispute behind it yet, so it has no dispute
// reason). Both are bounded, so cardinality is fine, but nothing reading this
// measurement may assume the value is a dispute reason.
//
// `amountMinor` is in the CHARGE's own currency and is never converted. Any USD
// conversion the engine does is a threshold comparison only: a converted figure
// reaching Influx would let someone sum money that was never in one currency.
export function exportDisputeAutoResolve(p: {
  stage: "inquiry" | "efw";
  outcome: "proposed" | "executed" | "vetoed" | "blocked" | "failed";
  reason: string;
  currency: string;
  // Which guardrail refused the action. Defaulted here rather than at the call
  // site, and ALWAYS emitted: a tag that is present on blocked points and
  // absent on executed ones makes those two different series, and a group-by on
  // guardrail would silently drop every executed point.
  guardrail?: string | null;
  amountMinor?: number | null;
  // FIELD, not a tag: an admin pressing Execute rather than the veto window
  // expiring. A tag here would split every existing series.
  humanTriggered?: boolean;
}): void {
  writePoint(
    "dispute_auto_resolve",
    {
      stage: p.stage,
      outcome: p.outcome,
      reason: p.reason || "unknown",
      currency: p.currency.toLowerCase(),
      guardrail: p.guardrail || "none",
    },
    {
      count: 1,
      amount_minor: p.amountMinor ?? undefined,
      human_triggered: p.humanTriggered == null ? undefined : p.humanTriggered ? 1 : 0,
    }
  );
}

// One point per evidence pack assembled for a dispute response: how much of the
// recommended evidence was actually filled, and how much of it came from a
// template rather than from someone typing.
export function exportDisputeEvidencePack(p: {
  reason: string;
  source: "template" | "manual" | "mixed";
  fieldsFilled: number;
  fieldsRecommended: number;
  filesAttached: number;
  autoSubmitted: boolean;
  // Everything below is OPTIONAL and describes the strength of the package
  // rather than its size. All are FIELDS, never tags: adding a tag to this
  // measurement would split every existing series and silently break the
  // panels already querying it.
  score?: number;
  // How many of the external fact sources actually answered for this dispute.
  sourcesUsed?: number;
  sourcesPossible?: number;
  // The usage evidence, which is the strongest thing a package can carry: real
  // posts published after the disputed charge, with clickable public URLs.
  postsAfterCharge?: number;
  postUrls?: number;
  channelsConnected?: number;
  // Payment-identity evidence. A 3-D Secure authentication has already shifted
  // liability to the issuer, so a won/lost split on this field is the clearest
  // measure of whether the evidence work is what is winning cases.
  threeDSecure?: boolean;
  cvcMatched?: boolean;
  sameCardPriorCharges?: number;
}): void {
  writePoint(
    "dispute_evidence_pack",
    { reason: p.reason || "unknown", source: p.source },
    {
      count: 1,
      fields_filled: p.fieldsFilled,
      fields_recommended: p.fieldsRecommended,
      files_attached: p.filesAttached,
      auto_submitted: p.autoSubmitted ? 1 : 0,
      score: p.score ?? undefined,
      sources_used: p.sourcesUsed ?? undefined,
      sources_possible: p.sourcesPossible ?? undefined,
      posts_after_charge: p.postsAfterCharge ?? undefined,
      post_urls: p.postUrls ?? undefined,
      channels_connected: p.channelsConnected ?? undefined,
      three_d_secure: p.threeDSecure == null ? undefined : p.threeDSecure ? 1 : 0,
      cvc_matched: p.cvcMatched == null ? undefined : p.cvcMatched ? 1 : 0,
      same_card_prior_charges: p.sameCardPriorCharges ?? undefined,
    }
  );
}

// One point per BUILD of an evidence package. A dispute can be rebuilt many
// times (the webhook, the looper's enrich pass, a human pressing Build), so
// this is deliberately NOT dispute_evidence_pack, which stays exactly one
// point per dispute because its consumers count it as a dispute count.
//
// This is the measurement for "how strong are the packages we are producing",
// answered continuously rather than once at the end.
export function exportDisputePackBuild(p: {
  reason: string;
  score: number;
  fieldsFilled: number;
  fieldsOmitted: number;
  sourcesUsed: number;
  sourcesPossible: number;
  postsAfterCharge?: number;
  postUrls?: number;
  channelsConnected?: number;
  threeDSecure?: boolean;
  cvcMatched?: boolean;
  sameCardPriorCharges?: number;
}): void {
  writePoint(
    "dispute_pack_build",
    { reason: p.reason || "unknown" },
    {
      count: 1,
      score: p.score,
      fields_filled: p.fieldsFilled,
      fields_omitted: p.fieldsOmitted,
      sources_used: p.sourcesUsed,
      sources_possible: p.sourcesPossible,
      posts_after_charge: p.postsAfterCharge ?? undefined,
      post_urls: p.postUrls ?? undefined,
      channels_connected: p.channelsConnected ?? undefined,
      three_d_secure: p.threeDSecure == null ? undefined : p.threeDSecure ? 1 : 0,
      cvc_matched: p.cvcMatched == null ? undefined : p.cvcMatched ? 1 : 0,
      same_card_prior_charges: p.sameCardPriorCharges ?? undefined,
    }
  );
}

// One point per FACT SOURCE per assembled package. Separate from the pack
// measurement because the question is different: not "how good was this
// package" but "which of our feeds is silent", which is what actually explains
// a run of weak packages. A source that stops answering shows up here as a
// mean(answered) falling off a cliff, long before win rate moves.
export function exportDisputeEvidenceSource(p: { source: string; answered: boolean; reason: string }): void {
  writePoint(
    "dispute_evidence_source",
    { source: p.source, reason: p.reason || "unknown" },
    { count: 1, answered: p.answered ? 1 : 0 }
  );
}

// The two cutover phases, as a gauge, so every other dispute panel can be read
// against what was actually switched on at the time. Without this, a change in
// win rate or in the ratio is uninterpretable: nobody remembers which week
// evidence went to auto.
//
// Encoded as the phase ORDER (none 0, manual 1, manualplus 2, auto 3) so it
// charts as a step line rather than as unplottable strings.
export function exportDisputeModes(p: { evidencePhase: number; resolvePhase: number }): void {
  writePoint("dispute_modes", {}, { evidence_phase: p.evidencePhase, resolve_phase: p.resolvePhase });
}

// One point per recorded dispute-history entry. The events table is the
// authoritative record; this is the aggregate view of it, so "how often does
// auto-submit refuse at the deadline" is a Grafana query rather than a SQL one.
export function exportDisputeEvent(p: { kind: string; automated: boolean }): void {
  writePoint("dispute_event", { kind: p.kind }, { count: 1, automated: p.automated ? 1 : 0 });
}

// Response timing for the deadline-risk view: how long we took to submit, and
// how much runway was left when we did. A shrinking hoursBeforeDeadline is the
// leading indicator of a missed response, which is an automatic loss.
export function exportDisputeResponse(p: {
  reason: string;
  currency: string;
  hoursToSubmit: number;
  hoursBeforeDeadline: number;
}): void {
  writePoint(
    "dispute_response",
    { reason: p.reason || "unknown", currency: p.currency.toLowerCase() },
    { count: 1, hours_to_submit: p.hoursToSubmit, hours_before_deadline: p.hoursBeforeDeadline }
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
