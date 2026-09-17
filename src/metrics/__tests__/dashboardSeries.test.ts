import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The Grafana dashboards are hand-imported and never type-checked, so a panel
// can quietly query a series nothing writes. It renders as an empty graph,
// which looks exactly like "nothing happened" rather than like a bug, and the
// mistake survives for weeks.
//
// This reads the shipped dashboards, pulls every measurement they query, and
// compares that against what the exporter actually writes.

const root = process.cwd();
const dashboardDir = join(root, "grafana", "dashboards");
const exporterSrc = readFileSync(join(root, "src", "metrics", "MetricsExporter.ts"), "utf8");

// writePoint("name", ...) with the name on the same line or the next one.
function emittedMeasurements(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/writePoint\(\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  return names;
}

function queriedMeasurements(json: string): Set<string> {
  const names = new Set<string>();
  // Flux inside the JSON, so the quotes arrive escaped.
  for (const m of json.matchAll(/_measurement\s*==\s*\\"([a-z0-9_]+)\\"/g)) names.add(m[1]);
  return names;
}

// Measurements whose EMITTERS were deleted, leaving panels that can never draw
// anything. These are pre-existing and known, not new breakage:
//
//   ticket_events, ticket_snapshot, ai_scores, ai_runs, ai_staff_scores
//     retired by the agent-rip, which removed ticket scoring, the report loop
//     and the ticket-side Influx writes. The panels reading them were left
//     behind. support-overview.json is 9/13 dead and bot-ops.json 2/9; both
//     need either new emitters or the panels removed, which is a product
//     decision rather than a test's to make.
//
// Listing them here keeps the hole visible and permanently tracked while still
// failing on any NEW orphan.
const RETIRED_MEASUREMENTS = new Set(["ticket_events", "ticket_snapshot", "ai_scores", "ai_runs", "ai_staff_scores"]);

const emitted = emittedMeasurements(exporterSrc);
const files = readdirSync(dashboardDir).filter((f) => f.endsWith(".json"));

test("the exporter parse found the real measurements (guards a no-op test)", () => {
  assert.ok(emitted.size >= 15, `parsed only ${emitted.size} measurements out of the exporter`);
  for (const expected of ["dispute_snapshot", "dispute_outcomes", "dispute_auto_resolve", "money_out"]) {
    assert.ok(emitted.has(expected), `${expected} should be emitted`);
  }
});

test("every dashboard is valid JSON with unique panel ids and a datasource variable", () => {
  for (const file of files) {
    const raw = readFileSync(join(dashboardDir, file), "utf8");
    const dash = JSON.parse(raw) as {
      uid?: string;
      panels?: Array<{ id?: number; gridPos?: object }>;
      templating?: { list?: Array<{ name: string }> };
    };
    assert.ok(dash.uid, `${file} has no uid, so re-importing it would duplicate the dashboard`);
    const ids = (dash.panels ?? []).map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, `${file} has duplicate panel ids`);
    for (const p of dash.panels ?? []) assert.ok(p.gridPos, `${file} has a panel with no gridPos`);
    const vars = (dash.templating?.list ?? []).map((v) => v.name);
    assert.ok(vars.includes("datasource") && vars.includes("bucket"), `${file} is missing the datasource/bucket variables`);
  }
});

test("no dashboard queries a measurement the exporter never writes", () => {
  const orphans: string[] = [];
  for (const file of files) {
    const raw = readFileSync(join(dashboardDir, file), "utf8");
    for (const measurement of queriedMeasurements(raw)) {
      if (!emitted.has(measurement) && !RETIRED_MEASUREMENTS.has(measurement)) {
        orphans.push(`${file}: ${measurement}`);
      }
    }
  }
  assert.deepEqual(
    orphans,
    [],
    `these panels would render empty forever, because nothing writes the series:\n  ${orphans.join("\n  ")}`
  );
});

test("every dispute measurement the exporter writes is charted somewhere", () => {
  // The other direction: a metric nobody can see is a metric nobody acts on.
  // Scoped to disputes, which is the surface this dashboard set exists for.
  const charted = new Set<string>();
  for (const file of files) {
    for (const m of queriedMeasurements(readFileSync(join(dashboardDir, file), "utf8"))) charted.add(m);
  }
  const uncharted = [...emitted].filter((m) => m.startsWith("dispute") && !charted.has(m));
  assert.deepEqual(uncharted, [], `emitted but never charted: ${uncharted.join(", ")}`);
});
