import * as Sentry from "@sentry/node";

// Minimal leveled logger with scope + context fields, plus optional Sentry
// error capture. The DSN lives in BotSettings (deploy has no editable .env),
// so initSentry runs after SettingsStore.load() — anything logged before that
// goes to stdout only.

export type LogFields = Record<string, unknown>;

let sentryEnabled = false;

export function initSentry(dsn: string | null | undefined): void {
  if (!dsn || sentryEnabled) return;
  try {
    Sentry.init({ dsn, tracesSampleRate: 0 });
    sentryEnabled = true;
    log.info("Sentry initialized");
  } catch (e) {
    log.error("Sentry init failed", e);
  }
}

export function sentryActive(): boolean {
  return sentryEnabled;
}

function stringifyFields(fields: LogFields | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  try {
    return " " + JSON.stringify(fields);
  } catch {
    return " [unserializable fields]";
  }
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly base: LogFields = {}
  ) {}

  child(scope: string, fields: LogFields = {}): Logger {
    return new Logger(this.scope ? `${this.scope}:${scope}` : scope, { ...this.base, ...fields });
  }

  private line(level: string, message: string, fields?: LogFields): string {
    const scope = this.scope ? ` [${this.scope}]` : "";
    return `${new Date().toISOString()} ${level.toUpperCase()}${scope} ${message}${stringifyFields({ ...this.base, ...fields })}`;
  }

  debug(message: string, fields?: LogFields): void {
    if (process.env.LOG_DEBUG) console.debug(this.line("debug", message, fields));
  }

  info(message: string, fields?: LogFields): void {
    console.log(this.line("info", message, fields));
  }

  warn(message: string, fields?: LogFields): void {
    console.warn(this.line("warn", message, fields));
  }

  error(message: string, error?: unknown, fields?: LogFields): void {
    const errText = error instanceof Error ? `: ${error.stack ?? error.message}` : error !== undefined ? `: ${String(error)}` : "";
    console.error(this.line("error", message, fields) + errText);
    if (sentryEnabled) {
      Sentry.withScope((scope) => {
        scope.setContext("log", { scope: this.scope, message, ...this.base, ...fields });
        if (error instanceof Error) Sentry.captureException(error);
        else Sentry.captureMessage(`${message}${errText}`, "error");
      });
    }
  }
}

export const log = new Logger("");
