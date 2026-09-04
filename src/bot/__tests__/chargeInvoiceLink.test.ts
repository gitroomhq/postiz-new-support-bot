import { test } from "node:test";
import assert from "node:assert/strict";
import { StripeClient } from "../StripeClient";
import type { BotConfig } from "../../config";

// Basil removed `invoice` from Charge, and the self-service refund flow reads
// the subscription (and so the billing-period guardrail) off that invoice. When
// the link goes missing every refund request fails safe into manual review, so
// these tests pin the InvoicePayment path that replaced the removed field.

const KEY = "sk_test_chargeinvoicelink";

// The getter only rebuilds the SDK when the resolved key changes, so a stub
// installed under the same key survives every call.
function client(sdk: unknown): StripeClient {
  const c = new StripeClient({ stripe: { secretKey: KEY } } as unknown as BotConfig);
  (c as unknown as { sdk: unknown }).sdk = sdk;
  return c;
}

type ListCall = { payment?: { type: string; payment_intent?: string }; limit?: number };

function stubSdk(opts: {
  charges?: unknown[];
  invoicePayments?: unknown[];
  invoice?: unknown;
  calls?: ListCall[];
}) {
  return {
    charges: {
      list: async () => ({ data: opts.charges ?? [] }),
      retrieve: async () => (opts.charges ?? [])[0],
    },
    invoicePayments: {
      list: async (params: ListCall) => {
        opts.calls?.push(params);
        return { data: opts.invoicePayments ?? [] };
      },
    },
    invoices: {
      retrieve: async () => opts.invoice ?? null,
    },
  };
}

const subCharge = {
  id: "ch_1",
  status: "succeeded",
  refunded: false,
  disputed: false,
  amount: 4165,
  currency: "usd",
  created: 1_700_000_000,
  payment_intent: "pi_1",
  customer: "cus_1",
};

test("a Basil charge resolves its invoice through invoice_payments", async () => {
  const calls: ListCall[] = [];
  const c = client(
    stubSdk({ invoicePayments: [{ invoice: "in_1" }], calls })
  );
  assert.equal(await c.resolveChargeInvoiceId(subCharge as never), "in_1");
  assert.deepEqual(calls[0]?.payment, { type: "payment_intent", payment_intent: "pi_1" });
});

test("a pre-Basil charge still uses its own invoice field, with no extra call", async () => {
  const calls: ListCall[] = [];
  const c = client(stubSdk({ calls }));
  assert.equal(
    await c.resolveChargeInvoiceId({ ...subCharge, invoice: "in_legacy" } as never),
    "in_legacy"
  );
  assert.equal(calls.length, 0);
});

test("a charge with no payment intent and no invoice resolves to null", async () => {
  const c = client(stubSdk({ invoicePayments: [{ invoice: "in_1" }] }));
  assert.equal(await c.resolveChargeInvoiceId({ ...subCharge, payment_intent: null } as never), null);
});

test("a Basil payment intent resolves its invoice the same way", async () => {
  // Basil removed `invoice` from PaymentIntent too — the /billing payment-attempt
  // card showed "N/A" for every invoice-backed intent without this.
  const calls: ListCall[] = [];
  const c = client(stubSdk({ invoicePayments: [{ invoice: "in_2" }], calls }));
  assert.equal(await c.resolvePaymentIntentInvoiceId({ id: "pi_9" } as never), "in_2");
  assert.deepEqual(calls[0]?.payment, { type: "payment_intent", payment_intent: "pi_9" });
  assert.equal(
    await c.resolvePaymentIntentInvoiceId({ id: "pi_9", invoice: "in_legacy" } as never),
    "in_legacy"
  );
  assert.equal(calls.length, 1);
});

test("an invoice_payments failure resolves to null instead of throwing", async () => {
  const sdk = stubSdk({});
  sdk.invoicePayments.list = async () => {
    throw new Error("stripe down");
  };
  assert.equal(await client(sdk).resolveChargeInvoiceId(subCharge as never), null);
});

test("the refund flow gets a subscription id for an ordinary subscription charge", async () => {
  // The regression: without the invoice_payments hop this came back "", and
  // BillingCategory blocked the refund as an unverifiable billing period.
  const c = client(
    stubSdk({
      charges: [subCharge],
      invoicePayments: [{ invoice: "in_1" }],
      invoice: { id: "in_1", parent: { subscription_details: { subscription: "sub_1" } } },
    })
  );
  const found = await c.getLastSubscriptionCharge("cus_1");
  assert.equal(found?.subscriptionId, "sub_1");
  assert.equal(found?.invoiceId, "in_1");
  assert.equal(found?.chargeId, "ch_1");
});

test("an unlinked charge still returns, with no subscription for the guardrails to clear", async () => {
  const c = client(stubSdk({ charges: [{ ...subCharge, payment_intent: null }] }));
  const found = await c.getLastSubscriptionCharge("cus_1");
  assert.equal(found?.subscriptionId, "");
  assert.equal(found?.invoiceId, "ch_1");
});
