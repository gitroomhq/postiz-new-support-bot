import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { NativeConnection, Runtime, Worker, DefaultLogger, type LogEntry } from "@temporalio/worker";
import { log } from "../util/logger";
import type { TemporalService } from "./TemporalService";
import { makeTemporalRuntimeLogger, sentryActivityInterceptor, sentrySinks } from "./sentry";

const workerLog = log.child("temporal:worker");

// Owns the worker lifecycle + Worker Deployment Versioning: registers this
// build (deployment name + 6-char git SHA) and auto-promotes it to the
// deployment's Current Version once the first poll registered it server-side
// (the user's auto-deploy requirement). Re-deploying an old SHA re-promotes
// that version — that IS the rollback story.

const PROMOTE_ATTEMPTS = 30;
const PROMOTE_BACKOFF_MS = 2_000;

// Shared-process safety caps (SDK defaults: 100 / 40). These bound how many
// tasks execute SIMULTANEOUSLY — open workflows are unlimited; excess tasks
// just queue server-side for moments. The Discord bot, Prisma pool and
// Anthropic/Discord HTTP clients share this event loop; the sizing case is a
// post-outage burst of ticket timer-scans (3-6 Discord REST calls each) —
// 25 keeps discord.js's rate-limit queue and the heap bounded while a few
// hundred backlogged scans still drain in about a minute. Bump via deploy.
const MAX_CONCURRENT_ACTIVITIES = 25;
const MAX_CONCURRENT_WORKFLOW_TASKS = 20;

let runtimeInstalled = false;

export class TemporalWorkerManager {
  private worker: Worker | null = null;
  private nativeConn: NativeConnection | null = null;
  private runPromise: Promise<void> | null = null;
  private promotedVal: boolean | null = null;
  private stopping = false;

  constructor(
    private temporal: TemporalService,
    private buildId: string
  ) {}

  running(): boolean {
    return this.worker != null && this.runPromise != null;
  }

  deploymentVersion(): { deploymentName: string; buildId: string } {
    return { deploymentName: this.temporal.envConfig().deploymentName, buildId: this.buildId };
  }

  // null = promote not attempted yet / worker not running.
  promoted(): boolean | null {
    return this.promotedVal;
  }

  async start(activities: Record<string, unknown>): Promise<void> {
    if (this.worker) return;
    const cfg = this.temporal.envConfig();
    const tls = this.temporal.tlsMaterial();
    if (!tls) throw new Error(this.temporal.configError() ?? "temporal mTLS material unavailable");
    this.stopping = false;
    this.promotedVal = null;

    if (!runtimeInstalled) {
      // Route Rust-core logs through the app logger instead of raw console.
      // Runtime.install may only ever run once per process.
      Runtime.install({
        logger: new DefaultLogger("WARN", (entry: LogEntry) => {
          makeTemporalRuntimeLogger()[entry.level === "ERROR" ? "error" : "warn"](String(entry.message));
        }),
      });
      runtimeInstalled = true;
    }

    this.nativeConn = await NativeConnection.connect({
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
    });

    const codeOpt = workflowCodeOption();
    this.worker = await Worker.create({
      connection: this.nativeConn,
      namespace: cfg.namespace,
      taskQueue: cfg.taskQueue,
      ...codeOpt,
      activities,
      sinks: sentrySinks,
      interceptors: {
        activity: [sentryActivityInterceptor],
        // With a prebuilt bundle the workflow interceptors are baked in at
        // bundle time (see scripts/bundleWorkflows.ts); the dev fallback path
        // registers them here instead.
        ...("workflowsPath" in codeOpt ? { workflowModules: [require.resolve("./workflows/interceptors")] } : {}),
      },
      workerDeploymentOptions: {
        useWorkerVersioning: true,
        version: { deploymentName: cfg.deploymentName, buildId: this.buildId },
        defaultVersioningBehavior: "AUTO_UPGRADE",
      },
      // Combined-process memory hygiene: the Discord bot shares this heap.
      maxCachedWorkflows: 100,
      reuseV8Context: true,
      maxConcurrentActivityTaskExecutions: MAX_CONCURRENT_ACTIVITIES,
      maxConcurrentWorkflowTaskExecutions: MAX_CONCURRENT_WORKFLOW_TASKS,
    });

    // worker.run() resolves only on shutdown; trap errors so a worker crash
    // degrades (logged + state visible in the panel) instead of killing boot.
    this.runPromise = this.worker
      .run()
      .catch((e) => {
        if (!this.stopping) workerLog.error("temporal worker crashed", e);
      })
      .finally(() => {
        this.worker = null;
        this.runPromise = null;
      });

    workerLog.info("temporal worker started", {
      "temporal.task_queue": cfg.taskQueue,
      "temporal.deployment": cfg.deploymentName,
      "temporal.build_id": this.buildId,
    });

    // Auto-promote in the background — the version only exists server-side
    // after the first poll, hence the retry loop. Failure is a warning, not
    // fatal: the worker still polls, and the panel shows the drift.
    void this.promoteCurrentVersion();
  }

