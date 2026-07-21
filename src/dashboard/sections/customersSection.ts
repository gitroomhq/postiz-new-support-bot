import type Stripe from "stripe";
import { StripeClient } from "../../bot/StripeClient";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, Badge, Block, Cell, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor, validId } from "./types";
import { bookmarkButton, isBookmarkedSafe, toggleBookmarkAction } from "./bookmarks";
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
// surface — create, edit details/tax/locale/metadata, Discord↔Stripe
// link/unlink (T1) and DELETE (typed CONFIRM + Discord reverse code, then
// unlinkStripeCustomerEverywhere exactly like CustomersHub). Layout follows
// the Stripe DETAIL archetype: flat tables in the main column,
// Insights/Details/Linked accounts stacked label-over-value in the right rail.

const PAGE_SIZE = 25;

// Curated tax-ID types — the Stripe union is 100+ entries; support
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

// Parse the one-line address input: "line1 | line2 | city | state | postal |
// country(2)" — shipping prepends "name |". Blank segments are omitted; a
// lone "-" clears (Stripe Emptyable "").
function parseAddressInput(
  raw: string,
  shipping: boolean
): { ok: true; value: "" | Record<string, unknown> } | { ok: false; error: string } {
  const input = raw.trim();
  if (!input) return { ok: false, error: "Enter the address, or '-' to clear." };
  if (input === "-") return { ok: true, value: "" };
  const parts = input.split("|").map((s) => s.trim());
  const expected = shipping ? 7 : 6;
  if (parts.length > expected) return { ok: false, error: `Too many segments — expected at most ${expected} '|'-separated parts.` };
  while (parts.length < expected) parts.push("");
  const name = shipping ? parts.shift()! : null;
  if (shipping && !name) return { ok: false, error: "Shipping needs a recipient name as the first segment." };
  const [line1, line2, city, state, postal, country] = parts;
  if (!line1) return { ok: false, error: "line1 is required." };
  if (!/^[A-Za-z]{2}$/.test(country)) return { ok: false, error: "Country must be a 2-letter code (last segment)." };
  const address = {
    line1,
    ...(line2 ? { line2 } : {}),
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    ...(postal ? { postal_code: postal } : {}),
    country: country.toUpperCase(),
  };
  return { ok: true, value: shipping ? { name, address } : address };
}

// PM identity cell. Stripe exposes `fingerprint` on the types that
// carry the instrument directly (cards + bank-debit rails); only CARD
// fingerprints link into the reverse-card hunt (charges.search indexes only
// those). Wallets (Link/PayPal…) vault the card on their side and expose NO
// fingerprint — but the wallet ACCOUNT EMAIL is their stable cross-customer
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
  return WALLET_PM_TYPES.has(pm.type) ? text("—", "wallet-vaulted") : text("—");
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

export function makeCustomersSection(): DashboardSectionModule {
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
      return detail(ctx, id);
    },

    async action(ctx: DashboardCtx, req) {
      return customerAction(ctx, req.key, req.params ?? {}, req.confirmWord);
    },
  };
}

// ---- section actions (edit / create / delete / link) ----

