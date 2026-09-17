import type { EvidenceFacts } from "../tokens";
import type { EvidenceTemplate } from "../renderTemplate";

// Reason-specific overrides. Each entry replaces the generic template for that
// one field; every other field still comes from GENERIC_TEMPLATES, which is
// what keeps the corpus at roughly 35 entries instead of 7 x 18.
//
// Each reason leads with the single fact that most directly answers the
// cardholder's claim, and only then tells the account story. Any sentence that
// says one date is "after" another is gated on a predicate that checks it,
// because a template cannot compare dates and a wrong "after" loses the case.

// ---- ordering predicates ----

// ISO-8601 timestamps in UTC compare correctly as strings.
const cancelledAfterCharge = (f: EvidenceFacts): boolean =>
  !!f.sub?.canceledAtIso && !!f.charge?.dateIso && f.sub.canceledAtIso > f.charge.dateIso;

// "Not cancelled before the charge" is also true of a subscription that was
// never cancelled at all, so a null cancellation date passes.
const notCancelledBeforeCharge = (f: EvidenceFacts): boolean =>
  !!f.sub && !!f.charge && (!f.sub.canceledAtIso || f.sub.canceledAtIso > f.charge.dateIso);

const siblingPrecedesCharge = (f: EvidenceFacts): boolean =>
  !!f.dup && !!f.charge && f.dup.originalDateIso < f.charge.dateIso;

const siblingFollowsCharge = (f: EvidenceFacts): boolean =>
  !!f.dup && !!f.charge && f.dup.originalDateIso > f.charge.dateIso;

// The checkout name and the customer record name agree, compared loosely so
// that case and spacing do not decide it. Only then may the text say "matches".
const checkoutNameMatchesRecord = (f: EvidenceFacts): boolean => {
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const a = norm(f.charge?.cardName);
  const b = norm(f.customer?.name);
  return a.length > 0 && a === b;
};

// ---- subscription_canceled ----
// The cardholder says they cancelled. The case turns on WHEN, on cancellation
// having been one control inside their own account, and on the subscription
// having demonstrably been used after the renewal they say they cancelled.
export const SUBSCRIPTION_CANCELED: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      {
        text:
          "Summary: this subscription had not been cancelled when the disputed charge of {{charge.amount}} was taken on {{charge.date}}. " +
          "Cancellation is a single self-service control in the Billing section of the customer's own Postiz account, needs no contact with us, and stops the next renewal. " +
          "That control had not been used before this renewal.",
        when: notCancelledBeforeCharge,
      },
      {
        text:
          "Use after the renewal: between {{charge.date}} and {{dispute.opened}}, the day this dispute was raised, " +
          "the account published {{usage.posts_after_charge}} posts through Postiz to {{usage.platforms_after_charge}}. " +
          "That is not consistent with a subscription the customer believed to be cancelled.",
      },
      {
        text: "Those posts are publicly visible at the following addresses:\n{{usage.post_url_lines_after_charge}}",
      },
      {
        text: "The account was signed into on {{usage.last_sign_in_after_charge}}, after the disputed charge.",
      },
      {
        text: "As of this response the account still has {{usage.posts_queued}} posts scheduled for future publication through Postiz.",
      },
      {
        text:
          "Account and purchase: the account is registered to {{customer.email}} and was created on {{customer.created}}. " +
          "The subscription is {{sub.plan}}, started {{sub.started}} and billed {{sub.period}}. " +
          "The disputed charge of {{charge.amount}} on {{charge.date}} paid for the {{sub.period}} period beginning that day.",
      },
      {
        text:
          "Our published documentation states that cancelling stops the next renewal and leaves the subscription active until the end of the period already paid for. " +
          "Our records show this subscription with status {{sub.status}} on {{dispute.opened}}, the day this dispute was raised.",
      },
      {
        text:
          "A cancellation was recorded on this subscription on {{sub.canceled_at}}, after the disputed charge of {{charge.date}}. " +
          "A cancellation made after a renewal does not reverse that renewal; it stops the one after it.",
        when: cancelledAfterCharge,
      },
      { text: "Account standing: {{usage.summary}}" },
      { text: "{{refund.status}}" },
      {
        text:
          "We ask that the charge stand. The renewal price and date were disclosed before purchase and remained visible in the Billing section, " +
          "the service was available for the whole period this charge paid for, and cancellation was one control inside the customer's own account.",
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
        text: "A cancellation was recorded on this subscription on {{sub.canceled_at}}, which is after the disputed charge of {{charge.date}}.",
        when: cancelledAfterCharge,
      },
      {
        text:
          "Between {{charge.date}} and {{dispute.opened}} the account published {{usage.posts_after_charge}} posts through Postiz, " +
          "so the subscription was in active use after the renewal the cardholder says they had cancelled.",
      },
      {
        text: "Those posts are publicly visible at the following addresses:\n{{usage.post_url_lines_after_charge}}",
      },
      {
        text: "The account was signed into on {{usage.last_sign_in_after_charge}}, after the disputed charge.",
      },
      {
        text:
          "Cancelling is a self-service action in the Billing section of the customer's own account. It takes effect at the end of the period already paid for, " +
          "so a cancellation made after a renewal does not reverse that renewal. " +
          "The disputed charge of {{charge.date}} paid for the {{sub.period}} period beginning that day, and the account had access to the service throughout it.",
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
          "Our refund conditions are published and applied automatically to every customer: one refund per customer, subscription charges only, " +
          "the charge under 60 days old, the amount capped at one month of the plan, and the subscription cancelled as part of the refund. " +
          "A request meeting them is granted immediately in the in-app support chat, with no wait for a member of staff. That route was open to this customer and was not used.",
      },
      { text: "{{refund.status}}" },
    ],
  },
];

