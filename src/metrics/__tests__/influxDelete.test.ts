import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InfluxDeleteError,
  deleteMeasurements,
  initInflux,
  probeInfluxDelete,
  shutdownInflux,
} from "../InfluxWriter";

// The wipe is the one irreversible step in the analytics rebuild, and it has to
// fail LOUDLY. A delete that quietly did nothing, followed by a re-emit, leaves
// every point in the bucket counted twice — the exact failure the rebuild
// exists to remove.

const CFG = {
  enabled: true,
  url: "https://influx.example.com",
  org: "acme",
  bucket: "bot",
  token: "tok_secret",
};

type Captured = { url: string; init: RequestInit };

// Stubs global fetch, runs the body, and always restores. initInflux only
// constructs a client object, so nothing here touches the network.
async function withFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  body: (calls: Captured[]) => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  initInflux(CFG);
  try {
    await body(calls);
  } finally {
    globalThis.fetch = original;
    await shutdownInflux(0);
  }
}

const ok = () => new Response(null, { status: 204 });
const fail = (status: number, body = "") => new Response(body, { status });

test("posts the right url, auth and predicate", async () => {
  await withFetch(ok, async (calls) => {
    await deleteMeasurements(["money_out"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://influx.example.com/api/v2/delete?org=acme&bucket=bot");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Token tok_secret");
    const sent = JSON.parse(String(calls[0].init.body));
    assert.equal(sent.predicate, '_measurement="money_out"');
    assert.equal(sent.start, "1970-01-01T00:00:00.000Z");
    // The window ends in the FUTURE: a point written seconds ago by an in-flight
    // webhook must be inside it, not just past the edge.
    assert.ok(new Date(sent.stop).getTime() > Date.now());
  });
});

test("one call per measurement", async () => {
  await withFetch(ok, async (calls) => {
    await deleteMeasurements(["money_out", "dispute_outcomes", "ai_runs"]);
    assert.equal(calls.length, 3);
    const predicates = calls.map((c) => JSON.parse(String(c.init.body)).predicate);
    assert.deepEqual(predicates, [
      '_measurement="money_out"',
      '_measurement="dispute_outcomes"',
      '_measurement="ai_runs"',
    ]);
  });
});

test("a trailing slash on the configured url does not double up", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return ok();
  }) as typeof fetch;
  initInflux({ ...CFG, url: "https://influx.example.com///" });
  try {
    await deleteMeasurements(["money_out"]);
    assert.equal(calls[0], "https://influx.example.com/api/v2/delete?org=acme&bucket=bot");
  } finally {
    globalThis.fetch = original;
    await shutdownInflux(0);
  }
});

test("405 and 501 are reported as an unsupported deployment, not a retryable error", async () => {
  // InfluxDB Cloud Serverless has no delete endpoint. Retrying cannot help, and
  // continuing would double every number in the bucket, so the rebuild stops.
  for (const status of [405, 501]) {
    await withFetch(
      () => fail(status),
      async () => {
        const err = await deleteMeasurements(["money_out"]).catch((e) => e);
        assert.ok(err instanceof InfluxDeleteError);
        assert.equal(err.reason, "unsupported");
        assert.match(err.message, /Serverless|does not support/i);
        // The consequence has to be in the message: whoever reads this needs to
        // know why the run stopped rather than continuing.
        assert.match(err.message, /double-count/i);
      }
    );
  }
});

test("a body that says 'not implemented' is treated as unsupported too", async () => {
  await withFetch(
    () => fail(400, '{"code":"invalid","message":"delete is not implemented"}'),
    async () => {
      const err = await deleteMeasurements(["money_out"]).catch((e) => e);
      assert.equal((err as InfluxDeleteError).reason, "unsupported");
    }
  );
});

test("401 and 403 name the permission that is actually missing", async () => {
  for (const status of [401, 403]) {
    await withFetch(
      () => fail(status),
      async () => {
        const err = await deleteMeasurements(["money_out"]).catch((e) => e);
        assert.equal((err as InfluxDeleteError).reason, "unauthorized");
        // A delete needs bucket write access, which is broader than the write
        // endpoint the token is already proven to have — that is the confusing
        // part, so it is spelled out.
        assert.match((err as Error).message, /write access to the bucket/i);
      }
    );
  }
});

test("404 points at the org and bucket rather than the token", async () => {
  await withFetch(
    () => fail(404),
    async () => {
      const err = await deleteMeasurements(["money_out"]).catch((e) => e);
      assert.equal((err as InfluxDeleteError).reason, "http");
      assert.match((err as Error).message, /org "acme" or bucket "bot"/);
    }
  );
});

test("a network failure is distinguished from a rejection", async () => {
  await withFetch(
    () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      const err = await deleteMeasurements(["money_out"]).catch((e) => e);
      assert.equal((err as InfluxDeleteError).reason, "network");
    }
  );
});

test("the preflight probe is harmless and validates the whole path", async () => {
  // Deleting a measurement nothing writes is a 204 no-op, so this proves url,
  // org, bucket, token and endpoint support in one call — BEFORE the rebuild
  // spends an hour walking Stripe.
  await withFetch(ok, async (calls) => {
    await probeInfluxDelete();
    assert.equal(calls.length, 1);
    const sent = JSON.parse(String(calls[0].init.body));
    assert.equal(sent.predicate, '_measurement="analytics_rebuild_probe"');
    // A one-second window, not all of history: it must not be able to delete
    // anything real even if the name were ever reused.
    const span = new Date(sent.stop).getTime() - new Date(sent.start).getTime();
    assert.ok(span <= 2_000, `probe window was ${span}ms`);
  });
});

test("deleting with the exporter inactive refuses rather than pretending", async () => {
  await shutdownInflux(0);
  const err = await deleteMeasurements(["money_out"]).catch((e) => e);
  assert.equal((err as InfluxDeleteError).reason, "inactive");
});
