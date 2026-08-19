import * as Sentry from "@sentry/node";
import type { SettingsStore } from "../config/SettingsStore";
import type { AuditLogger } from "../bot/AuditLogger";
import { exportVaultHealth } from "../metrics/MetricsExporter";
import { safe } from "../util/instrument";
import { log } from "../util/logger";
import { VaultClient, VaultHttpError } from "./VaultClient";

const vaultLog = log.child("vault");

// The bot must survive Vault outages of an hour or more, so every consumer of
// this service treats failure as "secret unavailable right now", never as a
// crash: reads fall back to the in-memory KV cache (or null → the existing
// feature-gate degradation), writes fall back to local encryption, and the
// probe loop below recovers everything when Vault returns.

export type VaultState = "unconfigured" | "up" | "down" | "denied";

// One KV entry per integration under <kvBasePath>/<integration>. "temporal"
// holds the mTLS client cert material (clientCertPem/clientKeyPem/caPem) —
// Vault-only by design, no local-encryption fallback: a cold cache simply
// leaves the Temporal connection down until Vault recovers.
export type VaultIntegration = "intercom" | "stripe" | "sentry" | "influx" | "temporal" | "yubico" | "postiz";
export const VAULT_INTEGRATIONS: readonly VaultIntegration[] = ["intercom", "stripe", "sentry", "influx", "temporal", "yubico", "postiz"];

// Runtime config resolved from BotSettings (see SettingsStore.vaultConfig()).
export interface VaultRuntimeConfig {
  enabled: boolean;
  addr: string | null;
  token: string | null;
  kvMount: string;
  kvBasePath: string;
  transitMount: string;
  transitKey: string;
}

export interface VaultTestReport {
  healthOk: boolean;
  sealed: boolean;
  initialized: boolean;
  healthError: string | null;
  tokenOk: boolean;
  displayName: string | null;
  policies: string[];
  ttlSeconds: number | null;
  tokenError: string | null;
  transitOk: boolean;
  transitError: string | null;
  kvOk: boolean;
  kvEntriesFound: VaultIntegration[];
  kvError: string | null;
}

const PROBE_INTERVAL_MS = 30_000;
// While up: skip the liveness ping when any real operation succeeded recently.
const UP_PROBE_IDLE_MS = 60_000;
// While up: periodically re-read the KV entries so out-of-band edits made
// directly in the Vault UI reach the cache without a /config touch.
const KV_REFRESH_INTERVAL_MS = 10 * 60_000;
// Rate limit for repeated-failure logging while down (transition logs are not
// limited — they fire once by definition).
const FAILURE_LOG_INTERVAL_MS = 60_000;

// State machine + caches over VaultClient. Owns the up/down/denied lifecycle,
// the in-memory KV secret cache that keeps SettingsStore getters synchronous,
// and the probe scheduler (same start/stop + overlap-guard idiom as the other
// schedulers). Never throws out of init/tick — Vault being down at boot means
// the bot starts degraded, not dead.
export class VaultService {
  private client: VaultClient | null = null;
  private stateVal: VaultState = "unconfigured";
  private lastErrorMsg: string | null = null;
  private lastProbeAtMs: number | null = null;
  private downSinceMs: number | null = null;
  private lastOkAtMs = 0;
  private kvCache = new Map<VaultIntegration, Record<string, string>>();
  private kvLoadedAtMs: number | null = null;
  private recoveredHooks: Array<() => Promise<void> | void> = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private recovering = false;
  private lastFailureLogAtMs = 0;

  constructor(
    private settings: SettingsStore,
    private audit: AuditLogger
  ) {}

  // ---- introspection (sync, for panels/gates) ----

  state(): VaultState {
    return this.stateVal;
  }

  lastError(): string | null {
    return this.lastErrorMsg;
  }

  lastProbeAt(): Date | null {
    return this.lastProbeAtMs ? new Date(this.lastProbeAtMs) : null;
  }

  downSince(): Date | null {
    return this.downSinceMs ? new Date(this.downSinceMs) : null;
  }

  hasWarmCache(): boolean {
    return this.kvLoadedAtMs != null;
  }

  kvCacheAgeMs(): number | null {
    return this.kvLoadedAtMs != null ? Date.now() - this.kvLoadedAtMs : null;
  }

  // Connection settings are complete (independent of reachability).
  configured(): boolean {
    const cfg = this.settings.vaultConfig();
    return cfg.enabled && !!cfg.addr && !!cfg.token;
  }

  // Storage cutover: secrets ROUTE to Vault only after the explicit /config
  // migration stamped vaultMigratedAt — enabling the connection alone never
  // silently moves storage.
  storageActive(): boolean {
    return this.settings.vaultEnabled() && this.settings.vaultMigratedAt() != null;
  }

