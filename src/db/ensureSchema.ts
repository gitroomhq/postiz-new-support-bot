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
  // (The priority axis is removed: existing deployments keep an orphaned
  // "priority_tags" table + "tickets"."priorityTagId" column — dropping them
  // while an older build is still live would break it; fresh installs never
  // create them.)
  // Append-only status change history (emoji+label snapshotted as text).
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
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryAiRecordContent" BOOLEAN NOT NULL DEFAULT false`,
  // Sentry READ access for /ai error correlation (token encrypted at rest).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryReadEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryReadToken" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryOrgSlug" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryProjectSlug" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryReadRegion" TEXT NOT NULL DEFAULT 'us'`,
  // Postiz platform lookup (superadmin user search). POSTIZ_ADMIN_TOKEN
  // overrides the key column at runtime; the column stays the rotation path.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "postizLookupEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "postizBaseUrl" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "postizApiKey" TEXT`,
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
  // Stripe account API key — managed copy of the env var (encrypted/vault-held).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "stripeSecretKey" TEXT`,
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
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "temporalTlsEnabled" BOOLEAN NOT NULL DEFAULT false`,
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
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeAutoAttachReceipt" BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeReminderDays" INTEGER NOT NULL DEFAULT 3`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeRatioWarnPct" DOUBLE PRECISION NOT NULL DEFAULT 0.5`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeRatioCriticalPct" DOUBLE PRECISION NOT NULL DEFAULT 0.9`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "disputeRatioLastLevel" TEXT NOT NULL DEFAULT 'ok'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "radarListCardId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "radarListEmailId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "radarListCustomerId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "radarListIpId" TEXT`,
  // Intercom bi-mode hardening: confirmed echo marker, assignee damper,
  // webhook health stamp, mode-change stamp (gap heal).
  `ALTER TABLE "intercom_echo_parts" ADD COLUMN IF NOT EXISTS "confirmed" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "intercom_links" ADD COLUMN IF NOT EXISTS "lastAssigneeId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomLastInboundAt" TIMESTAMP(3)`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomModeChangedAt" TIMESTAMP(3)`,
  // Intercom edit/delete reflection: Discord message ↔ Intercom part map
  // (redact outbound, conversation_part.redacted inbound).
  `CREATE TABLE IF NOT EXISTS "intercom_message_maps" (
    "id" TEXT NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "discordMessageId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "via" TEXT,
    "redactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "intercom_message_maps_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "intercom_message_maps_partId_key" ON "intercom_message_maps"("partId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "intercom_message_maps_direction_discordMessageId_key" ON "intercom_message_maps"("direction", "discordMessageId")`,
  `CREATE INDEX IF NOT EXISTS "intercom_message_maps_ticketThreadId_idx" ON "intercom_message_maps"("ticketThreadId")`,
  // Agent-rip release: workspace inactivity sweeper (native/unbridged
  // conversations + tickets) + the one-time migration stamp.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "inactivityEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "inactivityAgentWaitDays" INTEGER NOT NULL DEFAULT 2`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "inactivityCustomerWaitDays" INTEGER NOT NULL DEFAULT 3`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "inactivityNagsBeforeClose" INTEGER NOT NULL DEFAULT 2`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "agentRipMigratedAt" TIMESTAMP(3)`,
  `CREATE TABLE IF NOT EXISTS "intercom_sweep_state" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lastAgentRemindedAt" TIMESTAMP(3),
    "customerNagCount" INTEGER NOT NULL DEFAULT 0,
    "lastCustomerNagAt" TIMESTAMP(3),
    "sweepClosedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "intercom_sweep_state_pkey" PRIMARY KEY ("id")
  )`,
  // Refund-scope fix: the Intercom unmirror gate moves from the whole billing
  // category to this per-ticket flag (only refund-flow threads stay
  // Discord-only). The UPDATE backfills pre-flag refund threads — the refund
  // flow always stamps question 'Refund request' — and converges to a no-op.
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "intercomExempt" BOOLEAN NOT NULL DEFAULT false`,
  // Flip stamp — must exist BEFORE the guarded backfill UPDATE below. The
  // IS NULL guard keeps flipped tickets (customer typed → mirrored) from
  // being re-exempted on every boot.
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "intercomExemptLiftedAt" TIMESTAMP(3)`,
  // Resolved Postiz account, stamped best-effort at ticket creation.
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "postizUserId" TEXT`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "postizOrgId" TEXT`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "postizTier" TEXT`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "postizRole" TEXT`,
  `ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "postizLinkedAt" TIMESTAMP(3)`,
  `UPDATE "tickets" SET "intercomExempt" = true
    WHERE "categoryId" = 'billing' AND "question" = 'Refund request' AND "intercomExempt" = false
      AND "intercomExemptLiftedAt" IS NULL`,
  // Refund eligibility guardrail: max charge age for self-service refunds
  // (DEFAULT backfills the existing settings row → live at 31d on deploy).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "refundMaxChargeAgeDays" INTEGER DEFAULT 31`,
  // Per-tag reminder/auto-close overrides + global sweeper text overrides
  // (all nullable = built-in defaults; {days} placeholder in texts).
  `ALTER TABLE "status_tags" ADD COLUMN IF NOT EXISTS "reminderTextCustomer" TEXT`,
  `ALTER TABLE "status_tags" ADD COLUMN IF NOT EXISTS "reminderTextSupport" TEXT`,
  `ALTER TABLE "status_tags" ADD COLUMN IF NOT EXISTS "reminderRepeatDays" INTEGER`,
  `ALTER TABLE "status_tags" ADD COLUMN IF NOT EXISTS "autoCloseMessage" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "inactivityNagText" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "inactivityAgentNoteText" TEXT`,
  // Intercom billing actions (canvas approve/deny + Stripe panel): approval
  // queue + per-action access levels + panel admin list + panel token key.
  `CREATE TABLE IF NOT EXISTS "billing_approvals" (
    "id" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "paramsJson" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "conversationId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'intercom',
    "ticketThreadId" TEXT,
    "stripeCustomerId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewerId" TEXT,
    "reviewerName" TEXT,
    "claimedAt" TIMESTAMP(3),
    "resultText" TEXT,
    "errorText" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_approvals_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "billing_approvals_status_createdAt_idx" ON "billing_approvals"("status", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "billing_approvals_conversationId_status_idx" ON "billing_approvals"("conversationId", "status")`,
  // Dashboard-origin approvals: conversation becomes optional, origin
  // decides how the execution ctx is rebuilt at approval time. Both statements
  // are idempotent on already-migrated databases.
  `ALTER TABLE "billing_approvals" ALTER COLUMN "conversationId" DROP NOT NULL`,
  `ALTER TABLE "billing_approvals" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'intercom'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "intercomPanelAdminsJson" JSONB`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "billingActionLevelsJson" JSONB`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "panelTokenSecret" TEXT`,
  // Stripe-panel link/session revocation epoch ("Revoke Stripe Panel Links").
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "panelTokenEpoch" INTEGER NOT NULL DEFAULT 0`,
  // Admin web-panel (/config + /intercom) revocation epoch — independent of the
  // Stripe-panel epoch above ("Revoke Admin Panel Links").
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "adminPanelEpoch" INTEGER NOT NULL DEFAULT 0`,
  // Stripe dashboard (/dashboard): kill switch (default OFF), allowlist,
  // independent token HMAC secret + revocation epoch.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "dashboardEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "dashboardAdminsJson" JSONB`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "dashboardTokenSecret" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "dashboardEpoch" INTEGER NOT NULL DEFAULT 0`,
  // YubiKey OTP sign-in: Yubico API client id, vault-routed API secret and an
  // optional self-hosted validation-server URL (blank = YubiCloud).
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "yubicoClientId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "yubicoApiSecret" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "yubicoValidationUrl" TEXT`,
  // Dashboard standing auth: per-admin credentials (passkeys / TOTP /
  // passphrase), DB-backed sessions (survive deploys; id = SHA-256 of the
  // cookie token) and the append-only audit trail.
  `CREATE TABLE IF NOT EXISTS "dashboard_credentials" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "credentialId" TEXT,
    "publicKey" TEXT,
    "signCount" INTEGER,
    "transports" TEXT,
    "backupState" BOOLEAN,
    "secretEnc" TEXT,
    "lastUsedStep" INTEGER,
    "hash" TEXT,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "dashboard_credentials_pkey" PRIMARY KEY ("id")
  )`,
  // Trusted-passkey flag for tables created before the column existed.
  `ALTER TABLE "dashboard_credentials" ADD COLUMN IF NOT EXISTS "trusted" BOOLEAN NOT NULL DEFAULT false`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_credentials_credentialId_key" ON "dashboard_credentials"("credentialId")`,
  `CREATE INDEX IF NOT EXISTS "dashboard_credentials_discordUserId_kind_idx" ON "dashboard_credentials"("discordUserId", "kind")`,
  `CREATE TABLE IF NOT EXISTS "dashboard_sessions" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "adminName" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "authMethod" TEXT NOT NULL,
    "credentialIdUsed" TEXT,
    "activationCode" TEXT,
    "activationAttempts" INTEGER NOT NULL DEFAULT 0,
    "uaFirst" TEXT,
    "ipFirst" TEXT,
    "ipLast" TEXT,
    "stepUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "dashboard_sessions_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "dashboard_sessions_discordUserId_idx" ON "dashboard_sessions"("discordUserId")`,
  `CREATE INDEX IF NOT EXISTS "dashboard_sessions_absoluteExpiresAt_idx" ON "dashboard_sessions"("absoluteExpiresAt")`,
  `CREATE TABLE IF NOT EXISTS "dashboard_audit_log" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "ip" TEXT,
    "sessionIdHash" TEXT,
    CONSTRAINT "dashboard_audit_log_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "dashboard_audit_log_at_idx" ON "dashboard_audit_log"("at")`,
  `CREATE INDEX IF NOT EXISTS "dashboard_audit_log_actorId_at_idx" ON "dashboard_audit_log"("actorId", "at")`,
  // SLA manager: rules write the "SLA Target" conversation attribute; an
  // Intercom Workflow branches on it → native Apply SLA. Rules + per-subject
  // state (write dedup + manual pins) + global toggles/registry.
  `CREATE TABLE IF NOT EXISTS "sla_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB NOT NULL,
    "expression" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sla_rules_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "sla_states" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conversationId" TEXT,
    "lastTarget" TEXT,
    "lastWrittenTarget" TEXT,
    "lastRuleId" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastWriteError" TEXT,
    "pinnedTarget" TEXT,
    "pinnedById" TEXT,
    "pinnedByName" TEXT,
    "pinnedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sla_states_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "sla_states_conversationId_idx" ON "sla_states"("conversationId")`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaNativeEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaDefaultTarget" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaAttributeName" TEXT NOT NULL DEFAULT 'SLA Target'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaNoteKickEnabled" BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaNoteAdminId" TEXT`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "lastKickPartId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaTargetsJson" JSONB`,
  // Bot-native SLA engine + balanced assignment + office hours (Intercom
  // Expert→Advanced downgrade, 2026-07-17): the bot now runs the clocks the
  // native Apply-SLA Workflow used to own, and balances assignment itself.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaStatusAttributeName" TEXT NOT NULL DEFAULT 'SLA Status'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaBreachTagName" TEXT NOT NULL DEFAULT 'sla-breached'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaWarnPct" INTEGER NOT NULL DEFAULT 80`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaNagRepeatMins" INTEGER NOT NULL DEFAULT 240`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "slaNagNoteText" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "officeHoursEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "officeHoursJson" JSONB`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "assignEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "assignExcludedAdminsJson" JSONB`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "assignRotationCursorsJson" JSONB`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "teamSettingsJson" JSONB`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "frHumanReplyAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "frVerifyNoneAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "frWarnedAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "frBreachedAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "frLastNaggedAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "nrCycleAnchor" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "nrWarnedAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "nrBreachedAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "nrLastNaggedAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "resWarnedAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "resBreachedAt" TIMESTAMP(3)`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "lastStatusWritten" TEXT`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "breachTagged" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "sla_states" ADD COLUMN IF NOT EXISTS "lastEnforcedAt" TIMESTAMP(3)`,
  // Sentry feedback → Intercom import: dedup/exemption ledger + the /config
  // knobs (team routing, no-backfill watermark, webhook secret — 7th global).
  `CREATE TABLE IF NOT EXISTS "sentry_feedback_imports" (
    "id" TEXT NOT NULL,
    "sentryIssueId" TEXT NOT NULL,
    "sentryShortId" TEXT,
    "projectSlug" TEXT,
    "status" TEXT NOT NULL,
    "contactEmail" TEXT,
    "contactName" TEXT,
    "intercomContactId" TEXT,
    "intercomConversationId" TEXT,
    "pageUrl" TEXT,
    "feedbackAt" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sentry_feedback_imports_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "sentry_feedback_imports_sentryIssueId_key" ON "sentry_feedback_imports"("sentryIssueId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "sentry_feedback_imports_intercomConversationId_key" ON "sentry_feedback_imports"("intercomConversationId")`,
  `CREATE INDEX IF NOT EXISTS "sentry_feedback_imports_importedAt_idx" ON "sentry_feedback_imports"("importedAt")`,
  // Identity captured off the Sentry event, plus the one-shot replay marker.
  `ALTER TABLE "sentry_feedback_imports" ADD COLUMN IF NOT EXISTS "postizUserId" TEXT`,
  `ALTER TABLE "sentry_feedback_imports" ADD COLUMN IF NOT EXISTS "postizOrgId" TEXT`,
  `ALTER TABLE "sentry_feedback_imports" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT`,
  `ALTER TABLE "sentry_feedback_imports" ADD COLUMN IF NOT EXISTS "retriedAt" TIMESTAMP(3)`,
  // Organization ↔ Stripe customer mapping harvested from Sentry events.
  `CREATE TABLE IF NOT EXISTS "postiz_org_links" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observations" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "postiz_org_links_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "postiz_org_links_orgId_key" ON "postiz_org_links"("orgId")`,
  `CREATE INDEX IF NOT EXISTS "postiz_org_links_stripeCustomerId_idx" ON "postiz_org_links"("stripeCustomerId")`,
  `CREATE INDEX IF NOT EXISTS "sentry_feedback_imports_status_retriedAt_idx" ON "sentry_feedback_imports"("status", "retriedAt")`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryFeedbackTeamId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryFeedbackWatermarkAt" TIMESTAMP(3)`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryFeedbackLastSyncAt" TIMESTAMP(3)`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryWebhookSecret" TEXT`,
  // Feedback imports as customer tickets (type picked via /config) + the
  // ledger's ticket-id column for the sweeper/enforcer exemption lookups.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "sentryFeedbackTicketTypeId" TEXT`,
  `ALTER TABLE "sentry_feedback_imports" ADD COLUMN IF NOT EXISTS "intercomTicketId" TEXT`,
  // Forwarded-email conversion (lite-seat forwards → conversation recreated for
  // the original sender): ledger table + the /intercom → Automation knobs.
  `CREATE TABLE IF NOT EXISTS "forwarded_email_converts" (
    "id" TEXT NOT NULL,
    "originalConversationId" TEXT NOT NULL,
    "newConversationId" TEXT,
    "forwarderAdminId" TEXT,
    "forwarderEmail" TEXT,
    "customerEmail" TEXT NOT NULL,
    "customerName" TEXT,
    "intercomContactId" TEXT,
    "contactRole" TEXT,
    "trigger" TEXT NOT NULL,
    "actorLabel" TEXT,
    "attachmentsCount" INTEGER NOT NULL DEFAULT 0,
    "attachmentsReuploaded" BOOLEAN NOT NULL DEFAULT false,
    "convertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "forwarded_email_converts_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "forwarded_email_converts_originalConversationId_key" ON "forwarded_email_converts"("originalConversationId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "forwarded_email_converts_newConversationId_key" ON "forwarded_email_converts"("newConversationId")`,
  `CREATE INDEX IF NOT EXISTS "forwarded_email_converts_convertedAt_idx" ON "forwarded_email_converts"("convertedAt")`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "forwardConvertEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "forwardConvertTagName" TEXT NOT NULL DEFAULT 'email'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "forwardConvertCloseNote" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "forwardConvertExtraEmails" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "forwardDetachForwarder" BOOLEAN NOT NULL DEFAULT true`,
  // Money-out ledger: one row per outflow, written by the balance-transaction
  // sweep (kind=LEDGER, id = txn_…) or by the concession webhooks/actions
  // (kind=CONCESSION, id = the Stripe object id). Disjoint key spaces, so a
  // plain upsert-by-id is the whole idempotency story.
  `CREATE TABLE IF NOT EXISTS "stripe_money_out" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "feeMinor" INTEGER NOT NULL DEFAULT 0,
    "netMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "stripeObjectId" TEXT,
    "chargeId" TEXT,
    "customerId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "stripe_money_out_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "stripe_money_out_occurredAt_idx" ON "stripe_money_out"("occurredAt")`,
  `CREATE INDEX IF NOT EXISTS "stripe_money_out_bucket_occurredAt_idx" ON "stripe_money_out"("bucket", "occurredAt")`,
  `CREATE INDEX IF NOT EXISTS "stripe_money_out_category_occurredAt_idx" ON "stripe_money_out"("category", "occurredAt")`,
  `CREATE INDEX IF NOT EXISTS "stripe_money_out_customerId_idx" ON "stripe_money_out"("customerId")`,
  `CREATE INDEX IF NOT EXISTS "stripe_money_out_chargeId_idx" ON "stripe_money_out"("chargeId")`,
  `CREATE INDEX IF NOT EXISTS "stripe_money_out_stripeObjectId_idx" ON "stripe_money_out"("stripeObjectId")`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "moneyOutEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "moneyOutSweepAt" TIMESTAMP(3)`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "moneyOutBackfillDoneAt" TIMESTAMP(3)`,
];

export async function ensureSchema(prisma: PrismaClient): Promise<void> {
  for (const statement of STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
}
