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
// Worker start only REPORTS them (one audit post listing the tickets): an
// automatic bulk repair on 2026-10-31 reopened and unassigned tickets that
// teammates had closed in Intercom while the bridge could not hear them.
// /ticket Repair sync repairs one ticket: terminate its stranded runs, then
// heal it from its sources. The Discord thread is the source for outbound
// (messages with no delivery record are re-sent with their original
// timestamps, plus a note and the customer-responded flip, see recoveryTail),
// Intercom is the source for inbound (agent replies with no relay record).
// The re-ensure in that heal leaves the ticket's state and routing alone
// (IntercomEventExecutor.ensureBridge). Whatever else the dead run held is
// dropped; a nudge starts a fresh run so the ticket's timers come back.

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
}

export interface TicketRepairResult {
  terminated: number;
  recovered: number;
  inbound: number;
}

export interface StrandedReport {
  tickets: number;
  inboxes: number;
  taskQueues: string[];
  // Ticket threads behind the stranded runs (an inbox run counts through its
  // linked ticket; a native conversation has none).
  threads: string[];
  others: Record<string, number>;
}

const REASON = "stranded on a task queue no worker polls; repaired with /ticket Repair sync";
const LISTED_TICKETS = 25;

export class StrandedRunRepair {
  private reporting: Promise<StrandedReport | null> | null = null;

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

  // Worker start: list what is stranded, touch nothing. Overlapping calls
  // share one pass.
  report(): Promise<StrandedReport | null> {
    if (!this.reporting) {
      this.reporting = this.runReport()
        .catch((e) => {
          strandedLog.error("stranded run report failed", e);
          return null;
        })
        .finally(() => {
          this.reporting = null;
        });
    }
    return this.reporting;
  }

  private async runReport(): Promise<StrandedReport | null> {
    const temporal = this.deps.temporal();
    if (!temporal?.routable()) return null;
    const runs = await temporal.listStrandedRuns();
    const others = await temporal.countOtherStranded().catch((): Record<string, number> => ({}));
    if (runs.length === 0 && Object.keys(others).length === 0) return null;

    const threads = new Set<string>();
    for (const run of runs) {
      if (run.kind === "ticket") {
        threads.add(run.key);
        continue;
      }
      const link = await this.deps.getLinkByConversationId(run.key).catch(() => null);
      if (link) threads.add(link.ticketThreadId);
    }
    const report: StrandedReport = {
      tickets: runs.filter((r) => r.kind === "ticket").length,
      inboxes: runs.filter((r) => r.kind === "inbox").length,
      taskQueues: [...new Set(runs.map((r) => r.taskQueue))],
      threads: [...threads],
      others,
    };
    this.post(report);
    return report;
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

  private post(r: StrandedReport): void {
    const others = Object.entries(r.others).map(([type, n]) => `${type} ×${n}`);
    strandedLog.warn("temporal.stranded_runs_found", {
      "stranded.tickets": r.tickets,
      "stranded.inboxes": r.inboxes,
      "stranded.threads": r.threads.length,
      "stranded.others": others.join(", "),
    });
    const fields: NonNullable<AuditEvent["fields"]> = [];
    if (r.tickets + r.inboxes > 0) {
      fields.push({
        name: "Stranded runs",
        value: `${r.tickets} ticket, ${r.inboxes} inbox (task queue ${r.taskQueues.map((q) => `\`${q}\``).join(", ")})`,
        inline: false,
      });
    }
    if (r.threads.length > 0) {
      const listed = r.threads.slice(0, LISTED_TICKETS).map((t) => `<#${t}>`);
      if (r.threads.length > LISTED_TICKETS) listed.push(`and ${r.threads.length - LISTED_TICKETS} more`);
      fields.push({ name: "Tickets", value: listed.join(" ").slice(0, 1024), inline: false });
    }
    if (others.length > 0) {
      fields.push({ name: "Other workflow types", value: others.join(", ").slice(0, 1024), inline: false });
    }
    this.deps.audit({
      title: "🧵 Stranded Temporal runs found",
      severity: "warn",
      actor: "Temporal",
      description:
        "These workflows are bound to a task queue no worker polls, so nothing sent through them reaches Intercom or Discord. " +
        "Nothing was changed. Repair a ticket with /ticket → Repair sync.",
      fields,
    });
  }
}
