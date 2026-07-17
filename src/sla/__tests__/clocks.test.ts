import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateClocks, type ClockInput, type ClockMarkers } from "../clocks";
import type { SlaTargetEntry } from "../types";
import { zonedTimeToUtc, type OfficeHoursSchedule } from "../businessTime";

const MIN = 60_000;
const HOUR = 60 * MIN;

const T0 = new Date("2026-07-13T09:00:00Z"); // Monday

function input(overrides: Partial<ClockInput> = {}): ClockInput {
  return {
    kind: "bridged",
    createdAt: T0,
    waitingSince: null,
    firstAdminReplyAt: null,
    lastAdminReplyAt: null,
    snoozed: false,
    ...overrides,
  };
}

function markers(overrides: Partial<ClockMarkers> = {}): ClockMarkers {
  return {
    frHumanReplyAt: null,
    frVerifyNoneAt: null,
    frWarnedAt: null,
    frBreachedAt: null,
    nrCycleAnchor: null,
    nrWarnedAt: null,
    nrBreachedAt: null,
    resWarnedAt: null,
    resBreachedAt: null,
    ...overrides,
  };
}

function target(overrides: Partial<SlaTargetEntry> = {}): SlaTargetEntry {
  return { value: "vip", note: "", firstReplyMins: 60, ...overrides };
}

function at(msAfterT0: number): Date {
  return new Date(T0.getTime() + msAfterT0);
}

function clock(ev: ReturnType<typeof evaluateClocks>, kind: string) {
  return ev.clocks.find((c) => c.kind === kind);
}

test("FR progresses ok → at_risk → breached with exact warnPct boundary", () => {
  const t = target({ firstReplyMins: 60 });
  const ok = evaluateClocks(input(), t, 80, null, markers(), at(47 * MIN));
  assert.equal(ok.overall, "ok");
  assert.deepEqual(ok.actions.newMarkers, {});
  assert.equal(ok.actions.breachNotes.length, 0);

  const warn = evaluateClocks(input(), t, 80, null, markers(), at(48 * MIN)); // exactly 80%
  assert.equal(warn.overall, "at_risk");
  assert.ok(warn.actions.newMarkers.frWarnedAt);
  assert.equal(warn.actions.breachNotes.length, 0);

  const breach = evaluateClocks(input(), t, 80, null, markers({ frWarnedAt: at(48 * MIN) }), at(60 * MIN));
  assert.equal(breach.overall, "breached");
  assert.ok(breach.actions.newMarkers.frBreachedAt);
  assert.deepEqual(breach.actions.breachNotes.map((n) => n.clock), ["first_reply"]);
});

test("FR breach note is emitted exactly once (marker dedup)", () => {
  const t = target();
  const again = evaluateClocks(
    input(),
    t,
    80,
    null,
    markers({ frWarnedAt: at(48 * MIN), frBreachedAt: at(60 * MIN) }),
    at(90 * MIN),
  );
  assert.equal(again.overall, "breached");
  assert.equal(again.actions.breachNotes.length, 0);
  assert.equal(again.actions.newMarkers.frBreachedAt, undefined);
});

test("bridged FR satisfied by raw stats; recovery after breach stops alerting", () => {
  const t = target();
  const ev = evaluateClocks(
    input({ firstAdminReplyAt: at(70 * MIN) }),
    t,
    80,
    null,
    markers({ frWarnedAt: at(48 * MIN), frBreachedAt: at(60 * MIN) }),
    at(120 * MIN),
  );
  // Satisfied → FR contributes nothing (overall ok, no actions)
  assert.equal(ev.overall, "ok");
  assert.equal(ev.clocks.length, 0);
  assert.equal(ev.actions.breachNotes.length, 0);
});

test("native FR with unverified admin reply emits needsFirstReplyVerify and suppresses alerts", () => {
  const t = target();
  const ev = evaluateClocks(
    input({ kind: "native", firstAdminReplyAt: at(5 * MIN), lastAdminReplyAt: at(5 * MIN) }),
    t,
    80,
    null,
    markers(),
    at(90 * MIN),
  );
  assert.equal(ev.needsFirstReplyVerify, true);
  assert.equal(ev.overall, "ok"); // suppressed until verified
  assert.equal(ev.actions.breachNotes.length, 0);
  assert.equal(ev.actions.newMarkers.frWarnedAt, undefined);
});

