import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPool, pickAssignee, type PoolMember } from "../assignment";
import type { IntercomAdmin } from "../types";

function member(id: string, openCount = 0, overrides: Partial<PoolMember> = {}): PoolMember {
  return { id, name: `Admin ${id}`, openCount, away: false, excluded: false, ...overrides };
}

function admin(id: string, overrides: Partial<IntercomAdmin> = {}): IntercomAdmin {
  return { id, name: `Admin ${id}`, email: null, avatarUrl: null, ...overrides };
}

test("buildPool filters operator, non-team, deleted, seatless; flags away/excluded; maps counts", () => {
  const pool = buildPool(
    ["1", "2", "3", "4", "5", "99"],
    [
      admin("1"),
      admin("2", { awayModeEnabled: true }),
      admin("3", { hasInboxSeat: false }),
      admin("4"),
      admin("5"),
      admin("7"), // not on the team
    ],
    "5", // operator
    new Set(["4"]),
    new Map([
      ["1", 3],
      ["2", 1],
    ]),
  );
  // 3 dropped (no seat), 5 dropped (operator), 99 dropped (unknown admin), 7 not on team
  assert.deepEqual(
    pool.map((m) => ({ id: m.id, openCount: m.openCount, away: m.away, excluded: m.excluded })),
    [
      { id: "1", openCount: 3, away: false, excluded: false },
      { id: "2", openCount: 1, away: true, excluded: false },
      { id: "4", openCount: 0, away: false, excluded: true },
    ],
  );
});

test("uniform load degrades to plain round-robin with cursor advance", () => {
  const pool = [member("a", 2), member("b", 2), member("c", 2)];
  const p1 = pickAssignee(pool, null);
  assert.equal(p1?.adminId, "a");
  const p2 = pickAssignee(pool, p1!.nextCursor);
  assert.equal(p2?.adminId, "b");
  const p3 = pickAssignee(pool, p2!.nextCursor);
  assert.equal(p3?.adminId, "c");
  const p4 = pickAssignee(pool, p3!.nextCursor); // wraps
  assert.equal(p4?.adminId, "a");
});

test("members above the pool average are skipped this round", () => {
  // avg = (6+1+2)/3 = 3 → "a" (6) skipped; rotation after cursor null starts at a
  const pool = [member("a", 6), member("b", 1), member("c", 2)];
  const pick = pickAssignee(pool, null);
  assert.equal(pick?.adminId, "b");
  // cursor at b → next in ring is c (2 <= 3)
  const pick2 = pickAssignee(pool, "b");
  assert.equal(pick2?.adminId, "c");
  // cursor at c → wraps to a (skipped) → b
  const pick3 = pickAssignee(pool, "c");
  assert.equal(pick3?.adminId, "b");
});

test("away and excluded members never receive work", () => {
  const pool = [member("a", 0, { away: true }), member("b", 5), member("c", 0, { excluded: true })];
  const pick = pickAssignee(pool, null);
  assert.equal(pick?.adminId, "b"); // only eligible member, despite highest load
});

test("empty or fully-ineligible pool returns null", () => {
  assert.equal(pickAssignee([], null), null);
  assert.equal(pickAssignee([member("a", 0, { away: true }), member("b", 0, { excluded: true })], null), null);
});

test("single member always wins and cursor stays on them", () => {
  const pool = [member("only", 42)];
  const pick = pickAssignee(pool, "only");
  assert.equal(pick?.adminId, "only");
  assert.equal(pick?.nextCursor, "only");
});

test("stale cursor (member left pool) falls back to ring start", () => {
  const pool = [member("b", 0), member("d", 0)];
  // cursor "c" no longer exists → first id > "c" is "d"
  assert.equal(pickAssignee(pool, "c")?.adminId, "d");
  // cursor beyond all ids wraps to the first
  assert.equal(pickAssignee(pool, "z")?.adminId, "b");
});

test("rotation across ticks converges to balanced distribution", () => {
  // Simulate 9 assignments with live count updates
  const counts = new Map([
    ["a", 0],
    ["b", 0],
    ["c", 0],
  ]);
  let cursor: string | null = null;
  for (let i = 0; i < 9; i++) {
    const pool = [member("a", counts.get("a")!), member("b", counts.get("b")!), member("c", counts.get("c")!)];
    const pick = pickAssignee(pool, cursor);
    assert.ok(pick);
    counts.set(pick.adminId, counts.get(pick.adminId)! + 1);
    cursor = pick.nextCursor;
  }
  assert.deepEqual([...counts.values()], [3, 3, 3]);
});
