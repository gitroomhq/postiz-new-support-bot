import { InfluxDB, Point, WriteApi } from "@influxdata/influxdb-client";
import { log } from "../util/logger";

const influxLog = log.child("influx");

// Runtime config resolved from BotSettings (see SettingsStore.influxConfig()).
// The exporter is active only when enabled AND all four connection fields exist.
export interface InfluxRuntimeConfig {
  enabled: boolean;
  url: string | null;
  org: string | null;
  bucket: string | null;
  token: string | null;
}

let writeApi: WriteApi | null = null;
// The connection behind the WriteApi, kept so the delete endpoint (which the
// client has no API for) can be called against the same bucket the points go to.
let activeConfig: InfluxRuntimeConfig | null = null;

// Rate-limit write-failure logging: Influx being down must not flood stderr/Sentry.
let lastWriteFailureLogAt = 0;
const WRITE_FAILURE_LOG_INTERVAL_MS = 60_000;

function openWriteApi(cfg: InfluxRuntimeConfig): WriteApi | null {
  if (!cfg.enabled || !cfg.url || !cfg.org || !cfg.bucket || !cfg.token) return null;
  const client = new InfluxDB({ url: cfg.url, token: cfg.token });
  // NANOSECOND precision, deliberately, even though nothing measures time that
  // finely. Stripe's `created` is second-granularity, so every ledger row's
  // occurredAt is X.000ms; at "ms" precision two different refunds in the same
  // second with the same tags land on the identical point and one of them
  // silently overwrites the other. The extra digits exist purely to carry the
  // per-row disambiguator from nsTimestamp() below.
  //
  // Safe for every existing call site: the client's convertTime passes a STRING
  // through verbatim, converts a Date correctly for the configured precision,
  // and falls back to hrtime when the timestamp is absent.
  const api = client.getWriteApi(cfg.org, cfg.bucket, "ns", {
    batchSize: 100,
    flushInterval: 10_000,
    maxRetries: 3,
    // Bounded in-memory buffer: if Influx is unreachable, points are dropped
    // (metrics export must never block or grow memory unbounded).
    maxBufferLines: 5_000,
    writeFailed: (error) => {
      const now = Date.now();
      if (now - lastWriteFailureLogAt > WRITE_FAILURE_LOG_INTERVAL_MS) {
        lastWriteFailureLogAt = now;
        influxLog.warn("influx.write_failed", { "influx.error": String(error) });
      }
      // Returning undefined keeps the client's default retry behavior.
      return undefined;
    },
  });
  return api;
}

export function initInflux(cfg: InfluxRuntimeConfig): void {
  writeApi = openWriteApi(cfg);
  activeConfig = writeApi ? cfg : null;
  if (writeApi) {
    influxLog.info("influx.enabled", { "influx.url": cfg.url, "influx.bucket": cfg.bucket });
  }
}

// Applies a /config change live: flush + close the old WriteApi, open a new one.
export async function reconfigureInflux(cfg: InfluxRuntimeConfig): Promise<void> {
  const old = writeApi;
  writeApi = null;
  activeConfig = null;
  if (old) {
    try {
      await old.close();
    } catch {
      // Old buffer flush failure is not actionable during a reconfigure.
    }
  }
  initInflux(cfg);
}

export function influxActive(): boolean {
  return writeApi != null;
}

// ---- emission suppression ----

// Measurements that writePoint silently drops.
//
// The analytics rebuild closes this gate over the rebuildable measurements for
// its repair and wipe phases: the repair rewrites tag VALUES, and a point
// written from a half-repaired row would be a series the wipe then orphans.
// Non-rebuildable measurements keep flowing throughout — their history has no
// second source, so suppressing them would lose it.
//
// Deliberately enforced HERE rather than at the ~25 export* call sites. A gate
// spread across call sites is a gate somebody forgets when they add the
// twenty-sixth next quarter, and the failure would be silent.
let suppressed: ReadonlySet<string> = new Set();

export function setSuppressedMeasurements(names: ReadonlySet<string>): void {
  suppressed = names;
  if (names.size > 0) {
    influxLog.info("influx.suppression_on", { "influx.measurements": [...names].join(",") });
  } else {
    influxLog.info("influx.suppression_off", {});
  }
}

export function suppressedMeasurements(): ReadonlySet<string> {
  return suppressed;
}

export type FieldValue = number | string | boolean;

