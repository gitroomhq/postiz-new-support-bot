import { proxyActivities } from "@temporalio/workflow";
import type {
  CoreActivities,
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
// dedups redeliveries at the server (the stripe_webhook_events table stays as
// a second dedup layer inside handleStripeEvent).
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