test("native FR verified human reply satisfies; verified-none alerts without re-verify", () => {
  const t = target();
  const satisfied = evaluateClocks(
    input({ kind: "native", firstAdminReplyAt: at(5 * MIN), lastAdminReplyAt: at(5 * MIN) }),
    t,
    80,
    null,
    markers({ frHumanReplyAt: at(5 * MIN) }),
    at(90 * MIN),
  );
  assert.equal(satisfied.overall, "ok");
  assert.equal(satisfied.needsFirstReplyVerify, false);

  // Verified none (Fin-only) and no newer reply → alert proceeds
  const verifiedNone = evaluateClocks(
    input({ kind: "native", firstAdminReplyAt: at(5 * MIN), lastAdminReplyAt: at(5 * MIN) }),
    t,
    80,
    null,
    markers({ frVerifyNoneAt: at(10 * MIN) }),
    at(90 * MIN),
  );
  assert.equal(verifiedNone.needsFirstReplyVerify, false);
  assert.equal(verifiedNone.overall, "breached");
  assert.deepEqual(verifiedNone.actions.breachNotes.map((n) => n.clock), ["first_reply"]);

  // A NEWER admin reply than the last verify → re-verify instead of alerting
  const reverify = evaluateClocks(
    input({ kind: "native", firstAdminReplyAt: at(5 * MIN), lastAdminReplyAt: at(70 * MIN) }),
    t,
    80,
    null,
    markers({ frVerifyNoneAt: at(10 * MIN) }),
    at(90 * MIN),
  );
  assert.equal(reverify.needsFirstReplyVerify, true);
  assert.equal(reverify.overall, "ok");
});

test("native FR with NO admin reply at all alerts directly (nothing to verify)", () => {
  const t = target();
  const ev = evaluateClocks(input({ kind: "native" }), t, 80, null, markers(), at(90 * MIN));
  assert.equal(ev.needsFirstReplyVerify, false);
  assert.equal(ev.overall, "breached");
});

test("NRT is idle until FR satisfied when an FR clock exists", () => {
  const t = target({ firstReplyMins: 60, nextReplyMins: 30 });
  const ev = evaluateClocks(input({ waitingSince: T0 }), t, 80, null, markers(), at(50 * MIN));
  assert.equal(clock(ev, "next_reply"), undefined); // FR owns the first wait
  assert.ok(clock(ev, "first_reply"));

  // Without an FR clock on the target, NRT runs from waiting_since immediately
  const nrOnly = target({ firstReplyMins: undefined, nextReplyMins: 30 });
  const ev2 = evaluateClocks(input({ waitingSince: T0 }), nrOnly, 80, null, markers(), at(50 * MIN));
  const nr = clock(ev2, "next_reply");
  assert.ok(nr);
  assert.equal(nr.state, "breached");
});

test("NRT cycles: new waiting_since resets markers and re-alerts; recovery clears the cycle", () => {
  const t = target({ firstReplyMins: undefined, nextReplyMins: 30 });
  // Cycle 1 breached and noted
  const cycle1 = evaluateClocks(input({ waitingSince: T0 }), t, 80, null, markers(), at(40 * MIN));
  assert.deepEqual(cycle1.actions.breachNotes.map((n) => n.clock), ["next_reply"]);
  assert.equal(cycle1.actions.newMarkers.nrCycleAnchor?.getTime(), T0.getTime());

  // Same cycle later → no re-note
  const same = evaluateClocks(
    input({ waitingSince: T0 }),
    t,
    80,
    null,
    markers({ nrCycleAnchor: T0, nrWarnedAt: at(24 * MIN), nrBreachedAt: at(30 * MIN) }),
    at(50 * MIN),
  );
  assert.equal(same.actions.breachNotes.length, 0);

  // Teammate replied → waiting_since clears → cycle cleared
  const recovered = evaluateClocks(
    input({ waitingSince: null }),
    t,
    80,
    null,
    markers({ nrCycleAnchor: T0, nrWarnedAt: at(24 * MIN), nrBreachedAt: at(30 * MIN) }),
    at(60 * MIN),
  );
  assert.equal(recovered.overall, "ok");
  assert.equal(recovered.actions.newMarkers.nrCycleAnchor, null);
  assert.equal(recovered.actions.newMarkers.nrWarnedAt, null);
  assert.equal(recovered.actions.newMarkers.nrBreachedAt, null);

  // Customer writes again → NEW cycle (fresh anchor, re-alert at threshold)
  const waiting2 = at(2 * HOUR);
  const cycle2 = evaluateClocks(
    input({ waitingSince: waiting2 }),
    t,
    80,
    null,
    markers(),
    new Date(waiting2.getTime() + 31 * MIN),
  );
  assert.deepEqual(cycle2.actions.breachNotes.map((n) => n.clock), ["next_reply"]);
  assert.equal(cycle2.actions.newMarkers.nrCycleAnchor?.getTime(), waiting2.getTime());
});

