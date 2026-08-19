import type Stripe from "stripe";
import { StripeClient } from "../../bot/StripeClient";
import { SessionStore } from "../../auth/SessionStore";
import { DisputeStore } from "../../bot/billing/DisputeStore";
import { BlockStore } from "../../bot/billing/BlockStore";
import { BillingQolStore } from "../../bot/billing/BillingQolStore";
import { ObjectRef } from "../renderer/contract";
import type { PostizIdentityService } from "../../postiz/PostizIdentityService";

// Global search behind the ⌘K palette. Pipeline: id fast-path (no network) →
// local DB hits (notes/bookmarks/blocklist/dispute mirror/Discord links) →
// Stripe fan-out (allSettled + per-call time-box + per-group truncation).
// Search API is eventually consistent (~1min) and rate-limited — the caller
// throttles per actor, the client debounces 400ms, and this module never
// exceeds 3 Stripe calls per query.

export interface SearchHit {
  title: string; // primary line (name / amount / summary)
  sub?: string; // secondary muted line (email / id / reason)
  ref: ObjectRef;
  id?: string; // mono id shown on the right
}

export interface SearchGroup {
  label: string;
  hits: SearchHit[];
}

export interface SearchResponse {
  groups: SearchGroup[];
  notice?: string;
}

const GROUP_LIMIT = 5;
const STRIPE_TIMEBOX_MS = 3000;

// Recognized ids jump straight to their page — zero network.
const ID_JUMPS: Array<{ re: RegExp; page: string; label: string }> = [
  { re: /^cus_[A-Za-z0-9]+$/, page: "customers.detail", label: "Customer" },
  { re: /^(ch|py)_[A-Za-z0-9]+$/, page: "payments.detail", label: "Payment" },
  { re: /^pi_[A-Za-z0-9]+$/, page: "payments.detail", label: "Payment intent" },
  { re: /^po_[A-Za-z0-9]+$/, page: "balances.detail", label: "Payout" },
  { re: /^sub_[A-Za-z0-9]+$/, page: "subscriptions.detail", label: "Subscription" },
  { re: /^in_[A-Za-z0-9]+$/, page: "invoices.detail", label: "Invoice" },
  { re: /^(dp|du)_[A-Za-z0-9]+$/, page: "disputes.detail", label: "Dispute" },
];

export class GlobalSearch {
  constructor(
    private stripe: StripeClient,
    private stores: {
      session: SessionStore;
      dispute: DisputeStore;
      block: BlockStore;
      qol: BillingQolStore;
    },
    // Optional: search works without it, just without the platform group.
    private postiz?: PostizIdentityService
  ) {}

  // Postiz accounts matching the term. The platform is the only place a name
  // or organization id resolves to a person, and its account email is what
  // finds the Stripe customer to open — the platform does not expose the
  // customer id itself, so a hit without a matching customer is shown as
  // context rather than as a dead link.
  private async postizGroup(term: string): Promise<SearchGroup | null> {
    if (!this.postiz) return null;
    let result;
    try {
      result = await this.postiz.search(term);
    } catch {
      // Too short or too broad for the platform's unindexed search. The rest
      // of the palette still answers.
      return null;
    }
    if (!result || result.accounts.length === 0) return null;

    const hits: SearchHit[] = [];
    for (const account of result.accounts.slice(0, GROUP_LIMIT)) {
      const customers = account.email ? await this.stripe.findCustomersByEmail(account.email).catch(() => []) : [];
      const sub = [account.orgName ?? account.orgId, account.tier ?? "no plan", account.role]
        .filter(Boolean)
        .join(" · ");
      hits.push({
        title: account.email ?? account.name ?? account.userId,
        sub,
        id: account.userId,
        ref: customers.length === 1
          ? { page: "customers.detail", params: { id: customers[0].id } }
          : { page: "customers", params: { q: account.email ?? "" } },
      });
    }
    return hits.length ? { label: "Postiz accounts", hits } : null;
  }

