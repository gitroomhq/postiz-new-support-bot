import type Stripe from "stripe";
import { ActionResult, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage } from "./types";
import { badgeCell, dateCell, idCell, text } from "./cells";

// Customer portal (#/portal, Operate group, PA-6): the billing_portal
// configuration surface — which self-serve features customers get (invoice
// history, payment-method update, cancellation). Per-customer LOGIN LINKS are
// minted from the Customer 360 (customers.portal), not here. Feature edits are
// T1 typed-CONFIRM; deeper knobs (subscription_update products, cancellation
// reasons) stay in the real Stripe dashboard.

const CONFIG_ID_RE = /^bpc_[A-Za-z0-9]{1,64}$/;

// The three feature toggles the panel edits; everything else is display-only.
function featuresFromParams(p: Record<string, unknown>): Stripe.BillingPortal.ConfigurationCreateParams.Features {
  return {
    invoice_history: { enabled: p.invoiceHistory === true },
    payment_method_update: { enabled: p.pmUpdate === true },
    subscription_cancel: { enabled: p.subCancel === true, ...(p.subCancel === true ? { mode: "at_period_end" as const } : {}) },
  };
}

export function makePortalSection(): DashboardSectionModule {
  return {
    nav: [{ key: "portal", label: "Customer portal", page: "portal", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "portal";
    },

    async buildPage(ctx: DashboardCtx): Promise<SectionPage | null> {
      const configs = await ctx.stripe.listPortalConfigurations(10).catch(() => [] as Stripe.BillingPortal.Configuration[]);
      const blocks: Block[] = [
        {
          type: "header",
          title: "Customer portal",
          sub: "What customers can self-serve on their Stripe-hosted billing page.",
        },
      ];

      if (configs.length === 0) {
        blocks.push({
          type: "notice",
          badge: { kind: "info", text: "Not configured" },
          text: "The customer portal has no configuration yet — create the default one to enable self-serve billing.",
          actions: [
            {
              key: "section:portal.config_create",
              label: "Create default configuration",
              style: "primary",
              dangerous: true,
              inputs: [
                { type: "toggle", key: "invoiceHistory", label: "Invoice history", value: true },
                { type: "toggle", key: "pmUpdate", label: "Update payment methods", value: true },
                { type: "toggle", key: "subCancel", label: "Cancel subscriptions (at period end)" },
              ],
              summary: "Creates the portal configuration Stripe uses for customer login links.",
            },
          ],
        });
      } else {
        blocks.push({
          type: "table",
          key: "configs",
          title: "Configurations",
          columns: [
            { key: "id", label: "Configuration" },
            { key: "flags", label: "" },
            { key: "features", label: "Features" },
            { key: "updated", label: "Updated" },
          ],
          rows: configs.map((c) => {
            const f = c.features;
            const summary = [
              f.invoice_history?.enabled ? "invoice history" : null,
              f.payment_method_update?.enabled ? "PM update" : null,
              f.subscription_cancel?.enabled ? `cancel (${f.subscription_cancel.mode ?? "at_period_end"})` : null,
              f.subscription_update?.enabled ? "plan update" : null,
              f.customer_update?.enabled ? "details update" : null,
            ].filter(Boolean);
            const flags: Badge[] = [
              ...(c.is_default ? [{ kind: "info", text: "Default" } as Badge] : []),
              ...(c.active ? [] : [{ kind: "neutral", text: "Inactive" } as Badge]),
            ];
            return {
              id: c.id,
              cells: [
                idCell(c.id, { copy: true }),
                { t: "flags", badges: flags } as Cell,
                text(summary.join(" · ") || "nothing enabled"),
                dateCell(c.updated),
              ] as Cell[],
              actions: [
                {
                  key: "section:portal.config_update",
                  label: "Edit features",
                  dangerous: true,
                  params: { id: c.id },
                  inputs: [
                    { type: "toggle", key: "invoiceHistory", label: "Invoice history", value: f.invoice_history?.enabled ?? false },
                    { type: "toggle", key: "pmUpdate", label: "Update payment methods", value: f.payment_method_update?.enabled ?? false },
                    { type: "toggle", key: "subCancel", label: "Cancel subscriptions (at period end)", value: f.subscription_cancel?.enabled ?? false },
                  ],
                  summary: "Applies the three core self-serve toggles. Deeper knobs (plan switching, cancellation reasons) stay in the Stripe dashboard.",
                },
              ],
            };
          }),
          empty: "No configurations.",
          notice: "Per-customer login links are minted from each customer's page (Manage → Customer portal).",
        });
      }
      return { title: "Customer portal", crumbs: [{ label: "Customer portal" }], blocks };
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const p = req.params ?? {};
      const confirmed = req.confirmWord === "CONFIRM";
      switch (req.key) {
        // T1 — create the initial portal configuration.
        case "section:portal.config_create": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const config = await ctx.stripe.createPortalConfiguration(
            featuresFromParams(p),
            `dash-portalcfg-${Date.now().toString(36)}`
          );
          await ctx.audit(`Portal configuration ${config.id} created`);
          return { ok: true, text: `Portal configuration ${config.id} created.` };
        }
        // T1 — flip the core feature toggles on an existing configuration.
        case "section:portal.config_update": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const id = typeof p.id === "string" && CONFIG_ID_RE.test(p.id) ? p.id : null;
          if (!id) return { ok: false, error: "Bad configuration id (bpc_…)." };
          const config = await ctx.stripe.updatePortalConfiguration(id, featuresFromParams(p));
          const f = config.features;
          const summary = [
            f.invoice_history?.enabled ? "invoice history" : null,
            f.payment_method_update?.enabled ? "PM update" : null,
            f.subscription_cancel?.enabled ? "cancel" : null,
          ].filter(Boolean);
          await ctx.audit(`Portal configuration ${id} updated — ${summary.join(", ") || "all core features off"}`);
          return { ok: true, text: `Portal configuration updated (${summary.join(", ") || "all core features off"}).` };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}
