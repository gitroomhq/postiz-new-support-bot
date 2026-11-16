import type Stripe from "stripe";
import type { StripeClient } from "../bot/StripeClient";
import type { PostizIdentityService, PostizOrgLookup } from "../postiz/PostizIdentityService";
import { derivePostizPlan, isGitroomSub, readPostizMeta } from "../bot/billing/postizPlan";
import { distanceFromBooking, parseBankReference, type BankReference } from "../bot/billing/bankReference";
import type { Badge } from "../dashboard/renderer/contract";
import { subStatusFlags } from "../dashboard/sections/cells";
import { log } from "../util/logger";

const dataLog = log.child("support:data");

// The Stripe and Postiz reads behind the support dashboard. A customer page
// is read once (customer, tax IDs, subscriptions, the latest 100 invoices and
// charges, the Postiz org) and kept for a minute, so switching tabs or paging
// costs nothing.

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
// Names, emails and plan lines of result and Recently opened rows.
const ROW_TTL_MS = 3 * 60_000;
const ROW_CACHE_MAX = 1000;
const LIST_LIMIT = 100;
const TIMEBOX_MS = 5_000;
const MAX_HITS = 50;
// Card and reference lookups read at most this many pages of charges on that
// last 4 (100 a page).
const CARD_SEARCH_PAGES = 3;

export interface CustomerSnapshot {
  customer: Stripe.Customer;
  taxIds: Stripe.TaxId[];
  subs: Stripe.Subscription[];
  invoices: Stripe.Invoice[];
  invoicesMore: boolean;
  charges: Stripe.Charge[];
  chargesMore: boolean;
  postiz: PostizOrgLookup;
}

export interface PlanSummary {
  subscriptionId: string;
  label: string; // "Pro, monthly"
  badge: Badge; // Active, Trialing, Canceled at period end, ...
  renews: number | null; // unix seconds of the current period end
  cancelsAt: number | null;
  ended: boolean;
}

export interface LookupHit {
  customerId: string;
  name: string | null;
  email: string | null;
  foundBy: string;
}

export type LookupOutcome = { ok: true; hits: LookupHit[] } | { ok: false; error: string };

// A card or reference lookup also returns the charge it matched per customer.
export type ChargeLookupOutcome = LookupOutcome & { charges?: Map<string, Stripe.Charge>; window?: BankReference };

export class SupportData {
  private cache = new Map<string, { at: number; snap: CustomerSnapshot }>();
  private inflight = new Map<string, Promise<CustomerSnapshot | null>>();
  private briefs = new Map<string, { at: number; name: string | null; email: string | null }>();
  private planRows = new Map<string, { at: number; plan: PlanSummary | null }>();

  constructor(
    private stripe: StripeClient,
    private postiz: PostizIdentityService | null,
    private now: () => number = Date.now
  ) {}

  // ---- the customer page ----

  async customer(customerId: string, opts: { fresh?: boolean } = {}): Promise<CustomerSnapshot | null> {
    const hit = this.cache.get(customerId);
    if (!opts.fresh && hit && this.now() - hit.at < CACHE_TTL_MS) return hit.snap;
    const running = this.inflight.get(customerId);
    if (running) return running;
    const load = this.load(customerId).finally(() => this.inflight.delete(customerId));
    this.inflight.set(customerId, load);
    return load;
  }

  invalidate(customerId: string): void {
    this.cache.delete(customerId);
    this.briefs.delete(customerId);
    this.planRows.delete(customerId);
  }

  // A charge as Stripe has it now (a refund re-checks it, never the cache).
  async charge(chargeId: string): Promise<Stripe.Charge | null> {
    return this.stripe.getCharge(chargeId).catch((e) => {
      if ((e as { code?: string })?.code === "resource_missing") return null;
      throw e;
    });
  }

