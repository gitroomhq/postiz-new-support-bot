import { addBusinessMs, businessMsBetween, type OfficeHoursSchedule } from "./businessTime";
import type { SlaTargetEntry } from "./types";

// Pure clock-state derivation for the bot-native SLA engine. Zero I/O: the
// enforcer feeds one conversation snapshot + the persisted markers and gets
// back the per-clock states plus the transition actions (markers to stamp,
// breach notes to post) for THIS tick. All elapsed time is business time
// (schedule null = wall clock).
//
// Clock semantics:
// - first_reply (FR): createdAt → first REAL human teammate reply. Bridged
//   conversations trust statistics.first_admin_reply_at (bridge-mirrored admin
//   comments are staff replies; the bridge itself only authors notes and
//   contact-side messages). Native conversations must parts-verify humanness
//   (Fin/Operator counts as an admin in Intercom statistics): while a raw
//   admin reply exists but is unverified, the clock emits needsFirstReplyVerify
//   and suppresses alerts for the tick instead of crying wolf.
// - next_reply (NRT): runs while the customer is waiting (waiting_since set).
//   FR owns the FIRST wait when an FR clock exists; each new waiting_since
//   value starts a fresh cycle with fresh warn/breach markers (re-alert per
//   cycle). The stored anchor can be moved forward (unsnooze re-anchor) — the
//   later of waiting_since/stored anchor wins.
// - resolution (RES): createdAt → close. The enforcer only scans open
//   conversations, so a closed subject simply leaves the population (status
//   attribute + tag intentionally keep their last value as history).
//
// at_risk fires at warnPct% of the target, breached at 100%. at_risk is
// transition-edged (one warn per clock per cycle). Breach of the first_reply /
// next_reply clocks RE-NAGS: the breach note is re-emitted every nagRepeatMs of
// business time while the clock stays breached (the *LastNaggedAt markers pace
// it). The resolution clock keeps a single one-shot breach note. Snoozed
// conversations are inert.

export type ClockKind = "first_reply" | "next_reply" | "resolution";
export type ClockState = "ok" | "at_risk" | "breached";

export interface ClockInput {
  kind: "bridged" | "native";
  createdAt: Date;
  waitingSince: Date | null;
  firstAdminReplyAt: Date | null; // raw statistics (may be Fin/Operator on native)
  lastAdminReplyAt: Date | null; // raw statistics — drives native re-verify
  snoozed: boolean;
}

export interface ClockMarkers {
  frHumanReplyAt: Date | null; // parts-verified human reply (native cache)
  frVerifyNoneAt: Date | null; // last parts-verify that found none
  frWarnedAt: Date | null;
  frBreachedAt: Date | null;
  frLastNaggedAt: Date | null; // last recurring agent nag for a breached first-reply clock
  nrCycleAnchor: Date | null;
  nrWarnedAt: Date | null;
  nrBreachedAt: Date | null;
  nrLastNaggedAt: Date | null; // last recurring agent nag for a breached next-reply clock (reset with the cycle)
  resWarnedAt: Date | null;
  resBreachedAt: Date | null;
}

export interface ClockStatus {
  kind: ClockKind;
  state: ClockState;
  elapsedBizMs: number;
  targetMs: number;
  deadline: Date | null; // business-time deadline (display/note copy)
  anchor: Date;
}

export interface ClockEvaluation {
  // Worst state across ACTIVE clocks (satisfied/disabled clocks are ok).
  overall: ClockState;
  clocks: ClockStatus[];
  // Native only: a raw admin reply exists but humanness is unverified while a
  // threshold is crossed — the enforcer must parts-verify before any FR alert.
  needsFirstReplyVerify: boolean;
  actions: {
    newMarkers: Partial<ClockMarkers>;
    breachNotes: Array<{ clock: ClockKind; deadline: Date | null }>;
  };
}

const MIN_MS = 60_000;

function stateFor(elapsed: number, targetMs: number, warnMs: number): ClockState {
  if (elapsed >= targetMs) return "breached";
  if (elapsed >= warnMs) return "at_risk";
  return "ok";
}

function worst(states: ClockState[]): ClockState {
  if (states.includes("breached")) return "breached";
  if (states.includes("at_risk")) return "at_risk";
  return "ok";
}

