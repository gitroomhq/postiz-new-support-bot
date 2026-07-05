import * as Sentry from "@sentry/node";

// Leveled logger with scope + context fields, backed by Sentry Logs, plus the
// Sentry SDK lifecycle (init/reconfigure/shutdown). The DSN and all knobs live
// in BotSettings (deploy has no editable .env), so initSentry runs after
// SettingsStore.load() — anything logged before that goes to stdout only.
//
// OpenTelemetry auto-instrumentation (http/express/pg) still works despite the
// late init because the process starts with `--require @sentry/node/preload`
// (see package.json start/dev scripts), which registers the require hooks
// before any app module loads.
//
// Output contract: this logger writes to process.stdout/stderr directly, never
// through console.*, so the consoleLoggingIntegration bridge (which captures
// stray console.warn/error from dependencies) can never double-capture a line
// that already went to Sentry Logs via Sentry.logger.

export type LogFields = Record<string, unknown>;

// Runtime-tunable Sentry knobs, sourced from SettingsStore.sentryConfig().
export interface SentryRuntimeConfig {
  dsn: string | null;
  environment: string;
  tracesSampleRate: number;
  profilesSampleRate: number;
  logsEnabled: boolean;
  debug: boolean;
  sendDefaultPii: boolean;
  aiRecordContent: boolean;
}

let sentryEnabled = false;
let profilingAttached = false;
// Once a client has been closed, a fresh init can no longer re-register the
// OTel tracer provider (setGlobalTracerProvider silently refuses a second
// registration), so spans would flow into the dead client. Force a restart.
let everClosed = false;

// dist/util/logger.js → ../../package.json resolves to the repo root; same
// depth applies under ts-node from src/util. require(), not import: rootDir
// is ./src so tsc rejects JSON imports from outside it.
export function appRelease(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json") as { name?: string; version?: string };
    return `${pkg.name ?? "postiz-support-bot"}@${pkg.version ?? "0.0.0"}`;
  } catch {
    return "postiz-support-bot@unknown";
  }
}

// The Integration interface lives in @sentry/core, which pnpm's strict layout
// hides from the app — derive it from the init options instead.
type SentryIntegration = Extract<
  NonNullable<NonNullable<Parameters<typeof Sentry.init>[0]>["integrations"]>,
  unknown[]
>[number];

// The profiling addon is native and optional: a missing/blocked prebuilt for
// the host's Node ABI must never stop the bot from booting.
function loadProfilingIntegration(): SentryIntegration | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { nodeProfilingIntegration } = require("@sentry/profiling-node");
    return nodeProfilingIntegration();
  } catch (e) {
    process.stderr.write(
      `Sentry profiling unavailable (native module failed to load): ${e instanceof Error ? e.message : String(e)}\n`
    );
    return null;
  }
}

export function initSentry(cfg: SentryRuntimeConfig): void {
  if (!cfg.dsn || sentryEnabled) return;
  try {
    const integrations: SentryIntegration[] = [
      // Bridge for stray console.* (mostly dependencies): only warn/error to
      // keep noise down. Our own Logger bypasses console entirely (see the
      // output contract above). Self-disables when enableLogs is false.
      Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] }),
    ];
    if (cfg.profilesSampleRate > 0) {
      const profiling = loadProfilingIntegration();
      if (profiling) {
        integrations.push(profiling);
        profilingAttached = true;
      }
    }
    Sentry.init({
      dsn: cfg.dsn,
      release: appRelease(),
      environment: cfg.environment,
      debug: cfg.debug,
      sendDefaultPii: cfg.sendDefaultPii,
      // A non-null rate makes init() attach all auto performance integrations
      // (Express, Prisma, Postgres, Http, NodeFetch, ...).
      tracesSampleRate: cfg.tracesSampleRate,
      enableLogs: cfg.logsEnabled,
      enableMetrics: true,
      // Trace-lifecycle profiling: samples whenever a sampled span is active.
      profileSessionSampleRate: cfg.profilesSampleRate,
      profileLifecycle: "trace",
      integrations,
    });
    sentryEnabled = true;
    log.info("sentry.initialized", {
      "sentry_cfg.environment": cfg.environment,
      "sentry_cfg.release": appRelease(),
      "sentry_cfg.traces_sample_rate": cfg.tracesSampleRate,
      "sentry_cfg.profiles_sample_rate": profilingAttached ? cfg.profilesSampleRate : 0,
      "sentry_cfg.logs_enabled": cfg.logsEnabled,
      "sentry_cfg.profiling_attached": profilingAttached,
    });
  } catch (e) {
    log.error("sentry.init_failed", e);
  }
}

