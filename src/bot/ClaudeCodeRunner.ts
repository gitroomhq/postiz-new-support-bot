import { spawn } from "child_process";
import path from "path";
import * as Sentry from "@sentry/node";
import { log } from "../util/logger";
import {
  aiRecordContentEnabled,
  truncateForAttr,
  metricCount,
  metricDistribution,
  SPAN_STATUS_ERROR,
} from "../util/instrument";

interface StreamMessage {
  id: string;
  text: string;
}

export class ClaudeApiLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeApiLimitError";
  }
}

function isApiLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("api usage limits") ||
    lower.includes("you have reached your specified") ||
    lower.includes("credit balance is too low") ||
    lower.includes("credit balance") ||
    lower.includes("you will regain access") ||
    lower.includes("usage limit")
  );
}

const LEGACY_SUPPORT_PREFIX =
  "We need support for Postiz cloud version only (not self-hosted), Don't modify any code, don't be technical about the answer, just write a final answer in the end, and try to output the reference of line and file in github in the end: ";

const claudeLog = log.child("claude");

export interface ClaudeRunTelemetry {
  /** gen_ai.agent.name — e.g. "support-bugs", "ai-ask". */
  agentName: string;
  kind: "customer_qa" | "staff_command";
}

export interface ClaudeRunOptions {
  /** Appended to the base allowed tools (Read, Glob, Grep). */
  extraAllowedTools?: string[];
  /** Passed as `--mcp-config <json> --strict-mcp-config` when set. */
  mcpConfig?: Record<string, unknown> | null;
  /** null = send prompt verbatim; undefined = legacy support prefix. */
  promptPrefix?: string | null;
  timeoutMs?: number;
  /** Labels the run's gen_ai spans/metrics. */
  telemetry?: ClaudeRunTelemetry;
}

type RunOutcome = "success" | "api_limit" | "error" | "empty";

// Aggregates from the terminal `result` stream-json event (only place the CLI
// reports token usage and cost for the whole run).
interface ResultStats {
  subtype?: string;
  numTurns?: number;
  durationMs?: number;
  durationApiMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  webSearches?: number;
}

