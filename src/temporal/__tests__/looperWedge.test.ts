import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@temporalio/client";
import { describeLooper, reconcileLooperGeneration } from "../looperGeneration";
import { LOOPER_GEN_MEMO_KEY } from "../types";

const MINUTES = 60_000;

// Minimal DescribeWorkflowExecution stand-in: status + memo + the pending
// workflow task, which is the only part the wedge check reads.
function makeClient(opts: {
  status?: string;
  gen?: number | null;
  taskAttempt?: number;
  taskAgeMs?: number;
}): { client: Client; terminated: string[] } {
  const terminated: string[] = [];
  const client = {
    workflow: {
      getHandle: () => ({
        describe: async () => {
          return {
            status: { name: opts.status ?? "RUNNING" },
            memo: opts.gen == null ? {} : { [LOOPER_GEN_MEMO_KEY]: opts.gen },
            raw:
              opts.taskAttempt == null
                ? {}
                : {
                    pendingWorkflowTask: {
                      attempt: opts.taskAttempt,
                      scheduledTime: {
                        seconds: Math.floor((Date.now() - (opts.taskAgeMs ?? 0)) / 1000),
                      },
                    },
                  },
          };
        },
        terminate: async (reason: string) => {
          terminated.push(reason);
        },
      }),
    },
  } as unknown as Client;
  return { client, terminated };
}

test("a looper asleep on its timer has no pending task and is not wedged", async () => {
  const { client } = makeClient({ gen: 1 });
  const health = await describeLooper(client, "sentry-feedback-sync");
  assert.equal(health.status, "RUNNING");
  assert.equal(health.taskAttempt, 0);
  assert.equal(health.wedged, false);
});

test("a briefly retrying workflow task is not a wedge", async () => {
  // Both halves of the check matter: a task can legitimately be on attempt 6
  // seconds after a worker restart, and can sit at attempt 1 for a while.
  const young = makeClient({ gen: 1, taskAttempt: 9, taskAgeMs: 10_000 });
  assert.equal((await describeLooper(young.client, "id")).wedged, false);

  const patient = makeClient({ gen: 1, taskAttempt: 1, taskAgeMs: 60 * MINUTES });
  assert.equal((await describeLooper(patient.client, "id")).wedged, false);
});

test("a task failing for minutes is a wedge and gets terminated at boot", async () => {
  const { client, terminated } = makeClient({ gen: 1, taskAttempt: 41, taskAgeMs: 30 * MINUTES });
  const health = await describeLooper(client, "id");
  assert.equal(health.wedged, true);

  const r = await reconcileLooperGeneration(client, "sentry-feedback-sync", 1);
  assert.equal(r.action, "terminated");
  assert.equal(r.cause, "wedged");
  assert.equal(r.health.taskAttempt, 41);
  assert.match(terminated[0], /wedged: workflow task attempt 41/);
});

test("a generation bump still wins over the wedge check, and reports as such", async () => {
  const { client, terminated } = makeClient({ gen: 1, taskAttempt: 41, taskAgeMs: 30 * MINUTES });
  const r = await reconcileLooperGeneration(client, "sentry-feedback-sync", 2);
  assert.equal(r.cause, "generation");
  assert.deepEqual(terminated, ["looper generation 1 -> 2"]);
});

test("a healthy matching generation is kept untouched", async () => {
  const { client, terminated } = makeClient({ gen: 2 });
  const r = await reconcileLooperGeneration(client, "sentry-feedback-sync", 2);
  assert.equal(r.action, "kept");
  assert.equal(r.cause, null);
  assert.deepEqual(terminated, []);
});

test("a protobuf Long timestamp is read like a number", async () => {
  // int64 fields arrive as Long objects, not numbers: the seconds value has to
  // survive that or every task looks freshly scheduled and nothing is ever
  // detected as wedged.
  const seconds = Math.floor((Date.now() - 30 * MINUTES) / 1000);
  const longish = { low: 0, high: 0, unsigned: false, toString: () => String(seconds) };
  const client = {
    workflow: {
      getHandle: () => ({
        describe: async () => ({
          status: { name: "RUNNING" },
          memo: {},
          raw: { pendingWorkflowTask: { attempt: 41, scheduledTime: { seconds: longish } } },
        }),
      }),
    },
  } as unknown as Client;
  const health = await describeLooper(client, "id");
  assert.equal(health.taskScheduledAt?.getTime(), seconds * 1000);
  assert.equal(health.wedged, true);
});

test("a closed run is absent: signal-with-start re-creates it, no terminate", async () => {
  const { client, terminated } = makeClient({ status: "TERMINATED", gen: 1, taskAttempt: 41, taskAgeMs: 30 * MINUTES });
  const r = await reconcileLooperGeneration(client, "sentry-feedback-sync", 2);
  assert.equal(r.action, "absent");
  assert.equal(r.health.wedged, false, "a closed run cannot be wedged");
  assert.deepEqual(terminated, []);
});
