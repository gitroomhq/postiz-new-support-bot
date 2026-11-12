// A customer's bank quotes its own reference for a card charge (proof of
// payment, a charge they do not recognise). Stripe never receives it, but a
// reference in the Temenos T24 shape carries the day the bank booked the
// transaction: two letters, the year, the day of the year and five
// characters, so FT26307B8P5M was booked on day 307 of 2026, 3 Nov. A card
// charge is booked on the day it is made or a few days later, and the day is
// the bank's local one, so the charge lies between 3 days before and 1 day
// after it.

const BANK_REFERENCE_RE = /^[A-Z]{2}(\d{2})(\d{3})[A-Z0-9]{5}$/;
const DAY_S = 86_400;

export interface BankReference {
  reference: string; // upper case, without spaces
  bookedDay: number; // unix seconds, 00:00 UTC of the day the bank booked it
  from: number; // the charge window, unix seconds, inclusive
  to: number; // exclusive
}

export function parseBankReference(raw: string, nowMs: number = Date.now()): BankReference | null {
  const reference = raw.replace(/\s+/g, "").toUpperCase();
  const m = BANK_REFERENCE_RE.exec(reference);
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const dayOfYear = Number(m[2]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (dayOfYear < 1 || dayOfYear > (leap ? 366 : 365)) return null;
  const bookedDay = Date.UTC(year, 0, dayOfYear) / 1000;
  // A bank cannot have booked a charge after tomorrow.
  if (bookedDay > nowMs / 1000 + DAY_S) return null;
  return { reference, bookedDay, from: bookedDay - 3 * DAY_S, to: bookedDay + 2 * DAY_S };
}

// How far a charge is from the middle of the booked day: the nearest charge
// on the card is the likeliest one.
export function distanceFromBooking(ref: BankReference, createdUnix: number): number {
  return Math.abs(createdUnix - (ref.bookedDay + DAY_S / 2));
}