// A nanosecond timestamp that carries a deterministic per-row disambiguator in
// its sub-millisecond digits.
//
// Influx identifies a point by measurement + tag set + timestamp, and a money
// point deliberately carries no identifier in its tags (ids are unbounded, and
// several of them are PII-adjacent). Two distinct rows with the same tags and
// the same timestamp are therefore the SAME point to Influx, and the second
// write silently replaces the first. Stripe stamps to the second, so that is
// not a rare collision: it is what happens every time two similar refunds land
// in the same second.
//
// The offset is a hash of the row id, so it is stable forever: re-emitting a
// row during a rebuild reproduces the identical timestamp and overwrites its
// own earlier point, which is exactly the idempotency the backfills rely on.
// Two different ids collide only on a 1-in-10^6 hash tie.
export function nsTimestamp(at: Date, dedupeKey: string): string {
  // FNV-1a, 32-bit. Chosen for being short, dependency-free and well spread over
  // short ASCII keys like "txn_3Qk…" — not for any cryptographic property.
  let hash = 0x811c9dc5;
  for (let i = 0; i < dedupeKey.length; i++) {
    hash ^= dedupeKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const sub = String(hash % 1_000_000).padStart(6, "0");
  return `${at.getTime()}${sub}`;
}

// Fire-and-forget point write. Tags must be bounded sets (cardinality!); ids
// like thread/charge/session ids belong in fields. No-ops when inactive and
// never throws — metrics export must never break the caller.
//
// A string timestamp is written verbatim as NANOSECONDS (see openWriteApi) and
// is how callers pass an nsTimestamp(); a Date is converted for them.
export function writePoint(
  measurement: string,
  tags: Record<string, string>,
  fields: Record<string, FieldValue | null | undefined>,
  timestamp?: Date | string
): void {
  const api = writeApi;
  if (!api) return;
  if (suppressed.has(measurement)) return;
  try {
    const point = new Point(measurement);
    for (const [k, v] of Object.entries(tags)) {
      if (v) point.tag(k, v);
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v == null) continue;
      if (typeof v === "number") {
        // Always float: a field that's `12` on one point and `12.5` on another
        // would otherwise write conflicting int/float types into the bucket.
        point.floatField(k, v);
      } else if (typeof v === "boolean") {
        point.booleanField(k, v);
      } else {
        point.stringField(k, v);
      }
    }
    if (timestamp) point.timestamp(timestamp);
    api.writePoint(point);
  } catch (err) {
    const now = Date.now();
    if (now - lastWriteFailureLogAt > WRITE_FAILURE_LOG_INTERVAL_MS) {
      lastWriteFailureLogAt = now;
      influxLog.warn("influx.point_failed", { "influx.error": String(err) });
    }
  }
}

export async function flushInflux(): Promise<void> {
  const api = writeApi;
  if (!api) return;
  try {
    await api.flush();
  } catch (err) {
    influxLog.warn("influx.flush_failed", { "influx.error": String(err) });
  }
}

// Write one test point and force a flush — used by the /config "Send test point"
// button. Throws on failure so the caller can show the error.
export async function pingInflux(): Promise<void> {
  const api = writeApi;
  if (!api) throw new Error("Influx exporter is not active (check enabled flag and connection settings).");
  const point = new Point("bot_health").floatField("up", 1);
  api.writePoint(point);
  await api.flush();
}

// ---- delete ----

export class InfluxDeleteError extends Error {
  constructor(
    message: string,
    readonly reason: "inactive" | "unsupported" | "unauthorized" | "http" | "network"
  ) {
    super(message);
    this.name = "InfluxDeleteError";
  }
}

// Hard reset of the client immediately before a wipe.
//
// flushInflux() is NOT sufficient on its own. The client holds two buffers: the
// write buffer, which flush() drains, and a RetryBuffer of lines from earlier
// sends that failed. The retry buffer re-fires on its own timer, so lines
// sitting in it can be delivered AFTER the delete call and survive the wipe —
// which would leave exactly the duplicated history this rebuild exists to
// remove. dispose() clears the timers and drops that buffer, returning how many
// lines went with it.
//
// Dropping them is safe here and only here: suppression is already on, so
// nothing rebuildable has been queued since the repair began, and everything
// rebuildable that WAS in there is about to be re-emitted from Postgres. A
// non-zero count means Influx was unhealthy during the run and belongs in the
// report.
export function resetInfluxForRebuild(cfg: InfluxRuntimeConfig): { droppedLines: number } {
  const old = writeApi;
  writeApi = null;
  activeConfig = null;
  let droppedLines = 0;
  if (old) {
    try {
      droppedLines = old.dispose();
    } catch (err) {
      influxLog.warn("influx.dispose_failed", { "influx.error": String(err) });
    }
  }
  initInflux(cfg);
  return { droppedLines };
}

