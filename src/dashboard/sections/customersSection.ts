import type Stripe from "stripe";
import { exportBillingEvent } from "../../metrics/MetricsExporter";
import { StripeClient } from "../../bot/StripeClient";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, Badge, Block, Cell, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";
import { countryName, countryOptions, isCountryCode } from "./countries";
import { bookmarkButton, isBookmarkedSafe, toggleBookmarkAction } from "./bookmarks";
import { isGitroomSub, readPostizMeta } from "../../bot/billing/postizPlan";
import type { PostizIdentityService, PostizOrgLookup, PostizOrgSummary } from "../../postiz/PostizIdentityService";
import {
  describeSuppression,
  distinctEmails,
  type DeliveryStatus,
  type EmailDeliverabilityService,
} from "../../resend/EmailDeliverabilityService";
import { PROBLEM_EVENTS, categoryLabel, eventLabel } from "../../resend/DeliveryLogStore";
import { SHARE_TTL_LABEL, type DeliveryLogService } from "../../resend/DeliveryLogService";
import {
  amount,
  avatarCell,
  badgeCell,
  chargeBadge,
  dateCell,
  DATE_RANGE_OPTIONS,
  estimateMrr,
  fmtAddress,
  formatPerCurrency,
  idCell,
  invoiceBadge,
  isoDateCell,
  money,
  parseDateFilter,
  paymentMethodCell,
  sentence,
  strong,
  subStatusFlags,
  text,
} from "./cells";

// Customers: account-wide browse/search, the Customer 360 and the edit
// surface: create, edit details/tax/locale/metadata, Discord↔Stripe
// link/unlink (T1) and DELETE (typed CONFIRM + Discord reverse code, then
// unlinkStripeCustomerEverywhere exactly like CustomersHub). Layout follows
// the Stripe DETAIL archetype: flat tables in the main column,
// Insights/Details/Linked accounts stacked label-over-value in the right rail.

const PAGE_SIZE = 25;

// Curated tax-ID types: the Stripe union is 100+ entries; support
// workflows need these. Server-side membership check beats trusting the select.
const TAX_ID_TYPES = [
  { value: "eu_vat", label: "EU VAT" },
  { value: "gb_vat", label: "GB VAT" },
  { value: "us_ein", label: "US EIN" },
  { value: "ch_vat", label: "CH VAT" },
  { value: "no_vat", label: "NO VAT" },
  { value: "au_abn", label: "AU ABN" },
  { value: "ca_bn", label: "CA BN" },
  { value: "ca_gst_hst", label: "CA GST/HST" },
  { value: "in_gst", label: "IN GST" },
  { value: "jp_cn", label: "JP CN" },
  { value: "nz_gst", label: "NZ GST" },
  { value: "sg_gst", label: "SG GST" },
  { value: "br_cnpj", label: "BR CNPJ" },
  { value: "mx_rfc", label: "MX RFC" },
  { value: "tr_tin", label: "TR TIN" },
];

export function taxTypeLabel(type: string): string {
  return TAX_ID_TYPES.find((t) => t.value === type)?.label ?? type.replace(/_/g, " ").toUpperCase();
}

// The select value that asks the server to work the type out from the number.
export const TAX_TYPE_DETECT = "detect";

// VAT numbers carry their country: an EU member prefix (Greece writes EL,
// Northern Ireland XI) is an EU VAT number, GB a UK one, CHE Swiss, NO…MVA
// Norwegian. Anything else (an EIN, an ABN) has no prefix to read and needs
// its type picked.
const EU_VAT_PREFIXES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT",
  "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI",
]);
export function detectTaxIdType(value: string): string | null {
  const v = value.toUpperCase();
  if (/^CHE[0-9]/.test(v)) return "ch_vat";
  if (/^NO[0-9]{9}(MVA)?$/.test(v)) return "no_vat";
  if (/^GB[0-9]/.test(v)) return "gb_vat";
  const prefix = v.slice(0, 2);
  if (EU_VAT_PREFIXES.has(prefix) && /^[A-Z]{2}[0-9A-Z]{2,13}$/.test(v)) return "eu_vat";
  return null;
}

// Stripe validates every format itself; this only keeps junk out of the call.
// VAT-style numbers lose their spaces and dots so "HU 3207 2121" and
// "HU32072121" are the same number when diffing against what Stripe holds.
export function normalizeTaxIdValue(type: string, raw: string): string {
  const v = raw.trim();
  return /_(vat|gst|hst)$/.test(type) || type === "ch_vat" ? v.replace(/[\s.]/g, "").toUpperCase() : v;
}

type AddressSaveInput = {
  name: string;
  email: string;
  line1: string;
  line2: string;
  postal: string;
  city: string;
  state: string;
  country: string;
  taxIds: Array<{ type: string; value: string }>;
};

// Read and check the Edit address dialog. Every field is prefilled with the
// current value, so a blank field means "clear it".
export function parseAddressSave(
  p: Record<string, unknown>,
  existingTypes: ReadonlySet<string>
): { ok: true; value: AddressSaveInput } | { ok: false; error: string } {
  const field = (k: string, max: number) => str(p[k], max).trim();
  const value: AddressSaveInput = {
    name: field("name", 256),
    email: field("email", 512),
    line1: field("line1", 200),
    line2: field("line2", 200),
    postal: field("postal", 40),
    city: field("city", 200),
    state: field("state", 200),
    country: field("country", 2).toUpperCase(),
    taxIds: [],
  };
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    return { ok: false, error: "That billing email doesn't look like an email address." };
  }
  if (value.country && !isCountryCode(value.country)) return { ok: false, error: "Pick a country from the list." };
  const anyAddress = [value.line1, value.line2, value.postal, value.city, value.state].some(Boolean);
  if (anyAddress && !value.country) return { ok: false, error: "Pick a country for the address." };

  const rows = Array.isArray(p.taxIds) ? p.taxIds : [];
  if (rows.length > MAX_TAX_IDS) return { ok: false, error: `At most ${MAX_TAX_IDS} tax IDs.` };
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const raw = str(r.value, 40).trim();
    if (!raw) continue;
    let type = str(r.type, 20);
    if (type === TAX_TYPE_DETECT) {
      const detected = detectTaxIdType(raw.replace(/[\s.]/g, ""));
      if (!detected) return { ok: false, error: `Pick a type for ${raw.slice(0, 30)}: it has no country prefix to read.` };
      type = detected;
    }
    // Curated types, plus whatever type a tax ID already on this customer has
    // (so an existing, uncurated one survives a save untouched).
    if (!TAX_ID_TYPES.some((t) => t.value === type) && !existingTypes.has(type)) {
      return { ok: false, error: `Pick a tax ID type for ${raw.slice(0, 30)}.` };
    }
    const normalized = normalizeTaxIdValue(type, raw);
    if (!/^[A-Za-z0-9 .\-/]{2,30}$/.test(normalized)) {
      return { ok: false, error: `${raw.slice(0, 30)}: 2-30 letters, digits, spaces, dots, dashes or slashes.` };
    }
    const id = `${type}:${normalized}`;
    if (seen.has(id)) continue;
    seen.add(id);
    value.taxIds.push({ type, value: normalized });
  }
  return { ok: true, value };
}

const MAX_TAX_IDS = 10;

const TAX_STATUS_BADGE: Record<string, Badge> = {
  verified: { kind: "ok", text: "Verified" },
  pending: { kind: "neutral", text: "Pending" },
  unverified: { kind: "warn", text: "Unverified" },
  unavailable: { kind: "neutral", text: "Not checkable" },
};

// The address as the customer's documents print it, one part per line.
function addressLines(a: Stripe.Address | null | undefined): string | null {
  if (!a) return null;
  const lines = [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(" "), a.state, countryName(a.country)]
    .map((l) => (l ? String(l).trim() : ""))
    .filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

// PM identity cell. Stripe exposes `fingerprint` on the types that
// carry the instrument directly (cards + bank-debit rails); only CARD
// fingerprints link into the reverse-card hunt (charges.search indexes only
// those). Wallets (Link/PayPal…) vault the card on their side and expose NO
// fingerprint: but the wallet ACCOUNT EMAIL is their stable cross-customer
// identity (it lands in billing_details.email on every charge), so it links
// into the Payments whole-account email sweep instead.
const WALLET_PM_TYPES = new Set(["link", "paypal", "klarna", "cashapp", "amazon_pay", "revolut_pay"]);

function pmFingerprintCell(pm: Stripe.PaymentMethod): Cell {
  const details = (pm as unknown as Record<string, { fingerprint?: string | null } | undefined>)[pm.type];
  const fingerprint = details?.fingerprint ?? null;
  if (fingerprint) {
    if (pm.type === "card") {
      return idCell(fingerprint, { copy: true, ref: { page: "fraud", filters: { view: "card", fp: fingerprint } } });
    }
    return idCell(fingerprint, { copy: true });
  }
  const walletEmail = pm.link?.email ?? pm.paypal?.payer_email ?? null;
  if (walletEmail) {
    return { t: "link", v: walletEmail, ref: { page: "payments", filters: { email: walletEmail } } };
  }
  return WALLET_PM_TYPES.has(pm.type) ? text("N/A", "wallet-vaulted") : text("N/A");
}

function actionActor(ctx: DashboardCtx): ActionActor {
  return { kind: "dashboard", id: ctx.actor.id, name: ctx.actor.name, isAdmin: ctx.actor.isAdmin };
}

// Advisory render mode for a registry button: queue notice or disabled state.
// Execution re-checks server-side regardless.
function registryButton(ctx: DashboardCtx, button: ActionButton): ActionButton {
  const mode = ctx.billing.actions.effectiveMode(button.key, actionActor(ctx));
  if (mode === "denied") return { ...button, disabledReason: "Disabled by /config → Billing → Intercom Actions." };
  return { ...button, mode: mode === "queue" ? "queue" : "direct" };
}

// `deps` is optional so the section keeps working (Postiz rows simply absent)
// wherever it is constructed without the platform client, which is also what
// keeps the existing Customer-360 tests honest.
export interface CustomersDeps {
  postiz?: PostizIdentityService | null;
  // Resend suppression status for the customer's addresses, and removal.
  emailDelivery?: EmailDeliverabilityService | null;
  // The Resend delivery log (every email sent to those addresses), and the
  // admin-only share link.
  deliveryLog?: DeliveryLogService | null;
}

export function makeCustomersSection(deps: CustomersDeps = {}): DashboardSectionModule {
  return {
    nav: [{ key: "customers", label: "Customers", page: "customers" }],

    ownsPage(page: string): boolean {
      return page === "customers" || page === "customers.detail" || page === "customers.portal";
    },

    // Hover peek card: ONE retrieve, plain-text lines only.
    async peek(ctx: DashboardCtx, page: string, id: string) {
      if (page !== "customers.detail") return null;
      const c = await ctx.stripe.getCustomer(id).catch(() => null);
      if (!c) return null;
      const lines: string[] = [];
      if (c.email) lines.push(c.email);
      lines.push(`Customer since ${new Date(c.created * 1000).toISOString().slice(0, 10)}`);
      if (typeof c.balance === "number" && c.balance !== 0) {
        lines.push(`Balance ${ctx.stripe.formatAmount(c.balance, c.currency ?? "usd")}${c.balance < 0 ? " (credit)" : ""}`);
      }
      return {
        title: c.name ?? c.email ?? c.id,
        ...(c.delinquent ? { badge: { kind: "warn" as const, text: "Delinquent" } } : {}),
        lines: lines.slice(0, 5),
      };
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "customers") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      const id = validId("customer", req.params?.id);
      if (!id) return notFound("That customer id is not valid.");
      if (req.page === "customers.portal") return portalLinkPage(ctx, id);
      return detail(ctx, id, deps, { ...(req.filters ?? {}), ...(req.cursor ? { logcursor: req.cursor } : {}) });
    },

    async action(ctx: DashboardCtx, req) {
      return customerAction(ctx, req.key, req.params ?? {}, req.confirmWord, deps);
    },
  };
}