  // Hooks run after a down/denied → up transition (Influx rebuild, the
  // enc:v1-straggler upgrade job). Each is individually guarded.
  onRecovered(hook: () => Promise<void> | void): void {
    this.recoveredHooks.push(hook);
  }

  // ---- lifecycle ----

  // Bounded warm-up: one auth check + one parallel KV read, each capped by the
  // client's 5s timeout. Never throws; a down Vault leaves state=down and the
  // probe loop takes it from there.
  async init(): Promise<void> {
    const cfg = this.settings.vaultConfig();
    this.kvCache.clear();
    this.kvLoadedAtMs = null;
    if (!cfg.enabled || !cfg.addr || !cfg.token) {
      this.client = null;
      this.stateVal = "unconfigured";
      this.lastErrorMsg = null;
      this.downSinceMs = null;
      return;
    }
    this.client = new VaultClient({
      addr: cfg.addr,
      token: cfg.token,
      kvMount: cfg.kvMount,
      kvBasePath: cfg.kvBasePath,
      transitMount: cfg.transitMount,
      transitKey: cfg.transitKey,
    });
    await this.recover("init");
  }

  // /config save: rebuild the client and caches from the current settings.
  async reconfigure(): Promise<void> {
    await this.init();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => vaultLog.error("vault probe tick failed", e));
    }, PROBE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.stateVal === "unconfigured" || !this.client) return;
      this.lastProbeAtMs = Date.now();
      if (this.stateVal === "up") {
        const now = Date.now();
        if (now - this.lastOkAtMs > UP_PROBE_IDLE_MS) {
          try {
            const h = await this.client.health();
            if (!h.ok) {
              this.noteFailure(new VaultHttpError(503, h.sealed ? "Vault is sealed" : "Vault health: not usable"), "health probe");
            } else {
              this.lastOkAtMs = now;
            }
          } catch (e) {
            this.noteFailure(e, "health probe");
          }
        }
        if (this.stateVal === "up" && this.kvLoadedAtMs != null && Date.now() - this.kvLoadedAtMs > KV_REFRESH_INTERVAL_MS) {
          await this.refreshKvCache();
        }
      } else {
        await this.recover("probe");
      }
    } finally {
      if (this.stateVal !== "unconfigured") exportVaultHealth(this.stateVal === "up");
      this.ticking = false;
    }
  }

  // Full path back to "up": auth check → fresh KV cache → state flip →
  // recovery hooks. Also the init path (where the prior state is
  // "unconfigured" and hooks/embeds are skipped). Self-catches.
  private async recover(trigger: string): Promise<void> {
    if (this.recovering || !this.client) return;
    this.recovering = true;
    try {
      await this.client.lookupSelf();
      await this.refreshKvCacheThrow();
      const prev = this.stateVal;
      this.stateVal = "up";
      this.lastOkAtMs = Date.now();
      this.lastErrorMsg = null;
      if (prev === "up") return;
      const outageMs = this.downSinceMs != null ? Date.now() - this.downSinceMs : null;
      this.downSinceMs = null;
      exportVaultHealth(true);
      vaultLog.info("vault.up", { "vault.trigger": trigger, "vault.outage_ms": outageMs ?? 0 });
      if (prev === "down" || prev === "denied") {
        for (const hook of this.recoveredHooks) {
          try {
            await hook();
          } catch (e) {
            vaultLog.error("vault recovery hook failed", e);
          }
        }
        void this.audit.log({
          title: "🔐 Vault recovered",
          severity: "success",
          description: "Vault is reachable again. Cached secrets refreshed and fallback-written secrets are being upgraded.",
          fields: outageMs != null ? [{ name: "Outage", value: formatDurationMs(outageMs), inline: true }] : [],
        });
      }
    } catch (e) {
      this.noteFailure(e, trigger);
    } finally {
      this.recovering = false;
    }
  }

  // ---- failure/success accounting (every Vault op reports through these) ----

  // Called by wrappers on any successful real operation; an op succeeding
  // while we think Vault is down short-circuits the wait for the next probe.
  private noteSuccess(): void {
    this.lastOkAtMs = Date.now();
    if ((this.stateVal === "down" || this.stateVal === "denied") && !this.recovering) {
      safe(this.recover("op success"), "vault");
    }
  }

  private noteFailure(err: unknown, what: string): void {
    const status = err instanceof VaultHttpError ? err.status : null;
    const next: VaultState = status === 403 ? "denied" : "down";
    const msg = err instanceof Error ? err.message : String(err);
    this.lastErrorMsg = msg;
    const prev = this.stateVal;
    if (prev === next) {
      // Still down — keep quiet apart from a rate-limited log line.
      const now = Date.now();
      if (now - this.lastFailureLogAtMs > FAILURE_LOG_INTERVAL_MS) {
        this.lastFailureLogAtMs = now;
        vaultLog.warn("vault.still_unreachable", { "vault.what": what, "vault.error": msg });
      }
      return;
    }
    this.stateVal = next;
    if (this.downSinceMs == null) this.downSinceMs = Date.now();
    exportVaultHealth(false);
    vaultLog.warn(next === "denied" ? "vault.denied" : "vault.down", { "vault.what": what, "vault.error": msg });
    Sentry.withScope((scope) => {
      scope.setFingerprint([next === "denied" ? "vault-denied" : "vault-down"]);
      scope.setContext("vault", { what, error: msg, state: next });
      Sentry.captureMessage(
        next === "denied" ? "Vault token rejected (403)" : "Vault unreachable: serving cached secrets",
        "warning"
      );
    });
    // Transitions only (user decision): one embed when it goes down, one on
    // recovery. A boot-time failure has no bound Discord client yet — the
    // AuditLogger no-ops in that case (Sentry + logs above still fire).
    if (prev === "up") {
      void this.audit.log({
        title: next === "denied" ? "🔐 Vault token rejected" : "🔐 Vault unreachable",
        severity: "warn",
        description:
          next === "denied"
            ? "Vault answered 403. The token was revoked or its policy changed. Check /config → Vault. Cached secrets keep working; new secret writes fall back to local encryption."
            : "Serving secrets from the in-memory cache until Vault recovers. New secret writes fall back to local encryption and are upgraded automatically.",
        fields: [{ name: "Failure", value: msg.slice(0, 1024), inline: false }],
      });
    }
  }

  // ---- KV cache ----

  // Sync read for SettingsStore getters. null = field absent OR cache cold
  // (Vault down since boot) — both degrade identically downstream.
  getCachedKvField(integration: VaultIntegration, field: string): string | null {
    return this.kvCache.get(integration)?.[field] || null;
  }

  async refreshKvCache(): Promise<boolean> {
    try {
      await this.refreshKvCacheThrow();
      this.noteSuccess();
      return true;
    } catch (e) {
      this.noteFailure(e, "kv refresh");
      return false;
    }
  }

  private async refreshKvCacheThrow(): Promise<void> {
    if (!this.client) throw new Error("vault client not configured");
    const client = this.client;
    const entries = await Promise.all(VAULT_INTEGRATIONS.map((i) => client.kvGet(i)));
    VAULT_INTEGRATIONS.forEach((integration, idx) => {
      this.kvCache.set(integration, entries[idx] ?? {});
    });
    this.kvLoadedAtMs = Date.now();
  }

  // Fresh read straight from Vault, bypassing the cache — the migrator uses it
  // to verify a write round-trip before vacating a column. Refreshes the cache
  // as a side effect. null = entry missing OR read failed (either way the
  // caller's verification fails closed).
  async kvGetFresh(integration: VaultIntegration): Promise<Record<string, string> | null> {
    if (!this.client) return null;
    try {
      const entry = await this.client.kvGet(integration);
      this.kvCache.set(integration, entry ?? {});
      if (this.kvLoadedAtMs == null) this.kvLoadedAtMs = Date.now();
      this.noteSuccess();
      return entry;
    } catch (e) {
      this.noteFailure(e, `kv read ${integration}`);
      return null;
    }
  }

  // Removes one integration entry entirely (all versions + metadata) — the
  // reverse-migration cleanup.
  async kvDeleteEntry(integration: VaultIntegration): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.kvDelete(integration);
      this.kvCache.set(integration, {});
      this.noteSuccess();
      return true;
    } catch (e) {
      this.noteFailure(e, `kv delete ${integration}`);
      return false;
    }
  }

  // Read-merge-write one integration entry (both Intercom fields arrive in a
  // single call, avoiding a read-modify-write race between them). null/""
  // removes a field; an entry left empty is deleted outright. The cache is
  // updated BEFORE the caller stamps its sentinel column, so a sync getter can
  // never observe a sentinel with a cold cache while we're up. Returns false
  // on failure — the caller falls back to local encryption.
  async setKvFields(integration: VaultIntegration, fields: Record<string, string | null>): Promise<boolean> {
    if (!this.client) return false;
    try {
      const current = (await this.client.kvGet(integration)) ?? {};
      const merged: Record<string, string> = { ...current };
      for (const [k, v] of Object.entries(fields)) {
        if (v == null || v === "") delete merged[k];
        else merged[k] = v;
      }
      if (Object.keys(merged).length === 0) {
        await this.client.kvDelete(integration);
      } else {
        await this.client.kvPut(integration, merged);
      }
      this.kvCache.set(integration, merged);
      if (this.kvLoadedAtMs == null) this.kvLoadedAtMs = Date.now();
      this.noteSuccess();
      return true;
    } catch (e) {
      this.noteFailure(e, `kv write ${integration}`);
      return false;
    }
  }

  // ---- Transit ----

  // A Transit 400 is a permanent per-item failure (bad ciphertext, missing
  // key): logged rate-limited and returned as null WITHOUT flipping the state
  // — Vault itself is up, retrying would loop forever.
  private classifyTransitFailure(e: unknown, what: string): null {
    if (e instanceof VaultHttpError && e.status === 400) {
      const now = Date.now();
      if (now - this.lastFailureLogAtMs > FAILURE_LOG_INTERVAL_MS) {
        this.lastFailureLogAtMs = now;
        vaultLog.warn("vault.transit_rejected", { "vault.what": what, "vault.error": e.message });
      }
    } else {
      this.noteFailure(e, what);
    }
    return null;
  }

  async transitEncrypt(plaintext: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const ct = await this.client.transitEncrypt(plaintext);
      this.noteSuccess();
      return ct;
    } catch (e) {
      return this.classifyTransitFailure(e, "transit encrypt");
    }
  }

  async transitDecrypt(ciphertext: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const pt = await this.client.transitDecrypt(ciphertext);
      this.noteSuccess();
      return pt;
    } catch (e) {
      return this.classifyTransitFailure(e, "transit decrypt");
    }
  }

  async transitEncryptBatch(plaintexts: string[]): Promise<(string | null)[]> {
    if (!this.client || plaintexts.length === 0) return plaintexts.map(() => null);
    try {
      const out = await this.client.transitEncryptBatch(plaintexts);
      this.noteSuccess();
      return out;
    } catch (e) {
      this.classifyTransitFailure(e, "transit encrypt batch");
      return plaintexts.map(() => null);
    }
  }

  async transitDecryptBatch(ciphertexts: string[]): Promise<(string | null)[]> {
    if (!this.client || ciphertexts.length === 0) return ciphertexts.map(() => null);
    try {
      const out = await this.client.transitDecryptBatch(ciphertexts);
      this.noteSuccess();
      return out;
    } catch (e) {
      this.classifyTransitFailure(e, "transit decrypt batch");
      return ciphertexts.map(() => null);
    }
  }

  // ---- Test Connection (the /config button) ----

  // Runs every layer independently so the report pinpoints the broken one:
  // health (unauthenticated) → token lookup → Transit round-trip → KV reads.
  // Never throws; also feeds the state machine (a passing test while "down"
  // triggers recovery, a failing one while "up" flips down).
  async testConnection(): Promise<VaultTestReport> {
    const report: VaultTestReport = {
      healthOk: false,
      sealed: false,
      initialized: true,
      healthError: null,
      tokenOk: false,
      displayName: null,
      policies: [],
      ttlSeconds: null,
      tokenError: null,
      transitOk: false,
      transitError: null,
      kvOk: false,
      kvEntriesFound: [],
      kvError: null,
    };
    const client = this.client;
    if (!client) {
      report.healthError = "Vault is not configured (set address + token and enable it).";
      return report;
    }
    try {
      const h = await client.health();
      report.healthOk = h.ok;
      report.sealed = h.sealed;
      report.initialized = h.initialized;
      if (!h.ok) report.healthError = h.sealed ? "Vault is sealed." : "Vault reports not-usable status.";
    } catch (e) {
      report.healthError = e instanceof Error ? e.message : String(e);
    }
    try {
      const self = await client.lookupSelf();
      report.tokenOk = true;
      report.displayName = self.displayName;
      report.policies = self.policies;
      report.ttlSeconds = self.ttlSeconds;
      this.noteSuccess();
    } catch (e) {
      report.tokenError = e instanceof Error ? e.message : String(e);
      this.noteFailure(e, "test connection");
    }
    if (report.tokenOk) {
      try {
        const probe = `self-test-${Math.random().toString(36).slice(2)}`;
        const ct = await client.transitEncrypt(probe);
        const pt = await client.transitDecrypt(ct);
        report.transitOk = pt === probe;
        if (!report.transitOk) report.transitError = "Round-trip mismatch (decrypted value differs).";
      } catch (e) {
        report.transitError = e instanceof Error ? e.message : String(e);
      }
      try {
        const entries = await Promise.all(VAULT_INTEGRATIONS.map((i) => client.kvGet(i)));
        report.kvOk = true;
        report.kvEntriesFound = VAULT_INTEGRATIONS.filter(
          (_, idx) => entries[idx] != null && Object.keys(entries[idx] ?? {}).length > 0
        );
        // A successful full read is as good as a refresh — keep the cache warm.
        VAULT_INTEGRATIONS.forEach((integration, idx) => this.kvCache.set(integration, entries[idx] ?? {}));
        this.kvLoadedAtMs = Date.now();
      } catch (e) {
        report.kvError = e instanceof Error ? e.message : String(e);
      }
    }
    return report;
  }
}

function formatDurationMs(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return "under a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
