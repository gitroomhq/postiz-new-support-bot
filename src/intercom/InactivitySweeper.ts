import type { SettingsStore } from "../config/SettingsStore";
import type { IntercomClient } from "./IntercomClient";
import type { IntercomStore } from "./IntercomStore";
import type { InactivitySweepResult } from "../temporal/types";
import { exportIntercomSweep } from "../metrics/MetricsExporter";
import { applyTeam } from "./reminderText";
import { log } from "../util/logger";

const sweepLog = log.child("intercom:sweep");

const DAY_MS = 24 * 60 * 60 * 1000;
// Politeness pacing between Intercom WRITE calls (reads are paged bulk).
const WRITE_SPACING_MS = 400;
// Backstop for a first run against a workspace with a deep idle backlog: the
// sweep stops writing after this many actions and finishes on later ticks.
// Logged when hit — never a silent cap.
const MAX_WRITES_PER_SWEEP = 100;

// Default sweep copy; /config text overrides ({days}/{team} placeholders)
// replace these. Agent-idle notes always name the assigned team (applyTeam).
const DEFAULT_AGENT_NOTE = (days: number): string =>
  `⏰ This conversation has been waiting on an agent reply for ${days} day(s).`;
const DEFAULT_TICKET_NOTE = (days: number): string => `⏰ This ticket has had no activity for ${days} day(s).`;
const DEFAULT_CUSTOMER_NAG =
  "Are you still there? We haven't heard back from you — this conversation will be closed automatically if we don't hear from you.";
const renderDays = (template: string, days: number): string => template.split("{days}").join(String(days));

// Workspace inactivity automation for NATIVE (unbridged) Intercom
// conversations and tickets — Intercom's own workflow triggers are
// channel-gated and never fire on API-created objects, so the bot is the
// automation engine for the whole workspace:
//  - bridged (Discord) tickets: per-ticket timers in ticketWorkflow (not here);
//  - native conversations: agent-idle → internal note; customer-idle →
//    outbound admin nag, auto-close after N unanswered nags;
//  - native tickets (back-office/tracker included): agent-idle → internal
//    note only. Deliberately NO auto-close — they are work items, and
//    silently closing an agent's to-do would destroy state.
// Dampers live in intercom_sweep_state; every step is idempotent and
// per-item best-effort.
export class InactivitySweeper {
  constructor(
    private client: IntercomClient,
    private store: IntercomStore,
    private settingsStore: SettingsStore
  ) {}

