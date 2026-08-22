import type Stripe from "stripe";
import { StripeClient } from "../StripeClient";
import { SettingsStore } from "../../config/SettingsStore";
import { MoneyOutStore } from "./MoneyOutStore";
import {
  classifyBalanceConcession,
  buildRefundFeeRow,
  classifyBalanceTransaction,
  classifyCreditNote,
  classifyDiscount,
  classifyWriteOff,
  type MoneyOutCategory,
  type MoneyOutRow,
  type MoneyOutSource,
} from "./moneyOutTaxonomy";
import { exportMoneyOut, exportMoneyOutSweep } from "../../metrics/MetricsExporter";
import { flushInflux, influxActive } from "../../metrics/InfluxWriter";
import { log } from "../../util/logger";
import type { MoneyOutTickResult } from "../../temporal/types";

const moneyLog = log.child("money-out");

const DAY_S = 24 * 60 * 60;
// Re-read this far behind the cursor on every sweep. Balance transactions are
// created slightly after the event they describe, so a cursor advanced to
// "now" would step over transactions still landing. Upsert-by-id makes the
// overlap free.
const SWEEP_OVERLAP_S = 15 * 60;
// First-ever sweep with no cursor: how far back to walk. Deliberately short —
// history is the backfill button's job, not the tick's.
const FIRST_SWEEP_LOOKBACK_S = 7 * DAY_S;
// Runaway guards. A normal tick reads one or two pages.
const PAGE_SIZE = 100;
const MAX_PAGES_PER_TICK = 40;
const MAX_PAGES_BACKFILL = 2_000;
// Per page, how many charge reads the sweep will spend resolving customer ids.
// Attribution is a nice-to-have column; the totals never depend on it, so this
// is capped rather than allowed to dominate a backfill's runtime.
const MAX_CUSTOMER_LOOKUPS_PER_PAGE = 20;
// Flush the Influx buffer every N points during the backfill's re-emission —
// the client drops points once its 5000-line buffer fills.
const BACKFILL_FLUSH_EVERY = 500;

// Which half of the history to import. "concessions" exists because coupons,
// credit notes and write-offs can be added to an account whose ledger is
// already imported, and re-walking every balance transaction to get them would
// be pure waste.
export type MoneyOutBackfillScope = "all" | "ledger" | "concessions";

export interface MoneyOutBackfillResult {
  scanned: number;
  created: number;
  points: number;
  truncated: boolean;
  // Concessions have no balance transaction, so they are swept from their own
  // endpoints rather than the ledger.
  creditNotes: number;
  writeOffs: number;
  discounts: number;
  // Discounts that ended before the backfill ran cannot be recovered: Stripe
  // has no list endpoint for historical discounts, only the live ones still
  // attached to a subscription or customer.
  discountsHistoricalUnavailable: boolean;
}

// The money-out ledger engine.
//
// The balance-transaction sweep is the ONLY writer of cash rows (kind=LEDGER,
// keyed on txn_…). Webhooks never write a cash row directly — they call
// syncForObject, which sweeps just that object's transactions. That single-
// writer rule is what makes webhook + reconcile + backfill idempotent without
// any dedupe logic: every path upserts the same primary key.
//
// Concessions (credit notes, discounts, write-offs, credit grants, balance
// credits) have no balance transaction at all, so they are written directly and
// keyed on their Stripe object id — a disjoint key space that cannot collide.
export class MoneyOutService {
  constructor(
    private settings: SettingsStore,
    private stripe: StripeClient,
    private store: MoneyOutStore
  ) {}

  // Pass-through so /config can read what the mirror holds without reaching
  // past the service into the store.
  coverage(): ReturnType<MoneyOutStore["coverage"]> {
    return this.store.coverage();
  }

  // ---- ledger path ----

