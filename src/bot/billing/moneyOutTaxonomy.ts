import type Stripe from "stripe";

// The money-out taxonomy: one place that decides what counts as an outflow and
// which bucket it lands in. Pure functions only — no Stripe calls, no Prisma —
// so the classification is unit-testable against raw balance-transaction shapes.
//
// SIGN CONVENTION: amountMinor is positive when money LEFT the account and
// negative when it came back (refund failures, dispute reversals). Reversals
// are kept as their own negative rows rather than mutating the original, so any
// window sum is already net and the history stays auditable.
//
// Payouts, transfers and top-up reversals are deliberately NOT money-out: that
// is cash moving from the Stripe balance to the bank, not cash lost. They are
// classified as "ignored" and never written.

export type MoneyOutBucket = "CASH" | "FEES" | "CONCESSION" | "OPERATING";

export type MoneyOutCategory =
  // CASH — money reversed to a cardholder
  | "refund"
  | "refund_failure"
  | "dispute"
  | "dispute_reversal"
  // FEES — fees we LOSE: a penalty, or a fee Stripe keeps on money we gave back
  | "dispute_fee"
  | "refund_fee"
  // OPERATING — the cost of processing payments at all. Recorded, but NOT a
  // loss: it is what taking money costs, and folding it into "money out" would
  // make the number grow with healthy revenue.
  | "stripe_fee"
  // CONCESSION — revenue given away without cash moving
  | "credit_note"
  | "discount"
  | "write_off"
  | "credit_grant"
  | "balance_credit";

export type MoneyOutSource = "webhook" | "sweep" | "backfill" | "action";

export const BUCKET_OF: Record<MoneyOutCategory, MoneyOutBucket> = {
  refund: "CASH",
  refund_failure: "CASH",
  dispute: "CASH",
  dispute_reversal: "CASH",
  dispute_fee: "FEES",
  refund_fee: "FEES",
  stripe_fee: "OPERATING",
  credit_note: "CONCESSION",
  discount: "CONCESSION",
  write_off: "CONCESSION",
  credit_grant: "CONCESSION",
  balance_credit: "CONCESSION",
};

export const CASH_CATEGORIES = ["refund", "refund_failure", "dispute", "dispute_reversal"] as const;
export const FEE_CATEGORIES = ["dispute_fee", "refund_fee"] as const;
export const OPERATING_CATEGORIES = ["stripe_fee"] as const;
export const CONCESSION_CATEGORIES = ["credit_note", "discount", "write_off", "credit_grant", "balance_credit"] as const;

export const ALL_CATEGORIES: MoneyOutCategory[] = [
  ...CASH_CATEGORIES,
  ...FEE_CATEGORIES,
  ...OPERATING_CATEGORIES,
  ...CONCESSION_CATEGORIES,
];

// The buckets that answer "what did we LOSE". Everything a money-out total
// sums must come from these; OPERATING is deliberately absent.
export const LOSS_BUCKETS: MoneyOutBucket[] = ["CASH", "FEES", "CONCESSION"];

// Loss-vs-cost is decided by CATEGORY, never by the stored bucket string: a row
// written before a taxonomy change keeps its old bucket, and a total must not
// silently shift because of it.
export function countsAsLoss(category: string): boolean {
  return !(OPERATING_CATEGORIES as readonly string[]).includes(category);
}

// One row destined for the stripe_money_out table. `id` carries the whole
// idempotency story: balance-transaction id for ledger rows, Stripe object id
// for concessions. The two key spaces cannot collide (txn_ vs cn_/di_/in_/…).
export interface MoneyOutRow {
  id: string;
  kind: "LEDGER" | "CONCESSION";
  bucket: MoneyOutBucket;
  category: MoneyOutCategory;
  amountMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
  source: MoneyOutSource;
  reason: string | null;
  stripeObjectId: string | null;
  chargeId: string | null;
  customerId: string | null;
  occurredAt: Date;
}

