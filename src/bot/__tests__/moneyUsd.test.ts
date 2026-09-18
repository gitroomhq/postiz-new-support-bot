import { test } from "node:test";
import assert from "node:assert/strict";
import { toUsdMinor, usdMinorAtRate, usdMinorOf } from "../billing/fx";

// The ledger stores every amount in its original currency, which is what keeps
// it reconcilable against Stripe, and a frozen USD figure beside it so a
// Grafana total across a mixed-currency account means something instead of
// adding EUR minor units to USD ones.

test("converts a two-decimal currency", () => {
  const usd = usdMinorOf(10_000, "eur"); // 100.00 EUR at 1.08
  assert.equal(usd?.usdMinor, 10_800);
  assert.equal(usd?.rate, 1.08);
});

test("a zero-decimal currency is not hundredths", () => {
  // JPY has no minor unit: 6000 is 6000 yen, not 60 yen. Treating it like cents
  // is a 100x error, and the dashboards' old `/100.0` scaling made exactly that
  // mistake for every JPY row.
  const usd = usdMinorOf(6_000, "jpy"); // 6000 JPY at 0.0067 = $40.20
  assert.equal(usd?.usdMinor, 4_020);
});

test("a three-decimal currency is thousandths", () => {
  const usd = usdMinorOf(10_000, "kwd"); // 10.000 KWD at 3.26 = $32.60
  assert.equal(usd?.usdMinor, 3_260);
});

test("an unknown currency converts to null, never to zero", () => {
  // Zero would read as "this movement cost nothing", which is worse than the
  // honest answer of "not convertible" — the point then omits the amount and
  // flags usd_convertible: 0 rather than dragging a total down.
  assert.equal(usdMinorOf(1_000, "xyz"), null);
  assert.equal(usdMinorOf(Number.NaN, "eur"), null);
});

test("ledger rounding is to NEAREST, unlike the threshold helper", () => {
  // toUsdMinor rounds UP because overstating a charge can only block an
  // auto-refund — the cheap failure. usdMinorOf is summed across the whole
  // account, where rounding every row the same way biases the total upward
  // without limit.
  const amount = 333; // 3.33 EUR at 1.08 = 3.5964 USD
  assert.equal(toUsdMinor(amount, "eur"), 360); // up
  assert.equal(usdMinorOf(amount, "eur")?.usdMinor, 360); // nearest, same here
  // A case where they differ: 1.01 EUR = 1.0908 USD.
  assert.equal(toUsdMinor(101, "eur"), 110);
  assert.equal(usdMinorOf(101, "eur")?.usdMinor, 109);
});

test("negatives round symmetrically so a reversal cancels its movement", () => {
  // Ledger amounts are signed. Math.round(-2.5) is -2 while Math.round(2.5) is
  // 3, and that asymmetry would leave a residue every time a refund and its
  // reversal were summed together.
  for (const amount of [101, 333, 4_999, 12_345]) {
    const pos = usdMinorOf(amount, "eur")!.usdMinor;
    const neg = usdMinorOf(-amount, "eur")!.usdMinor;
    assert.equal(pos + neg, 0, `${amount} did not cancel with its reversal`);
  }
});

test("a stored rate is reused verbatim, so history cannot be restated", () => {
  // fx.ts rates are reviewed annually. A row converted at last year's rate must
  // keep last year's number: re-converting on every rebuild would silently
  // rewrite years of history each time the table was touched.
  const stale = 1.5; // deliberately not the current EUR rate
  assert.equal(usdMinorAtRate(10_000, "eur", stale), 15_000);
  assert.notEqual(usdMinorAtRate(10_000, "eur", stale), usdMinorOf(10_000, "eur")?.usdMinor);
});

test("a stored rate respects the currency's minor-unit size", () => {
  assert.equal(usdMinorAtRate(6_000, "jpy", 0.01), 6_000); // 6000 yen * 0.01 = $60
  assert.equal(usdMinorAtRate(10_000, "kwd", 3.0), 3_000); // 10.000 KWD * 3 = $30
});
