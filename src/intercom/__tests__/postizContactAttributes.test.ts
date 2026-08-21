import { test } from "node:test";
import assert from "node:assert/strict";
import { postizContactAttributes } from "../IntercomEventExecutor";
import type { EnsurePayload } from "../types";

// These land on the Intercom CONTACT, so they render in Intercom's own sidebar
// next to the Discord and Stripe ids. Intercom MERGES custom attributes, so an
// omitted key keeps whatever was there rather than blanking it — which is why
// unknown values are omitted instead of sent as null or "".

const payload = (over: Partial<EnsurePayload> = {}): EnsurePayload =>
  ({ customerId: "d1", customerDisplayName: "Someone", ...over }) as EnsurePayload;

test("an unresolved account contributes no attributes at all", () => {
  assert.deepEqual(postizContactAttributes(payload()), {});
  assert.deepEqual(postizContactAttributes(payload({ postizResolved: null })), {});
});

test("a resolved account maps to the three contact attributes", () => {
  const attrs = postizContactAttributes(
    payload({ postizResolved: { userId: "usr_1", orgId: "org_1", tier: "PRO", role: "ADMIN" } })
  );
  assert.deepEqual(attrs, { postiz_user_id: "usr_1", postiz_org_id: "org_1", postiz_plan: "PRO" });
});

test("a free organization omits the plan key rather than blanking it", () => {
  // Sending "" would overwrite a previously known plan with nothing.
  const attrs = postizContactAttributes(
    payload({ postizResolved: { userId: "usr_1", orgId: "org_1", tier: null, role: "USER" } })
  );
  assert.deepEqual(attrs, { postiz_user_id: "usr_1", postiz_org_id: "org_1" });
  assert.ok(!("postiz_plan" in attrs));
});

test("the user id is always present once resolved, even with nothing else known", () => {
  const attrs = postizContactAttributes(
    payload({ postizResolved: { userId: "usr_1", orgId: null, tier: null, role: null } })
  );
  assert.deepEqual(attrs, { postiz_user_id: "usr_1" });
});
