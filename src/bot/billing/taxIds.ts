// Tax-ID helpers shared by the /billing Address dialog and the support
// dashboard's change requests.

// Curated tax-ID types: the Stripe union is 100+ entries; support
// workflows need these. Server-side membership check beats trusting the select.
export const TAX_ID_TYPES = [
  { value: "eu_vat", label: "EU VAT" },
  { value: "gb_vat", label: "GB VAT" },
  { value: "us_ein", label: "US EIN" },
  { value: "ch_vat", label: "CH VAT" },
  { value: "no_vat", label: "NO VAT" },
  { value: "au_abn", label: "AU ABN" },
  { value: "ca_bn", label: "CA BN" },
  { value: "ca_gst_hst", label: "CA GST/HST" },
  { value: "in_gst", label: "IN GST" },
  { value: "jp_cn", label: "JP CN" },
  { value: "nz_gst", label: "NZ GST" },
  { value: "sg_gst", label: "SG GST" },
  { value: "br_cnpj", label: "BR CNPJ" },
  { value: "mx_rfc", label: "MX RFC" },
  { value: "tr_tin", label: "TR TIN" },
];

export function taxTypeLabel(type: string): string {
  return TAX_ID_TYPES.find((t) => t.value === type)?.label ?? type.replace(/_/g, " ").toUpperCase();
}

// The select value that asks the server to work the type out from the number.
export const TAX_TYPE_DETECT = "detect";

// VAT numbers carry their country: an EU member prefix (Greece writes EL,
// Northern Ireland XI) is an EU VAT number, GB a UK one, CHE Swiss, NO…MVA
// Norwegian. Anything else (an EIN, an ABN) has no prefix to read and needs
// its type picked.
const EU_VAT_PREFIXES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT",
  "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
]);
export function detectTaxIdType(value: string): string | null {
  const v = value.toUpperCase();
  if (/^CHE[0-9]/.test(v)) return "ch_vat";
  if (/^NO[0-9]{9}(MVA)?$/.test(v)) return "no_vat";
  if (/^GB[0-9]/.test(v)) return "gb_vat";
  const prefix = v.slice(0, 2);
  if (EU_VAT_PREFIXES.has(prefix) && /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(v)) return "eu_vat";
  return null;
}

// Stripe validates every format itself; this only keeps junk out of the call.
// VAT-style numbers lose their spaces and dots so "HU 3207 2121" and
// "HU32072121" are the same number when diffing against what Stripe holds.
export function normalizeTaxIdValue(type: string, raw: string): string {
  const v = raw.trim();
  return /_(vat|gst|hst)$/.test(type) || type === "ch_vat" ? v.replace(/[\s.]/g, "").toUpperCase() : v;
}

// A VAT number in Stripe's sense: eu_vat, gb_vat, ch_vat, no_vat and the other
// *_vat types. The support dashboard edits exactly one of these per customer.
export function isVatType(type: string): boolean {
  return /_vat$/.test(type);
}
