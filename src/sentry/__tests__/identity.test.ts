import { test } from "node:test";
import assert from "node:assert/strict";
import { extractIdentity, readTag, IDENTITY_TAGS } from "../SentryFeedbackClient";

// The platform ships the acting identity in two different shapes depending on
// release: as indexed tags, or in the event's `user` block via Sentry.setUser.
// Both are in flight at once, so these cover each shape and the mix.

test("readTag: handles the array shape Sentry returns and a plain object", () => {
  assert.equal(readTag([{ key: "user.id", value: "u1" }], "user.id"), "u1");
  assert.equal(readTag({ "user.id": "u1" }, "user.id"), "u1");
  assert.equal(readTag([{ key: "user.id", value: "  u1  " }], "user.id"), "u1");
  assert.equal(readTag([{ key: "other", value: "x" }], "user.id"), null);
  assert.equal(readTag(undefined, "user.id"), null);
  // An empty tag value is absence, not an identity of "".
  assert.equal(readTag([{ key: "user.id", value: "   " }], "user.id"), null);
});

test("identity: reads the tag shape, including the backend-only stripe customer", () => {
  const id = extractIdentity([
    { key: IDENTITY_TAGS.userId, value: "usr_1" },
    { key: IDENTITY_TAGS.email, value: "a@example.com" },
    { key: IDENTITY_TAGS.orgId, value: "org_1" },
    { key: IDENTITY_TAGS.stripeCustomerId, value: "cus_123" },
  ]);
  assert.deepEqual(id, {
    userId: "usr_1",
    email: "a@example.com",
    orgId: "org_1",
    stripeCustomerId: "cus_123",
  });
});

test("identity: falls back to the user context when no identity tags are present", () => {
  const id = extractIdentity([{ key: IDENTITY_TAGS.orgId, value: "org_1" }], {
    id: "usr_2",
    email: "b@example.com",
  });
  assert.equal(id.userId, "usr_2");
  assert.equal(id.email, "b@example.com");
  assert.equal(id.orgId, "org_1");
  // Frontend events never carry it, and there is no user-context equivalent.
  assert.equal(id.stripeCustomerId, null);
});

test("identity: tags win over the user context when both are present", () => {
  const id = extractIdentity(
    [
      { key: IDENTITY_TAGS.userId, value: "from-tag" },
      { key: IDENTITY_TAGS.email, value: "tag@example.com" },
    ],
    { id: "from-context", email: "context@example.com" }
  );
  assert.equal(id.userId, "from-tag");
  assert.equal(id.email, "tag@example.com");
});

test("identity: a numeric user id from the context is stringified", () => {
  assert.equal(extractIdentity(undefined, { id: 42 as unknown as number }).userId, "42");
});

test("identity: an anonymous event yields all nulls", () => {
  assert.deepEqual(extractIdentity(undefined, null), {
    userId: null,
    email: null,
    orgId: null,
    stripeCustomerId: null,
  });
});
