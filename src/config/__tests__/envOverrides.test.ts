import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envBool, envPin, envStr, temporalTlsFilePaths } from "../env";
import { SettingsStore } from "../SettingsStore";
import { loadTemporalTls, temporalTlsSource } from "../../temporal/certs";
import type { VaultService } from "../../vault/VaultService";
import { FIXTURE_CERT_PEM, FIXTURE_KEY_PEM } from "../../temporal/__tests__/certFixture";

// The Vault/Temporal env vars OVERRIDE the stored settings (config/env.ts), the
// inverse of every other fallback in the codebase — these lock that rule in.

const VARS = [
  "VAULT_ENABLED",
  "VAULT_ADDR",
  "VAULT_TOKEN",
  "VAULT_KV_MOUNT",
  "VAULT_KV_BASE_PATH",
  "VAULT_TRANSIT_MOUNT",
  "VAULT_TRANSIT_KEY",
  "TEMPORAL_ENABLED",
  "TEMPORAL_ADDRESS",
  "TEMPORAL_NAMESPACE",
  "TEMPORAL_TASK_QUEUE",
  "TEMPORAL_DEPLOYMENT_NAME",
  "TEMPORAL_TLS_SERVER_NAME",
  "TEMPORAL_TLS_CERT_FILE",
  "TEMPORAL_TLS_KEY_FILE",
  "TEMPORAL_TLS_CA_FILE",
];

function clearEnv(): void {
  for (const v of VARS) delete process.env[v];
}

// Stored values that every env-win assertion below has to beat.
const STORED = {
  vaultEnabled: false,
  vaultAddr: "https://db.example.com:8200",
  vaultToken: null,
  vaultKvMount: "db-kv",
  vaultKvBasePath: "db-base",
  vaultTransitMount: "db-transit",
  vaultTransitKey: "db-key",
  vaultMigratedAt: null,
  temporalEnabled: false,
  temporalAddress: "db-host:7233",
  temporalNamespace: "db-namespace",
  temporalTaskQueue: "db-queue",
  temporalDeploymentName: "db-deployment",
  temporalTlsServerName: "db-sni",
};

function storeWith(overrides: Record<string, unknown> = {}): SettingsStore {
  const store = new SettingsStore(null as never);
  (store as unknown as { settings: unknown }).settings = { ...STORED, ...overrides };
  return store;
}

test("envStr trims and treats blank as unset; envBool takes the documented spellings", () => {
  clearEnv();
  assert.equal(envStr("VAULT_ADDR"), null);
  process.env.VAULT_ADDR = "  https://vault.example.com:8200  ";
  assert.equal(envStr("VAULT_ADDR"), "https://vault.example.com:8200");
  process.env.VAULT_ADDR = "   ";
  assert.equal(envStr("VAULT_ADDR"), null);

  for (const truthy of ["1", "true", "TRUE", "yes", "on", "enabled"]) {
    process.env.VAULT_ENABLED = truthy;
    assert.equal(envBool("VAULT_ENABLED"), true, truthy);
  }
  for (const falsy of ["0", "false", "No", "off", "disabled"]) {
    process.env.VAULT_ENABLED = falsy;
    assert.equal(envBool("VAULT_ENABLED"), false, falsy);
  }
  // Garbage is not a pin: the stored value keeps winning.
  process.env.VAULT_ENABLED = "maybe";
  assert.equal(envBool("VAULT_ENABLED"), null);
  assert.equal(envPin("vaultEnabled"), null);
  process.env.VAULT_ENABLED = "1";
  assert.equal(envPin("vaultEnabled"), "VAULT_ENABLED");
  clearEnv();
});

test("Vault getters: env overrides the stored value, blank env leaves it alone", () => {
  clearEnv();
  const stored = storeWith();
  assert.equal(stored.vaultEnabled(), false);
  assert.equal(stored.vaultAddr(), "https://db.example.com:8200");
  assert.equal(stored.vaultKvMount(), "db-kv");
  assert.equal(stored.vaultKvBasePath(), "db-base");
  assert.equal(stored.vaultTransitMount(), "db-transit");
  assert.equal(stored.vaultTransitKey(), "db-key");

  process.env.VAULT_ENABLED = "true";
  process.env.VAULT_ADDR = "https://env.example.com:8200";
  process.env.VAULT_KV_MOUNT = "env-kv";
  process.env.VAULT_KV_BASE_PATH = "/env-base/";
  process.env.VAULT_TRANSIT_MOUNT = "env-transit";
  process.env.VAULT_TRANSIT_KEY = "env-key";
  const pinned = storeWith();
  assert.equal(pinned.vaultEnabled(), true);
  assert.equal(pinned.vaultAddr(), "https://env.example.com:8200");
  assert.equal(pinned.vaultKvMount(), "env-kv");
  // Surrounding slashes are stripped from the env value too.
  assert.equal(pinned.vaultKvBasePath(), "env-base");
  assert.equal(pinned.vaultTransitMount(), "env-transit");
  assert.equal(pinned.vaultTransitKey(), "env-key");
  clearEnv();
});

