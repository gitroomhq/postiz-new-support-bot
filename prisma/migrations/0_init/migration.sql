-- Baseline of the schema created earlier with `prisma db push`. On the existing
-- production database this migration is marked as already applied (see the
-- one-time `prisma migrate resolve --applied 0_init`); it only runs on fresh
-- databases.

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "postizUserId" TEXT,
    "stripeCustomerId" TEXT,
    "authenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_actions" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "stripeInvoiceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_auths" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "interactionToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_auths_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_discordUserId_key" ON "user_sessions"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_actions_stripeInvoiceId_key" ON "billing_actions"("stripeInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_auths_state_key" ON "pending_auths"("state");
