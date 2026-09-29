// Fight or accept: whether a dispute is worth answering at all.
//
// Kept PURE (plain data in, plain data out) for the same reason
// autoResolvePolicy.ts is: the rule that decides whether we spend Stripe's
// countered-dispute fee on a case, or concede it, has to be readable and
// testable in one file with no IO to mock.
//
// WHY THIS EXISTS. A package that is complete is not a package that wins.
// scorePack measures how many fields we could fill; it says nothing about
// whether the bank will side with us, and fighting a case we cannot win costs
// the countered fee on top of the loss. These rules are the operator's own
// reading of which cases are winnable, applied in a fixed order.
//
// THE ORDER, first match wins:
//   1. a refund already issued on the disputed charge      -> fight
//   2. an annual charge                                     -> fight
//   3. "subscription canceled", and support saw a request
//      to cancel before the charge (our miss, not theirs)   -> accept
//   4. 3-D Secure authenticated, or Visa CE 3.0 qualified   -> fight
//   5. very little data (any one indicator)                 -> accept
//   6. any weak signal: Postiz usage, support contact
//      before the dispute, a cancel claim Stripe disproves  -> fight
//   7. nothing at all                                       -> accept
//
// UNKNOWN IS NOT NO. Every input is nullable, and a null never fires a signal
// or a veto: a feed that did not answer cannot prove a customer never posted,
// and cannot prove a history is thin either. What a dead feed does instead is
// make the verdict INCOMPLETE, which the irreversible automation (auto-accept)
// refuses to act on. The verdict itself still shows.

export const VERDICT_VERSION = "v1";

export type Verdict = "fight" | "accept";

// Bounded, because it is persisted and tabulated by the backtest: add a value
// here and nowhere else.
export type VerdictSignal =
  | "refunded"
  | "annual"
  | "cancel_ask_seen"
  | "three_d_secure"
  | "visa_ce3"
  | "thin_first_charge"
  | "thin_low_score"
  | "thin_unverified"
  | "posts_after_charge"
  | "posts_before_charge"
  | "channels_in_period"
  | "queued_posts"
  | "support_contact"
  | "cancel_claim_false"
  | "no_signal";

export const VERDICT_SIGNALS: readonly VerdictSignal[] = [
  "refunded",
  "annual",
  "cancel_ask_seen",
  "three_d_secure",
  "visa_ce3",
  "thin_first_charge",
  "thin_low_score",
  "thin_unverified",
  "posts_after_charge",
  "posts_before_charge",
  "channels_in_period",
  "queued_posts",
  "support_contact",
  "cancel_claim_false",
  "no_signal",
];

// Short labels for pills and table rows. Sentences with numbers are built by
// the pages from the stored detail, where the numbers live.
export const VERDICT_SIGNAL_LABELS: Record<VerdictSignal, string> = {
  refunded: "Already refunded",
  annual: "Annual charge",
  cancel_ask_seen: "Asked support to cancel before the charge",
  three_d_secure: "3-D Secure authenticated",
  visa_ce3: "Visa CE 3.0 qualified",
  thin_first_charge: "First charge, no payment history",
  thin_low_score: "Evidence pack too thin",
  thin_unverified: "Card never verified",
  posts_after_charge: "Posted after the charge",
  posts_before_charge: "Posted before the charge",
  channels_in_period: "Channels connected in the paid period",
  queued_posts: "Posts queued or scheduled",
  support_contact: "Contacted support before the dispute",
  cancel_claim_false: "Never cancelled before the charge",
  no_signal: "No reason to fight",
};

// Feeds whose silence makes a verdict incomplete: each one can produce a fight
// signal, so without its answer an Accept is a guess.
export type VerdictFeed = "usage" | "support" | "history";

export interface VerdictInput {
  // Stripe's dispute reason, verbatim.
  reason: string;
  // Money already refunded on the disputed charge, in its minor units.
  refundedMinor: number;
  // null = the billing period of the charge could not be established.
  annual: boolean | null;
  // charge.payment_method_details.card.three_d_secure.result on the disputed charge.
  threeDSecure: string | null;
  // evidence_details.enhanced_eligibility.visa_compelling_evidence_3.status.
  visaCe3: string | null;

  // Postiz usage, from the platform's own tables. null = no usage facts, which
  // is a real "none" only when usageReached is true.
  usage: {
    publishedSinceCharge: number;
    publishedBeforeCharge: number;
    channelsDuringPeriod: number;
    queued: number;
  } | null;
  usageReached: boolean;

  // Conversations and Discord tickets the customer opened BEFORE the dispute.
  // Contact after it (writing in to complain about the chargeback) is not a
  // relationship and is not counted.
  supportContacts: number;
  supportReached: boolean;
  // A request to cancel, seen by support before the disputed charge. null =
  // not looked for (only subscription_canceled looks) or not readable.
  cancelAskBeforeCharge: boolean | null;
  // From the subscription: was it cancelled before the charge? null = no
  // subscription could be attributed to the charge.
  cancelledBeforeCharge: boolean | null;

  // Successful charges for this customer before the disputed one. null = the
  // payment history could not be read.
  priorSucceededCharges: number | null;
  // 3-D Secure, CVC or postal check passed on this charge or on an earlier
  // charge on the same card. null = not a card, or not readable.
  cardVerified: boolean | null;
  // Evidence pack completeness (scorePack), and the bar below which the data
  // counts as thin.
  packScore: number | null;
  minScore: number;
}

