import type { EvidenceTemplate } from "../renderTemplate";

// Reason-specific overrides. Each file entry replaces the generic template for
// that one field; every other field still comes from GENERIC_TEMPLATES, which
// is what keeps the corpus at roughly 35 entries instead of 7 x 18.

// ---- subscription_canceled ----
// The customer says they cancelled. The case turns on WHEN, and on cancellation
// having been available to them without contacting us.
export const SUBSCRIPTION_CANCELED: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      {
        text:
          "Summary: this is a recurring subscription charge for software the customer held an active, working subscription to on the day it was taken. " +
          "The subscription had not been cancelled when it renewed.",
      },
      {
        text:
          "Account and purchase: the account is registered to {{customer.email}} and was created on {{customer.created}}. " +
          "The {{sub.plan}} subscription started on {{sub.started}} and has been billed {{sub.period}} since. " +
          "The disputed charge of {{charge.amount}} was taken on {{charge.date}} and paid for the period beginning that day.",
      },
      {
        text:
          "Cancellation required no contact with us. The Billing section of the customer's own account carries a cancellation control, available at any time. " +
          "Our published documentation states that cancelling stops the next renewal and leaves the subscription active until the end of the period already paid for. " +
          "Our records show this subscription with status {{sub.status}} on {{dispute.opened}}, the day this dispute was raised.",
      },
      { text: "Use of the service: {{usage.summary}}" },
      { text: "{{refund.status}}" },
      {
        text:
          "We ask that the charge stand. The service was available for the whole period this charge paid for, the renewal price and date were disclosed before purchase, " +
          "and cancellation was a single control inside the customer's own account.",
      },
    ],
  },
  {
    field: "cancellation_rebuttal",
    minChars: 150,
    blocks: [
      {
        text:
          "The subscription was not cancelled before the disputed renewal. On {{dispute.opened}}, the day this dispute was raised, " +
          "our records show the subscription for account {{customer.email}} with status {{sub.status}}.",
      },
      {
        text:
          "A cancellation was recorded on this subscription on {{sub.canceled_at}}, which is after the disputed charge of {{charge.date}}.",
      },
      {
        text:
          "Cancelling is a self-service action in the customer's own Billing section and takes effect at the end of the period already paid for, " +
          "so a cancellation made after a renewal does not reverse that renewal. " +
          "The period this charge paid for ran from {{sub.period_start}} to {{sub.period_end}}, and the account had access to the service throughout it.",
      },
    ],
  },
  {
    field: "refund_refusal_explanation",
    minChars: 120,
    stage: "enrich",
    requires: ["support.no_refund_request"],
    blocks: [
      {
        text:
          "No refund was refused on this charge, because no refund was requested. " +
          "We have no record of a refund request from this customer, in the in-app support chat or by email, before this dispute was raised on {{dispute.opened}}.",
      },
      {
        text:
          "Our refund conditions are published and are applied automatically to every customer: one refund per customer, subscription charges only, " +
          "under 60 days old, capped at one month of the plan, with the subscription cancelled as part of the refund. " +
          "A request meeting them is granted immediately in the in-app support chat, with no wait for a member of staff.",
      },
      { text: "{{refund.status}}" },
    ],
  },
];

// ---- credit_not_processed ----
// The customer says a promised refund or credit never arrived.
export const CREDIT_NOT_PROCESSED: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      { text: "Summary: no credit is outstanding on this charge. {{refund.status}}" },
      {
        text:
          "Our refund conditions are published in the Postiz Cloud documentation and are applied automatically and identically to every customer: " +
          "one refund per customer, subscription charges only, the charge under 60 days old, the amount capped at one month of the plan, " +
          "and the subscription cancelled as part of the refund. A request that meets those conditions is granted immediately in the in-app support chat, " +
          "without waiting for a member of staff.",
      },
      {
        text:
          "The disputed charge of {{charge.amount}} was taken on {{charge.date}} against the account registered to {{customer.email}}, " +
          "for the {{sub.plan}} subscription that started on {{sub.started}}.",
      },
      { text: "Use of the service: {{usage.summary}}" },
    ],
  },
  {
    field: "refund_refusal_explanation",
    minChars: 120,
    stage: "enrich",
    requires: ["support.no_refund_request"],
    blocks: [
      {
        text:
          "No refund was refused on this charge, because no refund was requested. " +
          "We have no record of a refund request from this customer, in the in-app support chat or by email, before this dispute was raised on {{dispute.opened}}.",
      },
      { text: "{{refund.status}}" },
    ],
  },
];

