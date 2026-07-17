import type { SettingsStore } from "../config/SettingsStore";
import type { IntercomClient } from "./IntercomClient";
import type { IntercomStore } from "./IntercomStore";
import type { IntercomAdmin } from "./types";
import { buildPool, pickAssignee, type PoolMember } from "./assignment";
import { log } from "../util/logger";

const assignLog = log.child("intercom:assign");

// TTL for the admins/team snapshots used by webhook-path picks (the 5-min
// enforcement tick refreshes counts anyway).
const CACHE_TTL_MS = 60_000;
// Open-count freshness: counts come from the last enforcement scan. Older
// than this and the webhook path degrades to count-less round-robin (uniform
// counts) rather than fetching the whole workspace per webhook.
const COUNTS_FRESH_MS = 10 * 60_000;

export type WithAuthor = <T>(fn: (adminId: string) => Promise<T>) => Promise<T>;

// Bot-driven balanced assignment (Intercom Advanced lost native workload
// management). Assignment is inherently TEAM-scoped — the bot balances a
// conversation WITHIN its assigned team's members (hybrid round-robin; see
// assignment.ts). Each team's enable/exclusions/rotation come from
// SettingsStore's per-team resolution (team override ?? workspace default);
// a conversation with no team can't be balanced (no pool) and is left alone.
// The bot only assigns conversations with no admin assignee (human assignment
// is never overridden); the single exception is a customer reply landing on
// an away/removed assignee. Runs 24/7 — office hours pause SLA clocks only.
export class AssignmentService {
  private adminsCache: { fetchedAt: number; admins: IntercomAdmin[] } | null = null;
  private teamCache = new Map<string, { fetchedAt: number; adminIds: string[] }>();
  private openCounts: { computedAt: number; counts: Map<string, number> } | null = null;

  constructor(
    private client: IntercomClient,
    private store: IntercomStore,
    private settingsStore: SettingsStore,
    private withAuthor: WithAuthor
  ) {}

  // The enforcement tick hands over its per-admin open counts (computed from
  // the same scan that finds strays) so webhook-path picks stay API-free.
  setOpenCounts(counts: Map<string, number>): void {
    this.openCounts = { computedAt: Date.now(), counts };
  }

  private async admins(): Promise<IntercomAdmin[] | null> {
    const now = Date.now();
    if (this.adminsCache && now - this.adminsCache.fetchedAt < CACHE_TTL_MS) return this.adminsCache.admins;
    try {
      const admins = await this.client.listAdmins();
      this.adminsCache = { fetchedAt: now, admins };
      return admins;
    } catch (e) {
      assignLog.warn("assignment admins fetch failed", { error: e instanceof Error ? e.message : String(e) });
      return this.adminsCache?.admins ?? null;
    }
  }

  private async teamMemberIds(teamId: string): Promise<string[] | null> {
    const now = Date.now();
    const cached = this.teamCache.get(teamId);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.adminIds;
    try {
      const team = await this.client.getTeam(teamId);
      if (!team) return cached?.adminIds ?? null;
      this.teamCache.set(teamId, { fetchedAt: now, adminIds: team.adminIds });
      return team.adminIds;
    } catch (e) {
      assignLog.warn("assignment team fetch failed", { "intercom.team_id": teamId, error: e instanceof Error ? e.message : String(e) });
      return cached?.adminIds ?? null;
    }
  }

  // The balanced pool for one team: its members minus Operator/Fin minus that
  // team's resolved exclusion list, with resolved open counts.
  private async poolForTeam(teamId: string): Promise<PoolMember[] | null> {
    const [admins, memberIds] = await Promise.all([this.admins(), this.teamMemberIds(teamId)]);
    if (!admins || !memberIds) return null;
    const counts =
      this.openCounts && Date.now() - this.openCounts.computedAt < COUNTS_FRESH_MS
        ? this.openCounts.counts
        : new Map<string, number>(); // stale → uniform counts → plain round-robin
    const excluded = new Set(this.settingsStore.resolveAssignExcludedAdmins(teamId).map((a) => a.id));
    return buildPool(memberIds, admins, this.settingsStore.intercomOperatorAdminId(), excluded, counts);
  }

