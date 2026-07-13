import { Prisma, PrismaClient, BotSettings, StatusTag, PriorityTag } from "../generated/prisma/client";
import type { SentryRuntimeConfig } from "../util/logger";
import type { InfluxRuntimeConfig } from "../metrics/InfluxWriter";
import { decryptSecret, encryptSecret, isVaultKvSentinel, VAULT_KV_SENTINEL } from "../util/crypto";
import type { VaultIntegration, VaultRuntimeConfig, VaultService } from "../vault/VaultService";

export type ReminderTarget = "SUPPORT" | "CUSTOMER";

export type IntercomMode = "none" | "push" | "bi";
export type IntercomRegion = "us" | "eu" | "au";

// `--effort` levels accepted by the Claude CLI. Stored free-text in BotSettings
// but coerced on read so a bad /config value can never break the spawn.
export type AiEffort = "low" | "medium" | "high" | "max";
const AI_EFFORT_LEVELS: readonly AiEffort[] = ["low", "medium", "high", "max"];
export function coerceEffort(v: string | null | undefined, fallback: AiEffort): AiEffort {
  const s = (v ?? "").trim().toLowerCase();
  return (AI_EFFORT_LEVELS as readonly string[]).includes(s) ? (s as AiEffort) : fallback;
}

export interface TagInput {
  emoji: string;
  label: string;
  isInitial?: boolean;
  closesThread?: boolean;
  reminderEnabled?: boolean;
  reminderDays?: number;
  reminderTarget?: ReminderTarget;
  autoCloseAfter?: number | null;
  // When set, a customer replying to a Waiting-for-Customer ticket moves it here
  // instead of reverting to its previous status. At most one tag holds this.
  isCustomerReplyTarget?: boolean;
}

const DEFAULT_TAGS: TagInput[] = [
  { emoji: "🟢", label: "Open", isInitial: true, reminderEnabled: true, reminderDays: 3, reminderTarget: "SUPPORT" },
  { emoji: "🟡", label: "Ongoing", reminderEnabled: true, reminderDays: 3, reminderTarget: "SUPPORT" },
  { emoji: "🟠", label: "Waiting for Customer", reminderEnabled: true, reminderDays: 3, reminderTarget: "CUSTOMER", autoCloseAfter: 3 },
  { emoji: "🔵", label: "Waiting for Developer", reminderEnabled: true, reminderDays: 5, reminderTarget: "SUPPORT", isCustomerReplyTarget: true },
  { emoji: "🟣", label: "Testing", reminderEnabled: true, reminderDays: 5, reminderTarget: "SUPPORT" },
  // autoCloseAfter on Resolved is read as DAYS of customer silence before the ticket
  // is auto-closed (locked); on reminder tags it counts reminder rounds instead.
  { emoji: "✅", label: "Resolved", reminderEnabled: false, autoCloseAfter: 3 },
  { emoji: "📁", label: "Closed", closesThread: true, reminderEnabled: false },
];

export interface PriorityInput {
  emoji: string;
  label: string;
  isInitial?: boolean;
}

const DEFAULT_PRIORITIES: PriorityInput[] = [
  { emoji: "⬜", label: "Very Low" },
  { emoji: "🟩", label: "Low" },
  { emoji: "🟨", label: "Medium", isInitial: true },
  { emoji: "🟧", label: "High" },
  { emoji: "🟥", label: "Very High" },
  { emoji: "🚨", label: "Critical" },
];

// The five global secrets and their Vault KV home (one KV entry per
// integration; field names live inside the entry). Shared by the read
// resolver, the write router, the panel state helper and the migrator.
export type GlobalSecretColumn =
  | "intercomAccessToken"
  | "intercomClientSecret"
  | "stripeWebhookSecret"
  | "sentryReadToken"
  | "influxToken";

export const GLOBAL_SECRETS: Record<GlobalSecretColumn, { integration: VaultIntegration; field: string }> = {
  intercomAccessToken: { integration: "intercom", field: "accessToken" },
  intercomClientSecret: { integration: "intercom", field: "clientSecret" },
  stripeWebhookSecret: { integration: "stripe", field: "webhookSecret" },
  sentryReadToken: { integration: "sentry", field: "readToken" },
  influxToken: { integration: "influx", field: "token" },
};

// Panel-facing storage state of a global secret column.
export type SecretState = "none" | "local" | "vault" | "vault-unreachable" | "local-unreadable";

export function isUnicodeEmoji(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  if (s.includes(":") || s.includes("<") || s.includes(">")) return false;
  if (/[A-Za-z0-9]/.test(s)) return false;
  if (Array.from(s).length > 8) return false;
  return /\p{Extended_Pictographic}/u.test(s);
}

export class SettingsStore {
  private settings!: BotSettings;
  private tagList: StatusTag[] = [];
  private priorityList: PriorityTag[] = [];
  private vault: VaultService | null = null;

  constructor(private prisma: PrismaClient) {}

  // Late-bound (same idiom as AuditLogger.bindClient): SettingsStore is
  // constructed before the VaultService that depends on it. Until bound,
  // vault-held secrets resolve to null — identical to Vault-down degradation.
  bindVault(vault: VaultService): void {
    this.vault = vault;
  }

