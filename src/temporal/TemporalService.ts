import * as Sentry from "@sentry/node";
import { Client, Connection } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import type { SettingsStore } from "../config/SettingsStore";
import type { AuditLogger } from "../bot/AuditLogger";
import type { VaultService } from "../vault/VaultService";
import { log } from "../util/logger";
import { RetryBuffer, type BufferedOp } from "./RetryBuffer";
import { loadTemporalTls, parseCertInfo, temporalTlsSource, type TemporalCertInfo, type TemporalTlsMaterial, type TemporalTlsSource } from "./certs";
import { describeSaResult, ensureSearchAttributes, type SaEnsureResult } from "./searchAttributes";

const temporalLog = log.child("temporal");

// Connection state machine over the Temporal gRPC client, mirroring the
// VaultService idiom: up/down/unconfigured states, a 30s probe loop,
// transition-only audit embeds, and a bounded in-memory retry buffer so
// Discord-triggered signals survive short server outages. Never throws out of
// init/tick — Temporal being down means degraded, not dead.

export type TemporalState = "unconfigured" | "up" | "down";

// Connection values, resolved live from BotSettings (/config → Temporal →
// Connection; TEMPORAL_* env vars are first-boot fallbacks only — the deploy
// has no .env access).
export interface TemporalEnvConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  deploymentName: string;
  // TLS SNI / server-name override (dialing by IP with a hostname cert).
  tlsServerName: string | null;
}

const PROBE_INTERVAL_MS = 30_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const CONNECT_TIMEOUT = "5s";

export interface GatewayResult {
  ok: boolean;
  // The op was queued for replay after recovery (caller: webhooks answer 503
  // so the sender redelivers; Discord handlers accept it silently).
  buffered: boolean;
  // start()-style dedup outcome: the workflow was already running, which most
  // callers (stripe events, per-user AI mutex) treat as a distinct result.
  alreadyRunning?: boolean;
  error?: string;
}

export interface StartRequest {
  workflowType: string;
  workflowId: string;
  args?: unknown[];
  // Loose passthrough (workflowIdReusePolicy, workflowIdConflictPolicy, memo…)
  // so callers don't need client types.
  options?: Record<string, unknown>;
}

export interface SignalRequest {
  workflowId: string;
  signalName: string;
  signalArgs?: unknown[];
}

export interface SignalWithStartRequest extends StartRequest {
  signalName: string;
  signalArgs?: unknown[];
}

export interface TemporalTestReport {
  configured: boolean;
  configError: string | null;
  healthOk: boolean;
  healthError: string | null;
  namespaceOk: boolean;
  namespaceError: string | null;
  deploymentFound: boolean;
  currentVersion: string | null;
  deploymentError: string | null;
  visibilityOk: boolean;
  runningWorkflows: number | null;
  visibilityError: string | null;
  searchAttributesOk: boolean;
  searchAttributesDetail: string | null;
}

export class TemporalService {
  private conn: Connection | null = null;
  private clientVal: Client | null = null;
  private stateVal: TemporalState = "unconfigured";
  private lastErrorMsg: string | null = null;
  private downSinceMs: number | null = null;
  private lastFailureLogAtMs = 0;
  private buffer = new RetryBuffer(500);
  private overflowAnnounced = false;
  private saResult: SaEnsureResult | null = null;
  private recoveredHooks: Array<() => Promise<void> | void> = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private connecting: Promise<void> | null = null;

  constructor(
    private settings: SettingsStore,
    private vault: VaultService,
    private audit: AuditLogger
  ) {}

  // ---- introspection (sync, for the /config panel and gates) ----

  state(): TemporalState {
    return this.stateVal;
  }

  lastError(): string | null {
    return this.lastErrorMsg;
  }

  downSince(): Date | null {
    return this.downSinceMs ? new Date(this.downSinceMs) : null;
  }

  // Resolved fresh on every read so /config edits apply without a restart
  // (the running Client/worker still need reconfigure()/a toggle to pick a
  // CHANGED address up — connections don't hot-swap).
  envConfig(): TemporalEnvConfig {
    return {
      address: this.settings.temporalAddress() ?? "",
      namespace: this.settings.temporalNamespace() ?? "",
      taskQueue: this.settings.temporalTaskQueue(),
      deploymentName: this.settings.temporalDeploymentName(),
      tlsServerName: this.settings.temporalTlsServerName(),
    };
  }

