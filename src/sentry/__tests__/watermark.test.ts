import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceWatermark, planFeedbackWalk } from "../feedbackFormat";

const item = (id: string, iso: string) => ({ id, firstSeen: iso });

test("planFeedbackWalk drops items at/under the floor, sorts ascending, dedupes by id", () => {
  const floor = new Date("2026-07-20T10:00:00Z");
  const { todo, overflow } = planFeedbackWalk(
    [
      item("c", "2026-07-20T12:00:00Z"),
      item("a", "2026-07-20T10:30:00Z"),
      item("floor", "2026-07-20T10:00:00Z"), // exactly the floor → excluded
      item("old", "2026-07-20T09:59:59Z"),
      item("a", "2026-07-20T10:30:00Z"), // duplicate id (overlap re-list)
      item("b", "2026-07-20T11:00:00Z"),
      item("bad", "not-a-date"),
    ],
    floor,
    10
  );
  assert.deepEqual(
    todo.map((i) => i.id),
    ["a", "b", "c"]
  );
  assert.equal(overflow, 0);
});

test("planFeedbackWalk caps with an explicit overflow count (oldest first survive)", () => {
  const floor = new Date("2026-07-20T10:00:00Z");
  const items = Array.from({ length: 7 }, (_, i) => item(`i${i}`, `2026-07-20T1${i + 1}:00:00Z`));
  const { todo, overflow } = planFeedbackWalk(items, floor, 5);
  assert.deepEqual(
    todo.map((i) => i.id),
    ["i0", "i1", "i2", "i3", "i4"]
  );
  assert.equal(overflow, 2);
});

test("advanceWatermark advances through terminal outcomes to the max feedbackAt", () => {
  const current = new Date("2026-07-20T10:00:00Z");
  const mark = advanceWatermark(
    [
      { feedbackAt: new Date("2026-07-20T10:30:00Z"), terminal: true },
      { feedbackAt: new Date("2026-07-20T11:00:00Z"), terminal: true },
    ],
    current
  );
  assert.equal(mark.toISOString(), "2026-07-20T11:00:00.000Z");
});

test("advanceWatermark freezes at the first failure even when later items succeeded", () => {
  const current = new Date("2026-07-20T10:00:00Z");
  const mark = advanceWatermark(
    [
      { feedbackAt: new Date("2026-07-20T10:30:00Z"), terminal: true },
      { feedbackAt: new Date("2026-07-20T11:00:00Z"), terminal: false }, // poison item
      { feedbackAt: new Date("2026-07-20T12:00:00Z"), terminal: true }, // ledger-protected
    ],
    current
  );
  assert.equal(mark.toISOString(), "2026-07-20T10:30:00.000Z");
});

test("advanceWatermark never moves backwards and no-ops on empty input", () => {
  const current = new Date("2026-07-20T10:00:00Z");
  assert.equal(advanceWatermark([], current).toISOString(), current.toISOString());
  // Overlap re-reads can surface terminal items OLDER than the watermark.
  const mark = advanceWatermark([{ feedbackAt: new Date("2026-07-20T09:00:00Z"), terminal: true }], current);
  assert.equal(mark.toISOString(), current.toISOString());
});