test("NRT unsnooze re-anchor: stored anchor later than waiting_since wins", () => {
  const t = target({ firstReplyMins: undefined, nextReplyMins: 30 });
  const reanchoredTo = at(3 * HOUR); // unsnooze handler moved the anchor forward
  const ev = evaluateClocks(
    input({ waitingSince: T0 }),
    t,
    80,
    null,
    markers({ nrCycleAnchor: reanchoredTo }),
    new Date(reanchoredTo.getTime() + 10 * MIN),
  );
  const nr = clock(ev, "next_reply");
  assert.ok(nr);
  assert.equal(nr.anchor.getTime(), reanchoredTo.getTime());
  assert.equal(nr.state, "ok"); // only 10 min into the re-anchored cycle
});

test("resolution clock runs from createdAt and notes once", () => {
  const t = target({ firstReplyMins: undefined, resolveMins: 120 });
  const ev = evaluateClocks(input(), t, 80, null, markers(), at(121 * MIN));
  const res = clock(ev, "resolution");
  assert.ok(res);
  assert.equal(res.state, "breached");
  assert.deepEqual(ev.actions.breachNotes.map((n) => n.clock), ["resolution"]);
});

test("snoozed conversations are inert", () => {
  const t = target({ firstReplyMins: 60, nextReplyMins: 30, resolveMins: 120 });
  const ev = evaluateClocks(input({ snoozed: true, waitingSince: T0 }), t, 80, null, markers(), at(10 * HOUR));
  assert.equal(ev.overall, "ok");
  assert.equal(ev.clocks.length, 0);
  assert.deepEqual(ev.actions.newMarkers, {});
  assert.equal(ev.actions.breachNotes.length, 0);
});

test("office-hours schedule pauses elapsed time", () => {
  // Mon-Fri 09:00-17:00 UTC; conversation created Friday 16:00 UTC
  const s: OfficeHoursSchedule = {
    tz: "UTC",
    week: {
      mon: [{ start: "09:00", end: "17:00" }],
      tue: [{ start: "09:00", end: "17:00" }],
      wed: [{ start: "09:00", end: "17:00" }],
      thu: [{ start: "09:00", end: "17:00" }],
      fri: [{ start: "09:00", end: "17:00" }],
      sat: [],
      sun: [],
    },
    holidays: [],
  };
  const friday16 = new Date(zonedTimeToUtc(2026, 7, 10, 16, 0, "UTC"));
  const monday0930 = new Date(zonedTimeToUtc(2026, 7, 13, 9, 30, "UTC"));
  const t = target({ firstReplyMins: 240 }); // 4h business
  const ev = evaluateClocks(input({ createdAt: friday16 }), t, 80, s, markers(), monday0930);
  const fr = clock(ev, "first_reply");
  assert.ok(fr);
  // 1h Friday + 0.5h Monday = 1.5h elapsed — far from the 4h target
  assert.equal(fr.elapsedBizMs, 1.5 * HOUR);
  assert.equal(fr.state, "ok");
  // Deadline = Monday 12:00 (3h remaining after Friday's 1h)
  assert.equal(fr.deadline?.getTime(), zonedTimeToUtc(2026, 7, 13, 12, 0, "UTC"));
});

test("overall is worst-of and per-target warnPct override applies", () => {
  const t = target({ firstReplyMins: 60, resolveMins: 600, warnPct: 50 });
  const ev = evaluateClocks(input(), t, 80, null, markers(), at(31 * MIN));
  // FR at 31/60 min with warnPct 50 → at_risk; RES at 31/600 → ok
  assert.equal(clock(ev, "first_reply")?.state, "at_risk");
  assert.equal(clock(ev, "resolution")?.state, "ok");
  assert.equal(ev.overall, "at_risk");
});
