import Anthropic from "@anthropic-ai/sdk";
import { Client, ThreadChannel } from "discord.js";
import { Ticket } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { TicketScoreStore } from "./TicketScoreStore";
import { AiRunStore } from "../bot/AiRunStore";
import {
  SCORING_SYSTEM_PROMPT,
  SCORING_OUTPUT_SCHEMA,
  TicketScoreResult,
  TicketScoreResultType,
  renderScoringUserMessage,
} from "./scoringPrompt";
import { reconcileStaffNames } from "./staffNames";
import { exportAiRun, exportTicketScore } from "../metrics/MetricsExporter";
import { log } from "../util/logger";
import { metricCount } from "../util/instrument";

const scoreLog = log.child("scoring");

// Transcript char budget per ticket (~10k tokens). Long threads keep head+tail;
// the marker tells the model where the cut happened (the prompt covers this).
const TRANSCRIPT_CHAR_BUDGET = 40_000;
const TRANSCRIPT_HEAD_CHARS = 24_000;

// Pause between per-ticket Discord transcript fetches so a 200-ticket backfill
// chunk doesn't hammer the REST API (discord.js also queues 429s internally).
const FETCH_PACING_MS = 250;

// Batch-discounted per-MTok prices used to attribute cost per result. The Batch
// API bills 50% of list price on ALL token classes. Keyed by model-id substring;
// unknown models fall back to Haiku rates (scoringModel is free-text).
const BATCH_PRICES: Array<{ match: string; inPerMTok: number; outPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number }> = [
  { match: "haiku", inPerMTok: 0.5, outPerMTok: 2.5, cacheReadPerMTok: 0.05, cacheWritePerMTok: 0.625 },
  { match: "sonnet", inPerMTok: 1.5, outPerMTok: 7.5, cacheReadPerMTok: 0.15, cacheWritePerMTok: 1.875 },
];