  async shutdown(timeoutMs = 15_000): Promise<void> {
    const worker = this.worker;
    const run = this.runPromise;
    this.stopping = true;
    if (worker) {
      try {
        worker.shutdown();
      } catch {
        // never started polling / already shut down
      }
    }
    if (run) {
      await Promise.race([run, new Promise((r) => setTimeout(r, timeoutMs))]);
    }
    if (this.nativeConn) {
      try {
        await this.nativeConn.close();
      } catch {
        // already closed
      }
      this.nativeConn = null;
    }
    this.worker = null;
    this.runPromise = null;
  }

  // Set this build as the deployment's Current Version via the raw gRPC
  // service (there is no high-level TS API for worker deployments yet).
  // Idempotent: promoting the already-current version is a no-op server-side.
  private async promoteCurrentVersion(): Promise<void> {
    const cfg = this.temporal.envConfig();
    for (let attempt = 1; attempt <= PROMOTE_ATTEMPTS; attempt++) {
      if (this.stopping) return;
      try {
        const conn = await this.temporal.connection();
        if (!conn) throw new Error("temporal client connection unavailable");
        const svc = conn.workflowService;
        const desc = await svc.describeWorkerDeployment({
          namespace: cfg.namespace,
          deploymentName: cfg.deploymentName,
        });
        const current =
          desc.workerDeploymentInfo?.routingConfig?.currentDeploymentVersion?.buildId ??
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((desc.workerDeploymentInfo?.routingConfig as any)?.currentVersion as string | undefined) ??
          null;
        if (current === this.buildId || current === `${cfg.deploymentName}.${this.buildId}`) {
          this.promotedVal = true;
          return;
        }
        await svc.setWorkerDeploymentCurrentVersion({
          namespace: cfg.namespace,
          deploymentName: cfg.deploymentName,
          buildId: this.buildId,
          conflictToken: desc.conflictToken ?? undefined,
          identity: `support-bot@${os.hostname()}`,
        });
        this.promotedVal = true;
        workerLog.info("temporal deployment version promoted to current", {
          "temporal.deployment": cfg.deploymentName,
          "temporal.build_id": this.buildId,
        });
        return;
      } catch (e) {
        // NOT_FOUND until the first poll registers the version; stale
        // conflictToken → FAILED_PRECONDITION → refetch next attempt.
        if (attempt === PROMOTE_ATTEMPTS) {
          this.promotedVal = false;
          workerLog.warn("temporal deployment auto-promote failed — worker still polls, panel shows drift", {
            "temporal.error": e instanceof Error ? e.message : String(e),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, PROMOTE_BACKOFF_MS));
      }
    }
  }
}

// Prod runs the build-time webpack bundle (dist/temporal/workflow-bundle.js,
// produced by src/scripts/bundleWorkflows.ts); dev under ts-node falls back to
// runtime bundling from the workflows folder.
function workflowCodeOption(): { workflowBundle: { codePath: string } } | { workflowsPath: string } {
  const bundlePath = path.join(__dirname, "workflow-bundle.js");
  if (fs.existsSync(bundlePath)) {
    return { workflowBundle: { codePath: bundlePath } };
  }
  return { workflowsPath: require.resolve("./workflows") };
}
