import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { changedFields, detailsOf, parseDetailsInput, parseStoredDetails, type CustomerDetails } from "../../bot/billing/customerDetails";
import { actionByKey, CUSTOMER_UPDATE_DETAILS, type ActionExecCtx } from "../../bot/billing/actions/ActionRegistry";

// The support dashboard's change request: what the dialog accepts, how a
// stored request is read back, and the registry action an admin approves
// (applied only while the customer still matches what the teammate saw).

const BEFORE: CustomerDetails = {
  name: "Nordlicht Media GmbH",
  line1: "Schillerstraße 14",
  line2: "",
  postal: "10625",
  city: "Berlin",
  state: "",
  country: "DE",
  vat: null,
};

test("the dialog needs a country for an address and a country prefix on a VAT ID", () => {
  const noCountry = parseDetailsInput({ ...BEFORE, country: "", vat: "" }, null);
  assert.equal(noCountry.ok, false);
  const badVat = parseDetailsInput({ ...BEFORE, vat: "312345678" }, null);
  assert.equal(badVat.ok, false);
  assert.equal(!badVat.ok && badVat.field, "vat");
  const ok = parseDetailsInput({ ...BEFORE, vat: "de 312.345.678" }, null);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.value.vat, { type: "eu_vat", value: "DE312345678" });
});

test("an unchanged VAT ID keeps the type it already has", () => {
  const res = parseDetailsInput({ ...BEFORE, vat: "4012345678" }, { type: "za_vat", value: "4012345678" });
  assert.ok(res.ok);
  assert.deepEqual(res.ok && res.value.vat, { type: "za_vat", value: "4012345678" });
});

test("changes are reported per field", () => {
  const after = { ...BEFORE, line1: "Torstraße 109", postal: "10119", vat: { type: "eu_vat", value: "DE312345678" } };
  assert.deepEqual(changedFields(BEFORE, after), ["address", "vat"]);
  assert.deepEqual(changedFields(BEFORE, { ...BEFORE }), []);
});

test("a stored request reads back exactly and junk does not", () => {
  const after = { ...BEFORE, vat: { type: "eu_vat", value: "DE312345678" } };
  assert.deepEqual(parseStoredDetails(JSON.parse(JSON.stringify(after))), after);
  assert.equal(parseStoredDetails({ ...BEFORE, vat: { type: "us_ein", value: "12-3456789" } }), null, "only *_vat types");
  assert.equal(parseStoredDetails({ ...BEFORE, country: "XX" }), null);
  assert.equal(parseStoredDetails("nope"), null);
});

test("detailsOf reads the first VAT tax ID and ignores other types", () => {
  const customer = {
    name: "Nordlicht Media GmbH",
    address: { line1: "Schillerstraße 14", line2: null, postal_code: "10625", city: "Berlin", state: null, country: "DE" },
  } as unknown as Stripe.Customer;
  const taxIds = [
    { id: "txi_1", type: "us_ein", value: "12-3456789" },
    { id: "txi_2", type: "eu_vat", value: "DE 312 345 678" },
  ] as unknown as Stripe.TaxId[];
  assert.deepEqual(detailsOf(customer, taxIds), { ...BEFORE, vat: { type: "eu_vat", value: "DE312345678" } });
});

// ---- the registry action ----

function fakeCtx(state: { customer: CustomerDetails; taxIds: Array<{ id: string; type: string; value: string }>; failUpdate?: boolean }) {
  const calls: string[] = [];
  const stripe = {
    getCustomer: async () => ({
      id: "cus_A1",
      name: state.customer.name,
      address: {
        line1: state.customer.line1,
        line2: state.customer.line2,
        postal_code: state.customer.postal,
        city: state.customer.city,
        state: state.customer.state,
        country: state.customer.country,
      },
    }),
    listTaxIds: async () => state.taxIds,
    addTaxId: async (_c: string, type: string, value: string) => {
      calls.push(`add:${value}`);
      const t = { id: `txi_${state.taxIds.length + 10}`, type, value };
      state.taxIds.push(t);
      return t;
    },
    removeTaxId: async (_c: string, id: string) => {
      calls.push(`remove:${id}`);
      state.taxIds = state.taxIds.filter((t) => t.id !== id);
    },
    updateCustomer: async (_c: string, params: Record<string, unknown>) => {
      calls.push(`update:${Object.keys(params).join(",")}`);
      if (state.failUpdate) throw new Error("boom");
    },
  };
  const ctx = { stripe, stripeCustomerId: "cus_A1", actor: { kind: "support", id: "1", name: "Mara", isAdmin: false } } as unknown as ActionExecCtx;
  return { ctx, calls };
}

const def = actionByKey(CUSTOMER_UPDATE_DETAILS)!;
const raw = (after: CustomerDetails) => ({ customerId: "cus_A1", before: BEFORE, after, reason: "Customer asked", intercomRef: "146041426", customerName: "Nordlicht" });

test("the action is queued for approval by default and needs no typed CONFIRM", () => {
  assert.equal(def.defaultLevel, "approval");
  assert.equal(def.dangerous, false);
  assert.equal(def.refusalIsFinal, true);
});

test("the action refuses a request with no change or no reason", () => {
  assert.equal(def.parseParams(raw(BEFORE)).ok, false);
  assert.equal(def.parseParams({ ...raw({ ...BEFORE, name: "X" }), reason: "" }).ok, false);
});

test("approval refuses when the customer changed since the request", async () => {
  const after = { ...BEFORE, name: "Nordlicht GmbH" };
  const parsed = def.parseParams(raw(after));
  assert.ok(parsed.ok);
  const { ctx } = fakeCtx({ customer: { ...BEFORE, city: "Hamburg" }, taxIds: [] });
  assert.match(String(await def.revalidate(ctx, parsed.ok && parsed.params)), /Changed since requested: Address/);
  const fresh = fakeCtx({ customer: { ...BEFORE }, taxIds: [] });
  assert.equal(await def.revalidate(fresh.ctx, parsed.ok && parsed.params), null);
});

test("approval adds the new VAT ID first and removes the old one last", async () => {
  const before = { ...BEFORE, vat: { type: "eu_vat", value: "DE111111111" } };
  const after = { ...BEFORE, line1: "Torstraße 109", vat: { type: "eu_vat", value: "DE312345678" } };
  const parsed = def.parseParams({ ...raw(after), before });
  assert.ok(parsed.ok);
  const { ctx, calls } = fakeCtx({ customer: before, taxIds: [{ id: "txi_old", type: "eu_vat", value: "DE111111111" }] });
  const res = await def.execute(ctx, parsed.ok && parsed.params);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, ["add:DE312345678", "update:address", "remove:txi_old"]);
});

test("a failed update takes the new VAT ID back out", async () => {
  const after = { ...BEFORE, name: "New name", vat: { type: "eu_vat", value: "DE312345678" } };
  const parsed = def.parseParams(raw(after));
  assert.ok(parsed.ok);
  const state = { customer: { ...BEFORE }, taxIds: [] as Array<{ id: string; type: string; value: string }>, failUpdate: true };
  const { ctx, calls } = fakeCtx(state);
  const res = await def.execute(ctx, parsed.ok && parsed.params);
  assert.equal(res.ok, false);
  assert.deepEqual(calls, ["add:DE312345678", "update:name", "remove:txi_10"]);
  assert.equal(state.taxIds.length, 0);
});