// ---- section actions (edit / create / delete / link) ----

async function customerAction(
  ctx: DashboardCtx,
  key: string,
  p: Record<string, unknown>,
  confirmWord: string | undefined,
  deps: CustomersDeps = {}
): Promise<{
  ok: boolean;
  text?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  needsReverse?: boolean;
  needsStepUp?: boolean;
  link?: { href: string; label: string };
}> {
  const confirmed = confirmWord === "CONFIRM";

  // T0: shared team bookmark toggle (bookmark helper validates its own id).
  if (key === "section:customers.bookmark") return toggleBookmarkAction(ctx, "customer", p);

  // Create has no target id; everything else validates one.
  if (key === "section:customers.create") {
    const email = str(p.email, 200).trim();
    const name = str(p.name, 200).trim();
    const description = str(p.description, 300).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, fieldErrors: { email: "That doesn't look like an email address." } };
    }
    if (!email && !name) return { ok: false, error: "Give the customer at least a name or an email." };
    const customer = await ctx.stripe.createCustomer({
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
    await ctx.audit(`Customer created: ${customer.id} (${email || name})`);
    return { ok: true, text: `Customer ${customer.id} created.` };
  }

  const customerId = validId("customer", p.customerId);
  if (!customerId) return { ok: false, error: "Bad customer id." };

  // Email delivery. The address is checked against the ones this customer is
  // actually known by, re-derived here, so the button cannot be pointed at an
  // arbitrary address by editing the request. Removal is T1; any signed-in
  // teammate may (operator decision), and the service audits every one.
  if (key === "section:customers.email_unsuppress" || key === "section:customers.email_activation") {
    const svc = deps.emailDelivery;
    if (!svc?.enabled()) return { ok: false, error: "Resend is not enabled (/config → Integrations → Resend)." };
    const email = str(p.email, 254).trim();
    const known = await customerEmails(ctx, customerId, deps);
    const match = known.find((e) => e.toLowerCase() === email.toLowerCase());
    if (!match) return { ok: false, error: "That address does not belong to this customer." };
    const actor = { surface: "dashboard" as const, id: ctx.actor.id, name: ctx.actor.name };
    if (key === "section:customers.email_activation") {
      const sent = await svc.resendActivation(match, actor);
      await ctx.audit(`Postiz activation email re-sent for a customer address on ${customerId}${sent.ok ? "" : " (failed)"}`);
      return sent.ok ? { ok: true, text: `Postiz is sending a new activation email to ${match}.` } : { ok: false, error: sent.error };
    }
    if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
    const result = await svc.remove(match, actor);
    await ctx.audit(`Resend suppression removal on ${customerId}: ${result.kind}`);
    switch (result.kind) {
      case "removed":
        return { ok: true, text: `${match} is off the suppression list. New mail from Postiz will be delivered to it.` };
      case "not_suppressed":
        return { ok: true, text: `${match} was not on the suppression list; nothing was removed.` };
      case "disabled":
        return { ok: false, error: "Resend is not enabled." };
      default:
        return { ok: false, error: result.error };
    }
  }

  // Admin-only: a share link for one logged email. Re-checks the admin role
  // server-side and that the email went to one of THIS customer's addresses,
  // so an edited request cannot mint a link to someone else's mail.
  if (key === "section:customers.email_share") {
    if (!ctx.actor.isAdmin) return { ok: false, error: "Only dashboard admins can share an email." };
    const log = deps.deliveryLog;
    if (!log) return { ok: false, error: "The delivery log is not available." };
    const emailId = str(p.emailId, 80).trim();
    if (!/^[A-Za-z0-9-]{8,80}$/.test(emailId)) return { ok: false, error: "Bad email id." };
    const found = await log.email(emailId).catch(() => null);
    const known = await customerEmails(ctx, customerId, deps);
    if (!found || !known.some((e) => e.toLowerCase() === found.email.recipient)) {
      return { ok: false, error: "That email was not sent to this customer." };
    }
    const r = await log.share(emailId, { surface: "dashboard", id: ctx.actor.id, name: ctx.actor.name });
    await ctx.audit(`Resend share link created for an email to ${customerId}${r.ok ? "" : " (failed)"}`);
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      text: `Link created, valid for ${SHARE_TTL_LABEL}. Anyone with it sees the whole email.`,
      link: { href: r.url, label: "Open the email as sent" },
    };
  }

  switch (key) {
    // T0: mint an off-session SetupIntent for saving a card later. Only the
    // seti_ id is surfaced; the client_secret never leaves the server (it is
    // only useful to a Stripe.js confirm flow on the customer's device).
    case "section:customers.setup_intent": {
      const si = await ctx.stripe.createSetupIntent({ customerId }, `dash-seti-${customerId}-${Date.now().toString(36)}`);
      await ctx.audit(`SetupIntent ${si.id} created for ${customerId}`);
      return {
        ok: true,
        text: `SetupIntent ${si.id} created (${si.status}). Confirm it via Stripe.js/Elements or the API; the client secret is not shown here.`,
      };
    }

    // T0: core details. Blank = keep as-is; a single "-" clears the field
    // (web modals can't prefill text inputs, so absent ≠ clear).
    case "section:customers.update": {
      const updates: Stripe.CustomerUpdateParams = {};
      const apply = (field: "name" | "email" | "description", raw: unknown, max: number) => {
        const v = str(raw, max).trim();
        if (!v) return;
        (updates as Record<string, string>)[field] = v === "-" ? "" : v;
      };
      apply("name", p.name, 200);
      apply("email", p.email, 200);
      apply("description", p.description, 300);
      if (typeof updates.email === "string" && updates.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)) {
        return { ok: false, fieldErrors: { email: "That doesn't look like an email address." } };
      }
      if (Object.keys(updates).length === 0) return { ok: false, error: "Nothing to change: fill at least one field ('-' clears)." };
      await ctx.stripe.updateCustomer(customerId, updates);
      await ctx.audit(`Customer ${customerId} updated: ${Object.keys(updates).join(", ")}`);
      return { ok: true, text: "Customer updated." };
    }

    // T0: tax exemption + preferred locale.
    case "section:customers.tax_locale": {
      const taxExempt = str(p.taxExempt, 10);
      const locale = str(p.locale, 12).trim();
      const updates: Stripe.CustomerUpdateParams = {};
      if (taxExempt === "none" || taxExempt === "exempt" || taxExempt === "reverse") updates.tax_exempt = taxExempt;
      if (locale) updates.preferred_locales = locale === "-" ? [] : [locale];
      if (Object.keys(updates).length === 0) return { ok: false, error: "Nothing to change." };
      await ctx.stripe.updateCustomer(customerId, updates);
      await ctx.audit(`Customer ${customerId} tax/locale updated`);
      return { ok: true, text: "Tax settings updated." };
    }

    // T0: metadata: key=value per line; a single "-" clears everything.
    case "section:customers.metadata": {
      const raw = str(p.metadata, 2000).trim();
      if (!raw) return { ok: false, error: "Enter key=value lines, or '-' to clear all metadata." };
      if (raw === "-") {
        await ctx.stripe.updateCustomer(customerId, { metadata: "" });
        await ctx.audit(`Customer ${customerId} metadata cleared`);
        return { ok: true, text: "Metadata cleared." };
      }
      const metadata: Record<string, string> = {};
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) return { ok: false, fieldErrors: { metadata: `"${trimmed.slice(0, 40)}" is not key=value.` } };
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1).trim();
        if (!k || k.length > 40 || v.length > 500) return { ok: false, fieldErrors: { metadata: `"${k.slice(0, 40)}": keys ≤40 chars, values ≤500.` } };
        metadata[k] = v;
      }
      if (Object.keys(metadata).length === 0) return { ok: false, error: "No key=value lines found." };
      await ctx.stripe.updateCustomer(customerId, { metadata });
      await ctx.audit(`Customer ${customerId} metadata updated: ${Object.keys(metadata).length} key(s)`);
      return { ok: true, text: `Metadata updated (${Object.keys(metadata).length} key(s)).` };
    }

    // T0: the customer's address card in one save: name, billing email,
    // address and every tax ID. Diffed against a fresh read so only what
    // changed is written. Tax IDs cannot be edited at Stripe, so a changed
    // number is the new one added, then the old one removed. Adds go first:
    // they are what Stripe rejects (format, VIES shape), and a rejection then
    // leaves the rest of the customer as it was.
    case "section:customers.address_save": {
      const [customer, currentTax] = await Promise.all([
        ctx.stripe.getCustomer(customerId),
        ctx.stripe.listTaxIds(customerId),
      ]);
      if (!customer) return { ok: false, error: "That customer no longer exists." };
      const parsed = parseAddressSave(p, new Set(currentTax.map((t) => t.type)));
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const next = parsed.value;

      const updates: Stripe.CustomerUpdateParams = {};
      const changed: string[] = [];
      if (next.name !== (customer.name ?? "")) {
        updates.name = next.name;
        changed.push("name");
      }
      if (next.email !== (customer.email ?? "")) {
        updates.email = next.email;
        changed.push("email");
      }
      const cur = customer.address;
      const nextAddress = {
        line1: next.line1,
        line2: next.line2,
        postal_code: next.postal,
        city: next.city,
        state: next.state,
        country: next.country,
      };
      const addressChanged = (Object.keys(nextAddress) as Array<keyof typeof nextAddress>).some(
        (k) => nextAddress[k] !== ((cur?.[k] ?? "") as string)
      );
      if (addressChanged) {
        const empty = Object.values(nextAddress).every((v) => !v);
        updates.address = empty ? "" : nextAddress;
        changed.push(empty ? "address cleared" : "address");
      }

      const key = (type: string, value: string) => `${type}:${normalizeTaxIdValue(type, value)}`;
      const wanted = new Set(next.taxIds.map((t) => key(t.type, t.value)));
      const have = new Set(currentTax.map((t) => key(t.type, t.value)));
      const toAdd = next.taxIds.filter((t) => !have.has(key(t.type, t.value)));
      const toRemove = currentTax.filter((t) => !wanted.has(key(t.type, t.value)));

      if (changed.length === 0 && toAdd.length === 0 && toRemove.length === 0) return { ok: true, text: "Nothing changed." };

      const added: string[] = [];
      for (const t of toAdd) {
        try {
          const created = await ctx.stripe.addTaxId(customerId, t.type, t.value);
          added.push(created.id);
        } catch (e) {
          if (added.length) await ctx.audit(`Customer ${customerId}: tax ID(s) ${added.join(", ")} added before a rejection`);
          const why = (e as Error).message?.slice(0, 200) || "Stripe rejected it.";
          return {
            ok: false,
            error: `${taxTypeLabel(t.type)} ${t.value}: ${why}${added.length ? ` (${added.length} other tax ID already added)` : ""}`,
          };
        }
      }
      if (Object.keys(updates).length) await ctx.stripe.updateCustomer(customerId, updates);
      for (const t of toRemove) await ctx.stripe.removeTaxId(customerId, t.id);

      const parts = [...changed];
      if (toAdd.length) parts.push(`tax ID added (${toAdd.map((t) => t.type).join(", ")})`);
      if (toRemove.length) parts.push(`tax ID removed (${toRemove.map((t) => t.id).join(", ")})`);
      await ctx.audit(`Customer ${customerId}: address card saved: ${parts.join("; ")}`);
      return { ok: true, text: "Address saved." };
    }

    // T1 + T2: grant monetary credits against METERED usage. Money-adjacent
    // (credits shrink future usage bills), so typed CONFIRM plus fresh factor.
    case "section:customers.credit_grant": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      if (!ctx.security.stepUpFresh()) return { ok: false, needsStepUp: true };
      const amountMajor = typeof p.amountMajor === "number" && isFinite(p.amountMajor) && p.amountMajor > 0 ? p.amountMajor : null;
      if (!amountMajor) return { ok: false, fieldErrors: { amountMajor: "Enter a positive amount." } };
      const currency = str(p.currency, 3).trim().toLowerCase();
      if (!/^[a-z]{3}$/.test(currency)) return { ok: false, fieldErrors: { currency: "3-letter currency code." } };
      const category = p.category === "paid" ? ("paid" as const) : ("promotional" as const);
      const name = str(p.name, 100).trim();
      const expiresDays =
        typeof p.expiresDays === "number" && Number.isSafeInteger(p.expiresDays) && p.expiresDays >= 1 && p.expiresDays <= 3650
          ? p.expiresDays
          : null;
      const customer = await ctx.stripe.getCustomer(customerId).catch(() => null);
      if (!customer || customer.deleted) return { ok: false, error: "Customer no longer exists in Stripe." };
      const amountMinor = Math.round(amountMajor * (StripeClient.isZeroDecimal(currency) ? 1 : 100));
      const grant = await ctx.stripe.createCreditGrant(
        {
          customerId,
          amountMinor,
          currency,
          category,
          ...(name ? { name } : {}),
          ...(expiresDays ? { expiresAt: Math.floor(Date.now() / 1000) + expiresDays * 86400 } : {}),
        },
        `dash-credgrant-${customerId}-${Date.now().toString(36)}`
      );
      await ctx.audit(
        `Credit grant ${grant.id} for ${customerId}: ${ctx.stripe.formatAmount(amountMinor, currency)} (${category}${expiresDays ? `, expires in ${expiresDays}d` : ""})`
      );
      // Concession: billing credits never produce a balance transaction, so
      // this is the only place the give-away can be booked.
      await ctx.billing.moneyOut
        ?.recordBalanceConcession({
          id: grant.id,
          category: "credit_grant",
          customerId,
          currency,
          amountMinor,
          reason: category,
          source: "action",
        })
        .catch(() => undefined);
      exportBillingEvent({ event: "credit_grant", amountMinor, currency, surface: "dashboard" });
      return { ok: true, text: `Granted ${ctx.stripe.formatAmount(amountMinor, currency)} in billing credits (${grant.id}).` };
    }

    // T1: void a grant: zeroes the REMAINING credit (applied credit stays).
    case "section:customers.credit_grant_void": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const grantId = typeof p.grantId === "string" && /^credgr_[A-Za-z0-9_]{1,80}$/.test(p.grantId) ? p.grantId : null;
      if (!grantId) return { ok: false, error: "Bad credit grant id." };
      const grant = await ctx.stripe.getCreditGrant(grantId).catch(() => null);
      if (!grant) return { ok: false, error: "This credit grant does not exist." };
      const grantCustomer = typeof grant.customer === "string" ? grant.customer : grant.customer?.id ?? null;
      if (grantCustomer !== customerId) return { ok: false, error: "That grant belongs to a different customer." };
      if (grant.voided_at) return { ok: false, error: "This grant is already voided." };
      if (grant.expires_at && grant.expires_at < Math.floor(Date.now() / 1000)) {
        return { ok: false, error: "This grant has already expired." };
      }
      await ctx.stripe.voidCreditGrant(grantId, `dash-credvoid-${grantId}`);
      await ctx.audit(`Credit grant ${grantId} VOIDED for ${customerId}`);
      return { ok: true, text: `Credit grant ${grantId} voided: remaining credit is gone; already-applied credit stays.` };
    }

    // T1: link a Discord user to this Stripe customer.
    case "section:customers.link": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const discordId = str(p.discordUserId, 32).trim();
      if (!/^\d{5,32}$/.test(discordId)) return { ok: false, fieldErrors: { discordUserId: "Discord user ids are 5-32 digits." } };
      const updated = await ctx.stores.session.updateStripeCustomerId(discordId, customerId);
      if (!updated) {
        return { ok: false, error: "That Discord user has no session row yet; they need to interact with the bot once first." };
      }
      await ctx.audit(`Linked Discord ${discordId} ↔ ${customerId}`);
      return { ok: true, text: `Linked Discord user ${discordId} to ${customerId}.` };
    }

    // T1: clear the link on every Discord user pointing at this customer.
    case "section:customers.unlink": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const cleared = await ctx.stores.session.unlinkStripeCustomerEverywhere(customerId);
      await ctx.audit(`Unlinked ${customerId} from ${cleared} Discord user session(s)`);
      return { ok: true, text: cleared ? `Cleared the link on ${cleared} Discord user session(s).` : "No Discord users were linked." };
    }

    // T1 + T3: delete the customer in Stripe (permanent, cancels subs),
    // then clear every Discord link: exactly the CustomersHub sequence.
    case "section:customers.delete": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true };
      await ctx.stripe.deleteCustomer(customerId);
      const unlinked = await ctx.stores.session.unlinkStripeCustomerEverywhere(customerId);
      await ctx.audit(`Customer ${customerId} DELETED in Stripe${unlinked ? `; cleared the link on ${unlinked} Discord user session(s)` : ""}`);
      return { ok: true, text: `Customer ${customerId} deleted in Stripe.${unlinked ? ` Cleared ${unlinked} Discord link(s).` : ""}` };
    }

    default:
      return { ok: false, error: "Unknown action." };
  }
}

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const q = str(filters.q, 80);
  // Filter expansion (Stripe Customers-filter parity): created is a
  // SERVER param on the plain listing; delinquent/country/has-subscription
  // slice the fetched page (subscriptions ride the list expand).
  const { createdGte, createdLt } = parseDateFilter(str(filters.created, 24));
  const delinquentF = filters.delinquent === "yes" || filters.delinquent === "no" ? filters.delinquent : "";
  const countryF = /^[A-Za-z]{2}$/.test(filters.country ?? "") ? filters.country.toUpperCase() : "";
  const hasSubF = filters.hassub === "yes" || filters.hassub === "no" ? filters.hassub : "";

  let customers: Stripe.Customer[];
  let hasMore = false;
  let notice: string | undefined;
  if (q) {
    customers = await ctx.stripe.searchCustomersByTerm(q, PAGE_SIZE);
    notice = "Search results (name/email fuzzy match). May lag Stripe by ~1 minute.";
  } else {
    const page = await ctx.stripe.listCustomersPage({
      limit: PAGE_SIZE,
      startingAfter: validCursor(cursor) ?? undefined,
      createdGte,
      createdLt,
    });
    customers = page.customers;
    hasMore = page.hasMore;
  }

  const sliced = customers.filter((c) => {
    if (delinquentF && (c.delinquent === true) !== (delinquentF === "yes")) return false;
    if (countryF && (c.address?.country ?? "").toUpperCase() !== countryF) return false;
    if (hasSubF) {
      const has = ((c as { subscriptions?: { data?: unknown[] } }).subscriptions?.data?.length ?? 0) > 0;
      if (has !== (hasSubF === "yes")) return false;
    }
    // Search results can't take a server-side created param: cut here.
    if (q && createdGte && c.created < createdGte) return false;
    if (q && createdLt && c.created >= createdLt) return false;
    return true;
  });

  const n = sliced.length;
  const table: TableBlock = {
    type: "table",
    key: "customers",
    columns: [
      { key: "name", label: "Customer" },
      { key: "email", label: "Email" },
      { key: "flags", label: "Flags" },
      { key: "country", label: "Country" },
      { key: "created", label: "Created" },
      { key: "id", label: "ID" },
    ],
    filters: [
      { key: "q", label: "Search", kind: "search", value: q || undefined, placeholder: "Search by name or email" },
      {
        key: "created",
        label: "Created",
        kind: "daterange",
        value: str(filters.created, 24) && (createdGte || createdLt) ? str(filters.created, 24) : undefined,
        options: DATE_RANGE_OPTIONS,
      },
      {
        key: "delinquent",
        label: "Delinquent",
        kind: "select",
        value: delinquentF || undefined,
        options: [
          { value: "yes", label: "Delinquent" },
          { value: "no", label: "Not delinquent" },
        ],
      },
      {
        key: "hassub",
        label: "Has subscription",
        kind: "select",
        value: hasSubF || undefined,
        options: [
          { value: "yes", label: "Has a subscription" },
          { value: "no", label: "No subscription" },
        ],
      },
      { key: "country", label: "Country", kind: "text", value: countryF || undefined, placeholder: "DE" },
    ],
    exportable: true,
    rows: sliced.map((c) => ({
      id: c.id,
      ref: { page: "customers.detail", params: { id: c.id } },
      cells: [
        strong(c.name ?? "N/A"),
        text(c.email ?? "N/A"),
        { t: "flags", badges: c.delinquent ? [{ kind: "warn", text: "Delinquent" }] : [] },
        text(c.address?.country ?? "N/A"),
        dateCell(c.created),
        idCell(c.id, { copy: true }),
      ] as Cell[],
    })),
    nextCursor: !q && hasMore && customers.length > 0 ? customers[customers.length - 1].id : null,
    empty: q || delinquentF || countryF || hasSubF ? "No customers match these filters (within this page)." : "No customers yet.",
    ...(n > 0 ? { footer: q ? `${n} result${n === 1 ? "" : "s"}` : `${n}${hasMore ? "+" : ""} item${n === 1 ? "" : "s"}` } : {}),
    notice:
      (notice ? `${notice} ` : "") +
      (delinquentF || countryF || hasSubF ? "Delinquent/country/subscription filters slice the fetched page; page onward for more." : "") || undefined,
  };

  const header: Block = {
    type: "header",
    title: "Customers",
    actions: [
      {
        key: "section:customers.create",
        label: "New customer",
        style: "primary",
        inputs: [
          { type: "text", key: "email", label: "Email" },
          { type: "text", key: "name", label: "Name" },
          { type: "text", key: "description", label: "Description (internal)" },
        ],
        summary: "Creates a Stripe customer (at least a name or an email).",
      },
    ],
  };

  return { title: "Customers", crumbs: [{ label: "Customers" }], blocks: [header, table] };
}

