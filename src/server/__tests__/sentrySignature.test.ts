import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sentrySignatureMatches } from "../CallbackServer";

const SECRET = "shhh-integration-client-secret";
const sign = (raw: Buffer, secret = SECRET) => createHmac("sha256", secret).update(raw).digest("hex");

test("accepts a valid hex HMAC-SHA256 signature", () => {
  const raw = Buffer.from(JSON.stringify({ action: "created", data: {} }));
  assert.equal(sentrySignatureMatches(raw, SECRET, sign(raw)), true);
});

test("accepts uppercase and padded signature headers", () => {
  const raw = Buffer.from("{}");
  assert.equal(sentrySignatureMatches(raw, SECRET, ` ${sign(raw).toUpperCase()} `), true);
});

test("rejects a signature made with the wrong secret", () => {
  const raw = Buffer.from("{}");
  assert.equal(sentrySignatureMatches(raw, SECRET, sign(raw, "wrong")), false);
});

test("rejects when the body was tampered after signing", () => {
  const raw = Buffer.from('{"a":1}');
  const sig = sign(raw);
  assert.equal(sentrySignatureMatches(Buffer.from('{"a":2}'), SECRET, sig), false);
});

test("rejects garbage and empty headers without throwing", () => {
  const raw = Buffer.from("{}");
  assert.equal(sentrySignatureMatches(raw, SECRET, ""), false);
  assert.equal(sentrySignatureMatches(raw, SECRET, "not-hex-at-all"), false);
});
