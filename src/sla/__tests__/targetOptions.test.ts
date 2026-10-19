import { test } from "node:test";
import assert from "node:assert/strict";
import { targetsMissingFromList } from "../types";

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
