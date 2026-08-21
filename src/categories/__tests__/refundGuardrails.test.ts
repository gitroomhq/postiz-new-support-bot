import { test } from "node:test";
import assert from "node:assert/strict";
import { BillingCategory } from "../BillingCategory";
import type { StripeClient } from "../../bot/StripeClient";
import type { SessionStore } from "../../auth/SessionStore";
import type { SettingsStore } from "../../config/SettingsStore";
import type { BlockStore } from "../../bot/billing/BlockStore";

// Self-service billing is the one place a customer moves money without a human
// in the loop, so both fixes here are about what must NOT be self-served:
// a multi-month prepayment, and a retention discount for someone who is not
// paying monthly today.

type Billing = {
  status: string;
  customerId: string | null;
  interval: string | null;
  intervalCount: number;
  monthsPerPeriod: number | null;
};

const monthly = (over: Partial<Billing> = {}): Billing => ({
  status: "active",
  customerId: "cus_1",
  interval: "month",
  intervalCount: 1,
  monthsPerPeriod: 1,
  ...over,
});

const annual = (over: Partial<Billing> = {}): Billing =>
  monthly({ interval: "year", intervalCount: 1, monthsPerPeriod: 12, ...over });

function category(opts: { billing?: Billing | null; throws?: boolean } = {}) {
  const stripeClient = {
    async getSubscriptionBillingContext() {
      if (opts.throws) throw new Error("stripe down");
      return opts.billing === undefined ? monthly() : opts.billing;
    },
    formatAmount: (a: number, c: string) => `${(a / 100).toFixed(2)} ${c.toUpperCase()}`,
    async customerHasAnyRefund() {
      return { hasRefund: false, truncated: false };
    },
  } as unknown as StripeClient;

  const sessionStore = {
    async getSession() {
      return { stripeCustomerId: "cus_1" };
    },
    async countRefundsSince() {
      return 0;
    },
    async countRefundsSinceForUser() {
      return 0;
    },
    async hasEverBeenRefunded() {
      return false;
    },
  } as unknown as SessionStore;

  // Every optional guardrail disabled, so a failure can only come from the
  // billing-period check under test.
  const settingsStore = {
    refundMaxAmount: () => null,
    refundMaxAmountCurrency: () => "usd",
    refundMaxChargeAgeDays: () => null,
    refundMaxPer24h: () => null,
    refundMaxPer24hPerUser: () => null,
    refundMinMemberAgeDays: () => null,
  } as unknown as SettingsStore;

  const blockStore = { async anyBlocked() { return null; } } as unknown as BlockStore;

  const cat = new BillingCategory(
    stripeClient, sessionStore, settingsStore,
    {} as never, {} as never, {} as never, {} as never, blockStore, {} as never
  );

  const interaction = { user: { id: "d1" }, guild: null } as never;
  const charge = { amount: 95000, currency: "usd", created: new Date(), customerId: "cus_1" };

  return {
    guardrails: (subscriptionId: string) =>
      (cat as unknown as {
        checkRefundGuardrails(i: unknown, c: unknown, id: string, sub: string): Promise<string | null>;
      }).checkRefundGuardrails(interaction, charge, "ch_1", subscriptionId),
    discount: (subscriptionId: string) =>
      (cat as unknown as { checkDiscountEligibility(sub: string): Promise<string | null> }).checkDiscountEligibility(
        subscriptionId
      ),
  };
}

// ---- refunding a multi-month prepayment ----

test("an annual charge is sent to manual review instead of being self-refunded", async () => {
  const reason = await category({ billing: annual() }).guardrails("sub_1");
  assert.ok(reason, "an annual charge must not pass the guardrails");
  assert.match(reason!, /annual/i);
});

test("a multi-month monthly plan is treated as a prepayment too", async () => {
  // interval=month with interval_count=6 buys half a year in one charge.
  const reason = await category({
    billing: monthly({ intervalCount: 6, monthsPerPeriod: 6 }),
  }).guardrails("sub_1");
  assert.match(reason!, /6-month/);
});

test("an ordinary monthly charge still self-serves", async () => {
  assert.equal(await category({ billing: monthly() }).guardrails("sub_1"), null);
});

test("a weekly plan is not a prepayment and still self-serves", async () => {
  assert.equal(
    await category({ billing: monthly({ interval: "week", monthsPerPeriod: 0 }) }).guardrails("sub_1"),
    null
  );
});

test("an unverifiable billing period fails safe to manual review", async () => {
  // The amount cap is optional and currency-scoped, so it cannot be relied on
  // to catch what this check misses. Every unknown goes to a human.
  assert.match((await category().guardrails(""))!, /could not be verified/i);
  assert.match((await category({ billing: null }).guardrails("sub_1"))!, /could not be verified/i);
  assert.match((await category({ throws: true }).guardrails("sub_1"))!, /could not be verified/i);
  assert.match(
    (await category({ billing: monthly({ monthsPerPeriod: null, interval: null }) }).guardrails("sub_1"))!,
    /could not be verified/i
  );
});

// ---- the 50% retention discount ----

test("a trialing subscriber cannot take the discount", async () => {
  // They have never been billed, so 50% off would discount a charge that
  // never happened.
  const reason = await category({ billing: monthly({ status: "trialing" }) }).discount("sub_1");
  assert.match(reason!, /trialing/);
});

test("only an active subscription is eligible", async () => {
  for (const status of ["past_due", "canceled", "incomplete", "unpaid", "paused"]) {
    const reason = await category({ billing: monthly({ status }) }).discount("sub_1");
    assert.ok(reason, `${status} must not be eligible`);
  }
  assert.equal(await category({ billing: monthly() }).discount("sub_1"), null);
});

test("an annual subscription cannot take a next-month discount", async () => {
  // "50% off your next month" on a yearly plan would take half off a year.
  assert.match((await category({ billing: annual() }).discount("sub_1"))!, /not billed monthly/);
});

test("an unreadable subscription is refused rather than discounted", async () => {
  assert.ok(await category({ billing: null }).discount("sub_1"));
  assert.ok(await category({ throws: true }).discount("sub_1"));
  assert.ok(await category().discount(""));
});
