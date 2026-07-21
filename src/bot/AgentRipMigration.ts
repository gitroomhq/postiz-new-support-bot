import { Client, ThreadChannel } from "discord.js";
import type { PrismaClient } from "../generated/prisma/client";
import type { SettingsStore } from "../config/SettingsStore";
import type { AuditLogger } from "./AuditLogger";
import { log } from "../util/logger";

const migLog = log.child("agent-rip-migration");

// Discord thread edits can silently queue behind the ~2/10min rename limit —
// bound each edit like StatusService.editWithGrace and move on (the edit still
// lands FIFO once the limit clears).
const EDIT_GRACE_MS = 3_000;
// Inter-thread pacing: the sweeps are cosmetic/reconciliation work and must
// never crowd out live REST traffic.
const THREAD_SPACING_MS = 1_200;

// Mirrors IntercomSyncService.isResolvedTag — \y is Postgres' word boundary.
const RESOLVED_TAG_SQL = `("emoji" = '✅' OR "label" ~* '\\y(resolved|solved)\\y')`;

export interface AgentRipSweepSummary {
  tagsFlipped: number;
  threadsClosed: number;
  titlesCleaned: number;
  failures: number;
}

// One-time agent-rip migration, in two phases around the boot sequence:
//
// Phase 1 (DB, synchronous — BEFORE settingsStore.load() so the tag cache and
// closingTag() see post-flip truth from the first instruction):
//   1. Resolved-state removal: every ✅/"resolved"-labeled tag becomes a
//      closing tag (tickets are open or closed now). Intercom-invisible —
//      the executor computes resolved = closesThread || isResolvedTag, and
//      the lastSynced* dampers no-op the redundant push.
//   2. remindersPaused reset (the /reminders pause surface is gone; snooze in
//      Intercom is the pause now, via a reminder-free snooze tag).
//
// Phase 2 (Discord sweeps, fire-and-forget after bot.start()):
//   a. Currently-resolved tickets are closed in the DB but their threads were
//      deliberately left open for the (now removed) resolved-auto-close —
//      strip the title and lock+archive them. Direct thread edits, NOT
//      applyStatus: the tickets are already closed in DB + Intercom, and the
//      transition body would post close notices / CSAT prompts per ticket.
//      handleThreadUpdate ignores bot-executor edits, so nothing echoes.
//   b. Open, unarchived threads get their legacy "{status} rest" title emojis
//      stripped (nothing renames threads anymore). Tokens are stripped only
//      when they match a CONFIGURED status emoji, so adopted/plain names are
//      never mangled. (Legacy priority-emoji stripping went with the priority
//      axis — prod migrated before the removal, fresh installs have no legacy
//      titles.)
//
// The flag (BotSettings.agentRipMigratedAt) is stamped only when phase 2
// completes an iteration; per-item failures are counted + audited but don't
// block the stamp (retrying deleted threads forever would be worse). A thrown
// iteration leaves the flag unset — the whole migration re-runs next boot and
// converges via the per-item guards.
export class AgentRipMigration {
  constructor(
    private prisma: PrismaClient,
    private settingsStore: SettingsStore,
    private client: Client,
    private audit: AuditLogger
  ) {}

  // Phase 1. Static + raw SQL: runs before SettingsStore.load(), so nothing
  // here may depend on caches (or even on the flag column being readable via
  // the prisma model — ensureSchema has just added it).
  static async runDbPhase(prisma: PrismaClient): Promise<{ migrated: boolean; tagsFlipped: number }> {
    const rows = await prisma.$queryRawUnsafe<Array<{ agentRipMigratedAt: Date | null }>>(
      `SELECT "agentRipMigratedAt" FROM "bot_settings" WHERE "id" = 'global'`
    );
    // Missing row = fresh install: nothing to migrate, and the sweeps below
    // no-op on empty tables — treat as unmigrated so the flag gets stamped.
    if (rows[0]?.agentRipMigratedAt) return { migrated: true, tagsFlipped: 0 };

    const tagsFlipped = await prisma.$executeRawUnsafe(
      `UPDATE "status_tags" SET "closesThread" = true WHERE "closesThread" = false AND ${RESOLVED_TAG_SQL}`
    );
    await prisma.$executeRawUnsafe(`UPDATE "tickets" SET "remindersPaused" = false WHERE "remindersPaused" = true`);
    if (tagsFlipped > 0) {
      migLog.info("agent-rip phase 1: resolved tags flipped to closing", { "migration.tags_flipped": tagsFlipped });
    }
    return { migrated: false, tagsFlipped };
  }