  // The looper tick: walk forward from the cursor, upsert what is new, advance.
  // onProgress is the Temporal heartbeat — a first sweep against a busy account
  // can page for minutes, which would otherwise trip the heartbeat timeout.
  async reconcile(onProgress?: () => void): Promise<MoneyOutTickResult> {
    const result: MoneyOutTickResult = { scanned: 0, created: 0, errors: 0, truncated: false, skipped: true };
    if (!this.settings.moneyOutEnabled()) {
      // Still emit the gauge: a silent measurement must mean "the tick is not
      // running", never "the tick ran and chose to do nothing".
      exportMoneyOutSweep({ scanned: 0, created: 0, errors: 0, lagSeconds: 0, skipped: true });
      return result;
    }
    result.skipped = false;

    const cursor = this.settings.moneyOutSweepAt();
    const startedAt = new Date();
    const createdGte = cursor
      ? Math.floor(cursor.getTime() / 1000) - SWEEP_OVERLAP_S
      : Math.floor(startedAt.getTime() / 1000) - FIRST_SWEEP_LOOKBACK_S;

    try {
      const swept = await this.sweep({ createdGte, maxPages: MAX_PAGES_PER_TICK, source: "sweep", onProgress });
      result.scanned = swept.scanned;
      result.created = swept.created;
      result.truncated = swept.truncated;
    } catch (error) {
      result.errors++;
      moneyLog.error("money-out reconcile failed", error);
    }

    // Only advance the cursor on a clean, untruncated pass — a truncated sweep
    // has NOT seen everything up to `startedAt`, and moving the cursor there
    // would silently skip the remainder forever.
    if (result.errors === 0 && !result.truncated) {
      await this.settings.updateMoneyOut({ moneyOutSweepAt: startedAt }).catch((e) => {
        moneyLog.warn("money-out cursor advance failed", { "error.message": String(e) });
      });
    }

    const lagSeconds = Math.max(0, Math.round((Date.now() - (this.settings.moneyOutSweepAt()?.getTime() ?? Date.now())) / 1000));
    exportMoneyOutSweep({
      scanned: result.scanned,
      created: result.created,
      errors: result.errors,
      lagSeconds,
      skipped: false,
    });
    return result;
  }

  // Targeted mini-sweep for one object, called from the Stripe webhook so a
  // refund issued in the Stripe Dashboard lands in the ledger within seconds
  // instead of at the next tick. Same writer, same keys — just narrower.
  async syncForObject(sourceId: string): Promise<number> {
    if (!this.settings.moneyOutEnabled()) return 0;
    const swept = await this.sweep({ sourceId, maxPages: 5, source: "webhook" });
    return swept.created;
  }

  // All-time history import, in selectable scopes.
  //
  // The two halves have nothing in common: the LEDGER comes from balance
  // transactions, CONCESSIONS from credit-note / invoice / subscription
  // endpoints. Adding coupons to an account whose ledger is already imported
  // should not re-walk every balance transaction Stripe has, so each half runs
  // on its own.
  //
  // Idempotent throughout: rows key on their Stripe id, and points carry each
  // row's real occurredAt, so identical points overwrite rather than double-count.
  async backfillHistory(
    opts: { scope?: MoneyOutBackfillScope; reemitAll?: boolean; onProgress?: () => void } = {}
  ): Promise<MoneyOutBackfillResult> {
    const scope = opts.scope ?? "all";
    const onProgress = opts.onProgress;
    // No per-charge customer lookups: an all-time sweep would otherwise spend
    // thousands of Stripe reads on a display column. Points ARE emitted inline
    // (each row carries its real timestamp), so there is no second full-table
    // walk in the normal case.
    const swept =
      scope === "concessions"
        ? { scanned: 0, created: 0, truncated: false }
        : await this.sweep({
            maxPages: MAX_PAGES_BACKFILL,
            source: "backfill",
            resolveCustomers: false,
            onProgress,
          });

    // Concessions come from their own endpoints — the ledger sweep above has
    // no trail for them at all.
    const concessions =
      scope === "ledger"
        ? { creditNotes: 0, writeOffs: 0, discounts: 0, discountsHistoricalUnavailable: false }
        : await this.backfillConcessions(onProgress);

    // Opt-in only: re-emit the WHOLE mirror at historical timestamps. Needed
    // exactly once, when Influx is enabled AFTER rows were already imported —
    // every other run emits its new rows inline as it writes them.
    let points = 0;
    if (opts.reemitAll && influxActive()) {
      let sinceFlush = 0;
      for await (const batch of this.store.iterateAll()) {
        onProgress?.();
        for (const row of batch) {
          exportMoneyOut({
            bucket: row.bucket,
            category: row.category,
            currency: row.currency,
            source: "backfill",
            amountMinor: row.amountMinor,
            feeMinor: row.feeMinor,
            netMinor: row.netMinor,
            ts: row.occurredAt,
          });
          points++;
          // The client silently DROPS points once its buffer fills, which on an
          // all-time history would quietly lose most of it.
          if (++sinceFlush >= BACKFILL_FLUSH_EVERY) {
            sinceFlush = 0;
            await flushInflux();
          }
        }
      }
      await flushInflux();
    }

    await this.settings.updateMoneyOut({ moneyOutBackfillDoneAt: new Date() }).catch(() => undefined);
    return {
      scanned: swept.scanned,
      created: swept.created,
      points,
      truncated: swept.truncated,
      ...concessions,
    };
  }

