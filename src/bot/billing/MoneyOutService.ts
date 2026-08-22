import type Stripe from "stripe";
import { StripeClient } from "../StripeClient";
import { SettingsStore } from "../../config/SettingsStore";
import { MoneyOutStore } from "./MoneyOutStore";
import {
  classifyBalanceConcession,
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

export interface MoneyOutBackfillResult {
  scanned: number;
  created: number;
  points: number;
  truncated: boolean;
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

  // ---- ledger path ----

  // The looper tick: walk forward from the cursor, upsert what is new, advance.
  // onProgress is the Temporal heartbeat — a first sweep against a busy account
  // can page for minutes, which would otherwise trip the heartbeat timeout.
  async reconcile(onProgress?: () => void): Promise<MoneyOutTickResult> {
    const result: MoneyOutTickResult = { scanned: 0, created: 0, errors: 0, truncated: false, skipped: true };
    if (!this.settings.moneyOutEnabled()) return result;
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
    exportMoneyOutSweep({ scanned: result.scanned, created: result.created, errors: result.errors, lagSeconds });
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

  // All-time history import. Idempotent: the same primary keys upsert, and the
  // Influx re-emission uses each row's real occurredAt, so identical points
  // (same measurement + tags + timestamp) overwrite rather than double-count.
  async backfillHistory(onProgress?: () => void): Promise<MoneyOutBackfillResult> {
    const swept = await this.sweep({ maxPages: MAX_PAGES_BACKFILL, source: "backfill", emitPoints: false, onProgress });

    // Re-emit the WHOLE mirror at historical timestamps, not just what this
    // sweep created — a re-run after enabling Influx must be able to populate
    // the series from rows an earlier run already stored.
    let points = 0;
    if (influxActive()) {
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
        }
      }
      await flushInflux();
    }

    await this.settings.updateMoneyOut({ moneyOutBackfillDoneAt: new Date() }).catch(() => undefined);
    return { scanned: swept.scanned, created: swept.created, points, truncated: swept.truncated };
  }

  // The shared pager behind reconcile / syncForObject / backfillHistory.
  private async sweep(opts: {
    createdGte?: number;
    sourceId?: string;
    maxPages: number;
    source: MoneyOutSource;
    emitPoints?: boolean;
    onProgress?: () => void;
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
      for (const bt of page.transactions) {
        scanned++;
        const rows = classifyBalanceTransaction(bt, opts.source);
        if (rows.length === 0) continue;
        for (const row of await this.withCustomer(rows, bt)) {
          const isNew = await this.store.upsert(row);
          if (!isNew) continue;
          created++;
          if (emitPoints) {
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
        }
      }
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

  // Resolve the customer behind the rows once per transaction (not once per
  // row) and only when the expanded source didn't already carry it.
  private async withCustomer(rows: MoneyOutRow[], bt: Stripe.BalanceTransaction): Promise<MoneyOutRow[]> {
    if (rows.every((r) => r.customerId != null)) return rows;
    const customerId = await this.resolveCustomer(bt);
    if (!customerId) return rows;
    return rows.map((r) => ({ ...r, customerId: r.customerId ?? customerId }));
  }

  private async resolveCustomer(bt: Stripe.BalanceTransaction): Promise<string | null> {
    const src = bt.source;
    if (src && typeof src !== "string") {
      const withCustomer = src as { customer?: string | { id: string } | null; charge?: string | { id: string } | null };
      const direct = idOf(withCustomer.customer ?? null);
      if (direct) return direct;
      const chargeId = idOf(withCustomer.charge ?? null);
      if (chargeId) return this.stripe.getChargeCustomerId(chargeId).catch(() => null);
    }
    return null;
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