async function customerAction(
  ctx: DashboardCtx,
  key: string,
  p: Record<string, unknown>,
  confirmWord: string | undefined
): Promise<{
  ok: boolean;
  text?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  needsReverse?: boolean;
  needsStepUp?: boolean;
}> {
  const confirmed = confirmWord === "CONFIRM";

  // T0 — shared team bookmark toggle (bookmark helper validates its own id).
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
    await ctx.audit(`Customer created — ${customer.id} (${email || name})`);
    return { ok: true, text: `Customer ${customer.id} created.` };
  }

  const customerId = validId("customer", p.customerId);
  if (!customerId) return { ok: false, error: "Bad customer id." };

  switch (key) {
    // T0 — mint an off-session SetupIntent for saving a card later. Only the
    // seti_ id is surfaced; the client_secret never leaves the server (it is
    // only useful to a Stripe.js confirm flow on the customer's device).
    case "section:customers.setup_intent": {
      const si = await ctx.stripe.createSetupIntent({ customerId }, `dash-seti-${customerId}-${Date.now().toString(36)}`);
      await ctx.audit(`SetupIntent ${si.id} created for ${customerId}`);
      return {
        ok: true,
        text: `SetupIntent ${si.id} created (${si.status}). Confirm it via Stripe.js/Elements or the API — the client secret is not shown here.`,
      };
    }

    // T0 — core details. Blank = keep as-is; a single "-" clears the field
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
      if (Object.keys(updates).length === 0) return { ok: false, error: "Nothing to change — fill at least one field ('-' clears)." };
      await ctx.stripe.updateCustomer(customerId, updates);
      await ctx.audit(`Customer ${customerId} updated — ${Object.keys(updates).join(", ")}`);
      return { ok: true, text: "Customer updated." };
    }

    // T0 — tax exemption + preferred locale.
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

    // T0 — metadata: key=value per line; a single "-" clears everything.
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
        if (!k || k.length > 40 || v.length > 500) return { ok: false, fieldErrors: { metadata: `"${k.slice(0, 40)}" — keys ≤40 chars, values ≤500.` } };
        metadata[k] = v;
      }
      if (Object.keys(metadata).length === 0) return { ok: false, error: "No key=value lines found." };
      await ctx.stripe.updateCustomer(customerId, { metadata });
      await ctx.audit(`Customer ${customerId} metadata updated — ${Object.keys(metadata).length} key(s)`);
      return { ok: true, text: `Metadata updated (${Object.keys(metadata).length} key(s)).` };
    }

    // T1 — add a tax ID (prints on every future invoice; can flip
    // reverse-charge). Type is validated against the curated set — the
    // select options are advisory only (hostile client).
    case "section:customers.tax_id_add": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const type = str(p.type, 20);
      if (!TAX_ID_TYPES.some((t) => t.value === type)) return { ok: false, fieldErrors: { type: "Pick a tax ID type." } };
      const value = str(p.value, 30).trim();
      if (!/^[A-Za-z0-9 .-]{2,30}$/.test(value)) return { ok: false, fieldErrors: { value: "2-30 chars: letters, digits, space, dot, dash." } };
      try {
        const taxId = await ctx.stripe.addTaxId(customerId, type, value);
        await ctx.audit(`Customer ${customerId}: tax ID ${taxId.id} added (${type})`);
        return { ok: true, text: `Tax ID added (${type.replace(/_/g, " ")} ${value}).` };
      } catch (e) {
        // Stripe validates per-type formats with useful messages.
        return { ok: false, fieldErrors: { value: (e as Error).message?.slice(0, 200) ?? "Stripe rejected the value." } };
      }
    }

    // T1 — remove a tax ID; live re-list proves it belongs to THIS customer.
    case "section:customers.tax_id_remove": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const taxIdId = typeof p.taxIdId === "string" && /^(txi|atxi)_[A-Za-z0-9]{1,64}$/.test(p.taxIdId) ? p.taxIdId : null;
      if (!taxIdId) return { ok: false, error: "Bad tax ID id." };
      const existing = await ctx.stripe.listTaxIds(customerId).catch(() => [] as Stripe.TaxId[]);
      if (!existing.some((t) => t.id === taxIdId)) return { ok: false, error: "That tax ID is not on this customer." };
      await ctx.stripe.removeTaxId(customerId, taxIdId);
      await ctx.audit(`Customer ${customerId}: tax ID ${taxIdId} removed`);
      return { ok: true, text: "Tax ID removed." };
    }

    // T0 — billing address as ONE structured line ('-' clears).
    case "section:customers.address_billing": {
      const parsed = parseAddressInput(str(p.address, 400), false);
      if (!parsed.ok) return { ok: false, fieldErrors: { address: parsed.error } };
      await ctx.stripe.updateCustomer(customerId, { address: parsed.value as Stripe.CustomerUpdateParams["address"] });
      await ctx.audit(`Customer ${customerId}: billing address ${parsed.value === "" ? "cleared" : "updated"}`);
      return { ok: true, text: parsed.value === "" ? "Billing address cleared." : "Billing address updated." };
    }

    // T0 — shipping (leading recipient-name segment, required by Stripe).
    case "section:customers.address_shipping": {
      const parsed = parseAddressInput(str(p.address, 400), true);
      if (!parsed.ok) return { ok: false, fieldErrors: { address: parsed.error } };
      await ctx.stripe.updateCustomer(customerId, { shipping: parsed.value as Stripe.CustomerUpdateParams["shipping"] });
      await ctx.audit(`Customer ${customerId}: shipping address ${parsed.value === "" ? "cleared" : "updated"}`);
      return { ok: true, text: parsed.value === "" ? "Shipping address cleared." : "Shipping address updated." };
    }

    // T1 + T2 — grant monetary credits against METERED usage. Money-adjacent
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
      return { ok: true, text: `Granted ${ctx.stripe.formatAmount(amountMinor, currency)} in billing credits (${grant.id}).` };
    }

    // T1 — void a grant: zeroes the REMAINING credit (applied credit stays).
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
      return { ok: true, text: `Credit grant ${grantId} voided — remaining credit is gone; already-applied credit stays.` };
    }

    // T1 — link a Discord user to this Stripe customer.
    case "section:customers.link": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const discordId = str(p.discordUserId, 32).trim();
      if (!/^\d{5,32}$/.test(discordId)) return { ok: false, fieldErrors: { discordUserId: "Discord user ids are 5-32 digits." } };
      const updated = await ctx.stores.session.updateStripeCustomerId(discordId, customerId);
      if (!updated) {
        return { ok: false, error: "That Discord user has no session row yet — they need to interact with the bot once first." };
      }
      await ctx.audit(`Linked Discord ${discordId} ↔ ${customerId}`);
      return { ok: true, text: `Linked Discord user ${discordId} to ${customerId}.` };
    }

    // T1 — clear the link on every Discord user pointing at this customer.
    case "section:customers.unlink": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const cleared = await ctx.stores.session.unlinkStripeCustomerEverywhere(customerId);
      await ctx.audit(`Unlinked ${customerId} from ${cleared} Discord user session(s)`);
      return { ok: true, text: cleared ? `Cleared the link on ${cleared} Discord user session(s).` : "No Discord users were linked." };
    }

    // T1 + T3 — delete the customer in Stripe (permanent, cancels subs),
    // then clear every Discord link — exactly the CustomersHub sequence.
    case "section:customers.delete": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true };
      await ctx.stripe.deleteCustomer(customerId);
      const unlinked = await ctx.stores.session.unlinkStripeCustomerEverywhere(customerId);
      await ctx.audit(`Customer ${customerId} DELETED in Stripe${unlinked ? ` — cleared the link on ${unlinked} Discord user session(s)` : ""}`);
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
    notice = "Search results (name/email fuzzy match) — may lag Stripe by ~1 minute.";
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
    // Search results can't take a server-side created param — cut here.
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
        strong(c.name ?? "—"),
        text(c.email ?? "—"),
        { t: "flags", badges: c.delinquent ? [{ kind: "warn", text: "Delinquent" }] : [] },
        text(c.address?.country ?? "—"),
        dateCell(c.created),
        idCell(c.id, { copy: true }),
      ] as Cell[],
    })),
    nextCursor: !q && hasMore && customers.length > 0 ? customers[customers.length - 1].id : null,
    empty: q || delinquentF || countryF || hasSubF ? "No customers match these filters (within this page)." : "No customers yet.",
    ...(n > 0 ? { footer: q ? `${n} result${n === 1 ? "" : "s"}` : `${n}${hasMore ? "+" : ""} item${n === 1 ? "" : "s"}` } : {}),
    notice:
      (notice ? `${notice} ` : "") +
      (delinquentF || countryF || hasSubF ? "Delinquent/country/subscription filters slice the fetched page — page onward for more." : "") || undefined,
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