// The rail is 280px: two organizations is as much as reads cleanly, and a
// Stripe customer mapping to more than one org is already an anomaly.
const MAX_RAIL_ORGS = 2;

// Platform dates arrive as ISO strings; the rail only has room for the day.
function shortDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

// Postiz-created subscriptions carry service:"gitroom" metadata. The live one
// speaks for the customer's current plan, so it sorts ahead of a dead one.
const LIVE_SUB_STATUSES = new Set(["active", "trialing", "past_due"]);

function gitroomSubs(subs: Stripe.Subscription[]): Stripe.Subscription[] {
  return subs
    .filter((sub) => isGitroomSub(sub))
    .sort(
      (a, b) =>
        Number(LIVE_SUB_STATUSES.has(b.status)) - Number(LIVE_SUB_STATUSES.has(a.status)) ||
        (b.created ?? 0) - (a.created ?? 0)
    );
}

// The Postiz lookup needs a uniqueId off the customer's subscriptions, so it
// chains behind that read instead of becoming another independent entry in the
// fan-out below. It is not a Stripe call and must not count against the
// twelve-parallel-Stripe-reads ceiling documented there.
async function loadSubsAndPostiz(
  ctx: DashboardCtx,
  customerId: string,
  deps: CustomersDeps
): Promise<{ subs: Stripe.Subscription[]; postiz: PostizOrgLookup }> {
  const subs = await ctx.stripe.listSubscriptions(customerId).catch(() => [] as Stripe.Subscription[]);
  const off: PostizOrgLookup = { state: "off", orgs: [], via: null };
  if (!deps.postiz) return { subs, postiz: off };

  const uniqueIds: string[] = [];
  for (const sub of gitroomSubs(subs)) {
    const uid = readPostizMeta(sub.metadata).uniqueId;
    if (uid && !uniqueIds.includes(uid)) uniqueIds.push(uid);
  }

  const postiz = await deps
    .postiz.resolveOrgsForCustomer(customerId, uniqueIds)
    // resolveOrgsForCustomer already swallows its own failures; this is the
    // belt for a client that is broken outright.
    .catch(() => ({ state: "error", orgs: [], via: null }) as PostizOrgLookup);
  return { subs, postiz };
}

