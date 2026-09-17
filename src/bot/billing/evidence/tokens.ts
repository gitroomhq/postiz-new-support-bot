// The fact bag a dispute evidence pack is rendered from, and the token registry
// that turns it into text.
//
// Every token returns `string | null`, and null means "we could not establish
// this". Nothing in this system may invent a substitute: no "N/A", no
// "unknown", no empty parenthetical, no hedge. A block that references an
// unresolved token is dropped; a field whose `requires` are unresolved is
// omitted entirely. A bank analyst rejects a whole response over one provably
// wrong claim, so a missing field always beats a guessed one.

// ---- facts ----

export interface DisputeFacts {
  id: string;
  amountText: string;
  reason: string;
  openedIso: string;
  dueIso: string | null;
}

export interface ChargeFacts {
  id: string;
  dateIso: string;
  amountText: string;
  currency: string;
  descriptor: string | null;
  description: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  cardCountry: string | null; // a country NAME, not an ISO code: the reader is not a developer
  cardName: string | null;
  // Always a complete sentence, and always provable from the charge object
  // itself, so it is one of the few tokens that never resolves to null.
  refundStatus: string;
  invoiceNumber: string | null;
  // The period the DISPUTED charge paid for, taken from its own invoice line.
  // NOT the subscription's current period: a dispute raised after a further
  // renewal would otherwise describe the wrong month entirely.
  paidPeriodStartIso: string | null;
  paidPeriodEndIso: string | null;
  // Verification results at the time of payment. "The cardholder entered the
  // correct security code and billing postcode" is textbook evidence against
  // an unauthorised-use claim.
  cvcCheck: string | null;
  postalCheck: string | null;
  addressCheck: string | null;
  // Whether the bank authenticated the cardholder (3-D Secure). Postiz does not
  // request it explicitly, but Stripe Checkout applies it automatically under
  // SCA, so a subset of charges carry a real authenticated result. Where they
  // do, liability has shifted to the issuer and the dispute should not exist.
  threeDSecure: string | null;
  // Stripe's own fraud assessment at authorisation time.
  riskLevel: string | null;
  riskScore: number | null;
  networkStatus: string | null;
  fingerprint: string | null;
}

export interface CustomerFacts {
  id: string;
  email: string | null;
  name: string | null;
  createdIso: string | null;
  // Rendered only when a line1 AND a country are present. A half address is
  // worse than none: it reads as sloppy record-keeping to an analyst.
  addressBlock: string | null;
}

export interface SubFacts {
  plan: string;
  tier: string | null; // STANDARD | TEAM | PRO | ULTIMATE, for PLAN_FACTS
  status: string;
  startedIso: string;
  period: string | null; // monthly | yearly
  periodStartIso: string | null;
  periodEndIso: string | null;
  canceledAtIso: string | null;
}

export interface BillingHistoryFacts {
  // At most 8 lines, oldest first. Null below two paid invoices, because a
  // one-line "history" argues nothing.
  historyLines: string | null;
  paidCount: number;
  ordinal: string | null; // "6th": where the disputed charge sits in the sequence
  firstPaidDateIso: string | null;
}

export interface DuplicateFacts {
  originalChargeId: string;
  originalInvoiceNumber: string | null;
  originalDateIso: string;
  originalAmountText: string;
  daysApart: number;
  candidateCount: number;
}

export interface PostizFacts {
  orgName: string | null;
  tier: string | null;
  loginProvider: string | null; // already humanised
  activated: boolean | null;
  subPeriod: string | null;
}

export interface SupportFacts {
  historyLines: string | null;
  conversationCount: number;
  firstContactIso: string | null;
  lastContactIso: string | null;
  // True ONLY when Intercom actually answered and returned no refund request.
  // A lookup that was off, timed out or errored leaves this null, so a negative
  // is never asserted from an absent answer.
  noRefundRequest: boolean | null;
}

// Real product usage, read from the Postiz Post and Integration tables.
export interface UsageFacts {
  published: number;
  publishedDeleted: number;
  publishedBeforeCharge: number;
  publishedSinceCharge: number;
  publishedDeletedSinceCharge: number;
  deletedAfterDispute: number;
  firstPublishedIso: string | null;
  lastPublishedIso: string | null;
  perPlatform: Array<{ platform: string; count: number }>;
  perPlatformSinceCharge: Array<{ platform: string; count: number }>;
  channelsLive: number;
  channelsDeleted: number;
  channelsDuringPeriod: number;
  channels: Array<{ name: string; platform: string; connectedIso: string; deletedIso: string | null; disabled: boolean }>;
  recentPosts: Array<{ publishedIso: string; platform: string; url: string }>;
  recentPostsSinceCharge: Array<{ publishedIso: string; platform: string; url: string }>;
  queued: number;
  // Last sign-in. Not currently reachable: it lives on the platform's User
  // table, which this bot is not granted, and no public endpoint returns it.
  // Left in the shape so the block that cites it switches on the day it is.
  lastSignInIso: string | null;
}

