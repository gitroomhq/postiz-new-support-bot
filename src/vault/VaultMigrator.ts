import { PrismaClient } from "../generated/prisma/client";
import type { SessionStore } from "../auth/SessionStore";
import { GLOBAL_SECRETS, GlobalSecretColumn, SettingsStore } from "../config/SettingsStore";
import { decryptSecret, encryptSecret, isVaultKvSentinel, VAULT_KV_SENTINEL } from "../util/crypto";
import { withTickSpan } from "../util/instrument";
import { log } from "../util/logger";
import { VAULT_INTEGRATIONS, VaultService } from "./VaultService";

const migrateLog = log.child("vault-migrate");

export const COLUMN_LABELS: Record<GlobalSecretColumn, string> = {
  intercomAccessToken: "Intercom access token",
  intercomClientSecret: "Intercom client secret",
  stripeWebhookSecret: "Stripe webhook signing secret",
  stripeSecretKey: "Stripe API key",
  sentryReadToken: "Sentry read token",
  influxToken: "InfluxDB token",
};

export interface MigrateItemResult {
  name: string;
  // migrated = moved this run; already = nothing to do; skipped-empty = no
  // value configured; unreadable = local ciphertext no longer decrypts (needs
  // re-entry); failed = Vault write/verify failed (re-run the button).
  outcome: "migrated" | "already" | "skipped-empty" | "unreadable" | "failed";
  detail?: string;
}

export interface MigrateReport {
  ok: boolean;
  items: MigrateItemResult[];
  sessions: { converted: number; failed: number };
  error?: string;
}

const SESSION_BATCH_SIZE = 100;

// One-time migration (the /config button), the reverse escape hatch, and the
// recurring upgrade job that lifts outage-fallback enc:v1 writes into Vault
// after recovery. Every flow is idempotent and safe under partial failure:
// each column self-describes its storage (sentinel vs local ciphertext), so a
// mixed state is just "re-run when Vault cooperates", never corruption.
export class VaultMigrator {
  private upgrading = false;

  constructor(
    private prisma: PrismaClient,
    private settings: SettingsStore,
    private sessions: SessionStore,
    private vault: VaultService
  ) {}

  private static columns(): GlobalSecretColumn[] {
    return Object.keys(GLOBAL_SECRETS) as GlobalSecretColumn[];
  }

  // ---- Migrate (local → Vault) ----

  async migrate(): Promise<MigrateReport> {
    if (this.vault.state() !== "up") {
      return {
        ok: false,
        items: [],
        sessions: { converted: 0, failed: 0 },
        error: "Vault is not reachable — run Test Connection and fix the connection first.",
      };
    }
    // Seed the Stripe API key from the env var on demand too — pressing
    // Migrate must move it without waiting for the boot upgrade job (which
    // rides a Temporal workflow under that regime). Pre-cutover the seed
    // lands as local enc:v1 and the loop below lifts + verifies it like any
    // other column; post-cutover it routes straight to KV ("already").
    await this.seedStripeSecretKey();
    const items: MigrateItemResult[] = [];
    for (const column of VaultMigrator.columns()) {
      const name = COLUMN_LABELS[column];
      const raw = this.settings.getSecretColumnRaw(column);
      if (!raw) {
        items.push({ name, outcome: "skipped-empty" });
        continue;
      }
      if (isVaultKvSentinel(raw)) {
        items.push({ name, outcome: "already" });
        continue;
      }
      // Local enc:v1 (or legacy plaintext, which passes through verbatim).
      const plaintext = decryptSecret(raw);
      if (!plaintext) {
        items.push({ name, outcome: "unreadable", detail: "Local ciphertext no longer decrypts — re-enter the value, then re-run." });
        continue;
      }
      const { integration, field } = GLOBAL_SECRETS[column];
      if (!(await this.vault.setKvFields(integration, { [field]: plaintext }))) {
        items.push({ name, outcome: "failed", detail: this.vault.lastError() ?? "KV write failed." });
        continue;
      }
      // Round-trip verify against Vault itself (not the cache) BEFORE the
      // column is vacated — the sentinel must never point at a missing value.
      const entry = await this.vault.kvGetFresh(integration);
      if (entry?.[field] !== plaintext) {
        items.push({ name, outcome: "failed", detail: "Post-write verification read did not return the value." });
        continue;
      }
      await this.settings.setSecretColumnRaw(column, VAULT_KV_SENTINEL);
      items.push({ name, outcome: "migrated" });
    }

    const sessions = await this.convertSessionsToTransit();
    const ok = items.every((i) => i.outcome !== "failed") && sessions.failed === 0;

    // Stamp the cutover when anything now lives in Vault OR the run was fully
    // clean (an all-empty config cutting over is legitimate — future secrets
    // then go straight to Vault). Even on a partial run the stamp is right:
    // new writes route to Vault and the upgrade job keeps retrying leftovers.
    // Only an all-failed run (Vault broken) leaves the cutover unset.
    const anyInVault = items.some((i) => i.outcome === "migrated" || i.outcome === "already");
    if ((ok || anyInVault) && this.settings.vaultMigratedAt() == null) {
      await this.settings.updateVault({ vaultMigratedAt: new Date() });
    }
    migrateLog.info("vault.migrate.done", {
      "vault.items": items.map((i) => `${i.name}:${i.outcome}`).join(", "),
      "vault.sessions_converted": sessions.converted,
      "vault.sessions_failed": sessions.failed,
    });
    return { ok, items, sessions };
  }