export class ClaudeCodeRunner {
  private searchDir: string;
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.searchDir = path.resolve(baseDir, "search");
  }

  /**
   * Path to the compiled Stripe read-only MCP server. Always resolves into
   * dist/ (not src/) because the Claude CLI spawns it with plain node —
   * in ts-node dev mode this requires a prior `pnpm build`.
   */
  stripeServerPath(): string {
    return path.resolve(this.baseDir, "dist/mcp/StripeReadOnlyMcpServer.js");
  }

  async run(
    prompt: string,
    onUpdate?: (messages: string[]) => void,
    options: ClaudeRunOptions = {}
  ): Promise<string[]> {
    const agentName = options.telemetry?.agentName ?? "claude-code";
    const kind: string = options.telemetry?.kind ?? "unspecified";
    const prefix = options.promptPrefix === undefined ? LEGACY_SUPPORT_PREFIX : (options.promptPrefix ?? "");

    const agentAttributes: Record<string, string | number | boolean> = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.system": "anthropic",
      "gen_ai.agent.name": agentName,
      "gen_ai.request.model": "sonnet",
      "gen_ai.response.streaming": true,
    };
    if (aiRecordContentEnabled()) {
      agentAttributes["gen_ai.request.messages"] = truncateForAttr(
        JSON.stringify([{ role: "user", content: prefix + prompt }])
      );
    }

    // The whole CLI run is one gen_ai.invoke_agent span; it nests under the
    // active Discord-interaction transaction when there is one.
    return Sentry.startSpan(
      { name: `invoke_agent ${agentName}`, op: "gen_ai.invoke_agent", attributes: agentAttributes },
      (agentSpan) =>
        new Promise<string[]>((resolve, reject) => {
          const allowedTools = ["Read", "Glob", "Grep", ...(options.extraAllowedTools ?? [])];
          const args = [
            "-p",
            prefix + prompt,
            "--allowedTools", ...allowedTools,
            "--permission-mode", "bypassPermissions",
            "--model", "sonnet",
            "--no-session-persistence",
            "--bare",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
          ];
          if (options.mcpConfig) {
            // --strict-mcp-config: cwd is search/ with two cloned third-party
            // repos — never pick up an .mcp.json from them.
            args.push("--mcp-config", JSON.stringify(options.mcpConfig), "--strict-mcp-config");
          }

          const claudeBin = path.resolve(__dirname, "../../node_modules/.bin/claude");

          const child = spawn(claudeBin, args, {
            cwd: this.searchDir,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: options.timeoutMs ?? 120_000,
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
              IS_SANDBOX: "1",
            },
          });

          child.stdin.end();

          const messages = new Map<string, StreamMessage>();
          const messageOrder: string[] = [];
          let currentMsgId: string | null = null;
          let currentTextIndex: number | null = null;
          let stderr = "";
          let buffer = "";
          let apiLimitDetected = false;

          // gen_ai child spans. stdout "data" callbacks do not run inside the
          // agent span's async context, so children are created with an
          // explicit parent via withActiveSpan + startInactiveSpan.
          const chatSpans = new Map<string, Sentry.Span>(); // message id → span
          const toolSpans = new Map<string, { span: Sentry.Span; name: string }>(); // tool_use id → span
          let toolCallCount = 0;
          let toolErrorCount = 0;
          let modelName = "sonnet";
          let sessionId: string | undefined;
          let stats: ResultStats = {};
          const startedAt = Date.now();
          let finalized = false;

          const childSpan = (spanOptions: {
            name: string;
            op: string;
            attributes: Record<string, string | number | boolean>;
          }): Sentry.Span => Sentry.withActiveSpan(agentSpan, () => Sentry.startInactiveSpan(spanOptions));

          const openChatSpan = (messageId: string): Sentry.Span => {
            let span = chatSpans.get(messageId);
            if (!span) {
              span = childSpan({
                name: `chat ${modelName}`,
                op: "gen_ai.chat",
                attributes: {
                  "gen_ai.operation.name": "chat",
                  "gen_ai.system": "anthropic",
                  "gen_ai.request.model": modelName,
                  "gen_ai.agent.name": agentName,
                },
              });
              chatSpans.set(messageId, span);
            }
            return span;
          };

          // Closes remaining spans, stamps run aggregates on the agent span and
          // emits the wide log event + metrics. Runs exactly once per run.
          const finalize = (outcome: RunOutcome) => {
            if (finalized) return;
            finalized = true;
            for (const [, entry] of toolSpans) {
              entry.span.setStatus({ code: SPAN_STATUS_ERROR, message: "aborted" });
              entry.span.end();
            }
            toolSpans.clear();
            for (const [, span] of chatSpans) {
              span.setStatus({ code: SPAN_STATUS_ERROR, message: "aborted" });
              span.end();
            }
            chatSpans.clear();

            const attrs: Record<string, string | number | boolean> = { "claude_code.outcome": outcome };
            if (stats.subtype) attrs["claude_code.subtype"] = stats.subtype;
            if (stats.numTurns !== undefined) attrs["claude_code.num_turns"] = stats.numTurns;
            if (stats.durationApiMs !== undefined) attrs["claude_code.duration_api_ms"] = stats.durationApiMs;
            if (stats.webSearches !== undefined) attrs["claude_code.web_search_requests"] = stats.webSearches;
            if (sessionId) attrs["claude_code.session_id"] = sessionId;
            if (stats.inputTokens !== undefined || stats.outputTokens !== undefined) {
              attrs["gen_ai.usage.input_tokens"] = stats.inputTokens ?? 0;
              attrs["gen_ai.usage.output_tokens"] = stats.outputTokens ?? 0;
              attrs["gen_ai.usage.cache_read_input_tokens"] = stats.cacheReadTokens ?? 0;
              attrs["gen_ai.usage.cache_creation_input_tokens"] = stats.cacheCreationTokens ?? 0;
              attrs["gen_ai.usage.total_tokens"] = (stats.inputTokens ?? 0) + (stats.outputTokens ?? 0);
            }
            if (stats.costUsd !== undefined) attrs["gen_ai.usage.total_cost"] = stats.costUsd;
            agentSpan.setAttributes(attrs);
            if (outcome !== "success") {
              agentSpan.setStatus({ code: SPAN_STATUS_ERROR, message: outcome });
            }

            claudeLog.info("ai.run.completed", {
              "ai.agent": agentName,
              "ai.kind": kind,
              "ai.outcome": outcome,
              "ai.model": modelName,
              "ai.session_id": sessionId ?? "",
              "ai.num_turns": stats.numTurns ?? 0,
              "ai.input_tokens": stats.inputTokens ?? 0,
              "ai.output_tokens": stats.outputTokens ?? 0,
              "ai.cache_read_tokens": stats.cacheReadTokens ?? 0,
              "ai.cache_creation_tokens": stats.cacheCreationTokens ?? 0,
              "ai.cost_usd": stats.costUsd ?? 0,
              "ai.tool_calls": toolCallCount,
              "ai.tool_errors": toolErrorCount,
              "ai.web_searches": stats.webSearches ?? 0,
            });
            metricCount("ai.runs", 1, { kind, agent: agentName, outcome });
            if (stats.inputTokens) metricCount("ai.tokens_used", stats.inputTokens, { direction: "input", kind });
            if (stats.outputTokens) metricCount("ai.tokens_used", stats.outputTokens, { direction: "output", kind });
            if (stats.cacheReadTokens) {
              metricCount("ai.tokens_used", stats.cacheReadTokens, { direction: "cache_read", kind });
            }
            if (stats.cacheCreationTokens) {
              metricCount("ai.tokens_used", stats.cacheCreationTokens, { direction: "cache_write", kind });
            }
            if (stats.costUsd !== undefined) {
              metricDistribution("ai.cost_usd", stats.costUsd, { kind, model: modelName }, "usd");
            }
            metricDistribution(
              "ai.run_duration",
              stats.durationMs ?? Date.now() - startedAt,
              { kind, outcome },
              "millisecond"
            );
          };

          const reportApiLimit = () => {
            // One grouped warning issue for every limit hit instead of noise.
            Sentry.withScope((scope) => {
              scope.setLevel("warning");
              scope.setFingerprint(["claude-api-limit"]);
              scope.setContext("claude_run", { agent: agentName, kind });
              Sentry.captureMessage("Claude API usage limit hit");
            });
            metricCount("ai.api_limit_hits", 1, { kind });
          };

          const detectApiLimit = (text: string): boolean => {
            if (apiLimitDetected) return true;
            if (!text) return false;
            if (isApiLimitError(text)) {
              apiLimitDetected = true;
              // Kill the process so the close handler fires quickly — Claude Code
              // may otherwise retry/hang after a 400, leaving Discord stuck on
              // the partial error + "Generating..." streaming state.
              try {
                if (!child.killed) child.kill("SIGTERM");
              } catch {}
              // Safety net in case SIGTERM is ignored
              setTimeout(() => {
                try {
                  if (!child.killed) child.kill("SIGKILL");
                } catch {}
              }, 1000).unref?.();
              return true;
            }
            return false;
          };

          const emitUpdate = () => {
            if (apiLimitDetected) return;
            const texts = messageOrder
              .map((id) => messages.get(id)!.text)
              .filter((t) => t.length > 0);
            if (texts.length > 0) {
              onUpdate?.(texts);
            }
          };

          child.stdout.on("data", (data) => {
            buffer += data.toString();

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              // Check raw line for API limit signatures — catches event types
              // we don't specifically handle (system, result, etc.) and raw
              // non-JSON error prints alike.
              if (detectApiLimit(line)) continue;
              try {
                const event = JSON.parse(line);

                // First line of every run: model, session, MCP server health.
                if (event.type === "system" && event.subtype === "init") {
                  if (typeof event.model === "string" && event.model) modelName = event.model;
                  if (typeof event.session_id === "string") sessionId = event.session_id;
                  agentSpan.setAttributes({
                    "gen_ai.request.model": modelName,
                    "gen_ai.response.model": modelName,
                    "claude_code.version": String(event.claude_code_version ?? ""),
                    "claude_code.session_id": sessionId ?? "",
                  });
                  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
                  if (servers.length > 0) {
                    agentSpan.setAttribute(
                      "claude_code.mcp_servers",
                      servers.map((s: { name?: string; status?: string }) => `${s.name}:${s.status}`).join(",")
                    );
                    for (const s of servers) {
                      if (s.status !== "connected") {
                        claudeLog.warn("mcp server not connected", {
                          "mcp.server": String(s.name ?? ""),
                          "mcp.status": String(s.status ?? ""),
                          "ai.agent": agentName,
                        });
                      }
                    }
                  }
                }

                if (event.type === "stream_event") {
                  const streamEvent = event.event;

                  // New message started
                  if (streamEvent.type === "message_start" && streamEvent.message?.id) {
                    currentMsgId = streamEvent.message.id;
                    if (!messages.has(currentMsgId!)) {
                      messages.set(currentMsgId!, { id: currentMsgId!, text: "" });
                      messageOrder.push(currentMsgId!);
                    }
                    currentTextIndex = null;
                    openChatSpan(currentMsgId!);
                  }

                  // New content block — track if it's text
                  if (streamEvent.type === "content_block_start" && currentMsgId) {
                    if (streamEvent.content_block?.type === "text") {
                      currentTextIndex = streamEvent.index;
                    } else {
                      currentTextIndex = null;
                    }
                  }

                  // Tool call begins — one gen_ai.execute_tool span per call,
                  // ended when the matching tool_result arrives.
                  if (
                    streamEvent.type === "content_block_start" &&
                    streamEvent.content_block?.type === "tool_use" &&
                    streamEvent.content_block.id
                  ) {
                    const block = streamEvent.content_block;
                    const toolName = String(block.name ?? "");
                    toolCallCount++;
                    toolSpans.set(block.id, {
                      span: childSpan({
                        name: `execute_tool ${toolName}`,
                        op: "gen_ai.execute_tool",
                        attributes: {
                          "gen_ai.operation.name": "execute_tool",
                          "gen_ai.system": "anthropic",
                          "gen_ai.tool.name": toolName,
                          "gen_ai.tool.call.id": String(block.id),
                          "gen_ai.tool.type": toolName.startsWith("mcp__") ? "mcp" : "function",
                          "gen_ai.agent.name": agentName,
                        },
                      }),
                      name: toolName,
                    });
                  }

                  // Text delta — append to current message
                  if (
                    streamEvent.type === "content_block_delta" &&
                    currentMsgId &&
                    currentTextIndex !== null &&
                    streamEvent.index === currentTextIndex &&
                    streamEvent.delta?.type === "text_delta" &&
                    streamEvent.delta?.text
                  ) {
                    const msg = messages.get(currentMsgId);
                    if (msg) {
                      msg.text += streamEvent.delta.text;
                      detectApiLimit(msg.text);
                      emitUpdate();
                    }
                  }

                  // Content block stopped
                  if (streamEvent.type === "content_block_stop") {
                    if (streamEvent.index === currentTextIndex) {
                      currentTextIndex = null;
                    }
                  }
                }

                // Full assistant message (snapshot) — closes the chat span
                // (usage lives here) and doubles as the text fallback.
                if (event.type === "assistant" && event.message) {
                  const msg = event.message;
                  const msgId: string | undefined = msg.id;
                  const content: Array<{
                    type?: string;
                    text?: string;
                    id?: string;
                    name?: string;
                    input?: unknown;
                  }> = Array.isArray(msg.content) ? msg.content : [];

                  if (msgId) {
                    // Lazy-open covers snapshots whose message_start we missed.
                    const chatSpan = openChatSpan(msgId);
                    const usage = msg.usage ?? {};
                    chatSpan.setAttributes({
                      "gen_ai.usage.input_tokens": Number(usage.input_tokens ?? 0),
                      "gen_ai.usage.output_tokens": Number(usage.output_tokens ?? 0),
                      "gen_ai.usage.cache_read_input_tokens": Number(usage.cache_read_input_tokens ?? 0),
                      "gen_ai.usage.cache_creation_input_tokens": Number(usage.cache_creation_input_tokens ?? 0),
                      "gen_ai.response.model": String(msg.model ?? modelName),
                    });
                    if (msg.stop_reason) chatSpan.setAttribute("gen_ai.response.stop_reason", String(msg.stop_reason));
                    if (aiRecordContentEnabled()) {
                      const text = content
                        .filter((b) => b.type === "text" && b.text)
                        .map((b) => b.text)
                        .join("");
                      if (text) chatSpan.setAttribute("gen_ai.response.text", truncateForAttr(text));
                      const toolCalls = content.filter((b) => b.type === "tool_use");
                      if (toolCalls.length > 0) {
                        chatSpan.setAttribute(
                          "gen_ai.response.tool_calls",
                          truncateForAttr(JSON.stringify(toolCalls.map((t) => ({ id: t.id, name: t.name }))), 8_192)
                        );
                      }
                    }
                    if (event.error) {
                      chatSpan.setStatus({ code: SPAN_STATUS_ERROR, message: String(event.error) });
                    }
                    chatSpan.end();
                    chatSpans.delete(msgId);
                  }

                  // The snapshot carries full tool inputs (deltas are skipped).
                  if (aiRecordContentEnabled()) {
                    for (const block of content) {
                      if (block.type === "tool_use" && block.id && block.input !== undefined) {
                        const entry = toolSpans.get(block.id);
                        if (entry) {
                          try {
                            entry.span.setAttribute(
                              "gen_ai.tool.input",
                              truncateForAttr(JSON.stringify(block.input), 8_192)
                            );
                          } catch {}
                        }
                      }
                    }
                  }

                  const textParts: string[] = [];
                  for (const block of content) {
                    if (block.type === "text" && block.text) {
                      textParts.push(block.text);
                    }
                  }
                  if (textParts.length > 0 && msgId) {
                    if (!messages.has(msgId)) {
                      messageOrder.push(msgId);
                    }
                    const joined = textParts.join("");
                    messages.set(msgId, { id: msgId, text: joined });
                    detectApiLimit(joined);
                    emitUpdate();
                  }
                }

                // Tool results come back embedded in synthetic user messages.
                if (event.type === "user" && Array.isArray(event.message?.content)) {
                  for (const block of event.message.content) {
                    if (block?.type === "tool_result" && block.tool_use_id) {
                      const entry = toolSpans.get(block.tool_use_id);
                      if (!entry) continue;
                      if (block.is_error) {
                        entry.span.setStatus({ code: SPAN_STATUS_ERROR, message: "tool_error" });
                        toolErrorCount++;
                      }
                      if (aiRecordContentEnabled() && block.content !== undefined) {
                        try {
                          entry.span.setAttribute(
                            "gen_ai.tool.output",
                            truncateForAttr(
                              typeof block.content === "string" ? block.content : JSON.stringify(block.content),
                              8_192
                            )
                          );
                        } catch {}
                      }
                      entry.span.end();
                      metricCount("ai.tool_calls", 1, { tool: entry.name, ok: !block.is_error });
                      toolSpans.delete(block.tool_use_id);
                    }
                  }
                }

                // Terminal event — the only place run-wide usage/cost exists.
                if (event.type === "result") {
                  const usage = event.usage ?? {};
                  stats = {
                    subtype: typeof event.subtype === "string" ? event.subtype : undefined,
                    numTurns: typeof event.num_turns === "number" ? event.num_turns : undefined,
                    durationMs: typeof event.duration_ms === "number" ? event.duration_ms : undefined,
                    durationApiMs: typeof event.duration_api_ms === "number" ? event.duration_api_ms : undefined,
                    costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
                    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
                    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
                    cacheReadTokens:
                      typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
                    cacheCreationTokens:
                      typeof usage.cache_creation_input_tokens === "number"
                        ? usage.cache_creation_input_tokens
                        : undefined,
                    webSearches:
                      typeof usage.server_tool_use?.web_search_requests === "number"
                        ? usage.server_tool_use.web_search_requests
                        : undefined,
                  };
                  if (aiRecordContentEnabled() && typeof event.result === "string" && event.result) {
                    agentSpan.setAttribute("gen_ai.response.text", truncateForAttr(event.result));
                  }
                }
              } catch {
                // Non-JSON line — already checked via detectApiLimit above.
              }
            }
          });

          child.stderr.on("data", (data) => {
            stderr += data;
            detectApiLimit(stderr);
          });

          child.on("error", (err) => {
            claudeLog.error("spawn failed", err, { "ai.agent": agentName });
            finalize("error");
            reject(new Error("Failed to spawn Claude Code"));
          });

          child.on("close", (code, signal) => {
            // If we detected the API limit mid-stream, always surface that —
            // the non-zero exit code or signal is just a side-effect of our kill.
            if (apiLimitDetected) {
              const combinedText = messageOrder
                .map((id) => messages.get(id)?.text || "")
                .filter((t) => t.length > 0)
                .join("\n");
              const errorText = (combinedText || stderr || "API usage limit reached").trim();
              finalize("api_limit");
              reportApiLimit();
              reject(new ClaudeApiLimitError(errorText));
              return;
            }

            if (code !== 0) {
              claudeLog.error("exited nonzero", undefined, {
                "ai.agent": agentName,
                "process.exit_code": code ?? -1,
                "process.signal": signal ?? "",
                "process.stderr_tail": truncateForAttr(stderr || "(empty)", 1_024),
              });
              if (isApiLimitError(stderr)) {
                finalize("api_limit");
                reportApiLimit();
                reject(new ClaudeApiLimitError(stderr.trim()));
              } else {
                finalize("error");
                reject(new Error("Failed to get a response from Claude Code"));
              }
              return;
            }

            const allMessages = messageOrder
              .map((id) => messages.get(id)!.text)
              .filter((t) => t.length > 0);

            // API limit errors can surface as streamed content on stdout (not stderr)
            const combinedText = allMessages.join("\n");
            if (isApiLimitError(combinedText)) {
              finalize("api_limit");
              reportApiLimit();
              reject(new ClaudeApiLimitError(combinedText));
              return;
            }

            if (allMessages.length === 0) {
              finalize("empty");
              reject(new Error("Empty response from Claude Code"));
              return;
            }

            finalize("success");
            resolve(allMessages);
          });
        })
    );
  }
}
