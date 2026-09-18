import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { classifyInvoiceDiscount, invoiceDiscountCount } from "../../bot/billing/moneyOutTaxonomy";

// Discounts are booked from the invoices that applied them.
//
// This replaces moneyOutDiscountPricing.test.ts, which guarded the previous
// model: ONE row per coupon, valued at a single billing cycle, stamped at the
// moment the coupon was attached. That model was wrong in a way no amount of
// careful pricing could fix — a 50%-off coupon running across thirty-six
// invoices was recorded as one month of value, and coupons that had already
// ended were unrecoverable because Stripe has no endpoint that lists them.
//
// An invoice states what was actually discounted and when, so these tests are
// about reading it faithfully rather than about estimating well.

const invoice = (p: {
  id?: string;
  currency?: string;
  created?: number;
  effectiveAt?: number | null;
  discounts: Array<{ amount: number; discount?: unknown }>;
}): Stripe.Invoice =>
  ({
    id: p.id ?? "in_1",
    currency: p.currency ?? "eur",
    customer: "cus_1",
    created: p.created ?? 1_700_000_000,
    effective_at: p.effectiveAt === undefined ? null : p.effectiveAt,
    total_discount_amounts: p.discounts.map((d) => ({
      amount: d.amount,
      discount: d.discount ?? "di_abc",
    })),
  }) as unknown as Stripe.Invoice;

test("books the amount the invoice actually discounted, at the invoice date", () => {
  const row = classifyInvoiceDiscount(invoice({ discounts: [{ amount: 1_250 }] }), 0, "backfill");
  assert.ok(row);
  assert.equal(row.amountMinor, 1_250);
  assert.equal(row.currency, "eur");
  assert.equal(row.category, "discount");
  assert.equal(row.kind, "CONCESSION");
  assert.equal(row.bucket, "CONCESSION");
  assert.equal(row.customerId, "cus_1");
  assert.equal(row.invoiceId, "in_1");
  assert.equal(row.occurredAt.getTime(), 1_700_000_000_000);
});

test("prefers effective_at over created for the date", () => {
  // An invoice finalised later than it was created should be booked when the
  // money was actually forgone.
  const row = classifyInvoiceDiscount(
    invoice({ created: 1_700_000_000, effectiveAt: 1_700_086_400, discounts: [{ amount: 500 }] }),
    0,
    "webhook"
  );
  assert.equal(row?.occurredAt.getTime(), 1_700_086_400_000);
});

test("one row per discount, with ids disjoint from every other key space", () => {
  const inv = invoice({ discounts: [{ amount: 100, discount: "di_a" }, { amount: 250, discount: "di_b" }] });
  assert.equal(invoiceDiscountCount(inv), 2);
  const ids = [0, 1].map((i) => classifyInvoiceDiscount(inv, i, "backfill")?.id);
  assert.deepEqual(ids, ["in_1:disc:di_a", "in_1:disc:di_b"]);

  // The ledger keys on txn_…, fee rows on txn_…:fee, credit notes on cn_…,
  // write-offs on the BARE invoice id, and the retired estimates on di_….
  // The ":disc:" infix is what keeps a discount row clear of the write-off for
  // the very same invoice.
  for (const id of ids) {
    assert.ok(id!.startsWith("in_"));
    assert.ok(id!.includes(":disc:"));
    assert.notEqual(id, "in_1");
  }
});

test("a zero or negative discount books nothing", () => {
  // Stripe lists an entry per applied discount; one worth nothing is not a
  // concession, and a row at 0 would read as "this cost us nothing" rather
  // than as absent.
  assert.equal(classifyInvoiceDiscount(invoice({ discounts: [{ amount: 0 }] }), 0, "backfill"), null);
  assert.equal(classifyInvoiceDiscount(invoice({ discounts: [{ amount: -5 }] }), 0, "backfill"), null);
});

test("an index past the end books nothing rather than throwing", () => {
  assert.equal(classifyInvoiceDiscount(invoice({ discounts: [] }), 0, "backfill"), null);
  assert.equal(classifyInvoiceDiscount(invoice({ discounts: [{ amount: 10 }] }), 5, "backfill"), null);
});

test("an unexpanded discount still books the money, losing only the label", () => {
  // The coupon backfill previously reported zero for an account full of coupons
  // because an expand failure was treated as "no discount". An expand can fail;
  // the amount is on the invoice either way, and only the NAME is lost.
  const bare = classifyInvoiceDiscount(invoice({ discounts: [{ amount: 900, discount: "di_xyz" }] }), 0, "backfill");
  assert.equal(bare?.amountMinor, 900);
  assert.equal(bare?.reason, "di_xyz");

  const expanded = classifyInvoiceDiscount(
    invoice({
      discounts: [{ amount: 900, discount: { id: "di_xyz", source: { coupon: { id: "c_1", name: "LAUNCH50" } } } }],
    }),
    0,
    "backfill"
  );
  assert.equal(expanded?.amountMinor, 900);
  assert.equal(expanded?.reason, "LAUNCH50");
  // Same id either way: a failed expand must not fork the key space, or the
  // two passes would book the same discount twice.
  assert.equal(expanded?.id, bare?.id);
});
