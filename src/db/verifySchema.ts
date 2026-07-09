import { PrismaClient } from "../generated/prisma/client";
import * as Sentry from "@sentry/node";
import { log } from "../util/logger";

const schemaLog = log.child("schema");

// Expected columns per table (DB table name → column names), hand-maintained to
// mirror prisma/schema.prisma + src/db/ensureSchema.ts. This is the third place a
// reviewer touches when adding a Prisma field — and that is the point: a column
// listed here but MISSING from the live database means an ensureSchema mirror was
// forgotten, which would break the no-CLI deploy at runtime. The check runs after
// ensureSchema on boot and is non-fatal by default (see verifySchema).
const EXPECTED_COLUMNS: Record<string, string[]> = {
  user_sessions: ["id", "discordUserId", "accessToken", "postizUserId", "stripeCustomerId", "authenticatedAt", "updatedAt"],
  billing_actions: ["id", "discordUserId", "stripeInvoiceId", "action", "createdAt"],
  pending_charge_reviews: [
    "id", "threadId", "chargeId", "subscriptionId", "customerId", "amount", "currency", "reason", "status",
    "reviewerId", "resolvedAt", "createdAt",
  ],
  pending_auths: ["id", "state", "discordUserId", "channelId", "interactionToken", "createdAt"],
  bot_settings: [
    "id", "threadsChannelId", "supportRoleId", "githubRepo", "aiSolveEnabled", "aiCommandsEnabled", "backfillDone",
    "reportChannelId", "reportEnabled", "reportIntervalHours", "reportHour", "reportMinute", "reportTimezone",
    "reportLastRunAt", "reportLastSnapshot", "overdueThresholdDays", "maxOpenTicketsPerUser", "ticketCooldownMinutes",
    "billingAuditChannelId", "refundMaxAmount", "refundMaxAmountCurrency", "refundMaxPer24h", "refundMinMemberAgeDays",
    "allowedPriceIds", "auditLogChannelId", "intercomMode", "intercomRegion", "intercomAccessToken",
    "intercomClientSecret", "intercomAdminId", "intercomOperatorAdminId", "intercomTicketTypeMap", "intercomTeamId",
    "intercomSnoozeStatusTagId", "sentryDsn", "sentryEnvironment", "sentryTracesSampleRate", "sentryProfilesSampleRate",
    "sentryLogsEnabled", "sentryDebug", "sentrySendDefaultPii", "sentryAiRecordContent",
    "sentryReadEnabled", "sentryReadToken", "sentryOrgSlug", "sentryProjectSlug", "sentryReadRegion",
    "aiModel", "aiModelLight",
    "aiEffortAsk", "aiEffortCause", "aiMaxBudgetUsdAsk", "aiMaxBudgetUsdCause", "aiPostizPrefetchEnabled",
    "aiPreviousRunsEnabled",
    "kbRefreshEnabled", "kbRefreshIntervalHours", "kbLastRefreshAt", "refundMaxPer24hPerUser", "stripeWebhookEnabled",
    "stripeWebhookEndpointId", "stripeWebhookSecret", "publicBaseUrl",
    "influxEnabled", "influxUrl", "influxOrg", "influxBucket", "influxToken",
    "scoringEnabled", "scoringIntervalHours", "scoringModel", "scoringMaxTicketsPerBatch",
    "scoringMaxBudgetUsdPerDay", "scoringLastRunAt", "scoringBackfillPending",
    "vaultEnabled", "vaultAddr", "vaultToken", "vaultKvMount", "vaultKvBasePath",
    "vaultTransitMount", "vaultTransitKey", "vaultMigratedAt",
    "temporalEnabled", "temporalAddress", "temporalNamespace", "temporalTaskQueue",
    "temporalDeploymentName", "temporalImportDoneAt", "updatedAt",
  ],
  status_tags: [
    "id", "emoji", "label", "isInitial", "closesThread", "reminderEnabled", "reminderDays", "reminderTarget",
    "autoCloseAfter", "sortOrder", "isCustomerReplyTarget", "intercomTicketStateId",
  ],
  priority_tags: ["id", "emoji", "label", "isInitial", "sortOrder"],
  tickets: [
    "id", "threadId", "channelId", "customerId", "customerDisplayName", "categoryId", "statusTagId", "prevStatusTagId",
    "priorityTagId", "escalationTierId", "lastStatusChangeAt", "lastReminderAt", "reminderCount", "remindersPaused", "closed", "closedAt",
    "recloseAt", "question", "aiAnswer", "firstResponseAt", "csatScore", "csatComment", "csatPromptedAt", "csatRatedAt",
    "createdAt",
  ],
  ticket_notes: ["id", "ticketThreadId", "authorId", "authorName", "text", "createdAt"],
  ticket_tag_changes: [
    "id", "ticketThreadId", "kind", "fromEmoji", "fromLabel", "toEmoji", "toLabel", "actorId", "actorName", "createdAt",
  ],
  escalation_tiers: ["id", "name", "roleId", "position", "createdAt"],
  canned_responses: ["id", "name", "content", "ownerId", "createdAt"],
  intercom_links: [
    "id", "ticketThreadId", "contactId", "contactExternalId", "conversationId", "ticketId", "agentWarnedAt",
    "lastSyncedStateId", "lastSyncedOpen", "lastTagsJson", "createdAt",
  ],
  intercom_outbox: [
    "id", "seq", "ticketThreadId", "type", "payload", "status", "attempts", "nextAttemptAt", "lastError", "createdAt",
  ],
  intercom_echo_parts: ["id", "kind", "partId", "ticketThreadId", "createdAt"],
  intercom_inbox: [
    "id", "seq", "deliveryId", "topic", "payload", "status", "attempts", "deferAttempts", "nextAttemptAt", "lastError",
    "receivedAt",
  ],
  intercom_pending_posts: ["id", "ticketThreadId", "kind", "bodyHash", "createdAt"],
  stripe_webhook_events: ["id", "type", "createdAt"],
  ai_runs: [
    "id", "agentName", "kind", "source", "model", "outcome", "sessionId", "batchId", "numTurns", "durationMs",
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd", "toolCalls", "toolErrors",
    "createdAt",
  ],
  ticket_ai_runs: [
    "id", "ticketThreadId", "subcommand", "input", "result", "invokerId", "invokerName", "model", "createdAt",
  ],
  ticket_scores: [
    "id", "ticketThreadId", "status", "attempts", "batchId", "model", "cxScore", "sentimentStart", "sentimentEnd",
    "agentTone", "agentClarity", "agentCorrectness", "resolution", "fcr", "escalationNeeded", "topic", "rootCause",
    "summary", "staffScores", "staffNames", "inputTokens", "outputTokens", "costUsd", "error", "scoredAt", "createdAt",
  ],
  scoring_batches: [
    "id", "anthropicBatchId", "status", "purpose", "model", "requestCount", "succeededCount", "erroredCount",
    "expiredCount", "costUsd", "submittedAt", "endedAt",
  ],
};

