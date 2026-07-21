import type Stripe from "stripe";
import { Badge, Cell, ObjectRef } from "../renderer/contract";

// Shared server-side cell/badge factories for dashboard sections. Every
// section builds its Blocks from these so the Stripe atoms (amount + faint
// currency, card chips, sentence-case status pills, object avatars) stay
// identical across pages.

// Minimal slice of StripeClient the formatters need (keeps fakes tiny in tests).
export interface AmountFormatter {
  formatAmount(amount: number, currency: string): string;
}

export function text(v: string, sub?: string): Cell {
  return { t: "text", v, ...(sub ? { sub } : {}) };
}

export function strong(v: string, sub?: string): Cell {
  return { t: "text", v, strong: true, ...(sub ? { sub } : {}) };
}

export function badgeCell(kind: Badge["kind"], t: string): Cell {
  return { t: "badge", b: { kind, text: t } };
}

export function idCell(v: string, opts: { ref?: ObjectRef; copy?: boolean } = {}): Cell {
  return { t: "id", v, ...(opts.ref ? { ref: opts.ref } : {}), ...(opts.copy ? { copy: true } : {}) };
}

// Currencies Stripe treats as zero-decimal (mirror of StripeClient's set —
// kept local so cells.ts stays dependency-light for test fakes).
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

// Stripe amount atom: "€29.00 EUR" (+ optional status pill in the same cell).
// major rides along so the client can sum selections for bulk ceremonies.
export function amount(fmt: AmountFormatter, amountMinor: number, currency: string, badge?: Badge): Cell {
  const major = ZERO_DECIMAL.has(currency.toLowerCase()) ? amountMinor : amountMinor / 100;
  return {
    t: "amount",
    v: fmt.formatAmount(amountMinor, currency),
    cur: currency.toUpperCase(),
    major,
    ...(badge ? { badge } : {}),
  };
}

export function money(fmt: AmountFormatter, amountMinor: number, currency: string, tone?: "pos" | "neg" | "muted"): Cell {
  return { t: "money", v: fmt.formatAmount(amountMinor, currency), ...(tone ? { tone } : {}) };
}

export function cardCell(brand: string, last4: string, sub?: string): Cell {
  return { t: "card", brand, last4, ...(sub ? { sub } : {}) };
}

// Card cell straight from a PaymentMethod (falls back to the PM type label).
export function paymentMethodCell(pm: Stripe.PaymentMethod, sub?: string): Cell {
  if (pm.type === "card" && pm.card) return cardCell(pm.card.brand, pm.card.last4, sub);
  return text(pm.type, sub);
}

export function avatarCell(
  icon: "customer" | "product" | "invoice" | "subscription",
  v: string,
  opts: { sub?: string; ref?: ObjectRef } = {}
): Cell {
  return { t: "avatar", icon, v, ...(opts.sub ? { sub: opts.sub } : {}), ...(opts.ref ? { ref: opts.ref } : {}) };
}

export function dateCell(unixSeconds: number): Cell {
  const iso = new Date(unixSeconds * 1000).toISOString();
  return { t: "date", v: iso.slice(0, 10), iso };
}

export function isoDateCell(d: Date): Cell {
  const iso = d.toISOString();
  return { t: "date", v: iso.slice(0, 10), iso };
}

// ---- count-card labels ----

// Real chip totals come from the Search API, whose total_count caps at 10,000
// — render the cap as an explicit floor. When search is unavailable (no API,
// call failed) callers fall back to the fetched-window count via windowCount,
// suffixed "+" whenever the window overflowed — never a bare wrong number.
export function searchCountLabel(n: number): number | string {
  return n >= 10_000 ? "10,000+" : n;
}

export function windowCount(n: number, windowOverflowed: boolean): number | string {
  return windowOverflowed ? `${n}+` : n;
}

// searchN when the search succeeded, honest windowed fallback otherwise.
export function chipCount(searchN: number | null, windowN: number, windowOverflowed: boolean): number | string {
  return searchN != null ? searchCountLabel(searchN) : windowCount(windowN, windowOverflowed);
}

