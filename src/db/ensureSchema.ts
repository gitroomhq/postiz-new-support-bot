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
];

export async function ensureSchema(prisma: PrismaClient): Promise<void> {
  for (const statement of STATEMENTS) {
    await prisma.$executeRawUnsafe(statement);
  }
}
