import { PrismaClient } from "../generated/prisma/client";
import { decryptSecret, encryptSecret, isTransitCiphertext } from "../util/crypto";
import type { VaultService } from "../vault/VaultService";

export class SessionStore {
  // Plaintext token cache: keeps /ai working on cache hits through Vault
  // outages (memory-only by design — lost on restart) and spares a Transit
  // round-trip per run. Insertion-ordered Map → evict-oldest at the cap.
  private static readonly TOKEN_CACHE_TTL_MS = 15 * 60_000;
  private static readonly TOKEN_CACHE_MAX = 1000;
  // Max age a pending OAuth state is accepted at callback (matches the sweeper).
  private static readonly PENDING_AUTH_TTL_MS = 10 * 60_000;
  private tokenCache = new Map<string, { token: string; at: number }>();
  private vault: VaultService | null = null;

  constructor(private prisma: PrismaClient) {}

  // Late-bound: SessionStore is constructed before the VaultService (same
  // idiom as SettingsStore.bindVault). Unbound = local-encryption behavior.
  bindVault(vault: VaultService): void {
    this.vault = vault;
  }

  // SLA-manager hook, late-bound: fires after a pending charge review is
  // created so stripe.refund_review rules re-evaluate the ticket. Best-effort
  // fire-and-forget — must never fail the refund guardrail path.
  private slaHook: ((threadId: string) => Promise<void>) | null = null;

  setSlaHook(fn: (threadId: string) => Promise<void>): void {
    this.slaHook = fn;
  }

  // Rows leaving the store carry a REDACTED accessToken ("") — no row consumer
  // uses it (they read postizUserId/stripeCustomerId), and running a Transit
  // ciphertext through decryptSecret's legacy-plaintext passthrough would hand
  // ciphertext out as if it were the token. The one plaintext consumer (/ai's
  // Postiz pre-fetch) calls getAccessToken() instead.
  private redactRow<T extends { accessToken: string }>(row: T): T {
    return { ...row, accessToken: "" };
  }

  private cacheToken(discordUserId: string, token: string): void {
    this.tokenCache.delete(discordUserId);
    this.tokenCache.set(discordUserId, { token, at: Date.now() });
    if (this.tokenCache.size > SessionStore.TOKEN_CACHE_MAX) {
      const oldest = this.tokenCache.keys().next().value;
      if (oldest !== undefined) this.tokenCache.delete(oldest);
    }
  }

  // No arg = drop everything (used by the migrator after batch re-encryption).
  invalidateTokenCache(discordUserId?: string): void {
    if (discordUserId) this.tokenCache.delete(discordUserId);
    else this.tokenCache.clear();
  }

  // On-demand plaintext token. Envelope discrimination: vault:v<N>: → Transit
  // decrypt (null while Vault is down), enc:v1: → local decrypt, anything else
  // → legacy plaintext passthrough. On a failed decrypt the stale cache entry
  // is served instead — the row still exists, so it's the same token, and /ai
  // keeps working through an outage for recently-active users.
  async getAccessToken(discordUserId: string): Promise<string | null> {
    const cached = this.tokenCache.get(discordUserId);
    if (cached && Date.now() - cached.at < SessionStore.TOKEN_CACHE_TTL_MS) return cached.token;
    const row = await this.prisma.userSession.findUnique({
      where: { discordUserId },
      select: { accessToken: true },
    });
    if (!row?.accessToken) {
      this.tokenCache.delete(discordUserId);
      return null;
    }
    const raw = row.accessToken;
    const fresh = isTransitCiphertext(raw) ? ((await this.vault?.transitDecrypt(raw)) ?? null) : decryptSecret(raw);
    if (fresh) {
      this.cacheToken(discordUserId, fresh);
      return fresh;
    }
    return cached?.token ?? null;
  }

  async setSession(discordUserId: string, accessToken: string, postizUserId?: string, stripeCustomerId?: string): Promise<void> {
    // Vault-first: Transit ciphertext when storage is active and Vault is up;
    // local encryption otherwise — the OAuth callback must never fail because
    // Vault is down (the upgrade job lifts fallback rows to Transit on
    // recovery).
    const vault = this.vault;
    const enc =
      (vault?.storageActive() && vault.state() === "up" ? await vault.transitEncrypt(accessToken) : null) ??
      encryptSecret(accessToken);
    await this.prisma.userSession.upsert({
      where: { discordUserId },
      update: { accessToken: enc, postizUserId, stripeCustomerId, authenticatedAt: new Date() },
      create: { discordUserId, accessToken: enc, postizUserId, stripeCustomerId },
    });
    this.cacheToken(discordUserId, accessToken);
  }

  async getSession(discordUserId: string) {
    const row = await this.prisma.userSession.findUnique({
      where: { discordUserId },
    });
    return row ? this.redactRow(row) : row;
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
    const rows = await this.prisma.userSession.findMany({
      where: { discordUserId: { in: discordUserIds } },
    });
    return rows.map((r) => this.redactRow(r));
  }

