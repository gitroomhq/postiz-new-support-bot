import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { parseBankReference } from "../../bot/billing/bankReference";
import type { StripeClient } from "../../bot/StripeClient";
import type { ApprovalStore } from "../../bot/billing/ApprovalStore";
import type { BillingActionService } from "../../bot/billing/actions/BillingActionService";
import { SupportData } from "../SupportData";
import type { SupportLookupLog } from "../SupportStores";
import { SupportViews } from "../supportViews";
import type { TableBlock } from "../../dashboard/renderer/contract";

// A customer's bank quotes its own reference for a card charge. Stripe never
// has it, so the lookup reads the booking day out of it and searches the
// card's charges around that day.

const NOW = Date.UTC(2026, 10, 12, 12); // 12 Nov 2026, 12:00 UTC
const DAY = 86_400;
const NOV3 = Date.UTC(2026, 10, 3) / 1000;

test("a T24 reference carries the day the bank booked it", () => {
  const ref = parseBankReference("ft26307b8p5m", NOW);
  assert.ok(ref);
  assert.equal(ref.reference, "FT26307B8P5M");
  assert.equal(ref.bookedDay, NOV3);
  assert.equal(ref.from, NOV3 - 3 * DAY);
  assert.equal(ref.to, NOV3 + 2 * DAY);
  assert.equal(parseBankReference(" FT26307 B8P5M ", NOW)?.reference, "FT26307B8P5M");
  assert.equal(parseBankReference("FT24366ABCDE", NOW)?.bookedDay, Date.UTC(2024, 11, 31) / 1000);
  // Tomorrow is still a booking day (the bank's day can be ahead of UTC).
  assert.equal(parseBankReference("FT26317ABCDE", NOW)?.bookedDay, Date.UTC(2026, 10, 13) / 1000);
});

test("a reference that cannot name a booking day is refused", () => {
  for (const bad of ["FT26000B8P5M", "FT25366B8P5M", "FT26318B8P5M", "FT2630B8P5M", "FT26307B8P5M1", "1T26307B8P5M", "FT26307B8P-M", "cus_26307B8P5M"]) {
    assert.equal(parseBankReference(bad, NOW), null, bad);
  }
});

function charge(id: string, customer: string | null, created: number, amount = 2900): Stripe.Charge {
  return { id, customer, created, amount, currency: "usd", status: "succeeded", payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } } } as unknown as Stripe.Charge;
}

function fakeStripe(charges: Stripe.Charge[]) {
  const calls: Array<{ last4: string; from: number; to: number }> = [];
  const stripe = {
    searchCardChargesBetween: async (last4: string, from: number, to: number) => {
      calls.push({ last4, from, to });
      return { charges, nextPage: null };
    },
    getCustomer: async (id: string) => ({ id, name: `Name ${id}`, email: `${id}@example.com` }),
    listAllSubscriptions: async () => ({ subscriptions: [] }),
    formatAmount: (amount: number, currency: string) => `${currency.toUpperCase()} ${(amount / 100).toFixed(2)}`,
  } as unknown as StripeClient & { formatAmount(a: number, c: string): string };
  return { stripe, calls };
}

const CHARGES = [
  charge("ch_a_old", "cus_a", NOV3 - 2 * DAY),
  charge("ch_b", "cus_b", NOV3 - DAY, 4401),
  charge("ch_a", "cus_a", NOV3 + 10 * 3600, 18666),
  charge("ch_guest", null, NOV3 + 12 * 3600),
];

test("the lookup lists each customer once with the charge nearest the booking day, nearest first", async () => {
  const { stripe, calls } = fakeStripe(CHARGES);
  const data = new SupportData(stripe, null, () => NOW);
  const res = await data.lookupReference("FT26307B8P5M", " 4242 ");
  assert.ok(res.ok);
  assert.deepEqual(calls, [{ last4: "4242", from: NOV3 - 3 * DAY, to: NOV3 + 2 * DAY }]);
  assert.deepEqual(res.ok && res.hits.map((h) => [h.customerId, h.foundBy, h.email]), [
    ["cus_a", "Reference", "cus_a@example.com"],
    ["cus_b", "Reference", "cus_b@example.com"],
  ]);
  assert.equal(res.charges?.get("cus_a")?.id, "ch_a");
  assert.equal(res.window?.bookedDay, NOV3);
});

test("a malformed reference or last 4 never reaches Stripe", async () => {
  const { stripe, calls } = fakeStripe(CHARGES);
  const data = new SupportData(stripe, null, () => NOW);
  const badRef = await data.lookupReference("cus_123", "4242");
  assert.equal(badRef.ok, false);
  const badLast4 = await data.lookupReference("FT26307B8P5M", "42");
  assert.equal(badLast4.ok, false);
  assert.equal(calls.length, 0);
});

test("the Reference tab shows the window and each customer's charge with its amount", async () => {
  const { stripe } = fakeStripe(CHARGES);
  const views = new SupportViews({
    data: new SupportData(stripe, null, () => NOW),
    approvals: { countByRequesterStatus: async () => ({}) } as unknown as ApprovalStore,
    actions: {} as BillingActionService,
    lookups: {} as SupportLookupLog,
    money: stripe as unknown as { formatAmount(a: number, c: string): string },
    now: () => NOW,
  });
  const page = await views.build(
    { id: "1", name: "Ada", sessionIdHash: "h" },
    { page: "lookup", params: {}, filters: { by: "reference", ref: "FT26307B8P5M", l4: "4242" }, cursor: null }
  );
  const tabs = page?.blocks.find((b) => b.type === "tabs") as { value: string } | undefined;
  assert.equal(tabs?.value, "reference");
  const table = page?.blocks.find((b) => b.type === "table") as TableBlock | undefined;
  assert.ok(table);
  assert.equal(table.title, "2 customers, charged Oct 31, 2026 to Nov 4, 2026");
  assert.deepEqual(table.rows[0].ref, { page: "customer", params: { id: "cus_a" }, filters: { via: "reference" } });
  assert.deepEqual(table.rows[0].cells[3], { t: "text", v: "USD 186.66, Nov 3, 2026" });
});