  // ---- Reverse (Vault → local) ----

  async reverse(): Promise<MigrateReport> {
    if (this.vault.state() !== "up") {
      return {
        ok: false,
        items: [],
        sessions: { converted: 0, failed: 0 },
        error: "Vault must be reachable to pull the secrets back out — fix the connection first.",
      };
    }
    const items: MigrateItemResult[] = [];
    for (const column of VaultMigrator.columns()) {
      const name = COLUMN_LABELS[column];
      const raw = this.settings.getSecretColumnRaw(column);
      if (!raw || !isVaultKvSentinel(raw)) {
        items.push({ name, outcome: "already" });
        continue;
      }
      const { integration, field } = GLOBAL_SECRETS[column];
      const entry = await this.vault.kvGetFresh(integration);
      const value = entry?.[field];
      if (!value) {
        // Sentinel with no value behind it — nothing to restore; clear the
        // column so the panel honestly shows "not set".
        await this.settings.setSecretColumnRaw(column, null);
        items.push({ name, outcome: "skipped-empty", detail: "No value found in Vault — column cleared." });
        continue;
      }
      await this.settings.setSecretColumnRaw(column, encryptSecret(value));
      items.push({ name, outcome: "migrated" });
    }

    const sessions = await this.convertSessionsToLocal();
    const ok = items.every((i) => i.outcome !== "failed") && sessions.failed === 0;

    if (ok) {
      // Columns are authoritative again: flip storage off FIRST, then clean up
      // Vault. A failed cleanup leaves inert stale copies (reported below),
      // never unreadable secrets.
      await this.settings.updateVault({ vaultMigratedAt: null, vaultEnabled: false });
      const missed: string[] = [];
      for (const integration of VAULT_INTEGRATIONS) {
        if (!(await this.vault.kvDeleteEntry(integration))) missed.push(integration);
      }
      if (missed.length > 0) {
        items.push({
          name: "KV cleanup",
          outcome: "failed",
          detail: `Could not delete: ${missed.join(", ")} — remove them in the Vault UI (stale copies, the bot no longer reads them).`,
        });
      }
      await this.vault.reconfigure();
    }
    migrateLog.info("vault.reverse.done", {
      "vault.items": items.map((i) => `${i.name}:${i.outcome}`).join(", "),
      "vault.sessions_converted": sessions.converted,
      "vault.sessions_failed": sessions.failed,
    });
    return { ok, items, sessions };
  }

  // ---- Upgrade job (outage-fallback stragglers → Vault) ----

  // Idempotent sweep run on recovery, after migrate(), and once at boot:
  // 0. Stripe API key env seed (runs even without Vault — see the method)
  // 1. global columns still holding enc:v1/plaintext → KV + sentinel
  // 2. columns cleared while Vault was down but whose KV field lingers → delete
  // 3. session rows not yet on Transit → batch-encrypt
  async runUpgradeJob(): Promise<{ globals: number; reconciled: number; sessions: number }> {
    const none = { globals: 0, reconciled: 0, sessions: 0 };
    // Seed ahead of the vault-up guard: on a vault-less deploy the value still
    // lands (as local enc:v1) and this same job lifts it after recovery.
    await this.seedStripeSecretKey();
    if (this.upgrading || !this.vault.storageActive() || this.vault.state() !== "up") return none;
    this.upgrading = true;
    try {
      // Cheap precheck so steady-state recoveries don't emit empty tick spans.
      const globalWork = VaultMigrator.columns().some((column) => {
        const raw = this.settings.getSecretColumnRaw(column);
        const { integration, field } = GLOBAL_SECRETS[column];
        return raw ? !isVaultKvSentinel(raw) : this.vault.getCachedKvField(integration, field) != null;
      });
      const sessionWork = await this.prisma.userSession.count({
        where: { NOT: { accessToken: { startsWith: "vault:" } } },
      });
      if (!globalWork && sessionWork === 0) return none;

      return await withTickSpan("vault-upgrade", async () => {
        let globals = 0;
        let reconciled = 0;
        for (const column of VaultMigrator.columns()) {
          const raw = this.settings.getSecretColumnRaw(column);
          const { integration, field } = GLOBAL_SECRETS[column];
          if (!raw) {
            if (this.vault.getCachedKvField(integration, field) != null) {
              if (await this.vault.setKvFields(integration, { [field]: null })) reconciled++;
            }
            continue;
          }
          if (isVaultKvSentinel(raw)) continue;
          const plaintext = decryptSecret(raw);
          if (!plaintext) {
            migrateLog.warn("vault.upgrade.unreadable", { "vault.column": column });
            continue;
          }
          if (await this.vault.setKvFields(integration, { [field]: plaintext })) {
            await this.settings.setSecretColumnRaw(column, VAULT_KV_SENTINEL);
            globals++;
          }
        }
        const sessions = await this.convertSessionsToTransit();
        migrateLog.info("vault.upgrade.done", {
          "vault.globals": globals,
          "vault.reconciled": reconciled,
          "vault.sessions_converted": sessions.converted,
          "vault.sessions_failed": sessions.failed,
        });
        return { globals, reconciled, sessions: sessions.converted };
      });
    } finally {
      this.upgrading = false;
    }
  }