  private async load(customerId: string): Promise<CustomerSnapshot | null> {
    const customer = await this.stripe.getCustomer(customerId).catch((e) => {
      if ((e as { code?: string })?.code === "resource_missing") return null;
      throw e;
    });
    if (!customer) {
      this.cache.delete(customerId);
      return null;
    }
    const [taxIds, subs, invoices, charges] = await Promise.all([
      this.stripe.listTaxIds(customerId),
      this.stripe.listAllSubscriptions({ customerId, status: "all", limit: LIST_LIMIT }),
      this.stripe.listInvoices(customerId, LIST_LIMIT),
      this.stripe.listCharges(customerId, LIST_LIMIT),
    ]);
    const uniqueIds = subs.subscriptions
      .filter((s) => isGitroomSub(s))
      .map((s) => readPostizMeta(s.metadata).uniqueId)
      .filter((u): u is string => !!u);
    const postiz: PostizOrgLookup = this.postiz
      ? await this.postiz.resolveOrgsForCustomer(customerId, [...new Set(uniqueIds)]).catch(() => ({ state: "error", orgs: [], via: null }) as PostizOrgLookup)
      : { state: "off", orgs: [], via: null };
    const snap: CustomerSnapshot = {
      customer,
      taxIds,
      subs: subs.subscriptions,
      // Drafts are not real to the customer yet; support never sees them.
      invoices: invoices.invoices.filter((i) => i.status !== "draft"),
      invoicesMore: invoices.hasMore,
      charges: charges.charges,
      chargesMore: charges.hasMore,
      postiz,
    };
    this.cache.set(customerId, { at: this.now(), snap });
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return snap;
  }

  // ---- lookups ----

