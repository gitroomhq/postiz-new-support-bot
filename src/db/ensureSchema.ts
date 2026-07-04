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
  // Chatwoot bridge: mode + credentials live in bot_settings (deploy env has no .env
  // access, so everything is edited via /config), links map threads to conversations,
  // and the outbox is a durable per-ticket-FIFO queue of pending API calls.
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "chatwootMode" TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "chatwootBaseUrl" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "chatwootAccountId" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "chatwootInboxIdentifier" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "chatwootHmacKey" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "chatwootBotToken" TEXT`,
  `ALTER TABLE "bot_settings" ADD COLUMN IF NOT EXISTS "chatwootWebhookSecret" TEXT`,
  `CREATE TABLE IF NOT EXISTS "chatwoot_links" (
    "id" TEXT NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "contactId" INTEGER NOT NULL,
    "contactSourceId" TEXT NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "agentWarnedAt" TIMESTAMP(3),
    "lastSyncedStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chatwoot_links_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatwoot_links_ticketThreadId_key" ON "chatwoot_links"("ticketThreadId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatwoot_links_conversationId_key" ON "chatwoot_links"("conversationId")`,
  `CREATE TABLE IF NOT EXISTS "chatwoot_outbox" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "ticketThreadId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chatwoot_outbox_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "chatwoot_outbox_seq_key" ON "chatwoot_outbox"("seq")`,
  `CREATE INDEX IF NOT EXISTS "chatwoot_outbox_ticketThreadId_seq_idx" ON "chatwoot_outbox"("ticketThreadId", "seq")`,
  `CREATE INDEX IF NOT EXISTS "chatwoot_outbox_status_nextAttemptAt_idx" ON "chatwoot_outbox"("status", "nextAttemptAt")`,
];

export async function ensureSchema(prisma: PrismaClient): Promise<void> {
  for (const statement of STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
}
