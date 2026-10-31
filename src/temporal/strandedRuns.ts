import type { TicketWithTag } from "../bot/TicketStore";
import type { AuditEvent } from "../bot/AuditLogger";
import type { BridgeSourceMessage } from "../intercom/IntercomSyncService";
import { log } from "../util/logger";
import type { StrandedRun } from "./producers";
import { inboxWorkflowId, ticketWorkflowId } from "./types";

const strandedLog = log.child("temporal:stranded");

// Ticket and inbox workflows bind to the task queue they started on. When the
// queue setting changes (the 2026-08-19 env precedence flip moved prod to
// "main"), every run started before it stays RUNNING on a queue nobody polls:
// Temporal still accepts its signals, so the bridge keeps feeding it, and
// nothing ever fails, so no dead-letter or warning ever shows up.
//
// Repair (operator decision): terminate the stranded run, then heal the ticket
// from its sources. The Discord thread is the source for outbound (messages
// with no delivery record are re-sent with their original timestamps, plus a
// note and the customer-responded flip, see recoveryTail), Intercom is the
// source for inbound (agent replies with no relay record). Whatever else the
// dead run held (status pushes, reminders, SLA writes) is months stale and is
// dropped; a nudge starts a fresh run so the ticket's timers come back.
// Runs on every worker start and from /ticket for one ticket.

export interface StrandedRepairDeps {
  temporal(): {
    routable(): boolean;
    listStrandedRuns(): Promise<StrandedRun[]>;
    countOtherStranded(): Promise<Record<string, number>>;
    terminateStranded(workflowId: string, reason: string): Promise<boolean>;
    nudgeTicket(threadId: string): Promise<unknown>;
  } | null;
  getTicket(threadId: string): Promise<TicketWithTag | null>;
  getLink(threadId: string): Promise<{ conversationId: string } | null>;
  getLinkByConversationId(conversationId: string): Promise<{ ticketThreadId: string } | null>;
  // Null when the thread is gone.
  threadMessages(threadId: string): Promise<BridgeSourceMessage[] | null>;
  // IntercomSyncService.repairTicket: verify-ensure plus the missed-message heal.
  repair(
    ticket: TicketWithTag,
    messages: BridgeSourceMessage[] | null
  ): Promise<{ kind: "backfill"; events: number } | { kind: "heal"; messages: number } | { kind: "queued" } | { kind: "skipped" }>;
  inboundHeal(threadId: string, conversationId: string): Promise<number>;
  audit(entry: AuditEvent): void;
  pause?(): Promise<void>;
}

export interface TicketRepairResult {
  terminated: number;
  recovered: number;
  inbound: number;
}

export interface StrandedSweepResult {
  tickets: number;
  inboxes: number;
  taskQueues: string[];
  repaired: Array<{ threadId: string; recovered: number; inbound: number }>;
  gone: number;
  failed: number;
  others: Record<string, number>;
}

const REASON = "stranded on a task queue no worker polls; repaired by the bot";
const LISTED_TICKETS = 20;

export class StrandedRunRepair {
  private sweeping: Promise<StrandedSweepResult | null> | null = null;

  constructor(private deps: StrandedRepairDeps) {}

  // One ticket (/ticket Repair sync): its own run and its conversation's
  // inbox run, then the heal.
  async repairTicket(threadId: string): Promise<TicketRepairResult> {
    const temporal = this.deps.temporal();
    if (!temporal?.routable()) return { terminated: 0, recovered: 0, inbound: 0 };
    const link = await this.deps.getLink(threadId);
    let terminated = 0;
    if (await temporal.terminateStranded(ticketWorkflowId(threadId), REASON)) terminated++;
    if (link && (await temporal.terminateStranded(inboxWorkflowId(link.conversationId), REASON))) terminated++;
    const healed = await this.heal(threadId);
    return { terminated, recovered: healed?.recovered ?? 0, inbound: healed?.inbound ?? 0 };
  }

  // Every stranded run at once (worker start). Overlapping calls share one pass.
  sweep(): Promise<StrandedSweepResult | null> {
    if (!this.sweeping) {
      this.sweeping = this.runSweep()
        .catch((e) => {
          strandedLog.error("stranded run sweep failed", e);
          return null;
        })
        .finally(() => {
          this.sweeping = null;
        });
    }
    return this.sweeping;
  }

