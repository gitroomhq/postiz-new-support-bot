import { z } from "zod";

// Business-time math for the bot-native SLA engine (office hours pause the
// clocks — Intercom Advanced lost native team office hours). Dependency-free:
// all timezone work goes through cached Intl.DateTimeFormat instances.
//
// Semantics:
// - A window belongs to the local calendar day it STARTS on. `end <= start`
//   crosses midnight into the next day ("22:00-06:00"). Holidays close the
//   whole day: windows STARTING on a holiday don't count (including their
//   after-midnight spillover); a previous open day's spillover INTO a holiday
//   still counts.
// - DST: local wall times convert via the standard two-pass offset correction.
//   Times inside a spring-forward gap resolve to the post-gap instant, so a
//   deadline landing in the gap shifts forward by up to one hour.
// - A `null` schedule everywhere means "wall clock" — callers pass null when
//   office hours are disabled or misconfigured, so a bad config can slow
//   alerts but never freeze the clocks.

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface OfficeWindow {
  start: string; // "HH:MM" 24h
  end: string; // "HH:MM"; end <= start crosses midnight
}

export interface OfficeHoursSchedule {
  tz: string; // IANA, e.g. "Europe/Berlin"
  week: Record<Weekday, OfficeWindow[]>; // [] = closed that day
  holidays: string[]; // "YYYY-MM-DD" in schedule tz, full-day closed
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const zWindow = z
  .object({ start: z.string().regex(TIME_RE), end: z.string().regex(TIME_RE) })
  .refine((w) => w.start !== w.end, { message: "window start and end must differ" });

export const officeHoursSchema = z.object({
  tz: z.string().min(1),
  week: z.object({
    mon: z.array(zWindow).default([]),
    tue: z.array(zWindow).default([]),
    wed: z.array(zWindow).default([]),
    thu: z.array(zWindow).default([]),
    fri: z.array(zWindow).default([]),
    sat: z.array(zWindow).default([]),
    sun: z.array(zWindow).default([]),
  }),
  holidays: z.array(z.string().regex(DATE_RE)).default([]),
});

export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Lenient parse for storage-sourced JSON: returns null (never throws) on any
// structural or timezone problem.
export function parseOfficeHours(raw: unknown): OfficeHoursSchedule | null {
  const parsed = officeHoursSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (!isValidTimeZone(parsed.data.tz)) return null;
  return parsed.data;
}

export function scheduleHasOpenWindows(schedule: OfficeHoursSchedule): boolean {
  return WEEKDAYS.some((d) => schedule.week[d].length > 0);
}

// ---- timezone primitives --------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, fmt);
  }
  return fmt;
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(tsMs: number, tz: string): LocalParts {
  const parts = formatterFor(tz).formatToParts(new Date(tsMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  // hourCycle h23 still reports 24 for midnight in some ICU versions.
  const hour = get("hour") === 24 ? 0 : get("hour");
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute"), second: get("second") };
}

// The schedule-tz wall-clock time of `tsMs`, re-encoded as a UTC ms value
// (whole-second precision; offsets are whole minutes so this is exact).
function wallMs(tsMs: number, tz: string): number {
  const p = localParts(tsMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

// Convert a schedule-tz wall time to a UTC instant (two-pass offset
// correction; spring-forward gap times resolve to the post-gap instant).
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const offset1 = wallMs(desired, tz) - desired;
  const first = desired - offset1;
  const offset2 = wallMs(first, tz) - first;
  return offset2 === offset1 ? first : desired - offset2;
}

interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function localDateOf(tsMs: number, tz: string): LocalDate {
  const p = localParts(tsMs, tz);
  return { year: p.year, month: p.month, day: p.day };
}

// Date.UTC normalizes overflow (month/day), so day+1 is safe everywhere.
function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function dateKey(d: LocalDate): string {
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

// Calendar weekday of a local date is timezone-independent once we have the
// date itself.
function weekdayOf(d: LocalDate): Weekday {
  const idx = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay(); // 0=Sun
  return (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const)[idx];
}

interface Interval {
  start: number; // UTC ms inclusive
  end: number; // UTC ms exclusive
}

function parseHHMM(s: string): { h: number; m: number } {
  return { h: Number(s.slice(0, 2)), m: Number(s.slice(3, 5)) };
}

// Absolute open intervals for windows STARTING on local day `d` (merged,
// sorted). Holiday days contribute nothing.
function openIntervalsForDay(schedule: OfficeHoursSchedule, d: LocalDate, holidaySet: Set<string>): Interval[] {
  if (holidaySet.has(dateKey(d))) return [];
  const windows = schedule.week[weekdayOf(d)];
  if (windows.length === 0) return [];
  const next = addDays(d, 1);
  const raw: Interval[] = [];
  for (const w of windows) {
    const s = parseHHMM(w.start);
    const e = parseHHMM(w.end);
    const startTs = zonedTimeToUtc(d.year, d.month, d.day, s.h, s.m, schedule.tz);
    const crossesMidnight = w.end <= w.start; // schema guarantees start !== end
    const endTs = crossesMidnight
      ? zonedTimeToUtc(next.year, next.month, next.day, e.h, e.m, schedule.tz)
      : zonedTimeToUtc(d.year, d.month, d.day, e.h, e.m, schedule.tz);
    if (endTs > startTs) raw.push({ start: startTs, end: endTs });
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

// Iteration guard: business math scans one local day per step. 4000 days
// (~11 years) is far beyond any live conversation; past it we degrade to
// wall-clock rather than loop (undercount is harmless — such subjects are
// long past every threshold and alerts dedup via markers anyway).
const MAX_DAY_ITERATIONS = 4000;
// Deadline walk cap: a target that takes >400 calendar days of walking to
// satisfy is a pathological schedule; we return null (callers omit the
// deadline from display copy).
const MAX_DEADLINE_DAYS = 400;

export function isOpenAt(schedule: OfficeHoursSchedule | null, at: Date): boolean {
  if (!schedule) return true;
  const holidaySet = new Set(schedule.holidays);
  const ts = at.getTime();
  const today = localDateOf(ts, schedule.tz);
  // Previous day's windows can spill past midnight into `today`.
  for (const d of [addDays(today, -1), today]) {
    for (const iv of openIntervalsForDay(schedule, d, holidaySet)) {
      if (ts >= iv.start && ts < iv.end) return true;
    }
  }
  return false;
}

// Business milliseconds elapsed between two instants. null schedule = wall
// clock. Negative ranges return 0.
export function businessMsBetween(schedule: OfficeHoursSchedule | null, start: Date, end: Date): number {
  const startTs = start.getTime();
  const endTs = end.getTime();
  if (endTs <= startTs) return 0;
  if (!schedule) return endTs - startTs;
  if (!scheduleHasOpenWindows(schedule)) return endTs - startTs; // misconfig → wall clock
  const holidaySet = new Set(schedule.holidays);
  let sum = 0;
  // Start one day early: the previous day's overnight window may cover startTs.
  let day = addDays(localDateOf(startTs, schedule.tz), -1);
  const lastDay = localDateOf(endTs, schedule.tz);
  const lastKey = dateKey(lastDay);
  for (let i = 0; i < MAX_DAY_ITERATIONS; i++) {
    for (const iv of openIntervalsForDay(schedule, day, holidaySet)) {
      const lo = Math.max(iv.start, startTs);
      const hi = Math.min(iv.end, endTs);
      if (hi > lo) sum += hi - lo;
    }
    if (dateKey(day) === lastKey) return sum;
    day = addDays(day, 1);
  }
  return sum; // iteration cap hit — best-effort undercount
}

// The instant at which `ms` of business time will have elapsed after `start`
// (SLA deadline). null schedule = wall clock. Returns null when the walk cap
// is exhausted (pathologically sparse schedule).
export function addBusinessMs(schedule: OfficeHoursSchedule | null, start: Date, ms: number): Date | null {
  const startTs = start.getTime();
  if (ms <= 0) return new Date(startTs);
  if (!schedule || !scheduleHasOpenWindows(schedule)) return new Date(startTs + ms);
  const holidaySet = new Set(schedule.holidays);
  let remaining = ms;
  let day = addDays(localDateOf(startTs, schedule.tz), -1);
  for (let i = 0; i < MAX_DEADLINE_DAYS; i++) {
    for (const iv of openIntervalsForDay(schedule, day, holidaySet)) {
      const lo = Math.max(iv.start, startTs);
      if (iv.end <= lo) continue;
      const span = iv.end - lo;
      if (span >= remaining) return new Date(lo + remaining);
      remaining -= span;
    }
    day = addDays(day, 1);
  }
  return null;
}