  async run(rawTerm: string): Promise<SearchResponse> {
    const term = rawTerm.trim().slice(0, 80);
    if (term.length < 2) return { groups: [] };

    // 1) id fast-path.
    const jump = ID_JUMPS.find((j) => j.re.test(term));
    if (jump) {
      return {
        groups: [
          { label: "Go to", hits: [{ title: `Open ${jump.label.toLowerCase()}`, id: term, ref: { page: jump.page, params: { id: term } } }] },
        ],
      };
    }

    // 2) local hits (cheap, always run) + 3) Stripe fan-out (classified) +
    //    4) the platform account lookup (its own failure never sinks the rest).
    const [local, stripeGroups, postizGroup] = await Promise.all([
      this.localHits(term),
      this.stripeFanOut(term),
      this.postizGroup(term).catch(() => null),
    ]);
    const groups = [...stripeGroups, ...(postizGroup ? [postizGroup] : []), ...local].filter((g) => g.hits.length > 0);
    return {
      groups,
      notice: "Stripe search can lag by ~1 minute. Showing the top matches per group.",
    };
  }

  // ---- local (DB only) ----

  private async localHits(term: string): Promise<SearchGroup[]> {
    const lower = term.toLowerCase();
    const [notes, bookmarks, blocks, discordCustomer] = await Promise.all([
      this.stores.qol.searchNotes(term, GROUP_LIMIT).catch(() => []),
      this.stores.qol.listBookmarks(0, 50).then((r) => r.rows).catch(() => []),
      this.stores.block.listPage(0, 100).then((r) => r.rows).catch(() => []),
      this.discordLink(term),
    ]);

    const noteHits = notes.flatMap((n): SearchHit[] => {
      const ref = objectRefFor(n.objectType, n.objectId);
      if (!ref) return [];
      return [
        {
          title: `Note by ${n.authorName}: ${n.text.slice(0, 60)}${n.text.length > 60 ? "…" : ""}`,
          sub: n.objectId,
          ref,
        },
      ];
    });

    const bookmarkHits = bookmarks
      .filter((b) => (b.label ?? "").toLowerCase().includes(lower) || b.objectId.toLowerCase().includes(lower))
      .slice(0, GROUP_LIMIT)
      .flatMap((b): SearchHit[] => {
        const ref = objectRefFor(b.objectType, b.objectId);
        if (!ref) return [];
        return [{ title: b.label || b.objectId, sub: `bookmark · ${b.objectType}`, id: b.objectId, ref }];
      });

    const blockHits = blocks
      .filter((b) => b.value.toLowerCase().includes(lower) || (b.customerId ?? "").toLowerCase().includes(lower))
      .slice(0, GROUP_LIMIT)
      .flatMap((b): SearchHit[] => {
        if (!b.customerId) return []; // navigable hits only — raw-value blocks have no customer detail to open
        return [
          {
            title: `Blocked ${b.kind}: ${b.value}`,
            sub: b.reason,
            id: b.customerId,
            ref: { page: "customers.detail", params: { id: b.customerId } },
          },
        ];
      });

    const groups: SearchGroup[] = [];
    if (discordCustomer) groups.push({ label: "Discord link", hits: [discordCustomer] });
    if (bookmarkHits.length) groups.push({ label: "Bookmarks", hits: bookmarkHits });
    if (noteHits.length) groups.push({ label: "Team notes", hits: noteHits });
    if (blockHits.length) groups.push({ label: "Blocklist", hits: blockHits });
    return groups;
  }

  // A 17–19 digit term is a Discord user id — resolve the linked customer.
  private async discordLink(term: string): Promise<SearchHit | null> {
    if (!/^\d{17,19}$/.test(term)) return null;
    const session = await this.stores.session.getSession(term).catch(() => null);
    if (!session?.stripeCustomerId) return null;
    return {
      title: `Discord ${term} → linked customer`,
      id: session.stripeCustomerId,
      ref: { page: "customers.detail", params: { id: session.stripeCustomerId } },
    };
  }

  // ---- Stripe fan-out (≤3 calls, classified by term shape) ----

