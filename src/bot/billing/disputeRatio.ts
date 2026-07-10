import type Stripe from "stripe";

// Account dispute-ratio math, kept PURE (Stripe types only — no discord.js, no
// prisma) so both the bot and the read-only MCP subprocess import the exact
// same computation. Two figures per window:
//   plain — chargeback-stage disputes ÷ succeeded charges (what the Stripe
//           dashboard's dispute rate counts; inquiries reported separately)
//   VAMP  — distinct charges with (any early-fraud warning ∪ any chargeback)
//           ÷ succeeded charges. Directional: Visa's real VAMP counts TC40s +
//           non-fraud disputes over settled Visa transactions and only flags
//           merchants past an absolute monthly event floor.
// All figures are count-based, so mixed currencies are irrelevant.

export type RatioLevel = "ok" | "warn" | "critical";

export interface RatioWindowNumbers {
  succeeded: number;
  chargebacks: number; // chargeback-stage disputes (plain numerator)
  inquiries: number; // warning_* / inquiry-stage disputes (informational)
  fraudDisputes: number; // reason === "fraudulent"
  efws: number;
  vampNumerator: number; // distinct charge ids with EFW ∪ chargeback
  plainPct: number | null; // null = zero denominator
  vampPct: number | null;
}

export interface DisputeRatios {
  computedAt: number; // epoch ms
  truncated: boolean; // a sweep hit its page cap — treat numerators as "≥"
  month: RatioWindowNumbers;
  d30: RatioWindowNumbers;
  d90: RatioWindowNumbers;
}

// The three Stripe reads the computation needs — a structural slice of
// StripeClient so tests can substitute a mock without the full class.
export interface RatioStripeReads {
  listDisputesSince(createdGte: number, maxPages?: number): Promise<{ disputes: Stripe.Dispute[]; truncated: boolean }>;
  listEarlyFraudWarningsSince(
    createdGte: number,
    maxPages?: number
  ): Promise<{ efws: Stripe.Radar.EarlyFraudWarning[]; truncated: boolean }>;
  countSucceededCharges(createdGte: number, createdLt?: number): Promise<number>;
}

// Stripe's Search API caps total_count at 10,000 — a busy window reports
// exactly 10000 instead of the real count (observed in prod: 90d showed
// 36/10000 while 30d alone had ~7k charges). SEARCH_TOTAL_CAP is the detection
// threshold; countWithSearchCap makes counts exact by splitting a capped time
// slice in half and summing, recursing until every slice is under the cap (or
// an hour wide — beyond that the cap is accepted as the floor).
export const SEARCH_TOTAL_CAP = 10_000;
const MIN_SLICE_S = 3600;

export async function countWithSearchCap(
  countOnce: (gte: number, lt: number) => Promise<number>,
  gte: number,
  lt: number
): Promise<number> {
  const count = await countOnce(gte, lt);
  if (count < SEARCH_TOTAL_CAP || lt - gte <= MIN_SLICE_S) return count;
  const mid = Math.floor((gte + lt) / 2);
  const [left, right] = await Promise.all([
    countWithSearchCap(countOnce, gte, mid),
    countWithSearchCap(countOnce, mid, lt),
  ]);
  return left + right;
}

const DAY_S = 24 * 60 * 60;

// Unix seconds for the three window starts. Month = UTC 1st 00:00 (VAMP and
// the other network programs are calendar-month based).
export function windowStarts(now: Date = new Date()): { month: number; d30: number; d90: number } {
  const nowS = Math.floor(now.getTime() / 1000);
  const month = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
  return { month, d30: nowS - 30 * DAY_S, d90: nowS - 90 * DAY_S };
}

// A dispute that is (or became) a formal chargeback — not an inquiry/retrieval.
// Card disputes carry an explicit case_type; non-card disputes fall back to
// "not in the warning_* inquiry stage".
export function isChargebackStage(d: Stripe.Dispute): boolean {
  const caseType = d.payment_method_details?.card?.case_type;
  if (caseType) return caseType === "chargeback";
  return !d.status.startsWith("warning_");
}

function chargeIdOf(obj: { charge: string | { id: string } | null }): string | null {
  return typeof obj.charge === "string" ? obj.charge : (obj.charge?.id ?? null);
}

