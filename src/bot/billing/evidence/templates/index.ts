import type { EvidenceTemplate } from "../renderTemplate";
import { GENERIC_TEMPLATES } from "./generic";
import {
  CREDIT_NOT_PROCESSED,
  DUPLICATE,
  FRAUDULENT,
  PRODUCT_NOT_RECEIVED,
  SUBSCRIPTION_CANCELED,
  UNRECOGNIZED,
} from "./reasons";

// Stamped onto every dispute the pack builder touches, so a package submitted
// months ago can be traced to the wording that produced it. Bump it whenever
// the corpus changes in a way that would alter a rendered field.
export const TEMPLATE_VERSION = "2026-09-17.1";

export type PackReason =
  | "general"
  | "subscription_canceled"
  | "credit_not_processed"
  | "duplicate"
  | "fraudulent"
  | "unrecognized"
  | "product_not_received";

export const PACK_REASONS: readonly PackReason[] = [
  "general",
  "subscription_canceled",
  "credit_not_processed",
  "duplicate",
  "fraudulent",
  "unrecognized",
  "product_not_received",
];

// Every Stripe dispute reason that is not its own variant falls back to
// "general", which is the full generic corpus. bank_cannot_process,
// debit_not_authorized, insufficient_funds, product_unacceptable,
// customer_initiated, check_returned, incorrect_account_details, noncompliant
// and general all land here deliberately: none of them needs a different story
// from "this is a subscription the customer held and used".
export function packReasonFor(reason: string | null | undefined): PackReason {
  const r = (reason ?? "").toLowerCase();
  return (PACK_REASONS as readonly string[]).includes(r) && r !== "general" ? (r as PackReason) : "general";
}

const BY_REASON: Record<PackReason, EvidenceTemplate[]> = {
  general: [],
  subscription_canceled: SUBSCRIPTION_CANCELED,
  credit_not_processed: CREDIT_NOT_PROCESSED,
  duplicate: DUPLICATE,
  fraudulent: FRAUDULENT,
  unrecognized: UNRECOGNIZED,
  product_not_received: PRODUCT_NOT_RECEIVED,
};

export const TEMPLATE_LIBRARY: Record<PackReason, Record<string, EvidenceTemplate>> = Object.fromEntries(
  PACK_REASONS.map((reason) => [reason, Object.fromEntries(BY_REASON[reason].map((t) => [t.field, t]))])
) as Record<PackReason, Record<string, EvidenceTemplate>>;

const GENERIC_BY_FIELD: Record<string, EvidenceTemplate> = Object.fromEntries(
  GENERIC_TEMPLATES.map((t) => [t.field, t])
);

// Per-FIELD fallback, not per-reason: a reason file only carries the fields
// whose voice actually differs, and everything else inherits. `overrides` is
// the DB layer, checked first so an operator edit wins over the shipped text.
export function templateFor(
  reason: PackReason,
  field: string,
  overrides?: Map<string, EvidenceTemplate>
): EvidenceTemplate | null {
  return (
    overrides?.get(`${reason}:${field}`) ??
    overrides?.get(`general:${field}`) ??
    TEMPLATE_LIBRARY[reason]?.[field] ??
    GENERIC_BY_FIELD[field] ??
    null
  );
}

// Which fields a pack attempts, per reason.
//
// This is deliberately NOT recommendedGroupKeys(): that drives the star in both
// editors and must keep doing so, but it returns the shipping group for
// product_not_received, and every shipping field is unfillable for software
// delivered online. A templated shipping_carrier would be empty or a lie.
//
// customer_purchase_ip is absent from every pack for a different reason: the
// payment's client IP is not exposed by any Stripe API object (see
// StripeClient), so it can only ever be entered by hand.
const CORE_FIELDS = [
  "product_description",
  "customer_email_address",
  "service_date",
  "access_activity_log",
  "uncategorized_text",
  "customer_name",
  "billing_address",
  "refund_policy_disclosure",
  "cancellation_policy_disclosure",
];

export const PACK_FIELDS_BY_REASON: Record<PackReason, string[]> = {
  general: CORE_FIELDS,
  subscription_canceled: [...CORE_FIELDS, "cancellation_rebuttal", "refund_refusal_explanation"],
  credit_not_processed: [...CORE_FIELDS, "refund_refusal_explanation"],
  duplicate: [...CORE_FIELDS, "duplicate_charge_explanation", "duplicate_charge_id"],
  // The customer-identity fields already in CORE_FIELDS carry these two cases.
  fraudulent: CORE_FIELDS,
  unrecognized: CORE_FIELDS,
  product_not_received: CORE_FIELDS,
};

// Weights for the completeness score. One shipped constant so the score a human
// sees, the auto-submit gate and the Grafana fields_filled ratio can never
// drift apart. Weighted by how much each field actually moves a bank analyst:
// the narrative and the account record win cases, a name and an address do not.
export const FIELD_WEIGHTS: Record<string, number> = {
  product_description: 20,
  uncategorized_text: 20,
  access_activity_log: 15,
  duplicate_charge_id: 15,
  duplicate_charge_explanation: 10,
  cancellation_rebuttal: 10,
  refund_refusal_explanation: 10,
  refund_policy_disclosure: 10,
  cancellation_policy_disclosure: 10,
  customer_email_address: 10,
  service_date: 10,
  customer_name: 5,
  billing_address: 5,
};

export { GENERIC_TEMPLATES };