// Card-history facts, which need the charge's card FINGERPRINT rather than its
// last four digits: last4 collides constantly and an analyst will not accept it
// as identity evidence.
export interface CardHistoryFacts {
  sameCardPriorCount: number;
  sameCardFirstIso: string | null;
  sameCard3dsIso: string | null;
}

export interface EvidenceFacts {
  dispute: DisputeFacts;
  charge: ChargeFacts | null;
  customer: CustomerFacts | null;
  sub: SubFacts | null;
  billing: BillingHistoryFacts | null;
  dup: DuplicateFacts | null;
  postiz: PostizFacts | null;
  support: SupportFacts | null;
  usage: UsageFacts | null;
  cards: CardHistoryFacts | null;
}

// ---- static merchant facts ----

// Read from search/postiz-docs/cloud/plans.mdx, which is itself generated from
// the product source. Quoting a plan's real contents is what makes
// product_description concrete instead of marketing copy.
export interface PlanFacts {
  channels: number;
  monthlyUsd: number;
  yearlyUsd: number;
}
export const PLAN_FACTS: Record<string, PlanFacts> = {
  STANDARD: { channels: 5, monthlyUsd: 29, yearlyUsd: 278 },
  TEAM: { channels: 10, monthlyUsd: 39, yearlyUsd: 374 },
  PRO: { channels: 30, monthlyUsd: 49, yearlyUsd: 470 },
  ULTIMATE: { channels: 100, monthlyUsd: 99, yearlyUsd: 950 },
};

function planFacts(f: EvidenceFacts): PlanFacts | null {
  const tier = (f.sub?.tier ?? f.postiz?.tier ?? "").toUpperCase();
  return PLAN_FACTS[tier] ?? null;
}

// ---- helpers ----