// The addresses a customer is known by: the one Stripe bills, then the owner
// of each Postiz organisation that is (or may be) theirs. Postiz mails its
// users at the latter, which is often not the billing address.
function emailsOf(stripeEmail: string | null, postiz: PostizOrgLookup): string[] {
  return distinctEmails([
    stripeEmail,
    ...postiz.orgs.filter((o) => o.customerMatches !== false && !o.orgDeleted).map((o) => o.ownerEmail),
  ]);
}

async function customerEmails(ctx: DashboardCtx, customerId: string, deps: CustomersDeps): Promise<string[]> {
  const [customer, subs] = await Promise.all([
    ctx.stripe.getCustomer(customerId).catch(() => null),
    loadSubsAndPostiz(ctx, customerId, deps).catch(() => null),
  ]);
  return emailsOf(customer?.email ?? null, subs?.postiz ?? { state: "off", orgs: [], via: null });
}

const REMOVE_SUMMARY =
  "Takes the address off Resend's suppression list, so Postiz mail (activation, password reset, notifications) is delivered to it again. If it still bounces or is reported as spam, Resend suppresses it again.";

function deliveryCell(st: DeliveryStatus): Cell {
  if (st.state === "suppressed") {
    return { t: "text", v: describeSuppression(st.suppression, st.source), sub: "Postiz mail to it is dropped" } as Cell;
  }
  if (st.state === "clear") return badgeCell("ok", "Deliverable");
  return badgeCell("warn", `Unknown: ${st.error}`);
}

async function emailDeliveryCard(
  svc: EmailDeliverabilityService,
  customerId: string,
  stripeEmail: string | null,
  postiz: PostizOrgLookup
): Promise<Block> {
  const statuses = await svc.statusFor(emailsOf(stripeEmail, postiz));
  const actions: ActionButton[] = [];
  for (const st of statuses) {
    if (st.state !== "suppressed") continue;
    actions.push({
      key: "section:customers.email_unsuppress",
      label: `Remove ${st.email} from suppression`.slice(0, 80),
      dangerous: true,
      params: { customerId, email: st.email },
      summary: REMOVE_SUMMARY,
    });
  }
  // The usual reason any of this matters: an account whose activation mail
  // never arrived cannot log in.
  for (const org of postiz.orgs) {
    const email = org.ownerEmail;
    if (org.ownerActivated !== false || !email || org.customerMatches === false) continue;
    if (!statuses.some((st) => st.email.toLowerCase() === email.toLowerCase() && st.state === "clear")) continue;
    actions.push({
      key: "section:customers.email_activation",
      label: "Resend activation email",
      params: { customerId, email },
      summary: `Asks Postiz to send ${email} a new activation email. The account is not activated yet.`,
    });
  }
  return {
    type: "kv",
    title: "Email delivery",
    rows: statuses.length
      ? statuses.map((st) => ({ label: st.email, cell: deliveryCell(st) }))
      : [{ label: "Addresses", cell: text("none known") }],
    ...(actions.length ? { actions } : {}),
  };
}

const LOG_PAGE_SIZE = 10;

