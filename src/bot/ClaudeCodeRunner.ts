import { spawn } from "child_process";
import path from "path";

interface StreamMessage {
  id: string;
  text: string;
}

export class ClaudeCodeRunner {
  private searchDir: string;

  constructor(baseDir: string) {
    this.searchDir = path.resolve(baseDir, "search");
  }

  async run(prompt: string, onUpdate?: (messages: string[]) => void): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const args = [
        "-p",
        prompt,
        "--allowedTools", "Read", "Glob", "Grep",
        "--permission-mode", "bypassPermissions",
        "--model", "sonnet",
        "--no-session-persistence",
        "--bare",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
      ];

      const claudeBin = path.resolve(__dirname, "../../node_modules/.bin/claude");

      const child = spawn(claudeBin, args, {
        cwd: this.searchDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
      });

      child.stdin.end();

      const messages = new Map<string, StreamMessage>();
      const messageOrder: string[] = [];
      let currentMsgId: string | null = null;
      let currentTextIndex: number | null = null;
      let stderr = "";
      let buffer = "";

      const emitUpdate = () => {
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
                messages.set(msgId, { id: msgId, text: textParts.join("") });
                emitUpdate();
              }
            }
          } catch {
            // skip non-JSON lines
          }
        }
      });

      child.stderr.on("data", (data) => { stderr += data; });

      child.on("error", (err) => {
        console.error("Claude Code spawn error:", err);
        reject(new Error("Failed to spawn Claude Code"));
      });

      child.on("close", (code, signal) => {
        if (code !== 0) {
          console.error("Claude Code exited with code:", code, "signal:", signal);
          console.error("Claude Code stderr:", stderr || "(empty)");
          reject(new Error("Failed to get a response from Claude Code"));
          return;
        }

        const allMessages = messageOrder
          .map((id) => messages.get(id)!.text)
          .filter((t) => t.length > 0);

        if (allMessages.length === 0) {
          reject(new Error("Empty response from Claude Code"));
          return;
        }

        resolve(allMessages);
      });
    });
  }
}