  // ---- Vault secret plumbing (the five GLOBAL_SECRETS columns) ----

  // Read path. A column holds one of: null/"" (not set), the vault:kv sentinel
  // (value lives in Vault KV → serve from the in-memory cache, null while the
  // cache is cold), a local enc:v1 ciphertext, or legacy plaintext (both
  // handled by decryptSecret).
  private resolveSecret(raw: string | null, column: GlobalSecretColumn): string | null {
    if (raw == null || raw === "") return raw;
    if (isVaultKvSentinel(raw)) {
      const { integration, field } = GLOBAL_SECRETS[column];
      return this.vault?.getCachedKvField(integration, field) ?? null;
    }
    return decryptSecret(raw);
  }

  // Write path: vault-first with local fallback. Returns the value to store in
  // the column — the sentinel after a successful KV write, or a local enc:v1
  // ciphertext when Vault storage isn't active/reachable (the migrator's
  // background job upgrades those on recovery). Clearing (null/"") clears the
  // column and best-effort deletes the KV field; a delete missed while Vault
  // is down is reconciled by the same job (null column + present KV field).
  private async routeSecretWrite(column: GlobalSecretColumn, plaintext: string | null): Promise<string | null> {
    const { integration, field } = GLOBAL_SECRETS[column];
    const vault = this.vault;
    const vaultActive = vault != null && vault.storageActive();
    if (!plaintext) {
      if (vaultActive && isVaultKvSentinel(this.settings[column] ?? "")) {
        await vault.setKvFields(integration, { [field]: null });
      }
      // null → NULL, "" → "" — preserves the existing "empty string blocks the
      // env fallback" semantics of the Intercom columns.
      return plaintext;
    }
    if (vaultActive && vault.state() === "up") {
      if (await vault.setKvFields(integration, { [field]: plaintext })) {
        return VAULT_KV_SENTINEL;
      }
      // The failed write flipped the state to down — fall through to local.
    }
    return encryptSecret(plaintext);
  }

  // Storage state for the /config panels (three Vault-era states on top of the
  // classic two): where does this secret live and is it readable right now?
  secretState(column: GlobalSecretColumn): SecretState {
    const raw = this.settings[column];
    if (!raw) return "none";
    if (isVaultKvSentinel(raw)) {
      const { integration, field } = GLOBAL_SECRETS[column];
      return this.vault?.getCachedKvField(integration, field) ? "vault" : "vault-unreachable";
    }
    return decryptSecret(raw) == null ? "local-unreadable" : "local";
  }

  // Migrator plumbing: raw column access bypassing resolve/encrypt. This is
  // the ONLY legal way to write the vault:kv sentinel — encryptSecret would
  // double-wrap it (it only skips enc:v1-prefixed values).
  getSecretColumnRaw(column: GlobalSecretColumn): string | null {
    return this.settings[column];
  }

