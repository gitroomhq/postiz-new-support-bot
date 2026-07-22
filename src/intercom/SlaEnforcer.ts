import { PrismaClient } from "../generated/prisma/client";
import type { SettingsStore } from "../config/SettingsStore";
import { IntercomClient, IntercomHttpError } from "./IntercomClient";
import type { IntercomStore } from "./IntercomStore";
import type { IntercomSweepConversation } from "./types";
import type { AssignmentService, WithAuthor } from "./AssignmentService";
import type { SentryFeedbackStore } from "../sentry/SentryFeedbackStore";
import type { SlaEnforceResult } from "../temporal/types";
import { evaluateClocks, CLOCK_LABELS, type ClockEvaluation, type ClockInput, type ClockKind, type ClockMarkers } from "../sla/clocks";
import { hasClockDurations, type SlaTargetEntry } from "../sla/types";
import { exportSlaEnforce } from "../metrics/MetricsExporter";
import { formatDuration } from "../util/format";
import { log } from "../util/logger";

const enforceLog = log.child("sla:enforce");

// Paced writes, hard cap per tick (later ticks finish the backlog), logged when
// hit. Shared across the assignment, clock (recurring nag) and customer-idle
// passes so no single tick can outrun the spacing or the write cap.
const WRITE_SPACING_MS = 400;
const MAX_WRITES_PER_SWEEP = 100;
// 150/page → 12k open conversations. Beyond that we stop scanning (and say so).
const MAX_PAGES = 80;
// Chunk size for `IN (...)` batch lookups.
const DB_CHUNK = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

const AUTOMATION_MARKER = "automated by the support bot";

// Customer-idle nag default copy; /config text overrides ({days}) replace it.
const DEFAULT_CUSTOMER_NAG =
  "Are you still there? We haven't heard back from you; this conversation will be closed automatically if we don't hear from you.";
const renderDays = (template: string, days: number): string => template.split("{days}").join(String(days));

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StateRow {
  id: string;
  kind: string;
  frHumanReplyAt: Date | null;
  frVerifyNoneAt: Date | null;
  frWarnedAt: Date | null;
  frBreachedAt: Date | null;
  frLastNaggedAt: Date | null;
  nrCycleAnchor: Date | null;
  nrWarnedAt: Date | null;
  nrBreachedAt: Date | null;
  nrLastNaggedAt: Date | null;
  resWarnedAt: Date | null;
  resBreachedAt: Date | null;
  lastStatusWritten: string | null;
  breachTagged: boolean;
  lastWrittenTarget: string | null;
  pinnedTarget: string | null;
}

// The bot-native SLA engine's enforcement tick (Intercom Advanced has no
// native SLAs). ONE paged open-conversation scan powers all three jobs:
//  - assignment stray sweep: open conversations with no admin assignee are
//    routed through the hybrid balancer (AssignmentService);
//  - SLA clocks: per-conversation business-time clock evaluation with
//    Intercom-only alerting — the SLA Status attribute (ok/at_risk/breached)
//    and the breach tag (added on breach, removed on recovery). at_risk flips
//    the attribute only; a breached first-reply/next-reply clock RE-NAGS with
//    an internal note every slaNagRepeatMins of business time while it stays
//    breached (the recurring "agent nag" — bridged + native alike, gated on
//    breach: a conversation with no SLA target never nags). Resolution keeps
//    its single one-shot note;
//  - customer-idle sweep (NATIVE conversations only, gated on inactivityEnabled
//    — bridged tickets are the per-ticket workflow's job): after the agent
//    spoke last and the customer went silent, an outbound nag, then auto-close
//    (+ native ticket) after N unanswered nags. Calendar-time, independent of
//    the SLA clocks; dampers live in intercom_sweep_state.
// SLA markers live in sla_states; every write is transition-edged/idempotent
// and every item is best-effort. The three passes share one write budget.
export class SlaEnforcer {
  private tagIdCache: { name: string; id: string } | null = null;

  constructor(
    private prisma: PrismaClient,
    private client: IntercomClient,
    private store: IntercomStore,
    private settingsStore: SettingsStore,
    private withAuthor: WithAuthor,
    private assignment: AssignmentService,
    private feedbackStore: SentryFeedbackStore | null = null
  ) {}

