import type Stripe from "stripe";
import { StripeClient } from "../StripeClient";
import type { SessionStore } from "../../auth/SessionStore";
import { FINGERPRINT_RE } from "./types";

// Account-wide fraud hunts, extracted from CardsHub so the Discord hub and the
// web dashboard's #/fraud page share one implementation of the aggregation
// logic. Pure data in/out — rendering stays with the callers. All three hunts
// ride the Stripe Search API: eventually consistent (~1 min lag), which the
// callers surface as a notice; inputs are validated HERE because they are
// interpolated into search query strings.

export interface FingerprintHuntRow {
  customerId: string; // "(no customer)" for guest charges
  email: string | null;
  count: number;
  discordIds: string[];
}

export interface Last4Group {
  brand: string;
  last4: string;
  exp: string;
  fingerprint: string | null;
  count: number;
  failed: number; // status:"failed" charges inside count — the card-testing signal
  lastFailure: { chargeId: string; piId: string | null; reason: string | null; created: number } | null;
  customers: Array<{ id: string; email: string | null }>;
}

export type ChargeHuntStatus = "succeeded" | "pending" | "failed";

export interface AmountHuntRow {
  id: string; // pi_…
  amount: number;
  currency: string;
  status: string;
  created: number; // unix seconds
  customerId: string | null;
  email: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  failureReason: string | null;
}

export type HuntResult<T> = { ok: true; rows: T[]; scanned: number; hasMore: boolean } | { ok: false; error: string };