  // Concessions leave NO balance transaction, so the ledger sweep above cannot
  // see a single one of them — which is why the concession bucket reads zero
  // until this runs. Each source is swept from its own endpoint instead.
  private async backfillConcessions(onProgress?: () => void): Promise<{
    creditNotes: number;
    writeOffs: number;
    discounts: number;
    discountsHistoricalUnavailable: boolean;
  }> {
    let creditNotes = 0;
    let writeOffs = 0;
    let discounts = 0;

    // ---- credit notes ----
    try {
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_PAGES_BACKFILL; page++) {
        onProgress?.();
        const res = await this.stripe.listAllCreditNotes({ limit: 100, ...(startingAfter ? { startingAfter } : {}) });
        for (const note of res.notes) {
          await this.recordCreditNote(note, "backfill");
          creditNotes++;
        }
        if (!res.hasMore || res.notes.length === 0) break;
        startingAfter = res.notes[res.notes.length - 1].id;
      }
    } catch (error) {
      moneyLog.warn("money-out credit note backfill failed", { "error.message": String(error) });
    }

    // ---- write-offs (void + uncollectible invoices) ----
    for (const status of ["void", "uncollectible"] as const) {
      try {
        let startingAfter: string | undefined;
        for (let page = 0; page < MAX_PAGES_BACKFILL; page++) {
          onProgress?.();
          const res = await this.stripe.listInvoicesByStatus(null, status, 100, startingAfter);
          for (const invoice of res.data) {
            await this.recordWriteOff(invoice, "backfill");
            writeOffs++;
          }
          if (!res.has_more || res.data.length === 0) break;
          startingAfter = res.data[res.data.length - 1].id;
        }
      } catch (error) {
        moneyLog.warn("money-out write-off backfill failed", { "money_out.status": status, "error.message": String(error) });
      }
    }

