import type Stripe from "stripe";
import { derivePostizPlan, postizSyncStatus, readPostizMeta } from "../bot/billing/postizPlan";
import { log } from "../util/logger";
import type { PostizIdentityService } from "./PostizIdentityService";
import type { PostizOrgLinkStore } from "./PostizOrgLinkStore";

const driftLog = log.child("postiz:drift");

export type DriftVerdict =
  // The platform agrees with what the subscription charges.
  | "in_sync"
  // Stripe and the platform disagree about the tier. This is the case
  // subscription.repair_sync cannot see, because from Stripe's side alone the
  // metadata looks correct.
  | "drifted"
  // The Stripe side is itself wrong (no gitroom metadata, or metadata that
  // contradicts the price). Already handled by subscription.repair_sync.
  | "stripe_unsynced"
  // Not answerable: lookup off, account unknown, or nothing to compare.
  | "unknown";

export interface DriftReport {
  verdict: DriftVerdict;
  // Tier the subscription's PRICE actually charges for.
  stripeTier: string | null;
  // Tier the platform currently has the organization on.
  platformTier: string | null;
  orgId: string | null;
  detail: string;
}

// Compares the plan a customer PAYS for against the plan the platform actually
// put their organization on.
//
// Until the platform exposed its own tier, only the Stripe half was observable:
// postizSyncStatus can tell that a subscription's metadata contradicts its
// price, but not that correct-looking metadata never took effect. A dropped
// webhook, a failed sync or a manual edit on either side leaves a customer
// paying for one tier and using another, and nothing surfaced it.
export class PostizDriftService {
  constructor(
    private identity: PostizIdentityService,
    private orgLinks: PostizOrgLinkStore
  ) {}

  // Resolution order matters: the harvested organization link is an exact id,
  // whereas the customer's email is a fuzzy match that can land on the wrong
  // account when several people share an address.
  private async accountFor(customer: Pick<Stripe.Customer, "id" | "email">) {
    const link = await this.orgLinks.orgsForCustomer(customer.id).catch(() => []);
    for (const { orgId } of link) {
      const byOrg = await this.identity.resolve(orgId);
      if (byOrg) return byOrg;
    }
    if (customer.email && customer.email.includes("@")) {
      return this.identity.resolve(customer.email);
    }
    return null;
  }

  async check(
    subscription: Pick<Stripe.Subscription, "metadata" | "items" | "status">,
    customer: Pick<Stripe.Customer, "id" | "email">
  ): Promise<DriftReport> {
    const none = (verdict: DriftVerdict, detail: string, extra: Partial<DriftReport> = {}): DriftReport => ({
      verdict,
      stripeTier: null,
      platformTier: null,
      orgId: null,
      detail,
      ...extra,
    });

    // A canceled subscription has no tier to be wrong about.
    if (subscription.status === "canceled") return none("unknown", "Subscription is canceled.");

    const stripeStatus = postizSyncStatus(subscription);
    const price = subscription.items.data[0]?.price;
    const derived = price ? derivePostizPlan(price) : null;
    if (stripeStatus !== "synced") {
      return none(
        "stripe_unsynced",
        stripeStatus === "missing"
          ? "Subscription carries no gitroom metadata, so the platform drops all of its events. Repair the Stripe sync first."
          : "Subscription metadata contradicts the price it charges. Repair the Stripe sync first.",
        { stripeTier: derived?.tier ?? null }
      );
    }
    if (!derived) return none("unknown", "Price is not a canonical Postiz price, so no tier can be derived.");

    let account;
    try {
      account = await this.accountFor(customer);
    } catch (e) {
      driftLog.warn("postiz.drift.lookup_failed", {
        "stripe.customer_id": customer.id,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return none("unknown", "Platform lookup failed.", { stripeTier: derived.tier });
    }
    if (!account) {
      return none("unknown", "No Postiz account resolved for this customer.", { stripeTier: derived.tier });
    }

    const platformTier = account.tier;
    const base = { stripeTier: derived.tier, platformTier, orgId: account.orgId };
    if (platformTier == null) {
      // The organization has no subscription row at all while Stripe is
      // charging: the paid plan never landed. That IS drift, and the most
      // consequential kind.
      return {
        ...base,
        verdict: "drifted",
        detail: `Stripe charges ${derived.tier} but the organization has no plan on the platform.`,
      };
    }
    if (platformTier.toUpperCase() !== derived.tier.toUpperCase()) {
      return {
        ...base,
        verdict: "drifted",
        detail: `Stripe charges ${derived.tier} but the platform has the organization on ${platformTier}.`,
      };
    }
    // readPostizMeta is re-read here so the message names the value the
    // platform actually keyed off, not the derived one.
    const meta = readPostizMeta(subscription.metadata);
    return {
      ...base,
      verdict: "in_sync",
      detail: `Platform and Stripe agree on ${meta.billing ?? derived.tier}.`,
    };
  }
}
