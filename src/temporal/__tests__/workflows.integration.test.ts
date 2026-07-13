import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

// Opt-in integration tests against Temporal's time-skipping test server
// (downloads a binary on first run — deliberately NOT part of `pnpm test`):
//   pnpm test:temporal
// They exercise the workflow logic with mocked activities: ticket timers,
// per-ticket Intercom FIFO with retries, delivery dead-letter, inbox defer.
const ENABLED = process.env.TEMPORAL_TEST === "1";

// Keeps this file compiling without the testing package types leaking into
// the normal build path.
type AnyRecord = Record<string, unknown>;

const baseSnapshot = {
  exists: true,
  closed: false,
  closedAtMs: null,
  statusTagId: "tag1",
  statusLabel: "Open",
  tagClosesThread: false,
  tagIsResolved: false,
  tagReminderEnabled: true,
  tagReminderDays: 3,
  tagReminderTarget: "SUPPORT",
  tagAutoCloseAfter: null,
  remindersPaused: false,
  reminderCount: 0,
  lastReminderAtMs: null,
  lastStatusChangeAtMs: 0,
  recloseAtMs: null,
  hasIntercomLink: true,
};

test("workflow suite (time-skipping)", { skip: !ENABLED && "set TEMPORAL_TEST=1 to run" }, async (t) => {
  // Imported lazily so plain `pnpm test` never touches the test server.
  const { TestWorkflowEnvironment } = await import("@temporalio/testing");
  const { Worker } = await import("@temporalio/worker");
  const { ApplicationFailure } = await import("@temporalio/common");

  const env = await TestWorkflowEnvironment.createTimeSkipping();
  t.after(async () => {
    await env.teardown();
  });

  const workflowsPath = path.join(__dirname, "..", "workflows");
  const taskQueue = "test";

  const makeWorker = (activities: AnyRecord) =>
    Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve(workflowsPath),
      activities,
    });

  await t.test("ticketWorkflow evaluates timers on the 30-minute scan and runs auto-close as a child", async () => {
    const calls: string[] = [];
    let checks = 0;
    const activities: AnyRecord = {
      loadTicketState: async () => ({ ...baseSnapshot }),
      intercomEnabled: async () => false,
      checkTicketTimers: async () => {
        checks++;
        calls.push("check");
        if (checks === 2) {
          // Second scan: pretend the reminder budget ran out → auto-close.
          return { statusChange: { tagId: "closing", actorName: "Automatic" }, reminded: false, reclosed: false, snapshot: { ...baseSnapshot } };
        }
        return { statusChange: null, reminded: checks === 1, reclosed: false, snapshot: { ...baseSnapshot } };
      },
      statusApplyDirect: async (input: { tagId: string }) => {
        calls.push(`status:${input.tagId}`);
        return { applied: true, closed: true, isResolved: false, closesThread: true, statusTagId: input.tagId, statusLabel: "Closed" };
      },
    };
    const worker = await makeWorker(activities);
    const run = worker.runUntil(async () => {
      const handle = await env.client.workflow.start("ticketWorkflow", {
        taskQueue,
        workflowId: "ticket-t1",
        args: [{ threadId: "t1" }],
      });
      // Two scan periods pass in skipped time; the workflow then has closed
      // state from the status child and eventually completes after retention.
      await env.sleep("70 minutes");
      assert.ok(calls.filter((c) => c === "check").length >= 2, `expected ≥2 timer checks, saw ${calls.join(",")}`);
      assert.ok(calls.includes("status:closing"), `expected auto-close child, saw ${calls.join(",")}`);
      await handle.terminate("test done");
    });
    await run;
  });

  await t.test("intercom pump delivers strictly in order and dead-letters after permanent failure", async () => {
    const delivered: string[] = [];
    const deadLettered: string[] = [];
    let failedOnce = false;
    const activities: AnyRecord = {
      loadTicketState: async () => ({ ...baseSnapshot }),
      intercomEnabled: async () => true,
      checkTicketTimers: async () => ({ statusChange: null, reminded: false, reclosed: false, snapshot: { ...baseSnapshot } }),
      executeIntercomEvent: async (input: { event: { type: string; payload: unknown } }) => {
        const tag = `${input.event.type}:${JSON.stringify(input.event.payload)}`;
        if (input.event.type === "note" && !failedOnce) {
          failedOnce = true;
          // transient failure → the delivery child retries with backoff
          throw ApplicationFailure.create({
            message: "boom 500",
            type: "IntercomHttpError",
            nonRetryable: true,
            details: [{ status: 500, retryAfterSeconds: null, permanent: false }],
          });
        }
        if (input.event.type === "csat") {
          throw ApplicationFailure.create({
            message: "422 nope",
            type: "IntercomHttpError",
            nonRetryable: true,
            details: [{ status: 422, retryAfterSeconds: null, permanent: true }],
          });
        }
        delivered.push(tag);
      },
      intercomDeadLetterAudit: async (input: { type: string }) => {
        deadLettered.push(input.type);
      },
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("ticketWorkflow", {
        taskQueue,
        workflowId: "ticket-t2",
        args: [{ threadId: "t2" }],
      });
      await handle.signal("intercomEnqueue", { type: "note", payload: 1 });
      await handle.signal("intercomEnqueue", { type: "message", payload: 2 });
      await handle.signal("intercomEnqueue", { type: "csat", payload: 3 });
      await handle.signal("intercomEnqueue", { type: "message", payload: 4 });
      await env.sleep("30 minutes");
      // FIFO despite the first event needing a retry; the permanent csat
      // failure dead-letters without blocking the tail.
      assert.deepEqual(delivered, ["note:1", "message:2", "message:4"]);
      assert.deepEqual(deadLettered, ["csat"]);
      await handle.terminate("test done");
    });
  });

  await t.test("intercomInboxWorkflow defers on DeferEcho and processes serially", async () => {
    const processed: Array<{ topic: string; deferAttempts: number }> = [];
    const activities: AnyRecord = {
      processInboundEvent: async (input: { topic: string; deferAttempts: number }) => {
        processed.push({ topic: input.topic, deferAttempts: input.deferAttempts });
        if (input.topic === "echoish" && input.deferAttempts < 2) {
          throw ApplicationFailure.create({ message: "defer", type: "DeferEcho", nonRetryable: true });
        }
      },
      inboundDeadLetterAudit: async () => {},
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.signalWithStart("intercomInboxWorkflow", {
        taskQueue,
        workflowId: "icx-c1",
        args: [{ conversationId: "c1" }],
        signal: "inboundEvent",
        signalArgs: [{ deliveryId: "d1", topic: "echoish", payload: {} }],
      });
      await handle.signal("inboundEvent", { deliveryId: "d1", topic: "echoish", payload: {} }); // dup → ring-dedup
      await handle.signal("inboundEvent", { deliveryId: "d2", topic: "reply", payload: {} });
      await env.sleep("5 minutes");
      const echoRuns = processed.filter((p) => p.topic === "echoish");
      assert.deepEqual(
        echoRuns.map((p) => p.deferAttempts),
        [0, 1, 2],
        "defer loop should retry with an incrementing defer counter"
      );
      assert.equal(processed.filter((p) => p.topic === "reply").length, 1, "duplicate deliveryId must be dropped");
      // idle 24h → the workflow completes on its own
      await env.sleep("25 hours");
      await handle.result();
    });
  });

  // ---- looper generation reconcile (terminate + restart on bump) ----

  await t.test("reconcileLooperGeneration keeps matching, terminates stale, reports absent", async () => {
    const { reconcileLooperGeneration } = await import("../looperGeneration");
    const activities: AnyRecord = { cleanupTick: async () => {} };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      // Fresh singleton stamped with generation 1.
      await env.client.workflow.signalWithStart("cleanupLoopWorkflow", {
        taskQueue,
        workflowId: "cleanup-loop-gen",
        signal: "noop",
        signalArgs: [],
        memo: { looperGen: 1 },
      });

      const kept = await reconcileLooperGeneration(env.client, "cleanup-loop-gen", 1);
      assert.equal(kept.action, "kept");
      assert.equal(kept.runningGen, 1);

      const bumped = await reconcileLooperGeneration(env.client, "cleanup-loop-gen", 2);
      assert.equal(bumped.action, "terminated");
      assert.equal(bumped.runningGen, 1);
      const desc = await env.client.workflow.getHandle("cleanup-loop-gen").describe();
      assert.equal(desc.status.name, "TERMINATED");

      // The follow-up signal-with-start (ensureBaseline's second half) brings
      // up a fresh run stamped with the new generation.
      await env.client.workflow.signalWithStart("cleanupLoopWorkflow", {
        taskQueue,
        workflowId: "cleanup-loop-gen",
        signal: "noop",
        signalArgs: [],
        memo: { looperGen: 2 },
      });
      const kept2 = await reconcileLooperGeneration(env.client, "cleanup-loop-gen", 2);
      assert.equal(kept2.action, "kept");
      assert.equal(kept2.runningGen, 2);

      const absent = await reconcileLooperGeneration(env.client, "never-started-looper", 1);
      assert.equal(absent.action, "absent");

      // Pre-mechanism runs carry no memo → generation 0 → one-time restart.
      await env.client.workflow.signalWithStart("cleanupLoopWorkflow", {
        taskQueue,
        workflowId: "cleanup-loop-nomemo",
        signal: "noop",
        signalArgs: [],
      });
      const legacyRun = await reconcileLooperGeneration(env.client, "cleanup-loop-nomemo", 1);
      assert.equal(legacyRun.action, "terminated");
      assert.equal(legacyRun.runningGen, 0);

      await env.client.workflow.getHandle("cleanup-loop-gen").terminate("test done").catch(() => {});
    });
  });

  // ---- agent-rip retirement (terminate retired singletons, idempotently) ----

  await t.test("retireWorkflowId terminates a running singleton and no-ops on re-run/absent", async () => {
    const { retireWorkflowId } = await import("../looperGeneration");
    const activities: AnyRecord = { cleanupTick: async () => {} };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      await env.client.workflow.signalWithStart("cleanupLoopWorkflow", {
        taskQueue,
        workflowId: "retired-loop",
        signal: "noop",
        signalArgs: [],
        memo: { looperGen: 1 },
      });

      const first = await retireWorkflowId(env.client, "retired-loop", "agent-rip test");
      assert.equal(first, true);
      const desc = await env.client.workflow.getHandle("retired-loop").describe();
      assert.equal(desc.status.name, "TERMINATED");

      // Idempotent: already-terminated and never-started ids are both no-ops.
      assert.equal(await retireWorkflowId(env.client, "retired-loop", "agent-rip test"), false);
      assert.equal(await retireWorkflowId(env.client, "never-started-retired", "agent-rip test"), false);
    });
  });
});