  // Live pool view for the /intercom Assignment hub (no assignment made).
  async poolPreview(teamId: string): Promise<{ members: PoolMember[]; cursor: string | null; countsFresh: boolean } | null> {
    const members = await this.poolForTeam(teamId);
    if (!members) return null;
    return {
      members,
      cursor: this.settingsStore.teamRotationCursor(teamId),
      countsFresh: this.openCounts != null && Date.now() - this.openCounts.computedAt < COUNTS_FRESH_MS,
    };
  }

  // Core assignment for a conversation on `teamId`. Gated by that team's
  // resolved enable. Returns the assignee admin id, or null. Never throws.
  async assignConversation(
    conversationId: string,
    teamId: string | null,
    opts: { threadId?: string | null; ticketId?: string | null; bumpCount?: boolean } = {}
  ): Promise<string | null> {
    if (!teamId) return null; // no team → no pool → cannot balance
    if (!this.settingsStore.resolveAssignEnabled(teamId)) return null;
    try {
      const members = await this.poolForTeam(teamId);
      if (!members || members.length === 0) return null;
      const pick = pickAssignee(members, this.settingsStore.teamRotationCursor(teamId));
      if (!pick) return null;
      // Damper BEFORE the API call: the conversation.admin.assigned webhook can
      // arrive faster than our own bookkeeping.
      if (opts.threadId) await this.store.setLastAssigneeId(opts.threadId, pick.adminId);
      try {
        await this.withAuthor((a) => this.client.assignConversationToAdmin(conversationId, pick.adminId, a));
      } catch (e) {
        if (opts.threadId) await this.store.setLastAssigneeId(opts.threadId, null).catch(() => undefined);
        throw e;
      }
      // Bridged tickets mirror the assignee onto the ticket object so the
      // Tickets views agree with the conversation. Best-effort.
      if (opts.ticketId) {
        await this.withAuthor((a) =>
          this.client.updateTicket(opts.ticketId as string, { assigneeId: pick.adminId, adminId: a })
        ).catch((e) => {
          assignLog.warn("ticket assignee mirror failed", {
            "intercom.ticket_id": opts.ticketId ?? "",
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }
      await this.settingsStore.setTeamRotationCursor(teamId, pick.nextCursor);
      // Keep this tick's counts honest so a burst of strays spreads out.
      if (opts.bumpCount !== false && this.openCounts) {
        this.openCounts.counts.set(pick.adminId, (this.openCounts.counts.get(pick.adminId) ?? 0) + 1);
      }
      assignLog.info("conversation assigned", {
        "intercom.conversation_id": conversationId,
        "intercom.team_id": teamId,
        "intercom.assignee_id": pick.adminId,
      });
      return pick.adminId;
    } catch (e) {
      assignLog.warn("assignment failed", {
        "intercom.conversation_id": conversationId,
        "intercom.team_id": teamId,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  // Creation-time hook (bridge ensure = the routing team; native
  // conversation.user.created = the conversation's team from the webhook):
  // the conversation is definitionally unassigned, no pre-read needed.
  async maybeAssignOnCreate(conversationId: string, teamId: string | null, threadId: string | null, ticketId: string | null): Promise<void> {
    if (!teamId) return;
    await this.assignConversation(conversationId, teamId, { threadId, ticketId });
  }

  // Customer replied while the current assignee is away or no longer in the
  // conversation's team pool (covers reopens): re-route within that team. A
  // conversation with NO assignee is left to the stray sweep.
  async maybeReassignOnCustomerReply(
    conversationId: string,
    currentAssigneeId: string | null,
    teamId: string | null,
    threadId: string | null,
    ticketId: string | null
  ): Promise<void> {
    if (!teamId || !currentAssigneeId) return;
    if (!this.settingsStore.resolveAssignEnabled(teamId)) return;
    const members = await this.poolForTeam(teamId);
    if (!members) return;
    const current = members.find((m) => m.id === currentAssigneeId);
    const stillWorkable = current != null && !current.away && !current.excluded;
    if (stillWorkable) return;
    assignLog.info("reassigning away/gone assignee on customer reply", {
      "intercom.conversation_id": conversationId,
      "intercom.team_id": teamId,
      "intercom.previous_assignee_id": currentAssigneeId,
    });
    await this.assignConversation(conversationId, teamId, { threadId, ticketId });
  }
}
