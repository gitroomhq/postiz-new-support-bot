import { test } from "node:test";
import assert from "node:assert/strict";
import { SentryFeedbackStore } from "../SentryFeedbackStore";

test("minute polls do not exhaust a failed import's retry budget during an outage", async (t) => {
  let now = new Date("2026-10-13T19:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  let row: { status: string; attempts: number; importedAt: Date } | null = null;
  const store = new SentryFeedbackStore({
    sentryFeedbackImport: {
      async upsert(input: {
        create: { status: string; attempts: number; importedAt: Date };
        update: { attempts: { increment: number }; importedAt: Date };
      }) {
        row = row
          ? { ...row, attempts: row.attempts + input.update.attempts.increment, importedAt: input.update.importedAt }
          : input.create;
      },
      async findMany(input: { where: { status: string; attempts: { lt: number }; importedAt: { lte: Date } } }) {
        return row && row.status === input.where.status && row.attempts < input.where.attempts.lt
          && row.importedAt <= input.where.importedAt.lte ? [row] : [];
      },
    },
  } as never);
  const failure = {
    sentryIssueId: "123", sentryShortId: "CLOUD-283", projectSlug: "cloud",
    feedbackAt: now, error: "Intercom temporarily unavailable",
  };
  await store.recordFailure(failure);
  assert.deepEqual(await store.listFailedForRetry(25), [], "no second attempt in the same tick");
  for (let minute = 1; minute < 15; minute++) {
    now = new Date(failure.feedbackAt.getTime() + minute * 60_000);
    t.mock.timers.setTime(now.getTime());
    assert.deepEqual(await store.listFailedForRetry(25), [], "each minute poll respects the cooldown");
  }
  now = new Date(failure.feedbackAt.getTime() + 15 * 60_000);
  t.mock.timers.setTime(now.getTime());
  assert.equal((await store.listFailedForRetry(25)).length, 1);
  await store.recordFailure(failure);
  assert.deepEqual(await store.listFailedForRetry(25), [], "a repeated failure renews the cooldown");
  now = new Date(failure.feedbackAt.getTime() + 30 * 60_000);
  t.mock.timers.setTime(now.getTime());
  assert.equal((await store.listFailedForRetry(25)).length, 1);
  for (let minute = 30; minute <= 60; minute += 15) {
    now = new Date(failure.feedbackAt.getTime() + minute * 60_000);
    t.mock.timers.setTime(now.getTime());
    assert.equal((await store.listFailedForRetry(25)).length, 1);
    await store.recordFailure(failure);
  }
  now = new Date(failure.feedbackAt.getTime() + 75 * 60_000);
  t.mock.timers.setTime(now.getTime());
  assert.deepEqual(await store.listFailedForRetry(25), [], "five failed attempts park the item");
});
