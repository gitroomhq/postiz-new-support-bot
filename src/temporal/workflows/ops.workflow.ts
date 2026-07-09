import { proxyActivities } from "@temporalio/workflow";
import type {
  CoreActivities,
  ImportSummary,
  ImportTicketSeed,
  RefundOutcome,
  RefundWorkflowInput,
  ReportTickResult,
  StripeEventInput,
} from "../types";

// Wall-clock status report — fired by the "status-report" Temporal Schedule
// (or the /config "Run Report Now" button with force=true). The activity keeps
// the legacy once-per-day guard against reportLastRunAt, so an overlapping
// schedule fire or a manual trigger can never double-post.
const report = proxyActivities<CoreActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

export async function publishStatusReportWorkflow(input?: { force?: boolean }): Promise<ReportTickResult> {
  return await report.publishStatusReport(input?.force ?? false);
}

// One workflow per verified Stripe webhook event; workflowId stripe-evt-{id}
// dedups redeliveries at the server (the stripe_webhook_events table keeps its
// own claim for the legacy path during the kill-switch release).
const stripe = proxyActivities<CoreActivities>({
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumAttempts: 5 },
});

export async function stripeEventWorkflow(input: StripeEventInput): Promise<void> {
  await stripe.handleStripeEvent(input);
}

// Money movement for the self-service refund confirm and /charge approve.
// Triple idempotency: workflowId refund-{chargeId} (REJECT_DUPLICATE), the
// BillingAction unique-index lock (first thing the activity claims), and
// Stripe idempotency keys. Single attempt — a mid-flight failure surfaces to
// staff exactly like the legacy path did.
const billing = proxyActivities<CoreActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export async function refundWorkflow(input: RefundWorkflowInput): Promise<RefundOutcome> {
  return await billing.executeRefundCore(input);
}

// Vault recovery hook / boot straggler-lift: the idempotent upgrade job
// (enc:v1 rows → Vault, session-token Transit conversion) + Influx rebuild.
const vault = proxyActivities<CoreActivities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 2 },
});

export async function vaultUpgradeWorkflow(): Promise<void> {
  await vault.runVaultUpgradeJob();
}

// One-time legacy-state import, run when the temporalEnabled toggle flips ON
// (re-runnable from the /config panel — every step is idempotent).
const imp = proxyActivities<CoreActivities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

const IMPORT_BATCH = 50;

export async function migrationImportWorkflow(): Promise<ImportSummary> {
  // 1. Every open ticket + closed tickets that still owe work gets a
  //    ticketWorkflow (signal-with-start — already-running ones are no-ops).
  const seeds: ImportTicketSeed[] = await imp.importListTickets();
  let started = 0;
  for (let i = 0; i < seeds.length; i += IMPORT_BATCH) {
    started += await imp.importStartTicketWorkflows(seeds.slice(i, i + IMPORT_BATCH));
  }

  // 2. Replay PENDING intercom_outbox rows as intercomEnqueue signals in seq
  //    order per ticket, then mark them IMPORTED (re-runs skip those).
  const outbox = await imp.importOutboxRows();

  // 3. Same for intercom_inbox → per-conversation inbox workflows.
  const inbox = await imp.importInboxRows();

  // 4. Singletons + the status-report Schedule (idempotent upserts). Any
  //    in-flight ScoringBatch is adopted automatically by the scoring loop's
  //    first poll (batch ids live in Postgres).
  await imp.importEnsureBaseline();

  const summary: ImportSummary = { ticketWorkflowsStarted: started, outboxImported: outbox, inboxImported: inbox };
  await imp.importWriteAudit(summary);
  return summary;
}
