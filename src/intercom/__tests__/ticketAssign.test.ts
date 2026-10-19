import { test } from "node:test";
import assert from "node:assert/strict";
import { IntercomClient } from "../IntercomClient";

// Assigning a ticket to the assignee it already has answers 422 "already
// assigned": for an assignee-only write that is the desired end state (the
// assignment mirror and the Sentry feedback import logged it as a failure).

const alreadyAssigned = () =>
  new Response(JSON.stringify({ errors: [{ message: "The conversation is already assigned to the specified assignee" }] }), { status: 422 });

test("an assignee-only ticket write to the current assignee is a success", async (t) => {
  t.mock.method(globalThis, "fetch", async () => alreadyAssigned());
  const client = new IntercomClient({ intercomRegion: () => "us", intercomAccessToken: () => "fixture-token" } as never);
  assert.deepEqual(await client.updateTicket("215476454849986", { assigneeId: "11006242", adminId: "11005726" }), { open: null });
});

test("the same 422 still fails a write that changes anything else", async (t) => {
  t.mock.method(globalThis, "fetch", async () => alreadyAssigned());
  const client = new IntercomClient({ intercomRegion: () => "us", intercomAccessToken: () => "fixture-token" } as never);
  await assert.rejects(client.updateTicket("1", { assigneeId: "2", stateId: "4" }), /already assigned/);
  await assert.rejects(client.updateTicket("1", { assigneeId: "2", attributes: { "SLA Target": "x" } }), /already assigned/);
  await assert.rejects(client.updateTicket("1", { assigneeId: "2", open: false }), /already assigned/);
});

test("other ticket write errors are not swallowed", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ errors: [{ message: "Assignee not found" }] }), { status: 422 }));
  const client = new IntercomClient({ intercomRegion: () => "us", intercomAccessToken: () => "fixture-token" } as never);
  await assert.rejects(client.updateTicket("1", { assigneeId: "2" }), /Assignee not found/);
});