// Every email Resend sent to this customer's addresses, newest first, ten to
// a page (the cursor is the page number). Admins get a Share action per row.
async function deliveryLogTable(
  ctx: DashboardCtx,
  log: DeliveryLogService,
  customerId: string,
  addresses: string[],
  cursor: string | undefined
): Promise<TableBlock> {
  const page = cursor && /^\d{1,5}$/.test(cursor) ? Number(cursor) : 0;
  const history = await log.historyForMany(addresses, page, LOG_PAGE_SIZE).catch(() => null);
  const pages = history ? Math.ceil(history.total / LOG_PAGE_SIZE) : 0;
  return {
    type: "table",
    key: "emaillog",
    title: history ? `Delivery log (${history.total})` : "Delivery log",
    columns: [
      { key: "sent", label: "Sent" },
      { key: "kind", label: "Email" },
      { key: "status", label: "Status" },
      { key: "to", label: "To / reason" },
    ],
    rows: (history?.rows ?? []).map((r) => ({
      id: r.id,
      cells: [
        isoDateCell(r.sentAt),
        text(categoryLabel(r.category), r.subject ?? undefined),
        badgeCell(
          PROBLEM_EVENTS.has(r.lastEvent) ? (r.lastEvent === "delivery_delayed" ? "warn" : "error") : r.lastEvent === "delivered" ? "ok" : "info",
          eventLabel(r.lastEvent)
        ),
        text(r.recipient, r.detail ? r.detail.slice(0, 160) : undefined),
      ],
      ...(ctx.actor.isAdmin
        ? {
            actions: [
              {
                key: "section:customers.email_share",
                label: `Share link (${SHARE_TTL_LABEL})`,
                params: { customerId, emailId: r.id },
                summary: `Creates a link that shows this email exactly as sent, body included, valid for ${SHARE_TTL_LABEL}. A reset or activation email carries a live link: do not paste it where others can read it.`,
              },
            ],
          }
        : {}),
    })),
    empty: history
      ? log.webhookRegistered()
        ? "No email to these addresses in the last 180 days."
        : "Nothing logged: the Resend webhook is not registered (/config → Integrations → Resend)."
      : "The delivery log is unavailable right now.",
    nextCursor: page + 1 < pages ? String(page + 1) : null,
    ...(history && history.total > 0 ? { footer: `${history.total} email${history.total === 1 ? "" : "s"} · 180 days kept` } : {}),
  };
}

// One query for the linked Discord sessions instead of one per id.
async function loadDiscordLinks(
  ctx: DashboardCtx,
  customerId: string
): Promise<{ discordIds: string[]; postizUserId: string | null }> {
  const discordIds = await ctx.stores.session.findDiscordIdsByStripeId(customerId).catch(() => [] as string[]);
  const capped = discordIds.slice(0, 5);
  if (!capped.length) return { discordIds, postizUserId: null };
  const sessions = await ctx.stores.session.listByDiscordIds(capped).catch(() => []);
  const linked = sessions.find((row) => row.postizUserId)?.postizUserId ?? null;
  return { discordIds, postizUserId: linked };
}

// The page's tabs. The rail keeps only Insights and Manage; everything that
// used to stack under them lives on a tab, so nothing needs a long scroll.
const TAB_ITEMS = [
  { value: "", label: "Overview" },
  { value: "billing", label: "Billing" },
  { value: "email", label: "Postiz & Email" },
  { value: "details", label: "Details" },
] as const;
type CustomerTab = "overview" | "billing" | "email" | "details";

function tabOf(raw: string | undefined): CustomerTab {
  return raw === "billing" || raw === "email" || raw === "details" ? raw : "overview";
}

