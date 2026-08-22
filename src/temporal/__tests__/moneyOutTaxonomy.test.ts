import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import {
  ALL_CATEGORIES,
  BUCKET_OF,
  countsAsLoss,
  LOSS_BUCKETS,
  categoryOfBalanceTransaction,
  classifyBalanceConcession,
  classifyBalanceTransaction,
  classifyCreditNote,
  classifyDiscount,
  classifyWriteOff,
} from "../../bot/billing/moneyOutTaxonomy";

// Minimal fabricators — only the fields the classifier reads. Amounts follow
// Stripe's own convention (outflows are negative), which is exactly the thing
// the classifier has to invert, so the tests must not "helpfully" pre-flip it.
const bt = (p: {
  id?: string;
  type: string;
  amount: number;
  fee?: number;
  reporting?: string;
  created?: number;
  source?: unknown;
  description?: string | null;
}): Stripe.BalanceTransaction =>
  ({
    id: p.id ?? "txn_1",
    object: "balance_transaction",
    type: p.type,
    amount: p.amount,
    fee: p.fee ?? 0,
    net: p.amount - (p.fee ?? 0),
    currency: "usd",
    created: p.created ?? 1_700_000_000,
    reporting_category: p.reporting ?? p.type,
    description: p.description ?? null,
    source: p.source ?? null,
  }) as unknown as Stripe.BalanceTransaction;

test("every category maps to exactly one bucket and the bucket map is total", () => {
  for (const c of ALL_CATEGORIES) {
    assert.ok(BUCKET_OF[c], `${c} has no bucket`);
  }
  assert.equal(new Set(ALL_CATEGORIES).size, ALL_CATEGORIES.length, "duplicate category");
  assert.deepEqual(
    ALL_CATEGORIES.filter((c) => BUCKET_OF[c] === "CASH"),
    ["refund", "refund_failure", "dispute", "dispute_reversal"]
  );
});

test("only processing fees and never-collected invoices sit outside the losses", () => {
  const notLoss = ALL_CATEGORIES.filter((c) => !countsAsLoss(c));
  assert.deepEqual(
    notLoss.sort(),
    ["stripe_fee", "write_off"].sort(),
    "a fee is what taking money costs; a voided invoice is revenue that never arrived. Neither is money lost."
  );
  assert.equal(BUCKET_OF.stripe_fee, "OPERATING");
  assert.equal(BUCKET_OF.write_off, "UNCOLLECTED");
  // The loss buckets must never include OPERATING, or a total would quietly
  // start growing with healthy revenue.
  assert.ok(!LOSS_BUCKETS.includes("OPERATING"));
  assert.ok(!LOSS_BUCKETS.includes("UNCOLLECTED"));
  for (const c of ALL_CATEGORIES) {
    assert.equal(countsAsLoss(c), LOSS_BUCKETS.includes(BUCKET_OF[c]), c);
  }
});

test("refund: Stripe's negative amount becomes positive money-out", () => {
  const rows = classifyBalanceTransaction(bt({ type: "refund", amount: -2500 }), "sweep");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "refund");
  assert.equal(rows[0].bucket, "CASH");
  assert.equal(rows[0].amountMinor, 2500);
  assert.equal(rows[0].kind, "LEDGER");
  assert.equal(rows[0].id, "txn_1");
  assert.equal(rows[0].source, "sweep");
});

test("refund failure is NEGATIVE: the money came back, so a window sum nets out", () => {
  const rows = classifyBalanceTransaction(bt({ type: "refund_failure", amount: 2500 }), "sweep");
  assert.equal(rows[0].category, "refund_failure");
  assert.equal(rows[0].amountMinor, -2500);

  // A refund that later failed must net to zero, not to double the loss.
  const refunded = classifyBalanceTransaction(bt({ id: "txn_a", type: "refund", amount: -2500 }), "sweep");
  const total = [...refunded, ...rows].reduce((n, r) => n + r.amountMinor, 0);
  assert.equal(total, 0);
});

test("dispute splits into the withdrawal AND a separate dispute-fee row", () => {
  // A real chargeback: $25 withdrawn plus Stripe's $15 fee on the same
  // transaction. The fee exists ONLY here — no webhook payload carries it.
  const rows = classifyBalanceTransaction(
    bt({ id: "txn_d", type: "adjustment", reporting: "dispute", amount: -2500, fee: 1500 }),
    "webhook"
  );
  assert.equal(rows.length, 2);

  const [movement, fee] = rows;
  assert.equal(movement.category, "dispute");
  assert.equal(movement.bucket, "CASH");
  assert.equal(movement.amountMinor, 2500);
  assert.equal(movement.id, "txn_d");

  assert.equal(fee.category, "dispute_fee");
  assert.ok(countsAsLoss(fee.category), "a chargeback penalty IS a loss");
  assert.equal(fee.bucket, "FEES");
  assert.equal(fee.amountMinor, 1500);
  // Suffixed so the fee row can never overwrite the movement row it accompanies.
  assert.equal(fee.id, "txn_d:fee");
  assert.notEqual(fee.id, movement.id);

  assert.equal(rows.reduce((n, r) => n + r.amountMinor, 0), 4000, "true cost is withdrawal + fee");
});

