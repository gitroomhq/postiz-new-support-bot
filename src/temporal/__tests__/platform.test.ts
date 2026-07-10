import { test } from "node:test";
import assert from "node:assert/strict";
import { RetryBuffer, type BufferedOp } from "../RetryBuffer";
import { parseCertInfo, validateCertPair } from "../certs";
import { resolveBuildId, resetBuildIdCacheForTests, buildIdIsDegenerate } from "../buildId";
import {
  ticketWorkflowId,
  intercomDeliveryChildId,
  stripeEventWorkflowId,
  aiRunWorkflowId,
  scoringBatchWorkflowId,
  CUSTOM_SEARCH_ATTRIBUTES,
  LOOPER_GEN_MEMO_KEY,
  LOOPER_GENERATIONS,
  SINGLETONS,
} from "../types";
import { looperStartOptions } from "../looperGeneration";
import { ensureSearchAttributes, describeSaResult } from "../searchAttributes";
import { FIXTURE_CERT_PEM, FIXTURE_KEY_PEM } from "./certFixture";

const op = (id: string): BufferedOp => ({
  kind: "signal",
  workflowId: id,
  signalName: "noop",
  args: [],
  enqueuedAt: 0,
  attempts: 0,
});

test("RetryBuffer keeps FIFO order and drains everything", () => {
  const buf = new RetryBuffer(10);
  buf.push(op("a"));
  buf.push(op("b"));
  buf.push(op("c"));
  assert.equal(buf.size(), 3);
  const drained = buf.drain();
  assert.deepEqual(
    drained.map((o) => o.workflowId),
    ["a", "b", "c"]
  );
  assert.equal(buf.size(), 0);
  assert.equal(buf.droppedTotal(), 0);
});

test("RetryBuffer drops the OLDEST op on overflow and counts drops", () => {
  const buf = new RetryBuffer(2);
  assert.equal(buf.push(op("a")).dropped, null);
  assert.equal(buf.push(op("b")).dropped, null);
  const third = buf.push(op("c"));
  assert.equal(third.dropped?.workflowId, "a");
  assert.equal(buf.size(), 2);
  assert.equal(buf.droppedTotal(), 1);
  assert.deepEqual(
    buf.drain().map((o) => o.workflowId),
    ["b", "c"]
  );
});

test("parseCertInfo reads fingerprint/subject/expiry from the fixture", () => {
  const info = parseCertInfo(FIXTURE_CERT_PEM);
  assert.ok(info);
  assert.match(info!.subject, /support-bot-test-fixture/);
  assert.match(info!.fingerprint256, /^([0-9A-F]{2}:)+[0-9A-F]{2}$/i);
  assert.ok(info!.daysLeft > 0, "fixture must not be expired");
});

test("parseCertInfo returns null on garbage", () => {
  assert.equal(parseCertInfo("not a pem"), null);
});

test("validateCertPair accepts the fixture pair and rejects a bad key", () => {
  const info = validateCertPair(FIXTURE_CERT_PEM, FIXTURE_KEY_PEM, null);
  assert.match(info.subject, /support-bot-test-fixture/);
  assert.throws(() => validateCertPair(FIXTURE_CERT_PEM, "-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----", null), /private key/i);
  assert.throws(() => validateCertPair("nope", FIXTURE_KEY_PEM, null), /certificate/i);
});

test("resolveBuildId resolves (build stamp or git checkout) and memoizes", () => {
  resetBuildIdCacheForTests();
  const first = resolveBuildId();
  assert.ok(first.length >= 5, `expected a build id, got "${first}"`);
  assert.ok(!buildIdIsDegenerate(first), `built/test env must not resolve the degenerate fallback ("${first}")`);
  assert.equal(resolveBuildId(), first);
  resetBuildIdCacheForTests();
});

test("buildIdIsDegenerate flags package-version ids only", () => {
  assert.equal(buildIdIsDegenerate("1.0.0"), true);
  assert.equal(buildIdIsDegenerate("12.34.5"), true);
  assert.equal(buildIdIsDegenerate("unknown"), true);
  assert.equal(buildIdIsDegenerate("3f8c25"), false);
  assert.equal(buildIdIsDegenerate("d41d8c"), false);
});

test("workflow id scheme matches the documented shapes", () => {
  assert.equal(ticketWorkflowId("123"), "ticket-123");
  assert.equal(intercomDeliveryChildId("123", 7), "icd-123-7");
  assert.equal(stripeEventWorkflowId("evt_1"), "stripe-evt-evt_1");
  assert.equal(aiRunWorkflowId("42"), "ai-run-42");
  assert.equal(scoringBatchWorkflowId("msgbatch_1"), "scoring-batch-msgbatch_1");
});

