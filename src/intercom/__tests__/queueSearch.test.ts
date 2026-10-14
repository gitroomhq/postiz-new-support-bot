import { test } from "node:test";
import assert from "node:assert/strict";
import { IntercomClient } from "../IntercomClient";

test("queue ticket search uses Intercom's request category and carries its pagination cursor", async (t) => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ tickets: [{ id: "1", category: "Customer" }], pages: { next: { starting_after: "next-page" } } }), { status: 200 });
  });
  const client = new IntercomClient({ intercomRegion: () => "us", intercomAccessToken: () => "fixture-token" } as never);
  const page = await client.searchOpenCustomerTicketsRaw("previous-page");
  assert.equal(calls[0].url, "https://api.intercom.io/tickets/search");
  const query = calls[0].body.query as { value: Array<{ field: string; value: unknown }> };
  assert.equal(query.value.find((q) => q.field === "category")?.value, "request");
  assert.equal(query.value.find((q) => q.field === "open")?.value, true);
  assert.deepEqual(calls[0].body.pagination, { per_page: 150, starting_after: "previous-page" });
  assert.equal(page.nextStartingAfter, "next-page");
  assert.equal(page.items.length, 1);
  await client.searchClosedUnresolvedTickets(123, "closed-page");
  const closedQuery = calls[1].body.query as { value: Array<{ field: string; value: unknown }> };
  assert.equal(closedQuery.value.find((q) => q.field === "category")?.value, "request");
  assert.equal(closedQuery.value.find((q) => q.field === "open")?.value, false);
  assert.equal(closedQuery.value.find((q) => q.field === "state")?.value, "resolved");
  assert.equal(closedQuery.value.find((q) => q.field === "updated_at")?.value, 123);
});
