import { randomBytes } from "node:crypto";
import { Prisma, PrismaClient, BotSettings, StatusTag } from "../generated/prisma/client";
import type { SentryRuntimeConfig } from "../util/logger";
import type { InfluxRuntimeConfig } from "../metrics/InfluxWriter";
import { decryptSecret, encryptSecret, isVaultKvSentinel, VAULT_KV_SENTINEL } from "../util/crypto";
import { ENV_PINS, envBool, envPin, envStr } from "./env";
import type { VaultIntegration, VaultRuntimeConfig, VaultService } from "../vault/VaultService";
import type { SlaTargetEntry } from "../sla/types";
import { parseOfficeHours, type OfficeHoursSchedule } from "../sla/businessTime";
import {
  parseTeamSettingsMap,
  parseCursorMap,
  parseExcludedAdmins,
  mergeEntry,
  stripFields,
  type TeamSettingsEntry,
} from "./teamSettings";

export type { TeamSettingsEntry } from "./teamSettings";

export type ReminderTarget = "SUPPORT" | "CUSTOMER";

// UI scope sentinel for editing the workspace default (vs a real team id).
export const DEFAULT_SETTINGS_SCOPE = "__default__";

export type IntercomMode = "none" | "push" | "bi";
export type IntercomRegion = "us" | "eu" | "au";

// Access level for one canvas/panel billing action: "none" disables it for
// EVERYONE (admins included), "approval" lets agents queue it for admin
// approval (admins execute directly), "admin" lets ONLY admins execute
// (agents get nothing — not even a queue request), "all" lets agents execute
// directly too.
export type BillingActionLevel = "none" | "approval" | "admin" | "all";

// Dashboard allowlist role: "admin" = full authority (per-action levels still
// apply), "operator" = read-only + registry actions at their configured level.
export type DashboardAdminRole = "admin" | "operator";

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
  // Per-tag overrides ({days} placeholder; null clears back to the built-in
  // default text / reminderDays cadence).
  reminderTextCustomer?: string | null;
  reminderTextSupport?: string | null;
  reminderRepeatDays?: number | null;
  autoCloseMessage?: string | null;
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

// The nine global secrets and their Vault KV home (one KV entry per
// integration; field names live inside the entry). Shared by the read
// resolver, the write router, the panel state helper and the migrator.
export type GlobalSecretColumn =
  | "intercomAccessToken"
  | "intercomClientSecret"
  | "stripeWebhookSecret"
  | "stripeSecretKey"
  | "sentryReadToken"
  | "sentryWebhookSecret"
  | "influxToken"
  | "yubicoApiSecret"
  | "postizApiKey";