export interface VerifySchemaOptions {
  // strict throws on drift (dev/CI: prod can't set the env var, so it can never
  // brick a deploy). Default (non-strict) only warns + reports to Sentry.
  strict?: boolean;
}

// Compares the live database columns against EXPECTED_COLUMNS and surfaces any
// column the code expects but the DB lacks (the dangerous "forgot to mirror in
// ensureSchema" drift). Read-only; safe to run on every boot.
export async function verifySchema(prisma: PrismaClient, opts: VerifySchemaOptions = {}): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()"
  );
  const actual = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
    actual.get(r.table_name)!.add(r.column_name);
  }

  const problems: string[] = [];
  for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
    const present = actual.get(table);
    if (!present) {
      problems.push(`table "${table}" is missing`);
      continue;
    }
    const missing = cols.filter((c) => !present.has(c));
    if (missing.length) problems.push(`"${table}" missing: ${missing.join(", ")}`);
  }

  if (problems.length === 0) {
    schemaLog.info("schema.verified", { "schema.tables_checked": Object.keys(EXPECTED_COLUMNS).length });
    return;
  }

  const summary = problems.join("; ");
  schemaLog.warn("schema.drift.detected", { "schema.problems": summary });
  Sentry.captureMessage(`schema drift detected: ${summary}`, "warning");
  if (opts.strict) {
    throw new Error(`Schema drift detected (strict mode): ${summary}`);
  }
}