async function detail(
  ctx: DashboardCtx,
  id: string,
  deps: CustomersDeps = {},
  filters: Record<string, string> = {}
): Promise<SectionPage> {
  const tab = tabOf(filters.tab);
  const customer = await ctx.stripe.getCustomer(id).catch(() => null);
  if (!customer) {
    return notFound("This customer does not exist (or was deleted).");
  }

  // Note: 12 parallel STRIPE reads is the ceiling here: consolidate
  // before adding more (every new one is .catch-guarded and independent; the
  // bookmark flag is a local DB read, not a Stripe call).
  const [subsAndPostiz, invoices, methods, chargesPage, disputes, blocks, discordLinks, notes, creditGrants, taxIds, balanceTxns, cashBalance, bookmarked] =
    await Promise.all([
      loadSubsAndPostiz(ctx, id, deps),
      ctx.stripe.listInvoices(id, 10).catch(() => ({ invoices: [] as Stripe.Invoice[], hasMore: false })),
      ctx.stripe.listAllPaymentMethods(id).catch(() => [] as Stripe.PaymentMethod[]),
      ctx.stripe.listCharges(id, 100).catch(() => ({ charges: [] as Stripe.Charge[], hasMore: false })),
      ctx.stores.dispute.listByCustomer(id, 10).catch(() => []),
      ctx.stores.block.listForCustomer(id, customer.email).catch(() => []),
      loadDiscordLinks(ctx, id),
      ctx.stores.qol.listNotes("customer", id, 0, 5).catch(() => ({ rows: [], total: 0 })),
      ctx.stripe.listCreditGrants(id).catch(() => [] as Stripe.Billing.CreditGrant[]),
      ctx.stripe.listTaxIds(id).catch(() => [] as Stripe.TaxId[]),
      ctx.stripe
        .listBalanceTransactions(id, 10)
        .then((r) => r.data)
        .catch(() => [] as Stripe.CustomerBalanceTransaction[]),
      ctx.stripe.getCashBalance(id).catch(() => null),
      isBookmarkedSafe(ctx, "customer", id),
    ]);

  const { subs, postiz } = subsAndPostiz;
  const { discordIds } = discordLinks;

  const main: Block[] = [];
  const rail: Block[] = [];
  const tabs: Record<CustomerTab, Block[]> = { overview: [], billing: [], email: [], details: [] };

  // Header: big name, email subline, status pills (Stripe detail archetype).
  const headBadges: Badge[] = [];
  if (customer.delinquent) headBadges.push({ kind: "warn", text: "Delinquent" });
  if (blocks.length > 0) headBadges.push({ kind: "error", text: "Blocked" });
  const title = customer.name || customer.email || customer.id;
  main.push({
    type: "header",
    title,
    ...(customer.email && customer.email !== title ? { sub: customer.email, subCopy: true } : {}),
    badges: headBadges,
    actions: [
      registryButton(ctx, {
        key: "customer.payment_method",
        label: "Attach payment method",
        dangerous: true,
        params: { customerId: id, op: "attach" },
        inputs: [
          { type: "text", key: "paymentMethodId", label: "Payment method (pm_…) or card token (tok_…)", placeholder: "pm_… / tok_…" },
          { type: "toggle", key: "makeDefault", label: "Set as default for invoices" },
        ],
        summary: "Attaches an existing unattached payment method (or mints one from a card token) to this customer.",
      }),
      {
        key: "section:customers.setup_intent",
        label: "Create SetupIntent",
        params: { customerId: id },
        summary:
          "Mints an off-session SetupIntent for saving a card via Stripe.js/Elements or the API. Only the seti_ id is shown, never the client secret.",
      },
      bookmarkButton("section:customers.bookmark", bookmarked, id, title),
    ],
  });

  // Blocklist banner (error notice with the first block's context).
  if (blocks.length > 0) {
    const b = blocks[0];
    main.push({
      type: "notice",
      badge: { kind: "error", text: "BLOCKED" },
      text:
        `${b.kind} "${b.value}" · ${b.reason}` +
        (b.actorName ? ` · added by ${b.actorName}` : "") +
        ` · ${b.createdAt.toISOString().slice(0, 10)}` +
        (blocks.length > 1 ? ` (+${blocks.length - 1} more entries)` : ""),
    });
  }

  // ---- rail: Insights (big values) ----
  const succeeded = chargesPage.charges.filter((c) => c.status === "succeeded");
  const spendByCurrency = new Map<string, number>();
  const refundsByCurrency = new Map<string, number>();
  for (const c of succeeded) {
    spendByCurrency.set(c.currency, (spendByCurrency.get(c.currency) ?? 0) + (c.amount - (c.amount_refunded ?? 0)));
  }
  for (const c of chargesPage.charges) {
    if ((c.amount_refunded ?? 0) > 0) {
      refundsByCurrency.set(c.currency, (refundsByCurrency.get(c.currency) ?? 0) + (c.amount_refunded ?? 0));
    }
  }
  const balance =
    customer.balance !== 0 && customer.currency != null
      ? ctx.stripe.formatAmount(customer.balance, customer.currency)
      : customer.balance !== 0
        ? String(customer.balance)
        : null;
  rail.push({
    type: "kv",
    title: "Insights",
    big: true,
    rows: [
      {
        label: "Spent",
        cell: text(
          formatPerCurrency(ctx.stripe, spendByCurrency),
          chargesPage.hasMore ? "from the 100 most recent payments" : undefined
        ),
      },
      { label: "MRR", cell: text(formatPerCurrency(ctx.stripe, estimateMrr(subs))) },
      { label: "Refunds", cell: text(formatPerCurrency(ctx.stripe, refundsByCurrency)) },
      ...(balance
        ? [{ label: "Balance", cell: text(balance, customer.balance < 0 ? "negative = customer credit" : undefined) }]
        : []),
      ...(() => {
        // Bank-transfer funds awaiting reconciliation (usually absent).
        const buckets = Object.entries(cashBalance?.available ?? {}).filter(([, v]) => v !== 0);
        if (buckets.length === 0) return [];
        const map = new Map(buckets);
        return [
          {
            label: "Cash balance",
            cell: text(formatPerCurrency(ctx.stripe, map), "bank-transfer funds awaiting reconciliation"),
          },
        ];
      })(),
    ],
  });

  // ---- rail: Details ----
  const defaultPm =
    typeof customer.invoice_settings?.default_payment_method === "string"
      ? customer.invoice_settings.default_payment_method
      : (customer.invoice_settings?.default_payment_method as Stripe.PaymentMethod | null)?.id ?? null;
  const defaultPmObj = defaultPm ? methods.find((m) => m.id === defaultPm) ?? null : null;

  // ---- Details tab: Address (name, address, tax IDs, billing email) ----
  // One card and one dialog for everything that identifies the customer on
  // their documents. Shipping is deliberately absent: Postiz ships nothing,
  // and a shipping address already in Stripe is left as it is.
  const addr = customer.address;
  // A tax ID already on the customer keeps its type even when it is not one
  // of the curated ones, or its row would reopen on "Detect" and fail.
  const taxOptions = (existing: string[]) => {
    const opts = [{ value: TAX_TYPE_DETECT, label: "Detect from number" }, ...TAX_ID_TYPES];
    for (const type of existing) {
      if (!opts.some((o) => o.value === type)) opts.push({ value: type, label: taxTypeLabel(type) });
    }
    return opts;
  };
  tabs.details.push({
    type: "kv",
    title: "Address",
    rows: [
      { label: "Name", cell: customer.name ? { t: "text", v: customer.name, strong: true } : text("N/A") },
      { label: "Address", cell: (() => {
        const lines = addressLines(addr);
        return lines ? { t: "text", v: lines, pre: true } : text("N/A");
      })() },
      ...(taxIds.length
        ? taxIds.slice(0, MAX_TAX_IDS).map((t) => {
            const badge = t.verification?.status ? TAX_STATUS_BADGE[t.verification.status] : undefined;
            return { label: taxTypeLabel(t.type), cell: { t: "text", v: t.value, ...(badge ? { badge } : {}) } as Cell };
          })
        : [{ label: "Tax ID", cell: text("none") }]),
      { label: "Billing email", cell: text(customer.email ?? "N/A") },
    ],
    actions: [
      {
        key: "section:customers.address_save",
        label: "Edit address",
        submitLabel: "Save",
        params: { customerId: id },
        inputs: [
          { type: "text", key: "name", label: "Name or company", value: customer.name ?? "", maxLength: 256 },
          { type: "text", key: "line1", label: "Street", value: addr?.line1 ?? "", maxLength: 200 },
          { type: "text", key: "line2", label: "Line 2", value: addr?.line2 ?? "", maxLength: 200 },
          { type: "text", key: "postal", label: "Postal code", value: addr?.postal_code ?? "", maxLength: 40, half: true },
          { type: "text", key: "city", label: "City", value: addr?.city ?? "", maxLength: 200, half: true },
          { type: "text", key: "state", label: "State or region", value: addr?.state ?? "", maxLength: 200, half: true },
          {
            type: "select",
            key: "country",
            label: "Country",
            value: addr?.country ?? "",
            options: [{ value: "", label: "None" }, ...countryOptions()],
            half: true,
          },
          {
            type: "rows",
            key: "taxIds",
            label: "VAT or tax IDs",
            max: MAX_TAX_IDS,
            addLabel: "Add tax ID",
            columns: [
              { key: "type", label: "Type", kind: "select", options: taxOptions(taxIds.map((t) => t.type)) },
              { key: "value", label: "Number", kind: "text", placeholder: "HU32072121", maxLength: 40, mono: true },
            ],
            value: taxIds.slice(0, MAX_TAX_IDS).map((t) => ({ type: t.type, value: t.value })),
          },
          { type: "text", key: "email", label: "Billing email", value: customer.email ?? "", maxLength: 512 },
        ],
      },
    ],
  });

  tabs.details.push({
    type: "kv",
    title: "Details",
    rows: [
      { label: "Customer ID", cell: idCell(customer.id, { copy: true }) },
      { label: "Customer since", cell: dateCell(customer.created) },
      { label: "Currency", cell: text(customer.currency?.toUpperCase() ?? "N/A") },
      ...(customer.delinquent ? [{ label: "Delinquent", cell: badgeCell("warn", "Yes") }] : []),
      ...(customer.tax_exempt && customer.tax_exempt !== "none"
        ? [{ label: "Tax exempt", cell: text(customer.tax_exempt) }]
        : []),
      ...(customer.preferred_locales?.length
        ? [{ label: "Locale", cell: text(customer.preferred_locales.join(", ")) }]
        : []),
      {
        label: "Default payment method",
        cell: defaultPmObj ? paymentMethodCell(defaultPmObj) : defaultPm ? idCell(defaultPm, { copy: true }) : text("N/A"),
      },
      ...(customer.discount
        ? [
            {
              label: "Discount",
              cell: text(
                typeof customer.discount.source?.coupon === "string"
                  ? customer.discount.source.coupon
                  : customer.discount.source?.coupon?.name ?? customer.discount.source?.coupon?.id ?? "coupon",
                "applies to every invoice"
              ),
            },
          ]
        : []),
      ...(customer.description ? [{ label: "Description", cell: text(customer.description) }] : []),
    ],
    // Name and billing email are edited on the Address card; this one keeps
    // the internal description.
    actions: [
      {
        key: "section:customers.update",
        label: "Edit description",
        submitLabel: "Save",
        params: { customerId: id },
        inputs: [
          { type: "text", key: "description", label: "Description · '-' clears", value: customer.description ?? "", maxLength: 300 },
        ],
      },
      {
        key: "section:customers.tax_locale",
        label: "Tax & locale",
        params: { customerId: id },
        inputs: [
          {
            type: "select",
            key: "taxExempt",
            label: "Tax exemption",
            value: customer.tax_exempt ?? "none",
            options: [
              { value: "none", label: "None (taxable)" },
              { value: "exempt", label: "Exempt" },
              { value: "reverse", label: "Reverse charge" },
            ],
          },
          { type: "text", key: "locale", label: `Preferred locale (now: ${customer.preferred_locales?.[0] ?? "N/A"}) · '-' clears` },
        ],
      },
      {
        key: "section:customers.metadata",
        label: "Metadata",
        params: { customerId: id },
        inputs: [
          { type: "text", key: "metadata", label: "key=value per line · '-' alone clears ALL metadata", multiline: true, maxLength: 2000 },
        ],
        summary: "Replaces the listed keys (other keys survive); '-' wipes everything.",
      },
      ...(customer.discount
        ? [
            registryButton(ctx, {
              key: "customer.coupon",
              label: "Remove discount",
              dangerous: true, // T1 param-aware (needsConfirmExtra) server-side
              params: { customerId: id, op: "remove" },
              summary: "Removes the CUSTOMER-level discount; every future invoice bills full price.",
            }),
          ]
        : []),
    ],
  });

  // ---- rail: Metadata (moved from the removed edit page) ----
  const metaEntries = Object.entries(customer.metadata ?? {});
  if (metaEntries.length > 0) {
    tabs.details.push({
      type: "kv",
      title: `Metadata (${metaEntries.length})`,
      rows: metaEntries.slice(0, 20).map(([k, v]) => ({ label: k, cell: text(String(v).slice(0, 120)) })),
    });
  }

  // ---- rail: Linked accounts (Discord / Postiz) ----
  const linkRows: Array<{ label: string; cell: Cell }> = [];
  for (const discordId of discordIds.slice(0, 5)) {
    linkRows.push({ label: "Discord user", cell: idCell(discordId, { copy: true }) });
  }

  // Free half of the Postiz picture: whatever the subscription's own metadata
  // already says. Rendered before the platform rows so the card still carries
  // the plan when the platform is slow or switched off.
  const gitroom = gitroomSubs(subs)[0] ?? null;
  const meta = gitroom ? readPostizMeta(gitroom.metadata) : null;
  // The platform writes userId on its own checkout subs; our own creates do not
  // (buildPostizMetadata is deliberately four keys), hence the fallback order.
  const metaUserId = str(gitroom?.metadata?.userId).trim() || null;
  const postizUserId = discordLinks.postizUserId ?? metaUserId;
  if (postizUserId) linkRows.push({ label: "Postiz user", cell: idCell(postizUserId, { copy: true }) });

  const primaryOrg: PostizOrgSummary | null = postiz.orgs[0] ?? null;
  if (meta?.billing || meta?.period) {
    const planNotes: string[] = [];
    if (primaryOrg?.tier && meta?.billing && primaryOrg.tier !== meta.billing) {
      planNotes.push(`platform says ${primaryOrg.tier}`);
    }
    if (primaryOrg?.subIsLifetime) planNotes.push("lifetime deal");
    const cancels = shortDay(primaryOrg?.subCancelAt);
    if (cancels) planNotes.push(`cancels ${cancels}`);
    linkRows.push({
      label: "Postiz plan",
      cell: text([meta?.billing, meta?.period].filter(Boolean).join(" · "), planNotes.join(" · ") || undefined),
    });
  }
  if (meta?.uniqueId) {
    linkRows.push({ label: "Postiz uniqueId", cell: idCell(meta.uniqueId, { copy: true }) });
    // The platform stores that uniqueId as Subscription.identifier. A
    // disagreement means Stripe and the platform are describing different
    // subscriptions, which is worth saying out loud rather than hiding.
    if (primaryOrg?.subIdentifier && primaryOrg.subIdentifier !== meta.uniqueId) {
      linkRows.push({
        label: "Platform identifier",
        cell: text(primaryOrg.subIdentifier, "does not match the Stripe metadata"),
      });
    }
  }

  for (const org of postiz.orgs.slice(0, MAX_RAIL_ORGS)) {
    const notes = [`${org.memberCount}${org.countIsFloor ? "+" : ""} member${org.memberCount === 1 ? "" : "s"}`];
    if (org.orgDeleted) notes.push("deleted");
    if (org.customerMatches === false) notes.push("points at a different Stripe customer");
    else if (postiz.via === "uniqueId" && org.customerMatches !== true) notes.push("matched on subscription id");
    linkRows.push({ label: "Postiz org", cell: text(org.orgName || org.orgId, notes.join(" · ")) });
    linkRows.push({ label: "Postiz org ID", cell: idCell(org.orgId, { copy: true }) });
    if (org.ownerEmail) {
      const ownerNotes = [
        org.ownerRole,
        org.ownerProvider,
        org.ownerActivated === false ? "not activated" : null,
        org.ownerIsLive ? null : "inactive account",
      ].filter(Boolean) as string[];
      linkRows.push({ label: "Postiz owner", cell: text(org.ownerEmail, ownerNotes.join(" · ") || undefined) });
    }
    if (org.ownerMembershipId) {
      linkRows.push({ label: "Impersonate id", cell: idCell(org.ownerMembershipId, { copy: true }) });
    }
  }
  if (postiz.orgs.length > MAX_RAIL_ORGS) {
    linkRows.push({
      label: "More organizations",
      cell: text(`+${postiz.orgs.length - MAX_RAIL_ORGS} not shown`),
    });
  }

  // Say "no account" only about a customer that actually looks like a Postiz
  // one. A plain Stripe customer that was never a Postiz org gets no Postiz row
  // at all, rather than a "not found" implying we expected one.
  if (!postiz.orgs.length && postiz.state !== "off" && gitroom) {
    const miss =
      postiz.state === "timeout"
        ? "lookup timed out"
        : postiz.state === "error"
          ? "platform unreachable"
          : "no account found";
    linkRows.push({ label: "Postiz org", cell: text(miss) });
  }

  tabs.email.push({
    type: "kv",
    title: "Linked accounts",
    rows: linkRows.length ? linkRows : [{ label: "Discord user", cell: text("not linked") }],
  });

  // ---- rail: Email delivery (Resend suppression list) ----
  // Only the tab that shows them pays for the Resend lookups and the log read.
  if (tab === "email" && deps.emailDelivery?.enabled()) {
    tabs.email.push(await emailDeliveryCard(deps.emailDelivery, id, customer.email ?? null, postiz));
    if (deps.deliveryLog) {
      tabs.email.push(
        await deliveryLogTable(ctx, deps.deliveryLog, id, emailsOf(customer.email ?? null, postiz), filters.logcursor)
      );
    }
  }

  // ---- main: Subscriptions ----
  tabs.overview.push({
    type: "table",
    key: "subs",
    title: "Subscriptions",
    columns: [
      { key: "plan", label: "Product" },
      { key: "status", label: "Status" },
      { key: "period", label: "Next invoice" },
      { key: "id", label: "ID" },
    ],
    rows: subs.slice(0, 25).map((sub) => {
      const item = sub.items.data[0];
      const price = item?.price;
      const plan = price?.nickname ?? (typeof price?.product === "string" ? price.product : price?.id) ?? "plan";
      const per =
        price?.unit_amount != null
          ? `${ctx.stripe.formatAmount(price.unit_amount * (item?.quantity ?? 1), price.currency)}/${price.recurring?.interval ?? "?"}`
          : undefined;
      const statusBadges: Badge[] = subStatusFlags(sub);
      return {
        id: sub.id,
        ref: { page: "subscriptions.detail", params: { id: sub.id } },
        cells: [
          avatarCell("subscription", plan, { sub: per }),
          { t: "flags", badges: statusBadges },
          item?.current_period_end ? dateCell(item.current_period_end) : text("N/A"),
          idCell(sub.id, { copy: true }),
        ] as Cell[],
        // Update jumps into the change-plan flow; cancel keeps its full
        // ceremony on the subscription detail page.
        ...(sub.status !== "canceled"
          ? {
              actions: [
                {
                  key: "nav:subscriptions.update",
                  label: "Update",
                  ref: { page: "subscriptions.changeplan", params: { id: sub.id } },
                } as ActionButton,
              ],
            }
          : {}),
      };
    }),
    empty: "No subscriptions.",
    ...(subs.length > 0
      ? {
          footer: `${Math.min(subs.length, 25)} result${subs.length === 1 ? "" : "s"} · view all`,
          footerRef: { page: "subscriptions", filters: { customer: id } },
        }
      : {}),
    ...(subs.length > 25 ? { notice: `Showing 25 of ${subs.length} subscriptions.` } : {}),
  });

  // ---- main: Payments (from the lifetime-spend fetch: no extra API call) ----
  const recentCharges = chargesPage.charges.slice(0, 10);
  tabs.overview.push({
    type: "table",
    key: "charges",
    title: "Payments",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "desc", label: "Description" },
      { key: "created", label: "Date" },
      { key: "id", label: "ID" },
    ],
    rows: recentCharges.map((charge) => ({
      id: charge.id,
      ref: { page: "payments.detail", params: { id: charge.id } },
      cells: [
        amount(ctx.stripe, charge.amount, charge.currency, chargeBadge(charge)),
        text(charge.description ?? pmIntentId(charge) ?? "N/A"),
        dateCell(charge.created),
        idCell(charge.id, { copy: true }),
      ] as Cell[],
    })),
    empty: "No payments.",
    ...(recentCharges.length > 0
      ? {
          footer: `${recentCharges.length}${chargesPage.charges.length > 10 || chargesPage.hasMore ? "+" : ""} result${recentCharges.length === 1 ? "" : "s"} · view all`,
          footerRef: { page: "payments", filters: { customer: id } },
        }
      : {}),
  });

  // ---- main: Payment methods ----
  tabs.billing.push({
    type: "table",
    key: "pms",
    title: "Payment methods",
    columns: [
      { key: "method", label: "Method" },
      { key: "default", label: "Default" },
      { key: "expires", label: "Expires" },
      { key: "fingerprint", label: "Identity" },
      { key: "id", label: "ID" },
    ],
    rows: methods.slice(0, 25).map((pm) => ({
      id: pm.id,
      cells: [
        paymentMethodCell(pm),
        pm.id === defaultPm ? badgeCell("info", "Default") : text("N/A"),
        pm.type === "card" && pm.card ? text(`${pm.card.exp_month}/${pm.card.exp_year}`) : text("N/A"),
        pmFingerprintCell(pm),
        idCell(pm.id, { copy: true }),
      ] as Cell[],
      actions: [
        registryButton(ctx, {
          key: "charge.create",
          label: "Charge",
          dangerous: true,
          stepUp: true,
          params: { customerId: id, paymentMethodId: pm.id },
          inputs: [
            { type: "number", key: "amountMajor", label: "Amount (major units, e.g. 12.50)", min: 0 },
            { type: "text", key: "currency", label: "Currency (3 letters)", placeholder: customer.currency ?? "eur" },
            { type: "text", key: "description", label: "Description (optional)" },
          ],
          summary: "Charges this saved payment method OFF-SESSION immediately (no customer present). Requires a fresh factor.",
        }),
        ...(pm.id !== defaultPm
          ? [
              registryButton(ctx, {
                key: "customer.payment_method",
                label: "Set default",
                dangerous: true,
                params: { customerId: id, paymentMethodId: pm.id, op: "set_default" },
                summary: "Future invoices/renewals bill this payment method.",
              }),
            ]
          : []),
        registryButton(ctx, {
          key: "customer.payment_method",
          label: "Detach",
          dangerous: true,
          params: { customerId: id, paymentMethodId: pm.id, op: "detach" },
          summary: "Removes the payment method from this customer (it cannot be re-attached; a new one must be saved).",
        }),
      ],
    })),
    empty: "No saved payment methods.",
    ...(methods.length > 0 ? { footer: `${Math.min(methods.length, 25)} result${methods.length === 1 ? "" : "s"}` } : {}),
  });

  // ---- main: Invoices ----
  tabs.billing.push({
    type: "table",
    key: "invoices",
    title: "Invoices",
    columns: [
      { key: "total", label: "Amount" },
      { key: "number", label: "Invoice" },
      { key: "created", label: "Created" },
    ],
    rows: invoices.invoices.map((invoice) => ({
      id: invoice.id ?? "draft",
      ...(invoice.id ? { ref: { page: "invoices.detail", params: { id: invoice.id } } } : {}),
      cells: [
        amount(ctx.stripe, invoice.total, invoice.currency, invoiceBadge(invoice.status)),
        idCell(invoice.number ?? invoice.id ?? "draft", { copy: !!invoice.id }),
        dateCell(invoice.created),
      ] as Cell[],
      // State actions inline: same registry belts as the invoice
      // detail; the hybrid renderer puts the first inline, the rest in ···.
      ...(invoice.id ? { actions: invoiceRowActions(ctx, invoice) } : {}),
    })),
    empty: "No invoices.",
    ...(invoices.invoices.length > 0
      ? {
          footer: `${invoices.invoices.length}${invoices.hasMore ? "+" : ""} result${invoices.invoices.length === 1 ? "" : "s"} · view all`,
          footerRef: { page: "invoices", filters: { customer: id } },
        }
      : {}),
  });

  // ---- main: credit grants (only when any exist: Grant lives in Manage) ----
  if (creditGrants.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    const grantBadge = (g: Stripe.Billing.CreditGrant): Badge =>
      g.voided_at
        ? { kind: "error", text: "Voided" }
        : g.expires_at && g.expires_at < now
          ? { kind: "neutral", text: "Expired" }
          : { kind: "ok", text: "Active" };
    tabs.billing.push({
      type: "table",
      key: "creditgrants",
      title: "Credit grants",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "name", label: "Name" },
        { key: "category", label: "Category" },
        { key: "expires", label: "Expires" },
        { key: "id", label: "ID" },
      ],
      rows: creditGrants.slice(0, 25).map((g) => ({
        id: g.id,
        cells: [
          g.amount.monetary
            ? amount(ctx.stripe, g.amount.monetary.value, g.amount.monetary.currency, grantBadge(g))
            : text("N/A"),
          text(g.name ?? "N/A"),
          text(g.category === "paid" ? "Paid" : "Promotional"),
          g.expires_at ? dateCell(g.expires_at) : text("Never"),
          idCell(g.id, { copy: true }),
        ] as Cell[],
        actions:
          !g.voided_at && !(g.expires_at && g.expires_at < now)
            ? [
                {
                  key: "section:customers.credit_grant_void",
                  label: "Void",
                  dangerous: true,
                  params: { customerId: id, grantId: g.id },
                  summary: "Zeroes the REMAINING credit on this grant; already-applied credit stays applied.",
                },
              ]
            : [],
      })),
      footer: `${Math.min(creditGrants.length, 25)} result${creditGrants.length === 1 ? "" : "s"}`,
      notice: "Credits apply automatically against metered-usage charges on future invoices.",
    });
  }

  // ---- main: balance-transaction history (glance, not a ledger) ----
  if (balanceTxns.length > 0) {
    tabs.billing.push({
      type: "table",
      key: "balancehistory",
      title: "Balance history",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "desc", label: "Description" },
        { key: "created", label: "Date" },
        { key: "ending", label: "Ending balance", align: "right" },
      ],
      rows: balanceTxns.map((t) => ({
        id: t.id,
        cells: [
          money(ctx.stripe, t.amount, t.currency, t.amount < 0 ? "pos" : "neg"),
          text(t.description ?? sentence(t.type.replace(/_/g, " "))),
          dateCell(t.created),
          money(ctx.stripe, t.ending_balance, t.currency),
        ] as Cell[],
      })),
      footer: `${balanceTxns.length} most recent`,
      notice: "Customer credit ledger: negative = credit toward future invoices.",
    });
  }

  // ---- main: dispute mirror rows ----
  if (disputes.length > 0) {
    tabs.billing.push({
      type: "table",
      key: "disputes",
      title: "Disputes",
      columns: [
        { key: "amount", label: "Amount" },
        { key: "reason", label: "Reason" },
        { key: "opened", label: "Opened" },
        { key: "due", label: "Evidence due" },
      ],
      rows: disputes.map((d) => ({
        id: d.id,
        ref: { page: "disputes.detail", params: { id: d.id } },
        cells: [
          amount(ctx.stripe, d.amount, d.currency, {
            kind: d.status.includes("needs_response") ? "error" : d.status === "won" ? "ok" : "info",
            text: d.status.replace(/_/g, " "),
          }),
          text(d.reason),
          d.disputeCreatedAt ? isoDateCell(d.disputeCreatedAt) : text("N/A"),
          d.evidenceDueBy ? isoDateCell(d.evidenceDueBy) : text("N/A"),
        ] as Cell[],
      })),
      footer: `${disputes.length} result${disputes.length === 1 ? "" : "s"}`,
    });
  }

  // ---- main: team notes (read-only) ----
  if (notes.rows.length > 0) {
    tabs.overview.push({
      type: "timeline",
      title: `Team notes (${notes.total})`,
      items: notes.rows.map((n) => ({
        label: n.authorName,
        iso: n.createdAt.toISOString(),
        text: n.text,
        kind: "info" as const,
      })),
    });
  }

  // ---- rail: manage (act-from-customer + money surfaces + links/delete) ----
  rail.push({
    type: "kv",
    title: "Manage",
    rows: [
      {
        label: "Subscription",
        cell: { t: "link", v: "New subscription →", ref: { page: "subscriptions.new", filters: { customer: id } } } as Cell,
      },
      {
        label: "Invoice",
        cell: { t: "link", v: "New invoice →", ref: { page: "invoices.new", filters: { customer: id } } } as Cell,
      },
      {
        label: "Customer portal",
        cell: { t: "link", v: "Mint portal login link →", ref: { page: "customers.portal", params: { id } } } as Cell,
      },
    ],
    actions: [
      registryButton(ctx, {
        key: "customer.balance",
        label: "Adjust balance",
        dangerous: true,
        stepUp: true,
        params: { customerId: id },
        inputs: [
          {
            type: "select",
            key: "mode",
            label: "Direction",
            options: [
              { value: "credit", label: "Credit: customer owes less" },
              { value: "debit", label: "Debit: customer owes more" },
            ],
          },
          { type: "number", key: "amountMajor", label: "Amount (major units, e.g. 10.00)", min: 0 },
          { type: "text", key: "currency", label: "Currency (3 letters)", placeholder: customer.currency ?? "eur" },
          { type: "text", key: "note", label: "Note (optional)" },
        ],
        summary: "Adjusts the running balance applied to FUTURE invoices (credit = negative). Requires a fresh factor.",
      }),
      {
        key: "section:customers.credit_grant",
        label: "Grant credits",
        dangerous: true,
        stepUp: true,
        params: { customerId: id },
        inputs: [
          { type: "number", key: "amountMajor", label: "Amount (major units, e.g. 25.00)", min: 0 },
          { type: "text", key: "currency", label: "Currency (3 letters)", placeholder: customer.currency ?? "eur" },
          {
            type: "select",
            key: "category",
            label: "Category",
            options: [
              { value: "promotional", label: "Promotional (goodwill)" },
              { value: "paid", label: "Paid (purchased credits)" },
            ],
          },
          { type: "text", key: "name", label: "Name (optional, shown in Stripe)" },
          { type: "number", key: "expiresDays", label: "Expires in days (optional)", min: 1, max: 3650 },
        ],
        summary:
          "Grants monetary billing credits applied against METERED usage charges. Requires a fresh factor.",
      },
      {
        key: "section:customers.link",
        label: "Link Discord user",
        dangerous: true,
        params: { customerId: id },
        inputs: [{ type: "text", key: "discordUserId", label: "Discord user id (digits)" }],
        summary: "Points that Discord user's session at this Stripe customer; self-service billing then acts on it.",
      },
      {
        key: "section:customers.unlink",
        label: "Unlink Discord",
        dangerous: true,
        params: { customerId: id },
        summary: `Clears the Stripe link on every Discord user currently pointing at ${id}.`,
        ...(discordIds.length === 0 ? { disabledReason: "No Discord users are linked to this customer." } : {}),
      },
      {
        key: "section:customers.delete",
        label: "Delete customer",
        style: "danger",
        dangerous: true,
        reverseConfirm: true,
        params: { customerId: id },
        summary: `Permanently deletes ${id} in Stripe; active subscriptions are canceled and this cannot be undone. Discord links are cleared afterwards. Needs the Discord reverse code (/billing → Show destructive-action code).`,
      },
    ],
  });

  main.push(
    {
      type: "tabs",
      key: "tab",
      value: tab === "overview" ? undefined : tab,
      items: TAB_ITEMS.map((t) => ({
        value: t.value,
        label: t.label,
        ...(t.value === "billing" && disputes.length ? { badge: String(disputes.length) } : {}),
      })),
    },
    ...tabs[tab]
  );
  if (!tabs[tab].length) main.push({ type: "empty", title: "Nothing here", hint: "This customer has nothing to show on this tab." });

  return {
    title,
    crumbs: [
      { label: "Customers", ref: { page: "customers" } },
      { label: customer.email ?? customer.id, copyId: customer.id },
    ],
    blocks: main,
    rail,
  };
}