// ---- credit_not_processed ----
// The cardholder says a promised refund or credit never arrived. The answer is
// the charge's actual refund state, then the fact that refunds here are issued
// on the spot or declined on the spot, so nothing can be "pending".
export const CREDIT_NOT_PROCESSED: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      { text: "Summary: no credit is outstanding on this charge. {{refund.status}}" },
      {
        text:
          "Refunds at Postiz are not promised and processed later. Under the published policy a request that meets the conditions is issued immediately by the in-app support chat, " +
          "and one that does not is declined in the same exchange with the condition that was not met. There is no state in which a refund has been agreed but not yet paid.",
      },
      {
        text:
          "The conditions, published under Refunds and support, are: one refund per customer, ever; subscription charges only; the charge under 60 days old; " +
          "the amount capped at one month of the plan, so a yearly charge is refunded at one twelfth; and the subscription cancelled as part of the refund.",
      },
      {
        text:
          "The disputed charge of {{charge.amount}} on {{charge.date}} was taken against the account registered to {{customer.email}}, " +
          "for the subscription {{sub.plan}} that started on {{sub.started}}.",
      },
      {
        text:
          "The account continued to use the service after this charge: between {{charge.date}} and {{dispute.opened}}, the day this dispute was raised, " +
          "it published {{usage.posts_after_charge}} posts through Postiz.",
      },
      {
        text: "Those posts are publicly visible at the following addresses:\n{{usage.post_url_lines_after_charge}}",
      },
      { text: "Account standing: {{usage.summary}}" },
      {
        text: "We ask that the charge stand. No credit is owed on it, and the refund route published to every customer was available to this one at all times.",
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
          "A refund request that meets the published conditions is granted on the spot in the in-app support chat, so a refund this customer qualified for would already have been issued.",
      },
      { text: "{{refund.status}}" },
    ],
  },
];

