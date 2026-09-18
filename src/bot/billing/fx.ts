// Approximate currency conversion, used for ONE purpose: comparing a charge
// against the single USD auto-resolve threshold in /config.
//
// SCOPE. This module never displays money, never sums money and never computes
// a refund amount. An auto-resolve refund always moves the charge's own
// currency, unconverted, and every amount stored or exported keeps that
// currency. The USD figure exists only to answer "is this charge small enough
// to refund without asking a human", and it is persisted on the proposal row
// purely so an auditor can see what number the decision was made on.
//
// STALENESS. These rates are approximate and they drift. They are deliberately
// hardcoded rather than fetched: a threshold comparison that silently depends
// on a third-party rate feed would make "why did this refund fire" unanswerable
// after the fact, and a feed outage would either block every non-USD
// auto-resolve or, worse, fall back to a stale number nobody can see. Review
// them annually.
//
// ROUNDING is always up (Math.ceil). Overstating the USD value can only push a
// charge OVER the threshold and block an auto-refund, which costs a human two
// minutes. Understating it lets a charge above the operator's limit through,
// which costs money. When a conversion is inexact, err toward the cheap
// failure.
//
// A currency missing from RATES returns null, and null means never
// auto-resolve. There is no default rate: an unknown currency cannot be made
// conservative, only guessed at.

export const RATES_SAMPLED_AT = "2026-09";

// USD per one MAJOR unit of the currency (1 EUR = 1.08 USD).
const RATES: Record<string, number> = {
  usd: 1,
  eur: 1.08,
  gbp: 1.27,
  chf: 1.13,
  cad: 0.73,
  aud: 0.66,
  nzd: 0.61,
  sek: 0.095,
  nok: 0.093,
  dkk: 0.145,
  pln: 0.25,
  czk: 0.043,
  huf: 0.0028,
  ron: 0.22,
  bgn: 0.55,
  jpy: 0.0067,
  krw: 0.00073,
  cny: 0.14,
  hkd: 0.128,
  twd: 0.031,
  sgd: 0.75,
  myr: 0.22,
  thb: 0.029,
  php: 0.017,
  idr: 0.000062,
  vnd: 0.00004,
  inr: 0.012,
  aed: 0.272,
  sar: 0.267,
  kwd: 3.26,
  bhd: 2.65,
  jod: 1.41,
  omr: 2.6,
  tnd: 0.32,
  ils: 0.27,
  try: 0.029,
  zar: 0.055,
  brl: 0.18,
  mxn: 0.055,
  clp: 0.001,
  ars: 0.0009,
};

// Stripe minor units are NOT uniformly one hundredth of the major unit. For a
// zero-decimal currency the "minor" amount IS the major amount, so an amount of
// 6000 is 6000 yen (about 40 USD), not 60 yen. For a three-decimal currency it
// is a thousandth. Treating either like a cent is a 100x or 10x error, and for
// the zero-decimal case it is an error in the direction that refunds money.
//
// Source: Stripe's zero-decimal and three-decimal currency lists.
const ZERO_DECIMAL = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

// How many minor units make one major unit of this currency.
export function minorUnitsPerMajor(currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 1;
  if (THREE_DECIMAL.has(c)) return 1000;
  return 100;
}

// Converts a Stripe minor-unit amount to USD cents, rounded UP.
// Returns null when the currency has no sampled rate, which callers must treat
// as "never auto-resolve" rather than as zero or as a pass.
export function toUsdMinor(amountMinor: number, currency: string): number | null {
  if (!Number.isFinite(amountMinor)) return null;
  const c = currency.toLowerCase();
  const rate = RATES[c];
  if (rate == null) return null;
  const major = amountMinor / minorUnitsPerMajor(c);
  return Math.ceil(major * rate * 100);
}

// ---- ledger conversion ----
//
// The SECOND use of this table, and the only one that stores a number rather
// than comparing one. The money-out ledger keeps every amount in its original
// currency (that is what makes it reconcilable against Stripe), and carries a
// USD figure alongside it so a Grafana total over a mixed-currency account
// means something instead of adding EUR minor units to USD ones.
//
// Three deliberate differences from toUsdMinor above:
//
//   ROUNDING is to NEAREST, not up. toUsdMinor rounds up because overstating a
//   charge can only block an auto-refund, which is the cheap failure. Here the
//   number is summed over the whole account, and rounding every row in the same
//   direction would bias the total upward without limit.
//
//   NEGATIVES round symmetrically. Ledger amounts are signed (a reversal is
//   negative), and Math.round(-2.5) is -2 while Math.round(2.5) is 3 — that
//   asymmetry would make a refund and its reversal fail to cancel out.
//
//   THE RATE COMES BACK. It is stored on the row and reused verbatim on every
//   re-emit, so revising this table next year restates nothing that has already
//   happened and an auditor can always see which rate produced a figure.
export interface UsdConversion {
  usdMinor: number;
  rate: number;
}

export function usdMinorOf(amountMinor: number, currency: string): UsdConversion | null {
  if (!Number.isFinite(amountMinor)) return null;
  const c = currency.toLowerCase();
  const rate = RATES[c];
  if (rate == null) return null;
  const major = amountMinor / minorUnitsPerMajor(c);
  const cents = major * rate * 100;
  return { usdMinor: Math.sign(cents) * Math.round(Math.abs(cents)), rate };
}

// Re-converts a stored amount using a rate that was frozen on the row. Used by
// the analytics re-emit so a rebuild reproduces the figure the row was written
// with, rather than today's.
export function usdMinorAtRate(amountMinor: number, currency: string, rate: number): number {
  const cents = (amountMinor / minorUnitsPerMajor(currency)) * rate * 100;
  return Math.sign(cents) * Math.round(Math.abs(cents));
}

// Whether a currency can be compared against the threshold at all. Exposed so
// surfaces can say "this currency is not convertible" instead of showing a
// guardrail name that reads like a policy decision.
export function isConvertible(currency: string): boolean {
  return RATES[currency.toLowerCase()] != null;
}

export const SUPPORTED_CURRENCIES: readonly string[] = Object.keys(RATES);