function row(input: Omit<MoneyOutRow, "bucket" | "netMinor"> & { netMinor?: number }): MoneyOutRow {
  return {
    ...input,
    bucket: BUCKET_OF[input.category],
    netMinor: input.netMinor ?? input.amountMinor + input.feeMinor,
  };
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// A balance transaction classifies into 0, 1 or 2 rows: the money movement
// itself, plus a separate FEES row when Stripe also took a fee on it (the $15
// chargeback fee is the case that matters — it is invisible everywhere else in
// this codebase).
//
// Stripe's `amount` on outflow transactions is already negative (money leaving
// the balance), so it is negated into our positive-means-out convention.
export function classifyBalanceTransaction(
  bt: Stripe.BalanceTransaction,
  source: MoneyOutSource
): MoneyOutRow[] {
  const occurredAt = new Date(bt.created * 1000);
  const currency = bt.currency.toLowerCase();
  const sourceId = idOf(bt.source as string | { id: string } | null);
  const category = categoryOfBalanceTransaction(bt);
  if (!category) return [];

  const rows: MoneyOutRow[] = [];

  // gross movement, positive = out. Stripe reports outflows as negative amounts.
  const gross = -bt.amount;
  // `fee` is always reported positive (what Stripe kept) regardless of direction.
  const fee = bt.fee ?? 0;

  // A pure fee transaction IS the fee — don't also emit a duplicate fee row.
  if (category === "stripe_fee") {
    rows.push(
      row({
        id: bt.id,
        kind: "LEDGER",
        category: "stripe_fee",
        amountMinor: gross,
        feeMinor: 0,
        netMinor: gross,
        currency,
        source,
        reason: bt.description ?? null,
        stripeObjectId: sourceId,
        chargeId: null,
        customerId: null,
        occurredAt,
      })
    );
    return rows;
  }

  // The movement row. `gross` on a refund BT already excludes the fee Stripe
  // keeps, so amount and net are the same number here and the fee (if any) is
  // carried by its own row below.
  rows.push(
    row({
      id: bt.id,
      kind: "LEDGER",
      category,
      amountMinor: gross,
      feeMinor: 0,
      netMinor: gross,
      currency,
      source,
      reason: bt.description ?? null,
      stripeObjectId: sourceId,
      chargeId: chargeIdOf(bt),
      customerId: null, // resolved by the caller, which can hit Stripe
      occurredAt,
    })
  );

  // The fee Stripe charged on top. For a dispute this is the chargeback fee;
  // for anything else it is an ordinary processing fee. Suffixed id so it never
  // collides with the movement row it accompanies.
  if (fee > 0) {
    // A fee riding on a movement transaction is a fee we LOST: the chargeback
    // penalty, or the processing fee Stripe keeps on money we handed back.
    // Standalone fee transactions (handled above) are ordinary operating cost.
    const feeCategory: MoneyOutCategory =
      category === "dispute" || category === "dispute_reversal" ? "dispute_fee" : "refund_fee";
    rows.push(
      row({
        id: `${bt.id}:fee`,
        kind: "LEDGER",
        category: feeCategory,
        amountMinor: fee,
        feeMinor: 0,
        netMinor: fee,
        currency,
        source,
        reason: bt.description ?? null,
        stripeObjectId: sourceId,
        chargeId: chargeIdOf(bt),
        customerId: null,
        occurredAt,
      })
    );
  }

  return rows;
}

// null = not an outflow we track (charges, payouts, transfers, top-ups…).
export function categoryOfBalanceTransaction(bt: Stripe.BalanceTransaction): MoneyOutCategory | null {
  const reporting = (bt.reporting_category ?? "") as string;

  // Disputes and their reversals arrive as `adjustment` with the meaningful
  // split living in reporting_category, not in `type`.
  if (reporting === "dispute") return "dispute";
  if (reporting === "dispute_reversal") return "dispute_reversal";

  switch (bt.type) {
    case "refund":
    case "payment_refund":
      return "refund";
    case "refund_failure":
    case "payment_failure_refund":
      return "refund_failure";
    case "adjustment":
      // An adjustment that is not dispute-flagged is a manual Stripe
      // correction. Only count it when it actually removed money.
      return bt.amount < 0 ? "stripe_fee" : null;
    // Every flavour of "money Stripe kept": the monthly billing fee, currency
    // conversion, tax on fees, and Stripe invoices paid out of the balance.
    case "stripe_fee":
    case "stripe_fx_fee":
    case "tax_fee":
    case "stripe_balance_payment_debit":
      return "stripe_fee";
    case "stripe_balance_payment_debit_reversal":
      // Money returned from a reversed Stripe balance payment. Classified as a
      // fee so it nets against the debit above rather than sitting in its own
      // category — the sign (negative, from the positive `amount`) does the work.
      return "stripe_fee";
    default:
      // Everything else is not an outflow we track: charges and payments
      // (money IN), payouts / transfers / top-ups (money moving to the bank,
      // not lost), Connect application fees and Issuing (unused here).
      return null;
  }
}

function chargeIdOf(bt: Stripe.BalanceTransaction): string | null {
  const src = bt.source;
  if (!src || typeof src === "string") return null;
  // Expanded sources carry the charge on refunds and disputes alike.
  const withCharge = src as { charge?: string | { id: string } | null };
  return idOf(withCharge.charge ?? null);
}

// ---- Concessions: revenue given away with no balance transaction behind it ----

// A credit note in `refund` mode ALSO produces a real Stripe refund, which the
// ledger will pick up as CASH. Counting the whole credit note as a concession
// would double-count that portion, so only the non-refunded part is recorded
// here. Returns null when the entire note was a refund (nothing left to book).
export function classifyCreditNote(note: Stripe.CreditNote, source: MoneyOutSource): MoneyOutRow | null {
  const refundedMinor = (note.refunds ?? []).reduce((sum, r) => sum + (r.amount_refunded ?? 0), 0);
  const concessionMinor = (note.amount ?? 0) - refundedMinor;
  if (concessionMinor <= 0) return null;
  return row({
    id: note.id,
    kind: "CONCESSION",
    category: "credit_note",
    amountMinor: concessionMinor,
    feeMinor: 0,
    netMinor: concessionMinor,
    currency: note.currency.toLowerCase(),
    source,
    reason: note.reason ?? note.memo ?? null,
    stripeObjectId: note.id,
    chargeId: null,
    customerId: idOf(note.customer as string | { id: string } | null),
    occurredAt: new Date(note.created * 1000),
  });
}

// An invoice write-off: what the customer owed and will now never pay.
// Only finalized invoices carry a real loss — voiding a draft costs nothing.
export function classifyWriteOff(invoice: Stripe.Invoice, source: MoneyOutSource): MoneyOutRow | null {
  const amountMinor = invoice.amount_due - (invoice.amount_paid ?? 0);
  if (amountMinor <= 0) return null;
  if (invoice.status !== "void" && invoice.status !== "uncollectible") return null;
  return row({
    id: invoice.id!,
    kind: "CONCESSION",
    category: "write_off",
    amountMinor,
    feeMinor: 0,
    netMinor: amountMinor,
    currency: invoice.currency.toLowerCase(),
    source,
    reason: invoice.status,
    stripeObjectId: invoice.id ?? null,
    chargeId: null,
    customerId: idOf(invoice.customer as string | { id: string } | null),
    occurredAt: new Date((invoice.status_transitions?.voided_at ?? invoice.created) * 1000),
  });
}

// A discount's value is only knowable against the amount it will be applied to,
// so the caller passes the base it computed (the subscription's next invoice
// total, the charge amount, whatever it had). percentOff wins when both are set,
// matching Stripe's own coupon semantics.
export function classifyDiscount(input: {
  discountId: string;
  customerId: string | null;
  currency: string;
  baseMinor: number;
  percentOff?: number | null;
  amountOffMinor?: number | null;
  reason?: string | null;
  occurredAt: Date;
  source: MoneyOutSource;
}): MoneyOutRow | null {
  const valueMinor =
    input.percentOff != null
      ? Math.round((input.baseMinor * input.percentOff) / 100)
      : (input.amountOffMinor ?? 0);
  if (valueMinor <= 0) return null;
  return row({
    id: input.discountId,
    kind: "CONCESSION",
    category: "discount",
    amountMinor: valueMinor,
    feeMinor: 0,
    netMinor: valueMinor,
    currency: input.currency.toLowerCase(),
    source: input.source,
    reason: input.reason ?? null,
    stripeObjectId: input.discountId,
    chargeId: null,
    customerId: input.customerId,
    occurredAt: input.occurredAt,
  });
}

// Credit grants and customer-balance credits: both are "the customer owes us
// less", both come from our own actions (no webhook, no balance transaction).
// A balance DEBIT is not money out and must not be recorded.
export function classifyBalanceConcession(input: {
  id: string;
  category: Extract<MoneyOutCategory, "credit_grant" | "balance_credit">;
  customerId: string | null;
  currency: string;
  amountMinor: number; // signed as the caller has it; only credits are recorded
  reason?: string | null;
  occurredAt: Date;
  source: MoneyOutSource;
}): MoneyOutRow | null {
  // The registry's deltaMinor is negative for a credit (the customer owes less);
  // credit grants arrive positive. Normalise both to positive-means-out.
  const valueMinor = Math.abs(input.amountMinor);
  if (input.category === "balance_credit" && input.amountMinor >= 0) return null;
  if (valueMinor <= 0) return null;
  return row({
    id: input.id,
    kind: "CONCESSION",
    category: input.category,
    amountMinor: valueMinor,
    feeMinor: 0,
    netMinor: valueMinor,
    currency: input.currency.toLowerCase(),
    source: input.source,
    reason: input.reason ?? null,
    stripeObjectId: input.id,
    chargeId: null,
    customerId: input.customerId,
    occurredAt: input.occurredAt,
  });
}