  // Unsnooze re-anchor: the next-reply clock restarts from the unsnooze
  // moment instead of the original waiting_since (a snooze is a deliberate
  // park). Called from the conversation.admin.unsnoozed webhook handler.
  async reanchorAfterUnsnooze(conversationId: string): Promise<void> {
    await this.prisma.slaState
      .updateMany({
        where: { conversationId },
        data: { nrCycleAnchor: new Date(), nrWarnedAt: null, nrBreachedAt: null, nrLastNaggedAt: null },
      })
      .catch(() => undefined);
  }

  // force = the hubs' "Run Now" buttons: bypasses the enabled toggles (a
  // deliberate one-shot test) but never the configuration gate.
  async sweep(force: boolean): Promise<SlaEnforceResult> {
    const result: SlaEnforceResult = {
      scanned: 0,
      assigned: 0,
      statusWrites: 0,
      tagged: 0,
      untagged: 0,
      notes: 0,
      customerNags: 0,
      closed: 0,
      verifies: 0,
      errors: 0,
      capped: false,
      skipped: true,
    };
    if (!this.settingsStore.intercomConfigured()) return result;
    const doClocks = this.settingsStore.slaEnabled() || force;
    const doAssign = this.settingsStore.anyAssignmentEnabled() || force;
    // Customer-idle nag + auto-close (native conversations). Outbound nags are
    // customer-visible, so they need a human admin author; without one the pass
    // is inert even when enabled.
    const inactivityAuthorId = this.settingsStore.intercomAdminId() ?? this.settingsStore.intercomAuthorAdminId();
    const doInactivity = (this.settingsStore.inactivityEnabled() || force) && !!inactivityAuthorId;
    if (!doClocks && !doAssign && !doInactivity) return result;
    result.skipped = false;

    // ---- one paged scan of every open conversation ----
    const items: IntercomSweepConversation[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.client.searchOpenConversations(cursor);
      items.push(...res.items);
      cursor = res.nextStartingAfter;
      if (!cursor) break;
    }
    if (cursor) enforceLog.warn("sla.enforce.scan_truncated", { "sla.scanned": items.length });
    result.scanned = items.length;

    const now = new Date();
    const notSnoozed = (c: IntercomSweepConversation): boolean =>
      c.state === "open" && (!c.snoozedUntil || c.snoozedUntil.getTime() <= now.getTime());

    // Per-admin open workload from the same snapshot (snoozed excluded).
    const openCounts = new Map<string, number>();
    for (const c of items) {
      if (c.state !== "open" || !c.adminAssigneeId) continue;
      openCounts.set(c.adminAssigneeId, (openCounts.get(c.adminAssigneeId) ?? 0) + 1);
    }
    this.assignment.setOpenCounts(openCounts);

    // Shared write budget across assignment + clock actions.
    let writes = 0;
    const budget = (): boolean => {
      if (writes < MAX_WRITES_PER_SWEEP) return true;
      result.capped = true;
      return false;
    };
    const paced = async (): Promise<void> => {
      writes++;
      await sleep(WRITE_SPACING_MS);
    };

    // Batch state: sla_states + bridged links + feedback imports for the
    // whole snapshot.
    const ids = items.map((c) => c.id);
    const stateByConv = new Map<string, StateRow>();
    const linkByConv = new Map<string, { ticketThreadId: string; ticketId: string | null; lastTagsJson: unknown }>();
    // conversationId → converted ticket id (null while unconverted). Presence
    // = feedback import (clock-pass skip); the ticket id feeds stray
    // assignment so balanced picks land on the ticket too (bridge parity).
    const feedbackByConv = new Map<string, string | null>();
    for (const ch of chunk(ids, DB_CHUNK)) {
      const rows = await this.prisma.slaState.findMany({ where: { conversationId: { in: ch } } });
      for (const r of rows) if (r.conversationId) stateByConv.set(r.conversationId, r as unknown as StateRow);
      const links = await this.prisma.intercomLink.findMany({
        where: { conversationId: { in: ch } },
        select: { conversationId: true, ticketThreadId: true, ticketId: true, lastTagsJson: true },
      });
      for (const l of links) {
        if (l.conversationId) {
          linkByConv.set(l.conversationId, {
            ticketThreadId: l.ticketThreadId,
            ticketId: l.ticketId,
            lastTagsJson: l.lastTagsJson,
          });
        }
      }
      if (this.feedbackStore) {
        for (const ref of await this.feedbackStore.mapImportedRefs(ch)) feedbackByConv.set(ref.conversationId, ref.ticketId);
      }
    }

    // ---- assignment pass (before clocks: counts are freshest here) ----
    // A stray can only be balanced within its OWN team's pool; per-team enable
    // is resolved inside assignConversation. Strays with no team are skipped
    // (nothing to balance them against).
    if (doAssign) {
      const strays = items.filter(
        (c) => notSnoozed(c) && !c.adminAssigneeId && c.teamAssigneeId && this.settingsStore.resolveAssignEnabled(c.teamAssigneeId)
      );
      for (const stray of strays) {
        if (!budget()) break;
        try {
          // Snapshot staleness guard: a teammate may have grabbed it mid-scan.
          const live = await this.client.getConversationSlaFacts(stray.id);
          if (!live || !live.open || live.adminAssigneeId) continue;
          const link = linkByConv.get(stray.id) ?? null;
          const assignee = await this.assignment.assignConversation(stray.id, stray.teamAssigneeId, {
            threadId: link?.ticketThreadId ?? null,
            ticketId: link?.ticketId ?? feedbackByConv.get(stray.id) ?? null,
          });
          if (assignee) {
            result.assigned++;
            await paced();
          }
        } catch (e) {
          result.errors++;
          enforceLog.warn("sla.enforce.assign_failed", {
            "intercom.conversation_id": stray.id,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    // ---- clock pass ----
    if (doClocks) {
      const targets = new Map(this.settingsStore.slaTargets().map((t) => [t.value, t]));
      const warnPct = this.settingsStore.slaWarnPct();
      const nagRepeatMs = this.settingsStore.slaNagRepeatMins() * 60_000;
      const nagNoteText = this.settingsStore.slaNagNoteText();
      const attrName = this.settingsStore.slaAttributeName();
      const statusAttrName = this.settingsStore.slaStatusAttributeName();
      // Office-hours schedule is resolved per conversation from its team
      // (team override ?? workspace default); cache per team for the tick.
      const scheduleCache = new Map<string, ReturnType<SettingsStore["resolveOfficeHours"]>>();
      const scheduleFor = (teamId: string | null) => {
        const key = teamId ?? "";
        if (!scheduleCache.has(key)) scheduleCache.set(key, this.settingsStore.resolveOfficeHours(teamId));
        return scheduleCache.get(key) ?? null;
      };
      // {team} in a custom nag note names the conversation's assigned team;
      // /teams is client-cached, so this is ~one API call per team per tick.
      const teamNameFor = async (teamId: string | null): Promise<string> => {
        const id = teamId ?? this.settingsStore.intercomTeamId();
        const name = id ? await this.client.getTeamNameCached(id).catch(() => null) : null;
        return name ?? "the support team";
      };
      // One warn per tick when the status attribute definition is missing —
      // not one per conversation per tick.
      let statusAttrBroken = false;

      for (const conv of items) {
        if (!budget()) break;
        if (!notSnoozed(conv)) continue;
        // Imported Sentry feedback runs no clocks (applyForNative never writes
        // a target, but this pass also honors hand-set live attributes — so
        // the skip must live here too). Stray-assignment above still balances
        // team-assigned imports, by design.
        if (feedbackByConv.has(conv.id)) continue;
        const state = stateByConv.get(conv.id) ?? null;
        // Effective target: our ledger first (covers pins — pinned writes land
        // in lastWrittenTarget), live attribute as fallback for subjects the
        // bot never wrote (e.g. agent set the attribute by hand).
        const live = conv.customAttributes[attrName];
        const targetValue = state?.lastWrittenTarget || (typeof live === "string" ? live : "");
        if (!targetValue) continue;
        const target = targets.get(targetValue);
        if (!target || !hasClockDurations(target)) continue;

        const link = linkByConv.get(conv.id) ?? null;
        const kind: "bridged" | "native" = link ? "bridged" : "native";
        const schedule = scheduleFor(conv.teamAssigneeId);
        try {
          const outcome = await this.enforceOne(conv, kind, link, state, target, warnPct, schedule, statusAttrName, now, {
            budget,
            paced,
            result,
            nagRepeatMs,
            nagNoteText,
            teamNameFor,
            statusAttrBroken: () => statusAttrBroken,
            markStatusAttrBroken: () => {
              statusAttrBroken = true;
            },
          });
          if (outcome === "capped") break;
        } catch (e) {
          result.errors++;
          enforceLog.warn("sla.enforce.item_failed", {
            "intercom.conversation_id": conv.id,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    // ---- customer-idle pass (native conversations only) ----
    if (doInactivity && inactivityAuthorId) {
      const customerWaitMs = Math.max(1, this.settingsStore.inactivityCustomerWaitDays()) * DAY_MS;
      const nagsBeforeClose = Math.max(1, this.settingsStore.inactivityNagsBeforeClose());
      const nagText = this.settingsStore.inactivityNagText();
      for (const conv of items) {
        if (!budget()) break;
        if (!notSnoozed(conv)) continue;
        // Bridged tickets are the per-ticket workflow's job (Discord-side
        // customer reminders); their agent nag is the clock pass above.
        if (linkByConv.has(conv.id)) continue;
        try {
          await this.enforceCustomerIdle(conv, inactivityAuthorId, customerWaitMs, nagsBeforeClose, nagText, feedbackByConv, now, {
            budget,
            paced,
            result,
          });
        } catch (e) {
          result.errors++;
          enforceLog.warn("sla.enforce.customer_idle_failed", {
            "intercom.conversation_id": conv.id,
            "error.message": e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    exportSlaEnforce({
      scanned: result.scanned,
      statusWrites: result.statusWrites,
      breaches: result.notes,
      recoveries: result.untagged,
      assigned: result.assigned,
      customerNags: result.customerNags,
      closed: result.closed,
      errors: result.errors,
      capped: result.capped ? 1 : 0,
    });
    if (result.capped) enforceLog.warn("sla.enforce.write_cap_hit", { "sla.writes": writes });
    enforceLog.info("sla.enforce.completed", {
      "sla.scanned": result.scanned,
      "sla.assigned": result.assigned,
      "sla.status_writes": result.statusWrites,
      "sla.tagged": result.tagged,
      "sla.untagged": result.untagged,
      "sla.notes": result.notes,
      "sla.customer_nags": result.customerNags,
      "sla.closed": result.closed,
      "sla.verifies": result.verifies,
      "sla.errors": result.errors,
    });
    return result;
  }

  private markersOf(state: StateRow | null): ClockMarkers {
    return {
      frHumanReplyAt: state?.frHumanReplyAt ?? null,
      frVerifyNoneAt: state?.frVerifyNoneAt ?? null,
      frWarnedAt: state?.frWarnedAt ?? null,
      frBreachedAt: state?.frBreachedAt ?? null,
      frLastNaggedAt: state?.frLastNaggedAt ?? null,
      nrCycleAnchor: state?.nrCycleAnchor ?? null,
      nrWarnedAt: state?.nrWarnedAt ?? null,
      nrBreachedAt: state?.nrBreachedAt ?? null,
      nrLastNaggedAt: state?.nrLastNaggedAt ?? null,
      resWarnedAt: state?.resWarnedAt ?? null,
      resBreachedAt: state?.resBreachedAt ?? null,
    };
  }

  private async enforceOne(
    conv: IntercomSweepConversation,
    kind: "bridged" | "native",
    link: { ticketThreadId: string; ticketId: string | null; lastTagsJson: unknown } | null,
    state: StateRow | null,
    target: SlaTargetEntry,
    warnPct: number,
    schedule: ReturnType<SettingsStore["resolveOfficeHours"]>,
    statusAttrName: string,
    now: Date,
    ctx: {
      budget: () => boolean;
      paced: () => Promise<void>;
      result: SlaEnforceResult;
      nagRepeatMs: number;
      nagNoteText: string | null;
      teamNameFor: (teamId: string | null) => Promise<string>;
      statusAttrBroken: () => boolean;
      markStatusAttrBroken: () => void;
    }
  ): Promise<"done" | "capped"> {
    if (!conv.createdAt) return "done";
    const input: ClockInput = {
      kind,
      createdAt: conv.createdAt,
      waitingSince: conv.waitingSince,
      firstAdminReplyAt: conv.firstAdminReplyAt,
      lastAdminReplyAt: conv.lastAdminReplyAt,
      snoozed: false,
    };
    let markers = this.markersOf(state);
    let ev: ClockEvaluation = evaluateClocks(input, target, warnPct, schedule, markers, now, ctx.nagRepeatMs);
    const verifyMarkers: Partial<ClockMarkers> = {};

    // Native first-reply humanness verify: one bounded parts fetch, cached.
    if (ev.needsFirstReplyVerify) {
      if (!ctx.budget()) return "capped";
      ctx.result.verifies++;
      const human = await this.findHumanReply(conv.id);
      await ctx.paced();
      if (human) verifyMarkers.frHumanReplyAt = human;
      else verifyMarkers.frVerifyNoneAt = now;
      markers = { ...markers, ...verifyMarkers } as ClockMarkers;
      ev = evaluateClocks(input, target, warnPct, schedule, markers, now, ctx.nagRepeatMs);
    }

    const statusValue = ev.overall;
    const wantTag = statusValue === "breached";
    const tagged = state?.breachTagged ?? false;
    const persisted: Partial<StateRow> = { ...verifyMarkers, ...ev.actions.newMarkers } as Partial<StateRow>;
    let dirty = Object.keys(persisted).length > 0;

    // ---- status attribute (ok | at_risk | breached) ----
    if ((state?.lastStatusWritten ?? null) !== statusValue) {
      if (!ctx.budget()) {
        if (dirty) await this.persistState(conv.id, kind, link, persisted, now);
        return "capped";
      }
      if (!ctx.statusAttrBroken()) {
        try {
          await this.client.setConversationAttributes(conv.id, { [statusAttrName]: statusValue });
          (persisted as Record<string, unknown>).lastStatusWritten = statusValue;
          dirty = true;
          ctx.result.statusWrites++;
          await ctx.paced();
        } catch (e) {
          if (e instanceof IntercomHttpError && e.status >= 400 && e.status < 500 && e.status !== 429) {
            // Definition/options missing — degrade for the rest of the tick;
            // Verify Setup surfaces the fix.
            ctx.markStatusAttrBroken();
            enforceLog.warn("sla.enforce.status_attr_degraded", {
              "sla.attribute": statusAttrName,
              "error.message": e.message,
            });
          } else {
            throw e;
          }
        }
      }
    }

    // ---- breach tag (add on breach, remove on recovery) ----
    if (wantTag !== tagged) {
      if (!ctx.budget()) {
        if (dirty) await this.persistState(conv.id, kind, link, persisted, now);
        return "capped";
      }
      const tagName = this.settingsStore.slaBreachTagName();
      const tagId = await this.breachTagId(tagName);
      if (tagId) {
        // Pre-stamp the bridged tag-diff damper BEFORE the API call so the
        // tag-change webhook never narrates our own tag into the Discord
        // thread (alerts are Intercom-only by design).
        if (link) {
          const prev = Array.isArray(link.lastTagsJson) ? (link.lastTagsJson as string[]) : [];
          const next = wantTag ? [...new Set([...prev, tagName])] : prev.filter((t) => t !== tagName);
          await this.store.setLastTags(link.ticketThreadId, next).catch(() => undefined);
          link.lastTagsJson = next;
        }
        if (wantTag) {
          await this.withAuthor((a) => this.client.tagConversation(conv.id, tagId, a));
          ctx.result.tagged++;
        } else {
          await this.withAuthor((a) => this.client.untagConversation(conv.id, tagId, a));
          ctx.result.untagged++;
        }
        (persisted as Record<string, unknown>).breachTagged = wantTag;
        dirty = true;
        await ctx.paced();
      }
    }

    // ---- recurring agent nag: internal note per due breached clock (clocks.ts
    // re-emits first_reply/next_reply every nagRepeatMs of business time;
    // resolution appears once). The *LastNaggedAt markers in ev.actions.newMarkers
    // persist the cadence. ----
    for (const note of ev.actions.breachNotes) {
      if (!ctx.budget()) {
        if (dirty) await this.persistState(conv.id, kind, link, persisted, now);
        return "capped";
      }
      // Pre-write re-check: the world may have moved since the scan page.
      const liveNow = await this.client.getConversationSlaFacts(conv.id);
      if (!liveNow || !liveNow.open || (liveNow.snoozedUntil && liveNow.snoozedUntil.getTime() > Date.now())) break;
      if (note.clock === "first_reply" && kind === "bridged" && liveNow.firstAdminReplyAt != null) continue;
      if (note.clock === "next_reply" && liveNow.waitingSince == null) continue;
      const clockLabel = CLOCK_LABELS[note.clock];
      const targetMs = ev.clocks.find((c) => c.kind === note.clock)?.targetMs ?? 0;
      const body = await this.buildNagBody(note, clockLabel, target, targetMs, ctx.nagNoteText, conv.teamAssigneeId, ctx.teamNameFor);
      const { partId } = await this.withAuthor((a) => this.client.replyAsAdmin(conv.id, { adminId: a, body, note: true }));
      if (link && partId) {
        // Echo-register so the noted-webhook never relays the nag note
        // into the Discord thread (same pattern the kick notes used).
        await this.store.recordEchoPart("c", partId, link.ticketThreadId).catch(() => undefined);
      }
      ctx.result.notes++;
      dirty = true;
      await ctx.paced();
    }

    if (dirty) await this.persistState(conv.id, kind, link, { ...persisted, lastEnforcedAt: now } as Partial<StateRow>, now);
    return "done";
  }

  // Recurring-nag body: the built-in rich SLA-breach format, or the
  // slaNagNoteText override with {clock}/{target}/{overdue}/{team} placeholders.
  // {team} is resolved lazily — no /teams call unless the copy actually uses it.
  private async buildNagBody(
    note: { clock: ClockKind; deadline: Date | null },
    clockLabel: string,
    target: SlaTargetEntry,
    targetMs: number,
    override: string | null,
    teamId: string | null,
    teamNameFor: (teamId: string | null) => Promise<string>
  ): Promise<string> {
    const overdue = note.deadline ? `${note.deadline.toISOString().slice(0, 16).replace("T", " ")} UTC` : "unknown";
    if (override && override.trim()) {
      let text = override;
      if (text.includes("{team}")) text = text.split("{team}").join(await teamNameFor(teamId));
      return text.split("{clock}").join(clockLabel).split("{target}").join(target.value).split("{overdue}").join(overdue);
    }
    const due = note.deadline ? ` · was due ${overdue}` : "";
    return `⏱️ <b>SLA breached: ${clockLabel}</b> · target <b>${target.value}</b> (${formatDuration(targetMs)} business)${due} · <i>${AUTOMATION_MARKER}</i>`;
  }

  // Customer-idle nag + auto-close for ONE native conversation (the agent
  // replied last and the customer went silent). Verbatim port of the former
  // InactivitySweeper conversation loop's customer branch — its agent-idle
  // branch is retired (the SLA clock pass owns agent nags). Calendar-time; every
  // step idempotent via intercom_sweep_state; shares the tick's write budget.
  private async enforceCustomerIdle(
    conv: IntercomSweepConversation,
    adminId: string,
    customerWaitMs: number,
    nagsBeforeClose: number,
    nagText: string | null,
    feedbackByConv: Map<string, string | null>,
    now: Date,
    ctx: { budget: () => boolean; paced: () => Promise<void>; result: SlaEnforceResult }
  ): Promise<void> {
    const nowMs = now.getTime();
    let state = await this.store.getSweepState(conv.id);
    // Reopened after a sweeper auto-close (agent/customer reopened) → fresh
    // cycle. Mirror the reset locally too, or the nag math below still sees the
    // exhausted pre-close counter and re-closes the just-reopened conversation.
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
    // Agent-idle (customer waiting) belongs to the SLA clock pass now. Only the
    // customer-idle case (agent spoke last: lastCustomer <= lastAdmin) is handled
    // here; imported feedback is notes-only, never nagged/closed (a nag would
    // email the submitter).
    if (lastAdminMs <= 0 || lastCustomerMs > lastAdminMs || feedbackByConv.has(conv.id)) return;

    const customerRepliedSinceNag =
      state?.lastCustomerNagAt != null &&
      conv.lastContactReplyAt != null &&
      conv.lastContactReplyAt.getTime() > state.lastCustomerNagAt.getTime();
    const nagCount = customerRepliedSinceNag ? 0 : state?.customerNagCount ?? 0;
    const waitedSince = Math.max(lastAdminMs, customerRepliedSinceNag ? 0 : state?.lastCustomerNagAt?.getTime() ?? 0);

    if (nowMs - waitedSince >= customerWaitMs) {
      if (!ctx.budget()) return;
      if (nagCount >= nagsBeforeClose) {
        // The page snapshot can be minutes stale by now — never close on stale
        // data. Re-fetch: if gone, no longer open, or the customer replied
        // meanwhile, skip (and restart the nag cycle on a genuine reply). Any
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
          return;
        }
        await this.client.setConversationOpen(conv.id, false, adminId);
        await ctx.paced();
        const nativeTicketId = await this.client.getConversationTicketId(conv.id).catch(() => null);
        if (nativeTicketId && ctx.budget()) {
          // Second Intercom write of this close — pace and count it too, so a
          // close burst can't defeat the spacing or the sweep-wide write cap.
          await this.client.updateTicket(nativeTicketId, { open: false, adminId }).catch(() => {});
          await ctx.paced();
        }
        await this.store.upsertSweepState(conv.id, "conversation", { sweepClosedAt: new Date(nowMs) });
        ctx.result.closed++;
      } else {
        const nagDays = Math.floor((nowMs - waitedSince) / DAY_MS);
        await this.client.replyAsAdmin(conv.id, {
          adminId,
          note: false,
          body: nagText ? renderDays(nagText, nagDays) : DEFAULT_CUSTOMER_NAG,
        });
        await ctx.paced();
        await this.store.upsertSweepState(conv.id, "conversation", {
          customerNagCount: nagCount + 1,
          lastCustomerNagAt: new Date(nowMs),
          sweepClosedAt: null,
        });
        ctx.result.customerNags++;
      }
    } else if (customerRepliedSinceNag && state) {
      // Not due yet, but the reply must reset the counter so a later silence
      // starts a fresh nag cycle.
      await this.store.upsertSweepState(conv.id, "conversation", { customerNagCount: 0 });
    }
  }

  // Any comment authored by a non-Operator admin counts as a human reply
  // (Fin/Operator authors as the Operator admin or as type "bot").
  private async findHumanReply(conversationId: string): Promise<Date | null> {
    const operatorId = this.settingsStore.intercomOperatorAdminId();
    try {
      const parts = await this.client.getConversationPartsSince(conversationId, 0);
      for (const p of parts) {
        if (p.part_type !== "comment" || p.redacted) continue;
        const authorType = p.author?.type ?? "";
        const authorId = p.author?.id != null ? String(p.author.id) : "";
        if (authorType !== "admin") continue;
        if (operatorId && authorId === operatorId) continue;
        return p.created_at ? new Date(p.created_at * 1000) : new Date();
      }
      return null;
    } catch (e) {
      enforceLog.warn("sla.enforce.verify_failed", {
        "intercom.conversation_id": conversationId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  private async breachTagId(name: string): Promise<string | null> {
    if (this.tagIdCache?.name === name) return this.tagIdCache.id;
    try {
      const tag = await this.client.findOrCreateTag(name);
      this.tagIdCache = { name, id: tag.id };
      return tag.id;
    } catch (e) {
      enforceLog.warn("sla.enforce.tag_resolve_failed", {
        "sla.tag": name,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  private async persistState(
    conversationId: string,
    kind: "bridged" | "native",
    link: { ticketThreadId: string } | null,
    data: Partial<StateRow>,
    now: Date
  ): Promise<void> {
    const id = link ? `t:${link.ticketThreadId}` : `c:${conversationId}`;
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    await this.prisma.slaState.upsert({
      where: { id },
      create: { id, kind, conversationId, lastEnforcedAt: now, ...clean },
      update: { conversationId, ...clean },
    });
  }
}
