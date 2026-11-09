import { test } from "node:test";
import assert from "node:assert/strict";
import { SlaBreachBoard, breachLabel } from "../breachBoard";

test("breachLabel names the clock that broke", () => {
  assert.equal(breachLabel(null), "SLA breached");
  assert.equal(breachLabel([]), "SLA breached");
  assert.equal(breachLabel(["first_reply"]), "Reply SLA breached");
  assert.equal(breachLabel(["next_reply"]), "Reply SLA breached");
  assert.equal(breachLabel(["resolution"]), "Resolution SLA breached");
  assert.equal(breachLabel(["next_reply", "resolution"]), "Reply and resolution SLA breached");
});

test("the board keeps the last tick's breaches and forgets stale ones", () => {
  let now = 1_000_000;
  const board = new SlaBreachBoard(() => now);
  board.record("c1", ["next_reply", "next_reply"]);
  assert.deepEqual(board.breached("c1"), ["next_reply"]);
  assert.equal(board.breached("c2"), null);

  // A tick that finds nothing breached clears the entry.
  board.record("c1", []);
  assert.equal(board.breached("c1"), null);

  // A conversation the enforcer stopped evaluating ages out.
  board.record("c3", ["resolution"]);
  now += 29 * 60_000;
  assert.deepEqual(board.breached("c3"), ["resolution"]);
  now += 2 * 60_000;
  assert.equal(board.breached("c3"), null);
});
