import { test } from "node:test";
import assert from "node:assert/strict";
import { targetRenameBlocker, targetsMissingFromList } from "../types";

// The SLA Target conversation attribute is an Intercom List: a target that is
// not one of its options fails every write with a 400 ("Incompatible value
// for attribute 'SLA Target' of type 'list'"). Verify Setup names them.

test("targets outside the list's options are named, once each", () => {
  const options = ["SLA-Support-Default", "SLA-Developer-Default"];
  assert.deepEqual(
    targetsMissingFromList(["SLA-Support-Default", "Support-Default-SLA", "Support-Default-SLA", "SLA-Developer-Default"], options),
    ["Support-Default-SLA"]
  );
  assert.deepEqual(targetsMissingFromList(["sla-support-default"], options), ["sla-support-default"], "case matters");
});

test("no options to compare (not a List, or unreadable): nothing is flagged", () => {
  assert.deepEqual(targetsMissingFromList(["anything"], []), []);
});

test("a target a rule or the default uses cannot be renamed", () => {
  const base = { from: "SLA-Support-Default", existing: ["SLA-Support-Default", "SLA-Developer-Default"], usedByRule: false, isDefault: false };
  assert.equal(targetRenameBlocker({ ...base, to: "Support-Default-SLA" }), null);
  assert.equal(targetRenameBlocker({ ...base, to: "SLA-Support-Default", usedByRule: true, isDefault: true }), null, "same value is a clock edit");
  assert.match(targetRenameBlocker({ ...base, to: "Support-Default-SLA", usedByRule: true }) ?? "", /used by a rule/);
  assert.match(targetRenameBlocker({ ...base, to: "Support-Default-SLA", isDefault: true }) ?? "", /default/);
  assert.match(targetRenameBlocker({ ...base, to: "SLA-Developer-Default" }) ?? "", /already exists/);
});