const LAST4_RE = /^\d{4}$/;
const BRAND_RE = /^[a-z_]+$/;
const STATUS_VALUES: ReadonlySet<string> = new Set(["succeeded", "pending", "failed"]);
const CURRENCY_RE = /^[a-z]{3}$/;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export class FraudHuntService {
  constructor(
    private stripe: StripeClient,
    private sessionStore: SessionStore
  ) {}

  // Every account that charged a card with this exact fingerprint — the
  // multi-account fraud picture one card can't hide from.
  async usersByFingerprint(fingerprint: string): Promise<HuntResult<FingerprintHuntRow>> {
    if (!FINGERPRINT_RE.test(fingerprint)) {
      return { ok: false, error: "That doesn't look like a card fingerprint (8-64 letters/digits)." };
    }
    const { charges, nextPage } = await this.stripe.searchChargesByCardFingerprint(fingerprint, 100);
    const byCustomer = new Map<string, { email: string | null; count: number }>();
    for (const charge of charges) {
      const cusId = typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? "(no customer)");
      const entry = byCustomer.get(cusId) ?? { email: null, count: 0 };
      entry.count++;
      entry.email = entry.email ?? charge.billing_details?.email ?? charge.receipt_email ?? null;
      byCustomer.set(cusId, entry);
    }
    const rows: FingerprintHuntRow[] = [];
    for (const [customerId, info] of byCustomer) {
      const discordIds = customerId.startsWith("cus_")
        ? await this.sessionStore.findDiscordIdsByStripeId(customerId).catch(() => [])
        : [];
      rows.push({ customerId, email: info.email, count: info.count, discordIds });
    }
    rows.sort((a, b) => b.count - a.count);
    return { ok: true, rows, scanned: charges.length, hasMore: nextPage != null };
  }

  // last4 is far from unique — group matches by fingerprint, which IS the
  // exact-match id the fingerprint hunt takes. status:"failed" narrows to
  // declined/blocked attempts (each carries its PaymentIntent); the per-group
  // failed count is tracked either way as a card-testing signal.
  async cardsByLast4(last4: string, brand?: string, status?: string): Promise<HuntResult<Last4Group>> {
    if (!LAST4_RE.test(last4)) return { ok: false, error: "Enter exactly the 4 digits." };
    const cleanBrand = (brand ?? "").trim().toLowerCase();
    if (cleanBrand && !BRAND_RE.test(cleanBrand)) {
      return { ok: false, error: "Brand must be letters only (visa, mastercard, amex, …)." };
    }
    const cleanStatus = (status ?? "").trim().toLowerCase();
    if (cleanStatus && !STATUS_VALUES.has(cleanStatus)) {
      return { ok: false, error: "Status must be failed, succeeded or pending (blank = all)." };
    }
    const { charges, nextPage } = await this.stripe.searchChargesByCardLast4(
      last4,
      cleanBrand || undefined,
      100,
      undefined,
      cleanStatus ? (cleanStatus as ChargeHuntStatus) : undefined
    );
    const groups = new Map<string, Last4Group & { customerMap: Map<string, string | null> }>();
    for (const charge of charges) {
      const card = charge.payment_method_details?.card;
      if (!card) continue;
      const key = card.fingerprint ?? `${card.brand}-${card.last4}-nofp`;
      const group =
        groups.get(key) ??
        ({
          brand: card.brand ?? "card",
          last4: card.last4 ?? last4,
          exp: `${card.exp_month ?? "?"}/${card.exp_year ?? "?"}`,
          fingerprint: card.fingerprint ?? null,
          count: 0,
          failed: 0,
          lastFailure: null,
          customers: [],
          customerMap: new Map<string, string | null>(),
        } as Last4Group & { customerMap: Map<string, string | null> });
      group.count++;
      if (charge.status === "failed") {
        group.failed++;
        if (!group.lastFailure || charge.created > group.lastFailure.created) {
          group.lastFailure = {
            chargeId: charge.id,
            piId: typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null),
            reason: charge.outcome?.seller_message ?? charge.failure_message ?? charge.failure_code ?? null,
            created: charge.created,
          };
        }
      }
      const cusId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
      if (cusId && !group.customerMap.has(cusId)) {
        group.customerMap.set(cusId, charge.billing_details?.email ?? charge.receipt_email ?? null);
      }
      groups.set(key, group);
    }
    const rows = [...groups.values()].map(({ customerMap, ...group }) => ({
      ...group,
      customers: [...customerMap.entries()].map(([id, email]) => ({ id, email })),
    }));
    rows.sort((a, b) => b.count - a.count);
    return { ok: true, rows, scanned: charges.length, hasMore: nextPage != null };
  }

  // Amount search hits PaymentIntents, so it surfaces attempts that never
  // produced ANY charge (abandoned checkout, unfinished 3DS) — the slice the
  // last4/charge searches cannot see. (Ordinary issuer declines DO become
  // failed charges and are reachable via cardsByLast4 with status "failed".)
  // amountMajor is parsed here so both surfaces share the zero-decimal handling.
  async paymentsByAmount(amountMajorRaw: string, currencyRaw?: string): Promise<HuntResult<AmountHuntRow>> {
    const amountStr = amountMajorRaw.trim();
    const currency = (currencyRaw ?? "").trim().toLowerCase();
    if (!AMOUNT_RE.test(amountStr)) return { ok: false, error: "Enter an amount like 25.39." };
    if (currency && !CURRENCY_RE.test(currency)) {
      return { ok: false, error: "Currency must be a 3-letter code (eur, usd, …) or left blank." };
    }
    const zeroDecimal = currency ? StripeClient.isZeroDecimal(currency) : false;
    const amountMinor = zeroDecimal ? Math.round(Number(amountStr)) : Math.round(Number(amountStr) * 100);
    const { paymentIntents, nextPage } = await this.stripe.searchPaymentIntentsByAmount(
      amountMinor,
      currency || undefined,
      50
    );
    const rows = paymentIntents.map((pi): AmountHuntRow => {
      const charge = pi.latest_charge && typeof pi.latest_charge !== "string" ? (pi.latest_charge as Stripe.Charge) : null;
      const card = charge?.payment_method_details?.card;
      return {
        id: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        status: pi.status,
        created: pi.created,
        customerId: typeof pi.customer === "string" ? pi.customer : (pi.customer?.id ?? null),
        email: charge?.billing_details?.email ?? charge?.receipt_email ?? pi.receipt_email ?? null,
        cardBrand: card?.brand ?? null,
        cardLast4: card?.last4 ?? null,
        failureReason: pi.last_payment_error?.message ?? charge?.outcome?.seller_message ?? charge?.failure_message ?? null,
      };
    });
    return { ok: true, rows, scanned: paymentIntents.length, hasMore: nextPage != null };
  }
}
