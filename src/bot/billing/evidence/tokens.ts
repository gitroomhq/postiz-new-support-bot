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

export interface EvidenceFacts {
  dispute: DisputeFacts;
  charge: ChargeFacts | null;
  customer: CustomerFacts | null;
  sub: SubFacts | null;
  billing: BillingHistoryFacts | null;
  dup: DuplicateFacts | null;
  postiz: PostizFacts | null;
  support: SupportFacts | null;
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
  "sub.plan": (f) => nonEmpty(f.sub?.plan),
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
      return `the account has paid ${paid} subscription charges since ${first} without previously disputing any of them, which is not consistent with a service that was never delivered.`;
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
