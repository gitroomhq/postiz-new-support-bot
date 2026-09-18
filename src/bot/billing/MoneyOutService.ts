import type Stripe from "stripe";
import { StripeClient } from "../StripeClient";
import { SettingsStore } from "../../config/SettingsStore";
import { MoneyOutStore } from "./MoneyOutStore";
import {
  classifyBalanceConcession,
  buildRefundFeeRow,
  classifyBalanceTransaction,
  classifyCreditNote,
  classifyInvoiceDiscount,
  classifyWriteOff,
  invoiceDiscountCount,
  type MoneyOutCategory,
  type MoneyOutRow,
  type MoneyOutSource,
} from "./moneyOutTaxonomy";
import { StripeSegmentResolver } from "./StripeSegmentResolver";
import { UNKNOWN, chargeAgeBucket, normalizeRefundReason, type MoneySegments } from "./segments";
import { emitMoneyOut, exportMoneyOutSweep } from "../../metrics/MetricsExporter";
import { flushInflux, influxActive } from "../../metrics/InfluxWriter";
import { log } from "../../util/logger";
import type { MoneyOutTickResult } from "../../temporal/types";

const moneyLog = log.child("money-out");

// The expanded source of a refund balance transaction IS the Refund object, and
// it carries the reason and the exact amount — neither of which survives into
// the balance transaction itself.
function refundFromSource(bt: Stripe.BalanceTransaction | undefined): Stripe.Refund | null {
  const src = bt?.source;
  if (!src || typeof src === "string") return null;
  return (src as { object?: string }).object === "refund" ? (src as Stripe.Refund) : null;
}

// The segment columns of a stored mirror row, back in the shape the exporter
// wants. Null columns stay null so they render as "unknown" rather than
// inventing a value the row never had.
function segmentsOf(row: {
  planTier: string | null;
  planPeriod: string | null;
  cardBrand: string | null;
  cardFunding: string | null;
  cardCountry: string | null;
  refundReason: string | null;
  refundKind: string | null;
  chargeAge: string | null;
  tenure: string | null;
  networkReason: string | null;
  surface: string | null;
}): MoneySegments {
  return {
    planTier: row.planTier,
    planPeriod: row.planPeriod,
    cardBrand: row.cardBrand,
    cardFunding: row.cardFunding,
    cardCountry: row.cardCountry,
    refundReason: row.refundReason,
    refundKind: row.refundKind,
    chargeAge: row.chargeAge,
    tenure: row.tenure,
    networkReason: row.networkReason,
    surface: row.surface,
  };
}

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
// Per page, how many Stripe reads the sweep will spend resolving descriptive
// segments (plan, card, region, tenure). Same shape as the customer-attribution
// cap above and for the same reason: a segment is a chart axis, never a total,
// so running out degrades one axis to "unknown" instead of stalling the sweep.
// The resolver's process-wide cache means a busy account spends far less than
// this in practice — the same few subscriptions repeat endlessly.
const MAX_SEGMENT_LOOKUPS_PER_PAGE = 30;

// The categories a descriptive segment can actually describe. Ordinary
// processing fees are excluded deliberately: they are the highest-volume rows
// on the account by an order of magnitude, they belong to no plan and no card,
// and enriching them would spend the whole budget on rows nobody slices.
const SEGMENTABLE_CATEGORIES = new Set<MoneyOutCategory>([
  "refund",
  "refund_failure",
  "refund_fee",
  "dispute",
  "dispute_reversal",
  "dispute_fee",
]);

// Which half of the history to import. "concessions" exists because coupons,
// credit notes and write-offs can be added to an account whose ledger is
// already imported, and re-walking every balance transaction to get them would
// be pure waste.
export type MoneyOutBackfillScope = "all" | "ledger" | "concessions" | "none";

export interface MoneyOutBackfillResult {
  scanned: number;
  created: number;
  points: number;
  truncated: boolean;
  // Rows repaired in place: ones that already existed and whose segments, fees
  // or USD columns an earlier, less-informed pass never filled in.
  repaired: number;
  // Concessions have no balance transaction, so they are swept from their own
  // endpoints rather than the ledger.
  creditNotes: number;
  writeOffs: number;
  // Discount ROWS booked, one per discount per paid invoice — real money not
  // collected, not the one-per-coupon estimate this used to report.
  discounts: number;
  invoicesScanned: number;
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
  private segments: StripeSegmentResolver;

