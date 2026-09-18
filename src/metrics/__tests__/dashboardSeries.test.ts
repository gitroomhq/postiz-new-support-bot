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
// BOTH emitter modules. The three money measurements (money_out,
// dispute_outcomes, subscription_events) live in moneyPoints.ts, because they
// are built from a Postgres row rather than from loose parameters — see that
// file's header. Reading only MetricsExporter.ts would silently report them as
// unwritten and mark every money panel an orphan.
const exporterSrc = [
  readFileSync(join(root, "src", "metrics", "MetricsExporter.ts"), "utf8"),
  readFileSync(join(root, "src", "bot", "billing", "moneyPoints.ts"), "utf8"),
].join("\n");

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
//   ticket_events, ticket_snapshot, ai_scores, ai_staff_scores
//     retired by the agent-rip, which removed ticket scoring, the report loop
//     and the ticket-side Influx writes. The panels reading them were left
//     behind. support-overview.json is 9/13 dead and bot-ops.json 2/9; both
//     need either new emitters or the panels removed, which is a product
//     decision rather than a test's to make.
//
// ai_runs used to be on this list and should not have been: it is still emitted
// (exportAiRun, from ClaudeCodeRunner and LightAiRunner), so listing it here
// exempted a live measurement from the orphan check for no reason.
//
// Listing them here keeps the hole visible and permanently tracked while still
// failing on any NEW orphan.
const RETIRED_MEASUREMENTS = new Set(["ticket_events", "ticket_snapshot", "ai_scores", "ai_staff_scores"]);

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

// A dashboard can also query the right MEASUREMENT and the wrong FIELD, which
// fails identically: an empty panel that looks like "nothing happened".
//
// This is not hypothetical. The money measurements changed from amount_minor
// (in the row's own currency, so a mixed-currency total added EUR minor units
// to USD ones) to amount_usd_minor, and a dashboard left on the old name would
// have read zero everywhere — indistinguishable from the rebuild having deleted
// the data it had just restored.
function queriedFields(json: string): Set<string> {
  const names = new Set<string>();
  for (const m of json.matchAll(/_field\s*==\s*\\"([a-z0-9_]+)\\"/g)) names.add(m[1]);
  return names;
}

test("no dashboard queries a money field the exporter never writes", () => {
  // Only the money measurements: the gauges write their fields through spread
  // objects the regex above cannot see, so asserting on them would be a test
  // that fails for being unable to look rather than for anything being wrong.
  const known = new Set([
    "count",
    "amount_usd_minor",
    "fee_usd_minor",
    "net_usd_minor",
    "mrr_delta_usd_minor",
    "mrr_at_risk_usd_minor",
    "fx_rate",
    "usd_convertible",
    "currency",
    "source",
    "submitted",
    "closed_at_estimated",
    "closed_at_source",
    "has_comment",
    "comment",
  ]);
  const stale: string[] = [];
  for (const file of files) {
    const raw = readFileSync(join(dashboardDir, file), "utf8");
    const measurements = queriedMeasurements(raw);
    const touchesMoney = ["money_out", "dispute_outcomes", "subscription_events"].some((m) => measurements.has(m));
    if (!touchesMoney) continue;
    for (const field of queriedFields(raw)) {
      // A dashboard can mix money panels with others; only flag the fields that
      // look like the ones that moved.
      if (/_minor$/.test(field) && !known.has(field)) stale.push(`${file}: ${field}`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `these panels query a money field that no longer exists, and would read zero forever:\n  ${stale.join("\n  ")}`
  );
});

test("every measurement is classified as rebuildable or fixed", async () => {
  // The analytics rebuild DELETES everything on the rebuildable list. An
  // unclassified measurement is therefore a silent bug in one of two
  // directions: left off both lists it survives a wipe while its mirror is
  // re-emitted around it (double-counted forever), and wrongly listed as
  // rebuildable it is deleted with nothing able to restore it.
  //
  // Neither shows up until someone reads a chart months later, so the only
  // workable guard is to make adding a measurement without classifying it fail
  // the build.
  const { REBUILDABLE_MEASUREMENTS, FIXED_MEASUREMENTS } = await import("../measurements");
  const rebuildable = new Set<string>(REBUILDABLE_MEASUREMENTS);
  const fixed = new Set<string>(FIXED_MEASUREMENTS);

  const overlap = [...rebuildable].filter((m) => fixed.has(m));
  assert.deepEqual(overlap, [], `a measurement cannot be both rebuildable and fixed: ${overlap.join(", ")}`);

  const unclassified = [...emitted].filter((m) => !rebuildable.has(m) && !fixed.has(m));
  assert.deepEqual(
    unclassified,
    [],
    `classify these in src/metrics/measurements.ts before shipping — the rebuild either wipes them with no way back, or leaves them to double-count:\n  ${unclassified.join("\n  ")}`
  );

  const phantom = [...rebuildable, ...fixed].filter((m) => !emitted.has(m));
  assert.deepEqual(phantom, [], `classified but never emitted (stale entry?): ${phantom.join(", ")}`);
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
