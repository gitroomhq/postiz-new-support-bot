import { PrismaClient } from "../generated/prisma/client";

export class SessionStore {
  constructor(private prisma: PrismaClient) {}

  async setSession(discordUserId: string, accessToken: string, postizUserId?: string, stripeCustomerId?: string): Promise<void> {
    await this.prisma.userSession.upsert({
      where: { discordUserId },
      update: { accessToken, postizUserId, stripeCustomerId, authenticatedAt: new Date() },
      create: { discordUserId, accessToken, postizUserId, stripeCustomerId },
    });
  }

  async getSession(discordUserId: string) {
    return this.prisma.userSession.findUnique({
      where: { discordUserId },
    });
  }

  // Reverse lookups for /search-tickets. postizUserId/stripeCustomerId are not @unique,
  // so a single id can (in theory) map to several Discord accounts — return all of them.
  async findDiscordIdsByPostizId(postizUserId: string): Promise<string[]> {
    const rows = await this.prisma.userSession.findMany({
      where: { postizUserId },
      select: { discordUserId: true },
    });
    return rows.map((r) => r.discordUserId);
  }

  async findDiscordIdsByStripeId(stripeCustomerId: string): Promise<string[]> {
    const rows = await this.prisma.userSession.findMany({
      where: { stripeCustomerId },
      select: { discordUserId: true },
    });
    return rows.map((r) => r.discordUserId);
  }

  // Admin link/unlink (/billing). Update-only by design: creating a row would flip
  // isAuthenticated() for a user who never OAuth'd (accessToken is owned by the OAuth flow).
  async updateStripeCustomerId(discordUserId: string, stripeCustomerId: string | null): Promise<boolean> {
    const res = await this.prisma.userSession.updateMany({
      where: { discordUserId },
      data: { stripeCustomerId },
    });
    return res.count > 0;
  }

  // After a customer is deleted in Stripe, stale links would point support staff
  // at a dead id — clear them everywhere (the column is not unique).
  async unlinkStripeCustomerEverywhere(stripeCustomerId: string): Promise<number> {
    const res = await this.prisma.userSession.updateMany({
      where: { stripeCustomerId },
      data: { stripeCustomerId: null },
    });
    return res.count;
  }

  // Batch-resolve sessions for display (Postiz/Stripe id columns) on a page of results.
  async listByDiscordIds(discordUserIds: string[]) {
    if (discordUserIds.length === 0) return [];
    return this.prisma.userSession.findMany({
      where: { discordUserId: { in: discordUserIds } },
    });
  }

  async removeSession(discordUserId: string): Promise<void> {
    await this.prisma.userSession.deleteMany({
      where: { discordUserId },
    });
  }

  async isAuthenticated(discordUserId: string): Promise<boolean> {
    const session = await this.prisma.userSession.findUnique({
      where: { discordUserId },
    });
    return session !== null;
  }

  async addPendingAuth(state: string, discordUserId: string, channelId: string, interactionToken?: string): Promise<void> {
    await this.prisma.pendingAuth.create({
      data: { state, discordUserId, channelId, interactionToken },
    });
  }

  async consumePendingAuth(state: string) {
    const pending = await this.prisma.pendingAuth.findUnique({
      where: { state },
    });

    if (pending) {
      await this.prisma.pendingAuth.delete({ where: { state } });
    }

    return pending;
  }

  async hasBillingAction(invoiceId: string): Promise<boolean> {
    const action = await this.prisma.billingAction.findUnique({
      where: { stripeInvoiceId: invoiceId },
    });
    return action !== null;
  }

  async recordBillingAction(discordUserId: string, invoiceId: string, action: "refund" | "discount"): Promise<void> {
    await this.prisma.billingAction.create({
      data: { discordUserId, stripeInvoiceId: invoiceId, action },
    });
  }

  // Atomically claims a charge for a billing action. The unique index on stripeInvoiceId
  // is the lock: whichever concurrent confirm inserts first wins, the loser gets false.
  // Claim BEFORE calling Stripe; release on Stripe failure so the user can retry.
  async claimBillingAction(discordUserId: string, chargeId: string, action: "refund" | "discount"): Promise<boolean> {
    try {
      await this.prisma.billingAction.create({
        data: { discordUserId, stripeInvoiceId: chargeId, action },
      });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") return false;
      throw error;
    }
  }

  async releaseBillingAction(chargeId: string): Promise<void> {
    await this.prisma.billingAction.deleteMany({ where: { stripeInvoiceId: chargeId } });
  }

  // Refunds executed in the trailing window, across all users (velocity guardrail).
  async countRefundsSince(since: Date): Promise<number> {
    return this.prisma.billingAction.count({
      where: { action: "refund", createdAt: { gte: since } },
    });
  }

  // ---- Blocked-charge manual reviews (staff /charge approve|deny) ----

  // A retried self-service refund can trip a guardrail again in the same thread;
  // upsert keeps the latest block as the pending one.
  async createPendingChargeReview(data: {
    threadId: string;
    chargeId: string;
    subscriptionId: string | null;
    customerId: string;
    amount: number;
    currency: string;
    reason: string;
  }): Promise<void> {
    await this.prisma.pendingChargeReview.upsert({
      where: { threadId: data.threadId },
      update: { ...data, status: "PENDING", reviewerId: null, resolvedAt: null },
      create: data,
    });
  }

  async getPendingChargeReview(threadId: string) {
    return this.prisma.pendingChargeReview.findFirst({ where: { threadId, status: "PENDING" } });
  }

  // Any-status lookup: guards the message-based recovery of pre-feature blocks
  // from resurrecting an already-resolved review.
  async hasChargeReview(threadId: string): Promise<boolean> {
    return (await this.prisma.pendingChargeReview.findUnique({ where: { threadId } })) !== null;
  }

  async resolvePendingChargeReview(
    threadId: string,
    status: "APPROVED" | "DENIED" | "ALREADY_PROCESSED",
    reviewerId: string
  ): Promise<void> {
    await this.prisma.pendingChargeReview.updateMany({
      where: { threadId, status: "PENDING" },
      data: { status, reviewerId, resolvedAt: new Date() },
    });
  }

  async cleanExpiredPending(maxAgeMs: number = 10 * 60 * 1000): Promise<void> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    await this.prisma.pendingAuth.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
  }
}