  async setSecretColumnRaw(column: GlobalSecretColumn, raw: string | null): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { [column]: raw },
    });
  }

  async load(): Promise<void> {
    let settings = await this.prisma.botSettings.findUnique({ where: { id: "global" } });
    if (!settings) {
      // intercomRegion is NOT NULL DEFAULT 'us', so the getter's `?? process.env`
      // fallback is dead — an env-only EU/AU deploy would silently stay on 'us'.
      // Seed it here on first run (the documented env path) instead.
      const seedRegion = process.env.INTERCOM_REGION;
      settings = await this.prisma.botSettings.create({
        data: {
          id: "global",
          threadsChannelId: process.env.DISCORD_THREADS_CHANNEL_ID || null,
          supportRoleId: process.env.DISCORD_SUPPORT_ROLE_ID || null,
          githubRepo: process.env.GH_BOT_REPO || null,
          ...(seedRegion === "eu" || seedRegion === "au" ? { intercomRegion: seedRegion } : {}),
        },
      });
    }
    this.settings = settings;

    if ((await this.prisma.statusTag.count()) === 0) {
      await this.prisma.statusTag.createMany({
        data: DEFAULT_TAGS.map((t, i) => ({
          emoji: t.emoji,
          label: t.label,
          isInitial: t.isInitial ?? false,
          closesThread: t.closesThread ?? false,
          reminderEnabled: t.reminderEnabled ?? false,
          reminderDays: t.reminderDays ?? 3,
          reminderTarget: t.reminderTarget ?? "SUPPORT",
          autoCloseAfter: t.autoCloseAfter ?? null,
          isCustomerReplyTarget: t.isCustomerReplyTarget ?? false,
          sortOrder: i,
        })),
      });
    }
    await this.refreshTags();

    if ((await this.prisma.priorityTag.count()) === 0) {
      await this.prisma.priorityTag.createMany({
        data: DEFAULT_PRIORITIES.map((p, i) => ({
          emoji: p.emoji,
          label: p.label,
          isInitial: p.isInitial ?? false,
          sortOrder: i,
        })),
      });
    }
    await this.refreshPriorities();
  }

  private async refreshTags(): Promise<void> {
    this.tagList = await this.prisma.statusTag.findMany({ orderBy: { sortOrder: "asc" } });
  }

  private async refreshPriorities(): Promise<void> {
    this.priorityList = await this.prisma.priorityTag.findMany({ orderBy: { sortOrder: "asc" } });
  }

  threadsChannelId(): string | null {
    return this.settings.threadsChannelId;
  }

  // Deprecated: staff roles live in EscalationTierStore now. This survives only
  // as the fallback while no tiers are configured (and to seed tier 1 once).
  supportRoleId(): string | null {
    return this.settings.supportRoleId;
  }

  githubRepo(): string | null {
    return this.settings.githubRepo;
  }

  // Main model for customer answers + /ai ask|cause. Free-text (a new model id
  // works without a code change); defaults to the "sonnet" alias.
  aiModel(): string {
    return this.settings.aiModel;
  }

  // Cheaper model for the tool-less /ai summarize|draft runs.
  aiModelLight(): string {
    return this.settings.aiModelLight;
  }

  // /ai ask|cause bounding levers (the pinned CLI has no --max-turns). Effort
  // caps exploration depth; the budget is a hard per-run USD stop (also bounds
  // worst-case latency). ask is lighter than cause by default.
  aiEffortAsk(): AiEffort {
    return coerceEffort(this.settings.aiEffortAsk, "medium");
  }

  aiMaxBudgetUsdAsk(): number {
    return this.settings.aiMaxBudgetUsdAsk;
  }

  kbRefreshEnabled(): boolean {
    return this.settings.kbRefreshEnabled;
  }

  kbRefreshIntervalHours(): number {
    return this.settings.kbRefreshIntervalHours;
  }

  kbLastRefreshAt(): Date | null {
    return this.settings.kbLastRefreshAt;
  }

  backfillDone(): boolean {
    return this.settings.backfillDone;
  }

  // 0 = disabled for both ticket limits.
  maxOpenTicketsPerUser(): number {
    return this.settings.maxOpenTicketsPerUser;
  }

  ticketCooldownMinutes(): number {
    return this.settings.ticketCooldownMinutes;
  }

  billingAuditChannelId(): string | null {
    return this.settings.billingAuditChannelId;
  }

  auditLogChannelId(): string | null {
    return this.settings.auditLogChannelId;
  }

  // null = guardrail disabled. Amount is in minor units of refundMaxAmountCurrency.
  refundMaxAmount(): number | null {
    return this.settings.refundMaxAmount;
  }

  refundMaxAmountCurrency(): string {
    return this.settings.refundMaxAmountCurrency;
  }

  refundMaxPer24h(): number | null {
    return this.settings.refundMaxPer24h;
  }

  // Per-user 24h cap (null = disabled), applied alongside the global refundMaxPer24h.
  refundMaxPer24hPerUser(): number | null {
    return this.settings.refundMaxPer24hPerUser;
  }

  refundMinMemberAgeDays(): number | null {
    return this.settings.refundMinMemberAgeDays;
  }

  // /billing plan allowlist (comma-separated price ids in the DB). Empty = all
  // active recurring prices are offered in the create/change-plan pickers.
  allowedPriceIds(): string[] {
    return (this.settings.allowedPriceIds ?? "").split(",").filter(Boolean);
  }

  tags(): StatusTag[] {
    return this.tagList;
  }

  tagById(id: string): StatusTag | undefined {
    return this.tagList.find((t) => t.id === id);
  }

  tagByEmoji(emoji: string): StatusTag | undefined {
    return this.tagList.find((t) => t.emoji === emoji);
  }

  initialTag(): StatusTag | undefined {
    return this.tagList.find((t) => t.isInitial);
  }

  // The tag a customer reply to a Waiting-for-Customer ticket lands on (at most
  // one). Undefined → callers fall back to the previous-status behaviour.
  customerReplyTarget(): StatusTag | undefined {
    return this.tagList.find((t) => t.isCustomerReplyTarget);
  }

  closingTag(): StatusTag | undefined {
    return this.tagList.find((t) => t.closesThread);
  }

  priorityById(id: string): PriorityTag | undefined {
    return this.priorityList.find((p) => p.id === id);
  }

  // ---- Intercom bridge ----
  // Credentials can come from the DB (/config panel, wins) or from env vars —
  // the deploy may provide either; the panel edits the DB copy live.

  intercomMode(): IntercomMode {
    const mode = this.settings.intercomMode;
    return mode === "push" || mode === "bi" ? mode : "none";
  }

  intercomRegion(): IntercomRegion {
    // Env is seeded into the row on first run (see load()); the column is NOT
    // NULL, so read it directly rather than a fallback that can never fire.
    const region = this.settings.intercomRegion;
    return region === "eu" || region === "au" ? region : "us";
  }

  // DB value is local-encrypted or vault-held (see resolveSecret). The env
  // fallback is never enc-wrapped, so it passes through plainly. A decrypt
  // failure (rotated key source) or an unreachable Vault yields null → falls
  // back to env, then null.
  intercomAccessToken(): string | null {
    return this.resolveSecret(this.settings.intercomAccessToken, "intercomAccessToken") ?? process.env.INTERCOM_ACCESS_TOKEN ?? null;
  }

  intercomClientSecret(): string | null {
    return this.resolveSecret(this.settings.intercomClientSecret, "intercomClientSecret") ?? process.env.INTERCOM_CLIENT_SECRET ?? null;
  }

  intercomAdminId(): string | null {
    return this.settings.intercomAdminId ?? process.env.INTERCOM_ADMIN_ID ?? null;
  }

  intercomOperatorAdminId(): string | null {
    return this.settings.intercomOperatorAdminId;
  }

  // Identity used for admin-side API calls: the auto-detected Operator/Fin bot
  // when available (no seat cost), otherwise the configured admin.
  intercomAuthorAdminId(): string | null {
    return this.intercomOperatorAdminId() ?? this.intercomAdminId();
  }

  intercomTeamId(): string | null {
    return this.settings.intercomTeamId ?? process.env.INTERCOM_TEAM_ID ?? null;
  }

  intercomTicketTypeMap(): Record<string, string> {
    const map = this.settings.intercomTicketTypeMap as unknown;
    if (map && typeof map === "object" && !Array.isArray(map)) {
      return map as Record<string, string>;
    }
    return {};
  }

  intercomTicketTypeIdFor(categoryId: string | null): string | null {
    const map = this.intercomTicketTypeMap();
    return (categoryId ? map[categoryId] : undefined) ?? map["_default"] ?? null;
  }

  // Deliberately does NOT require the client secret for bi: an existing
  // install running bi without one has a working OUTBOUND mirror, and gating
  // here would retroactively park every ticket outbox on deploy. The mode
  // preflight hard-blocks NEW bi flips without a secret instead.
  intercomConfigured(): boolean {
    return Boolean(this.intercomAccessToken() && this.intercomAuthorAdminId() && this.intercomTicketTypeIdFor(null));
  }

  // Status tag applied in Discord when an agent snoozes the conversation in
  // Intercom. Null = snooze events are ignored.
  intercomSnoozeStatusTagId(): string | null {
    return this.settings.intercomSnoozeStatusTagId;
  }

  // Webhook health: stamped (throttled) on every HMAC-verified inbound webhook;
  // the /config panel renders it as the "Last inbound" line.
  intercomLastInboundAt(): Date | null {
    return this.settings.intercomLastInboundAt;
  }

  async setIntercomLastInboundAt(at: Date): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { intercomLastInboundAt: at },
    });
  }

  // Last mode flip — the none→bi gap heal reads Intercom parts newer than this.
  intercomModeChangedAt(): Date | null {
    return this.settings.intercomModeChangedAt;
  }

  async setIntercomMode(mode: IntercomMode): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { intercomMode: mode, intercomModeChangedAt: new Date() },
    });
  }

  // ---- Workspace inactivity sweeper (native/unbridged conversations + tickets) ----

  inactivityEnabled(): boolean {
    return this.settings.inactivityEnabled;
  }

  inactivityAgentWaitDays(): number {
    return this.settings.inactivityAgentWaitDays;
  }

  inactivityCustomerWaitDays(): number {
    return this.settings.inactivityCustomerWaitDays;
  }

  inactivityNagsBeforeClose(): number {
    return this.settings.inactivityNagsBeforeClose;
  }

  async updateInactivity(data: {
    inactivityEnabled?: boolean;
    inactivityAgentWaitDays?: number;
    inactivityCustomerWaitDays?: number;
    inactivityNagsBeforeClose?: number;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  // ---- One-time agent-rip migration stamp ----

  agentRipMigratedAt(): Date | null {
    return this.settings.agentRipMigratedAt;
  }

  async recordAgentRipMigration(): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { agentRipMigratedAt: new Date() },
    });
  }

  // ---- Stripe webhook ingestion (dispute + early-fraud alerts) ----

  stripeWebhookEnabled(): boolean {
    return this.settings.stripeWebhookEnabled;
  }

  stripeWebhookEndpointId(): string | null {
    return this.settings.stripeWebhookEndpointId;
  }

  // Signing secret (whsec_…), local-encrypted or vault-held.
  stripeWebhookSecret(): string | null {
    return this.resolveSecret(this.settings.stripeWebhookSecret, "stripeWebhookSecret");
  }

  // Configured-ness by the RAW column (a vault:kv sentinel counts): the boot
  // reconciliation in StripeWebhookHandler.ensureEndpoint must not read "in
  // Vault but Vault is down" as "no secret" — that would recreate the endpoint
  // and rotate the signing secret on every boot during an outage.
  stripeWebhookSecretConfigured(): boolean {
    return !!this.settings.stripeWebhookSecret;
  }

  // The configured public origin (raw, for /config display).
  publicBaseUrl(): string | null {
    return this.settings.publicBaseUrl;
  }

  // Public origin for programmatic webhook registration: the configured value,
  // else the origin of POSTIZ_CALLBACK_URL (the one externally-reachable URL the
  // deploy already provides). null = unknown → registration is skipped.
  resolvedPublicBaseUrl(): string | null {
    const v = this.settings.publicBaseUrl?.trim();
    if (v) return v.replace(/\/+$/, "");
    try {
      return new URL(process.env.POSTIZ_CALLBACK_URL ?? "").origin;
    } catch {
      return null;
    }
  }

  // ---- Dispute management (/config → Billing → Disputes) ----

  disputeAutoCancelSub(): boolean {
    return this.settings.disputeAutoCancelSub;
  }

  disputeAutoBlock(): boolean {
    return this.settings.disputeAutoBlock;
  }

  // Stage the disputed charge's receipt PDF into the `receipt` evidence slot
  // when a new respondable dispute arrives. Defaults ON (unlike the other
  // auto-actions): it stages with submit:false, so nothing reaches the bank.
  disputeAutoAttachReceipt(): boolean {
    return this.settings.disputeAutoAttachReceipt;
  }

  disputeReminderDays(): number {
    return this.settings.disputeReminderDays;
  }

  disputeRatioWarnPct(): number {
    return this.settings.disputeRatioWarnPct;
  }

  disputeRatioCriticalPct(): number {
    return this.settings.disputeRatioCriticalPct;
  }

  // Last alerted ratio level — threshold alerts fire on transitions only.
  disputeRatioLastLevel(): "ok" | "warn" | "critical" {
    const v = this.settings.disputeRatioLastLevel;
    return v === "warn" || v === "critical" ? v : "ok";
  }

  // Urgent reminder tier: due within this many hours escalates the reminder.
  disputeUrgentHours(): number {
    return this.settings.disputeUrgentHours;
  }

  // Role the urgent tier mentions; null = urgent styling without a ping.
  disputeUrgentRoleId(): string | null {
    return this.settings.disputeUrgentRoleId;
  }

  disputeBackfillDoneAt(): Date | null {
    return this.settings.disputeBackfillDoneAt;
  }

  // Provisioned Radar value-list ids (not secrets — plain rsl_… ids).
  radarListId(kind: "card_fingerprint" | "email" | "customer_id" | "ip_address"): string | null {
    switch (kind) {
      case "card_fingerprint":
        return this.settings.radarListCardId;
      case "email":
        return this.settings.radarListEmailId;
      case "customer_id":
        return this.settings.radarListCustomerId;
      case "ip_address":
        return this.settings.radarListIpId;
    }
  }

  // Sentry DSN (null = disabled). DB-first with env fallback: the deploy has no
  // editable .env. `||` not `??` — an empty string stored in the DB must fall
  // through to the env var instead of silently disabling Sentry.
  sentryDsn(): string | null {
    return this.settings.sentryDsn?.trim() || process.env.SENTRY_DSN?.trim() || null;
  }

  sentryEnvironment(): string {
    return this.settings.sentryEnvironment;
  }

  sentryTracesSampleRate(): number {
    return this.settings.sentryTracesSampleRate;
  }

  sentryProfilesSampleRate(): number {
    return this.settings.sentryProfilesSampleRate;
  }

  sentryLogsEnabled(): boolean {
    return this.settings.sentryLogsEnabled;
  }

  sentryDebug(): boolean {
    return this.settings.sentryDebug;
  }

  sentrySendDefaultPii(): boolean {
    return this.settings.sentrySendDefaultPii;
  }

  sentryAiRecordContent(): boolean {
    return this.settings.sentryAiRecordContent;
  }

  // ---- InfluxDB 2.x metrics export (paired with /config → Analytics) ----

  influxEnabled(): boolean {
    return this.settings.influxEnabled;
  }

  influxUrl(): string | null {
    return this.settings.influxUrl?.trim() || null;
  }

  influxOrg(): string | null {
    return this.settings.influxOrg?.trim() || null;
  }

  influxBucket(): string | null {
    return this.settings.influxBucket?.trim() || null;
  }

  // Token is local-encrypted or vault-held. Unreadable/unreachable yields
  // null → the exporter stays inactive until the value is available again.
  influxToken(): string | null {
    return this.resolveSecret(this.settings.influxToken, "influxToken");
  }

  // True only when the DB holds a LOCAL ciphertext that no longer decrypts
  // (rotated key source) — the panel asks for re-entry. A vault:kv sentinel
  // with Vault unreachable is a different state (secretState →
  // "vault-unreachable"), not a re-enter situation.
  influxTokenUnreadable(): boolean {
    const raw = this.settings.influxToken;
    return !!raw && !isVaultKvSentinel(raw) && decryptSecret(raw) == null;
  }

  influxConfig(): InfluxRuntimeConfig {
    return {
      enabled: this.influxEnabled(),
      url: this.influxUrl(),
      org: this.influxOrg(),
      bucket: this.influxBucket(),
      token: this.influxToken(),
    };
  }

  // ---- HashiCorp Vault connection (paired with /config → Vault) ----
  // Connection settings only; the secret routing itself lives in
  // resolveSecret/routeSecretWrite above. The Vault token is the bootstrap
  // credential and is always encrypted with the LOCAL key (crypto.ts) — Vault
  // can't wrap its own token.

  vaultEnabled(): boolean {
    return this.settings.vaultEnabled;
  }

  vaultAddr(): string | null {
    return this.settings.vaultAddr?.trim() || null;
  }

  vaultToken(): string | null {
    const raw = this.settings.vaultToken;
    return raw != null ? decryptSecret(raw) : null;
  }

  // Local ciphertext present but no longer decryptable (rotated key source) —
  // the panel asks for re-entry.
  vaultTokenUnreadable(): boolean {
    return this.settings.vaultToken != null && this.vaultToken() == null;
  }

  vaultKvMount(): string {
    return this.settings.vaultKvMount?.trim() || "kv";
  }

  vaultKvBasePath(): string {
    return this.settings.vaultKvBasePath?.trim().replace(/^\/+|\/+$/g, "") || "support-bot";
  }

  vaultTransitMount(): string {
    return this.settings.vaultTransitMount?.trim() || "transit";
  }

  vaultTransitKey(): string {
    return this.settings.vaultTransitKey?.trim() || "support-bot";
  }

  // Storage cutover stamp: null = secrets live in Postgres columns; set = the
  // globals live in KV and user tokens are Transit-encrypted.
  vaultMigratedAt(): Date | null {
    return this.settings.vaultMigratedAt;
  }

  vaultConfig(): VaultRuntimeConfig {
    return {
      enabled: this.vaultEnabled(),
      addr: this.vaultAddr(),
      token: this.vaultToken(),
      kvMount: this.vaultKvMount(),
      kvBasePath: this.vaultKvBasePath(),
      transitMount: this.vaultTransitMount(),
      transitKey: this.vaultTransitKey(),
    };
  }

  // ---- AI ticket scoring (Batch API) ----

  // ---- Evaluation escalation (daily re-score of flagged tickets, ~12x/ticket) ----

  // The Influx token is encrypted at rest; pass a field as undefined to leave it
  // unchanged, null/"" to clear it.
  async updateAnalytics(data: {
    influxEnabled?: boolean;
    influxUrl?: string | null;
    influxOrg?: string | null;
    influxBucket?: string | null;
    influxToken?: string | null;
  }): Promise<void> {
    const { influxToken, ...rest } = data;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: {
        ...rest,
        ...(influxToken !== undefined ? { influxToken: await this.routeSecretWrite("influxToken", influxToken) } : {}),
      },
    });
  }

  // Vault connection settings. The token is encrypted at rest with the LOCAL
  // key (bootstrap credential); pass a field as undefined to leave it
  // unchanged, null/"" to clear it. Callers follow up with
  // vaultService.reconfigure() so the live client matches.
  async updateVault(data: {
    vaultEnabled?: boolean;
    vaultAddr?: string | null;
    vaultToken?: string | null;
    vaultKvMount?: string;
    vaultKvBasePath?: string;
    vaultTransitMount?: string;
    vaultTransitKey?: string;
    vaultMigratedAt?: Date | null;
  }): Promise<void> {
    const { vaultToken, ...rest } = data;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: {
        ...rest,
        ...(vaultToken !== undefined ? { vaultToken: vaultToken ? encryptSecret(vaultToken) : vaultToken } : {}),
      },
    });
  }

  // ---- Temporal (edited via /config → Temporal; certs live in Vault KV) ----

  // Worker pause switch: ON = the worker polls and owns all background work;
  // OFF = the worker is drained and background work pauses (signals park
  // server-side; no legacy fallback exists).
  temporalEnabled(): boolean {
    return this.settings.temporalEnabled;
  }

  // Connection values live in BotSettings (the deploy has no .env access);
  // the TEMPORAL_* env vars are first-boot fallbacks only, same pattern as
  // the INTERCOM_* getters above.
  temporalAddress(): string | null {
    return this.settings.temporalAddress?.trim() || (process.env.TEMPORAL_ADDRESS ?? "").trim() || null;
  }

  temporalNamespace(): string | null {
    return this.settings.temporalNamespace?.trim() || (process.env.TEMPORAL_NAMESPACE ?? "").trim() || null;
  }

  temporalTaskQueue(): string {
    return this.settings.temporalTaskQueue?.trim() || (process.env.TEMPORAL_TASK_QUEUE ?? "").trim() || "support-bot";
  }

  temporalDeploymentName(): string {
    return this.settings.temporalDeploymentName?.trim() || (process.env.TEMPORAL_DEPLOYMENT_NAME ?? "").trim() || "support-bot";
  }

  // TLS SNI / server-name override for dialing by IP while the server cert
  // carries a hostname. Null = let gRPC derive it from the address.
  temporalTlsServerName(): string | null {
    return this.settings.temporalTlsServerName?.trim() || (process.env.TEMPORAL_TLS_SERVER_NAME ?? "").trim() || null;
  }

  // Stamp of the one-time legacy-state import into workflows (open tickets,
  // pending outbox/inbox rows). Null = never ran.
  temporalImportDoneAt(): Date | null {
    return this.settings.temporalImportDoneAt;
  }

  async updateTemporal(data: {
    temporalEnabled?: boolean;
    temporalAddress?: string | null;
    temporalNamespace?: string | null;
    temporalTaskQueue?: string;
    temporalDeploymentName?: string;
    temporalTlsServerName?: string | null;
    temporalImportDoneAt?: Date | null;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data,
    });
  }

  sentryConfig(): SentryRuntimeConfig {
    return {
      dsn: this.sentryDsn(),
      environment: this.sentryEnvironment(),
      tracesSampleRate: this.sentryTracesSampleRate(),
      profilesSampleRate: this.sentryProfilesSampleRate(),
      logsEnabled: this.sentryLogsEnabled(),
      debug: this.sentryDebug(),
      sendDefaultPii: this.sentrySendDefaultPii(),
      aiRecordContent: this.sentryAiRecordContent(),
    };
  }

  async updateSentry(data: {
    sentryDsn?: string | null;
    sentryEnvironment?: string;
    sentryTracesSampleRate?: number;
    sentryProfilesSampleRate?: number;
    sentryLogsEnabled?: boolean;
    sentryDebug?: boolean;
    sentrySendDefaultPii?: boolean;
    sentryAiRecordContent?: boolean;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data,
    });
  }

  async updateIntercom(data: {
    intercomMode?: IntercomMode;
    intercomRegion?: IntercomRegion;
    intercomAccessToken?: string | null;
    intercomClientSecret?: string | null;
    intercomAdminId?: string | null;
    intercomOperatorAdminId?: string | null;
    intercomTicketTypeMap?: Record<string, string> | null;
    intercomTeamId?: string | null;
    intercomSnoozeStatusTagId?: string | null;
  }): Promise<void> {
    const { intercomTicketTypeMap, intercomAccessToken, intercomClientSecret, ...rest } = data;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: {
        ...rest,
        // Secrets route vault-first with local-encryption fallback; an empty
        // string / null clears them.
        ...(intercomAccessToken !== undefined
          ? { intercomAccessToken: await this.routeSecretWrite("intercomAccessToken", intercomAccessToken) }
          : {}),
        ...(intercomClientSecret !== undefined
          ? { intercomClientSecret: await this.routeSecretWrite("intercomClientSecret", intercomClientSecret) }
          : {}),
        // Nullable JSON columns need the DbNull sentinel instead of null.
        ...(intercomTicketTypeMap !== undefined
          ? { intercomTicketTypeMap: intercomTicketTypeMap ?? Prisma.DbNull }
          : {}),
      },
    });
  }

  async setTagIntercomState(tagId: string, stateId: string | null): Promise<void> {
    await this.prisma.statusTag.update({ where: { id: tagId }, data: { intercomTicketStateId: stateId } });
    await this.refreshTags();
  }

  async updateGeneral(data: {
    threadsChannelId?: string | null;
    supportRoleId?: string | null;
    githubRepo?: string | null;
    aiModel?: string;
    aiModelLight?: string;
    aiEffortAsk?: string;
    aiMaxBudgetUsdAsk?: number;
    maxOpenTicketsPerUser?: number;
    ticketCooldownMinutes?: number;
    auditLogChannelId?: string | null;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  async updateBilling(data: {
    billingAuditChannelId?: string | null;
    refundMaxAmount?: number | null;
    refundMaxAmountCurrency?: string;
    refundMaxPer24h?: number | null;
    refundMaxPer24hPerUser?: number | null;
    refundMinMemberAgeDays?: number | null;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  async updateKnowledge(data: { kbRefreshEnabled?: boolean; kbRefreshIntervalHours?: number }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  async recordKbRefresh(): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { kbLastRefreshAt: new Date() },
    });
  }

  // The signing secret routes vault-first with local fallback; other fields
  // pass through. Pass a field as undefined to leave it unchanged (null clears it).
  async updateStripeWebhook(data: {
    stripeWebhookEnabled?: boolean;
    stripeWebhookEndpointId?: string | null;
    stripeWebhookSecret?: string | null;
    publicBaseUrl?: string | null;
  }): Promise<void> {
    const { stripeWebhookSecret, ...rest } = data;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: {
        ...rest,
        ...(stripeWebhookSecret !== undefined
          ? { stripeWebhookSecret: await this.routeSecretWrite("stripeWebhookSecret", stripeWebhookSecret) }
          : {}),
      },
    });
  }

  async updateAllowedPriceIds(priceIds: string[]): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { allowedPriceIds: priceIds.join(",") },
    });
  }

  async updateDisputes(data: {
    disputeAutoCancelSub?: boolean;
    disputeAutoBlock?: boolean;
    disputeAutoAttachReceipt?: boolean;
    disputeReminderDays?: number;
    disputeRatioWarnPct?: number;
    disputeRatioCriticalPct?: number;
    disputeUrgentHours?: number;
    disputeUrgentRoleId?: string | null;
    disputeBackfillDoneAt?: Date;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  async updateRadarLists(data: {
    radarListCardId?: string | null;
    radarListEmailId?: string | null;
    radarListCustomerId?: string | null;
    radarListIpId?: string | null;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  async setDisputeRatioLevel(level: "ok" | "warn" | "critical"): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { disputeRatioLastLevel: level },
    });
  }

  async markBackfillDone(): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { backfillDone: true },
    });
  }

  async addTag(input: TagInput): Promise<StatusTag> {
    if (this.tagByEmoji(input.emoji.trim())) {
      throw new Error(`A tag with the emoji ${input.emoji.trim()} already exists.`);
    }
    const nextOrder = this.tagList.reduce((max, t) => Math.max(max, t.sortOrder), -1) + 1;
    const created = await this.prisma.$transaction(async (tx) => {
      if (input.isInitial) {
        await tx.statusTag.updateMany({ data: { isInitial: false } });
      }
      if (input.isCustomerReplyTarget) {
        await tx.statusTag.updateMany({ data: { isCustomerReplyTarget: false } });
      }
      return tx.statusTag.create({
        data: {
          emoji: input.emoji.trim(),
          label: input.label.trim(),
          isInitial: input.isInitial ?? false,
          closesThread: input.closesThread ?? false,
          reminderEnabled: input.reminderEnabled ?? false,
          reminderDays: input.reminderDays ?? 3,
          reminderTarget: input.reminderTarget ?? "SUPPORT",
          autoCloseAfter: input.autoCloseAfter ?? null,
          isCustomerReplyTarget: input.isCustomerReplyTarget ?? false,
          sortOrder: nextOrder,
        },
      });
    });
    await this.refreshTags();
    return created;
  }

  async editTag(id: string, input: Partial<TagInput>): Promise<StatusTag> {
    if (input.emoji) {
      const clash = this.tagByEmoji(input.emoji.trim());
      if (clash && clash.id !== id) {
        throw new Error(`A tag with the emoji ${input.emoji.trim()} already exists.`);
      }
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.isInitial) {
        await tx.statusTag.updateMany({ where: { id: { not: id } }, data: { isInitial: false } });
      }
      if (input.isCustomerReplyTarget) {
        await tx.statusTag.updateMany({ where: { id: { not: id } }, data: { isCustomerReplyTarget: false } });
      }
      return tx.statusTag.update({
        where: { id },
        data: {
          ...(input.emoji !== undefined ? { emoji: input.emoji.trim() } : {}),
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.isInitial !== undefined ? { isInitial: input.isInitial } : {}),
          ...(input.closesThread !== undefined ? { closesThread: input.closesThread } : {}),
          ...(input.reminderEnabled !== undefined ? { reminderEnabled: input.reminderEnabled } : {}),
          ...(input.reminderDays !== undefined ? { reminderDays: input.reminderDays } : {}),
          ...(input.reminderTarget !== undefined ? { reminderTarget: input.reminderTarget } : {}),
          ...(input.autoCloseAfter !== undefined ? { autoCloseAfter: input.autoCloseAfter } : {}),
          ...(input.isCustomerReplyTarget !== undefined ? { isCustomerReplyTarget: input.isCustomerReplyTarget } : {}),
        },
      });
    });
    await this.refreshTags();
    return updated;
  }

  // Deletes a tag, reassigning any open tickets that used it back to the initial
  // tag. Returns the threadIds of reassigned tickets so callers can rename them.
  async removeTag(id: string): Promise<{ reassignedThreadIds: string[]; initial: StatusTag }> {
    const tag = this.tagById(id);
    if (!tag) throw new Error("Tag not found.");
    if (tag.isInitial) throw new Error("The initial tag can't be removed. Mark another tag as initial first.");
    const initial = this.initialTag();
    if (!initial) throw new Error("No initial tag is configured.");

    const affected = await this.prisma.ticket.findMany({
      where: { statusTagId: id, closed: false },
      select: { threadId: true },
    });

    await this.prisma.$transaction([
      this.prisma.ticket.updateMany({
        where: { statusTagId: id },
        data: {
          statusTagId: initial.id,
          lastStatusChangeAt: new Date(),
          lastReminderAt: null,
          reminderCount: 0,
          remindersPaused: false,
          closed: false,
          closedAt: null,
        },
      }),
      this.prisma.statusTag.delete({ where: { id } }),
    ]);

    await this.refreshTags();
    return { reassignedThreadIds: affected.map((t) => t.threadId), initial };
  }

  // Moves a status tag one slot up/down in the display order. Renumbers the whole
  // list to a contiguous 0..n-1 sortOrder so a move is reliable even if existing
  // values were duplicated or sparse. No-op when already at the requested edge.
  async moveTag(id: string, direction: "up" | "down"): Promise<void> {
    const order = [...this.tagList]; // already sorted by sortOrder asc
    const idx = order.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error("Tag not found.");
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= order.length) return;
    [order[idx], order[swapIdx]] = [order[swapIdx], order[idx]];
    await this.prisma.$transaction(
      order.map((t, i) => this.prisma.statusTag.update({ where: { id: t.id }, data: { sortOrder: i } }))
    );
    await this.refreshTags();
  }

}
