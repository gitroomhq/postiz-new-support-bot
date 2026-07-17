import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addBusinessMs,
  businessMsBetween,
  isOpenAt,
  isValidTimeZone,
  parseOfficeHours,
  scheduleHasOpenWindows,
  zonedTimeToUtc,
  type OfficeHoursSchedule,
} from "../businessTime";

const HOUR = 3_600_000;
const MIN = 60_000;

function schedule(overrides: Partial<OfficeHoursSchedule> = {}): OfficeHoursSchedule {
  return {
    tz: "Europe/Berlin",
    week: {
      mon: [{ start: "09:00", end: "17:00" }],
      tue: [{ start: "09:00", end: "17:00" }],
      wed: [{ start: "09:00", end: "17:00" }],
      thu: [{ start: "09:00", end: "17:00" }],
      fri: [{ start: "09:00", end: "17:00" }],
      sat: [],
      sun: [],
      ...(overrides.week ?? {}),
    },
    holidays: overrides.holidays ?? [],
    ...(overrides.tz ? { tz: overrides.tz } : {}),
  };
}

// Convenience: a UTC instant from Berlin wall time.
function berlin(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(zonedTimeToUtc(y, mo, d, h, mi, "Europe/Berlin"));
}

test("isValidTimeZone accepts IANA zones and rejects garbage", () => {
  assert.equal(isValidTimeZone("Europe/Berlin"), true);
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isValidTimeZone(""), false);
});

test("parseOfficeHours round-trips a valid schedule and rejects bad shapes", () => {
  const ok = parseOfficeHours(schedule());
  assert.ok(ok);
  assert.equal(ok.tz, "Europe/Berlin");
  assert.equal(parseOfficeHours({ tz: "Nope/Nope", week: schedule().week, holidays: [] }), null);
  assert.equal(parseOfficeHours({ tz: "UTC", week: { mon: [{ start: "9:00", end: "17:00" }] }, holidays: [] }), null); // bad HH:MM
  assert.equal(parseOfficeHours({ tz: "UTC", week: schedule().week, holidays: ["25.12.2026"] }), null);
  assert.equal(parseOfficeHours(null), null);
  // start === end is rejected (ambiguous zero/24h window)
  const eq = schedule();
  eq.week.mon = [{ start: "09:00", end: "09:00" }];
  assert.equal(parseOfficeHours(eq), null);
});

test("null schedule means wall clock everywhere", () => {
  const a = new Date("2026-07-10T00:00:00Z");
  const b = new Date("2026-07-13T00:00:00Z");
  assert.equal(businessMsBetween(null, a, b), 3 * 24 * HOUR);
  assert.equal(isOpenAt(null, a), true);
  assert.deepEqual(addBusinessMs(null, a, 5 * HOUR), new Date(a.getTime() + 5 * HOUR));
});

test("weekday window: elapsed business time within one day", () => {
  const s = schedule();
  // Friday 2026-07-10, 10:00 → 15:30 Berlin = 5.5h
  const from = berlin(2026, 7, 10, 10, 0);
  const to = berlin(2026, 7, 10, 15, 30);
  assert.equal(businessMsBetween(s, from, to), 5.5 * HOUR);
});

test("weekend is skipped entirely", () => {
  const s = schedule();
  // Friday 16:00 → Monday 10:00 = 1h Friday + 1h Monday
  const from = berlin(2026, 7, 10, 16, 0);
  const to = berlin(2026, 7, 13, 10, 0);
  assert.equal(businessMsBetween(s, from, to), 2 * HOUR);
  // A 4h-business first-reply target starting Friday 16:00 does not breach
  // Monday 00:01 — it breaches Monday 12:00.
  const deadline = addBusinessMs(s, from, 4 * HOUR);
  assert.ok(deadline);
  assert.equal(deadline.getTime(), berlin(2026, 7, 13, 12, 0).getTime());
});

test("outside-hours start anchors at next opening", () => {
  const s = schedule();
  // Saturday → zero elapsed until Monday 09:00
  const from = berlin(2026, 7, 11, 12, 0);
  assert.equal(businessMsBetween(s, from, berlin(2026, 7, 13, 9, 0)), 0);
  const deadline = addBusinessMs(s, from, 2 * HOUR);
  assert.ok(deadline);
  assert.equal(deadline.getTime(), berlin(2026, 7, 13, 11, 0).getTime());
});

test("holidays close the whole day", () => {
  const s = schedule({ holidays: ["2026-07-13"] }); // Monday
  const from = berlin(2026, 7, 10, 16, 0); // Friday 16:00
  const to = berlin(2026, 7, 14, 10, 0); // Tuesday 10:00
  // 1h Friday + 0 Monday (holiday) + 1h Tuesday
  assert.equal(businessMsBetween(s, from, to), 2 * HOUR);
  assert.equal(isOpenAt(s, berlin(2026, 7, 13, 10, 0)), false);
});