  // Stripe customers with this email, plus the Stripe customer of every
  // Postiz organisation this address belongs to.
  async lookupEmail(email: string): Promise<LookupOutcome> {
    const term = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(term) || term.length > 254) return { ok: false, error: "Enter a full email address." };
    const hits = new HitList();
    const [stripeHits, postizHits] = await Promise.all([
      timebox(this.stripe.findCustomersByEmail(term), []),
      this.postizCustomers(term),
    ]);
    for (const c of stripeHits) hits.add(c, "Stripe email");
    for (const h of postizHits) hits.addId(h.customerId, h.foundBy);
    return { ok: true, hits: await this.fill(hits) };
  }

  async lookupCustomerId(id: string): Promise<LookupOutcome> {
    const term = id.trim();
    if (!/^cus_[A-Za-z0-9]{1,64}$/.test(term)) return { ok: false, error: "A customer ID starts with cus_." };
    const customer = await this.stripe.getCustomer(term).catch(() => null);
    const hits = new HitList();
    if (customer) hits.add(customer, "Customer ID");
    return { ok: true, hits: hits.list() };
  }

  // A Postiz org id, user id, uniqueId or account email: whatever the
  // platform search matches, resolved to each org's Stripe customer.
  async lookupPostiz(term: string): Promise<LookupOutcome> {
    const t = term.trim();
    if (!this.postiz) return { ok: false, error: "The Postiz lookup is not set up." };
    if (t.length < 3 || t.length > 200) return { ok: false, error: "Enter an org ID, user ID or email." };
    const hits = new HitList();
    for (const h of await this.postizCustomers(t)) hits.addId(h.customerId, h.foundBy);
    return { ok: true, hits: await this.fill(hits) };
  }

  // Customers charged on a card ending in these digits with this expiry.
  async lookupCard(last4: string, expiry: string): Promise<ChargeLookupOutcome> {
    const digits = last4.trim();
    const exp = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(expiry.trim());
    if (!/^\d{4}$/.test(digits) || !exp) return { ok: false, error: "Enter the last 4 digits and the expiry as MM/YY." };
    const month = Number(exp[1]);
    const year = exp[2].length === 2 ? 2000 + Number(exp[2]) : Number(exp[2]);
    if (month < 1 || month > 12) return { ok: false, error: "The expiry month is 01 to 12." };
    const charges = new Map<string, Stripe.Charge>();
    let page: string | undefined;
    for (let i = 0; i < CARD_SEARCH_PAGES; i++) {
      const res = await timebox(this.stripe.searchChargesByCardLast4(digits, undefined, 100, page), null);
      if (!res) break;
      for (const ch of res.charges) {
        const card = ch.payment_method_details?.card;
        const cus = typeof ch.customer === "string" ? ch.customer : ch.customer?.id ?? null;
        if (!card || !cus || card.exp_month !== month || card.exp_year !== year) continue;
        const prev = charges.get(cus);
        if (!prev || prev.created < ch.created) charges.set(cus, ch);
      }
      if (!res.nextPage || charges.size >= MAX_HITS) break;
      page = res.nextPage;
    }
    const hits = new HitList();
    const ordered = [...charges.entries()].sort((a, b) => b[1].created - a[1].created);
    for (const [cus] of ordered) hits.addId(cus, "Card");
    return { ok: true, hits: await this.fill(hits), charges };
  }

  // Customers charged on a card ending in these digits around the day a bank
  // reference carries (bankReference.ts), nearest charge first.
  async lookupReference(reference: string, last4: string): Promise<ChargeLookupOutcome> {
    const ref = parseBankReference(reference, this.now());
    const digits = last4.trim();
    if (!ref) return { ok: false, error: "Enter the reference as the bank shows it, like FT26307B8P5M." };
    if (!/^\d{4}$/.test(digits)) return { ok: false, error: "Enter the last 4 digits of the card." };
    const charges = new Map<string, Stripe.Charge>();
    let page: string | undefined;
    for (let i = 0; i < CARD_SEARCH_PAGES; i++) {
      const res = await timebox(this.stripe.searchCardChargesBetween(digits, ref.from, ref.to, 100, page), null);
      if (!res) break;
      for (const ch of res.charges) {
        const cus = typeof ch.customer === "string" ? ch.customer : ch.customer?.id ?? null;
        if (!cus) continue;
        const prev = charges.get(cus);
        if (!prev || distanceFromBooking(ref, ch.created) < distanceFromBooking(ref, prev.created)) charges.set(cus, ch);
      }
      if (!res.nextPage || charges.size >= MAX_HITS) break;
      page = res.nextPage;
    }
    const hits = new HitList();
    const ordered = [...charges.entries()].sort((a, b) => distanceFromBooking(ref, a[1].created) - distanceFromBooking(ref, b[1].created));
    for (const [cus] of ordered) hits.addId(cus, "Reference");
    return { ok: true, hits: await this.fill(hits), charges, window: ref };
  }

  // The plan line for a list of customers (result rows), read in parallel.
  async plans(customerIds: string[]): Promise<Map<string, PlanSummary | null>> {
    const out = new Map<string, PlanSummary | null>();
    await Promise.all(
      customerIds.map(async (id) => {
        const cached = this.cache.get(id);
        if (cached && this.now() - cached.at < CACHE_TTL_MS) {
          out.set(id, planOf(cached.snap.subs));
          return;
        }
        const row = this.planRows.get(id);
        if (row && this.now() - row.at < ROW_TTL_MS) {
          out.set(id, row.plan);
          return;
        }
        const res = await timebox(this.stripe.listAllSubscriptions({ customerId: id, status: "all", limit: 10 }), null);
        const plan = res ? planOf(res.subscriptions) : null;
        if (res) remember(this.planRows, id, { at: this.now(), plan });
        out.set(id, plan);
      })
    );
    return out;
  }

  private async postizCustomers(term: string): Promise<Array<{ customerId: string; foundBy: string }>> {
    if (!this.postiz) return [];
    try {
      const res = await timebox(this.postiz.search(term), null);
      const out: Array<{ customerId: string; foundBy: string }> = [];
      for (const a of res?.accounts ?? []) {
        if (!a.orgPaymentId || !/^cus_[A-Za-z0-9]{1,64}$/.test(a.orgPaymentId) || a.orgDeletedAt) continue;
        const owner = /^(SUPERADMIN|ADMIN)$/i.test(a.role ?? "");
        out.push({ customerId: a.orgPaymentId, foundBy: owner ? "Postiz org owner" : "Postiz org member" });
      }
      return out;
    } catch (e) {
      // A term the platform refuses (too short, too broad) just finds nothing.
      dataLog.info("postiz lookup refused", { "error.message": e instanceof Error ? e.message : String(e) });
      return [];
    }
  }

  // Name and email for customers known only by id (Recently opened); ids
  // Stripe no longer knows drop out.
  async brief(customerIds: string[]): Promise<LookupHit[]> {
    const now = this.now();
    const out: LookupHit[] = [];
    const missing = new HitList();
    for (const id of customerIds) {
      const snap = this.cache.get(id);
      const known = this.briefs.get(id);
      if (snap && now - snap.at < CACHE_TTL_MS) out.push({ customerId: id, name: snap.snap.customer.name ?? null, email: snap.snap.customer.email ?? null, foundBy: "" });
      else if (known && now - known.at < ROW_TTL_MS) out.push({ customerId: id, name: known.name, email: known.email, foundBy: "" });
      else missing.addId(id, "");
    }
    for (const h of await this.fill(missing)) {
      remember(this.briefs, h.customerId, { at: now, name: h.name, email: h.email });
      out.push(h);
    }
    return out;
  }

  // Ids found without a customer object (Postiz, card) get their name and
  // email; ids Stripe no longer knows drop out.
  private async fill(hits: HitList): Promise<LookupHit[]> {
    const list = hits.list().slice(0, MAX_HITS);
    await Promise.all(
      list.map(async (h) => {
        if (h.name != null || h.email != null) return;
        const c = await timebox(this.stripe.getCustomer(h.customerId).catch(() => null), null);
        if (!c) h.customerId = "";
        else {
          h.name = c.name ?? null;
          h.email = c.email ?? null;
        }
      })
    );
    return list.filter((h) => h.customerId);
  }
}