// ---- duplicate ----
// Two variants that are mutually exclusive by construction: either a
// same-amount sibling charge exists and is named, or it does not and we say so
// plainly. The sibling variant is itself split by which charge came first, so
// "days later" is never said of a charge that came earlier.
export const DUPLICATE: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 150,
    blocks: [
      {
        text:
          "Summary: the customer was not billed twice for the same period. This is a recurring subscription: each billing period is charged at the same price, " +
          "on the same card, with the same statement descriptor, so two consecutive periods look alike on a statement.",
      },
      {
        text:
          "The subscription on account {{customer.email}} is {{sub.plan}}, started {{sub.started}} and billed {{sub.period}}. " +
          "The disputed charge of {{charge.amount}} was taken on {{charge.date}}.",
      },
      {
        text: "Each charge has its own invoice. The disputed charge is invoice {{charge.invoice_number}}; the earlier charge of the same amount is invoice {{dup.original_invoice_number}}.",
      },
      { text: "Payment history on this account, oldest first:\n{{billing.history_lines}}" },
      {
        text:
          "The service was used after the disputed charge: between {{charge.date}} and {{dispute.opened}}, the day this dispute was raised, " +
          "the account published {{usage.posts_after_charge}} posts through Postiz.",
      },
      { text: "{{refund.status}}" },
      { text: "We ask that the charge stand. It paid for its own billing period, and no other charge paid for that period." },
    ],
  },
  {
    field: "duplicate_charge_explanation",
    minChars: 120,
    blocks: [
      {
        // Variant A1: a sibling charge exists and came first.
        text:
          "The two charges are separate subscription periods, not one charge taken twice. " +
          "Charge {{dup.original_charge_id}} was taken on {{dup.original_date}} for {{dup.original_amount}} and paid the subscription period beginning that day. " +
          "The disputed charge {{charge.id}} was taken on {{charge.date}}, {{dup.days_apart}} days later, and paid the following period.",
        when: siblingPrecedesCharge,
      },
      {
        // Variant A2: a sibling charge exists and came after the disputed one.
        text:
          "The two charges are separate subscription periods, not one charge taken twice. " +
          "The disputed charge {{charge.id}} was taken on {{charge.date}} and paid the subscription period beginning that day. " +
          "Charge {{dup.original_charge_id}} was taken {{dup.days_apart}} days later, on {{dup.original_date}}, for {{dup.original_amount}}, and paid the following period.",
        when: siblingFollowsCharge,
      },
      {
        text: "Each has its own invoice: {{charge.invoice_number}} for the disputed charge and {{dup.original_invoice_number}} for the other.",
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
        text: "Payment history on this account, oldest first:\n{{billing.history_lines}}",
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
// The cardholder says they did not authorise it. The strongest answer is that
// the account this charge paid for went on publishing real posts to live
// addresses after the charge. Behind that: an established account, a card that
// had paid before, and a checkout name that matches the record.
export const FRAUDULENT: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      {
        text:
          "Summary: the account this charge paid for was used after the charge was taken. Between {{charge.date}} and {{dispute.opened}}, the day this dispute was raised, " +
          "it published {{usage.posts_after_charge}} posts through Postiz to {{usage.platforms_after_charge}}. " +
          "Publishing through Postiz requires signing in to the Postiz account and connecting a social media account by logging in to that account, " +
          "so every one of those posts was made by someone who controls both the Postiz account and the social media account it went to. " +
          "That is a customer using the service they paid for, not an unauthorised charge.",
      },
      {
        text: "Those posts are publicly visible at the following addresses:\n{{usage.post_url_lines_after_charge}}",
      },
      {
        text:
          "This charge was taken under a subscription set up from inside the Postiz account registered to {{customer.email}}. " +
          "Every charge on that account follows from that subscription: a renewal takes the price shown at purchase, on the card saved to the account, on the renewal date shown in the Billing section.",
      },
      {
        // The strongest fact available on an unauthorised-use claim. Where the
        // bank authenticated the cardholder, liability has already shifted to
        // the issuer and this dispute should not have reached us at all. The
        // token resolves only on an "authenticated" result, so this paragraph
        // never appears for an attempted or failed authentication.
        text:
          "The disputed payment was {{charge.three_d_secure}} by the cardholder's own bank under 3-D Secure. " +
          "The cardholder was challenged by their issuer at the time of payment and passed that challenge, which is the issuer's own confirmation that the genuine cardholder authorised this charge.",
      },
      {
        text:
          "The card details entered at checkout were verified at the time of payment: the card security code {{charge.cvc_check}} and the billing postcode {{charge.postal_check}} the details held by the issuing bank. " +
          "Someone using a card they did not possess would not hold both.",
      },
      {
        text:
          "An earlier charge on this same card, on {{billing.same_card_3ds_date}}, was also authenticated by the cardholder with their bank under 3-D Secure. " +
          "The cardholder has therefore proved possession of this card on this account before.",
      },
      {
        text:
          "Cardholder match: the name given at checkout, {{charge.card_name}}, is the name on the customer record for {{customer.email}}, " +
          "an account created on {{customer.created}}.",
        when: checkoutNameMatchesRecord,
      },
      {
        text: "The account signs in using {{postiz.login_provider}} and is registered to the Postiz organisation {{postiz.org_name}}.",
      },
      {
        text:
          "Before this charge the account had already published {{usage.posts_before_charge}} posts through Postiz, the first on {{usage.first_post_date}}. " +
          "The account was established and in use before the disputed charge, not created for it.",
      },
      {
        text: "Social media accounts connected to this Postiz account, with the date each was connected:\n{{usage.channel_lines}}",
      },
      {
        text: "The account was most recently signed into on {{usage.last_sign_in}}.",
      },
      {
        text:
          "The disputed charge is {{charge.amount}}, taken on {{charge.date}} with a {{charge.card_brand}} card ending {{charge.card_last4}}, issued in {{charge.card_country}}.",
      },
      {
        text:
          "The same card, ending {{charge.card_last4}}, had paid {{billing.same_card_prior_count}} earlier charges on this account, the first on {{billing.same_card_first_date}}, " +
          "each with the statement descriptor {{charge.descriptor}}.",
      },
      {
        text: "In total this account has paid {{billing.paid_count}} subscription charges since {{billing.first_paid_date}}.",
      },
      { text: "{{refund.status}}" },
      {
        text: "We ask that the charge stand. It was taken on an established account, on the card saved to it, under a subscription that account's holder set up.",
      },
    ],
  },
];

