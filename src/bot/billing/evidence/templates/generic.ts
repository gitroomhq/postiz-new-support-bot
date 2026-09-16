import type { EvidenceTemplate } from "../renderTemplate";

// The fields every dispute reason inherits unless it overrides them. Written
// for a bank analyst who skims: short paragraphs, the strongest fact first, no
// marketing language, and nothing that is not provable from the fact bag or
// from Postiz's published documentation.
//
// The policy paragraphs below paraphrase the real published pages (Refunds and
// support, Managing your subscription, Plans and limits). They must stay
// faithful to them: describing a policy we do not actually operate is the one
// way this file can lose a case on its own.

export const GENERIC_TEMPLATES: EvidenceTemplate[] = [
  {
    field: "product_description",
    minChars: 200,
    blocks: [
      {
        text:
          "Postiz is a social media scheduling application, sold as a paid subscription and delivered entirely over the internet. " +
          "A subscriber connects their own social media accounts, writes posts in the editor, and Postiz publishes them on a schedule to those accounts. " +
          "Access begins immediately on payment. There is no physical product and nothing is shipped.",
      },
      {
        text:
          "The customer was subscribed to the {{sub.plan}} plan, billed {{sub.period}}. " +
          "That plan allows {{plan.channels}} connected social channels and unlimited posts per month. " +
          "Its price and contents are published on the Postiz pricing page and were displayed in the plan picker the customer used to subscribe.",
      },
      {
        text:
          "The disputed charge of {{charge.amount}}, taken on {{charge.date}}, is the subscription fee for that plan. " +
          "It appears on the cardholder's statement as {{charge.descriptor}}.",
      },
    ],
  },
  {
    field: "access_activity_log",
    minChars: 120,
    blocks: [
      {
        text: "Account and service record for {{customer.email}}:",
      },
      {
        text: "The customer's account was created on {{customer.created}}.",
      },
      {
        text:
          "The account is registered to the Postiz organisation {{postiz.org_name}}, signs in using {{postiz.login_provider}}, " +
          "and the platform records the plan on it as {{postiz.tier}}.",
      },
      {
        text:
          "The {{sub.plan}} subscription started on {{sub.started}} and is billed {{sub.period}}. " +
          "Its status on {{dispute.opened}}, the day this dispute was raised, was {{sub.status}}.",
      },
      {
        text: "Payment history on this account:\n{{billing.history_lines}}",
      },
      {
        text:
          "The disputed charge {{charge.id}}, {{charge.amount}} taken on {{charge.date}}, is the {{billing.ordinal}} payment in that sequence, " +
          "and was taken on the same day of the billing cycle as the payments before it.",
      },
    ],
  },
  {
    field: "refund_policy_disclosure",
    minChars: 200,
    blocks: [
      {
        text:
          "Postiz publishes its refund policy in the Postiz Cloud documentation, under Refunds and support, and applies it automatically and identically to every customer. " +
          "The conditions are fixed: one refund per customer, the charge must be a subscription charge rather than a one-off, " +
          "the charge must be less than 60 days old, the amount is capped at one month of the plan so that a yearly charge is refunded at one twelfth, " +
          "and the subscription is cancelled as part of the refund.",
      },
      {
        text:
          "A customer whose request meets those conditions is refunded immediately from the in-app support chat, without waiting for a member of staff. " +
          "Where a request falls outside them, the chat states which condition was not met. " +
          "Billing questions are also answered by email at support@postiz.com.",
      },
    ],
  },
  {
    field: "cancellation_policy_disclosure",
    minChars: 200,
    blocks: [
      {
        text:
          "Cancellation is self-service and available at any time to the organisation admin, in the Billing section of the customer's own account. " +
          "No email, chat message or notice period is required, and no cancellation fee is charged.",
      },
      {
        text:
          "The published documentation, under Managing your subscription, states what cancelling does: the subscription stays active until the end of the period already paid for, " +
          "nothing stops immediately, and cancelling again before that period ends reverses the cancellation and the subscription continues.",
      },
      {
        text:
          "A subscription that is not cancelled renews at the end of each paid period, at the price shown in the plan picker at the time of purchase. " +
          "The renewal date and the amount are both visible in the Billing section throughout the subscription.",
      },
    ],
  },
  {
    field: "customer_name",
    minChars: 1,
    requires: ["customer.name"],
    blocks: [{ text: "{{customer.name}}" }],
  },
  {
    field: "billing_address",
    minChars: 1,
    requires: ["billing.address_block"],
    blocks: [{ text: "{{billing.address_block}}" }],
  },
  {
    field: "customer_email_address",
    minChars: 1,
    requires: ["customer.email"],
    blocks: [{ text: "{{customer.email}}" }],
  },
  {
    field: "service_date",
    minChars: 1,
    requires: ["charge.date"],
    blocks: [{ text: "{{charge.date}}" }],
  },
  {
    field: "uncategorized_text",
    minChars: 200,
    blocks: [
      {
        text:
          "Summary: this charge is the subscription fee for working software that the customer had an active, provisioned account for on the day it was taken.",
      },
      {
        text:
          "Account and purchase: the account is registered to {{customer.email}} and was created on {{customer.created}}. " +
          "The {{sub.plan}} subscription started on {{sub.started}} and is billed {{sub.period}}. " +
          "The disputed charge of {{charge.amount}} was taken on {{charge.date}} and paid for the period beginning that day.",
      },
      {
        text: "Use of the service: {{usage.summary}}",
      },
      {
        text: "{{refund.status}}",
      },
      {
        text:
          "We ask that the charge stand. The service was available for the whole period this charge paid for, the price and the renewal terms were disclosed before purchase, " +
          "and both cancellation and a policy-compliant refund were available to the customer at any time from inside their own account.",
      },
    ],
  },
];