test("dispute reversal is negative and its fee is still a dispute fee (won disputes keep the fee)", () => {
  const rows = classifyBalanceTransaction(
    bt({ id: "txn_r", type: "adjustment", reporting: "dispute_reversal", amount: 2500 }),
    "sweep"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "dispute_reversal");
  assert.equal(rows[0].amountMinor, -2500);
});

test("a fee riding on a REFUND is a loss, not operating cost", () => {
  // The processing fee Stripe keeps on money we handed back buys nothing.
  const rows = classifyBalanceTransaction(bt({ id: "txn_rf", type: "refund", amount: -2500, fee: 90 }), "sweep");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].category, "refund_fee");
  assert.equal(rows[1].bucket, "FEES");
  assert.equal(rows[1].amountMinor, 90);
  assert.equal(rows[1].id, "txn_rf:fee");
  assert.ok(countsAsLoss(rows[1].category));
});

test("a pure stripe_fee transaction emits ONE row, not a fee row on top of itself", () => {
  const rows = classifyBalanceTransaction(bt({ type: "stripe_fee", amount: -1000, fee: 1000 }), "sweep");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, "stripe_fee");
  assert.equal(rows[0].amountMinor, 1000);
});

test("every flavour of Stripe fee lands in OPERATING and is excluded from losses", () => {
  for (const type of ["stripe_fee", "stripe_fx_fee", "tax_fee", "stripe_balance_payment_debit"]) {
    const rows = classifyBalanceTransaction(bt({ type, amount: -750 }), "sweep");
    assert.equal(rows.length, 1, `${type} should emit one row`);
    assert.equal(rows[0].category, "stripe_fee", type);
    assert.equal(rows[0].bucket, "OPERATING", type);
    assert.equal(countsAsLoss(rows[0].category), false, type);
    assert.equal(rows[0].amountMinor, 750, type);
  }
  // A reversal nets against the debit rather than getting its own category.
  const reversal = classifyBalanceTransaction(bt({ type: "stripe_balance_payment_debit_reversal", amount: 750 }), "sweep");
  assert.equal(reversal[0].category, "stripe_fee");
  assert.equal(reversal[0].amountMinor, -750);
});

test("payouts, charges and transfers are NOT money out", () => {
  for (const type of ["payout", "charge", "transfer", "topup", "payout_cancel"]) {
    assert.equal(categoryOfBalanceTransaction(bt({ type, amount: -5000 })), null, `${type} should be ignored`);
    assert.deepEqual(classifyBalanceTransaction(bt({ type, amount: -5000 }), "sweep"), []);
  }
});

test("a non-dispute adjustment only counts when it actually removed money", () => {
  assert.equal(categoryOfBalanceTransaction(bt({ type: "adjustment", reporting: "other", amount: -300 })), "stripe_fee");
  assert.equal(categoryOfBalanceTransaction(bt({ type: "adjustment", reporting: "other", amount: 300 })), null);
});

test("the expanded source supplies the charge id for attribution", () => {
  const rows = classifyBalanceTransaction(
    bt({ type: "refund", amount: -100, source: { id: "re_1", charge: "ch_1" } }),
    "sweep"
  );
  assert.equal(rows[0].chargeId, "ch_1");
  assert.equal(rows[0].stripeObjectId, "re_1");
});

const creditNote = (p: { amount: number; refunded?: number; id?: string }): Stripe.CreditNote =>
  ({
    id: p.id ?? "cn_1",
    amount: p.amount,
    currency: "usd",
    created: 1_700_000_000,
    customer: "cus_1",
    reason: "order_change",
    refunds: p.refunded ? [{ amount_refunded: p.refunded }] : [],
  }) as unknown as Stripe.CreditNote;