// Distinct charges having an EFW or a chargeback — a charge with both (the
// common fraud sequence: TC40 first, chargeback later) counts exactly once.
export function computeVampNumerator(disputes: Stripe.Dispute[], efws: Stripe.Radar.EarlyFraudWarning[]): number {
  const charges = new Set<string>();
  for (const d of disputes) {
    const id = chargeIdOf(d);
    if (id && isChargebackStage(d)) charges.add(id);
  }
  for (const e of efws) {
    const id = chargeIdOf(e);
    if (id) charges.add(id);
  }
  return charges.size;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

export function buildWindowNumbers(
  disputes: Stripe.Dispute[],
  efws: Stripe.Radar.EarlyFraudWarning[],
  succeeded: number
): RatioWindowNumbers {
  const chargebacks = disputes.filter(isChargebackStage);
  const vampNumerator = computeVampNumerator(disputes, efws);
  return {
    succeeded,
    chargebacks: chargebacks.length,
    inquiries: disputes.length - chargebacks.length,
    fraudDisputes: disputes.filter((d) => d.reason === "fraudulent").length,
    efws: efws.length,
    vampNumerator,
    plainPct: pct(chargebacks.length, succeeded),
    vampPct: pct(vampNumerator, succeeded),
  };
}

// One 90-day fetch each of disputes + EFWs (bucketed client-side per window)
// plus succeeded-charge counts via charges.search (cap-split, so exact).
export async function computeDisputeRatios(stripe: RatioStripeReads, now: Date = new Date()): Promise<DisputeRatios> {
  const starts = windowStarts(now);
  const nowS = Math.floor(now.getTime() / 1000) + 60; // +60s: search indexing lag headroom
  const [disputesRes, efwsRes, succMonth, succ30, succ90] = await Promise.all([
    stripe.listDisputesSince(starts.d90),
    stripe.listEarlyFraudWarningsSince(starts.d90),
    stripe.countSucceededCharges(starts.month, nowS),
    stripe.countSucceededCharges(starts.d30, nowS),
    stripe.countSucceededCharges(starts.d90, nowS),
  ]);

  const bucket = (gte: number) => ({
    disputes: disputesRes.disputes.filter((d) => d.created >= gte),
    efws: efwsRes.efws.filter((e) => e.created >= gte),
  });
  const m = bucket(starts.month);
  const w30 = bucket(starts.d30);

  return {
    computedAt: now.getTime(),
    truncated: disputesRes.truncated || efwsRes.truncated,
    month: buildWindowNumbers(m.disputes, m.efws, succMonth),
    d30: buildWindowNumbers(w30.disputes, w30.efws, succ30),
    d90: buildWindowNumbers(disputesRes.disputes, efwsRes.efws, succ90),
  };
}

// Threshold level for alerting — driven by the current calendar month's VAMP
// figure (the superset numerator, and the window the networks actually watch).
export function ratioLevel(r: DisputeRatios, warnPct: number, criticalPct: number): RatioLevel {
  const value = r.month.vampPct;
  if (value == null) return "ok";
  if (value >= criticalPct) return "critical";
  if (value >= warnPct) return "warn";
  return "ok";
}

function fmtPct(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(2)}%`;
}

// One embed-friendly line per window, shared by the hub header and the
// threshold-alert embeds so both always show identical numbers. "inquiry-stage"
// counts disputes created in the window that are CURRENTLY at inquiry stage
// (incl. closed inquiries) — one recent inquiry therefore shows up in every
// window, which is expected, not a stuck counter.
export function describeRatioWindow(label: string, w: RatioWindowNumbers, truncated: boolean): string {
  const approx = truncated ? "≥" : "";
  const plain = `${approx}${w.chargebacks}/${w.succeeded} = ${fmtPct(w.plainPct)}`;
  const vamp = `${approx}${w.vampNumerator}/${w.succeeded} = ${fmtPct(w.vampPct)}`;
  const inquiries = w.inquiries > 0 ? ` · ${w.inquiries} at inquiry stage` : "";
  return `**${label}** · disputes ${plain} · VAMP-style ${vamp}${inquiries}`;
}

// 15-minute single-flight cache — one shared instance serves the /billing hub
// and the dispute looper; the MCP subprocess computes fresh per call instead.
export class CachedRatioEngine {
  private cache: { at: number; value: DisputeRatios } | null = null;
  private inFlight: Promise<DisputeRatios> | null = null;

  constructor(
    private stripe: RatioStripeReads,
    private ttlMs = 15 * 60_000
  ) {}

  async get(force = false): Promise<DisputeRatios> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    if (this.inFlight) return this.inFlight;
    this.inFlight = computeDisputeRatios(this.stripe)
      .then((value) => {
        this.cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  cachedAt(): number | null {
    return this.cache?.at ?? null;
  }
}
