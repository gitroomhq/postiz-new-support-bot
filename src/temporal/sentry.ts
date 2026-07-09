import * as Sentry from "@sentry/node";
import { Context as ActivityContext } from "@temporalio/activity";
import { CancelledFailure } from "@temporalio/common";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import type { InjectedSinks } from "@temporalio/worker";
import { log } from "../util/logger";

const temporalLog = log.child("temporal");

// Sentry glue for the two Temporal execution contexts:
//  - Activities run on the main thread and can use @sentry/node directly —
//    an inbound interceptor tags + captures.
//  - Workflow code runs in the deterministic sandbox and cannot import
//    @sentry/node; a sink proxies serialized failure info out to this module
//    (registered via WorkerOptions.sinks, called from workflows/interceptors).

// Shape shared with src/temporal/workflows/interceptors.ts (kept structural on
// both sides — the workflow bundle cannot import Node-side modules).
import type { Sinks } from "@temporalio/workflow";
export interface SentrySinks extends Sinks {
  sentry: {
    captureWorkflowFailure(info: { workflowType: string; workflowId: string; runId: string; message: string; stack: string | null; type: string }): void;
  };
}

export const sentrySinks: InjectedSinks<SentrySinks> = {
  sentry: {
    captureWorkflowFailure: {
      fn(_workflowInfo, info) {
        Sentry.withScope((scope) => {
          scope.setTag("temporal.workflow_type", info.workflowType);
          scope.setTag("temporal.workflow_id", info.workflowId);
          scope.setTag("temporal.run_id", info.runId);
          scope.setFingerprint(["temporal-workflow-failure", info.workflowType, info.type]);
          const err = new Error(info.message);
          err.name = info.type || "WorkflowFailure";
          if (info.stack) err.stack = info.stack;
          Sentry.captureException(err);
        });
      },
      // Failure capture must not depend on replay determinism bookkeeping.
      callDuringReplay: false,
    },
  },
};

export const sentryActivityInterceptor: ActivityInterceptorsFactory = (ctx: ActivityContext) => ({
  inbound: {
    async execute(input, next) {
      try {
        return await next(input);
      } catch (e) {
        // Cancellations are control flow (shutdown, workflow cancel), not
        // errors; workflow-side retries also re-report — capture once here
        // with the attempt tagged so grouping stays sane.
        if (!(e instanceof CancelledFailure)) {
          Sentry.withScope((scope) => {
            scope.setTag("temporal.activity_type", ctx.info.activityType);
            scope.setTag("temporal.workflow_type", ctx.info.workflowType);
            scope.setTag("temporal.workflow_id", ctx.info.workflowExecution?.workflowId ?? "");
            scope.setTag("temporal.attempt", String(ctx.info.attempt));
            Sentry.captureException(e);
          });
        }
        throw e;
      }
    },
  },
});

// Routes the Rust-core / worker-internal logs through the app logger (which
// bridges warn/error to Sentry) instead of raw console output. Installed once
// before the first Worker.create.
export function makeTemporalRuntimeLogger() {
  return {
    log: (level: string, message: string) => route(level, message),
    trace: (message: string) => route("TRACE", message),
    debug: (message: string) => route("DEBUG", message),
    info: (message: string) => route("INFO", message),
    warn: (message: string) => route("WARN", message),
    error: (message: string) => route("ERROR", message),
  };
}

function route(level: string, message: string): void {
  switch (level) {
    case "ERROR":
      temporalLog.error(`core: ${message}`);
      return;
    case "WARN":
      temporalLog.warn(`core: ${message}`);
      return;
    default:
      // TRACE/DEBUG/INFO stay out of Sentry breadcrumb noise entirely.
      return;
  }
}