  private async runSweep(): Promise<StrandedSweepResult | null> {
    const temporal = this.deps.temporal();
    if (!temporal?.routable()) return null;
    const runs = await temporal.listStrandedRuns();
    const others = await temporal.countOtherStranded().catch((): Record<string, number> => ({}));
    // Other types are only reported, so without anything to repair they get a
    // log line per boot rather than an audit embed per deploy.
    if (runs.length === 0) {
      if (Object.keys(others).length > 0) {
        strandedLog.warn("temporal.stranded_runs_left", { "stranded.others": formatOthers(others).join(", ") });
      }
      return null;
    }

    const result: StrandedSweepResult = {
      tickets: runs.filter((r) => r.kind === "ticket").length,
      inboxes: runs.filter((r) => r.kind === "inbox").length,
      taskQueues: [...new Set(runs.map((r) => r.taskQueue))],
      repaired: [],
      gone: 0,
      failed: 0,
      others,
    };
    // Terminate everything first: a heal signal must start a fresh run, not
    // land in a dead one that a later step would terminate.
    const threads = new Set<string>();
    for (const run of runs) {
      try {
        await temporal.terminateStranded(run.workflowId, REASON);
      } catch (e) {
        result.failed++;
        strandedLog.warn("stranded run terminate failed", {
          "temporal.workflow_id": run.workflowId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      if (run.kind === "ticket") {
        threads.add(run.key);
      } else {
        // A native conversation has nothing to heal from; its lost events are gone.
        const link = await this.deps.getLinkByConversationId(run.key).catch(() => null);
        if (link) threads.add(link.ticketThreadId);
      }
    }

    for (const threadId of threads) {
      try {
        const healed = await this.heal(threadId);
        if (!healed) result.gone++;
        else if (healed.recovered > 0 || healed.inbound > 0) result.repaired.push({ threadId, ...healed });
      } catch (e) {
        result.failed++;
        strandedLog.warn("stranded ticket heal failed", {
          "ticket.thread_id": threadId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      }
      await this.deps.pause?.();
    }
    this.report(result);
    return result;
  }

  // Null when the ticket or its thread is gone.
  private async heal(threadId: string): Promise<{ recovered: number; inbound: number } | null> {
    const ticket = await this.deps.getTicket(threadId);
    if (!ticket) return null;
    const messages = await this.deps.threadMessages(threadId);
    const repaired = await this.deps.repair(ticket, messages);
    // Exempt or bridge-off tickets queue nothing, but their timers still
    // need a run.
    await this.deps.temporal()?.nudgeTicket(threadId);
    if (messages == null) return null;
    const recovered = repaired.kind === "heal" ? repaired.messages : repaired.kind === "backfill" ? repaired.events : 0;
    const link = await this.deps.getLink(threadId);
    const inbound = link ? await this.deps.inboundHeal(threadId, link.conversationId).catch(() => 0) : 0;
    return { recovered, inbound };
  }

  private report(r: StrandedSweepResult): void {
    const recovered = r.repaired.reduce((n, t) => n + t.recovered, 0);
    const inbound = r.repaired.reduce((n, t) => n + t.inbound, 0);
    const others = formatOthers(r.others);
    strandedLog.warn("temporal.stranded_runs_repaired", {
      "stranded.tickets": r.tickets,
      "stranded.inboxes": r.inboxes,
      "stranded.recovered_messages": recovered,
      "stranded.inbound_parts": inbound,
      "stranded.failed": r.failed,
      "stranded.others": others.join(", "),
    });
    const listed = r.repaired.slice(0, LISTED_TICKETS).map((t) => `<#${t.threadId}> (${t.recovered} out, ${t.inbound} in)`);
    if (r.repaired.length > LISTED_TICKETS) listed.push(`and ${r.repaired.length - LISTED_TICKETS} more`);
    const fields: NonNullable<AuditEvent["fields"]> = [
      {
        name: "Stranded runs",
        value: `${r.tickets} ticket, ${r.inboxes} inbox (task queue ${r.taskQueues.map((q) => `\`${q}\``).join(", ")})`,
        inline: false,
      },
      {
        name: "Recovered",
        value: `${recovered} Discord message(s) re-sent to Intercom, ${inbound} Intercom repl(ies) re-checked`,
        inline: false,
      },
    ];
    if (listed.length > 0) fields.push({ name: "Tickets", value: listed.join("\n").slice(0, 1024), inline: false });
    if (r.gone + r.failed > 0) fields.push({ name: "Skipped", value: `${r.gone} gone, ${r.failed} failed (the next worker start retries)`, inline: false });
    if (others.length > 0) {
      fields.push({ name: "Left alone (other workflow types)", value: others.join(", ").slice(0, 1024), inline: false });
    }
    this.deps.audit({
      title: "🧵 Stranded Temporal runs repaired",
      severity: "warn",
      actor: "Temporal",
      description:
        "These workflows were bound to a task queue no worker polls, so everything sent through them since the queue changed was silently held. " +
        "They were terminated and their tickets healed from Discord and Intercom.",
      fields,
    });
  }
}

function formatOthers(others: Record<string, number>): string[] {
  return Object.entries(others).map(([type, n]) => `${type} ×${n}`);
}
