import { test } from "node:test";
import assert from "node:assert/strict";
import { MoneyOutStore } from "../billing/MoneyOutStore";
import type { PrismaClient } from "../../generated/prisma/client";

// Regression guard for the bug that made the first production rebuild a no-op.
//
// The repair pass walks Stripe's balance transactions, and Stripe lists them
// NEWEST FIRST. The newest rows are exactly the ones the live sweep has already
// enriched. Enriching every row in page order therefore spends the entire run
// budget (20k Stripe lookups) on rows that did not need it, and the walk never
// reaches the history the rebuild exists to fix — while reporting success,
// because "we looked at 20,000 rows" and "we learned anything" were the same
// number.
//
// idsNeedingSegments is what breaks that: rows that already have a plan AND a
// card are skipped without spending a read.

function storeWith(
  rows: Array<{
    id: string;
    planTier: string | null;
    cardBrand: string | null;
    segmentsResolvedAt?: Date | null;
  }>
): MoneyOutStore {
  const prisma = {
    stripeMoneyOut: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        rows.filter((r) => where.id.in.includes(r.id)),
    },
  } as unknown as PrismaClient;
  return new MoneyOutStore(prisma);
}

test("a fully enriched row is skipped", async () => {
  const store = storeWith([{ id: "txn_new", planTier: "PRO", cardBrand: "visa" }]);
  const need = await store.idsNeedingSegments(["txn_new"]);
  assert.equal(need.has("txn_new"), false);
});

test("a row with null segments still needs them", async () => {
  const store = storeWith([{ id: "txn_old", planTier: null, cardBrand: null }]);
  const need = await store.idsNeedingSegments(["txn_old"]);
  assert.ok(need.has("txn_old"));
});

test("a HALF-enriched row still needs them", async () => {
  // A budget that ran out mid-row leaves a card but no plan. Treating that as
  // done would freeze the gap in permanently.
  const store = storeWith([
    { id: "txn_a", planTier: "PRO", cardBrand: null },
    { id: "txn_b", planTier: null, cardBrand: "visa" },
  ]);
  const need = await store.idsNeedingSegments(["txn_a", "txn_b"]);
  assert.ok(need.has("txn_a"));
  assert.ok(need.has("txn_b"));
});

test("an id the mirror has never seen needs them", async () => {
  // A brand-new row is not in the table yet, so it cannot be skipped.
  const store = storeWith([]);
  const need = await store.idsNeedingSegments(["txn_brand_new"]);
  assert.ok(need.has("txn_brand_new"));
});

test("the newest-first page shape: only the history is left to pay for", async () => {
  // The shape of a real repair page on an account whose recent rows are already
  // enriched. Before the fix every one of these consumed budget; now only the
  // three historical ones do, which is what lets a 20k budget actually reach
  // the history instead of dying in the first few thousand recent rows.
  const page = [
    { id: "txn_recent_1", planTier: "PRO", cardBrand: "visa" },
    { id: "txn_recent_2", planTier: "TEAM", cardBrand: "mastercard" },
    { id: "txn_recent_3", planTier: "PRO", cardBrand: "amex" },
    { id: "txn_hist_1", planTier: null, cardBrand: null },
    { id: "txn_hist_2", planTier: null, cardBrand: null },
    { id: "txn_hist_3", planTier: null, cardBrand: null },
  ];
  const store = storeWith(page);
  const need = await store.idsNeedingSegments(page.map((r) => r.id));
  assert.deepEqual([...need].sort(), ["txn_hist_1", "txn_hist_2", "txn_hist_3"]);
});

test("an empty page asks the database nothing", async () => {
  let called = false;
  const prisma = {
    stripeMoneyOut: {
      findMany: async () => {
        called = true;
        return [];
      },
    },
  } as unknown as PrismaClient;
  const need = await new MoneyOutStore(prisma).idsNeedingSegments([]);
  assert.equal(need.size, 0);
  assert.equal(called, false, "an empty page must not cost a query per page");
});

// ---- resumability: the bug that would have made "just run it again" a lie ----

test("a row whose budget ran out is retried, not written off", () => {
  // This is the failure the first production run left behind. When the lookup
  // budget is exhausted the resolver returns the literal string "unknown" for
  // every axis. Those strings are truthy, so a naive "has a plan and a card"
  // check reads them as enriched and skips the row on every future run — the
  // gap becomes permanent and no amount of re-running fixes it.
  //
  // segmentsResolvedAt is what distinguishes "we looked and the answer is
  // unknown" from "we never got to look".
  const store = storeWith([
    { id: "txn_budget_ran_out", planTier: "unknown", cardBrand: "unknown", segmentsResolvedAt: null },
  ]);
  return store.idsNeedingSegments(["txn_budget_ran_out"]).then((need) => {
    assert.ok(need.has("txn_budget_ran_out"), "a row nobody actually looked at must be retried");
  });
});

test("a row that WAS looked at and is genuinely unknown is not retried", async () => {
  // A one-off charge with no subscription resolves to "unknown" legitimately.
  // Retrying it every run would burn budget forever on an answer that will
  // never change.
  const store = storeWith([
    { id: "txn_really_unknown", planTier: "unknown", cardBrand: "unknown", segmentsResolvedAt: new Date() },
  ]);
  const need = await store.idsNeedingSegments(["txn_really_unknown"]);
  assert.equal(need.has("txn_really_unknown"), false);
});

test("legacy rows enriched before the marker existed are still skipped", async () => {
  // Rows from before segmentsResolvedAt was added have a real plan and card but
  // no marker. Re-resolving all of them would waste the budget the history
  // needs.
  const store = storeWith([{ id: "txn_legacy", planTier: "PRO", cardBrand: "visa", segmentsResolvedAt: null }]);
  const need = await store.idsNeedingSegments(["txn_legacy"]);
  assert.equal(need.has("txn_legacy"), false);
});