class HitList {
  private byId = new Map<string, LookupHit>();
  add(c: Stripe.Customer, foundBy: string): void {
    if (!this.byId.has(c.id)) this.byId.set(c.id, { customerId: c.id, name: c.name ?? null, email: c.email ?? null, foundBy });
  }
  addId(id: string, foundBy: string): void {
    if (!this.byId.has(id)) this.byId.set(id, { customerId: id, name: null, email: null, foundBy });
  }
  list(): LookupHit[] {
    return [...this.byId.values()];
  }
}

// The subscription that describes the customer today: a live one first, else
// the most recent.
const LIVE: Stripe.Subscription.Status[] = ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"];

export function liveSubs(subs: Stripe.Subscription[]): Stripe.Subscription[] {
  return subs.filter((s) => LIVE.includes(s.status));
}

export function planOf(subs: Stripe.Subscription[]): PlanSummary | null {
  if (!subs.length) return null;
  const sorted = [...subs].sort((a, b) => b.created - a.created);
  const sub = sorted.find((s) => LIVE.includes(s.status)) ?? sorted[0];
  const meta = readPostizMeta(sub.metadata);
  const item = sub.items?.data?.[0];
  let label = "Subscription";
  if (meta.billing && meta.period) {
    label = `${cap(meta.billing)}, ${meta.period.toUpperCase() === "YEARLY" ? "yearly" : "monthly"}`;
  } else if (item?.price) {
    const derived = derivePostizPlan(item.price);
    if (derived) label = `${cap(derived.tier)}, ${derived.period === "YEARLY" ? "yearly" : "monthly"}`;
    else if (item.price.nickname) label = item.price.nickname;
  }
  const ended = sub.status === "canceled" || sub.status === "incomplete_expired";
  return {
    subscriptionId: sub.id,
    label,
    badge: subStatusFlags(sub)[0],
    renews: !ended && !sub.cancel_at && !sub.cancel_at_period_end ? item?.current_period_end ?? null : null,
    cancelsAt: !ended ? (sub.cancel_at ?? (sub.cancel_at_period_end ? item?.current_period_end ?? null : null)) : null,
    ended,
  };
}

function cap(s: string): string {
  const v = s.toLowerCase();
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > ROW_CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function timebox<T, F>(p: Promise<T>, fallback: F): Promise<T | F> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<F>((resolve) => setTimeout(() => resolve(fallback), TIMEBOX_MS).unref?.()),
  ]);
}