// Dates are written out in full. "2026-03-04" is ambiguous to a reader who may
// be anywhere, and a bank analyst is not going to guess the convention.
export function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function nonEmpty(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

// Internal plan enums are SHOUTED (STANDARD, PRO). A bank analyst should never
// see one: it reads as a raw system dump rather than a product name.
function humanTier(v: string | null | undefined): string | null {
  const t = nonEmpty(v);
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

// Internal platform identifiers are not product names. An analyst reads
// "LinkedIn", never "linkedin-page".
const PLATFORM_NAMES: Record<string, string> = {
  x: "X",
  linkedin: "LinkedIn",
  "linkedin-page": "LinkedIn",
  instagram: "Instagram",
  "instagram-standalone": "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  tiktok: "TikTok",
  youtube: "YouTube",
  pinterest: "Pinterest",
  reddit: "Reddit",
  mastodon: "Mastodon",
  bluesky: "Bluesky",
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
  warpcast: "Farcaster",
  lemmy: "Lemmy",
  dribbble: "Dribbble",
  nostr: "Nostr",
  vk: "VK",
};

export function platformName(id: string): string {
  const key = id.trim().toLowerCase();
  return PLATFORM_NAMES[key] ?? key.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// "a, b and c". An analyst reads prose, not a comma-separated machine list.
function joinHuman(parts: string[]): string | null {
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// Clickable proof, newest first. Only live posts reach here: a link that 404s
// when the analyst tries it is worse than quoting no link at all.
function postLines(posts: Array<{ publishedIso: string; platform: string; url: string }>): string | null {
  const rows = posts.slice(0, 3);
  if (!rows.length) return null;
  return rows
    .map((p) => `  ${longDate(p.publishedIso) ?? "date unknown"}   ${platformName(p.platform)}   ${p.url}`)
    .join("\n");
}

// A count of zero is evidence FOR the cardholder. It must drop the block that
// would have cited it, never render as "0".
function positive(n: number | null | undefined): string | null {
  return n && n > 0 ? String(n) : null;
}

// ---- the registry ----

export type TokenResolver = (f: EvidenceFacts) => string | null;

export const TOKENS: Record<string, TokenResolver> = {
  // dispute
  "dispute.id": (f) => f.dispute.id,
  "dispute.amount": (f) => f.dispute.amountText,
  "dispute.reason": (f) => f.dispute.reason,
  "dispute.opened": (f) => longDate(f.dispute.openedIso),
  "dispute.due": (f) => longDate(f.dispute.dueIso),

  // charge
  "charge.id": (f) => f.charge?.id ?? null,
  "charge.date": (f) => longDate(f.charge?.dateIso),
  "charge.amount": (f) => f.charge?.amountText ?? null,
  "charge.descriptor": (f) => nonEmpty(f.charge?.descriptor),
  "charge.description": (f) => nonEmpty(f.charge?.description),
  "charge.card_brand": (f) => nonEmpty(f.charge?.cardBrand),
  "charge.card_last4": (f) => nonEmpty(f.charge?.cardLast4),
  "charge.card_country": (f) => nonEmpty(f.charge?.cardCountry),
  "charge.card_name": (f) => nonEmpty(f.charge?.cardName),
  "charge.invoice_number": (f) => nonEmpty(f.charge?.invoiceNumber),
  "refund.status": (f) => nonEmpty(f.charge?.refundStatus),

  // customer
  "customer.id": (f) => f.customer?.id ?? null,
  "customer.email": (f) => nonEmpty(f.customer?.email),
  "customer.name": (f) => nonEmpty(f.customer?.name) ?? nonEmpty(f.charge?.cardName),
  "customer.created": (f) => longDate(f.customer?.createdIso),
  "billing.address_block": (f) => nonEmpty(f.customer?.addressBlock),

  // subscription
  // A bare plan name. subPlanLabel can render "Pro . $49.00/month" or, when the
  // product is not expanded, a raw price id; neither belongs in evidence.
  "sub.plan": (f) => {
    const tier = humanTier(f.sub?.tier);
    if (tier) return tier;
    const label = nonEmpty(f.sub?.plan);
    if (!label || /^price_/i.test(label)) return null;
    return label.split("\u00b7")[0].trim() || null;
  },
  "sub.status": (f) => nonEmpty(f.sub?.status),
  "sub.started": (f) => longDate(f.sub?.startedIso),
  "sub.period": (f) => nonEmpty(f.sub?.period),
  "sub.period_start": (f) => longDate(f.sub?.periodStartIso),
  "sub.period_end": (f) => longDate(f.sub?.periodEndIso),
  "sub.canceled_at": (f) => longDate(f.sub?.canceledAtIso),

  // payment history
  "billing.history_lines": (f) => nonEmpty(f.billing?.historyLines),
  "billing.paid_count": (f) => (f.billing && f.billing.paidCount > 0 ? String(f.billing.paidCount) : null),
  "billing.ordinal": (f) => nonEmpty(f.billing?.ordinal),
  "billing.first_paid_date": (f) => longDate(f.billing?.firstPaidDateIso),

  // duplicate-reason grounding
  "dup.original_charge_id": (f) => f.dup?.originalChargeId ?? null,
  "dup.original_invoice_number": (f) => nonEmpty(f.dup?.originalInvoiceNumber),
  "dup.original_date": (f) => longDate(f.dup?.originalDateIso),
  "dup.original_amount": (f) => f.dup?.originalAmountText ?? null,
  "dup.days_apart": (f) => (f.dup ? String(f.dup.daysApart) : null),

  // platform account
  "postiz.org_name": (f) => nonEmpty(f.postiz?.orgName),
  "postiz.tier": (f) => humanTier(f.postiz?.tier),
  "postiz.login_provider": (f) => nonEmpty(f.postiz?.loginProvider),
  "postiz.activated": (f) => (f.postiz?.activated == null ? null : f.postiz.activated ? "yes" : "no"),

  // plan contents, from the published pricing table
  "plan.channels": (f) => {
    const p = planFacts(f);
    return p ? String(p.channels) : null;
  },
  "plan.price_monthly": (f) => {
    const p = planFacts(f);
    return p ? `$${p.monthlyUsd}` : null;
  },
  "plan.price_yearly": (f) => {
    const p = planFacts(f);
    return p ? `$${p.yearlyUsd}` : null;
  },

  // ---- real product usage (Postiz Post and Integration tables) ----
  "usage.posts_published_total": (f) => positive(f.usage?.published),
  "usage.posts_before_charge": (f) => positive(f.usage?.publishedBeforeCharge),
  "usage.posts_after_charge": (f) => positive(f.usage?.publishedSinceCharge),
  "usage.posts_deleted": (f) => positive(f.usage?.publishedDeleted),
  "usage.posts_deleted_after_dispute": (f) => positive(f.usage?.deletedAfterDispute),
  "usage.posts_queued": (f) => positive(f.usage?.queued),
  "usage.first_post_date": (f) => longDate(f.usage?.firstPublishedIso),
  "usage.last_post_date": (f) => longDate(f.usage?.lastPublishedIso),
  "usage.platform_breakdown": (f) =>
    joinHuman((f.usage?.perPlatform ?? []).slice(0, 4).map((p) => `${p.count} to ${platformName(p.platform)}`)),
  "usage.platforms_after_charge": (f) =>
    joinHuman((f.usage?.perPlatformSinceCharge ?? []).slice(0, 4).map((p) => platformName(p.platform))),
  "usage.post_url_lines": (f) => postLines(f.usage?.recentPosts ?? []),
  "usage.post_url_lines_after_charge": (f) => postLines(f.usage?.recentPostsSinceCharge ?? []),
  "usage.channels_connected": (f) => positive(f.usage?.channelsLive),
  "usage.channels_during_period": (f) => positive(f.usage?.channelsDuringPeriod),
  "usage.channels_removed": (f) => positive(f.usage?.channelsDeleted),
  "usage.channel_lines": (f) => {
    const rows = (f.usage?.channels ?? []).filter((c) => !c.deletedIso && !c.disabled).slice(0, 8);
    if (!rows.length) return null;
    return rows
      .map((c) => `  ${platformName(c.platform)}   ${c.name}   connected ${longDate(c.connectedIso) ?? "an unknown date"}`)
      .join("\n");
  },
  // Not reachable yet: the last sign-in lives on a table this bot is not
  // granted. Resolves null, so the blocks citing it simply do not render.
  "usage.last_sign_in": (f) => longDate(f.usage?.lastSignInIso),
  "usage.last_sign_in_after_charge": (f) => {
    const seen = f.usage?.lastSignInIso;
    const charged = f.charge?.dateIso;
    if (!seen || !charged || new Date(seen) < new Date(charged)) return null;
    return longDate(seen);
  },

  // ---- card history, keyed on FINGERPRINT (last4 collides) ----
  "billing.same_card_prior_count": (f) => positive(f.cards?.sameCardPriorCount),
  "billing.same_card_first_date": (f) =>
    f.cards?.sameCardPriorCount ? longDate(f.cards.sameCardFirstIso) : null,
  "billing.same_card_3ds_date": (f) => longDate(f.cards?.sameCard3dsIso),

  // ---- payment verification and risk ----
  "charge.cvc_check": (f) => (f.charge?.cvcCheck === "pass" ? "matched" : null),
  "charge.postal_check": (f) => (f.charge?.postalCheck === "pass" ? "matched" : null),
  "charge.address_check": (f) => (f.charge?.addressCheck === "pass" ? "matched" : null),
  // Only an AUTHENTICATED result is worth stating; "attempted" or "failed"
  // would argue against us, so they resolve null.
  "charge.three_d_secure": (f) => (f.charge?.threeDSecure === "authenticated" ? "authenticated" : null),
  "charge.risk_level": (f) => (f.charge?.riskLevel === "normal" ? "normal" : null),
  "charge.paid_period_start": (f) => longDate(f.charge?.paidPeriodStartIso),
  "charge.paid_period_end": (f) => longDate(f.charge?.paidPeriodEndIso),

  // support contact
  "support.history_lines": (f) => nonEmpty(f.support?.historyLines),
  "support.conversation_count": (f) =>
    f.support && f.support.conversationCount > 0 ? String(f.support.conversationCount) : null,
  "support.first_contact_date": (f) => longDate(f.support?.firstContactIso),
  // Gate only: a field that asserts "no refund was requested" requires this, and
  // it resolves only on a real negative answer from Intercom.
  "support.no_refund_request": (f) => (f.support?.noRefundRequest === true ? "confirmed" : null),

  // A composed token that degrades rather than disappearing: platform facts
  // first, then a Stripe-only statement, then nothing. Every branch says only
  // what the underlying facts support. Note there are NO login timestamps and
  // NO post counts available anywhere, so this never claims the customer
  // "logged in on" or "published N posts".
  "usage.summary": (f) => {
    const org = nonEmpty(f.postiz?.orgName);
    const started = longDate(f.sub?.startedIso);
    const tier = humanTier(f.postiz?.tier) ?? nonEmpty(f.sub?.plan);
    if (org && started && tier) {
      return `the Postiz organisation ${org} has held an active ${tier} plan on this account since ${started}, and the account remains provisioned.`;
    }
    if (org && started) {
      return `the Postiz organisation ${org} has been active on this account since ${started}.`;
    }
    const paid = f.billing && f.billing.paidCount > 1 ? f.billing.paidCount : null;
    const first = longDate(f.billing?.firstPaidDateIso);
    if (paid && first) {
      // No prior-dispute lookup exists, so the old "without previously
      // disputing any of them" clause was asserted unverified. Removed.
      return `the account has paid ${paid} subscription charges since ${first}, which is not consistent with a service that was never delivered.`;
    }
    if (started) return `the subscription on this account has been active since ${started}.`;
    return null;
  },
};

export const TOKEN_NAMES: readonly string[] = Object.keys(TOKENS);

// Resolves every token once. Callers render against this map rather than
// calling resolvers per block, so a token costs the same whether one template
// uses it or ten do.
export function resolveTokens(facts: EvidenceFacts): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name, resolve] of Object.entries(TOKENS)) {
    try {
      out[name] = resolve(facts);
    } catch {
      // A resolver that throws is treated exactly like one that cannot answer.
      out[name] = null;
    }
  }
  return out;
}
