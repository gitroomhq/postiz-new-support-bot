import { PrismaClient } from "../generated/prisma/client";

// The project syncs its schema with `prisma db push` rather than migrations.
// Since the deploy environment can't run the CLI, the app creates any missing
// tables itself on startup. Every statement is idempotent, so this is a safe
// no-op once the tables exist. Keep in sync with prisma/schema.prisma.
const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS "user_sessions" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "postizUserId" TEXT,
    "stripeCustomerId" TEXT,
    "authenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "billing_actions" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "stripeInvoiceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_actions_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "pending_auths" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "interactionToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pending_auths_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "bot_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "threadsChannelId" TEXT,
    "supportRoleId" TEXT,
    "githubRepo" TEXT,
    "aiSolveEnabled" BOOLEAN NOT NULL DEFAULT true,
    "backfillDone" BOOLEAN NOT NULL DEFAULT false,
    "reportChannelId" TEXT,
    "reportEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reportIntervalHours" INTEGER NOT NULL DEFAULT 24,
    "reportHour" INTEGER,
    "reportMinute" INTEGER,
    "reportTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "reportLastRunAt" TIMESTAMP(3),
    "reportLastSnapshot" JSONB,
    "overdueThresholdDays" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bot_settings_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "status_tags" (
    "id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isInitial" BOOLEAN NOT NULL DEFAULT false,
    "closesThread" BOOLEAN NOT NULL DEFAULT false,
    "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reminderDays" INTEGER NOT NULL DEFAULT 3,
    "reminderTarget" TEXT NOT NULL DEFAULT 'SUPPORT',
    "autoCloseAfter" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isCustomerReplyTarget" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "status_tags_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "tickets" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerDisplayName" TEXT,
    "categoryId" TEXT,
    "statusTagId" TEXT,
    "lastStatusChangeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReminderAt" TIMESTAMP(3),
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_discordUserId_key" ON "user_sessions"("discordUserId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "billing_actions_stripeInvoiceId_key" ON "billing_actions"("stripeInvoiceId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "pending_auths_state_key" ON "pending_auths"("state")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "status_tags_emoji_key" ON "status_tags"("emoji")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "tickets_threadId_key" ON "tickets"("threadId")`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_statusTagId_fkey') THEN
      ALTER TABLE "tickets" ADD CONSTRAINT "tickets_statusTagId_fkey"
        FOREIGN KEY ("statusTagId") REFERENCES "status_tags"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END
  $$`,
  `CREATE TABLE IF NOT EXISTS "ticket_notes" (
    "id" TEXT NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_notes_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "ticket_notes_ticketThreadId_idx" ON "ticket_notes"("ticketThreadId")`,
  `CREATE TABLE IF NOT EXISTS "canned_responses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
  )`,
  // Columns added after the tables already existed in production — additive, idempotent.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "reportChannelId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "reportEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "reportIntervalHours" INTEGER NOT NULL DEFAULT 24`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "reportHour" INTEGER`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "reportMinute" INTEGER`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "reportTimezone" TEXT NOT NULL DEFAULT 'UTC'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "reportLastRunAt" TIMESTAMP(3)`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "reportLastSnapshot" JSONB`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "overdueThresholdDays" INTEGER NOT NULL DEFAULT 7`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3)`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "maxOpenTicketsPerUser" INTEGER NOT NULL DEFAULT 3`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "ticketCooldownMinutes" INTEGER NOT NULL DEFAULT 5`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "billingAuditChannelId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "refundMaxAmount" INTEGER`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "refundMaxAmountCurrency" TEXT NOT NULL DEFAULT 'usd'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "refundMaxPer24h" INTEGER`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "refundMinMemberAgeDays" INTEGER`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "allowedPriceIds" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "question" TEXT`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "firstResponseAt" TIMESTAMP(3)`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "csatScore" INTEGER`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "csatComment" TEXT`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "csatPromptedAt" TIMESTAMP(3)`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "csatRatedAt" TIMESTAMP(3)`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "auditLogChannelId" TEXT`,
  `CREATE TABLE IF NOT EXISTS "pending_charge_reviews" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "customerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewerId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pending_charge_reviews_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "pending_charge_reviews_threadId_key" ON "pending_charge_reviews"("threadId")`,
  // Canned responses gained per-user scoping: name is now unique per owner
  // (ownerId null = team-wide), replacing the old global unique on name.
  `ALTER TABLE "canned_responses" ADD COLUMN IF NOT EXISTS "ownerId" TEXT`,
  `DROP INDEX IF EXISTS "canned_responses_name_key"`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "canned_responses_name_ownerId_key" ON "canned_responses"("name", "ownerId")`,
  // Escalation tiers: ordered staff ladder replacing the single support role.
  `CREATE TABLE IF NOT EXISTS "escalation_tiers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "escalation_tiers_pkey" PRIMARY KEY ("id")
  )`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "escalationTierId" TEXT`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "recloseAt" TIMESTAMP(3)`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "prevStatusTagId" TEXT`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_escalationTierId_fkey') THEN
      ALTER TABLE "tickets" ADD CONSTRAINT "tickets_escalationTierId_fkey"
        FOREIGN KEY ("escalationTierId") REFERENCES "escalation_tiers"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END
  $$`,
  // Priority tags: a second, status-like axis on tickets (emoji + label only).
  `CREATE TABLE IF NOT EXISTS "priority_tags" (
    "id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isInitial" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "priority_tags_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "priority_tags_emoji_key" ON "priority_tags"("emoji")`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "priorityTagId" TEXT`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_priorityTagId_fkey') THEN
      ALTER TABLE "tickets" ADD CONSTRAINT "tickets_priorityTagId_fkey"
        FOREIGN KEY ("priorityTagId") REFERENCES "priority_tags"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END
  $$`,
  // Append-only status/priority change history (emoji+label snapshotted as text).
  `CREATE TABLE IF NOT EXISTS "ticket_tag_changes" (
    "id" TEXT NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromEmoji" TEXT,
    "fromLabel" TEXT,
    "toEmoji" TEXT NOT NULL,
    "toLabel" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_tag_changes_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "ticket_tag_changes_ticketThreadId_kind_idx" ON "ticket_tag_changes"("ticketThreadId", "kind")`,
  // Cleanup of the removed Chatwoot bridge (replaced by Intercom): drops the
  // bridge tables and bot_settings columns from deployments that ran it. These
  // have no counterpart in schema.prisma — they exist only to converge old DBs
  // — and are idempotent no-ops everywhere else.
  `DROP TABLE IF EXISTS "chatwoot_outbox"`,
  `DROP TABLE IF EXISTS "chatwoot_links"`,
  `ALTER TABLE "bot_settings" DROP COLUMN IF EXISTS "chatwootMode"`,
  `ALTER TABLE "bot_settings" DROP COLUMN IF EXISTS "chatwootBaseUrl"`,
  `ALTER TABLE "bot_settings" DROP COLUMN IF EXISTS "chatwootAccountId"`,
  `ALTER TABLE "bot_settings" DROP COLUMN IF EXISTS "chatwootInboxIdentifier"`,
  `ALTER TABLE "bot_settings" DROP COLUMN IF EXISTS "chatwootHmacKey"`,
  `ALTER TABLE "bot_settings" DROP COLUMN IF EXISTS "chatwootBotToken"`,
  `ALTER TABLE "bot_settings" DROP COLUMN IF EXISTS "chatwootWebhookSecret"`,
  `ALTER TABLE "bot_settings" DROP COLUMN IF EXISTS "chatwootApiToken"`,
  `ALTER TABLE "bot_settings" DROP COLUMN IF EXISTS "chatwootInboxId"`,
  // Intercom bridge: link map, durable outbox, echo-part ledger + settings columns.
  `CREATE TABLE IF NOT EXISTS "intercom_links" (
    "id" TEXT NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "contactExternalId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "ticketId" TEXT,
    "agentWarnedAt" TIMESTAMP(3),
    "lastSyncedStateId" TEXT,
    "lastSyncedOpen" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "intercom_links_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "intercom_links_ticketThreadId_key" ON "intercom_links"("ticketThreadId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "intercom_links_conversationId_key" ON "intercom_links"("conversationId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "intercom_links_ticketId_key" ON "intercom_links"("ticketId")`,
  // Removed durable Intercom queue tables (drained by the one-time Temporal
  // migration import; the queues live in workflows now). Destructive
  // convergence like the Chatwoot cleanup above: DEAD-row history was also
  // posted as audit embeds at the time. A rollback to a pre-cleanup build
  // recreates them empty via that build's own ensureSchema.
  `DROP TABLE IF EXISTS "intercom_outbox"`,
  `DROP TABLE IF EXISTS "intercom_inbox"`,
  `CREATE TABLE IF NOT EXISTS "intercom_echo_parts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "intercom_echo_parts_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "intercom_echo_parts_kind_partId_key" ON "intercom_echo_parts"("kind", "partId")`,
  `CREATE INDEX IF NOT EXISTS "intercom_echo_parts_createdAt_idx" ON "intercom_echo_parts"("createdAt")`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomMode" TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomRegion" TEXT NOT NULL DEFAULT 'us'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomAccessToken" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomClientSecret" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomAdminId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomOperatorAdminId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomTicketTypeMap" JSONB`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomTeamId" TEXT`,
  `ALTER TABLE "status_tags" ADD COLUMN IF NOT EXISTS "intercomTicketStateId" TEXT`,
  // Customer-reply target flag. Added + backfilled together in a single guarded
  // block so it runs exactly once — on the boot that first introduces the column.
  // Existing installs adopt the documented default ("Waiting for Developer"); a
  // later operator toggle (including clearing it) is never re-applied on reboot.
  `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'status_tags'
        AND column_name = 'isCustomerReplyTarget'
    ) THEN
      ALTER TABLE "status_tags" ADD COLUMN "isCustomerReplyTarget" BOOLEAN NOT NULL DEFAULT false;
      UPDATE "status_tags" SET "isCustomerReplyTarget" = true WHERE "label" = 'Waiting for Developer';
    END IF;
  END $$;`,
  // Intercom bridge overhaul: reserve→confirm echo records, inbound tag-diff
  // damper, snooze tag + Sentry DSN settings.
  `CREATE TABLE IF NOT EXISTS "intercom_pending_posts" (
    "id" TEXT NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "intercom_pending_posts_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "intercom_pending_posts_ticketThreadId_bodyHash_idx" ON "intercom_pending_posts"("ticketThreadId", "bodyHash")`,
  `ALTER TABLE "intercom_links" ADD COLUMN IF NOT EXISTS "lastTagsJson" JSONB`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomSnoozeStatusTagId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryDsn" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "aiCommandsEnabled" BOOLEAN NOT NULL DEFAULT true`,
  // Sentry observability knobs (paired with /config → Sentry panel).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryEnvironment" TEXT NOT NULL DEFAULT 'production'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryTracesSampleRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryProfilesSampleRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryLogsEnabled" BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryDebug" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentrySendDefaultPii" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryAiRecordContent" BOOLEAN NOT NULL DEFAULT true`,
  // Sentry READ access for /ai error correlation (token encrypted at rest).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryReadEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryReadToken" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryOrgSlug" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryProjectSlug" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryReadRegion" TEXT NOT NULL DEFAULT 'us'`,
  // AI models + knowledge-base auto-refresh (paired with /config → AI & Knowledge).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "aiModel" TEXT NOT NULL DEFAULT 'sonnet'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "aiModelLight" TEXT NOT NULL DEFAULT 'haiku'`,
  // /ai ask|cause bounding levers (no --max-turns in the pinned CLI).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "aiEffortAsk" TEXT NOT NULL DEFAULT 'medium'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "aiEffortCause" TEXT NOT NULL DEFAULT 'high'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "aiMaxBudgetUsdAsk" DOUBLE PRECISION NOT NULL DEFAULT 1.0`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "aiMaxBudgetUsdCause" DOUBLE PRECISION NOT NULL DEFAULT 3.0`,
  // Pre-fetch the customer's live Postiz account into /ai context (prod kill-switch).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "aiPostizPrefetchEnabled" BOOLEAN NOT NULL DEFAULT true`,
  // Feed earlier /ai run results on the same ticket back into new /ai runs.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "aiPreviousRunsEnabled" BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "kbRefreshEnabled" BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "kbRefreshIntervalHours" INTEGER NOT NULL DEFAULT 6`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "kbLastRefreshAt" TIMESTAMP(3)`,
  // Per-user refund velocity cap (the global cap already exists as refundMaxPer24h).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "refundMaxPer24hPerUser" INTEGER`,
  // Stripe webhook ingestion (disputes + early-fraud). Secret stored encrypted.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "stripeWebhookEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "stripeWebhookEndpointId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "stripeWebhookSecret" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "publicBaseUrl" TEXT`,
  // Verbatim final AI answer, persisted for GitHub-issue bodies.
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "aiAnswer" TEXT`,
  // Stripe webhook event dedup ledger (id = Stripe evt_… id, globally unique).
  `CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "stripe_webhook_events_createdAt_idx" ON "stripe_webhook_events"("createdAt")`,
  // Per-ticket /reminders off pause (reminders, auto-close, re-close); cleared on
  // every status change.
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "remindersPaused" BOOLEAN NOT NULL DEFAULT false`,
  // InfluxDB 2.x metrics export (paired with /config → Analytics). Token encrypted.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "influxEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "influxUrl" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "influxOrg" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "influxBucket" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "influxToken" TEXT`,
  // AI ticket scoring (Batch API) knobs (paired with /config → Analytics).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringIntervalHours" INTEGER NOT NULL DEFAULT 6`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringModel" TEXT NOT NULL DEFAULT 'claude-haiku-4-5'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringMaxTicketsPerBatch" INTEGER NOT NULL DEFAULT 200`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringMaxBudgetUsdPerDay" DOUBLE PRECISION NOT NULL DEFAULT 5.0`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringLastRunAt" TIMESTAMP(3)`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringBackfillPending" BOOLEAN NOT NULL DEFAULT false`,
  // Per-run AI usage ledger (CLI + Batch runs) — feeds cost dashboards and the
  // scoring daily-budget cap.
  `CREATE TABLE IF NOT EXISTS "ai_runs" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'cli',
    "model" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "sessionId" TEXT,
    "batchId" TEXT,
    "numTurns" INTEGER,
    "durationMs" INTEGER,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "toolErrors" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "ai_runs_createdAt_idx" ON "ai_runs"("createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ai_runs_kind_createdAt_idx" ON "ai_runs"("kind", "createdAt")`,
  // Result text of staff /ai runs, replayed as context into later runs on the
  // same ticket (purged 3 days after ticket close).
  `CREATE TABLE IF NOT EXISTS "ticket_ai_runs" (
    "id" TEXT NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "subcommand" TEXT NOT NULL,
    "input" TEXT,
    "result" TEXT NOT NULL,
    "invokerId" TEXT NOT NULL,
    "invokerName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_ai_runs_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "ticket_ai_runs_ticketThreadId_createdAt_idx" ON "ticket_ai_runs"("ticketThreadId", "createdAt")`,
  // AI quality score per closed ticket (unique ticketThreadId = double-scoring guard).
  `CREATE TABLE IF NOT EXISTS "ticket_scores" (
    "id" TEXT NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "batchId" TEXT,
    "model" TEXT,
    "cxScore" INTEGER,
    "cxRationale" TEXT,
    "sentimentStart" TEXT,
    "sentimentEnd" TEXT,
    "agentTone" INTEGER,
    "agentClarity" INTEGER,
    "agentCorrectness" INTEGER,
    "resolution" TEXT,
    "fcr" BOOLEAN,
    "escalationNeeded" BOOLEAN,
    "topic" TEXT,
    "rootCause" TEXT,
    "summary" TEXT,
    "staffScores" JSONB,
    "staffNames" JSONB,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "escalationReason" TEXT,
    "customerMessages" INTEGER,
    "transcriptChars" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "scoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_scores_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ticket_scores_ticketThreadId_key" ON "ticket_scores"("ticketThreadId")`,
  `CREATE INDEX IF NOT EXISTS "ticket_scores_status_idx" ON "ticket_scores"("status")`,
  // Transcript staff-name snapshot used to validate the model's staff[] names.
  `ALTER TABLE "ticket_scores" ADD COLUMN IF NOT EXISTS "staffNames" JSONB`,
  // One-sentence model justification for cxScore (shown by /ai score).
  `ALTER TABLE "ticket_scores" ADD COLUMN IF NOT EXISTS "cxRationale" TEXT`,
  // Evaluation escalation: flag/reason survive the whole re-score lifecycle
  // (NOT NULL DEFAULT false keeps the raw-SQL work-list predicates null-safe);
  // customerMessages/transcriptChars are the submit-time complexity snapshot
  // (pre-truncation) that gates the model's flag at result time.
  `ALTER TABLE "ticket_scores" ADD COLUMN IF NOT EXISTS "escalated" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "ticket_scores" ADD COLUMN IF NOT EXISTS "escalationReason" TEXT`,
  `ALTER TABLE "ticket_scores" ADD COLUMN IF NOT EXISTS "customerMessages" INTEGER`,
  `ALTER TABLE "ticket_scores" ADD COLUMN IF NOT EXISTS "transcriptChars" INTEGER`,
  // Submitted Anthropic Message Batches — persisted so polling survives restarts.
  `CREATE TABLE IF NOT EXISTS "scoring_batches" (
    "id" TEXT NOT NULL,
    "anthropicBatchId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL,
    "succeededCount" INTEGER NOT NULL DEFAULT 0,
    "erroredCount" INTEGER NOT NULL DEFAULT 0,
    "expiredCount" INTEGER NOT NULL DEFAULT 0,
    "escalatedCount" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "scoring_batches_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "scoring_batches_anthropicBatchId_key" ON "scoring_batches"("anthropicBatchId")`,
  `CREATE INDEX IF NOT EXISTS "scoring_batches_status_idx" ON "scoring_batches"("status")`,
  // Results whose eval_escalation flag was honored in this batch.
  `ALTER TABLE "scoring_batches" ADD COLUMN IF NOT EXISTS "escalatedCount" INTEGER NOT NULL DEFAULT 0`,
  // Evaluation-escalation knobs (paired with /config → Analytics → Escalation).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringEscalationEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringEscalationModel" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringEscalationIntervalHours" INTEGER NOT NULL DEFAULT 24`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringEscalationMaxTicketsPerBatch" INTEGER NOT NULL DEFAULT 25`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "scoringEscalationLastRunAt" TIMESTAMP(3)`,
  // HashiCorp Vault connection (paired with /config → Vault). vaultToken is
  // encrypted with the LOCAL crypto.ts key — the bootstrap credential Vault
  // itself can't wrap. vaultMigratedAt = storage cutover (null = Postgres).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "vaultEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "vaultAddr" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "vaultToken" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "vaultKvMount" TEXT NOT NULL DEFAULT 'kv'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "vaultKvBasePath" TEXT NOT NULL DEFAULT 'support-bot'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "vaultTransitMount" TEXT NOT NULL DEFAULT 'transit'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "vaultTransitKey" TEXT NOT NULL DEFAULT 'support-bot'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "vaultMigratedAt" TIMESTAMP(3)`,
  // Temporal migration kill switch + connection + one-time import stamp
  // (paired with /config → Temporal; TEMPORAL_* env vars are first-boot
  // fallbacks only — the deploy has no .env access). The mTLS client cert
  // lives in Vault KV under the "temporal" integration entry.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "temporalEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "temporalAddress" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "temporalNamespace" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "temporalTaskQueue" TEXT NOT NULL DEFAULT 'support-bot'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "temporalDeploymentName" TEXT NOT NULL DEFAULT 'support-bot'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "temporalTlsServerName" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "temporalImportDoneAt" TIMESTAMP(3)`,
  // Dispute management: local dispute mirror (webhook-fed + looper-reconciled),
  // blocklist mirrored into Stripe Radar value lists, team notes/bookmarks on
  // billing objects, per-admin dispute watch subscriptions, and the
  // /config → Billing → Disputes knobs (auto-action toggles ship OFF).
  `CREATE TABLE IF NOT EXISTS "stripe_disputes" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "customerId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evidenceDueBy" TIMESTAMP(3),
    "evidenceDraft" JSONB,
    "evidenceSubmittedAt" TIMESTAMP(3),
    "lastReminderAt" TIMESTAMP(3),
    "disputeCreatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "stripe_disputes_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "stripe_disputes_status_idx" ON "stripe_disputes"("status")`,
  `CREATE INDEX IF NOT EXISTS "stripe_disputes_evidenceDueBy_idx" ON "stripe_disputes"("evidenceDueBy")`,
  `CREATE INDEX IF NOT EXISTS "stripe_disputes_chargeId_idx" ON "stripe_disputes"("chargeId")`,
  `CREATE INDEX IF NOT EXISTS "stripe_disputes_customerId_idx" ON "stripe_disputes"("customerId")`,
  // Dispute workflow v2: submitted-evidence snapshot (AI exemplars), urgent
  // reminder tier damper + settings, history/analytics (closedAt ordering) and
  // the one-time all-time backfill stamp.
  `ALTER TABLE "stripe_disputes" ADD COLUMN IF NOT EXISTS "evidenceFinal" JSONB`,
  `ALTER TABLE "stripe_disputes" ADD COLUMN IF NOT EXISTS "lastUrgentReminderAt" TIMESTAMP(3)`,
  `CREATE INDEX IF NOT EXISTS "stripe_disputes_closedAt_idx" ON "stripe_disputes"("closedAt")`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeUrgentHours" INTEGER NOT NULL DEFAULT 48`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeUrgentRoleId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeBackfillDoneAt" TIMESTAMP(3)`,
  `CREATE TABLE IF NOT EXISTS "blocked_entities" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "actorId" TEXT,
    "actorName" TEXT,
    "customerId" TEXT,
    "disputeId" TEXT,
    "radarItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "blocked_entities_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "blocked_entities_kind_value_key" ON "blocked_entities"("kind", "value")`,
  `CREATE INDEX IF NOT EXISTS "blocked_entities_customerId_idx" ON "blocked_entities"("customerId")`,
  `CREATE TABLE IF NOT EXISTS "billing_notes" (
    "id" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_notes_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "billing_notes_objectType_objectId_idx" ON "billing_notes"("objectType", "objectId")`,
  `CREATE TABLE IF NOT EXISTS "billing_bookmarks" (
    "id" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "label" TEXT,
    "addedById" TEXT NOT NULL,
    "addedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_bookmarks_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "billing_bookmarks_objectType_objectId_key" ON "billing_bookmarks"("objectType", "objectId")`,
  `CREATE TABLE IF NOT EXISTS "dispute_watches" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dispute_watches_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "dispute_watches_disputeId_userId_key" ON "dispute_watches"("disputeId", "userId")`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeAutoCancelSub" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeAutoBlock" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeReminderDays" INTEGER NOT NULL DEFAULT 3`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeRatioWarnPct" DOUBLE PRECISION NOT NULL DEFAULT 0.5`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeRatioCriticalPct" DOUBLE PRECISION NOT NULL DEFAULT 0.9`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeRatioLastLevel" TEXT NOT NULL DEFAULT 'ok'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "radarListCardId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "radarListEmailId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "radarListCustomerId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "radarListIpId" TEXT`,
];

export async function ensureSchema(prisma: PrismaClient): Promise<void> {
  for (const statement of STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
}
