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

test("queue reads: created_at slices, catch-up since a time, and single-item gets", async (t) => {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/conversations/404")) return new Response(JSON.stringify({ errors: [{ message: "not found" }] }), { status: 404 });
    return new Response(JSON.stringify({ conversations: [{ id: "1" }], tickets: [{ id: "2" }], id: "3" }), { status: 200 });
  });
  const client = new IntercomClient({ intercomRegion: () => "eu", intercomAccessToken: () => "fixture-token" } as never);
  type Q = { field?: string; operator: string; value: unknown };
  const filters = (i: number) => (calls[i].body!.query as { value: Q[] }).value;

  assert.equal((await client.searchOpenConversationsRaw(null, { after: 1000, before: 2000 })).items.length, 1);
  assert.equal(calls[0].url, "https://api.eu.intercom.io/conversations/search");
  assert.deepEqual(filters(0), [
    { field: "open", operator: "=", value: true },
    { field: "created_at", operator: ">", value: 999 },
    { field: "created_at", operator: "<", value: 2000 },
  ]);
  await client.searchOpenConversationsRaw("c1");
  assert.deepEqual(calls[1].body!.query, { field: "open", operator: "=", value: true }, "no slice: the plain query");
  assert.deepEqual(calls[1].body!.pagination, { per_page: 150, starting_after: "c1" });
  await client.searchOpenCustomerTicketsRaw(null, { before: 500 });
  assert.deepEqual(filters(2).map((f) => f.field), ["open", "category", "created_at"]);

  await client.searchConversationsUpdatedRaw(1234);
  assert.deepEqual(calls[3].body!.query, { field: "updated_at", operator: ">", value: 1234 });
  const tickets = await client.searchCustomerTicketsUpdatedRaw(1234, "t1");
  assert.deepEqual(tickets.items, [{ id: "2" }]);
  assert.deepEqual(filters(4), [
    { field: "category", operator: "=", value: "request" },
    { field: "updated_at", operator: ">", value: 1234 },
  ]);

  assert.deepEqual(await client.getTicketRaw("7"), { conversations: [{ id: "1" }], tickets: [{ id: "2" }], id: "3" });
  assert.equal(calls[5].url, "https://api.eu.intercom.io/tickets/7");
  assert.equal(calls[5].method, "GET");
  assert.equal(await client.getConversationRaw("404"), null, "gone");
});