export interface VerdictResult {
  verdict: Verdict;
  // The rule that decided it.
  decisive: VerdictSignal;
  // Every fight signal present, in rule order. Shown in full, because "fight:
  // annual" alone hides that the customer also posted forty times.
  signals: VerdictSignal[];
  // The thin-data indicators present, whether or not they decided.
  thin: VerdictSignal[];
  // Feeds that did not answer.
  missing: VerdictFeed[];
  complete: boolean;
}

export function decideVerdict(input: VerdictInput): VerdictResult {
  const missing: VerdictFeed[] = [];
  if (!input.usageReached) missing.push("usage");
  if (!input.supportReached) missing.push("support");
  if (input.priorSucceededCharges == null) missing.push("history");

  const canceledClaim = input.reason === "subscription_canceled";
  const u = input.usage;

  const strong: VerdictSignal[] = [];
  if (input.refundedMinor > 0) strong.push("refunded");
  if (input.annual === true) strong.push("annual");
  const cancelAsk = canceledClaim && input.cancelAskBeforeCharge === true;
  if (input.threeDSecure === "authenticated") strong.push("three_d_secure");
  if (input.visaCe3 === "qualified") strong.push("visa_ce3");

  const thin: VerdictSignal[] = [];
  if (input.priorSucceededCharges === 0) thin.push("thin_first_charge");
  if (input.packScore != null && input.packScore < input.minScore) thin.push("thin_low_score");
  if (input.cardVerified === false) thin.push("thin_unverified");

  const weak: VerdictSignal[] = [];
  if ((u?.publishedSinceCharge ?? 0) > 0) weak.push("posts_after_charge");
  if ((u?.publishedBeforeCharge ?? 0) > 0) weak.push("posts_before_charge");
  if ((u?.channelsDuringPeriod ?? 0) > 0) weak.push("channels_in_period");
  if ((u?.queued ?? 0) > 0) weak.push("queued_posts");
  if (input.supportContacts > 0) weak.push("support_contact");
  // The cancel claim is only disproved when Stripe positively shows no
  // cancellation before the charge AND support saw no request either.
  if (canceledClaim && input.cancelledBeforeCharge === false && input.cancelAskBeforeCharge !== true) {
    weak.push("cancel_claim_false");
  }

  const signals = [...strong, ...weak];
  const out = (verdict: Verdict, decisive: VerdictSignal): VerdictResult => ({
    verdict,
    decisive,
    signals,
    thin,
    missing,
    complete: missing.length === 0,
  });

  if (input.refundedMinor > 0) return out("fight", "refunded");
  if (input.annual === true) return out("fight", "annual");
  if (cancelAsk) return out("accept", "cancel_ask_seen");
  if (input.threeDSecure === "authenticated") return out("fight", "three_d_secure");
  if (input.visaCe3 === "qualified") return out("fight", "visa_ce3");
  if (thin.length) return out("accept", thin[0]);
  if (weak.length) return out("fight", weak[0]);
  return out("accept", "no_signal");
}

// The verdict that actually applies: a human override wins over the rules.
export function effectiveVerdict(row: {
  verdict: string | null;
  verdictOverride: string | null;
}): Verdict | null {
  const v = row.verdictOverride ?? row.verdict;
  return v === "fight" || v === "accept" ? v : null;
}

// ---- annual detection ----

// A paid period of more than 300 days is a yearly plan, whatever its price
// says: a custom annual price never matches the canonical table, but its
// invoice line still spans a year.
const ANNUAL_MIN_DAYS = 300;

export function annualFromPeriod(startIso: string | null | undefined, endIso: string | null | undefined): boolean | null {
  if (!startIso || !endIso) return null;
  const days = (Date.parse(endIso) - Date.parse(startIso)) / 86_400_000;
  if (!Number.isFinite(days) || days <= 0) return null;
  return days >= ANNUAL_MIN_DAYS;
}

// ---- cancel intent ----

// A customer asking to stop paying. Deliberately narrow: "how do I cancel a
// scheduled post" must not read as a request to cancel a subscription, so
// every pattern names the plan, the subscription or the account, or is a bare
// "please cancel" with nothing after it that it could be about. A false match
// concedes a case, which is why the bar is a named object and not the word.
export const CANCEL_INTENT = new RegExp(
  [
    // "cancel my subscription", "stop the payments", "end our plan"
    String.raw`\b(?:cancel(?:l?ing|l?ed)?|unsubscribe|terminate|end|stop)\s+(?:my\s+|the\s+|our\s+|this\s+)?(?:subscription|plan|membership|account|billing|renewal|auto[-\s]?renewal|payments?)\b`,
    // "cancellation request", "cancelation please"
    String.raw`\bcancel+ation\s+(?:request|please)\b`,
    // a bare "please cancel." or "I want to cancel, and ..."
    String.raw`\b(?:please|i\s+(?:want|would\s+like|need)\s+to)\s+cancel\s*(?:[.!,]|$|\s+and\b)`,
    // "unsubscribe me", "don't renew me", "do not charge me again"
    String.raw`\bunsubscribe\s+me\b`,
    String.raw`\b(?:don'?t|do\s+not)\s+(?:renew|charge|bill)\s+(?:me|us|my)\b`,
  ].join("|"),
  "i"
);

export function hasCancelIntent(text: string | null | undefined): boolean {
  return !!text && CANCEL_INTENT.test(text);
}
