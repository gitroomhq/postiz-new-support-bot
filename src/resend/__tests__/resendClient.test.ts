import { test } from "node:test";
import assert from "node:assert/strict";
import { ResendClient, ResendHttpError, parseResendDate } from "../ResendClient";
import { redactSecrets } from "../../util/logger";

// A scripted fetch: each call takes the next response and records what was
// asked, so a test can pin the URL, the method and the headers Resend demands.
function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
    const next = responses.shift() ?? { status: 500, body: { name: "application_error" } };
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const settings = (key: string | null = "re_test_key") => ({ resendApiKey: () => key }) as never;

const SUPPRESSED = {
  object: "suppression",
  id: "e169aa45-1ecf-4183-9955-b1499d5701d3",
  email: "a+b@example.com",
  origin: "bounce",
  source_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
  created_at: "2026-10-06 23:47:56.678+00",
};

test("resend client: a suppressed address comes back parsed, with the headers Resend requires", async () => {
  const f = fakeFetch([{ status: 200, body: SUPPRESSED }]);
  const client = new ResendClient(settings(), f.impl);
  const s = await client.getSuppression(" A+B@Example.com ");
  assert.equal(s?.origin, "bounce");
  assert.equal(s?.sourceId, SUPPRESSED.source_id);
  assert.equal(s?.createdAt?.toISOString(), "2026-10-06T23:47:56.678Z");
  assert.equal(f.calls[0].url, "https://api.resend.com/suppressions/a%2Bb%40example.com", "lowercased and encoded");
  assert.equal(f.calls[0].headers.Authorization, "Bearer re_test_key");
  assert.ok(f.calls[0].headers["User-Agent"], "Resend answers 403 without a User-Agent");
});

test("resend client: 404 is 'not suppressed', tried lowercased and then as typed, and cached", async () => {
  const f = fakeFetch([{ status: 404, body: { name: "not_found" } }, { status: 404, body: { name: "not_found" } }]);
  const client = new ResendClient(settings(), f.impl);
  assert.equal(await client.getSuppression("Mixed@Example.com"), null);
  assert.deepEqual(
    f.calls.map((c) => c.url.split("/").pop()),
    ["mixed%40example.com", "Mixed%40Example.com"]
  );
  assert.equal(await client.getSuppression("mixed@example.com"), null);
  assert.equal(f.calls.length, 2, "the second lookup is served from the cache");
});

test("resend client: removal clears the cache, and a 404 on delete means it was not there", async () => {
  const f = fakeFetch([
    { status: 200, body: SUPPRESSED },
    { status: 200, body: { object: "suppression", id: SUPPRESSED.id, deleted: true } },
    { status: 404, body: { name: "not_found" } },
    { status: 404, body: { name: "not_found" } },
  ]);
  const client = new ResendClient(settings(), f.impl);
  assert.ok(await client.getSuppression("a+b@example.com"));
  assert.equal(await client.removeSuppression("a+b@example.com"), true);
  assert.equal(f.calls[1].method, "DELETE");
  assert.equal(await client.getSuppression("a+b@example.com"), null, "re-read after the removal, not the stale cache");
  const g = fakeFetch([{ status: 404, body: { name: "not_found" } }]);
  assert.equal(await new ResendClient(settings(), g.impl).removeSuppression("x@example.com"), false);
});

test("resend client: a rate limit surfaces as a typed error with the retry hint", async () => {
  const f = fakeFetch([{ status: 429, body: { name: "rate_limit_exceeded", message: "Too many requests" }, headers: { "retry-after": "2" } }]);
  await assert.rejects(
    () => new ResendClient(settings(), f.impl).getSuppression("x@example.com"),
    (e: unknown) => e instanceof ResendHttpError && e.status === 429 && e.retryAfterSeconds === 2 && e.code === "rate_limit_exceeded"
  );
});

test("resend client: the self-test names a sending-only key, and lists the team's domains for a full one", async () => {
  const sending = fakeFetch([{ status: 401, body: { name: "restricted_api_key", message: "This API key is restricted" } }]);
  const r1 = await new ResendClient(settings(), sending.impl).selfTest();
  assert.equal(r1.ok, false);
  assert.match(r1.detail, /can only send email/);

  const full = fakeFetch([
    { status: 200, body: { object: "list", has_more: false, data: [] } },
    { status: 200, body: { data: [{ name: "postiz.com", status: "verified" }, { name: "mail.postiz.com", status: "pending" }] } },
  ]);
  const r2 = await new ResendClient(settings(), full.impl).selfTest();
  assert.equal(r2.ok, true);
  assert.match(r2.detail, /postiz\.com, mail\.postiz\.com \(pending\)/);

  const none = await new ResendClient(settings(null), fakeFetch([]).impl).selfTest();
  assert.equal(none.ok, false);
  assert.match(none.detail, /RESEND_API_KEY/);
});

test("resend dates: the space and the hour-only offset are normalised", () => {
  assert.equal(parseResendDate("2026-10-06 23:47:56.678+00")?.toISOString(), "2026-10-06T23:47:56.678Z");
  assert.equal(parseResendDate("2026-11-17T19:32:22.980Z")?.toISOString(), "2026-11-17T19:32:22.980Z");
  assert.equal(parseResendDate("not a date"), null);
  assert.equal(parseResendDate(null), null);
});

test("log redaction: a Resend key is scrubbed, a Stripe refund id is not", () => {
  const key = "re_Abc12345_9xYzQwErTyUiOpAsDfGh";
  assert.equal(redactSecrets(`auth failed for ${key}`), "auth failed for [redacted]");
  assert.equal(redactSecrets("refund re_3PqRsTuVwXyZ0123456789ab created"), "refund re_3PqRsTuVwXyZ0123456789ab created");
});