  // Phase 2. Fire-and-forget after bot.start(); safe to run concurrently with
  // the worker (timers are inert for closed tickets, bot-executor thread edits
  // are ignored by handleThreadUpdate).
  async runDiscordPhase(tagsFlipped: number): Promise<void> {
    if (this.settingsStore.agentRipMigratedAt()) return;
    const summary: AgentRipSweepSummary = { tagsFlipped, threadsClosed: 0, titlesCleaned: 0, failures: 0 };
    try {
      await this.sweepResolvedThreads(summary);
      await this.sweepTitles(summary);
    } catch (e) {
      // Discord/DB down mid-sweep: leave the flag unset — next boot re-runs
      // the (convergent) migration from the top.
      migLog.error("agent-rip phase 2 aborted: will re-run on next boot", e);
      return;
    }
    await this.settingsStore.recordAgentRipMigration();
    migLog.info("agent-rip migration complete", {
      "migration.tags_flipped": summary.tagsFlipped,
      "migration.threads_closed": summary.threadsClosed,
      "migration.titles_cleaned": summary.titlesCleaned,
      "migration.failures": summary.failures,
    });
    void this.audit.log({
      title: "🧹 Agent-rip migration complete",
      severity: summary.failures > 0 ? "warn" : "success",
      actor: "Automatic",
      fields: [
        { name: "Resolved tags → closing", value: String(summary.tagsFlipped), inline: true },
        { name: "Threads closed", value: String(summary.threadsClosed), inline: true },
        { name: "Titles cleaned", value: String(summary.titlesCleaned), inline: true },
        ...(summary.failures > 0
          ? [{ name: "Failures", value: `${summary.failures} (see logs: deleted threads / permissions)`, inline: true }]
          : []),
      ],
    });
  }

  // (a) closed tickets whose tag is resolved-style: lock+archive the thread.
  private async sweepResolvedThreads(summary: AgentRipSweepSummary): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ threadId: string }>>(
      `SELECT t."threadId" FROM "tickets" t
       JOIN "status_tags" s ON s."id" = t."statusTagId"
       WHERE t."closed" = true AND ${RESOLVED_TAG_SQL.replace(/"emoji"/g, `s."emoji"`).replace(/"label"/g, `s."label"`)}`
    );
    for (const row of rows) {
      try {
        const thread = await this.fetchThread(row.threadId);
        if (!thread) continue;
        if (thread.locked && thread.archived) continue;
        // Strip the title while the thread is still writable, then shut it.
        const cleaned = await this.strippedName(thread.name);
        if (cleaned) await this.boundedEdit(thread.setName(cleaned), "rename", row.threadId);
        if (thread.archived && !thread.locked) {
          // Locking needs an active thread.
          await this.boundedEdit(thread.setArchived(false), "unarchive", row.threadId);
        }
        await this.boundedEdit(thread.setLocked(true), "lock", row.threadId);
        await this.boundedEdit(thread.setArchived(true), "archive", row.threadId);
        summary.threadsClosed++;
        if (cleaned) summary.titlesCleaned++;
        await sleep(THREAD_SPACING_MS);
      } catch (e) {
        summary.failures++;
        migLog.warn("resolved-thread sweep: item failed", {
          "ticket.thread_id": row.threadId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // (b) open tickets: strip legacy title emojis (skip archived — a rename
  // would unarchive them; they age out with their frozen titles).
  private async sweepTitles(summary: AgentRipSweepSummary): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ threadId: string }>>(
      `SELECT "threadId" FROM "tickets" WHERE "closed" = false`
    );
    for (const row of rows) {
      try {
        const thread = await this.fetchThread(row.threadId);
        if (!thread || thread.archived || thread.locked) continue;
        const cleaned = await this.strippedName(thread.name);
        if (!cleaned) continue;
        await this.boundedEdit(thread.setName(cleaned), "rename", row.threadId);
        summary.titlesCleaned++;
        await sleep(THREAD_SPACING_MS);
      } catch (e) {
        summary.failures++;
        migLog.warn("title sweep: item failed", {
          "ticket.thread_id": row.threadId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // "{status} rest" → "rest", stripping ONLY configured emojis.
  // Returns null when nothing needs stripping.
  private async strippedName(currentName: string): Promise<string | null> {
    const statusEmojis = new Set(this.settingsStore.tags().map((t) => t.emoji));
    const tokens = currentName.split(" ");
    let index = 0;
    if (index < tokens.length && statusEmojis.has(tokens[index])) index++;
    if (index === 0) return null;
    const rest = tokens.slice(index).join(" ").trim();
    return rest.length > 0 ? rest.slice(0, 100) : null;
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    return channel?.isThread() ? (channel as ThreadChannel) : null;
  }

  // editWithGrace, migration edition: wait briefly, then detach — discord.js
  // delivers the queued edit FIFO once the per-thread limit clears. Only the
  // timeout detaches; a real API error (deleted thread, missing permission)
  // rethrows so the sweeps' per-item catch counts + audits it. A rejection
  // landing after the grace window is already handled here, so it can never
  // become an unhandled rejection.
  private boundedEdit(op: Promise<unknown>, edit: string, threadId: string): Promise<void> {
    const settled = op.then(
      () => ({ pending: false as const, failed: false as const, error: null as unknown }),
      (error: unknown) => ({ pending: false as const, failed: true as const, error })
    );
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<{ pending: true }>((resolve) => {
      timer = setTimeout(() => resolve({ pending: true }), EDIT_GRACE_MS);
      timer.unref?.();
    });
    return Promise.race([settled, grace]).then((outcome) => {
      clearTimeout(timer);
      if (outcome.pending) {
        migLog.warn("thread edit rate-limited: continuing, it lands when the limit clears", {
          "thread.edit": edit,
          "ticket.thread_id": threadId,
        });
        return;
      }
      if (outcome.failed) throw outcome.error;
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