test("credit note books only the NON-refunded part, so cash and concession never double-count", () => {
  // $100 note, $40 of it actually refunded to the card. The refund half will
  // arrive separately as a CASH ledger row from its balance transaction.
  const row = classifyCreditNote(creditNote({ amount: 10_000, refunded: 4_000 }), "webhook");
  assert.ok(row);
  assert.equal(row.category, "credit_note");
  assert.equal(row.bucket, "CONCESSION");
  assert.equal(row.amountMinor, 6_000);
  assert.equal(row.kind, "CONCESSION");
});

test("a fully-refunded credit note books nothing: the ledger already has it as cash", () => {
  assert.equal(classifyCreditNote(creditNote({ amount: 5_000, refunded: 5_000 }), "webhook"), null);
});

test("ledger and concession keys occupy disjoint spaces", () => {
  const ledger = classifyBalanceTransaction(bt({ id: "txn_x", type: "refund", amount: -100 }), "sweep")[0];
  const concession = classifyCreditNote(creditNote({ amount: 100, id: "cn_x" }), "webhook");
  assert.ok(concession);
  assert.notEqual(ledger.id, concession.id);
  assert.equal(ledger.kind, "LEDGER");
  assert.equal(concession.kind, "CONCESSION");
});

const invoice = (p: { status: string; due: number; paid?: number }): Stripe.Invoice =>
  ({
    id: "in_1",
    status: p.status,
    amount_due: p.due,
    amount_paid: p.paid ?? 0,
    currency: "usd",
    created: 1_700_000_000,
    customer: "cus_1",
    status_transitions: {},
  }) as unknown as Stripe.Invoice;

test("write-off books what will never be paid, and only for terminal invoices", () => {
  const row = classifyWriteOff(invoice({ status: "uncollectible", due: 9_900 }), "webhook");
  assert.ok(row);
  assert.equal(row.category, "write_off");
  assert.equal(row.amountMinor, 9_900);

  // A partly-paid invoice only loses the remainder.
  assert.equal(classifyWriteOff(invoice({ status: "void", due: 9_900, paid: 4_900 }), "webhook")?.amountMinor, 5_000);
  // Open/paid/draft invoices are not losses.
  assert.equal(classifyWriteOff(invoice({ status: "open", due: 9_900 }), "webhook"), null);
  assert.equal(classifyWriteOff(invoice({ status: "paid", due: 9_900, paid: 9_900 }), "webhook"), null);
  assert.equal(classifyWriteOff(invoice({ status: "void", due: 9_900, paid: 9_900 }), "webhook"), null);
});

test("discount is priced against the base it applies to; percent wins over amount", () => {
  const pct = classifyDiscount({
    discountId: "di_1",
    customerId: "cus_1",
    currency: "usd",
    baseMinor: 10_000,
    percentOff: 50,
    amountOffMinor: 999,
    occurredAt: new Date(0),
    source: "webhook",
  });
  assert.equal(pct?.amountMinor, 5_000);

  const flat = classifyDiscount({
    discountId: "di_2",
    customerId: "cus_1",
    currency: "usd",
    baseMinor: 10_000,
    amountOffMinor: 1_500,
    occurredAt: new Date(0),
    source: "webhook",
  });
  assert.equal(flat?.amountMinor, 1_500);

  // No base to price a percentage against = no row, rather than a silent zero
  // that would read as "this discount cost nothing".
  assert.equal(
    classifyDiscount({
      discountId: "di_3",
      customerId: "cus_1",
      currency: "usd",
      baseMinor: 0,
      percentOff: 50,
      occurredAt: new Date(0),
      source: "webhook",
    }),
    null
  );
});

test("balance credits count, balance DEBITS never do", () => {
  // The registry's deltaMinor is negative for a credit (customer owes less).
  const credit = classifyBalanceConcession({
    id: "cbt_1",
    category: "balance_credit",
    customerId: "cus_1",
    currency: "usd",
    amountMinor: -2_000,
    occurredAt: new Date(0),
    source: "action",
  });
  assert.equal(credit?.amountMinor, 2_000);
  assert.equal(credit?.bucket, "CONCESSION");

  // A debit is money the customer now owes US — the opposite of money out.
  assert.equal(
    classifyBalanceConcession({
      id: "cbt_2",
      category: "balance_credit",
      customerId: "cus_1",
      currency: "usd",
      amountMinor: 2_000,
      occurredAt: new Date(0),
      source: "action",
    }),
    null
  );

  // Credit grants arrive positive and are always a give-away.
  const grant = classifyBalanceConcession({
    id: "credgr_1",
    category: "credit_grant",
    customerId: "cus_1",
    currency: "usd",
    amountMinor: 3_000,
    occurredAt: new Date(0),
    source: "action",
  });
  assert.equal(grant?.amountMinor, 3_000);
  assert.equal(grant?.category, "credit_grant");
});