  // Why the connection can't come up, independent of reachability. null = all
  // prerequisites present.
  configError(): string | null {
    if (!this.settings.temporalAddress()) return "Address not set (Connection in /config → Temporal).";
    if (!this.settings.temporalNamespace()) return "Namespace not set (Connection in /config → Temporal).";
    if (!this.tlsMaterial()) {
      return this.vault.state() === "up"
        ? "mTLS client cert/key not found in Vault (enter them via Certificates, or point TEMPORAL_TLS_CERT_FILE/KEY_FILE at PEM files)."
        : "mTLS client cert/key unavailable (Vault KV cache is cold or certs were never entered; TEMPORAL_TLS_CERT_FILE/KEY_FILE is the offline fallback).";
    }
    return null;
  }

  configured(): boolean {
    return this.configError() == null;
  }

  // The kill switch AND the prerequisites: producers route to Temporal only
  // when this is true.
  enabled(): boolean {
    return this.settings.temporalEnabled() && this.configured();
  }

  certInfo(): TemporalCertInfo | null {
    const tls = this.tlsMaterial();
    return tls ? parseCertInfo(tls.clientCertPem) : null;
  }

  bufferStats(): { size: number; capacity: number; droppedTotal: number } {
    return { size: this.buffer.size(), capacity: this.buffer.capacityOf(), droppedTotal: this.buffer.droppedTotal() };
  }

  onRecovered(hook: () => Promise<void> | void): void {
    this.recoveredHooks.push(hook);
  }

  // ---- custom search attributes ----

  // Producers attach search attributes to starts only while this is true — a
  // start naming an unregistered attribute would fail the whole command.
  searchAttributesReady(): boolean {
    return this.saResult?.ok === true;
  }

  searchAttributeStatus(): SaEnsureResult | null {
    return this.saResult;
  }

  // Manual retry (panel button / Test Connection): re-runs the idempotent
  // registration — e.g. after operator-API permissions were granted without a
  // reconnect. Never throws.
  async ensureSearchAttributesNow(): Promise<SaEnsureResult> {
    const client = await this.client();
    if (!client || !this.conn) {
      return {
        ok: false,
        added: [],
        present: [],
        mismatched: [],
        error: this.lastErrorMsg ?? this.configError() ?? "temporal unavailable",
      };
    }
    this.saResult = await ensureSearchAttributes(this.conn, this.envConfig().namespace);
    return this.saResult;
  }

  // Once per connection lifetime (memoized on success, retried on every
  // reconnect — the namespace may have been re-pointed via /config).
  private async ensureSearchAttributesOnce(): Promise<void> {
    if (this.saResult?.ok === true || !this.conn) return;
    this.saResult = await ensureSearchAttributes(this.conn, this.envConfig().namespace);
    temporalLog.info("temporal.search_attributes", {
      "temporal.sa_status": describeSaResult(this.saResult),
    });
  }

  tlsMaterial(): TemporalTlsMaterial | null {
    return loadTemporalTls(this.vault);
  }

  // "vault" | "env-files" | null — panels name the source so a cert that came
  // off disk is never mistaken for one stored in Vault.
  tlsSource(): TemporalTlsSource | null {
    return temporalTlsSource(this.vault);
  }

  // ---- lifecycle ----

  // Bounded warm-up (5s connect timeout), never throws. Down at boot means the
  // probe loop keeps trying.
  async init(): Promise<void> {
    await this.teardownConnection();
    // Re-check registration against the (possibly re-pointed) namespace.
    this.saResult = null;
    if (!this.configured()) {
      this.stateVal = "unconfigured";
      this.lastErrorMsg = null;
      this.downSinceMs = null;
      return;
    }
    await this.recover("init");
  }

