import type { IntercomLink, StatusTag } from "../generated/prisma/client";
import type { SettingsStore } from "../config/SettingsStore";
import type { TicketStore } from "../bot/TicketStore";
import type { IntercomClient } from "./IntercomClient";
import { isPermanent4xx, isSameStateError } from "./IntercomEventExecutor";
import type { IntercomStore } from "./IntercomStore";
import { isResolvedTag, type IntercomSyncService } from "./IntercomSyncService";
import type {
  IntercomConversationItem,
  IntercomTicketState,
  IntercomTicketStateView,
  IntercomWebhookPart,
  ReplyStatePayload,
  StatusPayload,
} from "./types";
import {
  AGENT_REPLY_ACTOR,
  CUSTOMER_REPLY_ACTOR,
  TRIGGER_CATEGORIES,
  autoTransitionOrigin,
  autoTransitionOriginFromParts,
  isHumanReply,
  isMessagePart,
  lastSpeaker,
  newestCustomerMessageAt,
  pickStateForCategory,
  previousCategoryFromHistory,
  restoreCategory,
} from "./replyState";
import { log } from "../util/logger";

const STATES_TTL_MS = 5 * 60 * 1000;
// A reply payload without the message itself (Intercom's reply-and-assign
// quirk) is answered from the conversation's recent parts.
const FALLBACK_WINDOW_S = 15 * 60;
// One sweep never runs away: open conversations are scanned in pages of 150.
const SWEEP_MAX_PAGES = 20;

export type NativeCustomerOutcome =
  | "moved"
  | "already"
  | "not-ticket"
  | "not-open"
  | "not-customer-type"
  | "not-eligible"
  | "type-lacks-state"
  | "rejected"
  | "gone";

export interface ReplySyncReport {
  scanned: number;
  candidates: number;
  moved: number;
  queued: number;
  already: number;
  typeLacksState: number;
  skipped: number;
  failed: number;
}

// Customer-responded ticket state, the I/O half (decisions in replyState.ts).
//
// Native Intercom tickets run inline from the inbound webhooks: a customer
// reply (conversation.user.replied) moves the ticket into the configured state
// and records where it came from; a teammate reply (conversation.admin.replied)
// moves it back. Bridged Discord tickets ride the per-ticket outbox instead
// ("reply_state" events, executed here), so they stay ordered behind the
// message they react to; their restore also moves the Discord status back,
// and the Intercom state follows the existing tag mapping.
export class ReplyStateService {
  private rsLog = log.child("intercom:reply-state");
  private statesCache: { at: number; states: IntercomTicketState[] } | null = null;
  // Applies a Discord status change for a bridged restore; bound from index.ts
  // (signal into the ticket workflow, direct StatusService otherwise).
  private discordStatus: ((threadId: string, tagId: string, actorName: string) => Promise<void>) | null = null;

  constructor(
    private client: IntercomClient,
    private store: IntercomStore,
    private settingsStore: SettingsStore,
    private ticketStore: TicketStore,
    private sync: IntercomSyncService,
    private withAuthor: <T>(fn: (adminId: string) => Promise<T>) => Promise<T>
  ) {}

  setDiscordStatusRequester(fn: (threadId: string, tagId: string, actorName: string) => Promise<void>): void {
    this.discordStatus = fn;
  }

  // The configured state id while the feature is live, else null.
  customerStateId(): string | null {
    return this.settingsStore.replyStateActive() ? this.settingsStore.replyStateCustomerStateId() : null;
  }

  // Workspace ticket states, cached: the /intercom picker, labels on the
  // panels, and the category lookup when a payload omits the type's states.
  async listStates(force = false): Promise<IntercomTicketState[]> {
    if (!force && this.statesCache && Date.now() - this.statesCache.at < STATES_TTL_MS) return this.statesCache.states;
    const states = await this.client.listTicketStates();
    this.statesCache = { at: Date.now(), states };
    return states;
  }

  async stateById(id: string | null): Promise<IntercomTicketState | null> {
    if (!id) return null;
    const states = await this.listStates().catch(() => [] as IntercomTicketState[]);
    return states.find((s) => s.id === id) ?? null;
  }

  async countActive(): Promise<number> {
    return this.store.countReplyStates();
  }