  constructor(
    private settings: SettingsStore,
    private stripe: StripeClient,
    private store: MoneyOutStore,
    segments?: StripeSegmentResolver
  ) {
    // Injectable so the webhook handler and this service share one cache — the
    // same charge is touched by both within seconds of each other.
    this.segments = segments ?? new StripeSegmentResolver(stripe);
  }

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
    opts: {
      scope?: MoneyOutBackfillScope;
      reemitAll?: boolean;
      onProgress?: () => void;
      // Correct rows that already exist instead of skipping them, and buy
      // segments for the whole history. Both are off for the ordinary backfill
      // button and on for the analytics rebuild, which exists to fix exactly
      // what those defaults leave undone.
      repairExisting?: boolean;
      // Stripe reads the WHOLE run may spend on descriptive segments. One
      // budget for the run, not one per page: the old per-page allowance meant
      // the cap never capped — thirty lookups times two thousand pages is sixty
      // thousand reads with no ceiling at all.
      segmentBudget?: number;
      // Suppress inline point emission. The rebuild repairs with Influx closed
      // and re-emits afterwards in its own phase.
      emitPoints?: boolean;
    } = {}
  ): Promise<MoneyOutBackfillResult> {
    const scope = opts.scope ?? "all";
    const onProgress = opts.onProgress;
    const enrich = opts.segmentBudget != null && opts.segmentBudget > 0;
    // One budget for the entire run; see segmentBudget above.
    if (enrich) this.segments.startBatch(opts.segmentBudget!);
    // No per-charge customer lookups: an all-time sweep would otherwise spend
    // thousands of Stripe reads on a display column. Points ARE emitted inline
    // (each row carries its real timestamp), so there is no second full-table
    // walk in the normal case.
    const swept =
      scope === "concessions" || scope === "none"
        ? { scanned: 0, created: 0, repaired: 0, truncated: false }
        : await this.sweep({
            maxPages: MAX_PAGES_BACKFILL,
            source: "backfill",
            resolveCustomers: false,
            // Segments cost up to three Stripe reads per row. Over all-time
            // history that is thousands of calls, so the plain backfill leaves
            // them as "unknown" by design and the forward sweep enriches from
            // there on. The analytics rebuild passes a budget and pays for them.
            enrichSegments: enrich,
            // null = this call owns the budget opened above, so enrichSegments
            // must not reopen a fresh one per page.
            runBudget: enrich,
            repairExisting: opts.repairExisting,
            emitPoints: opts.emitPoints,
            onProgress,
          });

    // Concessions come from their own endpoints — the ledger sweep above has
    // no trail for them at all.
    const concessions =
      scope === "ledger" || scope === "none"
        ? { creditNotes: 0, writeOffs: 0, discounts: 0, invoicesScanned: 0, truncated: false }
        : await this.backfillConcessions(onProgress);

    // Opt-in only: re-emit the WHOLE mirror at historical timestamps. Needed
    // exactly once, when Influx is enabled AFTER rows were already imported —
    // every other run emits its new rows inline as it writes them.
    let points = 0;
    if (opts.reemitAll && influxActive() && opts.emitPoints !== false) {
      let sinceFlush = 0;
      for await (const batch of this.store.iterateAll()) {
        onProgress?.();
        for (const row of batch) {
          // Straight from the mirror row, which is the point of keeping the
          // segments in Postgres: a wiped Influx bucket can be rebuilt with its
          // axes intact without re-reading anything from Stripe.
          //
          // This used to hardcode source:"backfill" while the live paths
          // emitted the row's real source. `source` was a TAG, so every
          // re-emitted row landed as a SECOND point beside the original rather
          // than overwriting it, and every money panel doubled. It is a field
          // now, and both paths run through the same function.
          emitMoneyOut(row);
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
      repaired: swept.repaired,
      points,
      truncated: swept.truncated || concessions.truncated,
      creditNotes: concessions.creditNotes,
      writeOffs: concessions.writeOffs,
      discounts: concessions.discounts,
      invoicesScanned: concessions.invoicesScanned,
    };
  }

  // Concessions leave NO balance transaction, so the ledger sweep above cannot
  // see a single one of them — which is why the concession bucket reads zero
  // until this runs. Each source is swept from its own endpoint instead.
  private async backfillConcessions(onProgress?: () => void): Promise<{
    creditNotes: number;
    writeOffs: number;
    discounts: number;
    invoicesScanned: number;
    truncated: boolean;
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

    // ---- discounts, from the invoices that actually granted them ----
    //
    // This used to walk active subscriptions for attached coupons and book ONE
    // row per coupon, valued at a single billing cycle and stamped at the date
    // the coupon was attached. Every part of that was wrong: a 50%-off coupon
    // running for three years was recorded as one month of value, three years
    // ago, and coupons that had already ended were invisible because Stripe has
    // no endpoint that lists them.
    //
    // An invoice states how much was actually discounted and when. It recurs
    // the way the discount really recurred, and it reaches back as far as the
    // account does. The estimate rows those old sweeps wrote are retired by the
    // analytics rebuild so the two can never be counted together.
    const discountResult = await this.backfillInvoiceDiscounts(onProgress);
    discounts += discountResult.rows;

    return {
      creditNotes,
      writeOffs,
      discounts,
      invoicesScanned: discountResult.invoicesScanned,
      truncated: discountResult.truncated,
    };
  }

  // Walk every PAID invoice and book one row per discount on it.
  //
  // Paid only. A discount on an open invoice has not been given away yet, and a
  // void or uncollectible invoice is already booked as a write-off — counting
  // its discount here as well would double the concession bucket.
  private async backfillInvoiceDiscounts(
    onProgress?: () => void
  ): Promise<{ rows: number; invoicesScanned: number; truncated: boolean }> {
    let rows = 0;
    let invoicesScanned = 0;
    let startingAfter: string | undefined;

    for (let page = 0; page < MAX_PAGES_BACKFILL; page++) {
      onProgress?.();
      let res;
      try {
        res = await this.stripe.listInvoicesByStatus(null, "paid", 100, startingAfter);
      } catch (error) {
        moneyLog.warn("money-out invoice discount sweep failed", { "error.message": String(error) });
        return { rows, invoicesScanned, truncated: true };
      }
      for (const invoice of res.data) {
        invoicesScanned++;
        rows += await this.recordInvoiceDiscounts(invoice, "backfill");
      }
      if (!res.has_more || res.data.length === 0) {
        return { rows, invoicesScanned, truncated: false };
      }
      startingAfter = res.data[res.data.length - 1].id;
    }
    return { rows, invoicesScanned, truncated: true };
  }

  // Book every discount on one invoice. Also the live path: the invoice.paid
  // webhook calls this, so a discount reaches the ledger within seconds of the
  // invoice that granted it rather than at the next full sweep.
  //
  // Idempotent by key: the row id is the invoice plus the discount, so a
  // webhook, a sweep and a backfill all write the same primary key.
  async recordInvoiceDiscounts(invoice: Stripe.Invoice, source: MoneyOutSource): Promise<number> {
    if (!this.settings.moneyOutEnabled()) return 0;
    let booked = 0;
    for (let i = 0; i < invoiceDiscountCount(invoice); i++) {
      const row = classifyInvoiceDiscount(invoice, i, source);
      if (!row) continue;
      await this.record(row);
      booked++;
    }
    return booked;
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
    enrichSegments?: boolean;
    // Correct rows that already exist rather than skipping them. Off for the
    // ordinary tick, where a known balance transaction genuinely has nothing
    // new to say; on for the analytics rebuild, which is here precisely to fix
    // what earlier passes got wrong or never looked up.
    repairExisting?: boolean;
    // The CALLER opened one segment budget for the whole run, so enrichSegments
    // must not open a fresh one per page. Without this the cap never caps.
    runBudget?: boolean;
  }): Promise<{ scanned: number; created: number; repaired: number; truncated: boolean }> {
    const emitPoints = opts.emitPoints !== false;
    let startingAfter: string | undefined;
    let scanned = 0;
    let created = 0;
    let repaired = 0;
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
      // Which balance transaction produced each row. The expanded source on it
      // carries facts the row itself cannot hold — a refund's reason, its
      // amount against the original charge — and the enrichment pass below
      // needs them without paying for a second read.
      const btByRowId = new Map<string, Stripe.BalanceTransaction>();
      for (const bt of page.transactions) {
        scanned++;
        const rows = classifyBalanceTransaction(bt, opts.source);
        if (rows.length === 0) continue;
        const attached = this.attachCustomerFromSource(rows, bt);
        for (const r of attached) btByRowId.set(r.id, bt);
        pageRows.push(...attached);
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
          if (feeRow) {
            const bt = btByRowId.get(movement.id);
            if (bt) btByRowId.set(feeRow.id, bt);
            pageRows.push(feeRow);
          }
        }
      }

      // Descriptive segments, before the write so the mirror and the Influx
      // points carry the same axes. Never fatal: see enrichSegments.
      if (opts.enrichSegments !== false) await this.enrichSegments(pageRows, btByRowId, opts.runBudget);

      const fresh = await this.store.insertNew(pageRows);
      created += fresh.length;

      // Correct what was already on disk. Without this a row written by an
      // earlier, less-informed pass keeps its nulls forever, because insertNew
      // skips every id it has seen — which is precisely why all historical
      // money charted as "unknown" on every segment axis.
      if (opts.repairExisting) {
        const freshIds = new Set(fresh.map((r) => r.id));
        repaired += await this.store.repair(pageRows.filter((r) => !freshIds.has(r.id)));
      }

      if (emitPoints) {
        // From the PERSISTED rows. Emitting from the in-memory candidates is
        // what let the live and rebuild paths disagree by a tag and double the
        // totals; see the header of moneyPoints.ts.
        for (const row of fresh) emitMoneyOut(row);
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
        return { scanned, created, repaired, truncated: false };
      }
      if (pages >= opts.maxPages) {
        moneyLog.warn("money-out sweep hit the page cap", { "money_out.pages": pages, "money_out.scanned": scanned });
        return { scanned, created, repaired, truncated: true };
      }
      startingAfter = page.transactions[page.transactions.length - 1].id;
    }
  }

  // Descriptive segments for the rows that can carry one.
  //
  // Best-effort by construction, three times over: it is skipped entirely when
  // /config turns enrichment off, it stops when the page's lookup budget runs
  // out, and every individual resolution catches its own failure. A row that
  // comes back without segments is written with nulls and charts as "unknown",
  // which is the honest answer to "which plan was this" when nobody looked.
  //
  // It runs BEFORE the write so the Postgres mirror and the Influx point carry
  // identical axes — a mirror that disagreed with the chart would be worse than
  // no mirror at all.
  private async enrichSegments(
    rows: MoneyOutRow[],
    btByRowId: Map<string, Stripe.BalanceTransaction>,
    runBudget?: boolean
  ): Promise<void> {
    if (!this.settings.moneyOutEnrichEnabled()) return;
    const targets = rows.filter((r) => SEGMENTABLE_CATEGORIES.has(r.category));
    if (targets.length === 0) return;

    // Per-page allowance for the ordinary tick, which reads one or two pages.
    // Skipped when the caller opened a budget for the whole run: reopening it
    // here would hand every page a fresh allowance, so a two-thousand-page
    // backfill would spend sixty thousand Stripe reads under a cap of thirty.
    if (!runBudget) this.segments.startBatch(MAX_SEGMENT_LOOKUPS_PER_PAGE);
    for (const row of targets) {
      try {
        row.segments = await this.segmentsForRow(row, btByRowId.get(row.id));
      } catch (error) {
        // A chart axis is never worth failing a money movement over.
        moneyLog.debug("segment enrichment failed", {
          "money_out.row_id": row.id,
          "error.message": String(error),
        });
      }
    }
  }

  private async segmentsForRow(
    row: MoneyOutRow,
    bt: Stripe.BalanceTransaction | undefined
  ): Promise<MoneySegments> {
    const facts = await this.segments.factsForCharge(row.chargeId);
    const base: MoneySegments = {
      planTier: facts.planTier,
      planPeriod: facts.planPeriod,
      cardBrand: facts.cardBrand,
      cardFunding: facts.cardFunding,
      cardCountry: facts.cardCountry,
      tenure: await this.segments.tenureFor(facts.customerId, row.occurredAt),
    };

    const isRefund = row.category === "refund" || row.category === "refund_failure" || row.category === "refund_fee";
    if (!isRefund) return base;

    const refund = refundFromSource(bt);
    // The charge is already in the fee cache from the refund-fee pass above, so
    // reading the original amount here is a map lookup, not a Stripe call. When
    // it is absent (resolveRefundFees off) full-vs-partial stays unknown rather
    // than spending a read on it.
    const charge = row.chargeId ? this.chargeFeeCache.get(row.chargeId) : null;
    const refundedMinor = refund?.amount ?? Math.abs(row.amountMinor);
    return {
      ...base,
      refundReason: normalizeRefundReason(refund?.reason ?? null),
      refundKind: charge ? (refundedMinor < charge.amount ? "partial" : "full") : UNKNOWN,
      chargeAge: chargeAgeBucket(facts.chargeCreatedAt, row.occurredAt),
    };
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
  private async backfillCustomers(rows: Array<Pick<MoneyOutRow, "customerId" | "chargeId">>): Promise<void> {
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
      const { created, row: saved } = await this.store.upsert(row);
      if (!created) return;
      // From the SAVED row. This used to emit from the in-memory candidate and
      // pass no segments at all, so every concession point carried eleven
      // "unknown" tags while the rebuild emitted the mirror's real ones — two
      // different series for one movement.
      emitMoneyOut(saved);
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