test("Vault getters fall back to the documented defaults with neither env nor stored value", () => {
  clearEnv();
  const empty = storeWith({ vaultAddr: null, vaultKvMount: "", vaultKvBasePath: "", vaultTransitMount: "", vaultTransitKey: "" });
  assert.equal(empty.vaultAddr(), null);
  assert.equal(empty.vaultKvMount(), "kv");
  assert.equal(empty.vaultKvBasePath(), "support-bot");
  assert.equal(empty.vaultTransitMount(), "transit");
  assert.equal(empty.vaultTransitKey(), "support-bot");
});

test("VAULT_TOKEN wins over the stored ciphertext and silences the re-entry nag", () => {
  clearEnv();
  // Undecryptable ciphertext: without a pin this is the "re-enter it" state.
  const broken = storeWith({ vaultToken: "enc:v1:not-actually-decryptable" });
  assert.equal(broken.vaultToken(), null);
  assert.equal(broken.vaultTokenUnreadable(), true);

  process.env.VAULT_TOKEN = "  hvs.env-token  ";
  const pinned = storeWith({ vaultToken: "enc:v1:not-actually-decryptable" });
  assert.equal(pinned.vaultToken(), "hvs.env-token");
  assert.equal(pinned.vaultTokenUnreadable(), false);
  clearEnv();
});

test("Temporal getters: env overrides the stored connection and the worker switch", () => {
  clearEnv();
  const stored = storeWith();
  assert.equal(stored.temporalEnabled(), false);
  assert.equal(stored.temporalAddress(), "db-host:7233");
  assert.equal(stored.temporalTaskQueue(), "db-queue");

  process.env.TEMPORAL_ENABLED = "yes";
  process.env.TEMPORAL_ADDRESS = "env-host:7233";
  process.env.TEMPORAL_NAMESPACE = "env-namespace";
  process.env.TEMPORAL_TASK_QUEUE = "env-queue";
  process.env.TEMPORAL_DEPLOYMENT_NAME = "env-deployment";
  process.env.TEMPORAL_TLS_SERVER_NAME = "env-sni";
  const pinned = storeWith();
  assert.equal(pinned.temporalEnabled(), true);
  assert.equal(pinned.temporalAddress(), "env-host:7233");
  assert.equal(pinned.temporalNamespace(), "env-namespace");
  assert.equal(pinned.temporalTaskQueue(), "env-queue");
  assert.equal(pinned.temporalDeploymentName(), "env-deployment");
  assert.equal(pinned.temporalTlsServerName(), "env-sni");

  // A stored value still applies to whatever the env leaves unpinned.
  delete process.env.TEMPORAL_TASK_QUEUE;
  assert.equal(storeWith().temporalTaskQueue(), "db-queue");
  clearEnv();
});

// ---- Temporal mTLS: the one place where Vault KV still wins ----

function fakeVault(kv: Record<string, string | null>): VaultService {
  return {
    getCachedKvField: (_integration: string, field: string) => kv[field] ?? null,
  } as unknown as VaultService;
}

test("temporalTlsFilePaths requires cert AND key", () => {
  clearEnv();
  assert.equal(temporalTlsFilePaths(), null);
  process.env.TEMPORAL_TLS_CERT_FILE = "/tmp/cert.pem";
  assert.equal(temporalTlsFilePaths(), null); // half a pair is a misconfiguration
  process.env.TEMPORAL_TLS_KEY_FILE = "/tmp/key.pem";
  assert.deepEqual(temporalTlsFilePaths(), { cert: "/tmp/cert.pem", key: "/tmp/key.pem", ca: null });
  clearEnv();
});

test("cert files are read only when Vault KV holds no temporal entry", () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), "temporal-tls-"));
  const certPath = join(dir, "client.crt");
  const keyPath = join(dir, "client.key");
  const caPath = join(dir, "ca.crt");
  writeFileSync(certPath, FIXTURE_CERT_PEM);
  writeFileSync(keyPath, FIXTURE_KEY_PEM);
  writeFileSync(caPath, FIXTURE_CERT_PEM);
  try {
    const empty = fakeVault({});
    assert.equal(loadTemporalTls(empty), null);
    assert.equal(temporalTlsSource(empty), null);

    process.env.TEMPORAL_TLS_CERT_FILE = certPath;
    process.env.TEMPORAL_TLS_KEY_FILE = keyPath;
    process.env.TEMPORAL_TLS_CA_FILE = caPath;
    const fromFiles = loadTemporalTls(empty);
    assert.equal(fromFiles?.clientCertPem, FIXTURE_CERT_PEM);
    assert.equal(fromFiles?.clientKeyPem, FIXTURE_KEY_PEM);
    assert.equal(fromFiles?.caPem, FIXTURE_CERT_PEM);
    assert.equal(temporalTlsSource(empty), "env-files");

    // Vault stays authoritative: a KV entry takes over even with files present.
    const withKv = fakeVault({ clientCertPem: "vault-cert", clientKeyPem: "vault-key", caPem: "vault-ca" });
    assert.equal(loadTemporalTls(withKv)?.clientCertPem, "vault-cert");
    assert.equal(temporalTlsSource(withKv), "vault");

    // A missing file is not usable material.
    process.env.TEMPORAL_TLS_CERT_FILE = join(dir, "nope.crt");
    assert.equal(loadTemporalTls(empty), null);
  } finally {
    clearEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});
