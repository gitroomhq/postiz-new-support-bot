import type Stripe from "stripe";
import { countryName, isCountryCode } from "../../dashboard/sections/countries";
import { detectTaxIdType, isVatType, normalizeTaxIdValue } from "./taxIds";

// The part of a Stripe customer the support dashboard may ask to change: the
// name, the billing address and one VAT ID. A change request stores what the
// teammate saw (`before`) next to what they asked for (`after`); approval
// applies it only while the customer still matches `before`.

export interface CustomerDetails {
  name: string;
  line1: string;
  line2: string;
  postal: string;
  city: string;
  state: string;
  country: string; // ISO alpha-2, "" for none
  vat: { type: string; value: string } | null;
}

export type DetailField = "name" | "address" | "vat";

const ADDRESS_KEYS = ["line1", "line2", "postal", "city", "state", "country"] as const;

// The customer's VAT ID as support sees it: the first *_vat tax ID. Other tax
// ID types (an EIN, an ABN) are not support's to change and stay untouched.
export function primaryVat(taxIds: Stripe.TaxId[]): Stripe.TaxId | null {
  return taxIds.find((t) => isVatType(t.type)) ?? null;
}

export function detailsOf(customer: Stripe.Customer, taxIds: Stripe.TaxId[]): CustomerDetails {
  const a = customer.address;
  const vat = primaryVat(taxIds);
  return {
    name: (customer.name ?? "").trim(),
    line1: (a?.line1 ?? "").trim(),
    line2: (a?.line2 ?? "").trim(),
    postal: (a?.postal_code ?? "").trim(),
    city: (a?.city ?? "").trim(),
    state: (a?.state ?? "").trim(),
    country: (a?.country ?? "").trim().toUpperCase(),
    vat: vat ? { type: vat.type, value: normalizeTaxIdValue(vat.type, vat.value) } : null,
  };
}

export function changedFields(a: CustomerDetails, b: CustomerDetails): DetailField[] {
  const out: DetailField[] = [];
  if (a.name !== b.name) out.push("name");
  if (ADDRESS_KEYS.some((k) => a[k] !== b[k])) out.push("address");
  const va = a.vat ? `${a.vat.type}:${a.vat.value}` : "";
  const vb = b.vat ? `${b.vat.type}:${b.vat.value}` : "";
  if (va !== vb) out.push("vat");
  return out;
}

export const FIELD_LABEL: Record<DetailField, string> = { name: "Name", address: "Address", vat: "VAT ID" };

export function fieldList(fields: DetailField[]): string {
  return fields.map((f) => FIELD_LABEL[f]).join(", ");
}

// One line: "Torstraße 109, 10119 Berlin, DE".
export function addressText(d: CustomerDetails): string {
  const parts = [d.line1, d.line2, [d.postal, d.city].filter(Boolean).join(" "), d.state, d.country].filter(Boolean);
  return parts.join(", ");
}

// Several lines, the country spelled out, as an invoice prints it.
export function addressLines(d: CustomerDetails): string {
  return [d.line1, d.line2, [d.postal, d.city].filter(Boolean).join(" "), d.state, countryName(d.country)]
    .filter(Boolean)
    .join("\n");
}

export function fieldValue(d: CustomerDetails, f: DetailField): string {
  if (f === "name") return d.name || "None";
  if (f === "address") return addressText(d) || "None";
  return d.vat?.value || "None";
}

function cleanStr(v: unknown, max: number): string | null {
  if (v == null) return "";
  if (typeof v !== "string" || v.length > max) return null;
  return v.trim();
}

// Read the dialog's fields (or a stored request) into CustomerDetails. Every
// field is prefilled in the dialog, so a blank field means "clear it".
// `knownVat` keeps the type of a VAT ID already on the customer when the
// number is unchanged, so an uncurated type (za_vat) survives a save.
export function parseDetailsInput(
  raw: Record<string, unknown>,
  knownVat: { type: string; value: string } | null
): { ok: true; value: CustomerDetails } | { ok: false; error: string; field?: string } {
  const name = cleanStr(raw.name, 256);
  const line1 = cleanStr(raw.line1, 200);
  const line2 = cleanStr(raw.line2, 200);
  const postal = cleanStr(raw.postal, 40);
  const city = cleanStr(raw.city, 200);
  const state = cleanStr(raw.state, 200);
  const countryRaw = cleanStr(raw.country, 2);
  const vatRaw = cleanStr(raw.vat, 40);
  if (name == null || line1 == null || line2 == null || postal == null || city == null || state == null || countryRaw == null || vatRaw == null) {
    return { ok: false, error: "A field is too long." };
  }
  const country = countryRaw.toUpperCase();
  if (country && !isCountryCode(country)) return { ok: false, error: "Pick a country from the list.", field: "country" };
  if ([line1, line2, postal, city, state].some(Boolean) && !country) {
    return { ok: false, error: "Pick a country for the address.", field: "country" };
  }

  let vat: CustomerDetails["vat"] = null;
  if (vatRaw) {
    const compact = vatRaw.replace(/[\s.]/g, "").toUpperCase();
    const keep = knownVat && normalizeTaxIdValue(knownVat.type, knownVat.value) === compact ? knownVat.type : null;
    const type = keep ?? detectTaxIdType(compact);
    if (!type) return { ok: false, error: "Start the VAT ID with its country prefix (DE, FR, GB, CHE, NO and so on).", field: "vat" };
    const value = normalizeTaxIdValue(type, compact);
    if (!/^[A-Z0-9]{4,20}$/.test(value)) return { ok: false, error: "That VAT ID has the wrong shape.", field: "vat" };
    vat = { type, value };
  }
  return { ok: true, value: { name, line1, line2, postal, city, state, country, vat } };
}

// A stored request's details, checked again (the row is data from the DB, the
// shape a hostile client once sent).
export function parseStoredDetails(raw: unknown): CustomerDetails | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const vatObj = o.vat && typeof o.vat === "object" && !Array.isArray(o.vat) ? (o.vat as Record<string, unknown>) : null;
  if (o.vat != null && !vatObj) return null;
  const vat =
    vatObj && typeof vatObj.type === "string" && typeof vatObj.value === "string" && isVatType(vatObj.type)
      ? { type: vatObj.type.slice(0, 20), value: vatObj.value.slice(0, 40) }
      : null;
  if (vatObj && !vat) return null;
  const parsed = parseDetailsInput({ ...o, vat: vat?.value ?? "" }, vat);
  if (!parsed.ok) return null;
  // The stored type wins: parseDetailsInput only re-detects when it has to.
  return { ...parsed.value, vat };
}

// The Stripe address param for a details value ("" clears it).
export function stripeAddress(d: CustomerDetails): Stripe.AddressParam | "" {
  const empty = ADDRESS_KEYS.every((k) => !d[k]);
  if (empty) return "";
  return { line1: d.line1, line2: d.line2, postal_code: d.postal, city: d.city, state: d.state, country: d.country };
}