    // ---- discounts, live ones only ----
    // Stripe exposes no way to list discounts that have already ended, so this
    // captures what is currently attached and nothing older. Reported honestly
    // rather than left to look like a complete history.
    try {
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_PAGES_BACKFILL; page++) {
        onProgress?.();
        const res = await this.stripe.listAllSubscriptions({
          status: "active",
          limit: 100,
          expandDiscounts: true,
          ...(startingAfter ? { startingAfter } : {}),
        });
        for (const sub of res.subscriptions) {
          const booked = await this.recordDiscountsOn(sub.discounts, {
            customerId: idOf(sub.customer as string | { id: string } | null),
            subscriptionId: sub.id,
            createdFallback: sub.created,
          });
          if (booked) discounts++;
        }
        if (!res.hasMore || res.subscriptions.length === 0) break;
        startingAfter = res.subscriptions[res.subscriptions.length - 1].id;
      }
    } catch (error) {
      moneyLog.warn("money-out discount backfill failed", { "error.message": String(error) });
    }

    // Customer-level coupons: applied to the customer rather than one
    // subscription, so the subscription walk above never sees them.
    try {
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_PAGES_BACKFILL; page++) {
        onProgress?.();
        const res = await this.stripe.listCustomersPage({
          limit: 100,
          ...(startingAfter ? { startingAfter } : {}),
        });
        for (const customer of res.customers) {
          const discount = (customer as { discount?: Stripe.Discount | null }).discount;
          if (!discount) continue;
          const booked = await this.recordDiscountsOn(discount, {
            customerId: customer.id,
            subscriptionId: null,
            createdFallback: customer.created,
          });
          if (booked) discounts++;
        }
        if (!res.hasMore || res.customers.length === 0) break;
        startingAfter = res.customers[res.customers.length - 1].id;
      }
    } catch (error) {
      moneyLog.warn("money-out customer discount backfill failed", { "error.message": String(error) });
    }

    return { creditNotes, writeOffs, discounts, discountsHistoricalUnavailable: true };
  }

  // Books every discount attached to a subscription or a customer. Returns true
  // when at least one was recorded, so the caller counts subjects rather than
  // raw coupon objects.
  private async recordDiscountsOn(
    discounts: Array<string | Stripe.Discount> | Stripe.Discount | null | undefined,
    scope: { customerId: string | null; subscriptionId: string | null; createdFallback: number }
  ): Promise<boolean> {
    const list = Array.isArray(discounts) ? discounts : discounts ? [discounts] : [];
    let any = false;
    for (const raw of list) {
      // An unexpanded DISCOUNT is a dead end: Stripe has no discounts.retrieve.
      if (typeof raw === "string") continue;
      // An unexpanded COUPON is not — and it is the common case, which is why
      // skipping it made the coupon backfill report zero every time.
      const coupon = await this.resolveCoupon(raw.source?.coupon ?? null);
      if (!coupon) continue;

      let baseMinor = 0;
      let currency = coupon.currency ?? "usd";
      if (coupon.percent_off != null) {
        const priced = await this.priceDiscountBase(scope.customerId, scope.subscriptionId).catch(() => null);
        if (!priced) continue;
        baseMinor = priced.baseMinor;
        currency = priced.currency;
      }
      await this.recordDiscount({
        discountId: raw.id,
        customerId: scope.customerId,
        currency,
        baseMinor,
        percentOff: coupon.percent_off,
        amountOffMinor: coupon.amount_off,
        reason: `${coupon.name ?? coupon.id}${coupon.duration ? ` (${coupon.duration})` : ""}`,
        occurredAt: new Date((raw.start ?? scope.createdFallback) * 1000),
        source: "backfill",
      });
      any = true;
    }
    return any;
  }

  // One charge read per distinct charge for the life of the sweep: several
  // partial refunds of the same payment are the common case.
  private chargeFeeCache = new Map<string, { amount: number; feeMinor: number; currency: string } | null>();

  private async chargeWithFee(chargeId: string): Promise<{ amount: number; feeMinor: number; currency: string } | null> {
    if (this.chargeFeeCache.has(chargeId)) return this.chargeFeeCache.get(chargeId) ?? null;
    const fetched = await this.stripe.getChargeWithFee(chargeId).catch(() => null);
    this.chargeFeeCache.set(chargeId, fetched);
    return fetched;
  }

  // Coupons arrive as bare ids far more often than as objects, and the same
  // handful of coupons repeat across every subscription, so this is cached for
  // the life of the sweep.
  private couponCache = new Map<string, Stripe.Coupon | null>();

  private async resolveCoupon(coupon: string | Stripe.Coupon | null): Promise<Stripe.Coupon | null> {
    if (!coupon) return null;
    if (typeof coupon !== "string") return coupon;
    if (this.couponCache.has(coupon)) return this.couponCache.get(coupon) ?? null;
    const fetched = await this.stripe.getCoupon(coupon).catch(() => null);
    this.couponCache.set(coupon, fetched);
    return fetched;
  }

  // The shared pager behind reconcile / syncForObject / backfillHistory.
  private async sweep(opts: {
    createdGte?: number;
    sourceId?: string;
    maxPages: number;
    source: MoneyOutSource;
    emitPoints?: boolean;
    onProgress?: () => void;
    resolveCustomers?: boolean;
    resolveRefundFees?: boolean;
  }): Promise<{ scanned: number; created: number; truncated: boolean }> {
    const emitPoints = opts.emitPoints !== false;
    let startingAfter: string | undefined;
    let scanned = 0;
    let created = 0;
    let pages = 0;

    for (;;) {
      const page = await this.stripe.listAccountBalanceTransactions({
        limit: PAGE_SIZE,
        expandSource: true,
        ...(startingAfter ? { startingAfter } : {}),
        ...(opts.createdGte ? { createdGte: opts.createdGte } : {}),
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
      });
      pages++;
      opts.onProgress?.();

      // Classify the whole page first, then write it in ONE batch. Doing this
      // per row cost two queries each, which is what made an all-time backfill
      // take minutes on a busy account.
      const pageRows: MoneyOutRow[] = [];
      for (const bt of page.transactions) {
        scanned++;
        const rows = classifyBalanceTransaction(bt, opts.source);
        if (rows.length === 0) continue;
        pageRows.push(...this.attachCustomerFromSource(rows, bt));
      }

      // Fees lost to refunds. Stripe keeps the ORIGINAL charge's processing fee
      // when you refund, and that fee lives only on the charge's balance
      // transaction — the refund's own carries none, which is why this needs a
      // lookup rather than a field. Not capped like customer attribution: this
      // feeds a total, so quietly sampling it would understate real losses.
      if (opts.resolveRefundFees !== false) {
        for (const movement of pageRows.filter((r) => r.category === "refund" || r.category === "refund_failure")) {
          if (!movement.chargeId) continue;
          const charge = await this.chargeWithFee(movement.chargeId);
          if (!charge) continue;
          const feeRow = buildRefundFeeRow(movement, charge);
          if (feeRow) pageRows.push(feeRow);
        }
      }

      const fresh = await this.store.insertNew(pageRows);
      created += fresh.length;
      if (emitPoints) {
        for (const row of fresh) {
          exportMoneyOut({
            bucket: row.bucket,
            category: row.category,
            currency: row.currency,
            source: row.source,
            amountMinor: row.amountMinor,
            feeMinor: row.feeMinor,
            netMinor: row.netMinor,
            ts: row.occurredAt,
          });
        }
        // The Influx client drops points once its buffer fills (5000 lines), so
        // a long sweep MUST flush as it goes or it silently loses history.
        await flushInflux();
      }

      // Customer attribution for rows the expanded source couldn't answer.
      // Deliberately AFTER the write and only for genuinely new rows: it costs
      // a Stripe read per charge, and a missing customer id degrades one
      // dashboard column rather than the totals.
      if (opts.resolveCustomers !== false) await this.backfillCustomers(fresh);
      if (!page.hasMore || page.transactions.length === 0) {
        return { scanned, created, truncated: false };
      }
      if (pages >= opts.maxPages) {
        moneyLog.warn("money-out sweep hit the page cap", { "money_out.pages": pages, "money_out.scanned": scanned });
        return { scanned, created, truncated: true };
      }
      startingAfter = page.transactions[page.transactions.length - 1].id;
    }
  }

  // Free attribution: the expanded source often already names the customer.
  // No network, so it runs for every row before the batch write.
  private attachCustomerFromSource(rows: MoneyOutRow[], bt: Stripe.BalanceTransaction): MoneyOutRow[] {
    const src = bt.source;
    if (!src || typeof src === "string") return rows;
    const customerId = idOf((src as { customer?: string | { id: string } | null }).customer ?? null);
    if (!customerId) return rows;
    return rows.map((r) => ({ ...r, customerId: r.customerId ?? customerId }));
  }

  // Paid attribution: one charge read per distinct charge, and only for rows
  // that ended up without a customer. Bounded per page so a backfill over an
  // account with thousands of refunds cannot turn into thousands of extra
  // Stripe calls — the rest simply keep a null customer, which costs one
  // dashboard column and nothing else.
  private async backfillCustomers(rows: MoneyOutRow[]): Promise<void> {
    const needing = rows.filter((r) => !r.customerId && r.chargeId);
    if (needing.length === 0) return;
    const chargeIds = [...new Set(needing.map((r) => r.chargeId!))].slice(0, MAX_CUSTOMER_LOOKUPS_PER_PAGE);
    for (const chargeId of chargeIds) {
      const customerId = await this.stripe.getChargeCustomerId(chargeId).catch(() => null);
      if (!customerId) continue;
      await this.store
        .setCustomerForCharge(chargeId, customerId)
        .catch(() => undefined);
    }
  }

  // ---- concession path (no balance transaction exists for these) ----

  async recordCreditNote(note: Stripe.CreditNote, source: MoneyOutSource): Promise<void> {
    // Only the non-refunded portion: a credit note in refund mode also produces
    // a real refund, which the ledger already books as CASH.
    await this.record(classifyCreditNote(note, source));
  }

  async recordWriteOff(invoice: Stripe.Invoice, source: MoneyOutSource): Promise<void> {
    await this.record(classifyWriteOff(invoice, source));
  }

  // What a discount is worth per billing cycle.
  //
  // This is the number that made concessions read as zero: classifyDiscount
  // refuses to book a percentage coupon it cannot price, and the only base we
  // used to try was an upcoming-invoice preview — which returns nothing for a
  // customer-level discount, or for any subscription without a next invoice.
  // Now the subscription's own line items answer it directly, with the preview
  // as the fallback rather than the only route.
  async priceDiscountBase(
    customerId: string | null,
    subscriptionId: string | null
  ): Promise<{ baseMinor: number; currency: string } | null> {
    if (subscriptionId) {
      const fromItems = await this.subscriptionRecurringTotal(subscriptionId);
      if (fromItems) return fromItems;
      if (customerId) {
        const preview = await this.stripe.previewUpcomingInvoice(customerId, subscriptionId).catch(() => null);
        // subtotal is pre-discount, which is exactly the base a percentage
        // applies to (total would already have the discount taken off).
        if (preview && preview.subtotal > 0) return { baseMinor: preview.subtotal, currency: preview.currency };
      }
      return null;
    }
    // Customer-level discount: it applies to whatever they are subscribed to,
    // so the base is the sum of their active subscriptions.
    if (!customerId) return null;
    const subs = await this.stripe.listSubscriptions(customerId).catch(() => []);
    let baseMinor = 0;
    let currency: string | null = null;
    for (const sub of subs) {
      if (sub.status !== "active" && sub.status !== "trialing") continue;
      const priced = await this.subscriptionRecurringTotal(sub);
      if (!priced) continue;
      baseMinor += priced.baseMinor;
      currency = currency ?? priced.currency;
    }
    return baseMinor > 0 && currency ? { baseMinor, currency } : null;
  }

  // Sum of a subscription's line items at list price: quantity × unit amount.
  // Deterministic and available even when there is no upcoming invoice.
  private async subscriptionRecurringTotal(
    subscriptionOrId: string | Stripe.Subscription
  ): Promise<{ baseMinor: number; currency: string } | null> {
    const sub =
      typeof subscriptionOrId === "string"
        ? await this.stripe.getSubscription(subscriptionOrId).catch(() => null)
        : subscriptionOrId;
    if (!sub) return null;
    let baseMinor = 0;
    let currency: string | null = null;
    for (const item of sub.items?.data ?? []) {
      const unit = item.price?.unit_amount;
      if (unit == null) continue; // tiered/metered price — not knowable up front
      baseMinor += unit * (item.quantity ?? 1);
      currency = currency ?? item.price.currency;
    }
    return baseMinor > 0 && currency ? { baseMinor, currency } : null;
  }

  async recordDiscount(input: {
    discountId: string;
    customerId: string | null;
    currency: string;
    baseMinor: number;
    percentOff?: number | null;
    amountOffMinor?: number | null;
    reason?: string | null;
    occurredAt?: Date;
    source: MoneyOutSource;
  }): Promise<void> {
    await this.record(classifyDiscount({ ...input, occurredAt: input.occurredAt ?? new Date() }));
  }

  async recordBalanceConcession(input: {
    id: string;
    category: Extract<MoneyOutCategory, "credit_grant" | "balance_credit">;
    customerId: string | null;
    currency: string;
    amountMinor: number;
    reason?: string | null;
    occurredAt?: Date;
    source: MoneyOutSource;
  }): Promise<void> {
    await this.record(classifyBalanceConcession({ ...input, occurredAt: input.occurredAt ?? new Date() }));
  }

  // Best-effort by construction: a metrics write must never fail the billing
  // action that produced it.
  private async record(row: MoneyOutRow | null): Promise<void> {
    if (!row) return;
    if (!this.settings.moneyOutEnabled()) return;
    try {
      const isNew = await this.store.upsert(row);
      if (!isNew) return;
      exportMoneyOut({
        bucket: row.bucket,
        category: row.category,
        currency: row.currency,
        source: row.source,
        amountMinor: row.amountMinor,
        feeMinor: row.feeMinor,
        netMinor: row.netMinor,
        ts: row.occurredAt,
      });
    } catch (error) {
      moneyLog.warn("money-out concession record failed", {
        "money_out.id": row.id,
        "money_out.category": row.category,
        "error.message": error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}