export const GLOBAL_SECRETS: Record<GlobalSecretColumn, { integration: VaultIntegration; field: string }> = {
  intercomAccessToken: { integration: "intercom", field: "accessToken" },
  intercomClientSecret: { integration: "intercom", field: "clientSecret" },
  stripeWebhookSecret: { integration: "stripe", field: "webhookSecret" },
  stripeSecretKey: { integration: "stripe", field: "secretKey" },
  sentryReadToken: { integration: "sentry", field: "readToken" },
  sentryWebhookSecret: { integration: "sentry", field: "webhookSecret" },
  influxToken: { integration: "influx", field: "token" },
  yubicoApiSecret: { integration: "yubico", field: "apiSecret" },
  postizApiKey: { integration: "postiz", field: "apiKey" },
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
  private vault: VaultService | null = null;

  constructor(private prisma: PrismaClient) {}

  // Late-bound (same idiom as AuditLogger.bindClient): SettingsStore is
  // constructed before the VaultService that depends on it. Until bound,
  // vault-held secrets resolve to null — identical to Vault-down degradation.
  bindVault(vault: VaultService): void {
    this.vault = vault;
  }

  // ---- Vault secret plumbing (the eight GLOBAL_SECRETS columns) ----

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
  }

  private async refreshTags(): Promise<void> {
    this.tagList = await this.prisma.statusTag.findMany({ orderBy: { sortOrder: "asc" } });
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

  // null = guardrail disabled. Self-service refunds only for charges younger
  // than this many days; older charges go to manual review.
  refundMaxChargeAgeDays(): number | null {
    return this.settings.refundMaxChargeAgeDays;
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

  // ---- Workspace customer-idle sweeper (native/unbridged conversations) ----
  // The agent-idle half is retired: agent nags are SLA-breach-driven now (see
  // the SLA enforcer + slaNagRepeatMins/slaNagNoteText). The inactivityAgentWaitDays
  // and inactivityAgentNoteText columns are retained (unused) to avoid a
  // no-runtime-migration drop; nothing reads them.

  inactivityEnabled(): boolean {
    return this.settings.inactivityEnabled;
  }

  inactivityCustomerWaitDays(): number {
    return this.settings.inactivityCustomerWaitDays;
  }

  inactivityNagsBeforeClose(): number {
    return this.settings.inactivityNagsBeforeClose;
  }

  // Customer-idle nag text override ({days} placeholder). Null = built-in default.
  inactivityNagText(): string | null {
    return this.settings.inactivityNagText;
  }

  async updateInactivity(data: {
    inactivityEnabled?: boolean;
    inactivityCustomerWaitDays?: number;
    inactivityNagsBeforeClose?: number;
    inactivityNagText?: string | null;
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

  // ---- Stripe API key ----

  // The account API key (sk_…), local-encrypted or vault-held, with the boot
  // env var as fallback (Intercom-style). The env var never goes away: it is
  // required at boot and feeds the local encryption key derivation
  // (src/util/crypto.ts); the managed copy simply wins so the key can be
  // rotated without touching the deploy.
  stripeSecretKey(): string | null {
    return this.resolveSecret(this.settings.stripeSecretKey, "stripeSecretKey") ?? process.env.STRIPE_SECRET_KEY ?? null;
  }

  // Routes vault-first with local fallback (used by the boot seed; a /config
  // modal will reuse it). null clears the managed copy — reads fall back to env.
  async updateStripeSecretKey(value: string | null): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { stripeSecretKey: await this.routeSecretWrite("stripeSecretKey", value) },
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

  // ---- Intercom billing actions (canvas approve/deny + Stripe panel) ----

  // Intercom teammates who count as billing admins for canvas/panel actions
  // (names snapshotted for display; ids are the authority).
  intercomPanelAdmins(): Array<{ id: string; name: string }> {
    const raw = this.settings.intercomPanelAdminsJson as unknown;
    if (!Array.isArray(raw)) return [];
    const out: Array<{ id: string; name: string }> = [];
    for (const entry of raw) {
      if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
        const id = (entry as { id: string }).id;
        const name = (entry as { name?: unknown }).name;
        out.push({ id, name: typeof name === "string" && name ? name : id });
      }
    }
    return out;
  }

  isIntercomPanelAdmin(adminId: string): boolean {
    return this.intercomPanelAdmins().some((a) => a.id === adminId);
  }

  async updateIntercomPanelAdmins(admins: Array<{ id: string; name: string }>): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { intercomPanelAdminsJson: admins },
    });
  }

  // Raw per-action level map ({ "<actionKey>": "none" | "approval" | "all" }).
  billingActionLevels(): Record<string, string> {
    const raw = this.settings.billingActionLevelsJson as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, string>;
    return {};
  }

  // Coerced level for one action; a missing/invalid entry falls back to the
  // action's registry default (safety: a bad /config value can never widen
  // access past the registry default).
  billingActionLevel(key: string, registryDefault: BillingActionLevel): BillingActionLevel {
    const v = this.billingActionLevels()[key];
    return v === "none" || v === "approval" || v === "admin" || v === "all" ? v : registryDefault;
  }

  async updateBillingActionLevel(key: string, level: BillingActionLevel): Promise<void> {
    // Read-modify-write of the single-row JSON map — contention-free in
    // practice (config edits are admin-manual).
    const map = { ...this.billingActionLevels(), [key]: level };
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { billingActionLevelsJson: map },
    });
  }

  // Panel-token HMAC key: machine-generated, encrypted with the LOCAL crypto
  // key (deliberately NOT vault-routed — it signs short-lived links, and
  // rotation is just clearing the column). Never displayed or echoed.
  panelTokenSecret(): string | null {
    const raw = this.settings.panelTokenSecret;
    return raw ? decryptSecret(raw) : null;
  }

  async ensurePanelTokenSecret(): Promise<string> {
    const existing = this.panelTokenSecret();
    if (existing) return existing;
    const secret = randomBytes(32).toString("hex");
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { panelTokenSecret: encryptSecret(secret) },
    });
    return secret;
  }

  // Panel link/session revocation epoch: minted tokens embed it; bumping it
  // ("Revoke Stripe Panel Links" in /intercom → Maintenance) invalidates every
  // outstanding link and session instantly.
  panelTokenEpoch(): number {
    return this.settings.panelTokenEpoch;
  }

  async bumpPanelTokenEpoch(): Promise<number> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { panelTokenEpoch: { increment: 1 } },
    });
    return this.settings.panelTokenEpoch;
  }

  // Admin web-panel (/config + /intercom) revocation epoch — a separate lever
  // from panelTokenEpoch so "Revoke Admin Panel Links" and "Revoke Stripe Panel
  // Links" are independent. Admin tokens/sessions embed this value.
  adminPanelEpoch(): number {
    return this.settings.adminPanelEpoch;
  }

  async bumpAdminPanelEpoch(): Promise<number> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { adminPanelEpoch: { increment: 1 } },
    });
    return this.settings.adminPanelEpoch;
  }

  // ---- Stripe dashboard (/dashboard) ----

  // Kill switch: the /dashboard routes answer 404 while off. Default OFF —
  // enabling is a deliberate Discord-side act (Dashboard hub). The web surface
  // itself may only ever DISABLE (ratchet asymmetry: a compromised session can
  // reduce its own privilege but never restore it).
  dashboardEnabled(): boolean {
    return this.settings.dashboardEnabled;
  }

  async updateDashboardEnabled(enabled: boolean): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { dashboardEnabled: enabled },
    });
  }

  // Dashboard allowlist: Discord user ids are the authority (names snapshotted
  // for display, role defaults to "admin"). Checked at mint AND re-checked on
  // every authenticated request — removal applies to live sessions immediately.
  dashboardAdmins(): Array<{ id: string; name: string; role: DashboardAdminRole }> {
    const raw = this.settings.dashboardAdminsJson as unknown;
    if (!Array.isArray(raw)) return [];
    const out: Array<{ id: string; name: string; role: DashboardAdminRole }> = [];
    for (const entry of raw) {
      if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
        const id = (entry as { id: string }).id;
        const name = (entry as { name?: unknown }).name;
        const role = (entry as { role?: unknown }).role;
        out.push({
          id,
          name: typeof name === "string" && name ? name : id,
          role: role === "operator" ? "operator" : "admin",
        });
      }
    }
    return out;
  }

  // null = not on the allowlist (may not open the dashboard at all).
  dashboardAdminRole(userId: string): DashboardAdminRole | null {
    return this.dashboardAdmins().find((a) => a.id === userId)?.role ?? null;
  }

  async updateDashboardAdmins(admins: Array<{ id: string; name: string; role: DashboardAdminRole }>): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { dashboardAdminsJson: admins },
    });
  }

  // Dashboard token HMAC key — separate column from panelTokenSecret so the
  // dashboard's links (which later include ENROLL links) have an independent
  // blast radius and rotation lever. Same local-crypto storage idiom.
  dashboardTokenSecret(): string | null {
    const raw = this.settings.dashboardTokenSecret;
    return raw ? decryptSecret(raw) : null;
  }

  async ensureDashboardTokenSecret(): Promise<string> {
    const existing = this.dashboardTokenSecret();
    if (existing) return existing;
    const secret = randomBytes(32).toString("hex");
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { dashboardTokenSecret: encryptSecret(secret) },
    });
    return secret;
  }

  // Dashboard revocation epoch: tokens + sessions embed it; bumping ("Revoke
  // dashboard links" / LOCKDOWN) invalidates everything outstanding instantly.
  dashboardEpoch(): number {
    return this.settings.dashboardEpoch;
  }

  async bumpDashboardEpoch(): Promise<number> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { dashboardEpoch: { increment: 1 } },
    });
    return this.settings.dashboardEpoch;
  }

  // ---- YubiKey OTP sign-in (dashboard) ----

  // Yubico validation-protocol client id (upgrade.yubico.com/getapikey).
  // Blank disables the yubikey login/step-up/enrollment paths entirely.
  yubicoClientId(): string | null {
    return this.settings.yubicoClientId?.trim() || null;
  }

  // Optional API secret (base64): signs verify requests and authenticates
  // responses. Vault-routed like every global secret.
  yubicoApiSecret(): string | null {
    return this.resolveSecret(this.settings.yubicoApiSecret, "yubicoApiSecret");
  }

  // Optional self-hosted validation server (public https verify URL).
  // Blank = YubiCloud.
  yubicoValidationUrl(): string | null {
    return this.settings.yubicoValidationUrl?.trim() || null;
  }

  async updateYubicoSettings(data: {
    yubicoClientId?: string | null;
    yubicoApiSecret?: string | null;
    yubicoValidationUrl?: string | null;
  }): Promise<void> {
    const { yubicoApiSecret, ...rest } = data;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: {
        ...rest,
        ...(yubicoApiSecret !== undefined
          ? { yubicoApiSecret: await this.routeSecretWrite("yubicoApiSecret", yubicoApiSecret) }
          : {}),
      },
    });
  }

  // ---- SLA manager (/intercom → SLA Manager) ----
  // The bot IS the SLA engine (Advanced tier has no native SLAs): rules pick a
  // target, targets carry business-minute clock durations, and the 5-min
  // enforcement looper runs the clocks.

  slaEnabled(): boolean {
    return this.settings.slaEnabled;
  }

  // No-match value written to the attribute; null = clear a previously-written
  // value (no clocks run for a conversation without a target).
  slaDefaultTarget(): string | null {
    return this.settings.slaDefaultTarget;
  }

  slaAttributeName(): string {
    return this.settings.slaAttributeName || "SLA Target";
  }

  // List conversation attribute the enforcement looper writes ok | at_risk |
  // breached to. Created manually in Intercom (the API can't create
  // conversation attributes) — Verify Setup checks it exists.
  slaStatusAttributeName(): string {
    return this.settings.slaStatusAttributeName || "SLA Status";
  }

  slaBreachTagName(): string {
    return this.settings.slaBreachTagName || "sla-breached";
  }

  // Global at_risk threshold as % of the target duration (per-target override
  // lives on the registry entry).
  slaWarnPct(): number {
    const raw = this.settings.slaWarnPct;
    if (!Number.isFinite(raw)) return 80;
    return Math.min(99, Math.max(1, Math.trunc(raw)));
  }

  // Recurring agent-nag cadence in BUSINESS minutes: while a first-reply or
  // next-reply clock is breached, the enforcement sweep re-posts the breach
  // note once per this interval of business time. Floored at 1 minute.
  slaNagRepeatMins(): number {
    const raw = this.settings.slaNagRepeatMins;
    if (!Number.isFinite(raw)) return 240;
    return Math.max(1, Math.trunc(raw));
  }

  // Override copy for the recurring agent nag ({clock}/{target}/{overdue}/{team}
  // placeholders). Null = built-in rich SLA-breach format.
  slaNagNoteText(): string | null {
    return this.settings.slaNagNoteText;
  }

  // Managed target registry: every rule target and the default target must
  // reference an entry. Durations are business minutes; a clock left unset is
  // disabled for that target.
  slaTargets(): SlaTargetEntry[] {
    const raw = this.settings.slaTargetsJson as unknown;
    if (!Array.isArray(raw)) return [];
    const mins = (v: unknown): number | undefined => {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
    };
    return raw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as { value?: unknown }).value === "string")
      .map((e) => {
        const warn = mins(e.warnPct);
        return {
          value: e.value as string,
          note: typeof e.note === "string" ? e.note : "",
          firstReplyMins: mins(e.firstReplyMins),
          nextReplyMins: mins(e.nextReplyMins),
          resolveMins: mins(e.resolveMins),
          warnPct: warn !== undefined ? Math.min(99, Math.max(1, warn)) : undefined,
        };
      });
  }

  slaTargetExists(value: string): boolean {
    return this.slaTargets().some((t) => t.value === value);
  }

  async updateSla(data: {
    slaEnabled?: boolean;
    slaDefaultTarget?: string | null;
    slaAttributeName?: string;
    slaStatusAttributeName?: string;
    slaBreachTagName?: string;
    slaWarnPct?: number;
    slaNagRepeatMins?: number;
    slaNagNoteText?: string | null;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
  }

  async updateSlaTargets(targets: SlaTargetEntry[]): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { slaTargetsJson: targets as unknown as Prisma.InputJsonValue },
    });
  }

  // ---- Office hours + balanced assignment (per-team, workspace-default fallback) ----
  //
  // Both features were per-team on Intercom Expert. The BotSettings columns
  // below are the WORKSPACE DEFAULT; teamSettingsJson holds per-team overrides
  // that layer on per-field (any absent field inherits the default). A
  // conversation resolves its config from its own team (team_assignee_id);
  // teamId null or an un-overridden team falls back to the default. The
  // "__default__" scope sentinel edits the default itself from the UI.

  // Workspace-default getters (also the fallback for un-overridden teams).
  officeHoursEnabled(): boolean {
    return this.settings.officeHoursEnabled;
  }

  officeHours(): OfficeHoursSchedule | null {
    const raw = this.settings.officeHoursJson as unknown;
    return raw == null ? null : parseOfficeHours(raw);
  }

  assignEnabled(): boolean {
    return this.settings.assignEnabled;
  }

  assignExcludedAdmins(): Array<{ id: string; name: string }> {
    return parseExcludedAdmins(this.settings.assignExcludedAdminsJson);
  }

  // Per-team override map (parsed defensively; unknown fields dropped).
  private teamSettingsMap(): Record<string, TeamSettingsEntry> {
    return parseTeamSettingsMap(this.settings.teamSettingsJson);
  }

  teamOverride(teamId: string): TeamSettingsEntry | null {
    return this.teamSettingsMap()[teamId] ?? null;
  }

  // Teams that carry an explicit override (for the UI badge + "configured" list).
  listTeamOverrides(): Array<{ teamId: string; entry: TeamSettingsEntry }> {
    return Object.entries(this.teamSettingsMap()).map(([teamId, entry]) => ({ teamId, entry }));
  }

  // ---- runtime resolution (teamId null → default) ----

  resolveAssignEnabled(teamId: string | null): boolean {
    const e = teamId ? this.teamOverride(teamId) : null;
    return e?.assignEnabled ?? this.settings.assignEnabled;
  }

  // Cheap gate for the enforcement tick: is bot assignment on for the default
  // or ANY team override? False → the stray-assignment pass is skipped wholesale.
  anyAssignmentEnabled(): boolean {
    if (this.settings.assignEnabled) return true;
    return this.listTeamOverrides().some((o) => o.entry.assignEnabled === true);
  }

  resolveAssignExcludedAdmins(teamId: string | null): Array<{ id: string; name: string }> {
    const e = teamId ? this.teamOverride(teamId) : null;
    return e?.assignExcludedAdmins ?? this.assignExcludedAdmins();
  }

  resolveOfficeHoursEnabled(teamId: string | null): boolean {
    const e = teamId ? this.teamOverride(teamId) : null;
    return e?.officeHoursEnabled ?? this.settings.officeHoursEnabled;
  }

  // Effective office-hours schedule for a conversation's team: null (wall
  // clock) unless resolved-enabled AND the resolved JSON parses. Per-field:
  // a team can enable hours and inherit the default schedule, or set its own.
  resolveOfficeHours(teamId: string | null): OfficeHoursSchedule | null {
    const e = teamId ? this.teamOverride(teamId) : null;
    const enabled = e?.officeHoursEnabled ?? this.settings.officeHoursEnabled;
    if (!enabled) return null;
    const raw = (e?.officeHoursJson ?? this.settings.officeHoursJson) as unknown;
    return raw == null ? null : parseOfficeHours(raw);
  }

  // ---- per-team rotation cursors (operational state, always per-team) ----

  private rotationCursors(): Record<string, string> {
    return parseCursorMap(this.settings.assignRotationCursorsJson);
  }

  teamRotationCursor(teamId: string): string | null {
    return this.rotationCursors()[teamId] ?? null;
  }

  // Engine-written (every bot assignment advances it). Merges into the map so
  // the hot path only touches one team's cursor.
  async setTeamRotationCursor(teamId: string, adminId: string | null): Promise<void> {
    const map = this.rotationCursors();
    if (adminId == null) delete map[teamId];
    else map[teamId] = adminId;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { assignRotationCursorsJson: map as unknown as Prisma.InputJsonValue },
    });
  }

  // ---- scoped updaters (scope = DEFAULT_SETTINGS_SCOPE or a real team id) ----

  async updateOfficeHoursScoped(
    scope: string,
    teamName: string | null,
    data: { officeHoursEnabled?: boolean; officeHoursJson?: OfficeHoursSchedule }
  ): Promise<void> {
    if (scope === DEFAULT_SETTINGS_SCOPE) {
      this.settings = await this.prisma.botSettings.update({
        where: { id: "global" },
        data: {
          ...(data.officeHoursEnabled !== undefined ? { officeHoursEnabled: data.officeHoursEnabled } : {}),
          ...(data.officeHoursJson !== undefined ? { officeHoursJson: data.officeHoursJson as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      return;
    }
    await this.mergeTeamOverride(scope, teamName, {
      ...(data.officeHoursEnabled !== undefined ? { officeHoursEnabled: data.officeHoursEnabled } : {}),
      ...(data.officeHoursJson !== undefined ? { officeHoursJson: data.officeHoursJson } : {}),
    });
  }

  async updateAssignmentScoped(
    scope: string,
    teamName: string | null,
    data: { assignEnabled?: boolean; assignExcludedAdmins?: Array<{ id: string; name: string }> }
  ): Promise<void> {
    if (scope === DEFAULT_SETTINGS_SCOPE) {
      this.settings = await this.prisma.botSettings.update({
        where: { id: "global" },
        data: {
          ...(data.assignEnabled !== undefined ? { assignEnabled: data.assignEnabled } : {}),
          ...(data.assignExcludedAdmins !== undefined
            ? { assignExcludedAdminsJson: data.assignExcludedAdmins as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });
      return;
    }
    await this.mergeTeamOverride(scope, teamName, {
      ...(data.assignEnabled !== undefined ? { assignEnabled: data.assignEnabled } : {}),
      ...(data.assignExcludedAdmins !== undefined ? { assignExcludedAdmins: data.assignExcludedAdmins } : {}),
    });
  }

  private async mergeTeamOverride(teamId: string, teamName: string | null, patch: TeamSettingsEntry): Promise<void> {
    const map = mergeEntry(this.teamSettingsMap(), teamId, teamName, patch);
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { teamSettingsJson: map as unknown as Prisma.InputJsonValue },
    });
  }

  // Drop a team's entire override (revert BOTH concerns to the default).
  async clearTeamOverride(teamId: string): Promise<void> {
    await this.stripTeamFields(teamId, ["assignEnabled", "assignExcludedAdmins", "officeHoursEnabled", "officeHoursJson"]);
  }

  // Revert just the assignment concern for a team (keeps any office-hours override).
  async clearTeamAssignOverride(teamId: string): Promise<void> {
    await this.stripTeamFields(teamId, ["assignEnabled", "assignExcludedAdmins"]);
  }

  // Revert just the office-hours concern for a team (keeps any assignment override).
  async clearTeamOfficeHoursOverride(teamId: string): Promise<void> {
    await this.stripTeamFields(teamId, ["officeHoursEnabled", "officeHoursJson"]);
  }

  private async stripTeamFields(teamId: string, fields: Array<keyof TeamSettingsEntry>): Promise<void> {
    const map = stripFields(this.teamSettingsMap(), teamId, fields);
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: { teamSettingsJson: map as unknown as Prisma.InputJsonValue },
    });
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

  // ---- Money-out ledger (/config → Billing → Money out) ----

  moneyOutEnabled(): boolean {
    return this.settings.moneyOutEnabled;
  }

  // Reconcile cursor. Null = never swept: the first tick walks the default
  // lookback instead of all of history (that is what the backfill button is for).
  moneyOutSweepAt(): Date | null {
    return this.settings.moneyOutSweepAt;
  }

  moneyOutBackfillDoneAt(): Date | null {
    return this.settings.moneyOutBackfillDoneAt;
  }

  async updateMoneyOut(data: {
    moneyOutEnabled?: boolean;
    moneyOutSweepAt?: Date | null;
    moneyOutBackfillDoneAt?: Date | null;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
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

  // The VAULT_* env vars OVERRIDE the stored values (config/env.ts explains
  // why this layer inverts the usual /config-wins rule); the panels flag every
  // pinned field rather than letting an edit look effective.
  vaultEnabled(): boolean {
    return envBool("VAULT_ENABLED") ?? this.settings.vaultEnabled;
  }

  vaultAddr(): string | null {
    return envStr("VAULT_ADDR") ?? (this.settings.vaultAddr?.trim() || null);
  }

  vaultToken(): string | null {
    const pinned = envStr("VAULT_TOKEN");
    if (pinned) return pinned;
    const raw = this.settings.vaultToken;
    return raw != null ? decryptSecret(raw) : null;
  }

  // Local ciphertext present but no longer decryptable (rotated key source) —
  // the panel asks for re-entry. An env-pinned token means there IS a working
  // token, so the re-entry nag stays off.
  vaultTokenUnreadable(): boolean {
    if (envPin("vaultToken")) return false;
    return this.settings.vaultToken != null && this.vaultToken() == null;
  }

  vaultKvMount(): string {
    return envStr("VAULT_KV_MOUNT") ?? (this.settings.vaultKvMount?.trim() || "kv");
  }

  vaultKvBasePath(): string {
    const raw = envStr("VAULT_KV_BASE_PATH") ?? this.settings.vaultKvBasePath?.trim() ?? "";
    return raw.replace(/^\/+|\/+$/g, "") || "support-bot";
  }

  vaultTransitMount(): string {
    return envStr("VAULT_TRANSIT_MOUNT") ?? (this.settings.vaultTransitMount?.trim() || "transit");
  }

  vaultTransitKey(): string {
    return envStr("VAULT_TRANSIT_KEY") ?? (this.settings.vaultTransitKey?.trim() || "support-bot");
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
  // server-side; no legacy fallback exists). TEMPORAL_ENABLED pins it so a
  // fresh deploy can boot with the worker already polling.
  temporalEnabled(): boolean {
    return envBool("TEMPORAL_ENABLED") ?? this.settings.temporalEnabled;
  }

  // Connection values live in BotSettings and are edited via /config, but a set
  // TEMPORAL_* env var OVERRIDES the stored value — same rule as the VAULT_*
  // getters above, and unlike the INTERCOM_* fallbacks, which /config still
  // wins over. The mTLS material is the one exception (Vault KV stays
  // authoritative; see certs.ts).
  temporalAddress(): string | null {
    return envStr("TEMPORAL_ADDRESS") ?? (this.settings.temporalAddress?.trim() || null);
  }

  temporalNamespace(): string | null {
    return envStr("TEMPORAL_NAMESPACE") ?? (this.settings.temporalNamespace?.trim() || null);
  }

  temporalTaskQueue(): string {
    return envStr("TEMPORAL_TASK_QUEUE") ?? (this.settings.temporalTaskQueue?.trim() || "support-bot");
  }

  temporalDeploymentName(): string {
    return envStr("TEMPORAL_DEPLOYMENT_NAME") ?? (this.settings.temporalDeploymentName?.trim() || "support-bot");
  }

  // Transport security for the frontend connection. OFF (the default) dials
  // plaintext gRPC — a private-network frontend (Railway internal DNS, a
  // service mesh) listens without TLS, and speaking TLS at it dies in the
  // handshake with a rustls InvalidContentType. ON requires the Vault-held
  // mTLS material; the certs stay stored while off, just unused.
  temporalTlsEnabled(): boolean {
    return envBool("TEMPORAL_TLS_ENABLED") ?? this.settings.temporalTlsEnabled;
  }

  // TLS SNI / server-name override for dialing by IP while the server cert
  // carries a hostname. Null = let gRPC derive it from the address. Inert
  // while temporalTlsEnabled is off.
  temporalTlsServerName(): string | null {
    return envStr("TEMPORAL_TLS_SERVER_NAME") ?? (this.settings.temporalTlsServerName?.trim() || null);
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
    temporalTlsEnabled?: boolean;
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

  // ---- Sentry feedback import (User Feedback widget → Intercom) ----

  sentryReadEnabled(): boolean {
    return this.settings.sentryReadEnabled;
  }

  // Org auth token (org:read, project:read, event:read). Vault-held or locally
  // encrypted; deliberately NO env fallback (deploy has no .env access).
  sentryReadToken(): string | null {
    return this.resolveSecret(this.settings.sentryReadToken, "sentryReadToken");
  }

  // Sentry internal-integration client secret — verifies sentry-hook-signature
  // on POST /sentry/webhook. Unset = the endpoint rejects everything and the
  // polling looper carries delivery alone.
  sentryWebhookSecret(): string | null {
    return this.resolveSecret(this.settings.sentryWebhookSecret, "sentryWebhookSecret");
  }

  sentryOrgSlug(): string | null {
    return this.settings.sentryOrgSlug?.trim() || null;
  }

  // Comma-separated project-slug allowlist; empty = import from all projects.
  sentryFeedbackProjectSlugs(): string[] {
    const raw = this.settings.sentryProjectSlug ?? "";
    return [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  }

  sentryReadRegion(): "us" | "eu" {
    return this.settings.sentryReadRegion === "eu" ? "eu" : "us";
  }

  sentryFeedbackTeamId(): string | null {
    return this.settings.sentryFeedbackTeamId;
  }

  // Customer ticket type imports are converted into; null = imports stay
  // plain conversations.
  sentryFeedbackTicketTypeId(): string | null {
    return this.settings.sentryFeedbackTicketTypeId;
  }

  // No-backfill floor, stamped at FIRST enable. Null = never enabled — a hard
  // gate independent of the toggle (Sync Now force bypasses the toggle, never
  // this). Deliberately not reset on disable: a re-enable imports the gap.
  sentryFeedbackWatermarkAt(): Date | null {
    return this.settings.sentryFeedbackWatermarkAt;
  }

  sentryFeedbackLastSyncAt(): Date | null {
    return this.settings.sentryFeedbackLastSyncAt;
  }

  sentryFeedbackConfigured(): boolean {
    return Boolean(this.sentryReadToken() && this.sentryOrgSlug() && this.sentryFeedbackWatermarkAt());
  }

  async updateSentryFeedback(data: {
    sentryReadEnabled?: boolean;
    sentryReadToken?: string | null;
    sentryWebhookSecret?: string | null;
    sentryOrgSlug?: string | null;
    sentryProjectSlug?: string | null;
    sentryReadRegion?: string;
    sentryFeedbackTeamId?: string | null;
    sentryFeedbackTicketTypeId?: string | null;
    sentryFeedbackWatermarkAt?: Date;
  }): Promise<void> {
    const { sentryReadToken, sentryWebhookSecret, ...rest } = data;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: {
        ...rest,
        // Secrets route vault-first with local-encryption fallback; an empty
        // string / null clears them.
        ...(sentryReadToken !== undefined
          ? { sentryReadToken: await this.routeSecretWrite("sentryReadToken", sentryReadToken) }
          : {}),
        ...(sentryWebhookSecret !== undefined
          ? { sentryWebhookSecret: await this.routeSecretWrite("sentryWebhookSecret", sentryWebhookSecret) }
          : {}),
      },
    });
  }

  // ---- Postiz platform lookup (superadmin user search) ----

  postizLookupEnabled(): boolean {
    return this.settings.postizLookupEnabled;
  }

  // Backend base URL the /public/v1 routes hang off, no trailing slash.
  postizBaseUrl(): string | null {
    return this.settings.postizBaseUrl?.trim().replace(/\/+$/, "") || null;
  }

  // Org API key for the platform's public API. The calling org must contain a
  // superadmin user (SuperAdminGuard) and hold a subscription, or every lookup
  // comes back 401/403. POSTIZ_ADMIN_TOKEN in the environment WINS over the
  // stored column — the deploy already carries the key, and a second copy in
  // the database would only drift.
  postizApiKey(): string | null {
    return envStr(ENV_PINS.postizApiKey) ?? this.resolveSecret(this.settings.postizApiKey, "postizApiKey");
  }

  postizConfigured(): boolean {
    return Boolean(this.postizApiKey() && this.postizBaseUrl());
  }

  async updatePostiz(data: {
    postizLookupEnabled?: boolean;
    postizBaseUrl?: string | null;
    postizApiKey?: string | null;
  }): Promise<void> {
    const { postizApiKey, ...rest } = data;
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: {
        ...rest,
        ...(postizApiKey !== undefined
          ? { postizApiKey: await this.routeSecretWrite("postizApiKey", postizApiKey) }
          : {}),
      },
    });
  }

  // Tick stamp: lastSyncAt always; the watermark only when the walk advanced it.
  async recordSentryFeedbackSync(data: { lastSyncAt: Date; watermarkAt?: Date }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({
      where: { id: "global" },
      data: {
        sentryFeedbackLastSyncAt: data.lastSyncAt,
        ...(data.watermarkAt ? { sentryFeedbackWatermarkAt: data.watermarkAt } : {}),
      },
    });
  }

  // Forwarded-email conversion (lite-seat teammate forwards → conversation
  // recreated for the original sender). Edited via /intercom → Automation.

  forwardConvertEnabled(): boolean {
    return this.settings.forwardConvertEnabled;
  }

  // Tag applied to the recreated conversation (find-or-create by name).
  forwardConvertTagName(): string {
    return this.settings.forwardConvertTagName?.trim() || "email";
  }

  // Close-note override for the misattributed original ({email} supported);
  // null = built-in default text.
  forwardConvertCloseNote(): string | null {
    return this.settings.forwardConvertCloseNote?.trim() || null;
  }

  // Extra forwarder addresses treated like lite-seat teammates (personal
  // mailboxes, addresses without a seat). Comma-separated column, normalized
  // like sentryFeedbackProjectSlugs.
  forwardConvertExtraEmails(): string[] {
    const raw = this.settings.forwardConvertExtraEmails ?? "";
    return [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  }

  // Detach the forwarder from a thread Intercom's NATIVE forward detection
  // converted: it attaches the real customer but leaves the forwarding address
  // attached too. Separate toggle from forwardConvertEnabled so the repair can
  // be switched off without disabling our own bot-native conversion.
  forwardDetachForwarder(): boolean {
    return this.settings.forwardDetachForwarder;
  }

  async updateForwardConvert(data: {
    forwardConvertEnabled?: boolean;
    forwardConvertTagName?: string;
    forwardConvertCloseNote?: string | null;
    forwardConvertExtraEmails?: string;
    forwardDetachForwarder?: boolean;
  }): Promise<void> {
    this.settings = await this.prisma.botSettings.update({ where: { id: "global" }, data });
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
    refundMaxChargeAgeDays?: number | null;
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
          ...(input.reminderTextCustomer !== undefined ? { reminderTextCustomer: input.reminderTextCustomer } : {}),
          ...(input.reminderTextSupport !== undefined ? { reminderTextSupport: input.reminderTextSupport } : {}),
          ...(input.reminderRepeatDays !== undefined ? { reminderRepeatDays: input.reminderRepeatDays } : {}),
          ...(input.autoCloseMessage !== undefined ? { autoCloseMessage: input.autoCloseMessage } : {}),
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