// Drop every point of the named measurements from the configured bucket.
//
// @influxdata/influxdb-client ships no delete API at all (it is write + query
// only), so this calls the REST endpoint directly.
//
// Plain fetch, NOT safeFetch. safeFetch exists for URLs whose value is steered
// by an external system, and it refuses private addresses on purpose; this URL
// is typed by an operator into /config and a self-hosted Influx is normally on
// exactly such an address. It is the same URL the write path already posts
// every point to, at the same trust level.
//
// THROWS on anything that is not a success. That is the whole point: a wipe
// that quietly did nothing, followed by a re-emit, produces a bucket with
// everything counted twice — the precise failure this work exists to fix. A 405
// or 501 means InfluxDB Cloud Serverless, which has no delete endpoint and
// needs the bucket recreated by hand instead.
export async function deleteMeasurements(
  measurements: string[],
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  const cfg = requireDeleteConfig();
  // Points still sitting in the client's batch buffer would land AFTER the
  // delete and survive it. (The retry buffer needs resetInfluxForRebuild; see
  // its comment — callers doing a real wipe must do both.)
  await flushInflux();

  // Stop slightly in the future so a point written moments ago by an in-flight
  // webhook cannot sit just past the window.
  const stop = new Date(Date.now() + 60 * 60_000);
  for (const measurement of measurements) {
    await deleteOne(cfg, measurement, new Date(0), stop, opts.signal);
  }

  influxLog.info("influx.deleted", {
    "influx.bucket": cfg.bucket,
    "influx.measurements": measurements.join(","),
  });
}

// Prove the delete endpoint works BEFORE the rebuild spends an hour walking
// Stripe. Discovering a 405 or a token-permission problem after the repair has
// run is the worst available outcome: the mirror has been rewritten and the
// bucket still holds the old points.
//
// Deleting a measurement that does not exist is a 204 no-op, so this validates
// url + org + bucket + token + endpoint support in one harmless call against a
// name nothing writes.
export async function probeInfluxDelete(opts: { signal?: AbortSignal } = {}): Promise<void> {
  const cfg = requireDeleteConfig();
  const now = new Date();
  await deleteOne(cfg, "analytics_rebuild_probe", new Date(now.getTime() - 1_000), now, opts.signal);
}

// The connection with every field proven present — the delete endpoint needs
// all four, and InfluxRuntimeConfig types them as nullable.
interface InfluxDeleteTarget {
  url: string;
  org: string;
  bucket: string;
  token: string;
}

function requireDeleteConfig(): InfluxDeleteTarget {
  const cfg = activeConfig;
  if (!writeApi || !cfg || !cfg.url || !cfg.org || !cfg.bucket || !cfg.token) {
    throw new InfluxDeleteError("Influx exporter is not active, so there is nothing to delete from.", "inactive");
  }
  return { url: cfg.url, org: cfg.org, bucket: cfg.bucket, token: cfg.token };
}

async function deleteOne(
  cfg: InfluxDeleteTarget,
  measurement: string,
  start: Date,
  stop: Date,
  signal?: AbortSignal
): Promise<void> {
  const base = cfg.url.replace(/\/+$/, "");
  const url = `${base}/api/v2/delete?org=${encodeURIComponent(cfg.org)}&bucket=${encodeURIComponent(cfg.bucket)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Token ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        start: start.toISOString(),
        stop: stop.toISOString(),
        predicate: `_measurement="${measurement}"`,
      }),
      signal,
    });
  } catch (error) {
    throw new InfluxDeleteError(`could not reach Influx to delete ${measurement}: ${String(error)}`, "network");
  }
  if (res.ok) return;

  const detail = (await res.text().catch(() => "")).slice(0, 300);
  // InfluxDB Cloud Serverless (IOx) has no delete endpoint at all. Named
  // explicitly because the fix is not a retry — it is a different deployment or
  // a bucket recreated by hand — and because proceeding would double every
  // number in the bucket.
  if (res.status === 405 || res.status === 501 || /not implemented|unsupported|not supported/i.test(detail)) {
    throw new InfluxDeleteError(
      `this InfluxDB does not support /api/v2/delete (HTTP ${res.status}). InfluxDB Cloud Serverless has no delete endpoint: rebuilding without a wipe would double-count every point in the bucket, so the rebuild stops here. Recreate the bucket by hand in the Influx UI and run this again, or move to InfluxDB OSS 2.x. ${detail}`,
      "unsupported"
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new InfluxDeleteError(
      `the Influx token is not allowed to delete from bucket "${cfg.bucket}" (HTTP ${res.status}). A delete needs write access to the bucket, which is broader than the write endpoint alone. ${detail}`,
      "unauthorized"
    );
  }
  if (res.status === 404) {
    throw new InfluxDeleteError(
      `Influx does not know org "${cfg.org}" or bucket "${cfg.bucket}" (HTTP 404). Check the connection settings in /config. ${detail}`,
      "http"
    );
  }
  throw new InfluxDeleteError(`deleting ${measurement} failed: HTTP ${res.status} ${detail}`, "http");
}

// SIGINT/SIGTERM: best-effort flush of the remaining buffer, capped so shutdown
// can't hang on an unreachable Influx.
export async function shutdownInflux(timeoutMs = 2_000): Promise<void> {
  const api = writeApi;
  writeApi = null;
  activeConfig = null;
  if (!api) return;
  await Promise.race([
    api.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
