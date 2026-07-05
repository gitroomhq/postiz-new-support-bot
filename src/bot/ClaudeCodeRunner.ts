import { spawn } from "child_process";
import path from "path";

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

export interface ClaudeRunOptions {
  /** Appended to the base allowed tools (Read, Glob, Grep). */
  extraAllowedTools?: string[];
  /** Passed as `--mcp-config <json> --strict-mcp-config` when set. */
  mcpConfig?: Record<string, unknown> | null;
  /** null = send prompt verbatim; undefined = legacy support prefix. */
  promptPrefix?: string | null;
  timeoutMs?: number;
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
    return new Promise((resolve, reject) => {
      const prefix = options.promptPrefix === undefined ? LEGACY_SUPPORT_PREFIX : (options.promptPrefix ?? "");
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
              }

              // New content block — track if it's text
              if (streamEvent.type === "content_block_start" && currentMsgId) {
                if (streamEvent.content_block?.type === "text") {
                  currentTextIndex = streamEvent.index;
                } else {
                  currentTextIndex = null;
                }
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

            // Full assistant message (snapshot) — use as fallback
            if (event.type === "assistant" && event.message?.content) {
              const msgId = event.message.id;
              const textParts: string[] = [];
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  textParts.push(block.text);
                }
              }
              if (textParts.length > 0) {
                if (!messages.has(msgId)) {
                  messageOrder.push(msgId);
                }
                const joined = textParts.join("");
                messages.set(msgId, { id: msgId, text: joined });
                detectApiLimit(joined);
                emitUpdate();
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
        console.error("Claude Code spawn error:", err);
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
          reject(new ClaudeApiLimitError(errorText));
          return;
        }

        if (code !== 0) {
          console.error("Claude Code exited with code:", code, "signal:", signal);
          console.error("Claude Code stderr:", stderr || "(empty)");
          if (isApiLimitError(stderr)) {
            reject(new ClaudeApiLimitError(stderr.trim()));
          } else {
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
          reject(new ClaudeApiLimitError(combinedText));
          return;
        }

        if (allMessages.length === 0) {
          reject(new Error("Empty response from Claude Code"));
          return;
        }

        resolve(allMessages);
      });
    });
  }
}
