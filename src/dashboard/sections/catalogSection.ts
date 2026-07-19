import type Stripe from "stripe";
import { StripeClient } from "../../bot/StripeClient";
import { promoCoupon, promoCouponId } from "../../bot/billing/ui";
import { ActionButton, ActionResult, Badge, Block, Cell, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor } from "./types";
import { avatarCell, badgeCell, dateCell, formatPerCurrency, idCell, text } from "./cells";

// Product catalog (#/catalog): Products & prices read-only (PromosHub-parity
// actions live on the Coupons / Promo codes tabs — list/check/create/toggle
// promo, list/create/delete coupon). Stripe promotion codes can't be edited
// or deleted — only deactivated; coupons CAN be deleted (T1 CONFIRM).

const PRODUCT_ID_RE = /^prod_[A-Za-z0-9]{1,64}$/;

export function makeCatalogSection(): DashboardSectionModule {
  return {
    nav: [{ key: "catalog", label: "Product catalog", page: "catalog" }],

    ownsPage(page: string): boolean {
      return page === "catalog" || page === "catalog.detail";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "catalog.detail") {
        const id = typeof req.params?.id === "string" && PRODUCT_ID_RE.test(req.params.id) ? req.params.id : null;
        if (!id) return notFound("That product id is not valid (prod_…).");
        return productDetail(ctx, id);
      }
      const filters = req.filters ?? {};
      const view =
        filters.view === "coupons" || filters.view === "promos" || filters.view === "tax" ? filters.view : "";
      const blocks: Block[] = [];
      blocks.push({
        type: "tabs",
        key: "view",
        value: view || undefined,
        items: [
          { value: "", label: "Products & prices" },
          { value: "coupons", label: "Coupons" },
          { value: "promos", label: "Promo codes" },
          { value: "tax", label: "Tax rates" },
        ],
      });
      if (view === "coupons") blocks.push(...(await couponsBlocks(ctx)));
      else if (view === "promos") blocks.push(...(await promosBlocks(ctx, filters)));
      else if (view === "tax") blocks.push(...(await taxBlocks(ctx)));
      else blocks.push(await productsTable(ctx, req.cursor ?? null));
      return { title: "Product catalog", crumbs: [{ label: "Product catalog" }], blocks };
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const p = req.params ?? {};
      const confirmed = req.confirmWord === "CONFIRM";
      switch (req.key) {
        // T0 (promos tier) — create a coupon. Same validation as the hub modal.
        case "section:catalog.coupon_create": {
          const id = str(p.id, 60).trim();
          const name = str(p.name, 100).trim();
          const percentRaw = str(p.percentOff, 10).trim();
          const amountRaw = str(p.amountOff, 30).trim();
          const durationRaw = (str(p.duration, 20).trim().toLowerCase() || "once");
          if ((percentRaw === "") === (amountRaw === "")) {
            return { ok: false, error: "Fill exactly one of percent off or amount off." };
          }
          const percentOff = percentRaw ? Number.parseFloat(percentRaw) : undefined;
          if (percentRaw && (!/^\d+(\.\d+)?$/.test(percentRaw) || percentOff! <= 0 || percentOff! > 100)) {
            return { ok: false, fieldErrors: { percentOff: "Percent off must be a number between 0 and 100." } };
          }
          const amountMatch = amountRaw ? amountRaw.match(/^(\d+(?:\.\d{1,2})?)\s+([a-zA-Z]{3})$/) : null;
          if (amountRaw && !amountMatch) {
            return { ok: false, fieldErrors: { amountOff: "Amount off must look like `12.50 eur` (amount + currency)." } };
          }
          const durationMatch = durationRaw.match(/^(once|forever|repeating)(?::(\d+))?$/);
          if (!durationMatch || (durationMatch[1] === "repeating" && !durationMatch[2])) {
            return { ok: false, fieldErrors: { duration: "Duration must be once, forever, or repeating:N (N months)." } };
          }
          let amountOffMinor: number | undefined;
          let currency: string | undefined;
          if (amountMatch) {
            currency = amountMatch[2].toLowerCase();
            const value = Number.parseFloat(amountMatch[1]);
            if (StripeClient.isZeroDecimal(currency) && amountMatch[1].includes(".")) {
              return { ok: false, fieldErrors: { amountOff: `${currency} is a zero-decimal currency — whole amounts only.` } };
            }
            amountOffMinor = StripeClient.isZeroDecimal(currency) ? Math.round(value) : Math.round(value * 100);
          }
          // Restrictions (all optional): redemption cap, last-redeemable date,
          // and a product scope.
          const maxRedemptions =
            typeof p.maxRedemptions === "number" && Number.isSafeInteger(p.maxRedemptions) && p.maxRedemptions > 0
              ? p.maxRedemptions
              : undefined;
          const redeemByDays =
            typeof p.redeemByDays === "number" && Number.isSafeInteger(p.redeemByDays) && p.redeemByDays > 0
              ? p.redeemByDays
              : undefined;
          const appliesRaw = str(p.appliesTo, 400).trim();
          let appliesToProducts: string[] | undefined;
          if (appliesRaw) {
            const parts = appliesRaw.split(/[,\s]+/).filter(Boolean);
            if (parts.length > 20 || parts.some((prod) => !PRODUCT_ID_RE.test(prod))) {
              return { ok: false, fieldErrors: { appliesTo: "Product ids (prod_…), comma-separated, max 20." } };
            }
            appliesToProducts = parts;
          }
          const coupon = await ctx.stripe.createCoupon(
            {
              id: id || undefined,
              name: name || undefined,
              percentOff,
              amountOffMinor,
              currency,
              duration: durationMatch[1] as "once" | "forever" | "repeating",
              durationInMonths: durationMatch[2] ? Number.parseInt(durationMatch[2], 10) : undefined,
              maxRedemptions,
              redeemByUnix: redeemByDays ? Math.floor(Date.now() / 1000) + redeemByDays * 86400 : undefined,
              appliesToProducts,
            },
            `dash-coupon-${Date.now().toString(36)}`
          );
          await ctx.audit(`Coupon ${coupon.id} created — ${describeCoupon(ctx.stripe, coupon)} · ${coupon.duration}`);
          return { ok: true, text: `Coupon ${coupon.id} created.` };
        }

        // T1 — delete a coupon (existing redemptions keep their discount).
        case "section:catalog.coupon_delete": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const id = str(p.id, 60).trim();
          if (!id) return { ok: false, error: "Bad coupon id." };
          await ctx.stripe.deleteCoupon(id);
          await ctx.audit(`Coupon ${id} deleted`);
          return { ok: true, text: `Coupon ${id} deleted.` };
        }

        // T0 — create a promotion code on a coupon (+ optional restrictions:
        // minimum order amount, first-purchase-only, single-customer scope).
        case "section:catalog.promo_create": {
          const coupon = str(p.coupon, 60).trim();
          const code = str(p.code, 60).trim();
          const maxRedemptionsRaw = str(p.maxRedemptions, 10).trim();
          const expiresDaysRaw = str(p.expiresDays, 6).trim();
          if (!coupon) return { ok: false, fieldErrors: { coupon: "A coupon ID is required." } };
          if ((maxRedemptionsRaw && !/^\d+$/.test(maxRedemptionsRaw)) || (expiresDaysRaw && !/^\d+$/.test(expiresDaysRaw))) {
            return { ok: false, error: "Max redemptions and expiry days must be whole numbers." };
          }
          const minAmountRaw = str(p.minimumAmount, 30).trim();
          let minimumAmountMinor: number | undefined;
          let minimumAmountCurrency: string | undefined;
          if (minAmountRaw) {
            const m = minAmountRaw.match(/^(\d+(?:\.\d{1,2})?)\s+([a-zA-Z]{3})$/);
            if (!m) {
              return { ok: false, fieldErrors: { minimumAmount: "Minimum amount must look like `25.00 eur` (amount + currency)." } };
            }
            minimumAmountCurrency = m[2].toLowerCase();
            const value = Number.parseFloat(m[1]);
            if (StripeClient.isZeroDecimal(minimumAmountCurrency) && m[1].includes(".")) {
              return { ok: false, fieldErrors: { minimumAmount: `${minimumAmountCurrency} is a zero-decimal currency — whole amounts only.` } };
            }
            minimumAmountMinor = StripeClient.isZeroDecimal(minimumAmountCurrency) ? Math.round(value) : Math.round(value * 100);
          }
          const customerRaw = str(p.customer, 80).trim();
          if (customerRaw && !/^cus_[A-Za-z0-9]{1,64}$/.test(customerRaw)) {
            return { ok: false, fieldErrors: { customer: "Customer must be a cus_… id (or empty for everyone)." } };
          }
          const promo = await ctx.stripe.createPromotionCode(
            {
              coupon,
              code: code || undefined,
              maxRedemptions: maxRedemptionsRaw ? Number.parseInt(maxRedemptionsRaw, 10) : undefined,
              expiresAt: expiresDaysRaw ? Math.floor(Date.now() / 1000) + Number.parseInt(expiresDaysRaw, 10) * 86400 : undefined,
              minimumAmountMinor,
              minimumAmountCurrency,
              firstTimeTransaction: p.firstTime === true,
              customerId: customerRaw || undefined,
            },
            `dash-promo-${Date.now().toString(36)}`
          );
          await ctx.audit(`Promo code ${promo.code} (${promo.id}) created on coupon ${coupon}`);
          return { ok: true, text: `Promo code ${promo.code} created.` };
        }

        // T0 — create a tax rate (PA-7a). Tax rates can't be deleted, only
        // archived, so creation is the whole write surface besides the toggle.
        case "section:catalog.tax_create": {
          const displayName = str(p.displayName, 50).trim();
          const percentageRaw = str(p.percentage, 10).trim();
          const country = str(p.country, 2).trim().toUpperCase();
          const description = str(p.description, 100).trim();
          if (!displayName) return { ok: false, fieldErrors: { displayName: "A display name is required (shown on invoices)." } };
          const percentage = Number.parseFloat(percentageRaw);
          if (!/^\d+(\.\d{1,4})?$/.test(percentageRaw) || !(percentage > 0) || percentage > 100) {
            return { ok: false, fieldErrors: { percentage: "Percentage must be a number between 0 and 100 (e.g. 19 or 7.7)." } };
          }
          if (country && !/^[A-Z]{2}$/.test(country)) {
            return { ok: false, fieldErrors: { country: "Country must be a 2-letter code (e.g. DE) — or empty." } };
          }
          const rate = await ctx.stripe.createTaxRate(
            {
              displayName,
              percentage,
              inclusive: p.inclusive === true,
              country: country || undefined,
              description: description || undefined,
            },
            `dash-taxrate-${Date.now().toString(36)}`
          );
          await ctx.audit(`Tax rate ${rate.id} created — ${displayName} ${percentage}% (${rate.inclusive ? "inclusive" : "exclusive"})`);
          return { ok: true, text: `Tax rate ${rate.id} created.` };
        }

        // T0 — archive/restore a tax rate (delete does not exist).
        case "section:catalog.tax_toggle": {
          const id = str(p.id, 64).trim();
          if (!/^txr_[A-Za-z0-9]{1,64}$/.test(id)) return { ok: false, error: "Bad tax rate id." };
          const rate = await ctx.stripe.setTaxRateActive(id, p.active === true);
          await ctx.audit(`Tax rate ${id} ${rate.active ? "restored" : "archived"}`);
          return { ok: true, text: `${rate.display_name} is now ${rate.active ? "active" : "archived"}.` };
        }

        // T0 — toggle a promotion code (Stripe can't edit/delete promos).
        case "section:catalog.promo_toggle": {
          const id = str(p.id, 64).trim();
          const active = p.active === true;
          if (!/^promo_[A-Za-z0-9]{1,64}$/.test(id)) return { ok: false, error: "Bad promo code id." };
          const promo = await ctx.stripe.setPromotionCodeActive(id, active);
          await ctx.audit(`Promo code ${promo.code} ${promo.active ? "reactivated" : "deactivated"}`);
          return { ok: true, text: `${promo.code} is now ${promo.active ? "active" : "inactive"}.` };
        }

        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

function describeCoupon(stripe: { formatAmount(a: number, c: string): string }, c: Stripe.Coupon): string {
  return c.percent_off != null
    ? `${c.percent_off}% off`
    : c.amount_off != null
      ? `${stripe.formatAmount(c.amount_off, c.currency ?? "usd")} off`
      : "—";
}

function priceLabel(stripe: { formatAmount(a: number, c: string): string }, price: Stripe.Price | null): string {
  if (!price || price.unit_amount == null) return "—";
  const base = stripe.formatAmount(price.unit_amount, price.currency);
  if (!price.recurring) return base;
  const n = price.recurring.interval_count || 1;
  return `${base} / ${n > 1 ? `${n} ` : ""}${price.recurring.interval}${n > 1 ? "s" : ""}`;
}

// ---- Products & prices (read-only) ----

async function productsTable(ctx: DashboardCtx, cursor: string | null): Promise<Block> {
  const startingAfter = validCursor(cursor) ?? undefined;
  const [{ products, hasMore }, allPrices] = await Promise.all([
    ctx.stripe.listProducts({ limit: 25, startingAfter }),
    ctx.stripe.listAllActivePrices(100).catch(() => [] as Stripe.Price[]),
  ]);
  // Group prices by product so the list shows a real price even when a product
  // has no default_price set (+ "N prices" when there's more than one).
  const pricesByProduct = new Map<string, Stripe.Price[]>();
  for (const p of allPrices) {
    const pid = typeof p.product === "string" ? p.product : p.product?.id;
    if (!pid) continue;
    const bucket = pricesByProduct.get(pid);
    if (bucket) bucket.push(p);
    else pricesByProduct.set(pid, [p]);
  }
  const rows = products.map((prod) => {
    const dflt = prod.default_price && typeof prod.default_price !== "string" ? (prod.default_price as Stripe.Price) : null;
    const grouped = pricesByProduct.get(prod.id) ?? [];
    const shown = dflt ?? grouped[0] ?? null;
    const count = grouped.length || (dflt ? 1 : 0);
    const label = shown ? `${priceLabel(ctx.stripe, shown)}${count > 1 ? ` · ${count} prices` : ""}` : "No price";
    return {
      id: prod.id,
      ref: { page: "catalog.detail", params: { id: prod.id } },
      cells: [
        avatarCell("product", prod.name, { sub: prod.description?.slice(0, 80) }),
        text(label),
        badgeCell(prod.active ? "ok" : "neutral", prod.active ? "Active" : "Archived"),
        dateCell(prod.created),
        idCell(prod.id, { copy: true }),
      ] as Cell[],
    };
  });
  return {
    type: "table",
    key: "products",
    columns: [
      { key: "name", label: "Name" },
      { key: "price", label: "Pricing" },
      { key: "status", label: "" },
      { key: "created", label: "Created" },
      { key: "id", label: "ID" },
    ],
    rows,
    nextCursor: hasMore && products.length ? products[products.length - 1].id : null,
    empty: "No products yet.",
    ...(rows.length ? { footer: `${rows.length} product${rows.length === 1 ? "" : "s"}` } : {}),
    notice: "Read-only — create and edit products in the Stripe Dashboard.",
  };
}

async function productDetail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  let product: Stripe.Product | null = null;
  try {
    product = await ctx.stripe.getProduct(id);
  } catch (e) {
    if ((e as Stripe.errors.StripeError).code === "resource_missing") {
      return notFound("This product no longer exists at Stripe.");
    }
    throw e;
  }
  const [prices, subCounts] = await Promise.all([
    ctx.stripe.listPricesForProduct(id, 50),
    ctx.stripe.countActiveSubscriptionsByPrice(10).catch(() => ({ counts: new Map<string, number>(), scanned: 0, truncated: false })),
  ]);
  const name = product.name ?? id;

  // MRR + active-subscription totals for this product, from the (single) active-sub sweep.
  const mrrByCur = new Map<string, number>();
  let activeSubs = 0;
  for (const price of prices) {
    const cnt = subCounts.counts.get(price.id) ?? 0;
    activeSubs += cnt;
    if (!cnt || !price.recurring || price.unit_amount == null) continue;
    const n = price.recurring.interval_count || 1;
    const per = price.unit_amount * cnt;
    const monthly =
      price.recurring.interval === "month"
        ? per / n
        : price.recurring.interval === "year"
          ? per / (12 * n)
          : price.recurring.interval === "week"
            ? (per * 52) / (12 * n)
            : price.recurring.interval === "day"
              ? (per * 365) / (12 * n)
              : 0;
    if (monthly > 0) mrrByCur.set(price.currency, (mrrByCur.get(price.currency) ?? 0) + Math.round(monthly));
  }

  const main: Block[] = [];
  const rail: Block[] = [];
  main.push({
    type: "header",
    title: name,
    ...(product.description ? { sub: product.description.slice(0, 200) } : {}),
    id,
    badges: [{ kind: product.active ? "ok" : "neutral", text: product.active ? "Active" : "Archived" } as Badge],
  });
  main.push({
    type: "table",
    key: "prices",
    title: `Prices (${prices.length})`,
    columns: [
      { key: "price", label: "Price" },
      { key: "type", label: "Type" },
      { key: "subs", label: "Subscriptions" },
      { key: "status", label: "" },
      { key: "id", label: "ID" },
    ],
    rows: prices.map((price) => {
      const cnt = subCounts.counts.get(price.id) ?? 0;
      return {
        id: price.id,
        cells: [
          text(priceLabel(ctx.stripe, price), price.nickname ?? undefined),
          text(price.recurring ? `Recurring (${price.recurring.interval})` : "One-time"),
          text(cnt ? `${cnt} active` : "—"),
          badgeCell(price.active ? "ok" : "neutral", price.active ? "Active" : "Archived"),
          idCell(price.id, { copy: true }),
        ] as Cell[],
      };
    }),
    empty: "No prices on this product.",
    notice: `Read-only — subscriptions pick these prices in the change-plan flow.${subCounts.truncated ? " Subscription counts are approximate (sweep truncated)." : ""}`,
  });

  // Rail: Insights (MRR) / Details / Metadata.
  rail.push({
    type: "kv",
    title: "Insights",
    big: true,
    rows: [
      { label: "MRR", cell: text(formatPerCurrency(ctx.stripe, mrrByCur)) },
      { label: "Active subscriptions", cell: text(String(activeSubs)) },
      { label: "Prices", cell: text(String(prices.length)) },
    ],
  });
  rail.push({
    type: "kv",
    title: "Details",
    rows: [
      { label: "Product ID", cell: idCell(id, { copy: true }) },
      { label: "Status", cell: badgeCell(product.active ? "ok" : "neutral", product.active ? "Active" : "Archived") },
      { label: "Created", cell: dateCell(product.created) },
      ...(product.unit_label ? [{ label: "Unit label", cell: text(product.unit_label) }] : []),
      ...(typeof product.statement_descriptor === "string" && product.statement_descriptor
        ? [{ label: "Statement descriptor", cell: text(product.statement_descriptor) }]
        : []),
      ...(typeof product.tax_code === "string" && product.tax_code
        ? [{ label: "Tax code", cell: text(product.tax_code) }]
        : []),
      ...(product.description ? [{ label: "Description", cell: text(product.description) }] : []),
    ],
  });
  const productMeta = Object.entries(product.metadata ?? {});
  rail.push({
    type: "kv",
    title: "Metadata",
    rows: productMeta.length
      ? productMeta.slice(0, 15).map(([k, v]) => ({ label: k, cell: text(String(v).slice(0, 200)) }))
      : [{ label: "Metadata", cell: text("No metadata") }],
  });

  return {
    title: name,
    crumbs: [{ label: "Product catalog", ref: { page: "catalog" } }, { label: id, copyId: id }],
    blocks: main,
    rail,
  };
}

// ---- Coupons ----

async function couponsBlocks(ctx: DashboardCtx): Promise<Block[]> {
  const coupons = await ctx.stripe.listCoupons(25);
  const table: TableBlock = {
    type: "table",
    key: "coupons",
    title: "Coupons",
    columns: [
      { key: "id", label: "Coupon" },
      { key: "discount", label: "Discount" },
      { key: "duration", label: "Duration" },
      { key: "redeemed", label: "Redeemed", align: "right" },
      { key: "valid", label: "" },
    ],
    rows: coupons.map((c) => ({
      id: c.id,
      cells: [
        { t: "text", v: c.id, strong: true, ...(c.name ? { sub: c.name } : {}) } as Cell,
        text(describeCoupon(ctx.stripe, c)),
        text(`${c.duration}${c.duration_in_months ? ` (${c.duration_in_months}m)` : ""}`),
        text(String(c.times_redeemed)),
        badgeCell(c.valid ? "ok" : "error", c.valid ? "Valid" : "Invalid"),
      ] as Cell[],
      actions: [
        {
          key: "section:catalog.coupon_delete",
          label: "Delete",
          dangerous: true,
          params: { id: c.id },
          summary: `Delete coupon ${c.id}? New promo codes can't use it anymore. Customers who already have it applied keep their discount.`,
        },
      ],
    })),
    empty: "No coupons exist yet.",
    ...(coupons.length ? { footer: `${coupons.length} most recent coupons` } : {}),
    notice: "Coupons CAN be deleted; the promo codes on top of them can only be deactivated.",
  };
  const create: Block = {
    type: "notice",
    badge: { kind: "info", text: "Create" },
    text: "Coupons are the discounts; promo codes are the customer-facing codes that apply them.",
    actions: [
      {
        key: "section:catalog.coupon_create",
        label: "New coupon",
        style: "primary",
        inputs: [
          { type: "text", key: "id", label: "Coupon ID (empty = auto-generate)" },
          { type: "text", key: "name", label: "Display name (shown on invoices)" },
          { type: "text", key: "percentOff", label: "Percent off (fill this OR amount)" },
          { type: "text", key: "amountOff", label: "Amount off + currency (e.g. 12.50 eur)" },
          { type: "text", key: "duration", label: "Duration: once / forever / repeating:N", placeholder: "default: once" },
          { type: "number", key: "maxRedemptions", label: "Max redemptions (empty = unlimited)", min: 1 },
          { type: "number", key: "redeemByDays", label: "Redeemable for N days (empty = forever)", min: 1 },
          { type: "text", key: "appliesTo", label: "Only for products (prod_…, comma-separated; empty = all)" },
        ],
        summary: "Creates the coupon promo codes can apply.",
      },
    ],
  };
  return [table, create];
}

// ---- Promo codes (list + check + create + toggle) ----

async function promosBlocks(ctx: DashboardCtx, filters: Record<string, string>): Promise<Block[]> {
  const checkQuery = str(filters.code, 60).replace(/["\\]/g, "").trim();
  const blocks: Block[] = [];

  // Check-a-code: detailed validity verdict for matches (hub parity).
  if (checkQuery) {
    const promos = checkQuery.startsWith("promo_")
      ? [await ctx.stripe.getPromotionCode(checkQuery).catch(() => null)].filter((p): p is Stripe.PromotionCode => p != null)
      : await ctx.stripe.findPromotionCodes(checkQuery);
    if (promos.length === 0) {
      blocks.push({ type: "notice", badge: { kind: "warn", text: "No match" }, text: `No promotion code matching "${checkQuery}".` });
    }
    for (const promo of promos.slice(0, 3)) {
      blocks.push(promoVerdictKv(ctx, promo));
    }
  }

  const promos = await ctx.stripe.listPromotionCodes(25);
  const createButton: ActionButton = {
    key: "section:catalog.promo_create",
    label: "New promo code",
    style: "primary",
    inputs: [
      { type: "text", key: "coupon", label: "Coupon ID the code applies" },
      { type: "text", key: "code", label: "Code (empty = auto-generate)" },
      { type: "number", key: "maxRedemptions", label: "Max redemptions (empty = unlimited)", min: 1 },
      { type: "number", key: "expiresDays", label: "Expires in days (empty = never)", min: 1 },
      { type: "text", key: "minimumAmount", label: "Minimum order amount (e.g. 25.00 eur; empty = none)" },
      { type: "toggle", key: "firstTime", label: "First purchase only" },
      { type: "text", key: "customer", label: "Restrict to customer (cus_…; empty = everyone)" },
    ],
    summary: "Creates a customer-facing code on an existing coupon.",
  };
  const table: TableBlock = {
    type: "table",
    key: "promos",
    title: "Promotion codes",
    filters: [
      { key: "code", label: "Check a code", kind: "search", value: checkQuery || undefined, placeholder: "Check a code or promo_… id — full validity verdict" },
    ],
    columns: [
      { key: "code", label: "Code" },
      { key: "coupon", label: "Coupon" },
      { key: "uses", label: "Uses", align: "right" },
      { key: "expires", label: "Expires" },
      { key: "status", label: "" },
    ],
    rows: promos.map((p) => {
      const couponId = promoCouponId(p);
      return {
        id: p.id,
        cells: [
          { t: "text", v: p.code, strong: true, sub: p.id } as Cell,
          text(couponId),
          text(`${p.times_redeemed}/${p.max_redemptions ?? "∞"}`),
          p.expires_at ? dateCell(p.expires_at) : text("never"),
          badgeCell(p.active ? "ok" : "neutral", p.active ? "Active" : "Inactive"),
        ] as Cell[],
        actions: [
          p.active
            ? { key: "section:catalog.promo_toggle", label: "Deactivate", params: { id: p.id, active: false } }
            : { key: "section:catalog.promo_toggle", label: "Reactivate", params: { id: p.id, active: true } },
        ],
      };
    }),
    empty: "No promotion codes exist yet.",
    ...(promos.length ? { footer: `${promos.length} most recent codes` } : {}),
    notice: "Promotion codes can't be edited or deleted — deactivate and create a replacement.",
  };
  blocks.push(table);
  // Creation buttons ride a notice bar (the page header belongs to the tabs).
  blocks.push({
    type: "notice",
    badge: { kind: "info", text: "Create" },
    text: "New codes apply an existing coupon — create the coupon first on the Coupons tab.",
    actions: [createButton],
  });
  return blocks;
}

// ---- Tax rates (PA-7a: list + create + archive/restore) ----

async function taxBlocks(ctx: DashboardCtx): Promise<Block[]> {
  const rates = await ctx.stripe.listTaxRates(25).catch(() => [] as Stripe.TaxRate[]);
  const table: TableBlock = {
    type: "table",
    key: "taxrates",
    title: "Tax rates",
    columns: [
      { key: "name", label: "Name" },
      { key: "rate", label: "Rate", align: "right" },
      { key: "region", label: "Region" },
      { key: "status", label: "" },
      { key: "id", label: "ID" },
    ],
    rows: rates.map((r) => ({
      id: r.id,
      cells: [
        { t: "text", v: r.display_name, strong: true, ...(r.description ? { sub: r.description } : {}) } as Cell,
        text(`${r.percentage}% ${r.inclusive ? "incl." : "excl."}`),
        text(r.country ?? "—"),
        badgeCell(r.active ? "ok" : "neutral", r.active ? "Active" : "Archived"),
        idCell(r.id, { copy: true }),
      ] as Cell[],
      actions: [
        r.active
          ? {
              key: "section:catalog.tax_toggle",
              label: "Archive",
              params: { id: r.id, active: false },
              summary: "Hides the rate from new invoices/subscriptions — existing attachments keep it.",
            }
          : { key: "section:catalog.tax_toggle", label: "Restore", params: { id: r.id, active: true } },
      ],
    })),
    empty: "No tax rates yet.",
    ...(rates.length ? { footer: `${rates.length} most recent tax rates` } : {}),
    notice: "Tax rates can't be deleted or have their percentage edited — archive and create a replacement.",
  };
  const create: Block = {
    type: "notice",
    badge: { kind: "info", text: "Create" },
    text: "Tax rates attach to invoices and subscriptions; inclusive = the price already contains the tax.",
    actions: [
      {
        key: "section:catalog.tax_create",
        label: "New tax rate",
        style: "primary",
        inputs: [
          { type: "text", key: "displayName", label: "Display name (e.g. VAT)" },
          { type: "text", key: "percentage", label: "Percentage (e.g. 19 or 7.7)" },
          { type: "toggle", key: "inclusive", label: "Tax-inclusive prices" },
          { type: "text", key: "country", label: "Country (2 letters, optional)", placeholder: "DE" },
          { type: "text", key: "description", label: "Internal description (optional)" },
        ],
        summary: "Creates the tax rate — the percentage is immutable afterwards.",
      },
    ],
  };
  return [table, create];
}

function promoVerdictKv(ctx: DashboardCtx, promo: Stripe.PromotionCode): Block {
  const coupon = promoCoupon(promo);
  const now = Math.floor(Date.now() / 1000);
  const reasons: string[] = [];
  if (!promo.active) reasons.push("code is deactivated");
  if (promo.expires_at && promo.expires_at < now) reasons.push("code expired");
  if (promo.max_redemptions != null && promo.times_redeemed >= promo.max_redemptions) reasons.push("max redemptions reached");
  if (coupon && !coupon.valid) reasons.push("underlying coupon is invalid");
  const valid = reasons.length === 0;
  const discount = coupon ? describeCoupon(ctx.stripe, coupon) : "—";
  const restrictions = [
    promo.restrictions.first_time_transaction ? "first purchase only" : null,
    promo.restrictions.minimum_amount != null
      ? `min ${ctx.stripe.formatAmount(promo.restrictions.minimum_amount, promo.restrictions.minimum_amount_currency ?? "usd")}`
      : null,
    promo.customer ? `customer-specific (${typeof promo.customer === "string" ? promo.customer : promo.customer.id})` : null,
  ].filter(Boolean);
  return {
    type: "kv",
    title: `${promo.code} — ${valid ? "valid now" : "NOT valid"}`,
    rows: [
      { label: "Valid now", cell: badgeCell(valid ? "ok" : "error", valid ? "Yes" : `No — ${reasons.join(", ")}`) },
      { label: "ID", cell: idCell(promo.id, { copy: true }) },
      { label: "Coupon", cell: text(coupon ? `${coupon.id}${coupon.name ? ` (${coupon.name})` : ""} · ${discount} · ${coupon.duration}` : promoCouponId(promo)) },
      { label: "Redemptions", cell: text(`${promo.times_redeemed} / ${promo.max_redemptions ?? "∞"}`) },
      { label: "Expires", cell: promo.expires_at ? dateCell(promo.expires_at) : text("never") },
      { label: "Restrictions", cell: text(restrictions.join(" · ") || "none") },
    ],
    actions: [
      promo.active
        ? { key: "section:catalog.promo_toggle", label: "Deactivate", params: { id: promo.id, active: false } }
        : { key: "section:catalog.promo_toggle", label: "Reactivate", params: { id: promo.id, active: true } },
    ],
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Product catalog", ref: { page: "catalog" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Product not found", hint }],
  };
}