// One-line postal address ("1 Main St, 10115 Berlin, DE") or null when unset.
export function fmtAddress(a?: Stripe.Address | null): string | null {
  if (!a) return null;
  const parts = [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(" ").trim(), a.state, a.country]
    .map((p) => (p ? String(p).trim() : ""))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

// Route a Stripe object id to its dashboard page (shared by the Home feed and
// the Events page; null when we have no page for that object family).
export function refForId(id: string): ObjectRef | null {
  if (/^cus_/.test(id)) return { page: "customers.detail", params: { id } };
  if (/^(ch|py|pi)_/.test(id)) return { page: "payments.detail", params: { id } };
  if (/^po_/.test(id)) return { page: "balances.detail", params: { id } };
  if (/^sub_/.test(id)) return { page: "subscriptions.detail", params: { id } };
  if (/^in_/.test(id)) return { page: "invoices.detail", params: { id } };
  if (/^(dp|du)_/.test(id)) return { page: "disputes.detail", params: { id } };
  if (/^plink_/.test(id)) return { page: "links.detail", params: { id } };
  if (/^qt_/.test(id)) return { page: "quotes.detail", params: { id } };
  if (/^prod_/.test(id)) return { page: "catalog.detail", params: { id } };
  return null;
}

// ---- daterange filter parsing (shared by every list) ----

const DATE_RANGE_PRESETS: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

// One filter value carries a preset ("7d") or a custom
// "YYYY-MM-DD..YYYY-MM-DD" range. The custom end date is inclusive → lt is
// end+86400. Garbage (or inverted ranges) parses to no bounds at all.
export function parseDateFilter(value: string): { createdGte?: number; createdLt?: number } {
  if (DATE_RANGE_PRESETS[value]) {
    return { createdGte: Math.floor(Date.now() / 1000) - DATE_RANGE_PRESETS[value] * 86400 };
  }
  const m = value.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (!m) return {};
  const gte = Math.floor(Date.parse(`${m[1]}T00:00:00Z`) / 1000);
  const lt = Math.floor(Date.parse(`${m[2]}T00:00:00Z`) / 1000) + 86400;
  if (!Number.isFinite(gte) || !Number.isFinite(lt) || gte >= lt) return {};
  return { createdGte: gte, createdLt: lt };
}

// The preset rows every daterange pill offers (client adds "Custom…").
export const DATE_RANGE_OPTIONS = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

// Stripe pills are sentence case ("Past due"), never raw enum values.
export function sentence(status: string): string {
  const s = status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- status → Badge (returned as Badge so they can ride inside amount cells) ----

export function chargeBadge(charge: Stripe.Charge): Badge {
  if (charge.refunded) return { kind: "neutral", text: "Refunded" };
  if ((charge.amount_refunded ?? 0) > 0) return { kind: "warn", text: "Partial refund" };
  if (charge.disputed) return { kind: "error", text: "Disputed" };
  if (charge.status === "succeeded") return { kind: "ok", text: "Succeeded" };
  if (charge.status === "pending") return { kind: "warn", text: "Pending" };
  return { kind: "error", text: "Failed" };
}

export function subBadge(status: Stripe.Subscription.Status): Badge {
  const kind: Badge["kind"] =
    status === "active" || status === "trialing"
      ? "ok"
      : status === "past_due" || status === "unpaid" || status === "incomplete"
        ? "warn"
        : status === "canceled" || status === "incomplete_expired"
          ? "neutral"
          : "info";
  return { kind, text: sentence(status) };
}

// Full status flag set for a subscription row/header. A sub that already
// ended via a scheduled period-end cancel keeps cancel_at_period_end=true
// forever — "Canceled" + future-tense "Cancels at period end" side by side
// reads as a contradiction, so that pair collapses into one past-tense badge.
export function subStatusFlags(
  sub: Pick<Stripe.Subscription, "status" | "cancel_at_period_end" | "pause_collection">
): Badge[] {
  if (sub.status === "canceled" && sub.cancel_at_period_end) {
    return [{ kind: "neutral", text: "Canceled at period end" }];
  }
  const flags: Badge[] = [subBadge(sub.status)];
  if (sub.pause_collection) flags.push({ kind: "warn", text: "Paused" });
  if (sub.cancel_at_period_end) flags.push({ kind: "warn", text: "Cancels at period end" });
  return flags;
}

export function invoiceBadge(status: Stripe.Invoice.Status | null): Badge {
  const s = status ?? "draft";
  const kind: Badge["kind"] =
    s === "paid" ? "ok" : s === "open" ? "warn" : s === "void" || s === "uncollectible" ? "error" : "neutral";
  return { kind, text: sentence(s) };
}

export function piBadge(status: Stripe.PaymentIntent.Status): Badge {
  const kind: Badge["kind"] =
    status === "succeeded"
      ? "ok"
      : status === "canceled"
        ? "neutral"
        : status === "processing"
          ? "info"
          : "warn"; // requires_* → incomplete family
  const text = status.startsWith("requires_") ? "Incomplete" : sentence(status);
  return { kind, text };
}

// ---- metrics ----

// Normalized monthly recurring revenue per currency, in minor units. Follows
// Stripe's MRR definition: active (incl. past_due) subscriptions, trials
// excluded. Weeks/days normalize via 52/365 per year over 12 months.
export function estimateMrr(subs: Stripe.Subscription[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const sub of subs) {
    if (sub.status !== "active" && sub.status !== "past_due") continue;
    for (const item of sub.items.data) {
      const price = item.price;
      if (!price?.recurring || price.unit_amount == null) continue;
      const per = price.unit_amount * (item.quantity ?? 1);
      const n = price.recurring.interval_count || 1;
      const interval = price.recurring.interval;
      const monthly =
        interval === "month"
          ? per / n
          : interval === "year"
            ? per / (12 * n)
            : interval === "week"
              ? (per * 52) / (12 * n)
              : interval === "day"
                ? (per * 365) / (12 * n)
                : 0;
      if (monthly <= 0) continue;
      out.set(price.currency, (out.get(price.currency) ?? 0) + monthly);
    }
  }
  for (const [k, v] of out) out.set(k, Math.round(v));
  return out;
}

// Per-currency totals joined for display ("€152.00 + $10.00"), or an em dash.
export function formatPerCurrency(fmt: AmountFormatter, byCurrency: Map<string, number>): string {
  const parts = [...byCurrency.entries()].filter(([, v]) => v !== 0).map(([cur, v]) => fmt.formatAmount(v, cur));
  return parts.join(" + ") || "N/A";
}