  // ---- Stripe API key seed (env → managed storage, one-time) ----

  // The API key predates the vault system as a pure env var. Copies it into
  // managed storage so the /config Vault panel can see (and a later modal
  // rotate) it. Runs from the boot/recovery upgrade job AND the /config
  // Migrate button. Never clobbers an operator-set value: any non-empty raw
  // column (sentinel or ciphertext, readable or not) counts as set — env
  // might be the stale side after a rotation.
  private async seedStripeSecretKey(): Promise<void> {
    if (this.settings.getSecretColumnRaw("stripeSecretKey")) return;
    const envKey = process.env.STRIPE_SECRET_KEY;
    if (!envKey) return;
    await this.settings.updateStripeSecretKey(envKey);
    migrateLog.info("vault.seed.stripe_key", {
      "vault.secret_state": this.settings.secretState("stripeSecretKey"),
    });
  }

  // ---- Session token conversion (shared) ----

  private async convertSessionsToTransit(): Promise<{ converted: number; failed: number }> {
    const rows = await this.prisma.userSession.findMany({
      where: { NOT: { accessToken: { startsWith: "vault:" } } },
      select: { id: true, accessToken: true },
    });
    let converted = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i += SESSION_BATCH_SIZE) {
      const chunk = rows.slice(i, i + SESSION_BATCH_SIZE);
      const usable = chunk
        .map((r) => ({ id: r.id, oldCt: r.accessToken, plaintext: r.accessToken ? decryptSecret(r.accessToken) : null }))
        .filter((r): r is { id: string; oldCt: string; plaintext: string } => !!r.plaintext);
      failed += chunk.length - usable.length;
      if (usable.length === 0) continue;
      const ciphertexts = await this.vault.transitEncryptBatch(usable.map((r) => r.plaintext));
      for (let j = 0; j < usable.length; j++) {
        const ct = ciphertexts[j];
        if (!ct) {
          failed++;
          continue;
        }
        // Guarded write: only convert the row if it still holds the ciphertext
        // we read — a concurrent re-auth must never be clobbered. A miss is
        // fine (the new write already chose its own envelope).
        const res = await this.prisma.userSession.updateMany({
          where: { id: usable[j].id, accessToken: usable[j].oldCt },
          data: { accessToken: ct },
        });
        if (res.count > 0) converted++;
      }
    }
    if (converted > 0) this.sessions.invalidateTokenCache();
    return { converted, failed };
  }

  private async convertSessionsToLocal(): Promise<{ converted: number; failed: number }> {
    const rows = await this.prisma.userSession.findMany({
      where: { accessToken: { startsWith: "vault:" } },
      select: { id: true, accessToken: true },
    });
    let converted = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i += SESSION_BATCH_SIZE) {
      const chunk = rows.slice(i, i + SESSION_BATCH_SIZE);
      const plaintexts = await this.vault.transitDecryptBatch(chunk.map((r) => r.accessToken));
      for (let j = 0; j < chunk.length; j++) {
        const plaintext = plaintexts[j];
        if (!plaintext) {
          failed++;
          continue;
        }
        const res = await this.prisma.userSession.updateMany({
          where: { id: chunk[j].id, accessToken: chunk[j].accessToken },
          data: { accessToken: encryptSecret(plaintext) },
        });
        if (res.count > 0) converted++;
      }
    }
    if (converted > 0) this.sessions.invalidateTokenCache();
    return { converted, failed };
  }
}