interface ResultUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function batchCostUsd(model: string, u: ResultUsage): number {
  const p = BATCH_PRICES.find((e) => model.includes(e.match)) ?? BATCH_PRICES[0];
  return (
    (u.inputTokens * p.inPerMTok +
      u.outputTokens * p.outPerMTok +
      u.cacheReadTokens * p.cacheReadPerMTok +
      u.cacheCreationTokens * p.cacheWritePerMTok) /
    1_000_000
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SubmitBatchResult {
  submitted: number;
  skipped: number;
  drained: boolean; // no unscored closed tickets remained
  budgetBlocked: boolean;
}

// Background AI quality scoring of closed tickets via the Anthropic Message
// Batches API (flat 50% discount; nobody is waiting on these results) with a
// prompt-cached shared rubric. One batch in flight at a time; batch ids are
// persisted so polling survives restarts.
export class TicketScoringService {
  private anthropic: Anthropic;
  private client: Client | null = null;
  private submitting = false;

  constructor(
    private settings: SettingsStore,
    private scoreStore: TicketScoreStore,
    private aiRunStore: AiRunStore
  ) {
    // Same env var the Claude Code CLI spawn already uses — no new secret.
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  bindClient(client: Client): void {
    this.client = client;
  }

  hasDiscordClient(): boolean {
    return this.client != null;
  }

  // ---- Transcript assembly ----

  // Full thread transcript, oldest-first, rendered for the scoring prompt.
  // Returns null when the thread no longer exists. Works on archived threads.
  // staffNames is the exact set of STAFF display names in the transcript —
  // the allowlist the model's staff[] output is reconciled against later.
  private async fetchTranscript(
    ticket: Ticket
  ): Promise<{ text: string; customerMessages: number; staffNames: string[] } | null> {
    if (!this.client) throw new Error("Discord client not bound yet");
    const channel = await this.client.channels.fetch(ticket.threadId).catch(() => null);
    if (!channel || !channel.isThread()) return null;
    const thread = channel as ThreadChannel;

    const collected: Array<{ ts: Date; role: string; name: string; content: string }> = [];
    const staffNames = new Set<string>();
    let customerMessages = 0;
    let before: string | undefined;
    for (;;) {
      const batch = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!batch || batch.size === 0) break;
      for (const message of batch.values()) {
        const role =
          message.author.id === ticket.customerId ? "CUSTOMER" : message.author.bot ? "BOT" : "STAFF";
        const attachments =
          message.attachments.size > 0
            ? ` ${[...message.attachments.values()].map((a) => `[attachment: ${a.name}]`).join(" ")}`
            : "";
        const embeds = message.embeds
          .map((e) => [e.title, e.description].filter(Boolean).join(" — "))
          .filter(Boolean)
          .join(" | ");
        const content = `${message.content}${attachments}${embeds && !message.content ? embeds : ""}`.trim();
        if (!content) continue;
        if (role === "CUSTOMER") customerMessages++;
        const name = message.member?.displayName ?? message.author.displayName ?? message.author.username;
        if (role === "STAFF") staffNames.add(name);
        collected.push({ ts: message.createdAt, role, name, content });
      }
      before = batch.last()?.id;
      if (batch.size < 100) break;
    }
    collected.sort((a, b) => a.ts.getTime() - b.ts.getTime());

    // The customer's opening question arrives via the ticket modal (posted by
    // the bot), so count it as a customer message for the trivial-ticket check.
    if (ticket.question?.trim()) customerMessages++;

    const lines: string[] = [];
    if (ticket.question?.trim()) {
      lines.push(`[${ticket.createdAt.toISOString()}] CUSTOMER (${ticket.customerDisplayName ?? "customer"}): ${ticket.question.trim()}`);
    }
    for (const m of collected) {
      lines.push(`[${m.ts.toISOString()}] ${m.role} (${m.name}): ${m.content}`);
    }
    let text = lines.join("\n");
    if (text.length > TRANSCRIPT_CHAR_BUDGET) {
      const tail = TRANSCRIPT_CHAR_BUDGET - TRANSCRIPT_HEAD_CHARS;
      text =
        text.slice(0, TRANSCRIPT_HEAD_CHARS) +
        "\n[... transcript truncated: middle portion removed ...]\n" +
        text.slice(text.length - tail);
    }
    return { text, customerMessages, staffNames: [...staffNames] };
  }

  // Snap the model's staff[] names to the transcript's real display names and
  // drop invented ones — a single garbled name would otherwise live forever as
  // a phantom staff tag in Influx. Mutates parsed in place so Postgres and
  // Influx see the same reconciled list; the logs keep the raw model output.
  private reconcileParsedStaff(threadId: string, parsed: TicketScoreResultType, known: string[] | null): void {
    const { staff, snapped, dropped } = reconcileStaffNames(parsed.staff, known);
    for (const s of snapped) {
      scoreLog.warn("scoring.staff_name_snapped", {
        "ticket.thread_id": threadId,
        "scoring.staff_from": s.from,
        "scoring.staff_to": s.to,
      });
    }
    for (const name of dropped) {
      scoreLog.warn("scoring.staff_name_dropped", {
        "ticket.thread_id": threadId,
        "scoring.staff_from": name,
      });
    }
    if (snapped.length) metricCount("scoring.staff_names_snapped", snapped.length);
    if (dropped.length) metricCount("scoring.staff_names_dropped", dropped.length);
    parsed.staff = staff;
  }

  private buildRequestParams(ticket: Ticket, transcript: string): Anthropic.Messages.MessageCreateParamsNonStreaming {
    return {
      model: this.settings.scoringModel(),
      max_tokens: 2_000,
      // Stable cached prefix first (>4096 tokens — Haiku's cache minimum);
      // the volatile ticket content lives in the user message after it.
      system: [
        { type: "text", text: SCORING_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: SCORING_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        },
      },
      messages: [
        {
          role: "user",
          content: renderScoringUserMessage(
            {
              threadId: ticket.threadId,
              category: ticket.categoryId,
              createdAt: ticket.createdAt,
              closedAt: ticket.closedAt,
              csatScore: ticket.csatScore,
            },
            transcript
          ),
        },
      ],
    };
  }

  // ---- Budget guardrail ----

  async dailyBudgetExceeded(): Promise<boolean> {
    const budget = this.settings.scoringMaxBudgetUsdPerDay();
    if (budget <= 0) return true;
    const spent = await this.aiRunStore.costSince(new Date(Date.now() - 24 * 60 * 60 * 1000), "ticket_scoring");
    return spent >= budget;
  }

  async hasPendingBatches(): Promise<boolean> {
    return (await this.scoreStore.pendingBatches()).length > 0;
  }

  // ---- Batch submission ----

  async submitBatch(purpose: "interval" | "backfill"): Promise<SubmitBatchResult> {
    if (this.submitting) return { submitted: 0, skipped: 0, drained: false, budgetBlocked: false };
    this.submitting = true;
    try {
      return await this.doSubmitBatch(purpose);
    } finally {
      this.submitting = false;
    }
  }

  private async doSubmitBatch(purpose: "interval" | "backfill"): Promise<SubmitBatchResult> {
    if (await this.dailyBudgetExceeded()) {
      scoreLog.warn("scoring.budget_exceeded", {
        "scoring.budget_usd": this.settings.scoringMaxBudgetUsdPerDay(),
      });
      return { submitted: 0, skipped: 0, drained: false, budgetBlocked: true };
    }

    const limit = Math.max(1, this.settings.scoringMaxTicketsPerBatch());
    const tickets = await this.scoreStore.listUnscoredClosed(limit);
    if (tickets.length === 0) {
      return { submitted: 0, skipped: 0, drained: true, budgetBlocked: false };
    }

    const requests: Anthropic.Messages.Batches.BatchCreateParams.Request[] = [];
    const staffNamesByThread = new Map<string, string[]>();
    let skipped = 0;
    for (const ticket of tickets) {
      try {
        const transcript = await this.fetchTranscript(ticket);
        if (!transcript) {
          await this.scoreStore.recordSkipped(ticket.threadId, "thread_deleted");
          skipped++;
          continue;
        }
        if (transcript.customerMessages < 2) {
          await this.scoreStore.recordSkipped(ticket.threadId, "too_short");
          skipped++;
          continue;
        }
        staffNamesByThread.set(ticket.threadId, transcript.staffNames);
        requests.push({ custom_id: ticket.threadId, params: this.buildRequestParams(ticket, transcript.text) });
      } catch (err) {
        scoreLog.warn("scoring.transcript_failed", {
          "ticket.thread_id": ticket.threadId,
          "error": String(err),
        });
        skipped++;
      }
      await sleep(FETCH_PACING_MS);
    }

    if (requests.length === 0) {
      // Everything in this chunk was skipped; the next tick pulls the next chunk.
      return { submitted: 0, skipped, drained: false, budgetBlocked: false };
    }

    const batch = await this.anthropic.messages.batches.create({ requests });
    await this.scoreStore.createBatch({
      anthropicBatchId: batch.id,
      purpose,
      model: this.settings.scoringModel(),
      requestCount: requests.length,
    });
    await this.scoreStore.markPending(
      requests.map((r) => ({ ticketThreadId: r.custom_id, staffNames: staffNamesByThread.get(r.custom_id) ?? [] })),
      batch.id,
      this.settings.scoringModel()
    );
    scoreLog.info("scoring.batch_submitted", {
      "scoring.batch_id": batch.id,
      "scoring.purpose": purpose,
      "scoring.requests": requests.length,
      "scoring.skipped": skipped,
    });
    metricCount("scoring.batches_submitted", 1, { purpose });
    return { submitted: requests.length, skipped, drained: false, budgetBlocked: false };
  }

  // ---- Polling & result processing ----

  async pollBatches(): Promise<void> {
    const pending = await this.scoreStore.pendingBatches();
    for (const record of pending) {
      let batch: Anthropic.Messages.Batches.MessageBatch;
      try {
        batch = await this.anthropic.messages.batches.retrieve(record.anthropicBatchId);
      } catch (err) {
        // 404 = the batch is gone (results expire after 29 days) — fail it so
        // its tickets become retryable instead of polling forever.
        if (err instanceof Anthropic.NotFoundError) {
          await this.scoreStore.failBatch(record.anthropicBatchId, "batch not found");
        } else {
          scoreLog.warn("scoring.poll_failed", {
            "scoring.batch_id": record.anthropicBatchId,
            "error": String(err),
          });
        }
        continue;
      }
      if (batch.processing_status !== "ended") continue;
      await this.processEndedBatch(record.anthropicBatchId, record.model);
    }
  }

  private async processEndedBatch(anthropicBatchId: string, model: string): Promise<void> {
    const tickets = new Map<string, Ticket | null>();
    // Staff-name snapshots persisted at submit time (map value null = row from
    // before the snapshot existed → names pass through unvalidated).
    const knownStaff = await this.scoreStore.staffNamesForBatch(anthropicBatchId);
    const totals: ResultUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let succeeded = 0;
    let errored = 0;
    let expired = 0;

    // Results arrive in ANY order — always key on custom_id, never position.
    const results = await this.anthropic.messages.batches.results(anthropicBatchId);
    for await (const entry of results) {
      const threadId = entry.custom_id;
      try {
        if (entry.result.type === "succeeded") {
          const message = entry.result.message;
          const usage: ResultUsage = {
            inputTokens: message.usage.input_tokens ?? 0,
            outputTokens: message.usage.output_tokens ?? 0,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
          };
          totals.inputTokens += usage.inputTokens;
          totals.outputTokens += usage.outputTokens;
          totals.cacheReadTokens += usage.cacheReadTokens;
          totals.cacheCreationTokens += usage.cacheCreationTokens;

          const text = message.content
            .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          const parsed = TicketScoreResult.parse(JSON.parse(text));
          this.reconcileParsedStaff(threadId, parsed, knownStaff.get(threadId) ?? null);
          const costUsd = batchCostUsd(model, usage);
          await this.scoreStore.recordScored(
            threadId,
            parsed,
            { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
            costUsd
          );
          succeeded++;

          // Influx point, timestamped at the ticket's closedAt so backfilled
          // scores land on the timeline correctly.
          if (!tickets.has(threadId)) {
            tickets.set(threadId, await this.lookupTicket(threadId));
          }
          const ticket = tickets.get(threadId) ?? null;
          exportTicketScore({
            threadId,
            category: ticket?.categoryId ?? null,
            cxScore: parsed.cx_score,
            sentimentStart: parsed.customer_sentiment_start,
            sentimentEnd: parsed.customer_sentiment_end,
            agentTone: parsed.agent_overall.tone,
            agentClarity: parsed.agent_overall.clarity,
            agentCorrectness: parsed.agent_overall.correctness,
            resolution: parsed.resolution,
            fcr: parsed.first_contact_resolution,
            escalationNeeded: parsed.escalation_needed,
            topic: parsed.topic,
            staff: parsed.staff,
            ts: ticket?.closedAt ?? undefined,
          });
        } else if (entry.result.type === "expired") {
          expired++;
          await this.scoreStore.recordFailed(threadId, "batch request expired");
        } else {
          // errored | canceled
          errored++;
          const detail =
            entry.result.type === "errored" ? JSON.stringify(entry.result.error).slice(0, 500) : entry.result.type;
          await this.scoreStore.recordFailed(threadId, detail);
        }
      } catch (err) {
        errored++;
        await this.scoreStore
          .recordFailed(threadId, `result processing failed: ${String(err).slice(0, 500)}`)
          .catch(() => undefined);
      }
    }

    const orphaned = await this.scoreStore.resetOrphanedPending(anthropicBatchId);
    const costUsd = batchCostUsd(model, totals);
    await this.scoreStore.closeBatch(anthropicBatchId, { succeeded, errored: errored + orphaned, expired }, costUsd);

    // One aggregated ai_runs row + Influx point per batch.
    const runRecord = {
      agentName: "ticket-scoring",
      kind: "ticket_scoring",
      source: "batch",
      model,
      outcome: "batch_ended",
      batchId: anthropicBatchId,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      costUsd,
    };
    await this.aiRunStore.record(runRecord).catch((err) => {
      scoreLog.warn("scoring.ai_run_record_failed", { "error": String(err) });
    });
    exportAiRun(runRecord);

    scoreLog.info("scoring.batch_ended", {
      "scoring.batch_id": anthropicBatchId,
      "scoring.succeeded": succeeded,
      "scoring.errored": errored + orphaned,
      "scoring.expired": expired,
      "scoring.cost_usd": costUsd,
      "scoring.cache_read_tokens": totals.cacheReadTokens,
    });
    metricCount("scoring.tickets_scored", succeeded);
    if (totals.cacheReadTokens === 0 && succeeded > 1) {
      // The shared rubric should cache across a batch — zero reads means the
      // prefix fell below the model's minimum or was byte-unstable.
      scoreLog.warn("scoring.cache_never_hit", { "scoring.batch_id": anthropicBatchId });
    }
  }

  private async lookupTicket(threadId: string): Promise<Ticket | null> {
    // scoreStore shares the Prisma client; a tiny helper keeps this file free
    // of a direct Prisma dependency.
    return this.scoreStore.getTicket(threadId);
  }

  // ---- Interactive smoke test (/config → "Score one now") ----

  // Non-batch call with the identical prompt/schema: instant result at full
  // (non-discounted) price — negligible for a single ticket.
  async scoreOneNow(threadId: string): Promise<TicketScoreResultType> {
    const ticket = await this.scoreStore.getTicket(threadId);
    if (!ticket) throw new Error("No ticket found for that thread id.");
    if (!ticket.closed) throw new Error("Ticket is still open — only closed tickets are scored.");
    const transcript = await this.fetchTranscript(ticket);
    if (!transcript) throw new Error("Thread no longer exists on Discord.");

    const model = this.settings.scoringModel();
    const response = await this.anthropic.messages.create(this.buildRequestParams(ticket, transcript.text));
    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = TicketScoreResult.parse(JSON.parse(text));
    this.reconcileParsedStaff(threadId, parsed, transcript.staffNames);

    const usage: ResultUsage = {
      inputTokens: response.usage.input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    // Non-batch = 2x the batch rate.
    const costUsd = batchCostUsd(model, usage) * 2;

    await this.scoreStore.markPending([{ ticketThreadId: threadId, staffNames: transcript.staffNames }], "manual", model);
    await this.scoreStore.recordScored(
      threadId,
      parsed,
      { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      costUsd
    );
    const runRecord = {
      agentName: "ticket-scoring",
      kind: "ticket_scoring",
      source: "api",
      model,
      outcome: "success",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd,
    };
    await this.aiRunStore.record(runRecord).catch(() => undefined);
    exportAiRun(runRecord);
    exportTicketScore({
      threadId,
      category: ticket.categoryId,
      cxScore: parsed.cx_score,
      sentimentStart: parsed.customer_sentiment_start,
      sentimentEnd: parsed.customer_sentiment_end,
      agentTone: parsed.agent_overall.tone,
      agentClarity: parsed.agent_overall.clarity,
      agentCorrectness: parsed.agent_overall.correctness,
      resolution: parsed.resolution,
      fcr: parsed.first_contact_resolution,
      escalationNeeded: parsed.escalation_needed,
      topic: parsed.topic,
      staff: parsed.staff,
      ts: ticket.closedAt ?? undefined,
    });
    return parsed;
  }
}