  // Certs changed / Vault recovered / env-visible change: rebuild the
  // connection from current material. The worker keeps its own NativeConnection
  // — a cert rotation needs the temporalEnabled toggle (or a restart) to reach
  // it; the panel documents this.
  async reconfigure(): Promise<void> {
    await this.init();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => temporalLog.error("temporal probe tick failed", e));
    }, PROBE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.teardownConnection();
  }

  private async teardownConnection(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    this.clientVal = null;
    if (conn) {
      try {
        await conn.close();
      } catch {
        // already closed / never fully connected
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.stateVal === "unconfigured") {
        // Certs may have arrived out-of-band (Vault UI edit picked up by the
        // KV refresh loop) — promote to a real connection attempt.
        if (this.configured()) await this.recover("probe");
        return;
      }
      if (this.stateVal === "up") {
        try {
          await this.healthCheck();
        } catch (e) {
          this.noteFailure(e, "health probe");
        }
      } else {
        await this.recover("probe");
      }
    } finally {
      this.ticking = false;
    }
  }

  private async healthCheck(): Promise<void> {
    const conn = this.conn;
    if (!conn) throw new Error("no connection");
    const res = await conn.healthService.check({ service: "" });
    // grpc.health.v1: 1 = SERVING
    if (res.status !== 1) throw new Error(`health check status ${res.status}`);
  }

  // ---- connection / client ----

  private async ensureConnected(): Promise<Client> {
    if (this.clientVal) return this.clientVal;
    if (!this.configured()) throw new Error(this.configError() ?? "temporal not configured");
    if (!this.connecting) {
      this.connecting = (async () => {
        const tls = this.tlsMaterial()!;
        const cfg = this.envConfig();
        const conn = await Connection.connect({
          address: cfg.address,
          tls: {
            clientCertPair: {
              crt: Buffer.from(tls.clientCertPem),
              key: Buffer.from(tls.clientKeyPem),
            },
            ...(tls.caPem ? { serverRootCACertificate: Buffer.from(tls.caPem) } : {}),
            // SNI/cert-hostname override — needed when dialing by IP.
            ...(cfg.tlsServerName ? { serverNameOverride: cfg.tlsServerName } : {}),
          },
          connectTimeout: CONNECT_TIMEOUT,
        });
        this.conn = conn;
        this.clientVal = new Client({ connection: conn, namespace: cfg.namespace });
      })().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    if (!this.clientVal) throw new Error("temporal connection failed");
    return this.clientVal;
  }

  // Lazy client for direct callers (panel readouts, schedules, updates).
  // null = unavailable right now; callers degrade (the gateway methods below
  // are the buffered path for fire-and-forget ops).
  async client(): Promise<Client | null> {
    try {
      const c = await this.ensureConnected();
      return c;
    } catch (e) {
      this.noteFailure(e, "client connect");
      return null;
    }
  }

  // Raw connection for the worker manager's gRPC calls (deployment promote).
  async connection(): Promise<Connection | null> {
    const c = await this.client();
    return c ? this.conn : null;
  }

  // ---- recovery ----

  private async recover(trigger: string): Promise<void> {
    try {
      await this.teardownConnection();
      await this.ensureConnected();
      await this.healthCheck();
      await this.ensureSearchAttributesOnce();
      const prev = this.stateVal;
      this.stateVal = "up";
      this.lastErrorMsg = null;
      if (prev === "up") return;
      const outageMs = this.downSinceMs != null ? Date.now() - this.downSinceMs : null;
      this.downSinceMs = null;
      this.overflowAnnounced = false;
      temporalLog.info("temporal.up", { "temporal.trigger": trigger, "temporal.outage_ms": outageMs ?? 0 });
      const { flushed, requeued, droppedDuringOutage } = await this.flushBuffer();
      for (const hook of this.recoveredHooks) {
        try {
          await hook();
        } catch (e) {
          temporalLog.error("temporal recovery hook failed", e);
        }
      }
      if (prev === "down") {
        void this.audit.log({
          title: "⏱️ Temporal recovered",
          severity: "success",
          description: `The Temporal server is reachable again. Buffered operations were flushed${
            requeued > 0 ? ", but some failed again and were re-buffered" : ""
          }.`,
          fields: [
            { name: "Flushed", value: String(flushed), inline: true },
            ...(requeued > 0 ? [{ name: "Re-buffered", value: String(requeued), inline: true }] : []),
            ...(droppedDuringOutage > 0 ? [{ name: "Dropped during outage", value: String(droppedDuringOutage), inline: true }] : []),
            ...(outageMs != null ? [{ name: "Outage", value: formatDurationMs(outageMs), inline: true }] : []),
          ],
        });
      }
    } catch (e) {
      this.noteFailure(e, trigger);
    }
  }

  private async flushBuffer(): Promise<{ flushed: number; requeued: number; droppedDuringOutage: number }> {
    const droppedDuringOutage = this.buffer.droppedTotal();
    const ops = this.buffer.drain();
    let flushed = 0;
    let requeued = 0;
    for (let i = 0; i < ops.length; i++) {
      try {
        await this.executeOp(ops[i]);
        flushed++;
      } catch (e) {
        if (e instanceof WorkflowExecutionAlreadyStartedError) {
          // Dedup by workflow id did its job — the op is effectively done.
          flushed++;
          continue;
        }
        // One failure means the server is likely gone again — re-buffer this
        // op and the rest in order, stop hammering, let the probe loop retry.
        ops[i].attempts++;
        for (let j = i; j < ops.length; j++) {
          this.buffer.push(ops[j]);
          requeued++;
        }
        this.noteFailure(e, "buffer flush");
        break;
      }
    }
    return { flushed, requeued, droppedDuringOutage };
  }

  private noteFailure(err: unknown, what: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.lastErrorMsg = msg;
    const prev = this.stateVal;
    if (prev === "down") {
      const now = Date.now();
      if (now - this.lastFailureLogAtMs > FAILURE_LOG_INTERVAL_MS) {
        this.lastFailureLogAtMs = now;
        temporalLog.warn("temporal.still_unreachable", { "temporal.what": what, "temporal.error": msg });
      }
      return;
    }
    this.stateVal = "down";
    if (this.downSinceMs == null) this.downSinceMs = Date.now();
    temporalLog.warn("temporal.down", { "temporal.what": what, "temporal.error": msg });
    Sentry.withScope((scope) => {
      scope.setFingerprint(["temporal-down"]);
      scope.setContext("temporal", { what, error: msg });
      Sentry.captureMessage("Temporal unreachable: buffering workflow operations", "warning");
    });
    // Transition embed only when we were actually up before (an unconfigured →
    // down flip at boot has no Discord client bound yet anyway).
    if (prev === "up") {
      void this.audit.log({
        title: "⏱️ Temporal unreachable",
        severity: "warn",
        description:
          "Workflow starts/signals are buffered in memory (bounded) until the server recovers. " +
          "Webhook deliveries are answered 503 so the sender redelivers. Timers inside running workflows " +
          "resume server-side on their own.",
        fields: [{ name: "Failure", value: msg.slice(0, 1024), inline: false }],
      });
    }
  }

  // ---- gateway (buffered fire-and-forget ops) ----

  async startWorkflow(req: StartRequest): Promise<GatewayResult> {
    return this.runOp({
      kind: "start",
      workflowType: req.workflowType,
      workflowId: req.workflowId,
      args: req.args ?? [],
      options: req.options,
      enqueuedAt: Date.now(),
      attempts: 0,
    });
  }

  async signalWorkflow(req: SignalRequest): Promise<GatewayResult> {
    return this.runOp({
      kind: "signal",
      workflowId: req.workflowId,
      signalName: req.signalName,
      args: [],
      signalArgs: req.signalArgs ?? [],
      enqueuedAt: Date.now(),
      attempts: 0,
    });
  }

  async signalWithStart(req: SignalWithStartRequest): Promise<GatewayResult> {
    return this.runOp({
      kind: "signalWithStart",
      workflowType: req.workflowType,
      workflowId: req.workflowId,
      signalName: req.signalName,
      args: req.args ?? [],
      signalArgs: req.signalArgs ?? [],
      options: req.options,
      enqueuedAt: Date.now(),
      attempts: 0,
    });
  }

  private async runOp(op: BufferedOp): Promise<GatewayResult> {
    if (this.stateVal === "unconfigured" && !this.configured()) {
      return { ok: false, buffered: false, error: this.configError() ?? "temporal not configured" };
    }
    try {
      await this.executeOp(op);
      // A successful real op while we thought we were down = early recovery.
      if (this.stateVal !== "up") void this.recover("op success");
      return { ok: true, buffered: false };
    } catch (e) {
      if (e instanceof WorkflowExecutionAlreadyStartedError) {
        return { ok: true, buffered: false, alreadyRunning: true };
      }
      this.noteFailure(e, `${op.kind} ${op.workflowType ?? op.signalName ?? ""}`.trim());
      const { dropped } = this.buffer.push(op);
      if (dropped && !this.overflowAnnounced) {
        this.overflowAnnounced = true;
        void this.audit.log({
          title: "⏱️ Temporal buffer overflow",
          severity: "warn",
          description:
            "The in-memory retry buffer is full. Oldest operations are being dropped. " +
            "Webhook-driven work will be redelivered by the sender; timer-driven work self-heals " +
            "from DB state after recovery.",
          fields: [{ name: "Capacity", value: String(this.buffer.capacityOf()), inline: true }],
        });
      }
      return { ok: false, buffered: true, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async executeOp(op: BufferedOp): Promise<void> {
    const client = await this.ensureConnected();
    switch (op.kind) {
      case "start":
        await client.workflow.start(op.workflowType!, {
          taskQueue: this.envConfig().taskQueue,
          workflowId: op.workflowId,
          args: op.args,
          ...(op.options ?? {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        return;
      case "signal": {
        const handle = client.workflow.getHandle(op.workflowId);
        await handle.signal(op.signalName!, ...(op.signalArgs ?? []));
        return;
      }
      case "signalWithStart":
        await client.workflow.signalWithStart(op.workflowType!, {
          taskQueue: this.envConfig().taskQueue,
          workflowId: op.workflowId,
          args: op.args,
          signal: op.signalName!,
          signalArgs: op.signalArgs ?? [],
          ...(op.options ?? {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        return;
    }
  }

  // ---- Test Connection (the /config button) ----

  // Layered like VaultService.testConnection so the report pinpoints the
  // broken layer: config → gRPC health → namespace → deployment → visibility.
  async testConnection(): Promise<TemporalTestReport> {
    const report: TemporalTestReport = {
      configured: false,
      configError: null,
      healthOk: false,
      healthError: null,
      namespaceOk: false,
      namespaceError: null,
      deploymentFound: false,
      currentVersion: null,
      deploymentError: null,
      visibilityOk: false,
      runningWorkflows: null,
      visibilityError: null,
      searchAttributesOk: false,
      searchAttributesDetail: null,
    };
    report.configError = this.configError();
    report.configured = report.configError == null;
    if (!report.configured) return report;
    let client: Client;
    try {
      client = await this.ensureConnected();
      await this.healthCheck();
      report.healthOk = true;
      if (this.stateVal !== "up") void this.recover("test connection");
    } catch (e) {
      report.healthError = e instanceof Error ? e.message : String(e);
      this.noteFailure(e, "test connection");
      return report;
    }
    const svc = this.conn!.workflowService;
    try {
      await svc.describeNamespace({ namespace: this.envConfig().namespace });
      report.namespaceOk = true;
    } catch (e) {
      report.namespaceError = e instanceof Error ? e.message : String(e);
    }
    try {
      const desc = await svc.describeWorkerDeployment({
        namespace: this.envConfig().namespace,
        deploymentName: this.envConfig().deploymentName,
      });
      report.deploymentFound = true;
      report.currentVersion =
        desc.workerDeploymentInfo?.routingConfig?.currentDeploymentVersion?.buildId ??
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((desc.workerDeploymentInfo?.routingConfig as any)?.currentVersion as string | undefined) ??
        null;
    } catch (e) {
      // NOT_FOUND before the first versioned worker ever polled is expected.
      report.deploymentError = e instanceof Error ? e.message : String(e);
    }
    try {
      const count = await svc.countWorkflowExecutions({
        namespace: this.envConfig().namespace,
        query: `ExecutionStatus="Running"`,
      });
      report.visibilityOk = true;
      report.runningWorkflows = Number(count.count ?? 0);
    } catch (e) {
      report.visibilityError = e instanceof Error ? e.message : String(e);
    }
    // Doubles as the repair action: re-runs the idempotent registration.
    const sa = await this.ensureSearchAttributesNow();
    report.searchAttributesOk = sa.ok;
    report.searchAttributesDetail = describeSaResult(sa);
    return report;
  }
}

function formatDurationMs(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return "under a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
