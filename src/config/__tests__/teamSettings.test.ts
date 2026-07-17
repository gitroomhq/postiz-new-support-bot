import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTeamSettingsMap,
  parseCursorMap,
  parseExcludedAdmins,
  mergeEntry,
  stripFields,
  isEntryMeaningful,
  type TeamSettingsEntry,
} from "../teamSettings";

test("parseTeamSettingsMap keeps known fields, drops junk, leaves absent fields undefined", () => {
  const map = parseTeamSettingsMap({
    "5": { teamName: "Support", assignEnabled: true },
    "6": { officeHoursEnabled: false, assignExcludedAdmins: [{ id: "a", name: "Ann" }], bogus: 1 },
    "7": "not an object",
    "8": { assignEnabled: "yes" }, // wrong type → dropped to undefined
  });
  assert.deepEqual(map["5"], {
    teamName: "Support",
    assignEnabled: true,
    assignExcludedAdmins: undefined,
    officeHoursEnabled: undefined,
    officeHoursJson: undefined,
  });
  assert.equal(map["6"].officeHoursEnabled, false);
  assert.deepEqual(map["6"].assignExcludedAdmins, [{ id: "a", name: "Ann" }]);
  assert.equal("7" in map, false);
  assert.equal(map["8"].assignEnabled, undefined); // "yes" is not a boolean
});

test("parseTeamSettingsMap tolerates non-objects", () => {
  assert.deepEqual(parseTeamSettingsMap(null), {});
  assert.deepEqual(parseTeamSettingsMap([1, 2]), {});
  assert.deepEqual(parseTeamSettingsMap("x"), {});
});

test("parseExcludedAdmins keeps id, defaults name, drops malformed", () => {
  assert.deepEqual(parseExcludedAdmins([{ id: "1", name: "One" }, { id: "2" }, { name: "no id" }, 5]), [
    { id: "1", name: "One" },
    { id: "2", name: "2" },
  ]);
  assert.deepEqual(parseExcludedAdmins("nope"), []);
});

test("parseCursorMap keeps only string values", () => {
  assert.deepEqual(parseCursorMap({ "5": "admin1", "6": 42, "7": "admin2" }), { "5": "admin1", "7": "admin2" });
  assert.deepEqual(parseCursorMap(null), {});
});

test("isEntryMeaningful ignores teamName-only entries", () => {
  assert.equal(isEntryMeaningful({ teamName: "Support" }), false);
  assert.equal(isEntryMeaningful({ assignEnabled: false }), true); // explicit false is meaningful
  assert.equal(isEntryMeaningful({ officeHoursJson: { tz: "UTC", week: {} as never, holidays: [] } }), true);
});

test("mergeEntry adds/updates fields and snapshots the team name", () => {
  let map: Record<string, TeamSettingsEntry> = {};
  map = mergeEntry(map, "5", "Support", { assignEnabled: true });
  assert.deepEqual(map["5"], { assignEnabled: true, teamName: "Support" });
  // A second concern merges in, preserving the first + name.
  map = mergeEntry(map, "5", "Support", { officeHoursEnabled: true });
  assert.deepEqual(map["5"], { assignEnabled: true, officeHoursEnabled: true, teamName: "Support" });
});

test("mergeEntry does not mutate the input map", () => {
  const original: Record<string, TeamSettingsEntry> = { "5": { assignEnabled: true } };
  const next = mergeEntry(original, "5", null, { officeHoursEnabled: true });
  assert.equal(original["5"].officeHoursEnabled, undefined); // input untouched
  assert.equal(next["5"].officeHoursEnabled, true);
});

test("stripFields removes a concern and drops the entry when nothing meaningful remains", () => {
  const map: Record<string, TeamSettingsEntry> = {
    "5": { teamName: "Support", assignEnabled: true, officeHoursEnabled: true },
  };
  // Strip assignment → office hours remains.
  const afterAssign = stripFields(map, "5", ["assignEnabled", "assignExcludedAdmins"]);
  assert.deepEqual(afterAssign["5"], { teamName: "Support", officeHoursEnabled: true });
  // Strip the remaining office-hours concern → entry gone entirely.
  const afterAll = stripFields(afterAssign, "5", ["officeHoursEnabled", "officeHoursJson"]);
  assert.equal("5" in afterAll, false);
});

test("stripFields is a no-op for an unknown team", () => {
  const map: Record<string, TeamSettingsEntry> = { "5": { assignEnabled: true } };
  assert.equal(stripFields(map, "99", ["assignEnabled"]), map);
});
