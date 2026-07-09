import {
  ContinueAsNew,
  isCancellation,
  proxySinks,
  workflowInfo,
  type Next,
  type Sinks,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptorsFactory,
} from "@temporalio/workflow";

// Workflow code is sandboxed and cannot import @sentry/node — failures are
// proxied out through a sink (implemented main-thread in src/temporal/sentry.ts).
// Kept structural: this must stay in sync with SentrySinks over there.

interface SentrySinks extends Sinks {
  sentry: {
    captureWorkflowFailure(info: {
      workflowType: string;
      workflowId: string;
      runId: string;
      message: string;
      stack: string | null;
      type: string;
    }): void;
  };
}

const sinks = proxySinks<SentrySinks>();

class SentryWorkflowInterceptor implements WorkflowInboundCallsInterceptor {
  async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, "execute">): Promise<unknown> {
    try {
      return await next(input);
    } catch (e) {
      // Continue-As-New and cancellation are control flow, not failures.
      if (!(e instanceof ContinueAsNew) && !isCancellation(e)) {
        const info = workflowInfo();
        sinks.sentry.captureWorkflowFailure({
          workflowType: info.workflowType,
          workflowId: info.workflowId,
          runId: info.runId,
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? (e.stack ?? null) : null,
          type: e instanceof Error ? e.name : "WorkflowFailure",
        });
      }
      throw e;
    }
  }
}

export const interceptors: WorkflowInterceptorsFactory = () => ({
  inbound: [new SentryWorkflowInterceptor()],
});