  // force = the /config "Run Now" button: bypasses the enabled toggle (a
  // deliberate one-shot test) but never the configuration gate.
  async sweep(force: boolean): Promise<InactivitySweepResult> {
    const result: InactivitySweepResult = { scanned: 0, agentReminders: 0, customerNags: 0, closed: 0, skipped: true };
    if (!this.settingsStore.intercomConfigured()) return result;
    if (!this.settingsStore.inactivityEnabled() && !force) return result;
    // Outbound nags are customer-visible — prefer the configured human admin
    // over the Operator bot as the author.
    const adminId = this.settingsStore.intercomAdminId() ?? this.settingsStore.intercomAuthorAdminId();
    if (!adminId) return result;
    result.skipped = false;

    const now = Date.now();
    const agentWaitMs = Math.max(1, this.settingsStore.inactivityAgentWaitDays()) * DAY_MS;
    const customerWaitMs = Math.max(1, this.settingsStore.inactivityCustomerWaitDays()) * DAY_MS;
    const nagsBeforeClose = Math.max(1, this.settingsStore.inactivityNagsBeforeClose());
    const agentNoteText = this.settingsStore.inactivityAgentNoteText();
    const nagText = this.settingsStore.inactivityNagText();
    let writes = 0;
    let errors = 0;
    let lastWriteAt = 0;
    const paceWrite = async (): Promise<void> => {
      const wait = lastWriteAt + WRITE_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastWriteAt = Date.now();
    };
    // Assigned-team name for the agent-idle notes (client caches /teams, so
    // this is ~one API call per sweep). Falls back to the configured routing
    // team, then a generic label — never fails the note.
    const teamNameFor = async (teamAssigneeId: string | null): Promise<string> => {
      const teamId = teamAssigneeId ?? this.settingsStore.intercomTeamId();
      const name = teamId ? await this.client.getTeamNameCached(teamId).catch(() => null) : null;
      return name ?? "the support team";
    };

    // ---- conversations ----
    let cursor: string | null = null;
    do {
      const page = await this.client.searchOpenConversations(cursor);
      cursor = page.nextStartingAfter;
      for (const conv of page.items) {
        if (writes >= MAX_WRITES_PER_SWEEP) break;
        result.scanned++;
        try {
          // Snoozed = an agent deliberately deferred it; Intercom unsnoozes on
          // its own schedule.
          if (conv.state === "snoozed" || (conv.snoozedUntil && conv.snoozedUntil.getTime() > now)) continue;
          // Bridged conversations are the per-ticket workflow's job.
          if (await this.store.getLinkByConversationId(conv.id)) continue;

          let state = await this.store.getSweepState(conv.id);
          // The sweeper closed it earlier and it is open again (agent/customer
          // reopened) — start a fresh cycle. Mirror the reset locally too, or
          // the nag math below still sees the exhausted pre-close counter and
          // re-closes the just-reopened conversation on this very tick.
          if (state?.sweepClosedAt) {
            await this.store.upsertSweepState(conv.id, "conversation", {
              sweepClosedAt: null,
              customerNagCount: 0,
              lastCustomerNagAt: null,
            });
            state = { ...state, sweepClosedAt: null, customerNagCount: 0, lastCustomerNagAt: null };
          }
          // The opening message is contact activity even before any reply.
          const lastCustomerMs = conv.lastContactReplyAt?.getTime() ?? conv.createdAt?.getTime() ?? 0;
          const lastAdminMs = conv.lastAdminReplyAt?.getTime() ?? 0;

          if (lastCustomerMs > lastAdminMs) {
            // Agent-idle: the customer is waiting. One internal note per wait
            // window; the conversation is already open (search filter), so no
            // state change is needed for it to sit in the inbox.
            const remindedAt = state?.lastAgentRemindedAt?.getTime() ?? 0;
            if (now - lastCustomerMs >= agentWaitMs && now - remindedAt >= agentWaitMs) {
              const days = Math.floor((now - lastCustomerMs) / DAY_MS);
              const team = await teamNameFor(conv.teamAssigneeId);
              await paceWrite();
              await this.client.replyAsAdmin(conv.id, {
                adminId,
                note: true,
                body: applyTeam(agentNoteText ? renderDays(agentNoteText, days) : DEFAULT_AGENT_NOTE(days), team),
              });
              await this.store.upsertSweepState(conv.id, "conversation", {
                lastAgentRemindedAt: new Date(now),
                sweepClosedAt: null,
              });
              writes++;
              result.agentReminders++;
            }
          } else if (lastAdminMs > 0) {
            // Customer-idle: the agent replied last. Nag with a real outbound
            // reply; after N unanswered nags, close conversation + native
            // ticket parity.
            const customerRepliedSinceNag =
              state?.lastCustomerNagAt != null &&
              conv.lastContactReplyAt != null &&
              conv.lastContactReplyAt.getTime() > state.lastCustomerNagAt.getTime();
            const nagCount = customerRepliedSinceNag ? 0 : state?.customerNagCount ?? 0;
            const waitedSince = Math.max(lastAdminMs, customerRepliedSinceNag ? 0 : state?.lastCustomerNagAt?.getTime() ?? 0);
            if (now - waitedSince >= customerWaitMs) {
              await paceWrite();
              if (nagCount >= nagsBeforeClose) {
                // The page snapshot can be minutes stale by now — never close
                // on stale data. Re-fetch: if the conversation is gone, no
                // longer open, or the customer replied meanwhile, skip (and
                // restart the nag cycle on a genuine reply). Fail-safe: any
                // fetch error also skips the close; the next tick retries.
                const fresh = await this.client.getConversationIdleStats(conv.id).catch(() => null);
                const freshCustomerMs = fresh?.lastContactReplyAt?.getTime() ?? fresh?.createdAt?.getTime() ?? 0;
                const freshAdminMs = fresh?.lastAdminReplyAt?.getTime() ?? 0;
                if (!fresh || fresh.state !== "open" || freshCustomerMs > freshAdminMs) {
                  if (fresh && freshCustomerMs > freshAdminMs) {
                    await this.store.upsertSweepState(conv.id, "conversation", {
                      customerNagCount: 0,
                      lastCustomerNagAt: null,
                      sweepClosedAt: null,
                    });
                  }
                  continue;
                }
                await this.client.setConversationOpen(conv.id, false, adminId);
                writes++;
                const nativeTicketId = await this.client.getConversationTicketId(conv.id).catch(() => null);
                if (nativeTicketId) {
                  // Second Intercom write of this close — pace and count it
                  // like any other so a close burst can't defeat the spacing
                  // or the sweep-wide write cap.
                  await paceWrite();
                  await this.client.updateTicket(nativeTicketId, { open: false, adminId }).catch(() => {});
                  writes++;
                }
                await this.store.upsertSweepState(conv.id, "conversation", { sweepClosedAt: new Date(now) });
                result.closed++;
              } else {
                const nagDays = Math.floor((now - waitedSince) / DAY_MS);
                await this.client.replyAsAdmin(conv.id, {
                  adminId,
                  note: false,
                  body: nagText ? renderDays(nagText, nagDays) : DEFAULT_CUSTOMER_NAG,
                });
                await this.store.upsertSweepState(conv.id, "conversation", {
                  customerNagCount: nagCount + 1,
                  lastCustomerNagAt: new Date(now),
                  sweepClosedAt: null,
                });
                result.customerNags++;
                writes++;
              }
            } else if (customerRepliedSinceNag && state) {
              // Not due yet, but the reply must reset the counter so a later
              // silence starts a fresh nag cycle.
              await this.store.upsertSweepState(conv.id, "conversation", { customerNagCount: 0 });
            }
          }
        } catch (e) {
          errors++;
          sweepLog.warn("inactivity sweep: conversation skipped on error", {
            "intercom.conversation_id": conv.id,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
    } while (cursor && writes < MAX_WRITES_PER_SWEEP);

    // ---- native tickets (agent-idle notes only) ----
    cursor = null;
    do {
      const page = await this.client.searchOpenTickets(cursor);
      cursor = page.nextStartingAfter;
      for (const ticket of page.items) {
        if (writes >= MAX_WRITES_PER_SWEEP) break;
        result.scanned++;
        try {
          if (await this.store.getLinkByTicketId(ticket.id)) continue; // bridged
          const stateId = `ticket:${ticket.id}`;
          const lastActivityMs = ticket.updatedAt?.getTime() ?? ticket.createdAt?.getTime() ?? now;
          if (now - lastActivityMs < agentWaitMs) continue;
          const state = await this.store.getSweepState(stateId);
          const remindedAt = state?.lastAgentRemindedAt?.getTime() ?? 0;
          // The note itself bumps the ticket's updated_at, which restarts the
          // idle clock naturally — the damper is a second belt.
          if (now - remindedAt < agentWaitMs) continue;
          const days = Math.floor((now - lastActivityMs) / DAY_MS);
          const team = await teamNameFor(ticket.teamAssigneeId);
          await paceWrite();
          await this.client.replyTicketAsAdmin(ticket.id, {
            adminId,
            note: true,
            body: applyTeam(agentNoteText ? renderDays(agentNoteText, days) : DEFAULT_TICKET_NOTE(days), team),
          });
          await this.store.upsertSweepState(stateId, "ticket", { lastAgentRemindedAt: new Date(now) });
          writes++;
          result.agentReminders++;
        } catch (e) {
          errors++;
          sweepLog.warn("inactivity sweep: ticket skipped on error", {
            "intercom.ticket_id": ticket.id,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
    } while (cursor && writes < MAX_WRITES_PER_SWEEP);

    const capped = writes >= MAX_WRITES_PER_SWEEP;
    sweepLog.info("intercom.inactivity_sweep", {
      "sweep.scanned": result.scanned,
      "sweep.agent_reminders": result.agentReminders,
      "sweep.customer_nags": result.customerNags,
      "sweep.closed": result.closed,
      "sweep.errors": errors,
      "sweep.capped": capped,
      "sweep.forced": force,
    });
    exportIntercomSweep({ ...result, errors });
    return result;
  }
}
