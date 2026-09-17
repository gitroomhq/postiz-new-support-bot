import type { EvidenceTemplate } from "../renderTemplate";

// The fields every dispute reason inherits unless it overrides them. Written
// for a bank analyst who skims: the strongest checkable fact first, short
// paragraphs, no marketing language, and nothing that is not provable from the
// fact bag or from Postiz's published documentation.
//
// Block discipline: a block is dropped whole if any token in it is unresolved,
// so facts that only exist together share a block and every optional fact has
// a block of its own. The usage blocks (posts published, live post addresses,
// channels, sign-ins) are the strongest evidence in the corpus and are kept
// separate from everything else so a customer with no usage feed still gets
// the complete account and payment story.
//
// The policy paragraphs paraphrase the real published pages (Refunds and
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
          "Postiz is a social media scheduling service, sold as a monthly or yearly subscription and delivered entirely online. " +
          "The subscriber connects their own social media accounts (called channels), writes posts, and Postiz publishes those posts to the connected accounts at the scheduled time. " +
          "Access begins the moment payment succeeds. Nothing is shipped.",
      },
      {
        text:
          "The subscription on this account is {{sub.plan}}, billed {{sub.period}}. " +
          "It allows {{plan.channels}} connected channels and unlimited posts. " +
          "The price and contents of every plan are published on the Postiz pricing page and were shown in the plan picker the customer chose from before paying.",
      },
      {
        text:
          "The disputed charge of {{charge.amount}} on {{charge.date}} is the subscription fee for that plan. " +
          "It appears on the cardholder's statement as {{charge.descriptor}}.",
      },
      {
        text:
          "Since subscribing, this account has published {{usage.posts_published_total}} posts through Postiz: {{usage.platform_breakdown}}.",
      },
      {
        text:
          "There is no free plan. A new organisation may take a single 7 day trial, which requires a payment method to start; " +
          "the small authorisation placed on the card at that point is released immediately and is never charged. " +
          "A subscription charge is therefore always the fee for a paid plan the customer selected.",
      },
    ],
  },
  {
    field: "access_activity_log",
    minChars: 120,
    blocks: [
      {
        text: "Account and service record for {{customer.email}}.",
      },
      {
        text: "Account created: {{customer.created}}.",
      },
      {
        text:
          "The account is registered to the Postiz organisation {{postiz.org_name}}, signs in using {{postiz.login_provider}}, " +
          "and the platform records its plan as {{postiz.tier}}.",
      },
      {
        text: "Most recent sign-in to the account: {{usage.last_sign_in}}.",
      },
      {
        text:
          "Posts published through this account: {{usage.posts_published_total}} in total, the first on {{usage.first_post_date}} and the most recent on {{usage.last_post_date}}.",
      },
      {
        text:
          "Of those, {{usage.posts_after_charge}} were published between the disputed charge on {{charge.date}} and {{dispute.opened}}, the day this dispute was raised.",
      },
      {
        text: "Published posts by platform: {{usage.platform_breakdown}}.",
      },
      {
        text: "Social media channels currently connected to the account ({{usage.channels_connected}}), with the date each was connected:\n{{usage.channel_lines}}",
      },
      {
        text: "Published posts from this account, publicly visible at these addresses:\n{{usage.post_url_lines}}",
      },
      {
        text:
          "Subscription: {{sub.plan}}, started {{sub.started}}, billed {{sub.period}}. " +
          "Status on {{dispute.opened}}, the day this dispute was raised: {{sub.status}}.",
      },
      {
        text: "Payment history on this account:\n{{billing.history_lines}}",
      },
      {
        text: "The disputed charge {{charge.id}}, {{charge.amount}} on {{charge.date}}, is the {{billing.ordinal}} payment in that sequence.",
      },
    ],
  },
  {
    field: "refund_policy_disclosure",
    minChars: 200,
    blocks: [
      {
        text:
          "Postiz publishes its refund policy in its customer documentation, under Refunds and support, and applies it automatically and identically to every customer. " +
          "The conditions are fixed: one refund per customer, ever; subscription charges only, not one-off charges; the charge must be less than 60 days old; " +
          "the amount is capped at one month of the plan, so a yearly charge is refunded at one twelfth; and the subscription is cancelled as part of the refund.",
      },
      {
        text:
          "A request that meets those conditions is granted immediately in the in-app support chat, with no wait for a member of staff. " +
          "A request that does not is declined in the same exchange, with the condition that was not met. " +
          "Billing questions are also answered by email at support@postiz.com.",
      },
      {
        text: "On the disputed charge: {{refund.status}}",
      },
    ],
  },
  {
    field: "cancellation_policy_disclosure",
    minChars: 200,
    blocks: [
      {
        text:
          "Cancellation is self-service. The organisation admin can cancel at any time from the Billing section of their own Postiz account. " +
          "No email, chat message or notice period is required, and there is no cancellation fee.",
      },
      {
        text:
          "The published documentation, under Managing your subscription, states what cancelling does: the subscription stays active until the end of the period already paid for, " +
          "nothing stops immediately, and cancelling again before that period ends reverses the cancellation so the subscription continues.",
      },
      {
        text:
          "A subscription that has not been cancelled renews at the end of each paid period, at the price shown in the plan picker at the time of purchase. " +
          "The renewal date and the amount are visible in the Billing section throughout the subscription.",
      },
      {
        text: "This subscription's status on {{dispute.opened}}, the day the dispute was raised: {{sub.status}}.",
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
          "Summary: the disputed charge of {{charge.amount}} on {{charge.date}} is the recurring subscription fee for Postiz, a social media scheduling service, " +
          "on the account registered to {{customer.email}}. The service was available to that account for the whole period the charge paid for.",
      },
      {
        text:
          "Use of the service after this charge: between {{charge.date}} and {{dispute.opened}}, the day this dispute was raised, " +
          "the account published {{usage.posts_after_charge}} posts through Postiz to {{usage.platforms_after_charge}}.",
      },
      {
        text: "Those posts are publicly visible at the following addresses:\n{{usage.post_url_lines_after_charge}}",
      },
      {
        text:
          "Over its lifetime the account has published {{usage.posts_published_total}} posts through Postiz, the first on {{usage.first_post_date}} and the most recent on {{usage.last_post_date}}.",
      },
      {
        text: "It currently has {{usage.channels_connected}} social media channels connected.",
      },
      {
        text: "The account was signed into on {{usage.last_sign_in_after_charge}}, after the disputed charge.",
      },
      {
        text:
          "Account and purchase: the account was created on {{customer.created}}. " +
          "The subscription is {{sub.plan}}, started {{sub.started}} and billed {{sub.period}}. " +
          "Its status on {{dispute.opened}} was {{sub.status}}.",
      },
      {
        text: "Account standing: {{usage.summary}}",
      },
      {
        text: "{{refund.status}}",
      },
      {
        text:
          "We ask that the charge stand. The price and the renewal terms were disclosed before purchase, the service was delivered in full for the period paid for, " +
          "and both cancellation and a policy-compliant refund were available to the customer at any time from inside their own account.",
      },
    ],
  },
];
