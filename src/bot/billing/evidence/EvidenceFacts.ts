import type Stripe from "stripe";
import type { StripeClient } from "../../StripeClient";
import type { PostizIdentityService } from "../../../postiz/PostizIdentityService";
import { subPlanLabel } from "../ui";
import type {
  BillingHistoryFacts,
  CardHistoryFacts,
  UsageFacts,
  ChargeFacts,
  CustomerFacts,
  DuplicateFacts,
  EvidenceFacts,
  PostizFacts,
  SubFacts,
  SupportFacts,
} from "./tokens";

// Gathers everything a template pack can be rendered from. Every source is
// independently optional: a lookup that fails or is switched off leaves its
// facts null, which removes the paragraphs that needed them rather than
// producing a worse version of them.

export interface FactSources {
  stripe: StripeClient;
  // Real product usage. Absent = every usage paragraph is omitted rather than
  // replaced with something vaguer.
  usage?: UsageFacts | null;
  postiz?: PostizIdentityService | null;
  // Support facts are gathered by the caller (they are slow, so only the
  // looper's enrich pass supplies them).
  support?: SupportFacts | null;
}

// ISO 3166 alpha-2 to a name, for the handful of issuing countries worth
// spelling out. A bank analyst should read "Germany", not "DE"; an unlisted
// code falls back to the code itself, which is still better than nothing.
const COUNTRY_NAMES: Record<string, string> = {
  US: "the United States",
  GB: "the United Kingdom",
  DE: "Germany",
  FR: "France",
  NL: "the Netherlands",
  ES: "Spain",
  IT: "Italy",
  IE: "Ireland",
  CA: "Canada",
  AU: "Australia",
  NZ: "New Zealand",
  IN: "India",
  BR: "Brazil",
  JP: "Japan",
  SG: "Singapore",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  PL: "Poland",
  PT: "Portugal",
  BE: "Belgium",
  AT: "Austria",
  CH: "Switzerland",
  ZA: "South Africa",
  MX: "Mexico",
  AE: "the United Arab Emirates",
};

function titleCase(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th";
  return `${n}${suffix}`;
}

