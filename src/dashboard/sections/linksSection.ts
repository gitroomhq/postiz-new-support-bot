import type Stripe from "stripe";
import { ActionResult, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor } from "./types";
import { badgeCell, idCell, money, strong, text } from "./cells";

// Payment links (#/links, PA-7a): Stripe-hosted checkout URLs. List + detail
// + create (price + quantity modal) + activate/deactivate. The URL is the
// product here, so it renders as a copyable external cell everywhere. Reads
// expand line_items so the pages show what each link sells without N+1s.

const LINK_ID_RE = /^plink_[A-Za-z0-9]{1,64}$/;
const PRICE_RE = /^price_[A-Za-z0-9]{1,64}$/;

export function makeLinksSection(): DashboardSectionModule {
  return {
    nav: [{ key: "links", label: "Payment links", page: "links" }],

    ownsPage(page: string): boolean {
      return page === "links" || page === "links.detail";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "links") return list(ctx, req.filters ?? {}, req.cursor ?? null);
      const id = typeof req.params?.id === "string" && LINK_ID_RE.test(req.params.id) ? req.params.id : null;
      if (!id) return notFound("That payment link id is not valid (plink_…).");
      return detail(ctx, id);
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const p = req.params ?? {};
      switch (req.key) {
        // T0 (catalog-create tier) — mint a checkout URL for one price.
        case "section:links.create": {
          const priceId = typeof p.price === "string" && PRICE_RE.test(p.price) ? p.price : null;
          if (!priceId) return { ok: false, fieldErrors: { price: "Pick a price." } };
          const quantity =
            typeof p.quantity === "number" && Number.isSafeInteger(p.quantity) && p.quantity >= 1 && p.quantity <= 999
              ? p.quantity
              : 1;
          const link = await ctx.stripe.createPaymentLink(
            { priceId, quantity, adjustableQuantity: p.adjustable === true },
            `dash-plink-${priceId}-${Date.now().toString(36)}`
          );
          await ctx.audit(`Payment link ${link.id} created on ${priceId}`);
          return { ok: true, text: `Payment link created — ${link.url}` };
        }
        // T0 — kill/revive the URL (links can't be deleted).
        case "section:links.toggle": {
          const id = typeof p.id === "string" && LINK_ID_RE.test(p.id) ? p.id : null;
          if (!id) return { ok: false, error: "Bad payment link id." };
          const link = await ctx.stripe.setPaymentLinkActive(id, p.active === true);
          await ctx.audit(`Payment link ${id} ${link.active ? "reactivated" : "deactivated"}`);
          return { ok: true, text: `${id} is now ${link.active ? "active — the URL works again" : "inactive — the URL is dead"}.` };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

function sellsLabel(link: Stripe.PaymentLink): string {
  const items = link.line_items?.data ?? [];
  if (items.length === 0) return link.id;
  const first = items[0].description ?? "item";
  return items.length > 1 ? `${first} +${items.length - 1}` : first;
}

function activeBadge(active: boolean): Badge {
  return active ? { kind: "ok", text: "Active" } : { kind: "neutral", text: "Deactivated" };
}

async function list(ctx: DashboardCtx, filters: Record<string, string>, cursor: string | null): Promise<SectionPage> {
  const rawCursor = validCursor(cursor) ?? "";
  const startingAfter = LINK_ID_RE.test(rawCursor) ? rawCursor : undefined;
  const statusFilter = str(filters.status, 12);
  const [linksRes, prices] = await Promise.all([
    ctx.stripe.listPaymentLinks({ limit: 25, startingAfter }),
    ctx.stripe.listAllActivePrices(100).catch(() => [] as Stripe.Price[]),
  ]);
  const links = linksRes.links.filter((l) =>
    statusFilter === "active" ? l.active : statusFilter === "inactive" ? !l.active : true
  );

  const priceOptions = prices.slice(0, 25).map((p) => ({
    value: p.id,
    label: `${p.nickname ?? p.id.slice(0, 18)} — ${p.unit_amount != null ? ctx.stripe.formatAmount(p.unit_amount, p.currency) : "?"}${p.recurring ? `/${p.recurring.interval}` : ""}`,
  }));

  const blocks: Block[] = [
    {
      type: "header",
      title: "Payment links",
      actions: [
        {
          key: "section:links.create",
          label: "New payment link",
          style: "primary",
          inputs: [
            { type: "select", key: "price", label: "Price", options: priceOptions },
            { type: "number", key: "quantity", label: "Quantity (default 1)", min: 1, max: 999 },
            { type: "toggle", key: "adjustable", label: "Customer can adjust quantity" },
          ],
          summary: "Creates a Stripe-hosted checkout URL for the picked price — shareable immediately.",
        },
      ],
    },
    {
      type: "table",
      key: "links",
      columns: [
        { key: "sells", label: "Sells" },
        { key: "status", label: "Status" },
        { key: "url", label: "URL" },
        { key: "id", label: "ID" },
      ],
      counts: {
        key: "status",
        items: [
          { value: "", label: "All", count: linksRes.links.length },
          { value: "active", label: "Active", count: linksRes.links.filter((l) => l.active).length },
          { value: "inactive", label: "Deactivated", count: linksRes.links.filter((l) => !l.active).length },
        ],
      },
      exportable: true,
      rows: links.map((link) => ({
        id: link.id,
        ref: { page: "links.detail", params: { id: link.id } },
        cells: [
          strong(sellsLabel(link)),
          badgeCell(activeBadge(link.active).kind, activeBadge(link.active).text),
          { t: "external", v: link.url.replace(/^https?:\/\//, ""), href: link.url, copy: true } as Cell,
          idCell(link.id, { copy: true }),
        ] as Cell[],
        actions: [
          link.active
            ? {
                key: "section:links.toggle",
                label: "Deactivate",
                params: { id: link.id, active: false },
                summary: "Kills the URL — customers holding it see an error page until reactivation.",
              }
            : { key: "section:links.toggle", label: "Reactivate", params: { id: link.id, active: true } },
        ],
      })),
      nextCursor:
        linksRes.hasMore && linksRes.links.length > 0 ? linksRes.links[linksRes.links.length - 1].id : null,
      empty: statusFilter ? "No payment links match this filter (within this window)." : "No payment links yet — create one above.",
      ...(links.length ? { footer: `${links.length} item${links.length === 1 ? "" : "s"}` } : {}),
      notice: "Counts cover this page's window. Links can't be deleted — deactivate to kill the URL.",
    },
  ];
  return { title: "Payment links", crumbs: [{ label: "Payment links" }], blocks };
}

async function detail(ctx: DashboardCtx, id: string): Promise<SectionPage> {
  const link = await ctx.stripe.getPaymentLink(id).catch(() => null);
  if (!link) return notFound("This payment link does not exist.");
  const items = link.line_items?.data ?? [];
  const after =
    link.after_completion?.type === "redirect"
      ? `Redirect → ${link.after_completion.redirect?.url ?? "?"}`
      : "Stripe confirmation page";

  const main: Block[] = [
    {
      type: "header",
      title: sellsLabel(link),
      sub: "Payment link",
      badges: [activeBadge(link.active)],
      actions: [
        link.active
          ? {
              key: "section:links.toggle",
              label: "Deactivate",
              style: "danger",
              params: { id: link.id, active: false },
              summary: "Kills the URL — customers holding it see an error page until reactivation.",
            }
          : { key: "section:links.toggle", label: "Reactivate", style: "primary", params: { id: link.id, active: true } },
      ],
    },
    {
      type: "table",
      key: "items",
      title: "Line items",
      columns: [
        { key: "desc", label: "Description" },
        { key: "qty", label: "Qty", align: "right" },
        { key: "amount", label: "Amount", align: "right" },
      ],
      rows: items.map((li, i) => ({
        id: li.id ?? String(i),
        cells: [
          text(li.description ?? "item"),
          text(String(li.quantity ?? 1)),
          money(ctx.stripe, li.amount_total ?? 0, li.currency),
        ] as Cell[],
      })),
      empty: "No line items (expand unavailable).",
    },
  ];
  const rail: Block[] = [
    {
      type: "kv",
      title: "Details",
      rows: [
        { label: "Link ID", cell: idCell(link.id, { copy: true }) },
        { label: "URL", cell: { t: "external", v: "Open checkout ↗", href: link.url, copy: true } as Cell },
        { label: "Status", cell: badgeCell(activeBadge(link.active).kind, activeBadge(link.active).text) },
        { label: "After payment", cell: text(after) },
        ...(link.allow_promotion_codes ? [{ label: "Promo codes", cell: text("Allowed") }] : []),
      ],
    },
  ];
  return {
    title: sellsLabel(link),
    crumbs: [{ label: "Payment links", ref: { page: "links" } }, { label: link.id, copyId: link.id }],
    blocks: main,
    rail,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Payment links", ref: { page: "links" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Payment link not found", hint }],
  };
}
