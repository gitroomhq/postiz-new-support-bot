import type { IntercomLink } from "../generated/prisma/client";
import type { SettingsStore } from "../config/SettingsStore";
import type { TicketStore } from "../bot/TicketStore";
import type { IntercomClient } from "./IntercomClient";
import { isPermanent4xx, isSameStateError } from "./IntercomEventExecutor";
import type { IntercomStore } from "./IntercomStore";
import type { IntercomConversationItem, IntercomTicketState, IntercomTicketStateView } from "./types";
import { bridgedClosingState, decideClose } from "./closeState";
import { log } from "../util/logger";

// Paced writes with a hard cap per sweep; the next 5-minute tick finishes a
// backlog (the one-time backfill can be hundreds of tickets).
const WRITE_SPACING_MS = 400;
const MAX_WRITES_PER_SWEEP = 60;
const MAX_PAGES = 20;
// After the backfill, a sweep only looks at tickets touched in this window:
// the close webhook handles most closes inline, the sweep is the backstop.
const RECENT_WINDOW_S = 2 * 60 * 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CloseOutcome =
  | "resolved"
  | "reclosed"
  | "open"
  | "not-customer-type"
  | "already-resolved"
  | "no-target"
  | "bridged-open"
  | "rejected"
  | "gone";

export interface CloseSweepReport {
  at: Date;
  backfill: boolean;
  scanned: number;
  resolved: number;
  reclosed: number;
  skipped: number;
  rejected: number;
  failed: number;
  capped: boolean;
  backfillDone: boolean;
}

// Resolve on close, the I/O half (decisions in closeState.ts). A closed
// Intercom ticket whose state is not in the Resolved category is moved to the
// picked Resolved state (or its type's own). Four ways in:
//  - conversation.admin.closed on a native conversation, inline;
//  - the bridged closing status push (IntercomEventExecutor), which picks the
//    state before it closes the conversation;
//  - the customer-idle sweep's own auto-close, which writes the state before
//    it closes;
//  - a sweep on the 5-minute SLA enforce tick: the whole history once (the
//    backfill), then recently touched tickets, so a close whose webhook never
//    fired (or was missed) still lands within minutes.
// A ticket write on a closed conversation can reopen it in Intercom, so the
// write carries open: false and the ticket is closed again if the response
// says it came back open.
export class CloseStateService {
  private csLog = log.child("intercom:resolve-on-close");
  // Tickets whose type refused the write; not retried until the process restarts.
  private rejected = new Set<string>();
  private last: CloseSweepReport | null = null;

  constructor(
    private client: IntercomClient,
    private store: IntercomStore,
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private listStates: () => Promise<IntercomTicketState[]>,
    private withAuthor: <T>(fn: (adminId: string) => Promise<T>) => Promise<T>
  ) {}

  active(): boolean {
    return this.settingsStore.resolveOnCloseActive();
  }

  lastSweep(): CloseSweepReport | null {
    return this.last;
  }

  private async workspaceStates(): Promise<IntercomTicketState[]> {
    return this.listStates().catch(() => [] as IntercomTicketState[]);
  }

  // ---- conversation.admin.closed (native conversations) ----

  // A bridged close reaches Intercom through the ticket outbox, which picks the
  // state itself; the sweep covers the rest of the bridged cases.
  async onConversationClosed(item: IntercomConversationItem | undefined): Promise<void> {
    if (!this.active() || !item || item.id == null) return;
    if (item.ticket === null || item.ticket?.state === "resolved") return;
    const conversationId = String(item.id);
    if (await this.store.getLinkByConversationId(conversationId)) return;
    const ticketId =
      item.ticket?.id != null ? String(item.ticket.id) : await this.client.getConversationTicketId(conversationId);
    if (!ticketId) return;
    const outcome = await this.reconcile(ticketId, null, await this.workspaceStates());
    if (outcome === "resolved" || outcome === "reclosed") {
      this.csLog.info("closed ticket resolved", { "intercom.ticket_id": ticketId, "resolve.outcome": outcome });
    }
  }

