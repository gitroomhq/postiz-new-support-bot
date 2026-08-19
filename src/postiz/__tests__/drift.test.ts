import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { PostizDriftService } from "../PostizDriftService";
import type { PostizIdentityService } from "../PostizIdentityService";
import type { PostizOrgLinkStore } from "../PostizOrgLinkStore";
import { POSTIZ_TIERS } from "../../bot/billing/postizPlan";

// Drift = the customer pays for one tier and the platform put them on another.
// Distinct from the Stripe-side "unsynced" case, which postizSyncStatus already
// caught: there the metadata contradicts the price, here it looks perfect.

const priceFor = (tier: keyof typeof POSTIZ_TIERS) => ({
  currency: "usd",
  unit_amount: POSTIZ_TIERS[tier].month,
  recurring: { interval: "month", interval_count: 1 },
});

const sub = (tier: keyof typeof POSTIZ_TIERS, over: Record<string, unknown> = {}) =>
  ({
    status: "active",
    metadata: { service: "gitroom", billing: tier, period: "MONTHLY", uniqueId: "ABC1234567" },
    items: { data: [{ price: priceFor(tier) }] },
    ...over,
  }) as unknown as Stripe.Subscription;

const customer = { id: "cus_1", email: "a@example.com" } as Stripe.Customer;

function harness(opts: { tier?: string | null; account?: boolean; orgs?: string[]; throws?: boolean } = {}) {
  const resolved: string[] = [];
  const identity = {
    async resolve(term: string) {
      resolved.push(term);
      if (opts.throws) throw new Error("platform down");
      if (opts.account === false) return null;
      return { userId: "usr_1", orgId: "org_1", tier: opts.tier === undefined ? "PRO" : opts.tier, role: "ADMIN", email: "a@example.com", name: null, membershipId: "uo_1" };
    },
  } as unknown as PostizIdentityService;
  const orgLinks = {
    async orgsForCustomer() {
      return (opts.orgs ?? []).map((orgId) => ({ orgId, lastSeenAt: new Date() }));
    },
  } as unknown as PostizOrgLinkStore;
  return { service: new PostizDriftService(identity, orgLinks), resolved };
}

test("in sync when the platform tier matches what the price charges", async () => {
  const h = harness({ tier: "PRO" });
  const r = await h.service.check(sub("PRO"), customer);
  assert.equal(r.verdict, "in_sync");
  assert.equal(r.stripeTier, "PRO");
  assert.equal(r.platformTier, "PRO");
});

test("drift when the platform has the organization on a different tier", async () => {
  const h = harness({ tier: "STANDARD" });
  const r = await h.service.check(sub("PRO"), customer);
  assert.equal(r.verdict, "drifted");
  assert.equal(r.stripeTier, "PRO");
  assert.equal(r.platformTier, "STANDARD");
  assert.match(r.detail, /PRO.*STANDARD/);
});

test("drift when Stripe is charging but the organization has no plan at all", async () => {
  // The most consequential case: the paid plan never landed on the platform.
  const h = harness({ tier: null });
  const r = await h.service.check(sub("TEAM"), customer);
  assert.equal(r.verdict, "drifted");
  assert.match(r.detail, /no plan on the platform/);
});

test("tier comparison is case-insensitive", async () => {
  const h = harness({ tier: "pro" });
  assert.equal((await h.service.check(sub("PRO"), customer)).verdict, "in_sync");
});

test("a Stripe-side sync problem is reported as such, not as drift", async () => {
  const h = harness({ tier: "PRO" });

  // No gitroom metadata: the platform drops every event for this subscription.
  const missing = await h.service.check(sub("PRO", { metadata: {} }), customer);
  assert.equal(missing.verdict, "stripe_unsynced");
  assert.match(missing.detail, /no gitroom metadata/);

  // Metadata that contradicts the price it charges.
  const mismatched = await h.service.check(
    sub("PRO", { metadata: { service: "gitroom", billing: "TEAM", period: "MONTHLY", uniqueId: "ABC1234567" } }),
    customer
  );
  assert.equal(mismatched.verdict, "stripe_unsynced");
  // The platform is never consulted for a case Stripe alone can settle.
  assert.equal(h.resolved.length, 0);
});

test("unanswerable cases are unknown rather than a false drift claim", async () => {
  assert.equal((await harness().service.check(sub("PRO", { status: "canceled" }), customer)).verdict, "unknown");
  assert.equal((await harness({ account: false }).service.check(sub("PRO"), customer)).verdict, "unknown");
  // A platform outage must never be read as "the tiers disagree".
  assert.equal((await harness({ throws: true }).service.check(sub("PRO"), customer)).verdict, "unknown");

  const nonCanonical = sub("PRO", {
    items: { data: [{ price: { currency: "usd", unit_amount: 1234, recurring: { interval: "month", interval_count: 1 } } }] },
  });
  assert.equal((await harness().service.check(nonCanonical, customer)).verdict, "stripe_unsynced");
});

test("the harvested organization link is preferred over the fuzzy email match", async () => {
  const h = harness({ tier: "PRO", orgs: ["org_harvested"] });
  await h.service.check(sub("PRO"), customer);
  // An exact org id beats an email that several accounts could share.
  assert.deepEqual(h.resolved, ["org_harvested"]);
});

test("falls back to the customer email when no organization link was harvested", async () => {
  const h = harness({ tier: "PRO", orgs: [] });
  await h.service.check(sub("PRO"), customer);
  assert.deepEqual(h.resolved, ["a@example.com"]);
});
