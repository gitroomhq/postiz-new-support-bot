import { test } from "node:test";
import assert from "node:assert/strict";
import { PostizOrgLinkStore } from "../PostizOrgLinkStore";
import type { PrismaClient } from "../../generated/prisma/client";

// The organization to Stripe customer mapping is learned by observation, so
// the rules about what gets recorded matter more than the storage itself.

function harness() {
  const calls: Array<{ where: unknown; create: unknown; update: unknown }> = [];
  const prisma = {
    postizOrgLink: {
      async upsert(args: { where: unknown; create: unknown; update: unknown }) {
        calls.push(args);
      },
    },
  } as unknown as PrismaClient;
  return { store: new PostizOrgLinkStore(prisma), calls };
}

test("record: stores a well-formed pair keyed on the organization", async () => {
  const h = harness();
  await h.store.record("org_1", "cus_123");
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].where, { orgId: "org_1" });
});

test("record: refuses anything that is not a real Stripe customer id", async () => {
  const h = harness();
  // The platform stores a user id in paymentId for legacy non-Stripe
  // subscriptions, so a value without the cus_ prefix is not a customer.
  await h.store.record("org_1", "usr_legacy");
  await h.store.record("org_1", "");
  await h.store.record("", "cus_123");
  assert.equal(h.calls.length, 0);
});

test("recordIdentity: only records when the event carried BOTH halves", async () => {
  const h = harness();
  // Frontend events carry the org but never the Stripe customer.
  await h.store.recordIdentity({ orgId: "org_1", stripeCustomerId: null });
  await h.store.recordIdentity({ orgId: null, stripeCustomerId: "cus_123" });
  await h.store.recordIdentity({ orgId: null, stripeCustomerId: null });
  assert.equal(h.calls.length, 0);

  await h.store.recordIdentity({ orgId: "org_1", stripeCustomerId: "cus_123" });
  assert.equal(h.calls.length, 1);
});

test("record: a re-observation bumps the counter instead of duplicating", async () => {
  const h = harness();
  await h.store.record("org_1", "cus_123");
  const update = h.calls[0].update as { observations: unknown; stripeCustomerId: string };
  assert.deepEqual(update.observations, { increment: 1 });
  // A changed customer overwrites: the newer event is the more current truth.
  assert.equal(update.stripeCustomerId, "cus_123");
});
