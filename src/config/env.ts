import { log } from "../util/logger";

// Environment overrides for the Infrastructure settings (Vault + Temporal), plus
// the Postiz admin key.
//
// Every other BotSettings value is /config-only: the deploy has no editable
// .env, so a new setting must be reachable from Discord. Vault and Temporal are
// the exception because they are the bootstrap layer underneath everything
// else — the Vault connection holds the KV entry with the Temporal mTLS
// material, and a box that comes up with neither can only be repaired through
// the very panel that depends on them. So these accept an env var, and when one
// is set it WINS over the stored value: a deploy can pin its infrastructure
// regardless of what the database happens to hold.
//
// postizApiKey joins them for a different reason: the deploy already supplies
// the platform admin key as POSTIZ_ADMIN_TOKEN, so honouring that variable
// avoids a second copy of the same credential drifting in the database. It is
// the only pinned SECRET, so the value is never rendered — panels show only
// that the pin is in force, exactly as they do for a Vault-held secret.
//
// The panels never pretend the pin isn't there (see envPin): they show which
// variable is in force and keep accepting edits, which still write BotSettings
// and take effect the moment the variable is removed.

const envLog = log.child("config");

// Settings whose env var overrides the stored value, keyed by the BotSettings
// column so panels can look a field up by the key they already render.
export const ENV_PINS = {
  vaultEnabled: "VAULT_ENABLED",
  vaultAddr: "VAULT_ADDR",
  vaultToken: "VAULT_TOKEN",
  vaultKvMount: "VAULT_KV_MOUNT",
  vaultKvBasePath: "VAULT_KV_BASE_PATH",
  vaultTransitMount: "VAULT_TRANSIT_MOUNT",
  vaultTransitKey: "VAULT_TRANSIT_KEY",
  temporalEnabled: "TEMPORAL_ENABLED",
  temporalAddress: "TEMPORAL_ADDRESS",
  temporalNamespace: "TEMPORAL_NAMESPACE",
  temporalTaskQueue: "TEMPORAL_TASK_QUEUE",
  temporalDeploymentName: "TEMPORAL_DEPLOYMENT_NAME",
  temporalTlsEnabled: "TEMPORAL_TLS_ENABLED",
  temporalTlsServerName: "TEMPORAL_TLS_SERVER_NAME",
  postizApiKey: "POSTIZ_ADMIN_TOKEN",
} as const;

export type EnvPinnedField = keyof typeof ENV_PINS;

// The boolean-valued pins; everything else in ENV_PINS is a string.
const BOOLEAN_PINS = new Set<EnvPinnedField>(["vaultEnabled", "temporalEnabled", "temporalTlsEnabled"]);

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

// Unparseable booleans are logged once per variable rather than every getter
// call — these run on every panel render.
const warned = new Set<string>();

/** Trimmed value, or null when unset/blank. */
export function envStr(name: string): string | null {
  return (process.env[name] ?? "").trim() || null;
}

/** Parsed boolean, or null when unset/blank/garbage (garbage = not pinned). */
export function envBool(name: string): boolean | null {
  const raw = envStr(name);
  if (raw == null) return null;
  const value = raw.toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  if (!warned.has(name)) {
    warned.add(name);
    // Value deliberately not logged: a mistyped boolean is not a secret, but
    // these variables sit next to ones that are.
    envLog.warn("environment variable is not a boolean, ignoring", { "config.key": name });
  }
  return null;
}

/** The variable name currently overriding this field, or null when unpinned. */
export function envPin(field: EnvPinnedField): string | null {
  const name = ENV_PINS[field];
  const set = BOOLEAN_PINS.has(field) ? envBool(name) != null : envStr(name) != null;
  return set ? name : null;
}

/** Help/footnote line for a pinned field, or undefined when unpinned. */
export function envPinNote(field: EnvPinnedField): string | undefined {
  const name = envPin(field);
  return name
    ? `Pinned by ${name} in the environment; edits are stored but stay dormant until that variable is removed.`
    : undefined;
}

// Temporal mTLS material read off disk. NOT an ENV_PINS entry: Vault KV stays
// authoritative for the certs (see certs.ts) and these paths are the bootstrap
// fallback used only while KV has no temporal entry.
export const TEMPORAL_TLS_FILE_VARS = {
  cert: "TEMPORAL_TLS_CERT_FILE",
  key: "TEMPORAL_TLS_KEY_FILE",
  ca: "TEMPORAL_TLS_CA_FILE",
} as const;

export function temporalTlsFilePaths(): { cert: string; key: string; ca: string | null } | null {
  const cert = envStr(TEMPORAL_TLS_FILE_VARS.cert);
  const key = envStr(TEMPORAL_TLS_FILE_VARS.key);
  // Half a pair is a misconfiguration, not a fallback: say so instead of
  // silently leaving the connection down.
  if (!cert || !key) {
    if ((cert || key) && !warned.has("temporal-tls-files")) {
      warned.add("temporal-tls-files");
      envLog.warn("temporal TLS file fallback is incomplete, ignoring", {
        "config.key": cert ? TEMPORAL_TLS_FILE_VARS.key : TEMPORAL_TLS_FILE_VARS.cert,
      });
    }
    return null;
  }
  return { cert, key, ca: envStr(TEMPORAL_TLS_FILE_VARS.ca) };
}