export function evaluateClocks(
  input: ClockInput,
  target: SlaTargetEntry,
  globalWarnPct: number,
  schedule: OfficeHoursSchedule | null,
  markers: ClockMarkers,
  now: Date,
  nagRepeatMs: number,
): ClockEvaluation {
  const empty: ClockEvaluation = {
    overall: "ok",
    clocks: [],
    needsFirstReplyVerify: false,
    actions: { newMarkers: {}, breachNotes: [] },
  };
  if (input.snoozed) return empty;

  const warnPct = target.warnPct ?? globalWarnPct;
  const clocks: ClockStatus[] = [];
  const newMarkers: Partial<ClockMarkers> = {};
  const breachNotes: Array<{ clock: ClockKind; deadline: Date | null }> = [];
  let needsFirstReplyVerify = false;
  const states: ClockState[] = [];
  // Recurring nag is due when we never nagged this breach cycle, or a full
  // nagRepeatMs of BUSINESS time has elapsed since the last nag.
  const nagDue = (lastNaggedAt: Date | null): boolean =>
    lastNaggedAt == null || businessMsBetween(schedule, lastNaggedAt, now) >= nagRepeatMs;

  // ---- first reply ----
  const frTargetMs = (target.firstReplyMins ?? 0) * MIN_MS;
  let frSatisfied = true;
  if (frTargetMs > 0) {
    frSatisfied =
      input.kind === "bridged" ? input.firstAdminReplyAt != null : markers.frHumanReplyAt != null;
    if (!frSatisfied) {
      const elapsed = businessMsBetween(schedule, input.createdAt, now);
      const warnMs = (frTargetMs * warnPct) / 100;
      const state = stateFor(elapsed, frTargetMs, warnMs);
      const deadline = addBusinessMs(schedule, input.createdAt, frTargetMs);
      // Native humanness gate: someone replied, but was it a human?
      let suppressed = false;
      if (state !== "ok" && input.kind === "native" && input.firstAdminReplyAt != null) {
        const recheckDue =
          markers.frVerifyNoneAt == null ||
          (input.lastAdminReplyAt != null && input.lastAdminReplyAt > markers.frVerifyNoneAt);
        if (recheckDue) {
          needsFirstReplyVerify = true;
          suppressed = true; // don't alert on possibly-Fin replies; verify first
        }
      }
      if (!suppressed) {
        clocks.push({ kind: "first_reply", state, elapsedBizMs: elapsed, targetMs: frTargetMs, deadline, anchor: input.createdAt });
        states.push(state);
        if (state !== "ok" && markers.frWarnedAt == null) newMarkers.frWarnedAt = now;
        if (state === "breached") {
          if (markers.frBreachedAt == null) newMarkers.frBreachedAt = now;
          if (nagDue(markers.frLastNaggedAt)) {
            newMarkers.frLastNaggedAt = now;
            breachNotes.push({ clock: "first_reply", deadline });
          }
        }
      } else {
        clocks.push({ kind: "first_reply", state: "ok", elapsedBizMs: elapsed, targetMs: frTargetMs, deadline, anchor: input.createdAt });
        states.push("ok");
      }
    }
  }

  // ---- next reply ----
  const nrTargetMs = (target.nextReplyMins ?? 0) * MIN_MS;
  if (nrTargetMs > 0) {
    // FR owns the first wait when an FR clock exists and is still unsatisfied.
    const active = input.waitingSince != null && (frTargetMs === 0 || frSatisfied);
    if (!active) {
      if (input.waitingSince == null && markers.nrCycleAnchor != null) {
        // Cycle over (teammate replied): clear the cycle so the next wait re-alerts.
        newMarkers.nrCycleAnchor = null;
        newMarkers.nrWarnedAt = null;
        newMarkers.nrBreachedAt = null;
        newMarkers.nrLastNaggedAt = null;
      }
    } else {
      const waiting = input.waitingSince as Date;
      // Later of waiting_since / stored anchor wins (unsnooze re-anchor moves
      // the stored anchor forward past the original waiting_since).
      const stored = markers.nrCycleAnchor;
      const isNewCycle = stored == null || waiting.getTime() > stored.getTime();
      const anchor = isNewCycle ? waiting : (stored as Date);
      const warned = isNewCycle ? null : markers.nrWarnedAt;
      const breached = isNewCycle ? null : markers.nrBreachedAt;
      const lastNagged = isNewCycle ? null : markers.nrLastNaggedAt;
      if (isNewCycle) {
        newMarkers.nrCycleAnchor = waiting;
        newMarkers.nrWarnedAt = null;
        newMarkers.nrBreachedAt = null;
        newMarkers.nrLastNaggedAt = null;
      }
      const elapsed = businessMsBetween(schedule, anchor, now);
      const warnMs = (nrTargetMs * warnPct) / 100;
      const state = stateFor(elapsed, nrTargetMs, warnMs);
      const deadline = addBusinessMs(schedule, anchor, nrTargetMs);
      clocks.push({ kind: "next_reply", state, elapsedBizMs: elapsed, targetMs: nrTargetMs, deadline, anchor });
      states.push(state);
      if (state !== "ok" && warned == null) newMarkers.nrWarnedAt = now;
      if (state === "breached") {
        if (breached == null) newMarkers.nrBreachedAt = now;
        if (nagDue(lastNagged)) {
          newMarkers.nrLastNaggedAt = now;
          breachNotes.push({ clock: "next_reply", deadline });
        }
      }
    }
  }

  // ---- resolution ----
  const resTargetMs = (target.resolveMins ?? 0) * MIN_MS;
  if (resTargetMs > 0) {
    const elapsed = businessMsBetween(schedule, input.createdAt, now);
    const warnMs = (resTargetMs * warnPct) / 100;
    const state = stateFor(elapsed, resTargetMs, warnMs);
    const deadline = addBusinessMs(schedule, input.createdAt, resTargetMs);
    clocks.push({ kind: "resolution", state, elapsedBizMs: elapsed, targetMs: resTargetMs, deadline, anchor: input.createdAt });
    states.push(state);
    if (state !== "ok" && markers.resWarnedAt == null) newMarkers.resWarnedAt = now;
    if (state === "breached" && markers.resBreachedAt == null) {
      newMarkers.resBreachedAt = now;
      breachNotes.push({ clock: "resolution", deadline });
    }
  }

  return { overall: worst(states), clocks, needsFirstReplyVerify, actions: { newMarkers, breachNotes } };
}

export const CLOCK_LABELS: Record<ClockKind, string> = {
  first_reply: "first reply",
  next_reply: "next reply",
  resolution: "resolution",
};
