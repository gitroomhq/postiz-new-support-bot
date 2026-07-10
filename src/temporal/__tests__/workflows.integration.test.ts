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

  // ---- scoring loop + per-batch child workflows ----

  const scoringState = (over: AnyRecord = {}): AnyRecord => ({
    enabled: true,
    pendingBatchIds: [],
    due: false,
    backfill: false,
    escalationDue: false,
    escalationPendingCount: 0,
    ...over,
  });

  await t.test("scoringLoopWorkflow submits when due and watches the batch child to completion", async () => {
    let getStates = 0;
    let submits = 0;
    const polls: string[] = [];
    const activities: AnyRecord = {
      scoringGetState: async () => {
        getStates++;
        // Due exactly once; afterwards the (mock) run was recorded.
        return scoringState({ due: getStates === 1 });
      },
      scoringSubmit: async (purpose: string) => {
        submits++;
        assert.equal(purpose, "interval");
        return { batchId: "b1", submitted: 3, skipped: 0, drained: false, budgetBlocked: false };
      },
      scoringPollBatch: async (batchId: string) => {
        polls.push(batchId);
        return polls.length < 3 ? { status: "running", processingStatus: "in_progress" } : { status: "processed", processingStatus: "ended" };
      },
      scoringExpireBatch: async () => {},
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("scoringLoopWorkflow", {
        taskQueue,
        workflowId: "scoring-loop-t1",
      });
      await env.sleep("15 minutes");
      assert.equal(submits, 1, "exactly one submit for the single due tick");
      assert.deepEqual(polls, ["b1", "b1", "b1"], "child polls until the batch ends");
      assert.ok(getStates >= 3, `loop must keep ticking after the batch (${getStates} getStates)`);
      const child = env.client.workflow.getHandle("scoring-batch-b1");
      const desc = await child.describe();
      assert.equal(desc.status.name, "COMPLETED");
      await handle.terminate("test done");
    });
  });

  await t.test("scoringLoopWorkflow adopts pending batches sequentially before submitting", async () => {
    const order: string[] = [];
    const remaining = new Set(["a1", "a2"]);
    const activities: AnyRecord = {
      scoringGetState: async () => scoringState({ pendingBatchIds: [...remaining].sort() }),
      scoringSubmit: async () => {
        order.push("submit");
        return { batchId: null, submitted: 0, skipped: 0, drained: true, budgetBlocked: false };
      },
      scoringPollBatch: async (batchId: string) => {
        order.push(`poll:${batchId}`);
        remaining.delete(batchId);
        return { status: "processed", processingStatus: "ended" };
      },
      scoringExpireBatch: async () => {},
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("scoringLoopWorkflow", {
        taskQueue,
        workflowId: "scoring-loop-t2",
      });
      await env.sleep("10 minutes");
      assert.deepEqual(order.slice(0, 2), ["poll:a1", "poll:a2"], `adoption must be sequential, saw ${order.join(",")}`);
      assert.ok(!order.includes("submit"), "not due → no submit");
      await handle.terminate("test done");
    });
  });

  await t.test("scoringLoopWorkflow never wedges on a failing batch child", async () => {
    let getStates = 0;
    const activities: AnyRecord = {
      scoringGetState: async () => {
        getStates++;
        return scoringState({ pendingBatchIds: ["broken"] });
      },
      scoringSubmit: async () => ({ batchId: null, submitted: 0, skipped: 0, drained: false, budgetBlocked: false }),
      scoringPollBatch: async () => {
        throw ApplicationFailure.create({ message: "poll exploded", type: "Boom", nonRetryable: true });
      },
      scoringExpireBatch: async () => {},
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("scoringLoopWorkflow", {
        taskQueue,
        workflowId: "scoring-loop-t3",
      });
      await env.sleep("10 minutes");
      assert.ok(getStates >= 3, `loop must survive child failures and keep ticking (${getStates} getStates)`);
      const desc = await handle.describe();
      assert.equal(desc.status.name, "RUNNING");
      await handle.terminate("test done");
    });
  });

  await t.test("scoringRunNow forces a submit even when not due", async () => {
    let submits = 0;
    const activities: AnyRecord = {
      scoringGetState: async () => scoringState({ due: false }),
      scoringSubmit: async () => {
        submits++;
        return { batchId: null, submitted: 0, skipped: 0, drained: false, budgetBlocked: true };
      },
      scoringPollBatch: async () => ({ status: "processed", processingStatus: "ended" }),
      scoringExpireBatch: async () => {},
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("scoringLoopWorkflow", {
        taskQueue,
        workflowId: "scoring-loop-t4",
      });
      await env.sleep("3 minutes");
      assert.equal(submits, 0, "not due, no signal → no submit");
      await handle.signal("scoringRunNow");
      await env.sleep("3 minutes");
      assert.equal(submits, 1, "the run-now signal must force a submit");
      await handle.terminate("test done");
    });
  });

  await t.test("escalation submits when due but a due regular batch wins the shared tick", async () => {
    const submits: string[] = [];
    let getStates = 0;
    const activities: AnyRecord = {
      scoringGetState: async () => {
        getStates++;
        // Tick 1: regular AND escalation both due — regular must win; the
        // still-due escalation submits on the next tick.
        return scoringState({ due: getStates === 1, escalationDue: true, escalationPendingCount: 3 });
      },
      scoringSubmit: async (purpose: string) => {
        submits.push(purpose);
        return { batchId: null, submitted: 1, skipped: 0, drained: false, budgetBlocked: false };
      },
      scoringPollBatch: async () => ({ status: "processed", processingStatus: "ended" }),
      scoringExpireBatch: async () => {},
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("scoringLoopWorkflow", {
        taskQueue,
        workflowId: "scoring-loop-t5",
      });
      await env.sleep("3 minutes");
      assert.deepEqual(
        submits.slice(0, 2),
        ["interval", "escalation"],
        `regular batch wins the shared tick, escalation follows (saw ${submits.join(",")})`
      );
      await handle.terminate("test done");
    });
  });

  await t.test("scoringEscalationRunNow forces an escalation submit even when not due", async () => {
    const submits: string[] = [];
    const activities: AnyRecord = {
      scoringGetState: async () => scoringState(),
      scoringSubmit: async (purpose: string) => {
        submits.push(purpose);
        return { batchId: null, submitted: 0, skipped: 0, drained: true, budgetBlocked: false };
      },
      scoringPollBatch: async () => ({ status: "processed", processingStatus: "ended" }),
      scoringExpireBatch: async () => {},
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("scoringLoopWorkflow", {
        taskQueue,
        workflowId: "scoring-loop-t6",
      });
      await env.sleep("3 minutes");
      assert.equal(submits.length, 0, "nothing due, no signal → no submit");
      await handle.signal("scoringEscalationRunNow");
      await env.sleep("3 minutes");
      assert.deepEqual(submits, ["escalation"], "the escalation run-now signal must force an escalation submit");
      await handle.terminate("test done");
    });
  });

  await t.test("scoringBatchWorkflow fails a batch stuck past its deadline", async () => {
    let expired = 0;
    let pollCount = 0;
    const activities: AnyRecord = {
      scoringPollBatch: async () => {
        pollCount++;
        return { status: "running", processingStatus: "in_progress" };
      },
      scoringExpireBatch: async (batchId: string) => {
        assert.equal(batchId, "stuck");
        expired++;
      },
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      // Short explicit deadline (the input carry the CAN path also uses) so
      // the test doesn't need 1 560 real activity round-trips for 26h.
      // Anchored to the TEST SERVER's clock — earlier subtests already
      // skipped it days ahead of real time.
      const envNow = await env.currentTimeMs();
      const handle = await env.client.workflow.start("scoringBatchWorkflow", {
        taskQueue,
        workflowId: "scoring-batch-stuck",
        args: [{ batchId: "stuck", deadlineAtMs: envNow + 4 * 60_000 }],
      });
      const result = (await handle.result()) as { outcome: string; polls: number };
      assert.equal(result.outcome, "timeout");
      assert.equal(expired, 1, "the deadline path must fail the batch exactly once");
      assert.ok(result.polls >= 2 && result.polls === pollCount, `poll count carried correctly (${result.polls})`);
    });
  });

  await t.test("scoringBatchWorkflow surfaces a failed batch outcome", async () => {
    const activities: AnyRecord = {
      scoringPollBatch: async () => ({ status: "failed", processingStatus: null }),
      scoringExpireBatch: async () => {
        throw new Error("must not expire an already-failed batch");
      },
    };
    const worker = await makeWorker(activities);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("scoringBatchWorkflow", {
        taskQueue,
        workflowId: "scoring-batch-failed",
        args: [{ batchId: "bad" }],
      });
      const result = (await handle.result()) as { outcome: string; polls: number };
      assert.deepEqual(result, { outcome: "failed", polls: 1 });
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
});
