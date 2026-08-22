import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { MoneyOutService } from "../../bot/billing/MoneyOutService";
import type { StripeClient } from "../../bot/StripeClient";
import type { SettingsStore } from "../../config/SettingsStore";
import type { MoneyOutStore } from "../../bot/billing/MoneyOutStore";

// Regression guard for "concessions always show 0".
//
// classifyDiscount refuses to book a percentage coupon it cannot price, and the
// only base we originally tried was an upcoming-invoice preview — which returns
// nothing for a customer-level discount, or for any subscription without a next
// invoice. Every percentage coupon therefore booked nothing at all.

const sub = (p: { id?: string; items: Array<{ unit: number | null; qty?: number }>; status?: string }): Stripe.Subscription =>
  ({
    id: p.id ?? "sub_1",
    status: p.status ?? "active",
    customer: "cus_1",
    created: 1_700_000_000,
    items: {
      data: p.items.map((i) => ({
        quantity: i.qty ?? 1,
        price: { unit_amount: i.unit, currency: "eur" },
      })),
    },
  }) as unknown as Stripe.Subscription;

function makeService(stripe: Partial<Record<string, unknown>>): MoneyOutService {
  return new MoneyOutService(
    { moneyOutEnabled: () => true } as unknown as SettingsStore,
    stripe as unknown as StripeClient,
    {} as unknown as MoneyOutStore
  );
}

test("prices a subscription percentage coupon from its line items, with no invoice preview at all", async () => {
  let previewCalls = 0;
  const service = makeService({
    getSubscription: async () => sub({ items: [{ unit: 2_900 }] }),
    previewUpcomingInvoice: async () => {
      previewCalls++;
      return null;
    },
  });

  const priced = await service.priceDiscountBase("cus_1", "sub_1");
  assert.deepEqual(priced, { baseMinor: 2_900, currency: "eur" });
  assert.equal(previewCalls, 0, "line items answer it directly; the preview is only a fallback");
});

test("multiplies by quantity and sums multi-item subscriptions", async () => {
  const service = makeService({
    getSubscription: async () => sub({ items: [{ unit: 1_000, qty: 3 }, { unit: 500 }] }),
    previewUpcomingInvoice: async () => null,
  });
  assert.deepEqual(await service.priceDiscountBase("cus_1", "sub_1"), { baseMinor: 3_500, currency: "eur" });
});

test("falls back to the upcoming invoice when line items cannot be priced (metered/tiered)", async () => {
  const service = makeService({
    getSubscription: async () => sub({ items: [{ unit: null }] }),
    previewUpcomingInvoice: async () => ({ subtotal: 4_200, currency: "eur" }) as unknown as Stripe.Invoice,
  });
  // subtotal is PRE-discount, which is the base a percentage applies to.
  assert.deepEqual(await service.priceDiscountBase("cus_1", "sub_1"), { baseMinor: 4_200, currency: "eur" });
});

test("a CUSTOMER-level coupon prices against their active subscriptions — the case that used to book nothing", async () => {
  const service = makeService({
    listSubscriptions: async () => [
      sub({ id: "sub_a", items: [{ unit: 2_900 }] }),
      sub({ id: "sub_b", items: [{ unit: 1_000 }] }),
      // Cancelled subscriptions must not inflate the base.
      sub({ id: "sub_c", items: [{ unit: 9_900 }], status: "canceled" }),
    ],
  });
  assert.deepEqual(await service.priceDiscountBase("cus_1", null), { baseMinor: 3_900, currency: "eur" });
});

test("returns null rather than a zero base, so an unpriceable coupon is a visible gap not a silent 0", async () => {
  const noSubs = makeService({ listSubscriptions: async () => [] });
  assert.equal(await noSubs.priceDiscountBase("cus_1", null), null);

  const unpriceable = makeService({
    getSubscription: async () => sub({ items: [{ unit: null }] }),
    previewUpcomingInvoice: async () => null,
  });
  assert.equal(await unpriceable.priceDiscountBase("cus_1", "sub_1"), null);

  const noCustomer = makeService({});
  assert.equal(await noCustomer.priceDiscountBase(null, null), null);
});

test("a Stripe failure degrades to null instead of throwing into the webhook", async () => {
  const service = makeService({
    getSubscription: async () => {
      throw new Error("stripe down");
    },
    previewUpcomingInvoice: async () => {
      throw new Error("stripe down");
    },
  });
  assert.equal(await service.priceDiscountBase("cus_1", "sub_1"), null);
});