  async removeSession(discordUserId: string): Promise<void> {
    await this.prisma.userSession.deleteMany({
      where: { discordUserId },
    });
    this.invalidateTokenCache(discordUserId);
  }

  // Envelope census for the /config Vault panel and migration reports.
  async countTokensByEnvelope(): Promise<{ transit: number; local: number; legacy: number }> {
    const [transit, local, total] = await Promise.all([
      this.prisma.userSession.count({ where: { accessToken: { startsWith: "vault:" } } }),
      this.prisma.userSession.count({ where: { accessToken: { startsWith: "enc:" } } }),
      this.prisma.userSession.count(),
    ]);
    return { transit, local, legacy: total - transit - local };
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
    // Atomic single-use: delete on the @unique state either returns the row
    // (this caller consumed it) or throws P2025 (a concurrent callback already
    // did) — no read-then-delete TOCTOU window where two callbacks both proceed.
    let pending: { discordUserId: string; channelId: string; interactionToken: string | null; createdAt: Date };
    try {
      pending = await this.prisma.pendingAuth.delete({ where: { state } });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2025") return null; // already consumed / unknown state
      throw e;
    }
    // Reject stale state at consume time rather than trusting only the sweeper.
    if (Date.now() - pending.createdAt.getTime() > SessionStore.PENDING_AUTH_TTL_MS) return null;
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
  // Dispute actions claim synthetic ids ("dispute-<action>-<dp_id>") through the
  // same column — the velocity counters filter on action, so they never collide.
  async claimBillingAction(
    discordUserId: string,
    chargeId: string,
    action: "refund" | "discount" | "admin_refund" | "dispute_submit" | "dispute_accept" | "dispute_autocancel" | "dispute_autoblock" | "dispute_receipt"
  ): Promise<boolean> {
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

  // Self-service refunds in the trailing window, across all users (velocity
  // guardrail). Admin refunds are tagged "admin_refund" and deliberately excluded
  // so staff actions don't push unrelated customers into manual review.
  async countRefundsSince(since: Date): Promise<number> {
    return this.prisma.billingAction.count({
      where: { action: "refund", createdAt: { gte: since } },
    });
  }

  // Same trailing-window count but scoped to one Discord user (per-user velocity
  // cap, applied alongside the global one). BillingAction already stores
  // discordUserId, and admin_refund stays excluded via the action filter.
  async countRefundsSinceForUser(discordUserId: string, since: Date): Promise<number> {
    return this.prisma.billingAction.count({
      where: { action: "refund", discordUserId, createdAt: { gte: since } },
    });
  }

  // First-refund-only guardrail: has this Discord user EVER completed a refund
  // through the bot (no time window)? "admin_refund" is included — unlike the
  // velocity counters — because a staff-issued refund still means the person
  // already got money back. Rows are released on Stripe failure, so only
  // completed refunds count; dispute_* synthetic claims stay excluded.
  // NOTE: ChargesHub claims admin_refund under the acting STAFF member's id,
  // so customer-side admin refunds are primarily caught by the Stripe-history
  // sweep instead (StripeClient.customerHasAnyRefund).
  async hasEverBeenRefunded(discordUserId: string): Promise<boolean> {
    const count = await this.prisma.billingAction.count({
      where: { discordUserId, action: { in: ["refund", "admin_refund"] } },
    });
    return count > 0;
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
    void this.slaHook?.(data.threadId).catch(() => undefined);
  }

  async getPendingChargeReview(threadId: string) {
    return this.prisma.pendingChargeReview.findFirst({ where: { threadId, status: "PENDING" } });
  }

  // Any-status review lookup for the refund-flip context note
  // (getPendingChargeReview filters to PENDING; the note wants resolved
  // outcomes too).
  async getChargeReviewAnyStatus(threadId: string) {
    return this.prisma.pendingChargeReview.findUnique({ where: { threadId } });
  }

  // Newest completed billing action this customer took since the ticket opened
  // (BillingAction has no threadId — user+window is the join). Backs the
  // refund-flip context note's "discount accepted / refund executed" line.
  async latestBillingActionForUserSince(discordUserId: string, since: Date) {
    return this.prisma.billingAction.findFirst({
      where: { discordUserId, createdAt: { gte: since }, action: { in: ["refund", "discount", "admin_refund"] } },
      orderBy: { createdAt: "desc" },
    });
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

  // ---- Stripe webhook event dedup ----

  // Claims a Stripe event id (the PK). Returns false if already seen (Stripe
  // redelivers on non-2xx and occasionally at-least-once). Mirrors the Intercom
  // inbox's P2002-as-duplicate pattern.
  async claimStripeEvent(eventId: string, type: string): Promise<boolean> {
    try {
      await this.prisma.stripeWebhookEvent.create({ data: { id: eventId, type } });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") return false;
      throw error;
    }
  }

  // Prune old dedup rows so the ledger doesn't grow unbounded.
  async cleanOldStripeEvents(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): Promise<void> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    await this.prisma.stripeWebhookEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  }
}
