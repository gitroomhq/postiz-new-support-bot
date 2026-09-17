import { ActionResult, Section, SaveResult } from "../renderer/contract";
import {
  AdminHubContext,
  ActionRequest,
  HubModule,
  SaveRequest,
  asBoundedIntOrNull,
  asOptionalId,
  asString,
} from "./types";

// Audit & Billing hub (config group). Mirrors /config → Audit & Billing:
// audit-log channel, refund guardrails, eligibility, allowed plans, the Stripe
// and the Stripe webhook. Dispute automation moved to its own Disputes hub:
// it has two cutover pipelines and three data sources, which is more than a
// section of someone else's page can carry.

export interface AuditBillingHubDeps {
  applyWebhook: (on: boolean) => Promise<void>;
  registerWebhook: () => Promise<string>;
}

export function makeAuditBillingHub(deps: AuditBillingHubDeps): HubModule {
  return {
    hub: "auditbilling",
    group: "config",
    title: "Audit & Billing",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      const channels = ctx.guild.channels(ctx.actor.guildId);
      const roles = ctx.guild.roles(ctx.actor.guildId);
      const prices = s.allowedPriceIds();
      const pricesStr = Array.isArray(prices) ? prices.join(", ") : String(prices ?? "");

      const audit: Section = {
        key: "audit",
        title: "Audit log",
        fields: [{ type: "channel-select", key: "auditLogChannelId", label: "Audit-log channel", value: s.auditLogChannelId(), options: channels, nullable: true }],
      };
      const billing: Section = {
        key: "billing",
        title: "Billing guardrails",
        fields: [
          { type: "channel-select", key: "billingAuditChannelId", label: "Billing-audit channel", value: s.billingAuditChannelId(), options: channels, nullable: true },
          { type: "number", key: "refundMaxAmount", label: "Max refund (minor units)", value: s.refundMaxAmount(), min: 0, max: 100000000, nullable: true, help: "Blank = no cap." },
          { type: "text", key: "refundMaxAmountCurrency", label: "Refund currency", value: s.refundMaxAmountCurrency(), placeholder: "usd" },
          { type: "number", key: "refundMaxPer24h", label: "Max refunds / 24h (global)", value: s.refundMaxPer24h(), min: 0, max: 10000, nullable: true },
          { type: "number", key: "refundMaxPer24hPerUser", label: "Max refunds / 24h / user", value: s.refundMaxPer24hPerUser(), min: 0, max: 1000, nullable: true },
          { type: "number", key: "refundMinMemberAgeDays", label: "Min member age (days)", value: s.refundMinMemberAgeDays(), min: 0, max: 3650, nullable: true },
          { type: "number", key: "refundMaxChargeAgeDays", label: "Max charge age (days): eligibility", value: s.refundMaxChargeAgeDays(), min: 0, max: 3650, nullable: true },
          { type: "text", key: "allowedPriceIds", label: "Allowed plan price ids", value: pricesStr, placeholder: "price_abc, price_def", help: "Comma-separated. Blank = all." },
        ],
      };
      const webhook: Section = {
        key: "webhook",
        title: "Stripe webhook",
        fields: [
          { type: "toggle", key: "stripeWebhookEnabled", label: "Enabled", value: s.stripeWebhookEnabled() },
          { type: "text", key: "publicBaseUrl", label: "Public base URL", value: s.publicBaseUrl() ?? "", placeholder: "https://bot.example.com", help: "Also used by the web panels." },
        ],
        actions: [{ key: "register_webhook", label: "Register / refresh endpoint", style: "secondary" }],
      };
      return [audit, billing, webhook];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      const boundedNull = async (max: number, apply: (n: number | null) => Promise<void>): Promise<SaveResult> => {
        const parsed = asBoundedIntOrNull(v, 0, max);
        if (!parsed.ok) return { ok: false, fieldErrors: { [req.field!]: parsed.error } };
        await apply(parsed.value);
        await ctx.audit(`set ${req.field} → ${parsed.value ?? "none"}`);
        return { ok: true };
      };
      switch (req.field) {
        case "auditLogChannelId":
          await s.updateGeneral({ auditLogChannelId: asOptionalId(v) });
          await ctx.audit("set audit-log channel");
          return { ok: true };
        case "billingAuditChannelId":
          await s.updateBilling({ billingAuditChannelId: asOptionalId(v) });
          await ctx.audit("set billing-audit channel");
          return { ok: true };
        case "refundMaxAmount":
          return boundedNull(100000000, (n) => s.updateBilling({ refundMaxAmount: n }));
        case "refundMaxPer24h":
          return boundedNull(10000, (n) => s.updateBilling({ refundMaxPer24h: n }));
        case "refundMaxPer24hPerUser":
          return boundedNull(1000, (n) => s.updateBilling({ refundMaxPer24hPerUser: n }));
        case "refundMinMemberAgeDays":
          return boundedNull(3650, (n) => s.updateBilling({ refundMinMemberAgeDays: n }));
        case "refundMaxChargeAgeDays":
          return boundedNull(3650, (n) => s.updateBilling({ refundMaxChargeAgeDays: n }));
        case "refundMaxAmountCurrency":
          await s.updateBilling({ refundMaxAmountCurrency: asString(v).toLowerCase() || "usd" });
          await ctx.audit("set refund currency");
          return { ok: true };
        case "allowedPriceIds": {
          const ids = asString(v).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
          await s.updateAllowedPriceIds(ids);
          await ctx.audit(`set allowed price ids (${ids.length})`);
          return { ok: true };
        }
        case "stripeWebhookEnabled": {
          const on = v === true;
          await s.updateStripeWebhook({ stripeWebhookEnabled: on });
          await deps.applyWebhook(on).catch(() => {});
          await ctx.audit(`stripe webhook → ${on ? "on" : "off"}`);
          return { ok: true };
        }
        case "publicBaseUrl":
          await s.updateStripeWebhook({ publicBaseUrl: asString(v) || null });
          await ctx.audit("set public base URL");
          return { ok: true };
        default:
          return { ok: false, error: "Unknown field." };
      }
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      if (req.key === "register_webhook") {
        await ctx.audit("register stripe webhook");
        return { ok: true, text: await deps.registerWebhook() };
      }
      return { ok: false, error: "Unknown action." };
    },
  };
}
