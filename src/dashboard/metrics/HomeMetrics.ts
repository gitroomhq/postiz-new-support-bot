import type Stripe from "stripe";
import { StripeClient } from "../../bot/StripeClient";
import { SettingsStore } from "../../config/SettingsStore";
import { DisputeStore } from "../../bot/billing/DisputeStore";
import { SeriesResponse } from "../renderer/contract";

// Home chart series + expensive counters, behind a 10-minute in-memory cache
// with singleflight and serve-stale-while-refreshing. In-process by design:
// this deploy has no external cache available (no Railway access — no Redis).
// Every sweep carries a maxPages guard and reports truncation in `note`.

const TTL_MS = 10 * 60 * 1000;
const STALE_MAX_MS = 60 * 60 * 1000; // beyond this a dead cache entry recomputes inline
const DAY_MS = 86_400_000;

const WINDOW_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

interface CacheEntry {
  at: number;
  data: SeriesResponse | null;
  inflight?: Promise<SeriesResponse | null>;
}

export class HomeMetrics {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private stripe: StripeClient,
    private settings: SettingsStore,
    private disputes: DisputeStore
  ) {}

  // Cached active-subscription count for the Home stat tile. The account has
  // >1000 active subs, so the sweep is EXHAUSTIVE (10k-page runaway guard) and
  // always runs in the background: the view never blocks on it — the first
  // load renders "counting…" (null) and the cached number appears afterwards.
  private subsCache: { at: number; value: { count: number; truncated: boolean } } | null = null;
  private subsInflight: Promise<{ count: number; truncated: boolean }> | null = null;

  async activeSubsCount(): Promise<{ count: number; truncated: boolean } | null> {
    const now = Date.now();
    if (this.subsCache && now - this.subsCache.at < TTL_MS) return this.subsCache.value;
    if (!this.subsInflight) {
      this.subsInflight = this.stripe
        .countActiveSubscriptions(100)
        .then((value) => {
          this.subsCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          this.subsInflight = null;
        });
      void this.subsInflight.catch(() => {});
    }
    // Stale beats blocking; null on the very first load beats a 30s hang.
    return this.subsCache?.value ?? null;
  }

  // Series entry point (the `series` endpoint). null = unknown key/window.
  async series(key: string, window: string): Promise<SeriesResponse | null> {
    if (!WINDOW_DAYS[window]) return null;
    if (!["gross_volume", "new_customers", "mrr_by_plan", "failed_payments", "dispute_ratio"].includes(key)) return null;
    const id = `${key}:${window}`;
    const hit = this.cache.get(id);
    const now = Date.now();
    if (hit?.data && now - hit.at < TTL_MS) return hit.data;
    if (hit?.inflight) return hit.data ?? hit.inflight;

    const inflight = this.compute(key, window)
      .catch(() => null)
      .then((data) => {
        this.cache.set(id, { at: Date.now(), data: data ?? this.cache.get(id)?.data ?? null });
        return data;
      });
    this.cache.set(id, { at: hit?.at ?? 0, data: hit?.data ?? null, inflight });

    // Serve stale (marked) while the refresh runs in the background.
    if (hit?.data && now - hit.at < STALE_MAX_MS) {
      void inflight.catch(() => {});
      return { ...hit.data, stale: true };
    }
    return inflight;
  }

  private async compute(key: string, window: string): Promise<SeriesResponse | null> {
    switch (key) {
      case "gross_volume":
        return this.grossVolume(window);
      case "new_customers":
        return this.newCustomers(window);
      case "mrr_by_plan":
        return this.mrrByPlan();
      case "failed_payments":
        return this.failedPayments(window);
      case "dispute_ratio":
        return this.disputeRatio();
      default:
        return null;
    }
  }

  // ---- gross volume: daily sums of charge-type balance transactions ----

  private async grossVolume(window: string): Promise<SeriesResponse> {
    const days = WINDOW_DAYS[window];
    const since = Math.floor((Date.now() - days * DAY_MS) / 1000);
    const { rows, truncated } = await this.sweep((startingAfter) =>
      this.stripe
        .listAccountBalanceTransactions({ limit: 100, createdGte: since, startingAfter, type: "charge" })
        .then((r) => ({ items: r.transactions, hasMore: r.hasMore }))
    );
    // Multi-currency: chart the top-volume currency, list the rest in the note.
    const byCurrency = new Map<string, Stripe.BalanceTransaction[]>();
    for (const t of rows) {
      const list = byCurrency.get(t.currency) ?? [];
      list.push(t);
      byCurrency.set(t.currency, list);
    }
    const top = [...byCurrency.entries()].sort(
      (a, b) => b[1].reduce((s, t) => s + t.amount, 0) - a[1].reduce((s, t) => s + t.amount, 0)
    )[0];
    const currency = top?.[0] ?? "usd";
    const buckets = this.dailyBuckets(days);
    for (const t of top?.[1] ?? []) this.addToBucket(buckets, t.created, t.amount / this.minorFactor(currency));
    const others = [...byCurrency.keys()].filter((c) => c !== currency);
    return {
      key: "gross_volume",
      unit: "currency",
      currency: currency.toUpperCase(),
      points: buckets,
      note:
        (truncated ? "Truncated sweep — oldest days undercount. " : "") +
        (others.length ? `Only ${currency.toUpperCase()} charted (also saw ${others.map((c) => c.toUpperCase()).join(", ")}).` : "") || undefined,
    };
  }

  // ---- new customers per day ----

  private async newCustomers(window: string): Promise<SeriesResponse> {
    const days = WINDOW_DAYS[window];
    const since = Math.floor((Date.now() - days * DAY_MS) / 1000);
    const { rows, truncated } = await this.sweep((startingAfter) =>
      this.stripe
        .listCustomersPage({ limit: 100, createdGte: since, startingAfter })
        .then((r) => ({ items: r.customers, hasMore: r.hasMore }))
    );
    const buckets = this.dailyBuckets(days);
    for (const c of rows) this.addToBucket(buckets, c.created, 1);
    return {
      key: "new_customers",
      unit: "count",
      points: buckets,
      ...(truncated ? { note: "Truncated sweep — oldest days undercount." } : {}),
    };
  }

  // ---- MRR estimate by plan (bars; no history without a mirror) ----

  private async mrrByPlan(): Promise<SeriesResponse> {
    // >1000 active subs on this account — sweep deep (chart hydration is
    // async client-side, and the result caches for 10 minutes).
    const { rows, truncated } = await this.sweep(
      (startingAfter) =>
        this.stripe
          .listAllSubscriptions({ status: "active", limit: 100, startingAfter })
          .then((r) => ({ items: r.subscriptions, hasMore: r.hasMore })),
      100
    );
    const byPlan = new Map<string, { monthly: number; currency: string }>();
    for (const sub of rows) {
      for (const item of sub.items.data) {
        const price = item.price;
        if (!price?.recurring || price.unit_amount == null) continue;
        const per = price.unit_amount * (item.quantity ?? 1);
        const n = price.recurring.interval_count || 1;
        const monthly =
          price.recurring.interval === "month"
            ? per / n
            : price.recurring.interval === "year"
              ? per / (12 * n)
              : price.recurring.interval === "week"
                ? (per * 52) / (12 * n)
                : (per * 365) / (12 * n);
        const label = price.nickname ?? price.id.slice(0, 14);
        const bucket = byPlan.get(label) ?? { monthly: 0, currency: price.currency };
        bucket.monthly += monthly;
        byPlan.set(label, bucket);
      }
    }
    const entries = [...byPlan.entries()].sort((a, b) => b[1].monthly - a[1].monthly).slice(0, 8);
    const currency = entries[0]?.[1].currency ?? "usd";
    return {
      key: "mrr_by_plan",
      unit: "currency",
      currency: currency.toUpperCase(),
      points: entries.map(([label, v]) => ({
        label,
        v: Math.round((v.monthly / this.minorFactor(currency)) * 100) / 100,
      })),
      note:
        "MRR estimate from active subscriptions (trials excluded from Stripe's definition are included here when active)." +
        (truncated ? " Truncated sweep." : ""),
    };
  }

  // ---- failed payments per day ----

  private async failedPayments(window: string): Promise<SeriesResponse> {
    const days = WINDOW_DAYS[window];
    const since = Math.floor((Date.now() - days * DAY_MS) / 1000);
    const { rows, truncated } = await this.sweep((startingAfter) =>
      this.stripe
        .listAllCharges({ limit: 100, createdGte: since, startingAfter })
        .then((r) => ({ items: r.charges, hasMore: r.hasMore }))
    );
    const buckets = this.dailyBuckets(days);
    for (const c of rows) if (c.status === "failed") this.addToBucket(buckets, c.created, 1);
    return {
      key: "failed_payments",
      unit: "count",
      points: buckets,
      ...(truncated ? { note: "Truncated sweep — oldest days undercount." } : {}),
    };
  }

  // ---- dispute ratio trend (monthly, mirror numerator / live denominator) ----

  private async disputeRatio(): Promise<SeriesResponse> {
    const months = 6;
    const points: SeriesResponse["points"] = [];
    const now = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const to = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const [disputes, charges] = await Promise.all([
        this.disputes.countCreatedBetween(from, to),
        this.stripe.countSucceededCharges(Math.floor(from.getTime() / 1000), Math.floor(to.getTime() / 1000)).catch(() => 0),
      ]);
      const pct = charges > 0 ? (disputes / charges) * 100 : 0;
      points.push({ label: from.toISOString().slice(0, 7), v: Math.round(pct * 100) / 100 });
    }
    return {
      key: "dispute_ratio",
      unit: "percent",
      points,
      bands: [
        { v: this.settings.disputeRatioWarnPct(), kind: "warn", label: "warn" },
        { v: this.settings.disputeRatioCriticalPct(), kind: "error", label: "critical" },
      ],
      note: "Disputes from the local mirror ÷ succeeded charges (plain ratio, monthly). VAMP view lives in /billing → Disputes.",
    };
  }

  // ---- helpers ----

  // Cursor sweep with a hard page cap; reports truncation instead of hiding it.
  private async sweep<T extends { id: string; created: number }>(
    fetchPage: (startingAfter?: string) => Promise<{ items: T[]; hasMore: boolean }>,
    maxPages = 10
  ): Promise<{ rows: T[]; truncated: boolean }> {
    const rows: T[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await fetchPage(startingAfter);
      rows.push(...res.items);
      if (!res.hasMore || res.items.length === 0) return { rows, truncated: false };
      startingAfter = res.items[res.items.length - 1].id;
    }
    return { rows, truncated: true };
  }

  private dailyBuckets(days: number): Array<{ label: string; v: number }> {
    const out: Array<{ label: string; v: number }> = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * DAY_MS);
      out.push({ label: d.toISOString().slice(5, 10), v: 0 });
    }
    return out;
  }

  private addToBucket(buckets: Array<{ label: string; v: number }>, unixSeconds: number, delta: number): void {
    const label = new Date(unixSeconds * 1000).toISOString().slice(5, 10);
    const bucket = buckets.find((b) => b.label === label);
    if (bucket) bucket.v = Math.round((bucket.v + delta) * 100) / 100;
  }

  private minorFactor(currency: string): number {
    return StripeClient.isZeroDecimal(currency) ? 1 : 100;
  }
}