function iso(unixSeconds: number | null | undefined): string | null {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

// Always a complete sentence, always provable from the charge object, which is
// why it is one of the very few facts that is never null.
function refundStatus(stripe: StripeClient, charge: Stripe.Charge): string {
  const refunded = charge.amount_refunded ?? 0;
  if (!refunded) return "No refund or credit has been issued on this charge.";
  const amount = stripe.formatAmount(refunded, charge.currency);
  const first = charge.refunds?.data?.[0];
  const when = first ? new Date(first.created * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : null;
  const full = refunded >= charge.amount;
  return when
    ? `A ${full ? "full" : "partial"} refund of ${amount} was issued on ${when} and returned to the same card.`
    : `A ${full ? "full" : "partial"} refund of ${amount} has been issued on this charge and returned to the same card.`;
}

function addressBlock(customer: Stripe.Customer | null, charge: Stripe.Charge): string | null {
  const a = customer?.address ?? charge.billing_details?.address ?? null;
  // A half address reads as sloppy record-keeping, which is worse than leaving
  // the field out: both a street line and a country or nothing at all.
  if (!a?.line1 || !a.country) return null;
  const name = customer?.name ?? charge.billing_details?.name ?? null;
  return [name, a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(" "), a.state, COUNTRY_NAMES[a.country] ?? a.country]
    .filter(Boolean)
    .join("\n");
}

function chargeFacts(stripe: StripeClient, charge: Stripe.Charge, invoice: Stripe.Invoice | null): ChargeFacts {
  const card = charge.payment_method_details?.card ?? null;
  const checks = card?.checks ?? null;
  const outcome = charge.outcome ?? null;
  // The period THIS charge paid for, from its own invoice line. Using the
  // subscription's current period instead would describe the wrong month for
  // any dispute raised after a further renewal.
  const line = invoice?.lines?.data?.[0] ?? null;
  const period = (line as unknown as { period?: { start?: number; end?: number } } | null)?.period ?? null;
  return {
    id: charge.id,
    dateIso: new Date(charge.created * 1000).toISOString(),
    amountText: stripe.formatAmount(charge.amount, charge.currency),
    currency: charge.currency,
    descriptor: charge.calculated_statement_descriptor ?? charge.statement_descriptor ?? null,
    description: charge.description ?? null,
    cardBrand: titleCase(card?.brand),
    cardLast4: card?.last4 ?? null,
    cardCountry: card?.country ? (COUNTRY_NAMES[card.country] ?? card.country) : null,
    cardName: charge.billing_details?.name ?? null,
    refundStatus: refundStatus(stripe, charge),
    invoiceNumber: invoice?.number ?? null,
    paidPeriodStartIso: iso(period?.start),
    paidPeriodEndIso: iso(period?.end),
    cvcCheck: checks?.cvc_check ?? null,
    postalCheck: checks?.address_postal_code_check ?? null,
    addressCheck: checks?.address_line1_check ?? null,
    threeDSecure: card?.three_d_secure?.result ?? null,
    riskLevel: (outcome as unknown as { risk_level?: string } | null)?.risk_level ?? null,
    riskScore: (outcome as unknown as { risk_score?: number } | null)?.risk_score ?? null,
    networkStatus: outcome?.network_status ?? null,
    fingerprint: card?.fingerprint ?? null,
  };
}

// Earlier succeeded charges paid with the SAME physical card, matched on the
// fingerprint rather than the last four digits, which collide often enough that
// an analyst would be right to reject them as identity evidence.
function cardHistory(charges: Stripe.Charge[], charge: Stripe.Charge): CardHistoryFacts | null {
  const fingerprint = charge.payment_method_details?.card?.fingerprint ?? null;
  if (!fingerprint) return null;
  const prior = charges
    .filter(
      (c) =>
        c.id !== charge.id &&
        c.status === "succeeded" &&
        c.created < charge.created &&
        c.payment_method_details?.card?.fingerprint === fingerprint
    )
    .sort((a, b) => a.created - b.created);
  const authenticated = prior.find((c) => c.payment_method_details?.card?.three_d_secure?.result === "authenticated");
  return {
    sameCardPriorCount: prior.length,
    sameCardFirstIso: prior.length ? new Date(prior[0].created * 1000).toISOString() : null,
    // The cardholder proving to their own bank that they held this card, on
    // this account. Close to decisive on an unauthorised-use claim.
    sameCard3dsIso: authenticated ? new Date(authenticated.created * 1000).toISOString() : null,
  };
}

function customerFacts(customer: Stripe.Customer | null, charge: Stripe.Charge): CustomerFacts | null {
  const id = typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? customer?.id ?? null);
  if (!id) return null;
  return {
    id,
    email: customer?.email ?? charge.billing_details?.email ?? null,
    name: customer?.name ?? charge.billing_details?.name ?? null,
    createdIso: customer?.created ? new Date(customer.created * 1000).toISOString() : null,
    addressBlock: addressBlock(customer, charge),
  };
}

// Picks the subscription this charge belongs to. When several are plausible and
// none owns the invoice, EVERY subscription fact stays null rather than
// attributing the charge to a guess.
function subFacts(
  stripe: StripeClient,
  subs: Stripe.Subscription[],
  invoice: Stripe.Invoice | null
): SubFacts | null {
  // Basil moved the invoice's subscription link under parent.subscription_details.
  const linked = invoice?.parent?.subscription_details?.subscription ?? null;
  const invoiceSubId = typeof linked === "string" ? linked : (linked?.id ?? null);

  const live = subs.filter((s) => s.status !== "incomplete_expired");
  const chosen =
    (invoiceSubId ? subs.find((s) => s.id === invoiceSubId) : null) ??
    (live.length === 1 ? live[0] : null) ??
    // Several subscriptions and no invoice link: only attribute the charge when
    // exactly one is or was active, otherwise say nothing.
    (live.filter((s) => s.status === "active" || s.status === "past_due").length === 1
      ? live.find((s) => s.status === "active" || s.status === "past_due")
      : null) ??
    null;
  if (!chosen) return null;

  const item = chosen.items.data[0];
  const interval = item?.price?.recurring?.interval ?? null;
  const tier = (item?.price?.metadata?.tier ?? item?.price?.metadata?.plan ?? chosen.metadata?.tier ?? null) as string | null;
  return {
    plan: subPlanLabel(stripe, chosen),
    tier,
    status: chosen.status,
    startedIso: new Date(chosen.start_date * 1000).toISOString(),
    period: interval === "year" ? "yearly" : interval === "month" ? "monthly" : null,
    periodStartIso: iso((item as unknown as { current_period_start?: number })?.current_period_start),
    periodEndIso: iso((item as unknown as { current_period_end?: number })?.current_period_end),
    canceledAtIso: iso(chosen.canceled_at),
  };
}

function billingFacts(stripe: StripeClient, invoices: Stripe.Invoice[], invoiceId: string | null): BillingHistoryFacts | null {
  const paid = invoices
    .filter((i) => i.status === "paid" && (i.amount_paid ?? 0) > 0)
    .sort((a, b) => a.created - b.created);
  // One line is not a history, and arguing from it would be weaker than saying
  // nothing about the payment record at all.
  if (paid.length < 2) return null;

  const lines = paid
    .slice(-8)
    .map((i) => {
      const when = new Date(i.created * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
      const amount = stripe.formatAmount(i.amount_paid ?? 0, i.currency);
      return `  ${when}   ${amount}   paid${i.number ? `   invoice ${i.number}` : ""}`;
    })
    .join("\n");

  const index = invoiceId ? paid.findIndex((i) => i.id === invoiceId) : -1;
  return {
    historyLines: lines,
    paidCount: paid.length,
    ordinal: index >= 0 ? ordinal(index + 1) : null,
    firstPaidDateIso: new Date(paid[0].created * 1000).toISOString(),
  };
}

// Only used for reason=duplicate. Finds this customer's other succeeded charges
// of the SAME amount and currency: the real candidates for "the original".
async function duplicateFacts(
  stripe: StripeClient,
  charges: Stripe.Charge[],
  charge: Stripe.Charge,
  invoices: Stripe.Invoice[]
): Promise<DuplicateFacts | null> {
  const candidates = charges
    .filter((c) => c.id !== charge.id && c.status === "succeeded" && c.amount === charge.amount && c.currency === charge.currency)
    .sort((a, b) => b.created - a.created);
  // Prefer the nearest PRECEDING charge: that is the one a cardholder would
  // have seen next to the disputed line on their statement.
  const preceding = candidates.filter((c) => c.created < charge.created);
  const original = preceding[0] ?? candidates[0];
  if (!original) return null;
  // Two different invoice numbers on the two charges is the cleanest possible
  // proof that they are separate billing periods rather than one charge taken
  // twice. Costs one extra lookup, and only on a duplicate claim.
  const originalInvoiceId = await stripe.resolveChargeInvoiceId(original).catch(() => null);
  const originalInvoice = originalInvoiceId ? (invoices.find((i) => i.id === originalInvoiceId) ?? null) : null;
  return {
    originalChargeId: original.id,
    originalInvoiceNumber: originalInvoice?.number ?? null,
    originalDateIso: new Date(original.created * 1000).toISOString(),
    originalAmountText: stripe.formatAmount(original.amount, original.currency),
    daysApart: Math.max(1, Math.round(Math.abs(charge.created - original.created) / 86400)),
    candidateCount: candidates.length,
  };
}

function humanProvider(provider: string | null): string | null {
  if (!provider) return null;
  const p = provider.toUpperCase();
  if (p === "LOCAL") return "an email address and password";
  if (p === "GOOGLE") return "a Google account";
  if (p === "GITHUB") return "a GitHub account";
  return null;
}

async function postizFacts(postiz: PostizIdentityService | null | undefined, customerId: string | null): Promise<PostizFacts | null> {
  if (!postiz || !customerId) return null;
  const lookup = await postiz.resolveOrgsForCustomer(customerId).catch(() => null);
  // "off", "none", "timeout" and "error" are all distinct from "found", and
  // none of them licenses a claim about the platform account.
  if (!lookup || lookup.state !== "found") return null;
  const org = lookup.orgs?.[0];
  if (!org) return null;
  return {
    orgName: org.orgName ?? null,
    tier: org.tier ?? null,
    loginProvider: humanProvider(org.ownerProvider ?? null),
    activated: org.ownerActivated ?? null,
    subPeriod: org.subPeriod ?? null,
  };
}

export interface GatherOptions {
  // Skip the duplicate-charge sweep unless the reason needs it.
  needDuplicates?: boolean;
  // Fetch the customer's charge list to match earlier payments on the same card
  // fingerprint. The fraud-shaped reasons need this even though they are not
  // duplicate claims.
  needCardHistory?: boolean;
}

// One pass over every source. Costs at most five Stripe reads plus one
// time-boxed Postiz lookup, which is what keeps it inside the webhook's budget.
export async function gatherFacts(
  sources: FactSources,
  dispute: Stripe.Dispute,
  charge: Stripe.Charge,
  opts: GatherOptions = {}
): Promise<EvidenceFacts> {
  const { stripe } = sources;
  const customerId = typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null);

  // Basil removed `invoice` from Charge, so the link is resolved through the
  // client's own helper. It costs nothing extra on a pre-Basil account and one
  // call on a current one, and it is what ties the charge to its subscription
  // and to its place in the payment history.
  const invoiceIdPromise = stripe.resolveChargeInvoiceId(charge).catch(() => null);

  const [customer, subs, invoices, otherCharges, postiz, invoiceId] = await Promise.all([
    customerId ? stripe.getCustomer(customerId).catch(() => null) : Promise.resolve(null),
    customerId ? stripe.listSubscriptions(customerId).catch(() => [] as Stripe.Subscription[]) : Promise.resolve([]),
    customerId ? stripe.listInvoices(customerId, 12).then((r) => r.invoices).catch(() => [] as Stripe.Invoice[]) : Promise.resolve([]),
    (opts.needDuplicates || opts.needCardHistory) && customerId
      ? stripe.listCharges(customerId, 100).then((r) => r.charges).catch(() => [] as Stripe.Charge[])
      : Promise.resolve([] as Stripe.Charge[]),
    postizFacts(sources.postiz, customerId),
    invoiceIdPromise,
  ]);
  const invoice = invoiceId ? (invoices.find((i) => i.id === invoiceId) ?? null) : null;

  return {
    dispute: {
      id: dispute.id,
      amountText: stripe.formatAmount(dispute.amount, dispute.currency),
      reason: dispute.reason,
      openedIso: new Date(dispute.created * 1000).toISOString(),
      dueIso: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString() : null,
    },
    charge: chargeFacts(stripe, charge, invoice),
    customer: customerFacts(customer, charge),
    sub: subFacts(stripe, subs, invoice),
    billing: billingFacts(stripe, invoices, invoiceId),
    dup: opts.needDuplicates ? await duplicateFacts(stripe, otherCharges, charge, invoices) : null,
    postiz,
    support: sources.support ?? null,
    usage: sources.usage ?? null,
    cards: opts.needCardHistory ? cardHistory(otherCharges, charge) : null,
  };
}

// Short-lived cache so the looper's score re-check and a web preview after a
// build cost nothing. Same idiom as CachedRatioEngine.
export class FactCache {
  private entries = new Map<string, { at: number; facts: EvidenceFacts }>();

  constructor(
    private ttlMs = 10 * 60_000,
    private cap = 100
  ) {}

  get(disputeId: string): EvidenceFacts | null {
    const hit = this.entries.get(disputeId);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(disputeId);
      return null;
    }
    return hit.facts;
  }

  set(disputeId: string, facts: EvidenceFacts): void {
    if (this.entries.size >= this.cap) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    this.entries.set(disputeId, { at: Date.now(), facts });
  }

  clear(disputeId: string): void {
    this.entries.delete(disputeId);
  }
}