async function detail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const customer = await ctx.stripe.getCustomer(id).catch(() => null);
  if (!customer) {
    return notFound("This customer does not exist (or was deleted).");
  }

  // Note: 12 parallel STRIPE reads is the ceiling here — consolidate
  // before adding more (every new one is .catch-guarded and independent; the
  // bookmark flag is a local DB read, not a Stripe call).
  const [subs, invoices, methods, chargesPage, disputes, blocks, discordIds, notes, creditGrants, taxIds, balanceTxns, cashBalance, bookmarked] =
    await Promise.all([
      ctx.stripe.listSubscriptions(id).catch(() => [] as Stripe.Subscription[]),
      ctx.stripe.listInvoices(id, 10).catch(() => ({ invoices: [] as Stripe.Invoice[], hasMore: false })),
      ctx.stripe.listAllPaymentMethods(id).catch(() => [] as Stripe.PaymentMethod[]),
      ctx.stripe.listCharges(id, 100).catch(() => ({ charges: [] as Stripe.Charge[], hasMore: false })),
      ctx.stores.dispute.listByCustomer(id, 10).catch(() => []),
      ctx.stores.block.listForCustomer(id, customer.email).catch(() => []),
      ctx.stores.session.findDiscordIdsByStripeId(id).catch(() => [] as string[]),
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

  const main: Block[] = [];
  const rail: Block[] = [];

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
          "Mints an off-session SetupIntent for saving a card via Stripe.js/Elements or the API. Only the seti_ id is shown — never the client secret.",
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
        `${b.kind} "${b.value}" — ${b.reason}` +
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
  rail.push({
    type: "kv",
    title: "Details",
    rows: [
      { label: "Customer ID", cell: idCell(customer.id, { copy: true }) },
      { label: "Customer since", cell: dateCell(customer.created) },
      { label: "Billing email", cell: text(customer.email ?? "—") },
      { label: "Currency", cell: text(customer.currency?.toUpperCase() ?? "—") },
      ...(customer.delinquent ? [{ label: "Delinquent", cell: badgeCell("warn", "Yes") }] : []),
      ...(customer.tax_exempt && customer.tax_exempt !== "none"
        ? [{ label: "Tax exempt", cell: text(customer.tax_exempt) }]
        : []),
      ...(customer.preferred_locales?.length
        ? [{ label: "Locale", cell: text(customer.preferred_locales.join(", ")) }]
        : []),
      {
        label: "Default payment method",
        cell: defaultPmObj ? paymentMethodCell(defaultPmObj) : defaultPm ? idCell(defaultPm, { copy: true }) : text("—"),
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
    // Inline edit (replaces the customers.edit page): the same modals,
    // with current values embedded in the labels (web modals can't prefill).
    actions: [
      {
        key: "section:customers.update",
        label: "Edit details",
        params: { customerId: id },
        inputs: [
          { type: "text", key: "name", label: `Name (now: ${customer.name ?? "—"}) — blank keeps, '-' clears` },
          { type: "text", key: "email", label: `Email (now: ${customer.email ?? "—"})` },
          { type: "text", key: "description", label: `Description (now: ${customer.description?.slice(0, 60) ?? "—"})` },
        ],
        summary: "Blank fields stay unchanged; a single '-' clears the field.",
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
          { type: "text", key: "locale", label: `Preferred locale (now: ${customer.preferred_locales?.[0] ?? "—"}) — '-' clears` },
        ],
      },
      {
        key: "section:customers.metadata",
        label: "Metadata",
        params: { customerId: id },
        inputs: [
          { type: "text", key: "metadata", label: "key=value per line — '-' alone clears ALL metadata", multiline: true, maxLength: 2000 },
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
              summary: "Removes the CUSTOMER-level discount — every future invoice bills full price.",
            }),
          ]
        : []),
    ],
  });

  // ---- rail: Metadata (moved from the removed edit page) ----
  const metaEntries = Object.entries(customer.metadata ?? {});
  if (metaEntries.length > 0) {
    rail.push({
      type: "kv",
      title: `Metadata (${metaEntries.length})`,
      rows: metaEntries.slice(0, 20).map(([k, v]) => ({ label: k, cell: text(String(v).slice(0, 120)) })),
    });
  }

  // ---- rail: Tax IDs (print on every invoice → both actions T1) ----
  rail.push({
    type: "kv",
    title: taxIds.length ? `Tax IDs (${taxIds.length})` : "Tax IDs",
    rows: taxIds.length
      ? taxIds.slice(0, 10).map((t) => ({
          label: sentence(t.type.replace(/_/g, " ")),
          cell: text(t.value, t.verification?.status ? sentence(t.verification.status) : undefined),
        }))
      : [{ label: "Tax ID", cell: text("none") }],
    actions: [
      {
        key: "section:customers.tax_id_add",
        label: "Add tax ID",
        dangerous: true,
        params: { customerId: id },
        inputs: [
          { type: "select", key: "type", label: "Type", options: TAX_ID_TYPES },
          { type: "text", key: "value", label: "Value (e.g. DE123456789)", maxLength: 30 },
        ],
        summary: "Prints on every future invoice and can flip reverse-charge treatment.",
      },
      ...(taxIds.length
        ? [
            {
              key: "section:customers.tax_id_remove",
              label: "Remove tax ID",
              dangerous: true,
              params: { customerId: id },
              inputs: [
                {
                  type: "select" as const,
                  key: "taxIdId",
                  label: "Tax ID",
                  options: taxIds.slice(0, 25).map((t) => ({ value: t.id, label: `${t.type.replace(/_/g, " ")} — ${t.value}` })),
                },
              ],
              summary: "Removes the tax ID from future invoices (already-issued invoices keep it).",
            },
          ]
        : []),
    ],
  });

  // ---- rail: Addresses ----
  const billAddr = fmtAddress(customer.address);
  const shipAddr = fmtAddress(customer.shipping?.address ?? null);
  rail.push({
    type: "kv",
    title: "Addresses",
    rows: [
      { label: "Billing", cell: text(billAddr ?? "—") },
      { label: "Shipping", cell: text(shipAddr ?? "—", customer.shipping?.name ?? undefined) },
    ],
    actions: [
      {
        key: "section:customers.address_billing",
        label: "Edit billing address",
        params: { customerId: id },
        inputs: [
          {
            type: "text",
            key: "address",
            label: "line1 | line2 | city | state | postal | country(2) — '-' clears",
            multiline: true,
            maxLength: 400,
          },
        ],
        summary: "Blank segments are omitted; line1 + 2-letter country are required.",
      },
      {
        key: "section:customers.address_shipping",
        label: "Edit shipping address",
        params: { customerId: id },
        inputs: [
          {
            type: "text",
            key: "address",
            label: "name | line1 | line2 | city | state | postal | country(2) — '-' clears",
            multiline: true,
            maxLength: 400,
          },
        ],
        summary: "The leading segment is the recipient name (required by Stripe).",
      },
    ],
  });

  // ---- rail: Linked accounts (Discord / Postiz) ----
  const linkRows: Array<{ label: string; cell: Cell }> = [];
  for (const discordId of discordIds.slice(0, 5)) {
    linkRows.push({ label: "Discord user", cell: idCell(discordId, { copy: true }) });
    const session = await ctx.stores.session.getSession(discordId).catch(() => null);
    if (session?.postizUserId) {
      linkRows.push({ label: "Postiz user", cell: idCell(session.postizUserId, { copy: true }) });
    }
  }
  rail.push({
    type: "kv",
    title: "Linked accounts",
    rows: linkRows.length ? linkRows : [{ label: "Discord user", cell: text("not linked") }],
  });

  // ---- main: Subscriptions ----
  main.push({
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
          item?.current_period_end ? dateCell(item.current_period_end) : text("—"),
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
          footer: `${Math.min(subs.length, 25)} result${subs.length === 1 ? "" : "s"} — view all`,
          footerRef: { page: "subscriptions", filters: { customer: id } },
        }
      : {}),
    ...(subs.length > 25 ? { notice: `Showing 25 of ${subs.length} subscriptions.` } : {}),
  });

  // ---- main: Payments (from the lifetime-spend fetch — no extra API call) ----
  const recentCharges = chargesPage.charges.slice(0, 10);
  main.push({
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
        text(charge.description ?? pmIntentId(charge) ?? "—"),
        dateCell(charge.created),
        idCell(charge.id, { copy: true }),
      ] as Cell[],
    })),
    empty: "No payments.",
    ...(recentCharges.length > 0
      ? {
          footer: `${recentCharges.length}${chargesPage.charges.length > 10 || chargesPage.hasMore ? "+" : ""} result${recentCharges.length === 1 ? "" : "s"} — view all`,
          footerRef: { page: "payments", filters: { customer: id } },
        }
      : {}),
  });

  // ---- main: Payment methods ----
  main.push({
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
        pm.id === defaultPm ? badgeCell("info", "Default") : text("—"),
        pm.type === "card" && pm.card ? text(`${pm.card.exp_month}/${pm.card.exp_year}`) : text("—"),
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
          summary: "Removes the payment method from this customer (it cannot be re-attached — a new one must be saved).",
        }),
      ],
    })),
    empty: "No saved payment methods.",
    ...(methods.length > 0 ? { footer: `${Math.min(methods.length, 25)} result${methods.length === 1 ? "" : "s"}` } : {}),
  });

  // ---- main: Invoices ----
  main.push({
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
          footer: `${invoices.invoices.length}${invoices.hasMore ? "+" : ""} result${invoices.invoices.length === 1 ? "" : "s"} — view all`,
          footerRef: { page: "invoices", filters: { customer: id } },
        }
      : {}),
  });

  // ---- main: credit grants (only when any exist — Grant lives in Manage) ----
  if (creditGrants.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    const grantBadge = (g: Stripe.Billing.CreditGrant): Badge =>
      g.voided_at
        ? { kind: "error", text: "Voided" }
        : g.expires_at && g.expires_at < now
          ? { kind: "neutral", text: "Expired" }
          : { kind: "ok", text: "Active" };
    main.push({
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
            : text("—"),
          text(g.name ?? "—"),
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
                  summary: "Zeroes the REMAINING credit on this grant — already-applied credit stays applied.",
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
    main.push({
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
      notice: "Customer credit ledger — negative = credit toward future invoices.",
    });
  }

  // ---- main: dispute mirror rows ----
  if (disputes.length > 0) {
    main.push({
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
          d.disputeCreatedAt ? isoDateCell(d.disputeCreatedAt) : text("—"),
          d.evidenceDueBy ? isoDateCell(d.evidenceDueBy) : text("—"),
        ] as Cell[],
      })),
      footer: `${disputes.length} result${disputes.length === 1 ? "" : "s"}`,
    });
  }

  // ---- main: team notes (read-only) ----
  if (notes.rows.length > 0) {
    main.push({
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
              { value: "credit", label: "Credit — customer owes less" },
              { value: "debit", label: "Debit — customer owes more" },
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
        summary: "Points that Discord user's session at this Stripe customer — self-service billing then acts on it.",
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
        summary: `Permanently deletes ${id} in Stripe — active subscriptions are canceled and this cannot be undone. Discord links are cleared afterwards. Needs the Discord reverse code (/billing → Show destructive-action code).`,
      },
    ],
  });

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

// Status-appropriate invoice lifecycle buttons for 360 rows — the same
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
        summary: "Voids the invoice — it can no longer be paid.",
      }),
    ];
  }
  return [];
}

// ---- customer portal login link ----
// Rendering the page MINTS a fresh billing_portal session — the link is
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
      text: "Stripe could not create a portal session — is the portal configured? (Operate → Customer portal.)",
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
      text: "The link expires a few minutes after minting and is meant for ONE hand-off — send it to the customer, don't store it. Reload this page to mint a fresh one.",
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
