import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFetch, SafeFetchError } from "../safeFetch";

// Assert a safeFetch call rejects with a SafeFetchError of the given reason.
async function expectReason(p: Promise<unknown>, reason: SafeFetchError["reason"]): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SafeFetchError, `expected SafeFetchError, got ${e}`);
    assert.equal(e.reason, reason);
    return true;
  });
}

function withMockFetch<T>(
  impl: (url: string, opts: RequestInit) => Promise<Response>,
  body: () => Promise<T>
): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  return body().finally(() => {
    globalThis.fetch = orig;
  });
}

test("rejects non-https scheme", async () => {
  await expectReason(safeFetch("http://169.254.169.254/latest/meta-data/", { allowHosts: ["169.254.169.254"] }), "scheme");
});

test("rejects a host that is not allowlisted", async () => {
  await expectReason(safeFetch("https://evil.example/x", { allowHosts: ["files.stripe.com"] }), "host");
});

test("rejects an allowlisted host that is a private IP literal (link-local metadata)", async () => {
  await expectReason(safeFetch("https://169.254.169.254/", { allowHosts: ["169.254.169.254"] }), "private_ip");
});

test("rejects an allowlisted hostname that resolves to a private address", async () => {
  // localhost resolves to 127.0.0.1 locally (no external DNS needed).
  await expectReason(safeFetch("https://localhost/x", { allowHosts: ["localhost"] }), "private_ip");
});

test("rejects a redirect whose target resolves to a private IP", async () => {
  await withMockFetch(
    async () =>
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }),
    async () => {
      // Both literals are allowlisted so the redirect passes the host check and
      // is caught by the private-IP guard instead.
      await expectReason(
        safeFetch("https://93.184.216.34/start", { allowHosts: ["93.184.216.34", "169.254.169.254"] }),
        "private_ip"
      );
    }
  );
});

test("rejects a redirect to a non-allowlisted host", async () => {
  await withMockFetch(
    async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    async () => {
      await expectReason(safeFetch("https://93.184.216.34/start", { allowHosts: ["93.184.216.34"] }), "host");
    }
  );
});

test("returns the response for an allowlisted public host and uses manual redirect", async () => {
  const captured: RequestInit[] = [];
  const res = await withMockFetch(
    async (_url, opts) => {
      captured.push(opts);
      return new Response("ok", { status: 200 });
    },
    () => safeFetch("https://93.184.216.34/file", { allowHosts: ["93.184.216.34"] })
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  assert.equal(captured[0].redirect, "manual");
});