function pmIntentId(charge: Stripe.Charge): string | null {
  return typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
}

// Status-appropriate invoice lifecycle buttons for 360 rows: the same
// registry keys/params the invoice detail uses (belts enforced there).
function invoiceRowActions(ctx: DashboardCtx, invoice: Stripe.Invoice): ActionButton[] {
  const invoiceId = invoice.id!;
  if (invoice.status === "draft") {
    return [
      registryButton(ctx, {
        key: "invoice.finalize",
        label: "Finalize",
        dangerous: true,
        params: { invoiceId },
        summary: "Locks the draft and makes it open/collectible.",
      }),
      registryButton(ctx, {
        key: "invoice.void",
        label: "Delete draft",
        dangerous: true,
        params: { invoiceId, op: "delete_draft" },
        summary: "Deletes the draft permanently.",
      }),
    ];
  }
  if (invoice.status === "open") {
    return [
      registryButton(ctx, {
        key: "invoice.collect",
        label: "Send",
        dangerous: true,
        params: { invoiceId, op: "send" },
        summary: "Emails the hosted invoice to the customer.",
      }),
      registryButton(ctx, {
        key: "invoice.collect",
        label: "Collect now",
        dangerous: true,
        stepUp: true,
        params: { invoiceId, op: "pay" },
        summary: "Attempts an OFF-SESSION charge on the default payment method. Requires a fresh factor.",
      }),
      registryButton(ctx, {
        key: "invoice.void",
        label: "Void",
        dangerous: true,
        params: { invoiceId, op: "void" },
        summary: "Voids the invoice; it can no longer be paid.",
      }),
    ];
  }
  return [];
}