test("every looper singleton has an integer generation ≥ 1", () => {
  for (const id of Object.values(SINGLETONS)) {
    const gen = LOOPER_GENERATIONS[id];
    assert.ok(Number.isInteger(gen) && gen >= 1, `missing/invalid generation for ${id}: ${gen}`);
  }
});

test("scoring-loop is pinned at generation 3 (the escalation-branch rework)", () => {
  // Regression pin: lowering this re-wedges any still-running gen-3 singleton.
  assert.equal(LOOPER_GENERATIONS[SINGLETONS.scoringLoop], 3);
});

test("looperStartOptions stamps the code generation into the memo", () => {
  const opts = looperStartOptions(SINGLETONS.scoringLoop);
  assert.deepEqual(opts, { memo: { [LOOPER_GEN_MEMO_KEY]: 3 } });
  assert.deepEqual(looperStartOptions("unknown-id"), { memo: { [LOOPER_GEN_MEMO_KEY]: 1 } });
});

test("custom search attribute keys are unique KEYWORDs with stable names", () => {
  const names = CUSTOM_SEARCH_ATTRIBUTES.map((k) => k.name);
  assert.deepEqual(names, ["ticketThreadId", "ticketStatus", "conversationId", "aiKind"]);
  assert.equal(new Set(names).size, names.length);
  for (const key of CUSTOM_SEARCH_ATTRIBUTES) assert.equal(key.type, "KEYWORD");
});

// ---- ensureSearchAttributes against a stubbed operator service ----

type SaConn = Parameters<typeof ensureSearchAttributes>[0];
const KEYWORD = 2; // temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD

const stubConn = (impl: {
  list: () => Promise<{ customAttributes?: Record<string, number> }>;
  add?: (req: { namespace: string; searchAttributes: Record<string, number> }) => Promise<unknown>;
}): SaConn =>
  ({
    operatorService: {
      listSearchAttributes: impl.list,
      addSearchAttributes: impl.add ?? (async () => ({})),
    },
  }) as unknown as SaConn;

const allRegistered = (): Record<string, number> =>
  Object.fromEntries(CUSTOM_SEARCH_ATTRIBUTES.map((k) => [k.name, KEYWORD]));

test("ensureSearchAttributes: everything already present → ok, nothing added", async () => {
  let added = false;
  const res = await ensureSearchAttributes(
    stubConn({
      list: async () => ({ customAttributes: allRegistered() }),
      add: async () => {
        added = true;
        return {};
      },
    }),
    "ns"
  );
  assert.equal(res.ok, true);
  assert.equal(added, false);
  assert.equal(res.present.length, CUSTOM_SEARCH_ATTRIBUTES.length);
  assert.deepEqual(res.added, []);
  assert.match(describeSaResult(res), /^ok \(4\)$/);
});

test("ensureSearchAttributes: missing subset is registered and verified", async () => {
  const server: Record<string, number> = { ticketThreadId: KEYWORD };
  const res = await ensureSearchAttributes(
    stubConn({
      list: async () => ({ customAttributes: { ...server } }),
      add: async (req) => {
        Object.assign(server, req.searchAttributes);
        return {};
      },
    }),
    "ns"
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.added.sort(), ["aiKind", "conversationId", "ticketStatus"]);
  assert.deepEqual(res.present, ["ticketThreadId"]);
});

test("ensureSearchAttributes: type mismatch is reported and never auto-fixed", async () => {
  const res = await ensureSearchAttributes(
    stubConn({
      list: async () => ({ customAttributes: { ...allRegistered(), ticketStatus: 3 /* INT */ } }),
      add: async () => {
        throw new Error("must not add on mismatch");
      },
    }),
    "ns"
  );
  assert.equal(res.ok, false);
  assert.deepEqual(res.mismatched, ["ticketStatus"]);
});

test("ensureSearchAttributes: ALREADY_EXISTS race from a concurrent registrar is success", async () => {
  const res = await ensureSearchAttributes(
    stubConn({
      list: async () => ({ customAttributes: allRegistered() /* the racer won */ }),
      add: async () => {
        throw new Error("search attribute ticketStatus already exists");
      },
    }),
    "ns"
  );
  assert.equal(res.ok, true);
});

test("ensureSearchAttributes: RPC failure never throws, reports error", async () => {
  const res = await ensureSearchAttributes(
    stubConn({
      list: async () => {
        throw new Error("PERMISSION_DENIED: operator API");
      },
    }),
    "ns"
  );
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /PERMISSION_DENIED/);
  assert.match(describeSaResult(res), /^error:/);
});