  // ---- the bridged closing status push ----

  // Never throws: a failed lookup keeps the tag's own mapping and the sweep
  // resolves the ticket later.
  async closingStateFor(ticketId: string, mappedStateId: string | null): Promise<string | null> {
    if (!this.active()) return mappedStateId;
    try {
      const states = await this.listStates();
      const mappedCategory = mappedStateId ? states.find((s) => s.id === mappedStateId)?.category ?? null : null;
      if (mappedStateId && mappedCategory === "resolved") return mappedStateId;
      const view = await this.client.getTicketStateView(ticketId);
      return bridgedClosingState(mappedStateId, mappedCategory, view, states, this.settingsStore.resolveOnCloseStateId());
    } catch (e) {
      this.csLog.warn("closing state lookup failed, keeping the tag mapping", {
        "intercom.ticket_id": ticketId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return mappedStateId;
    }
  }

  // ---- the customer-idle sweep's auto-close ----

  // Called while the conversation is still open, right before the sweep closes
  // it, so no write lands on a closed conversation. True when it wrote.
  async resolveBeforeClose(ticketId: string, adminId: string): Promise<boolean> {
    if (!this.active()) return false;
    const view = await this.client.getTicketStateView(ticketId);
    if (!view) return false;
    const decision = decideClose({ ...view, open: false }, await this.workspaceStates(), this.settingsStore.resolveOnCloseStateId());
    if (decision.action === "skip") return false;
    try {
      await this.client.updateTicket(ticketId, { stateId: decision.stateId, adminId });
    } catch (e) {
      if (!isSameStateError(e)) {
        if (!isPermanent4xx(e)) throw e;
        this.logRejected(ticketId, decision.stateId, e);
        return false;
      }
    }
    await this.store.deleteReplyState(ticketId);
    return true;
  }

  // ---- the shared write ----

  private async reconcile(
    ticketId: string,
    known: IntercomTicketStateView | null,
    states: IntercomTicketState[]
  ): Promise<CloseOutcome> {
    const link = await this.store.getLinkByTicketId(ticketId);
    if (link) {
      // Closed in Intercom while the Discord ticket is still open: the bridge's
      // open/close parity owns that, a state write here would fight it.
      const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
      if (!ticket?.closed) return "bridged-open";
    }
    const view = known ?? (await this.client.getTicketStateView(ticketId));
    if (!view) return "gone";
    const decision = decideClose(view, states, this.settingsStore.resolveOnCloseStateId());
    if (decision.action === "skip") return decision.reason;

    // Bridged: damper first, so the state webhook's echo is recognised as ours
    // and a later push of the same state is skipped. Rolled back on failure.
    const prevSynced = link?.lastSyncedStateId ?? null;
    if (link) await this.store.setLastSyncedStateId(link.ticketThreadId, decision.stateId);
    let reopened = false;
    try {
      const res = await this.withAuthor((a) =>
        this.client.updateTicket(view.id, { stateId: decision.stateId, open: false, adminId: a })
      );
      reopened = res?.open === true;
    } catch (e) {
      if (!isSameStateError(e)) {
        if (link) await this.store.setLastSyncedStateId(link.ticketThreadId, prevSynced).catch(() => {});
        if (!isPermanent4xx(e)) throw e;
        this.rejected.add(view.id);
        this.logRejected(view.id, decision.stateId, e);
        return "rejected";
      }
    }
    // A pending customer-responded restore is moot once the ticket is resolved.
    if (link) await this.store.deleteReplyStateByThread(link.ticketThreadId);
    else await this.store.deleteReplyState(view.id);
    if (!reopened) return "resolved";
    await this.reclose(view.id, link);
    return "reclosed";
  }

  private async reclose(ticketId: string, link: IntercomLink | null): Promise<void> {
    this.csLog.info("state write reopened the ticket, closing it again", { "intercom.ticket_id": ticketId });
    await this.withAuthor((a) => this.client.updateTicket(ticketId, { open: false, adminId: a })).catch((e) => {
      if (!isPermanent4xx(e)) throw e;
    });
    if (link) {
      await this.withAuthor((a) => this.client.setConversationOpen(link.conversationId, false, a)).catch((e) => {
        if (!isPermanent4xx(e)) throw e; // "already closed" is the desired end state
      });
    }
  }

  private logRejected(ticketId: string, stateId: string, e: unknown): void {
    this.csLog.warn("resolve-on-close write rejected", {
      "intercom.ticket_id": ticketId,
      "intercom.state_id": stateId,
      "error.message": e instanceof Error ? e.message : String(e),
    });
  }

  // ---- the sweep (5-minute SLA enforce tick) ----

  // The first sweeps after the feature is switched on walk the whole history
  // (the backfill) until one full pass finds nothing left to write; from then
  // on only recently touched tickets are scanned.
  async sweep(): Promise<CloseSweepReport | null> {
    if (!this.active()) return null;
    const backfill = !this.settingsStore.resolveOnCloseBackfilledAt();
    const report: CloseSweepReport = {
      at: new Date(),
      backfill,
      scanned: 0,
      resolved: 0,
      reclosed: 0,
      skipped: 0,
      rejected: 0,
      failed: 0,
      capped: false,
      backfillDone: false,
    };
    const states = await this.listStates();
    const since = backfill ? null : Math.floor(Date.now() / 1000) - RECENT_WINDOW_S;
    let writes = 0;
    let complete = false;
    let cursor: string | null = null;
    pages: for (let page = 0; page < MAX_PAGES; page++) {
      const { items, nextStartingAfter } = await this.client.searchClosedUnresolvedTickets(since, cursor);
      for (const view of items) {
        report.scanned++;
        if (this.rejected.has(view.id)) {
          report.skipped++;
          continue;
        }
        if (writes >= MAX_WRITES_PER_SWEEP) {
          report.capped = true;
          break pages;
        }
        try {
          // A hit without its type's states is read fresh, so the target is
          // one the type allows.
          const outcome = await this.reconcile(view.id, view.typeStates ? view : null, states);
          if (outcome === "resolved" || outcome === "reclosed" || outcome === "rejected") {
            writes++;
            if (outcome === "rejected") report.rejected++;
            else report.resolved++;
            if (outcome === "reclosed") report.reclosed++;
            await sleep(WRITE_SPACING_MS);
          } else {
            report.skipped++;
          }
        } catch (e) {
          report.failed++;
          this.csLog.warn("resolve-on-close sweep item failed", {
            "intercom.ticket_id": view.id,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!nextStartingAfter) {
        complete = true;
        break;
      }
      cursor = nextStartingAfter;
    }
    if (backfill && complete && report.resolved === 0 && report.failed === 0) {
      await this.settingsStore.recordResolveOnCloseBackfill();
      report.backfillDone = true;
    }
    this.last = report;
    if (report.resolved || report.rejected || report.failed || report.backfillDone) {
      this.csLog.info("resolve-on-close sweep", {
        "resolve.backfill": report.backfill,
        "resolve.scanned": report.scanned,
        "resolve.resolved": report.resolved,
        "resolve.reclosed": report.reclosed,
        "resolve.rejected": report.rejected,
        "resolve.failed": report.failed,
        "resolve.capped": report.capped,
        "resolve.backfill_done": report.backfillDone,
      });
    }
    return report;
  }
}

// One line for the /intercom and web panels.
export function formatCloseSweep(r: CloseSweepReport | null): string {
  if (!r) return "no sweep yet since the bot started";
  const when = r.at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const parts = [`${r.resolved} resolved`];
  if (r.reclosed) parts.push(`${r.reclosed} closed again after the write`);
  if (r.rejected) parts.push(`${r.rejected} rejected by their ticket type`);
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.capped) parts.push("capped, the next tick continues");
  return `${when} (${r.backfill ? "backfill" : "recent closes"}): ${parts.join(", ")}`;
}