export function sentryActive(): boolean {
  return sentryEnabled;
}

export type SentryReconfigureResult =
  | { status: "started" } // was off → fully live (preload hooks make late init complete)
  | { status: "updated"; restartNeeded: string[] } // live-applied; listed knobs still need a restart
  | { status: "stopped" } // DSN cleared: flushed + closed
  | { status: "restart-required" } // DSN changed (or re-enabled after a stop) while the OTel provider is bound
  | { status: "disabled" }; // off before and after

// Applies /config changes to the running SDK where provably safe. The Sentry
// sampler and log gate read client.getOptions() per call, so tracesSampleRate,
// environment, sendDefaultPii and the enableLogs gate are live-mutable.
// Swapping the DSN of an active client is not (OTel tracer provider can't be
// re-registered) — that needs a restart.
export async function reconfigureSentry(cfg: SentryRuntimeConfig): Promise<SentryReconfigureResult> {
  const client = Sentry.getClient();
  if (!sentryEnabled || !client) {
    if (!cfg.dsn) return { status: "disabled" };
    if (everClosed) return { status: "restart-required" };
    initSentry(cfg);
    return sentryEnabled ? { status: "started" } : { status: "disabled" };
  }
  if (!cfg.dsn) {
    await Sentry.close(2000).catch(() => {});
    sentryEnabled = false;
    everClosed = true;
    return { status: "stopped" };
  }
  const activeDsn = client.getOptions().dsn;
  if (activeDsn && cfg.dsn !== activeDsn) return { status: "restart-required" };

  const opts = client.getOptions();
  const restartNeeded: string[] = [];
  opts.tracesSampleRate = cfg.tracesSampleRate;
  opts.environment = cfg.environment;
  opts.sendDefaultPii = cfg.sendDefaultPii;
  const logsWereOn = !!opts.enableLogs;
  opts.enableLogs = cfg.logsEnabled;
  if (cfg.logsEnabled && !logsWereOn) {
    restartNeeded.push("console capture (Sentry.logger works immediately)");
  }
  if (cfg.debug !== !!opts.debug) restartNeeded.push("debug output");
  if (cfg.profilesSampleRate > 0 && !profilingAttached) restartNeeded.push("profiling");
  return { status: "updated", restartNeeded };
}

export async function shutdownSentry(timeoutMs = 2000): Promise<void> {
  if (!sentryEnabled) return;
  await Sentry.close(timeoutMs).catch(() => {});
  sentryEnabled = false;
  everClosed = true;
}

// Fatal-path capture: no-op before init, flushes if Sentry is up.
export async function captureFatal(err: unknown): Promise<void> {
  if (!sentryEnabled) return;
  Sentry.captureException(err);
  await Sentry.flush(2000).catch(() => {});
}

// /config "Send test event" — the smoke test for "nothing appears in Sentry".
export async function sendSentryTestEvent(source: string): Promise<{ eventId: string; flushed: boolean } | null> {
  if (!sentryEnabled) return null;
  const eventId = Sentry.withScope((scope) => {
    scope.setTag("source", source);
    return Sentry.captureMessage(`Sentry test event (${new Date().toISOString()})`, "info");
  });
  const flushed = await Sentry.flush(3000).catch(() => false);
  return { eventId, flushed: flushed !== false };
}

