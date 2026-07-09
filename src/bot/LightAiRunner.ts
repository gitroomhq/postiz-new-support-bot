import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import * as Sentry from "@sentry/node";
import { log } from "../util/logger";
import {
  aiRecordContentEnabled,
  truncateForAttr,
  metricCount,
  metricDistribution,
  safe,
  SPAN_STATUS_ERROR,
} from "../util/instrument";
import { AiRunStore } from "./AiRunStore";
import { ClaudeApiLimitError, ClaudeRunTelemetry } from "./ClaudeCodeRunner";
import { exportAiRun } from "../metrics/MetricsExporter";

const lightLog = log.child("claude:light");

// The CLI accepts model aliases ("haiku"); the raw Messages API needs real ids.
// aiModelLight is free-text, so map the known aliases and pass real ids through.
const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
}

function isApiLimitMessage(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("credit balance") || lower.includes("usage limit") || lower.includes("rate limit");
}

// Full (non-batch) per-MTok prices for cost attribution when the API doesn't
// hand us a cost figure (unlike the CLI's result event). Fallback = haiku.
const PRICES: Array<{ match: string; inPerMTok: number; outPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number }> = [
  { match: "haiku", inPerMTok: 1, outPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  { match: "sonnet", inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  { match: "opus", inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
];

export interface LightAiRunOptions {
  model: string;
  telemetry: ClaudeRunTelemetry;
  maxTokens?: number;
  timeoutMs?: number;
}

// Direct Messages API runner for the tool-less staff subcommands (/ai draft,
// /ai summarize). Replaces the Claude Code CLI spawn for these runs: no CLI
// system-prompt overhead tokens, no ~1-2s process start, same streaming UX.
// Telemetry parity with ClaudeCodeRunner: gen_ai spans (conversation id = one
// per run), ai.run.completed log, ai.* metrics, ai_runs row, Influx point.
export class LightAiRunner {
  private anthropic: Anthropic;

  constructor(private aiRunStore?: AiRunStore) {
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async run(
    prompt: string,
    onUpdate?: (messages: string[]) => void,
    options?: LightAiRunOptions
  ): Promise<string[]> {
    if (!options) throw new Error("LightAiRunner.run requires options");
    const agentName = options.telemetry.agentName;
    const kind: string = options.telemetry.kind;
    const model = resolveModelAlias(options.model);
    const conversationId = randomUUID();
    const startedAt = Date.now();

    const isolationScope = Sentry.getIsolationScope();
    isolationScope.setConversationId(conversationId);
    if (options.telemetry.userId) {
      isolationScope.setUser({ id: options.telemetry.userId, username: options.telemetry.username });
    }

    const agentAttributes: Record<string, string | number | boolean> = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.system": "anthropic",
      "gen_ai.agent.name": agentName,
      "gen_ai.request.model": model,
      "gen_ai.response.streaming": true,
      "gen_ai.conversation.id": conversationId,
    };
    if (aiRecordContentEnabled()) {
      agentAttributes["gen_ai.request.messages"] = truncateForAttr(
        JSON.stringify([{ role: "user", content: prompt }])
      );
    }

    return Sentry.startSpan(
      { name: `invoke_agent ${agentName}`, op: "gen_ai.invoke_agent", attributes: agentAttributes },
      async (agentSpan) => {
        const chatSpan = Sentry.withActiveSpan(agentSpan, () =>
          Sentry.startInactiveSpan({
            name: `chat ${model}`,
            op: "gen_ai.chat",
            attributes: {
              "gen_ai.operation.name": "chat",
              "gen_ai.system": "anthropic",
              "gen_ai.request.model": model,
              "gen_ai.agent.name": agentName,
              "gen_ai.conversation.id": conversationId,
            },
          })
        );

        let outcome: "success" | "api_limit" | "error" | "empty" = "success";
        let text = "";
        let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

        try {
          const stream = this.anthropic.messages.stream(
            {
              model,
              max_tokens: options.maxTokens ?? 4_000,
              messages: [{ role: "user", content: prompt }],
            },
            { timeout: options.timeoutMs ?? 120_000 }
          );
          stream.on("text", (delta) => {
            text += delta;
            onUpdate?.([text]);
          });
          const final = await stream.finalMessage();
          text = final.content
            .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          usage = {
            inputTokens: final.usage.input_tokens ?? 0,
            outputTokens: final.usage.output_tokens ?? 0,
            cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: final.usage.cache_creation_input_tokens ?? 0,
          };
          chatSpan.setAttributes({
            "gen_ai.usage.input_tokens": usage.inputTokens,
            "gen_ai.usage.output_tokens": usage.outputTokens,
            "gen_ai.usage.cache_read_input_tokens": usage.cacheReadTokens,
            "gen_ai.usage.cache_creation_input_tokens": usage.cacheCreationTokens,
            "gen_ai.response.model": final.model,
            "gen_ai.response.stop_reason": String(final.stop_reason ?? ""),
          });
          if (aiRecordContentEnabled() && text) {
            chatSpan.setAttribute("gen_ai.response.text", truncateForAttr(text));
          }
          if (!text.trim()) outcome = "empty";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isLimit =
            err instanceof Anthropic.RateLimitError ||
            (err instanceof Anthropic.APIError && isApiLimitMessage(message));
          outcome = isLimit ? "api_limit" : "error";
          chatSpan.setStatus({ code: SPAN_STATUS_ERROR, message: outcome });
          chatSpan.end();
          this.finalize(agentSpan, agentName, kind, model, conversationId, outcome, usage, startedAt);
          if (isLimit) {
            Sentry.withScope((scope) => {
              scope.setLevel("warning");
              scope.setFingerprint(["claude-api-limit"]);
              scope.setContext("claude_run", { agent: agentName, kind });
              Sentry.captureMessage("Claude API usage limit hit");
            });
            metricCount("ai.api_limit_hits", 1, { kind });
            throw new ClaudeApiLimitError(message);
          }
          throw err;
        }

        chatSpan.end();
        this.finalize(agentSpan, agentName, kind, model, conversationId, outcome, usage, startedAt);
        if (aiRecordContentEnabled() && text) {
          agentSpan.setAttribute("gen_ai.response.text", truncateForAttr(text));
        }
        if (outcome === "empty") throw new Error("Empty response from the AI");
        return [text];
      }
    );
  }

  private finalize(
    agentSpan: Sentry.Span,
    agentName: string,
    kind: string,
    model: string,
    conversationId: string,
    outcome: string,
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number },
    startedAt: number
  ): void {
    const p = PRICES.find((e) => model.includes(e.match)) ?? PRICES[0];
    const costUsd =
      (usage.inputTokens * p.inPerMTok +
        usage.outputTokens * p.outPerMTok +
        usage.cacheReadTokens * p.cacheReadPerMTok +
        usage.cacheCreationTokens * p.cacheWritePerMTok) /
      1_000_000;
    const durationMs = Date.now() - startedAt;

    agentSpan.setAttributes({
      "gen_ai.usage.input_tokens": usage.inputTokens,
      "gen_ai.usage.output_tokens": usage.outputTokens,
      "gen_ai.usage.cache_read_input_tokens": usage.cacheReadTokens,
      "gen_ai.usage.cache_creation_input_tokens": usage.cacheCreationTokens,
      "gen_ai.usage.total_tokens": usage.inputTokens + usage.outputTokens,
      "gen_ai.usage.total_cost": costUsd,
    });
    if (outcome !== "success") {
      agentSpan.setStatus({ code: SPAN_STATUS_ERROR, message: outcome });
    }

    lightLog.info("ai.run.completed", {
      "ai.agent": agentName,
      "ai.kind": kind,
      "ai.outcome": outcome,
      "ai.model": model,
      "ai.session_id": conversationId,
      "ai.input_tokens": usage.inputTokens,
      "ai.output_tokens": usage.outputTokens,
      "ai.cache_read_tokens": usage.cacheReadTokens,
      "ai.cache_creation_tokens": usage.cacheCreationTokens,
      "ai.cost_usd": costUsd,
    });
    metricCount("ai.runs", 1, { kind, agent: agentName, outcome });
    if (usage.inputTokens) metricCount("ai.tokens_used", usage.inputTokens, { direction: "input", kind });
    if (usage.outputTokens) metricCount("ai.tokens_used", usage.outputTokens, { direction: "output", kind });
    if (usage.cacheReadTokens) metricCount("ai.tokens_used", usage.cacheReadTokens, { direction: "cache_read", kind });
    if (usage.cacheCreationTokens) {
      metricCount("ai.tokens_used", usage.cacheCreationTokens, { direction: "cache_write", kind });
    }
    metricDistribution("ai.cost_usd", costUsd, { kind, model }, "usd");
    metricDistribution("ai.run_duration", durationMs, { kind, outcome }, "millisecond");

    const runRecord = {
      agentName,
      kind,
      source: "api",
      model,
      outcome,
      sessionId: conversationId,
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd,
    };
    if (this.aiRunStore) safe(this.aiRunStore.record(runRecord), "ai-run-store");
    exportAiRun(runRecord);
  }
}
