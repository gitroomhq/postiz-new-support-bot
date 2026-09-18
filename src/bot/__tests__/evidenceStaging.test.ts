import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { EvidencePackBuilder, type EvidencePack } from "../billing/evidence/EvidencePackBuilder";
import { confirmedOrgFor, type PostizOrgLookup, type PostizOrgSummary } from "../../postiz/PostizIdentityService";

// Two defects that showed up in production on one dispute: a history timeline
// of two dozen identical hourly entries, and a provenance line claiming the
// platform account was used on a dispute whose account link cannot be proven.

// ---- staging the same text twice ----

function stageHarness(currentEvidence: Record<string, string>) {
  const calls: string[] = [];
  const builder = new EvidencePackBuilder(
    {} as never,
    {} as never,
    {} as never,
    {
      recordAutoPack: async () => {
        calls.push("recordAutoPack");
      },
    } as never,
    {
      stageFields: async () => {
        calls.push("stageFields");
      },
    } as never,
    {} as never,
    null,
    null,
    {
      record: async (e: { kind: string }) => {
        calls.push(`event:${e.kind}`);
      },
    } as never
  );
  const dispute = { id: "dp_1", reason: "subscription_canceled", evidence: currentEvidence } as unknown as Stripe.Dispute;
  const pack = {
    reason: "general",
    fields: { product_description: "The subscription renewed as disclosed.", customer_name: "Ada" },
    rendered: [],
    score: 0,
    templateVersion: "2026-09-17.1",
    facts: {},
  } as unknown as EvidencePack;
  return { builder, dispute, pack, calls };
}

test("staging: identical text is not re-staged, so the timeline does not fill with hourly duplicates", async () => {
  // The looper rebuilds every hour to catch facts that arrive late. The
  // templates are deterministic, so an untouched dispute rebuilds byte for byte
  // and would otherwise collect a Stripe write, a history entry and a build
  // metric every hour until its deadline.
  const h = stageHarness({
    product_description: "The subscription renewed as disclosed.",
    customer_name: "Ada",
  });
  const result = await h.builder.stage(h.dispute, h.pack, false);
  assert.equal(result.unchanged, true);
  assert.deepEqual(h.calls, [], "nothing written, and above all no pack_staged entry");
  // The score still comes back, because the caller goes on to decide about
  // submitting and needs to know how strong what IS staged is.
  assert.equal(typeof result.pack.score, "number");
  assert.deepEqual(result.staged, ["product_description", "customer_name"]);
});

test("staging: a single changed field is a real restage, and so is a first one", async () => {
  const changed = stageHarness({
    product_description: "The subscription renewed as disclosed.",
    customer_name: "Someone else",
  });
  const res = await changed.builder.stage(changed.dispute, changed.pack, false);
  assert.equal(res.unchanged, false);
  assert.deepEqual(changed.calls, ["stageFields", "recordAutoPack", "event:pack_staged"]);

  const first = stageHarness({});
  const firstRes = await first.builder.stage(first.dispute, first.pack, false);
  assert.equal(firstRes.unchanged, false);
  assert.ok(first.calls.includes("event:pack_staged"), "the first staging is always worth recording");
});

// ---- whose organisation is it ----

const org = (over: Partial<PostizOrgSummary> = {}): PostizOrgSummary =>
  ({
    orgId: "org_1",
    orgName: "Acme",
    tier: "PRO",
    paymentId: "cus_me",
    orgDeleted: false,
    customerMatches: true,
    ownerProvider: "google",
    ownerActivated: true,
    subPeriod: "MONTHLY",
    ...over,
  }) as PostizOrgSummary;

const lookup = (orgs: PostizOrgSummary[], state: PostizOrgLookup["state"] = "found"): PostizOrgLookup => ({
  state,
  orgs,
  via: "customer",
});

test("org gate: a search hit that is not provably this customer licenses no claim", () => {
  // "found" only says the search returned rows. The list is sorted to put a
  // confirmed match first, so orgs[0] on its own is a preference, and a
  // preference stated to a bank as fact is how a whole response gets thrown out.
  assert.equal(confirmedOrgFor(lookup([org({ customerMatches: false, paymentId: "cus_someone_else" })])), null);

  // A platform too old to echo the payment id back cannot confirm anything
  // either, and "probably" is not a thing evidence may say.
  assert.equal(confirmedOrgFor(lookup([org({ customerMatches: null, paymentId: null })])), null);

  // Nor does a deleted organisation describe a live account.
  assert.equal(confirmedOrgFor(lookup([org({ orgDeleted: true })])), null);
});

test("org gate: a proven match is used, and is picked out of a crowd of near-misses", () => {
  const confirmed = confirmedOrgFor(
    lookup([
      org({ orgId: "org_other", customerMatches: false, paymentId: "cus_someone_else" }),
      org({ orgId: "org_null", customerMatches: null, paymentId: null }),
      org({ orgId: "org_mine" }),
    ])
  );
  assert.equal(confirmed?.orgId, "org_mine");
});

test("org gate: every non-found state answers with nothing", () => {
  for (const state of ["off", "none", "timeout", "error"] as const) {
    assert.equal(confirmedOrgFor(lookup([org()], state)), null, state);
  }
});
