import { test } from "node:test";
import assert from "node:assert/strict";
import { RetryBuffer, type BufferedOp } from "../RetryBuffer";
import { parseCertInfo, validateCertPair } from "../certs";
import { resolveBuildId, resetBuildIdCacheForTests } from "../buildId";
import {
  ticketWorkflowId,
  intercomDeliveryChildId,
  stripeEventWorkflowId,
  aiRunWorkflowId,
} from "../types";
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

test("resolveBuildId resolves (git checkout or fallback) and memoizes", () => {
  resetBuildIdCacheForTests();
  const first = resolveBuildId();
  assert.ok(first.length >= 5, `expected a build id, got "${first}"`);
  assert.equal(resolveBuildId(), first);
  resetBuildIdCacheForTests();
});

test("workflow id scheme matches the documented shapes", () => {
  assert.equal(ticketWorkflowId("123"), "ticket-123");
  assert.equal(intercomDeliveryChildId("123", 7), "icd-123-7");
  assert.equal(stripeEventWorkflowId("evt_1"), "stripe-evt-evt_1");
  assert.equal(aiRunWorkflowId("42"), "ai-run-42");
});