test("overnight window spans midnight and previous-day spillover counts", () => {
  const s = schedule({
    week: {
      mon: [{ start: "22:00", end: "06:00" }],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    },
  });
  // Monday 23:00 → Tuesday 05:00 = 6h, all inside the Monday-starting window
  assert.equal(businessMsBetween(s, berlin(2026, 7, 13, 23, 0), berlin(2026, 7, 14, 5, 0)), 6 * HOUR);
  // Tuesday 02:00 is open (Monday's window spills over)
  assert.equal(isOpenAt(s, berlin(2026, 7, 14, 2, 0)), true);
  assert.equal(isOpenAt(s, berlin(2026, 7, 14, 7, 0)), false);
});

test("multiple + overlapping windows in one day are merged", () => {
  const s = schedule({
    week: {
      mon: [
        { start: "09:00", end: "12:00" },
        { start: "11:00", end: "14:00" }, // overlaps the first
        { start: "15:00", end: "16:00" },
      ],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    },
  });
  // 09:00-14:00 merged (5h) + 15:00-16:00 (1h)
  assert.equal(businessMsBetween(s, berlin(2026, 7, 13, 8, 0), berlin(2026, 7, 13, 18, 0)), 6 * HOUR);
});

test("DST spring forward (Europe/Berlin 2026-03-29): the lost hour is not counted", () => {
  const s = schedule({
    week: {
      sun: [{ start: "00:00", end: "23:59" }],
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
    },
  });
  // Berlin springs 02:00→03:00 on Sun 2026-03-29. Wall 00:00→06:00 is only 5 real hours.
  const from = berlin(2026, 3, 29, 0, 0);
  const to = berlin(2026, 3, 29, 6, 0);
  assert.equal(to.getTime() - from.getTime(), 5 * HOUR);
  assert.equal(businessMsBetween(s, from, to), 5 * HOUR);
});

test("DST spring forward gap times resolve post-gap", () => {
  // 02:30 doesn't exist in Berlin on 2026-03-29 → resolves to the post-gap instant
  const gap = zonedTimeToUtc(2026, 3, 29, 2, 30, "Europe/Berlin");
  const before = zonedTimeToUtc(2026, 3, 29, 1, 59, "Europe/Berlin");
  const after = zonedTimeToUtc(2026, 3, 29, 3, 0, "Europe/Berlin");
  assert.ok(gap > before);
  assert.ok(gap <= after + HOUR); // lands at/near the post-gap boundary, never before the gap
});

test("DST fall back (America/New_York 2026-11-01): the repeated hour is counted once per real hour", () => {
  const s: OfficeHoursSchedule = {
    tz: "America/New_York",
    week: {
      sun: [{ start: "00:00", end: "23:59" }],
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
    },
    holidays: [],
  };
  // NY falls back 02:00→01:00 on Sun 2026-11-01: wall 00:00→06:00 spans 7 real hours.
  const from = new Date(zonedTimeToUtc(2026, 11, 1, 0, 0, "America/New_York"));
  const to = new Date(zonedTimeToUtc(2026, 11, 1, 6, 0, "America/New_York"));
  assert.equal(to.getTime() - from.getTime(), 7 * HOUR);
  assert.equal(businessMsBetween(s, from, to), 7 * HOUR);
});

test("businessMsBetween is additive over a midpoint", () => {
  const s = schedule();
  const a = berlin(2026, 7, 9, 12, 0); // Thu noon
  const b = berlin(2026, 7, 11, 3, 0); // Sat 03:00
  const c = berlin(2026, 7, 14, 11, 17); // Tue 11:17
  assert.equal(businessMsBetween(s, a, b) + businessMsBetween(s, b, c), businessMsBetween(s, a, c));
});

test("degenerate ranges and schedules degrade safely", () => {
  const s = schedule();
  const at = berlin(2026, 7, 13, 10, 0);
  assert.equal(businessMsBetween(s, at, at), 0);
  assert.equal(businessMsBetween(s, at, new Date(at.getTime() - HOUR)), 0);
  // Zero open windows anywhere → wall clock fallback (a bad config can never freeze clocks)
  const closed = schedule({ week: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } });
  assert.equal(scheduleHasOpenWindows(closed), false);
  assert.equal(businessMsBetween(closed, at, new Date(at.getTime() + 3 * HOUR)), 3 * HOUR);
  assert.deepEqual(addBusinessMs(closed, at, 90 * MIN), new Date(at.getTime() + 90 * MIN));
});

test("addBusinessMs consumes across days and returns exact deadline", () => {
  const s = schedule();
  // Thu 15:00 + 6h business = Thu 15-17 (2h) + Fri 9-13 (4h) → Fri 13:00
  const deadline = addBusinessMs(s, berlin(2026, 7, 9, 15, 0), 6 * HOUR);
  assert.ok(deadline);
  assert.equal(deadline.getTime(), berlin(2026, 7, 10, 13, 0).getTime());
});
