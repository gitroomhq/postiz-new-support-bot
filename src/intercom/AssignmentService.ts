import type { SettingsStore } from "../config/SettingsStore";
import type { IntercomClient } from "./IntercomClient";
import type { IntercomStore } from "./IntercomStore";
import type { IntercomAdmin } from "./types";
import { buildPool, pickAssignee, type PoolMember } from "./assignment";
import { log } from "../util/logger";

const assignLog = log.child("intercom:assign");

// TTL for the admins/team snapshot used by webhook-path picks (the 5-min
// enforcement tick refreshes it anyway).
const POOL_CACHE_TTL_MS = 60_000;
// Open-count freshness: counts come from the last enforcement scan. Older
// than this and the webhook path degrades to count-less round-robin (uniform
// counts) rather than fetching the whole workspace per webhook.
const COUNTS_FRESH_MS = 10 * 60_000;

export type WithAuthor = <T>(fn: (adminId: string) => Promise<T>) => Promise<T>;

// Bot-driven balanced assignment (Intercom Advanced lost native workload
// management). Hybrid round-robin over the routing team's members — see
// assignment.ts for the pure balancer. The bot ONLY assigns conversations
// with no admin assignee (human assignment is never overridden); the single
// exception is a customer reply landing on an away/no-longer-pooled assignee,
// which re-routes to the pool. Away teammates receive no new work; their
// queues are never drained. Runs 24/7 — office hours pause SLA clocks only.
export class AssignmentService {
  private adminsCache: { fetchedAt: number; admins: IntercomAdmin[] } | null = null;
  private teamCache: { fetchedAt: number; teamId: string; adminIds: string[] } | null = null;
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

  // Admins + team membership with a short cache. Never throws — assignment is
  // always best-effort decoration of the support flow.
  private async poolMembers(): Promise<PoolMember[] | null> {
    const teamId = this.settingsStore.intercomTeamId();
    if (!teamId) return null;
    const now = Date.now();
    try {
      if (!this.adminsCache || now - this.adminsCache.fetchedAt >= POOL_CACHE_TTL_MS) {
        this.adminsCache = { fetchedAt: now, admins: await this.client.listAdmins() };
      }
      if (!this.teamCache || this.teamCache.teamId !== teamId || now - this.teamCache.fetchedAt >= POOL_CACHE_TTL_MS) {
        const team = await this.client.getTeam(teamId);
        if (!team) return null;
        this.teamCache = { fetchedAt: now, teamId, adminIds: team.adminIds };
      }
    } catch (e) {
      // Stale cache beats no pool — assignment is best-effort.
      assignLog.warn("assignment pool fetch failed", { error: e instanceof Error ? e.message : String(e) });
    }
    const admins = this.adminsCache?.admins;
    const team = this.teamCache;
    if (!admins || !team || team.teamId !== teamId) return null;
    const counts =
      this.openCounts && Date.now() - this.openCounts.computedAt < COUNTS_FRESH_MS
        ? this.openCounts.counts
        : new Map<string, number>(); // stale → uniform counts → plain round-robin
    const excluded = new Set(this.settingsStore.assignExcludedAdmins().map((a) => a.id));
    return buildPool(team.adminIds, admins, this.settingsStore.intercomOperatorAdminId(), excluded, counts);
  }

  // Live pool view for the /intercom Assignment hub (no assignment made).
  async poolPreview(): Promise<{ members: PoolMember[]; cursor: string | null; countsFresh: boolean } | null> {
    const members = await this.poolMembers();
    if (!members) return null;
    return {
      members,
      cursor: this.settingsStore.assignRotationCursor(),
      countsFresh: this.openCounts != null && Date.now() - this.openCounts.computedAt < COUNTS_FRESH_MS,
    };
  }

  // Core assignment. Returns the assignee admin id, or null when no pick was
  // possible. Never throws.
  async assignConversation(
    conversationId: string,
    opts: { threadId?: string | null; ticketId?: string | null; bumpCount?: boolean } = {}
  ): Promise<string | null> {
    try {
      const members = await this.poolMembers();
      if (!members || members.length === 0) return null;
      const pick = pickAssignee(members, this.settingsStore.assignRotationCursor());
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
      // Tickets views agree with the conversation. Best-effort: the
      // conversation assignment is the one that matters.
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
      await this.settingsStore.setAssignRotationCursor(pick.nextCursor);
      // Keep this tick's counts honest so a burst of strays spreads out.
      if (opts.bumpCount !== false && this.openCounts) {
        this.openCounts.counts.set(pick.adminId, (this.openCounts.counts.get(pick.adminId) ?? 0) + 1);
      }
      assignLog.info("conversation assigned", {
        "intercom.conversation_id": conversationId,
        "intercom.assignee_id": pick.adminId,
      });
      return pick.adminId;
    } catch (e) {
      assignLog.warn("assignment failed", {
        "intercom.conversation_id": conversationId,
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  // Creation-time hook (bridge ensure / native conversation.user.created):
  // the conversation is definitionally unassigned, no pre-read needed.
  async maybeAssignOnCreate(conversationId: string, threadId: string | null, ticketId: string | null): Promise<void> {
    if (!this.settingsStore.assignEnabled()) return;
    await this.assignConversation(conversationId, { threadId, ticketId });
  }

  // Customer replied while the current assignee is away or no longer in the
  // pool (covers reopens): re-route to the pool. A conversation with NO
  // assignee is left to the stray sweep — this path must stay webhook-cheap.
  async maybeReassignOnCustomerReply(conversationId: string, currentAssigneeId: string | null, threadId: string | null, ticketId: string | null): Promise<void> {
    if (!this.settingsStore.assignEnabled()) return;
    if (!currentAssigneeId) return;
    const members = await this.poolMembers();
    if (!members) return;
    const current = members.find((m) => m.id === currentAssigneeId);
    const stillWorkable = current != null && !current.away && !current.excluded;
    if (stillWorkable) return;
    assignLog.info("reassigning away/gone assignee on customer reply", {
      "intercom.conversation_id": conversationId,
      "intercom.previous_assignee_id": currentAssigneeId,
    });
    await this.assignConversation(conversationId, { threadId, ticketId });
  }
}