  private async stripeFanOut(term: string): Promise<SearchGroup[]> {
    const tasks: Array<Promise<SearchGroup | null>> = [];

    if (/^\d{4}$/.test(term)) {
      // Four digits → card last4 hunt: one group for all attempts, one for
      // failed-only (declined attempts DO exist as failed charges — surfaced
      // separately with their PI + decline reason so card-testing pops out).
      tasks.push(
        this.timeboxed(async () => {
          const res = await this.stripe.searchChargesByCardLast4(term, undefined, GROUP_LIMIT);
          return { label: `Payments · card ····${term}`, hits: res.charges.map((c) => chargeHit(this.stripe, c)) };
        })
      );
      tasks.push(
        this.timeboxed(async () => {
          const res = await this.stripe.searchChargesByCardLast4(term, undefined, GROUP_LIMIT, undefined, "failed");
          return {
            label: `Failed payments · card ····${term}`,
            hits: res.charges.map((c) => {
              const piId = typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id;
              return {
                title: this.stripe.formatAmount(c.amount, c.currency),
                sub: c.outcome?.seller_message ?? c.failure_message ?? c.failure_code ?? "failed",
                id: piId ?? c.id,
                ref: { page: "payments.detail", params: { id: piId ?? c.id } },
              };
            }),
          };
        })
      );
    } else if (/^\d+([.,]\d{1,2})?$/.test(term)) {
      // Amount-like → PI hunt in minor units (non-zero-decimal assumption is
      // fine for a search heuristic).
      const minor = Math.round(Number(term.replace(",", ".")) * 100);
      tasks.push(
        this.timeboxed(async () => {
          const res = await this.stripe.searchPaymentIntentsByAmount(minor, undefined, GROUP_LIMIT);
          return {
            label: `Payments · amount ${term}`,
            hits: res.paymentIntents.map((pi) => ({
              title: this.stripe.formatAmount(pi.amount, pi.currency),
              sub: pi.status.replace(/_/g, " "),
              id: pi.id,
              ref: { page: "payments.detail", params: { id: pi.id } },
            })),
          };
        })
      );
    } else {
      // Free text → customers + charges (+ invoice numbers when it looks like one).
      tasks.push(
        this.timeboxed(async () => {
          const customers = await this.stripe.searchCustomersByTerm(term, GROUP_LIMIT);
          return {
            label: "Customers",
            hits: customers.map((c) => ({
              title: c.name || c.email || c.id,
              sub: c.name ? c.email ?? undefined : undefined,
              id: c.id,
              ref: { page: "customers.detail", params: { id: c.id } },
            })),
          };
        })
      );
      tasks.push(
        this.timeboxed(async () => {
          const charges = await this.stripe.searchChargesByTerm(term, GROUP_LIMIT);
          return { label: "Payments", hits: charges.map((c) => chargeHit(this.stripe, c)) };
        })
      );
      if (/^[A-Za-z0-9-]{3,}$/.test(term)) {
        tasks.push(
          this.timeboxed(async () => {
            const invoices = await this.stripe.searchInvoicesByNumber(term, GROUP_LIMIT);
            return {
              label: "Invoices",
              hits: invoices
                .filter((i): i is Stripe.Invoice & { id: string } => !!i.id)
                .map((i) => ({
                  title: `${i.number ?? i.id} · ${this.stripe.formatAmount(i.total, i.currency)}`,
                  sub: i.status ?? undefined,
                  id: i.id,
                  ref: { page: "invoices.detail", params: { id: i.id } },
                })),
            };
          })
        );
      }
    }

    const settled = await Promise.allSettled(tasks);
    return settled
      .filter((s): s is PromiseFulfilledResult<SearchGroup | null> => s.status === "fulfilled")
      .map((s) => s.value)
      .filter((g): g is SearchGroup => g !== null && g.hits.length > 0);
  }

  // One Stripe call, boxed to 3s — a slow search degrades to "no group", never
  // a hung palette.
  private async timeboxed(fn: () => Promise<SearchGroup>): Promise<SearchGroup | null> {
    return Promise.race([
      fn().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), STRIPE_TIMEBOX_MS).unref?.()),
    ]);
  }
}

function chargeHit(stripe: StripeClient, c: Stripe.Charge): SearchHit {
  return {
    title: stripe.formatAmount(c.amount, c.currency),
    sub: c.billing_details?.email ?? c.description ?? undefined,
    id: c.id,
    ref: { page: "payments.detail", params: { id: c.id } },
  };
}

function objectRefFor(objectType: string, objectId: string): ObjectRef | null {
  if (objectType === "customer") return { page: "customers.detail", params: { id: objectId } };
  if (objectType === "charge") return { page: "payments.detail", params: { id: objectId } };
  if (objectType === "dispute") return { page: "disputes.detail", params: { id: objectId } };
  return null;
}
