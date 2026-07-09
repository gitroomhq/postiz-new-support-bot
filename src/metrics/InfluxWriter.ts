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

// Rate-limit write-failure logging: Influx being down must not flood stderr/Sentry.
let lastWriteFailureLogAt = 0;
const WRITE_FAILURE_LOG_INTERVAL_MS = 60_000;

function openWriteApi(cfg: InfluxRuntimeConfig): WriteApi | null {
  if (!cfg.enabled || !cfg.url || !cfg.org || !cfg.bucket || !cfg.token) return null;
  const client = new InfluxDB({ url: cfg.url, token: cfg.token });
  const api = client.getWriteApi(cfg.org, cfg.bucket, "ms", {
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
  if (writeApi) {
    influxLog.info("influx.enabled", { "influx.url": cfg.url, "influx.bucket": cfg.bucket });
  }
}

// Applies a /config change live: flush + close the old WriteApi, open a new one.
export async function reconfigureInflux(cfg: InfluxRuntimeConfig): Promise<void> {
  const old = writeApi;
  writeApi = null;
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

export type FieldValue = number | string | boolean;

// Fire-and-forget point write. Tags must be bounded sets (cardinality!); ids
// like thread/charge/session ids belong in fields. No-ops when inactive and
// never throws — metrics export must never break the caller.
export function writePoint(
  measurement: string,
  tags: Record<string, string>,
  fields: Record<string, FieldValue | null | undefined>,
  timestamp?: Date
): void {
  const api = writeApi;
  if (!api) return;
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

// SIGINT/SIGTERM: best-effort flush of the remaining buffer, capped so shutdown
// can't hang on an unreachable Influx.
export async function shutdownInflux(timeoutMs = 2_000): Promise<void> {
  const api = writeApi;
  writeApi = null;
  if (!api) return;
  await Promise.race([
    api.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
