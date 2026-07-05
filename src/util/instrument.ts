import * as Sentry from "@sentry/node";
import { log } from "./logger";

// Tracing/metrics helpers shared by the Discord handlers, schedulers and the
// AI runner. Everything here degrades to a plain passthrough when Sentry is
// not initialized.

// OTel span status codes (not exported by @sentry/node as constants).
export const SPAN_STATUS_OK = 1 as const;
export const SPAN_STATUS_ERROR = 2 as const;

// Every dynamic customId in the codebase is "prefix:arg1:arg2..." (e.g.
// "csat:5", "create_issue:123", "billing_accept_discount:ch_..."); static ids
// have no colon. Keeping only the prefix bounds span-name cardinality.
export function normalizeCustomId(customId: string): string {
  return customId.split(":")[0];
}

// Span wrappers capture exceptions with full scope context and rethrow; the
// marker lets outer catch blocks skip a duplicate captureException.
const CAPTURED_MARK = Symbol.for("supportbot.sentry.captured");

export function markCaptured(e: unknown): void {
  if (e && typeof e === "object") {
    try {
      (e as Record<symbol, unknown>)[CAPTURED_MARK] = true;
    } catch {}
  }
}

export function wasCaptured(e: unknown): boolean {
  return !!(e && typeof e === "object" && (e as Record<symbol, unknown>)[CAPTURED_MARK]);
}

export interface DiscordSpanCtx {
  op:
    | "discord.command"
    | "discord.button"
    | "discord.select"
    | "discord.modal"
    | "discord.autocomplete"
    | "discord.message"
    | "discord.event";
  name: string; // e.g. "/ai ask", "button billing_confirm_refund"
  userId?: string;
  username?: string;
  guildId?: string | null;
  channelId?: string | null;
  attributes?: Record<string, string | number | boolean>;
}

// Root span per Discord gateway event. withIsolationScope keeps concurrent
// interactions from cross-contaminating user context (gateway callbacks all
// share one ambient scope otherwise). Errors are captured here with full
// interaction context, then rethrown for the caller's own handling.
export function withDiscordSpan<T>(ctx: DiscordSpanCtx, fn: () => Promise<T>): Promise<T> {
  return Sentry.withIsolationScope((scope) => {
    if (ctx.userId) scope.setUser({ id: ctx.userId });
    const attributes: Record<string, string | number | boolean> = {
      "sentry.source": "route",
      ...ctx.attributes,
    };
    if (ctx.userId) attributes["discord.user_id"] = ctx.userId;
    if (ctx.username) attributes["discord.username"] = ctx.username;
    if (ctx.guildId) attributes["discord.guild_id"] = ctx.guildId;
    if (ctx.channelId) attributes["discord.channel_id"] = ctx.channelId;
    return Sentry.startSpan(
      { name: ctx.name, op: ctx.op, forceTransaction: true, attributes },
      async (span) => {
        try {
          const result = await fn();
          metricCount("discord.interactions", 1, { op: ctx.op, name: ctx.name, ok: true });
          return result;
        } catch (e) {
          span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
          metricCount("discord.interactions", 1, { op: ctx.op, name: ctx.name, ok: false });
          Sentry.captureException(e);
          markCaptured(e);
          throw e;
        }
      }
    );
  });
}

// Root span for a scheduler tick / background drain. Callers should invoke it
// only when there is actual work (high-frequency pollers would otherwise emit
// thousands of empty transactions a day).
export function withTickSpan<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  return Sentry.withIsolationScope(() =>
    Sentry.startSpan(
      {
        name: `tick ${slug}`,
        op: "scheduler.tick",
        forceTransaction: true,
        attributes: { "sentry.source": "task", "scheduler.slug": slug },
      },
      async (span) => {
        try {
          return await fn();
        } catch (e) {
          span.setStatus({ code: SPAN_STATUS_ERROR, message: "internal_error" });
          Sentry.captureException(e);
          markCaptured(e);
          throw e;
        }
      }
    )
  );
}

// Guard for fire-and-forget promises (replaces `void p.catch(console.error)`):
// failures become a structured error log + Sentry issue instead of vanishing.
export function safe(promise: Promise<unknown>, scopeName: string, attrs?: Record<string, unknown>): void {
  promise.catch((e) => {
    log.child(scopeName).error("background task failed", e, attrs);
  });
}

// Attribute payload cap: Sentry truncates huge strings server-side anyway;
// trimming client-side keeps envelopes small and intent explicit.
export function truncateForAttr(s: string, max = 16_384): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…[truncated]";
}

// Gate for recording AI conversation content (prompts/responses/tool I/O) on
// gen_ai spans. Set at boot from BotSettings and flipped live by /config.
let aiRecordContent = true;

export function setAiRecordContent(enabled: boolean): void {
  aiRecordContent = enabled;
}

export function aiRecordContentEnabled(): boolean {
  return aiRecordContent;
}

// Metric emission — no-ops until Sentry is initialized.
type MetricAttrs = Record<string, string | number | boolean>;

export function metricCount(name: string, value = 1, attributes?: MetricAttrs): void {
  if (!Sentry.isInitialized()) return;
  Sentry.metrics.count(name, value, attributes ? { attributes } : undefined);
}

export function metricGauge(name: string, value: number, attributes?: MetricAttrs, unit?: string): void {
  if (!Sentry.isInitialized()) return;
  Sentry.metrics.gauge(name, value, { unit, attributes });
}

export function metricDistribution(name: string, value: number, attributes?: MetricAttrs, unit?: string): void {
  if (!Sentry.isInitialized()) return;
  Sentry.metrics.distribution(name, value, { unit, attributes });
}