// ---- unrecognized ----
// Usually a descriptor problem rather than a fraud claim: the cardholder saw a
// name on the statement and did not connect it to the product. So: which
// product the descriptor is, whose account it is, and what that account was
// visibly doing around the charge.
export const UNRECOGNIZED: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      {
        text:
          "Summary: the charge appears on the statement as {{charge.descriptor}}. That is Postiz, a social media scheduling service, " +
          "and the charge is the subscription fee on the Postiz account registered to {{customer.email}}.",
      },
      {
        text:
          "That account was in use around this charge: between {{charge.date}} and {{dispute.opened}}, the day this dispute was raised, " +
          "it published {{usage.posts_after_charge}} posts through Postiz to {{usage.platforms_after_charge}}.",
      },
      {
        text: "Those posts are publicly visible at the following addresses:\n{{usage.post_url_lines_after_charge}}",
      },
      {
        text: "Social media accounts connected to the Postiz account, with the date each was connected:\n{{usage.channel_lines}}",
      },
      {
        text: "The account was most recently signed into on {{usage.last_sign_in}}.",
      },
      {
        text:
          "The subscription on that account is {{sub.plan}}, started {{sub.started}} and billed {{sub.period}}. " +
          "The disputed charge of {{charge.amount}} was taken on {{charge.date}} and paid for the period beginning that day.",
      },
      {
        text:
          "This account has paid {{billing.paid_count}} subscription charges since {{billing.first_paid_date}}, each carrying the same descriptor. " +
          "The descriptor is the product's own name, and every earlier charge with it was accepted.",
      },
      {
        // Same liability-shift argument as the fraud reason. A cardholder who
        // authenticated with their own bank did recognise this payment.
        text:
          "The disputed payment was {{charge.three_d_secure}} by the cardholder's own bank under 3-D Secure, so the issuer itself confirmed the genuine cardholder authorised it.",
      },
      {
        text:
          "The card security code {{charge.cvc_check}} and the billing postcode {{charge.postal_check}} the details held by the issuing bank at the time of payment.",
      },
      {
        text: "The same card, ending {{charge.card_last4}}, had paid {{billing.same_card_prior_count}} earlier charges on this account, the first on {{billing.same_card_first_date}}.",
      },
      { text: "Account standing: {{usage.summary}}" },
      { text: "{{refund.status}}" },
      {
        text: "We ask that the charge stand. It is the recurring subscription fee on a Postiz account, at a price disclosed at purchase and shown in that account's Billing section, and both cancellation and a policy-compliant refund were available from inside the account at any time.",
      },
    ],
  },
];

// ---- product_not_received ----
// Software delivered online, so there is no delivery step that can fail. The
// answer is what the account did with the service after paying, and the
// shipping fields are deliberately left empty rather than invented.
export const PRODUCT_NOT_RECEIVED: EvidenceTemplate[] = [
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      {
        text:
          "Summary: Postiz is software delivered online. There is no shipment and no delivery step. " +
          "When the payment on {{charge.date}} succeeded, the subscription {{sub.plan}} became active on the account registered to {{customer.email}} and the customer could sign in and use it.",
      },
      {
        text:
          "The service was received and used: between {{charge.date}} and {{dispute.opened}}, the day this dispute was raised, " +
          "the account published {{usage.posts_after_charge}} posts through Postiz to {{usage.platforms_after_charge}}.",
      },
      {
        text: "Those posts are publicly visible at the following addresses:\n{{usage.post_url_lines_after_charge}}",
      },
      {
        text: "During that time {{usage.channels_during_period}} social media channels were connected to the account.",
      },
      {
        text: "The account was signed into on {{usage.last_sign_in_after_charge}}, after the disputed charge.",
      },
      {
        text:
          "The subscription on that account started on {{sub.started}}, and its status on {{dispute.opened}} was {{sub.status}}.",
      },
      { text: "Account standing: {{usage.summary}}" },
      {
        text:
          "The shipping fields of this response are empty because this is software delivered online, not a physical good. " +
          "There is no carrier, no tracking number and no delivery address associated with this charge.",
      },
      { text: "{{refund.status}}" },
      {
        text: "We ask that the charge stand. Access to the service was granted the moment the payment succeeded and remained available for the whole period paid for.",
      },
    ],
  },
];