// ---- duplicate ----
// Two variants that are mutually exclusive by construction: either a
// same-amount sibling charge exists, or it does not and we say so plainly.
export const DUPLICATE: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 150,
    blocks: [
      {
        text:
          "Summary: the customer was not billed twice for the same thing. This is a recurring subscription, so successive periods are charged at the same price and appear identically on a statement.",
      },
      {
        text:
          "The {{sub.plan}} subscription on account {{customer.email}} started on {{sub.started}} and is billed {{sub.period}}. " +
          "The disputed charge of {{charge.amount}} was taken on {{charge.date}}.",
      },
      { text: "Complete payment history on this account:\n{{billing.history_lines}}" },
      { text: "{{refund.status}}" },
    ],
  },
  {
    field: "duplicate_charge_explanation",
    minChars: 120,
    blocks: [
      {
        // Variant A: a real sibling charge exists and is named.
        text:
          "The two charges are separate subscription periods, not one charge taken twice. " +
          "Charge {{dup.original_charge_id}} was taken on {{dup.original_date}} for {{dup.original_amount}} and paid the subscription period beginning that day. " +
          "The disputed charge {{charge.id}} was taken on {{charge.date}}, {{dup.days_apart}} days later, and paid the following period.",
      },
      {
        text:
          "Both appear on the statement as {{charge.descriptor}} and are for the same amount because they are the same recurring subscription, billed {{sub.period}} at the same price.",
        alsoNeeds: ["dup.original_charge_id"],
      },
      {
        // Variant B: no candidate exists at all, so there is nothing to compare
        // against and duplicate_charge_id is omitted by PACK_FIELDS gating.
        text:
          "Only one charge of {{charge.amount}} exists on this account: {{charge.id}}, taken on {{charge.date}}. " +
          "No second charge of that amount was taken, so nothing was billed twice.",
        when: (f) => !f.dup,
      },
      {
        text: "The complete payment history on this account is:\n{{billing.history_lines}}",
        when: (f) => !f.dup,
      },
    ],
  },
  {
    field: "duplicate_charge_id",
    minChars: 1,
    requires: ["dup.original_charge_id"],
    blocks: [{ text: "{{dup.original_charge_id}}" }],
  },
];

// ---- fraudulent ----
// The cardholder says they did not authorise it. The case is that the charge
// came from an established, authenticated account whose card had paid before.
export const FRAUDULENT: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      {
        text:
          "Summary: this charge was made by the authenticated holder of an existing account, not by an unknown third party. " +
          "The card used had been entered into that account by its owner and had paid earlier charges on it.",
      },
      {
        text:
          "Cardholder match: the name given at checkout, {{charge.card_name}}, and the billing address held for the account match the details on record for {{customer.email}}, " +
          "an account created on {{customer.created}} and signed in with {{postiz.login_provider}}.",
      },
      {
        text:
          "Payment history: this account has paid {{billing.paid_count}} charges since {{billing.first_paid_date}}, all with the same statement descriptor {{charge.descriptor}}, " +
          "and none of the earlier charges was disputed.",
      },
      { text: "Use of the service: {{usage.summary}}" },
      {
        text:
          "The disputed charge is {{charge.amount}}, taken on {{charge.date}} using a {{charge.card_brand}} card ending {{charge.card_last4}} issued in {{charge.card_country}}. " +
          "The same card and the same account details were used for the earlier, undisputed charges described above.",
      },
      { text: "{{refund.status}}" },
    ],
  },
];

// ---- unrecognized ----
// Usually a descriptor problem rather than a fraud claim, so the descriptor is
// addressed first and the rest of the fraud case follows.
export const UNRECOGNIZED: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      {
        text:
          "Summary: the charge appears on the statement as {{charge.descriptor}}. That descriptor belongs to Postiz, the social media scheduling service " +
          "the customer subscribed to with the account registered to {{customer.email}}.",
      },
      {
        text:
          "The {{sub.plan}} subscription on that account started on {{sub.started}} and is billed {{sub.period}}. " +
          "The disputed charge of {{charge.amount}} was taken on {{charge.date}} and paid for the period beginning that day.",
      },
      {
        text:
          "Payment history: this account has paid {{billing.paid_count}} charges since {{billing.first_paid_date}}, all carrying the same descriptor, and none of the earlier ones was disputed. " +
          "A descriptor a cardholder does not recognise on one charge, having accepted it on every previous charge, is most often a matter of the trading name differing from the product name.",
      },
      { text: "Use of the service: {{usage.summary}}" },
      { text: "{{refund.status}}" },
    ],
  },
];

// ---- product_not_received ----
// Software delivered online, so there is no delivery step that can fail, and
// the shipping fields are deliberately left empty rather than invented.
export const PRODUCT_NOT_RECEIVED: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      {
        text:
          "Summary: Postiz is delivered over the internet and access is immediate. There is no shipment and no delivery step that can fail. " +
          "When the payment on {{charge.date}} succeeded, the {{sub.plan}} plan became active on the account registered to {{customer.email}} and the customer could sign in and use it.",
      },
      {
        text:
          "The subscription on that account started on {{sub.started}} and its status on {{dispute.opened}}, the day this dispute was raised, was {{sub.status}}. " +
          "Nothing in our records shows the account being unable to reach the service.",
      },
      { text: "Use of the service after the charge: {{usage.summary}}" },
      {
        text:
          "The shipping fields of this response are empty because this is software delivered online, not a physical good. " +
          "There is no carrier, no tracking number and no delivery address associated with this charge.",
      },
      { text: "{{refund.status}}" },
    ],
  },
];