// ---- customer portal login link ----
// Rendering the page MINTS a fresh billing_portal session: the link is
// short-lived and single-session, so a per-view mint is the safe shape (no
// stored secret, nothing to revoke). Audited because the link grants the
// customer's self-serve billing access to whoever holds it.
async function portalLinkPage(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const customer = await ctx.stripe.getCustomer(id).catch(() => null);
  if (!customer) return notFound("This customer does not exist (or was deleted).");
  const session = await ctx.stripe.createPortalSession(id).catch(() => null);
  const blocks: Block[] = [
    {
      type: "header",
      title: "Customer portal link",
      sub: customer.name ?? customer.email ?? id,
    },
  ];
  if (!session) {
    blocks.push({
      type: "notice",
      badge: { kind: "error", text: "FAILED" },
      text: "Stripe could not create a portal session. Is the portal configured? (Operate → Customer portal.)",
    });
  } else {
    await ctx.audit(`Portal login link minted for ${id}`);
    blocks.push({
      type: "kv",
      title: "Login link",
      rows: [
        { label: "Customer", cell: idCell(id, { copy: true, ref: { page: "customers.detail", params: { id } } }) },
        { label: "Portal", cell: { t: "external", v: "Open customer portal ↗", href: session.url, copy: true } as Cell },
      ],
    });
    blocks.push({
      type: "notice",
      badge: { kind: "info", text: "Short-lived" },
      text: "The link expires a few minutes after minting and is meant for ONE hand-off: send it to the customer, don't store it. Reload this page to mint a fresh one.",
    });
  }
  return {
    title: "Customer portal link",
    crumbs: [
      { label: "Customers", ref: { page: "customers" } },
      { label: customer.email ?? id, ref: { page: "customers.detail", params: { id } } },
      { label: "Portal link" },
    ],
    blocks,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Customer not found",
    crumbs: [{ label: "Customers", ref: { page: "customers" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Customer not found", hint }],
  };
}