  private isHumanAdmin = (authorId: string | null): boolean => {
    if (!authorId) return false;
    return authorId !== this.settingsStore.intercomOperatorAdminId() && authorId !== this.settingsStore.intercomAdminId();
  };

  private isBridgeAuthor = (authorId: string | null): boolean => {
    if (!authorId) return false;
    return authorId === this.settingsStore.intercomOperatorAdminId() || authorId === this.settingsStore.intercomAdminId();
  };

  // Writes the ticket state. Same-state is success; any other permanent
  // rejection (the state isn't enabled on this ticket type, ticket gone) is
  // logged and reported as false so no event ever dead-letters over it.
  private async writeState(ticketId: string, stateId: string): Promise<boolean> {
    try {
      await this.withAuthor((a) => this.client.updateTicket(ticketId, { stateId, adminId: a }));
      return true;
    } catch (e) {
      if (isSameStateError(e)) return true;
      if (isPermanent4xx(e)) {
        this.rsLog.warn("ticket state write rejected", {
          "intercom.ticket_id": ticketId,
          "intercom.state_id": stateId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
        return false;
      }
      throw e;
    }
  }

  private async statesFor(view: IntercomTicketStateView): Promise<IntercomTicketState[]> {
    return view.typeStates ?? (await this.listStates());
  }

  private async categoryOf(stateId: string | null, view: IntercomTicketStateView): Promise<string | null> {
    if (!stateId) return null;
    const own = view.typeStates?.find((s) => s.id === stateId);
    if (own) return own.category ?? null;
    return (await this.listStates()).find((s) => s.id === stateId)?.category ?? null;
  }

  // ---- native tickets (inbound webhooks) ----

  // conversation.user.replied on a native conversation.
  async onNativeCustomerReply(conversationId: string, item: IntercomConversationItem | undefined): Promise<void> {
    if (!this.customerStateId()) return;
    const parts = item?.conversation_parts?.conversation_parts ?? [];
    const replyAt = newestCustomerMessageAt(parts) ?? Math.floor(Date.now() / 1000);
    const outcome = await this.applyNativeCustomerReply(conversationId, replyAt);
    if (outcome === "type-lacks-state") {
      this.rsLog.info("customer-responded state not enabled on this ticket type", { "intercom.conversation_id": conversationId });
    }
  }

  async applyNativeCustomerReply(conversationId: string, replyAtSec: number): Promise<NativeCustomerOutcome> {
    const cr = this.customerStateId();
    if (!cr) return "not-eligible";
    const conv = await this.client.getConversationReplyView(conversationId);
    if (!conv) return "gone";
    if (!conv.ticketId) return "not-ticket";
    // A ticket write reopens a closed conversation and wakes a snoozed one.
    if (conv.state !== "open") return "not-open";
    const view = await this.client.getTicketStateView(conv.ticketId);
    if (!view) return "gone";
    if (!view.open) return "not-open";
    if (view.typeCategory && view.typeCategory !== "Customer") return "not-customer-type";
    if (view.stateId === cr) return "already";

    let baseStateId = view.stateId;
    let baseCategory = view.stateCategory;
    if (baseCategory === "in_progress") {
      // Intercom's own Waiting on customer / Resolved → In progress move can
      // land before this read; the state before it is the real base.
      const origin =
        autoTransitionOrigin(view.stateChanges, replyAtSec, this.isHumanAdmin) ??
        (view.stateChanges.length === 0 ? autoTransitionOriginFromParts(conv.parts, replyAtSec, this.isHumanAdmin) : null);
      if (origin) {
        baseStateId = null;
        baseCategory = origin;
      }
    }
    if (!baseCategory || !TRIGGER_CATEGORIES.has(baseCategory)) {
      await this.store.deleteReplyState(view.id);
      return "not-eligible";
    }
    if (view.typeStates && !view.typeStates.some((s) => s.id === cr)) return "type-lacks-state";
    if (!(await this.writeState(view.id, cr))) return "rejected";
    await this.store.upsertReplyState({
      ticketId: view.id,
      conversationId,
      threadId: null,
      baseStateId,
      baseCategory,
      baseTagId: null,
    });
    return "moved";
  }

  // conversation.admin.replied / conversation.operator.replied on a native
  // conversation. Only a person's reply restores; Fin, workflows and the bot
  // itself never do.
  async onNativeAgentReply(conversationId: string, item: IntercomConversationItem | undefined): Promise<void> {
    const cr = this.customerStateId();
    if (!cr) return;
    const parts = item?.conversation_parts?.conversation_parts ?? [];
    let human = parts.some((p) => isHumanReply(p, this.isHumanAdmin));
    // A payload that carries someone else's message (Fin, a bot) is not ours
    // to act on; only a payload without any message falls back to the parts.
    if (!human && parts.some((p) => isMessagePart(p))) return;

    const conv = await this.client.getConversationReplyView(conversationId);
    if (!conv?.ticketId) return;
    if (!human) {
      // Only a reply newer than the customer's last message answers it; an
      // older one was handled when it arrived.
      const since = Math.max(Math.floor(Date.now() / 1000) - FALLBACK_WINDOW_S, newestCustomerMessageAt(conv.parts) ?? 0);
      human = conv.parts.some((p) => (p.created_at ?? 0) > since && isHumanReply(p, this.isHumanAdmin));
      if (!human) return;
    }

    const view = await this.client.getTicketStateView(conv.ticketId);
    if (!view) return;
    const row = await this.store.getReplyState(view.id);
    if (view.stateId !== cr) {
      // Someone moved it on already (by hand, or reply-and-set-state): their
      // choice wins and the pending restore is dropped.
      if (row) await this.store.deleteReplyState(view.id);
      return;
    }
    // Closed or snoozed: a ticket write would reopen it. Keep the row so the
    // next reply after it wakes up restores.
    if (conv.state !== "open") return;

    const states = await this.statesFor(view);
    let target: IntercomTicketState | null = null;
    if (row) {
      const category = restoreCategory(row.baseCategory);
      if (category === row.baseCategory && row.baseStateId) {
        target = states.find((s) => s.id === row.baseStateId && !s.archived) ?? null;
      }
      target ??= pickStateForCategory(states, category, cr);
    } else {
      // Nothing recorded (moved there by hand, or before this shipped): the
      // ticket's own history says where it came from; Waiting on customer
      // when it can't.
      target = pickStateForCategory(states, restoreCategory(previousCategoryFromHistory(view.stateChanges, view.stateCategory)), cr);
    }
    if (target) {
      await this.writeState(view.id, target.id);
    } else {
      this.rsLog.warn("no restore state for this ticket type", { "intercom.ticket_id": view.id });
    }
    await this.store.deleteReplyState(view.id);
  }

  // ---- bridged tickets (the "reply_state" outbox event) ----

  async executeBridged(threadId: string, payload: ReplyStatePayload): Promise<void> {
    const cr = this.customerStateId();
    if (!cr) return;
    const link = await this.store.getLink(threadId);
    if (!link?.ticketId) return;
    const ticket = await this.ticketStore.getByThreadId(threadId);
    if (!ticket || ticket.closed || link.lastSyncedOpen === "closed") {
      if (payload.kind === "agent") await this.store.deleteReplyStateByThread(threadId);
      return;
    }
    const view = await this.client.getTicketStateView(link.ticketId);
    if (!view) return;
    if (payload.kind === "customer") {
      await this.bridgedCustomer(threadId, link, view, cr, payload.baseTagId ?? null);
    } else {
      await this.bridgedAgent(threadId, link, ticket.statusTagId, view, cr);
    }
  }

  private async bridgedCustomer(
    threadId: string,
    link: IntercomLink,
    view: IntercomTicketStateView,
    cr: string,
    baseTagId: string | null
  ): Promise<void> {
    if (view.stateId === cr) return; // a follow-up message: the first base stands
    const baseTag = baseTagId ? this.settingsStore.tagById(baseTagId) : undefined;
    if (baseTag && (baseTag.closesThread || isResolvedTag(baseTag))) return;
    // The Intercom state the ticket had before the message: its pre-message
    // tag's mapping, else what the bridge last pushed, else what is live now.
    const baseStateId = baseTag?.intercomTicketStateId ?? link.lastSyncedStateId ?? view.stateId;
    const baseCategory = (await this.categoryOf(baseStateId, view)) ?? view.stateCategory;
    if (!baseCategory || !TRIGGER_CATEGORIES.has(baseCategory)) return;
    if (view.typeStates && !view.typeStates.some((s) => s.id === cr)) {
      this.rsLog.info("customer-responded state not enabled on this ticket type", { "ticket.thread_id": threadId });
      return;
    }
    if (!(await this.writeState(link.ticketId!, cr))) return;
    await this.store.setLastSyncedStateId(threadId, cr);
    await this.store.upsertReplyState({
      ticketId: link.ticketId!,
      conversationId: link.conversationId,
      threadId,
      baseStateId,
      baseCategory,
      baseTagId: baseTag?.id ?? null,
    });
  }

  private async bridgedAgent(
    threadId: string,
    link: IntercomLink,
    currentTagId: string | null,
    view: IntercomTicketStateView,
    cr: string
  ): Promise<void> {
    const row = await this.store.getReplyStateByThread(threadId);
    if (view.stateId !== cr) {
      if (row) await this.store.deleteReplyStateByThread(threadId);
      return;
    }
    const states = await this.statesFor(view);
    let targetTag: StatusTag | undefined;
    let targetStateId: string | null = null;
    const category = row
      ? restoreCategory(row.baseCategory)
      : restoreCategory(previousCategoryFromHistory(view.stateChanges, view.stateCategory));
    if (row && category === row.baseCategory) {
      // Literal restore: the Discord status from before the customer's message.
      targetTag = row.baseTagId ? this.settingsStore.tagById(row.baseTagId) : undefined;
      if (targetTag?.closesThread || (targetTag && isResolvedTag(targetTag))) targetTag = undefined;
      targetStateId = targetTag?.intercomTicketStateId ?? row.baseStateId;
    }
    if (!targetTag && !targetStateId) {
      if (category === "waiting_on_customer") {
        targetTag = await this.waitingTag();
        targetStateId = targetTag?.intercomTicketStateId ?? null;
      } else {
        targetStateId = pickStateForCategory(states, category, cr)?.id ?? null;
        targetTag = targetStateId
          ? this.settingsStore.tags().find((t) => t.intercomTicketStateId === targetStateId && !t.closesThread)
          : undefined;
      }
    }
    // An unmapped Discord tag still needs an Intercom state to leave this one.
    if (!targetStateId || targetStateId === cr) targetStateId = pickStateForCategory(states, category, cr)?.id ?? null;

    if (targetStateId && (await this.writeState(link.ticketId!, targetStateId))) {
      // Damper first: the Discord status change below pushes its mapped state,
      // which then finds Intercom already there.
      await this.store.setLastSyncedStateId(threadId, targetStateId);
    }
    if (targetTag && targetTag.id !== currentTagId && this.discordStatus) {
      await this.discordStatus(threadId, targetTag.id, AGENT_REPLY_ACTOR);
    }
    await this.store.deleteReplyStateByThread(threadId);
  }

  // The Discord status meaning "waiting on the customer": a non-closing tag
  // mapped to a Waiting on customer state, else one whose reminders target the
  // customer (that is what drives customer reminders and auto-close).
  private async waitingTag(): Promise<StatusTag | undefined> {
    const tags = this.settingsStore.tags().filter((t) => !t.closesThread && !isResolvedTag(t));
    const states = await this.listStates().catch(() => [] as IntercomTicketState[]);
    const wocIds = new Set(states.filter((s) => s.category === "waiting_on_customer").map((s) => s.id));
    return (
      tags.find((t) => t.intercomTicketStateId && wocIds.has(t.intercomTicketStateId)) ??
      tags.find((t) => t.reminderTarget === "CUSTOMER")
    );
  }

  // ---- hooks into the bridged status push (IntercomEventExecutor) ----

  // The customer-reply flip of the Discord status can reach the outbox after
  // the customer-responded write; it must not push the mapped state over it.
  holdsState(link: IntercomLink, payload: StatusPayload): boolean {
    const cr = this.customerStateId();
    if (!cr) return false;
    return payload.actorName === CUSTOMER_REPLY_ACTOR && !payload.closed && !payload.resolved && link.lastSyncedStateId === cr;
  }

  // Any other state reached Intercom through the bridge: nothing to restore.
  async onBridgedStatePushed(threadId: string, stateId: string): Promise<void> {
    if (stateId === this.settingsStore.replyStateCustomerStateId()) return;
    await this.store.deleteReplyStateByThread(threadId);
  }

  // ---- one-time sweep (/intercom → Automation → Sync Now) ----

  // Moves every open ticket whose customer spoke last into the state. Native
  // tickets are decided by the conversation statistics (Fin never counts as a
  // reply there either); bridged ones by their parts, where the bridge's own
  // posts are the Discord staff replies, and are queued through the outbox.
  async syncNow(): Promise<ReplySyncReport> {
    const report: ReplySyncReport = {
      scanned: 0,
      candidates: 0,
      moved: 0,
      queued: 0,
      already: 0,
      typeLacksState: 0,
      skipped: 0,
      failed: 0,
    };
    if (!this.customerStateId()) return report;
    let cursor: string | null = null;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      const { items, nextStartingAfter } = await this.client.searchOpenConversations(cursor);
      for (const conv of items) {
        report.scanned++;
        if (conv.state !== "open" || !conv.lastContactReplyAt) continue;
        try {
          const link = await this.store.getLinkByConversationId(conv.id);
          if (!link) {
            if (conv.lastAdminReplyAt && conv.lastAdminReplyAt.getTime() >= conv.lastContactReplyAt.getTime()) continue;
            report.candidates++;
            const outcome = await this.applyNativeCustomerReply(conv.id, Math.floor(conv.lastContactReplyAt.getTime() / 1000));
            if (outcome === "moved") report.moved++;
            else if (outcome === "already") report.already++;
            else if (outcome === "type-lacks-state") report.typeLacksState++;
            else report.skipped++;
          } else {
            const outcome = await this.queueBridgedFromSweep(link);
            if (outcome === "not-customer-last") continue;
            report.candidates++;
            if (outcome === "queued") report.queued++;
            else report.skipped++;
          }
        } catch (e) {
          report.failed++;
          this.rsLog.warn("reply-state sweep item failed", {
            "intercom.conversation_id": conv.id,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!nextStartingAfter) break;
      cursor = nextStartingAfter;
    }
    return report;
  }

  private async queueBridgedFromSweep(link: IntercomLink): Promise<"queued" | "not-customer-last" | "skipped"> {
    if (!link.ticketId) return "skipped";
    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId);
    if (!ticket || ticket.closed) return "skipped";
    const conv = await this.client.getConversationReplyView(link.conversationId);
    if (!conv) return "skipped";
    const who = lastSpeaker(conv.parts, { bridged: true, isHumanAdmin: this.isHumanAdmin, isBridgeAuthor: this.isBridgeAuthor });
    if (who !== "customer") return "not-customer-last";
    // The live reply flip may already have moved a Waiting-for-Customer ticket
    // to the reply target; its base is then the status before that flip.
    const replyTarget = this.settingsStore.customerReplyTarget();
    const prev = ticket.prevStatusTagId ? this.settingsStore.tagById(ticket.prevStatusTagId) : undefined;
    const baseTagId =
      replyTarget && ticket.statusTagId === replyTarget.id && prev?.reminderTarget === "CUSTOMER" ? prev.id : ticket.statusTagId;
    await this.sync.onReplyState(link.ticketThreadId, { kind: "customer", baseTagId });
    return "queued";
  }
}

export function formatReplySyncReport(r: ReplySyncReport): string {
  const lines = [
    `Scanned ${r.scanned} open conversation(s); ${r.candidates} had the customer speaking last.`,
    `Moved ${r.moved} native ticket(s), queued ${r.queued} Discord-bridged ticket(s).`,
  ];
  if (r.already) lines.push(`${r.already} were already in the state.`);
  if (r.typeLacksState) lines.push(`${r.typeLacksState} skipped: their ticket type does not have the state enabled.`);
  if (r.skipped) lines.push(`${r.skipped} skipped (not a ticket, not open, or not in Submitted / In progress / Waiting on customer).`);
  if (r.failed) lines.push(`${r.failed} failed; rerun to retry them.`);
  return lines.join("\n");
}