// Env for spawned helper processes (Stripe MCP server): the SDK natively
// consumes all of these at init, including SENTRY_TRACE/SENTRY_BAGGAGE, which
// become the propagation context — so the child's spans join the trace that
// was active when this snapshot was taken.
export function sentrySubprocessEnv(cfg: SentryRuntimeConfig): Record<string, string> {
  if (!cfg.dsn) return {};
  const env: Record<string, string> = {
    SENTRY_DSN: cfg.dsn,
    SENTRY_ENVIRONMENT: cfg.environment,
    SENTRY_RELEASE: appRelease(),
    SENTRY_TRACES_SAMPLE_RATE: String(cfg.tracesSampleRate),
    // The child only talks HTTP(S) to Stripe; skip the other require hooks.
    SENTRY_PRELOAD_INTEGRATIONS: "Http",
    SENTRY_AI_RECORD_CONTENT: cfg.aiRecordContent ? "1" : "0",
  };
  if (cfg.debug) env.SENTRY_DEBUG = "1";
  if (sentryEnabled) {
    const trace = Sentry.getTraceData();
    if (trace["sentry-trace"]) env.SENTRY_TRACE = trace["sentry-trace"];
    if (trace.baggage) env.SENTRY_BAGGAGE = trace.baggage;
  }
  return env;
}

function stringifyFields(fields: LogFields | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  try {
    return " " + JSON.stringify(fields);
  } catch {
    return " [unserializable fields]";
  }
}

// Sentry Logs want flat scalar attributes; JSON-stringify anything else.
function scalarizeFields(fields: LogFields): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value === null) {
      out[key] = "null";
    } else {
      try {
        out[key] = JSON.stringify(value);
      } catch {
        out[key] = "[unserializable]";
      }
    }
  }
  return out;
}

export interface LoggerOptions {
  // MCP servers speak their protocol on stdout — route every level to stderr.
  stream?: "stdout" | "stderr";
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly base: LogFields = {},
    private readonly options: LoggerOptions = {}
  ) {}

  child(scope: string, fields: LogFields = {}): Logger {
    return new Logger(
      this.scope ? `${this.scope}:${scope}` : scope,
      { ...this.base, ...fields },
      this.options
    );
  }

  private line(level: string, message: string, fields?: LogFields): string {
    const scope = this.scope ? ` [${this.scope}]` : "";
    return `${new Date().toISOString()} ${level.toUpperCase()}${scope} ${message}${stringifyFields({ ...this.base, ...fields })}\n`;
  }

  // stdoutSuffix is appended to the terminal line only (e.g. a stack trace);
  // the Sentry log keeps the stable message with facts in attributes.
  private write(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: LogFields,
    stdoutSuffix = ""
  ): void {
    const stderr = this.options.stream === "stderr" || level === "warn" || level === "error";
    (stderr ? process.stderr : process.stdout).write(this.line(level, message + stdoutSuffix, fields));
    // isInitialized (not the module flag): the MCP subprocess calls
    // Sentry.init directly rather than through initSentry().
    if (Sentry.isInitialized()) {
      Sentry.logger[level](message, {
        "logger.scope": this.scope,
        ...scalarizeFields({ ...this.base, ...fields }),
      });
    }
  }

  debug(message: string, fields?: LogFields): void {
    if (process.env.LOG_DEBUG) this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, error?: unknown, fields?: LogFields): void {
    const errText =
      error instanceof Error ? `: ${error.stack ?? error.message}` : error !== undefined ? `: ${String(error)}` : "";
    const errFields: LogFields =
      error instanceof Error
        ? { "error.name": error.name, "error.message": error.message }
        : error !== undefined
          ? { "error.message": String(error) }
          : {};
    this.write("error", message, { ...fields, ...errFields }, errText);
    if (Sentry.isInitialized()) {
      Sentry.withScope((scope) => {
        scope.setContext("log", { scope: this.scope, message, ...this.base, ...fields });
        if (error instanceof Error) Sentry.captureException(error);
        else Sentry.captureMessage(`${message}${errText}`, "error");
      });
    }
  }
}

export const log = new Logger("");
