import { ActionResult, Section, SaveResult } from "../renderer/contract";
import {
  AdminHubContext,
  ActionRequest,
  HubModule,
  SaveRequest,
  asBoundedInt,
  asBoundedIntOrNull,
  asOptionalId,
  asString,
} from "./types";
import { STRIPE_DISPUTE_REASONS } from "../../bot/billing/autoResolvePolicy";
import { RATES_SAMPLED_AT } from "../../bot/billing/fx";

// Audit & Billing hub (config group). Mirrors /config → Audit & Billing:
// audit-log channel, refund guardrails, eligibility, allowed plans, the Stripe
// webhook, and dispute automation + Radar. Operational actions (register
// webhook, provision Radar) run through injected handlers.

export interface AuditBillingHubDeps {
  applyWebhook: (on: boolean) => Promise<void>;
  registerWebhook: () => Promise<string>;
  provisionRadar: () => Promise<string>;
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
      const disputes: Section = {
        key: "disputes",
        title: "Disputes",
        fields: [
          { type: "toggle", key: "disputeAutoCancelSub", label: "Auto-cancel subscription on dispute", value: s.disputeAutoCancelSub() },
          { type: "toggle", key: "disputeAutoBlock", label: "Auto-blocklist on dispute", value: s.disputeAutoBlock() },
          { type: "toggle", key: "disputeAutoAttachReceipt", label: "Auto-attach receipt evidence", value: s.disputeAutoAttachReceipt() },
          { type: "toggle", key: "disputeAutoPackEnabled", label: "Auto-stage templated evidence", value: s.disputeAutoPackEnabled(), help: "Builds the evidence package from templates and stages it. Submit stays manual." },
          { type: "toggle", key: "disputeAutoSubmitEnabled", label: "Auto-submit near the deadline", value: s.disputeAutoSubmitEnabled(), help: "Sends a machine-written package to the bank when nobody has touched it. Leave off until you have read a few packs." },
          { type: "number", key: "disputeAutoSubmitHours", label: "Auto-submit lead (hours)", value: s.disputeAutoSubmitHours(), min: 1, max: 168, unit: "h" },
          { type: "number", key: "disputeAutoSubmitMinScore", label: "Auto-submit minimum score", value: s.disputeAutoSubmitMinScore(), min: 0, max: 100, unit: "%" },
          { type: "number", key: "disputeAutoSubmitMaxMinor", label: "Auto-submit amount ceiling", value: s.disputeAutoSubmitMaxMinor(), min: 0, max: 100000000, nullable: true, unit: "¢", help: "Blank = no ceiling. Above it, a human always submits." },
          { type: "toggle", key: "disputeTemplateIntercomEnabled", label: "Quote support history in evidence", value: s.disputeTemplateIntercomEnabled() },
          { type: "number", key: "disputeReminderDays", label: "Reminder lead (days)", value: s.disputeReminderDays(), min: 0, max: 30 },
          { type: "number", key: "disputeUrgentHours", label: "Urgent threshold (hours)", value: s.disputeUrgentHours(), min: 0, max: 168 },
          { type: "number", key: "disputeRatioWarnPct", label: "Ratio warn %", value: s.disputeRatioWarnPct(), min: 0, max: 100, unit: "%" },
          { type: "number", key: "disputeRatioCriticalPct", label: "Ratio critical %", value: s.disputeRatioCriticalPct(), min: 0, max: 100, unit: "%" },
          { type: "role-select", key: "disputeUrgentRoleId", label: "Urgent ping role", value: s.disputeUrgentRoleId(), options: roles, nullable: true },
          { type: "text", key: "radarListCardId", label: "Radar list: card", value: s.radarListId("card_fingerprint") ?? "" },
          { type: "text", key: "radarListEmailId", label: "Radar list: email", value: s.radarListId("email") ?? "" },
          { type: "text", key: "radarListCustomerId", label: "Radar list: customer", value: s.radarListId("customer_id") ?? "" },
          { type: "text", key: "radarListIpId", label: "Radar list: IP", value: s.radarListId("ip_address") ?? "" },
        ],
        actions: [{ key: "provision_radar", label: "Provision Radar lists", style: "secondary" }],
      };
      // Its own section rather than more fields on Disputes: that one already
      // carries twelve, and these six decide whether money leaves the account
      // without anyone pressing anything.
      const autoResolve: Section = {
        key: "autoresolve",
        title: "Dispute auto-resolve",
        fields: [
          {
            type: "toggle",
            key: "disputeAutoResolveEnabled",
            label: "Enabled",
            value: s.disputeAutoResolveEnabled(),
            help: "Refunds an inquiry-stage dispute so Stripe closes it as prevented and it never counts toward the ratio.",
          },
          {
            type: "toggle",
            key: "disputeAutoResolveEfw",
            label: "Also refund actionable fraud warnings",
            value: s.disputeAutoResolveEfw(),
            help: "Early fraud warnings have no dispute yet. Only ones Stripe marks actionable are eligible.",
          },
          {
            type: "number",
            key: "disputeAutoResolveMaxUsdMinor",
            label: "Maximum amount (USD cents)",
            value: s.disputeAutoResolveMaxUsdMinor(),
            min: 0,
            max: 100000000,
            unit: "¢",
            help: `Other currencies use an approximate built-in rate table (sampled ${RATES_SAMPLED_AT}); an unlisted currency never auto-resolves.`,
          },
          {
            type: "number",
            key: "disputeAutoResolveVetoMinutes",
            label: "Veto window (minutes)",
            value: s.disputeAutoResolveVetoMinutes(),
            min: 0,
            max: 1440,
            unit: "min",
            help: "How long the Discord alert can be cancelled before the refund fires. 0 fires on the next hourly tick.",
          },
          {
            type: "number",
            key: "disputeAutoResolveRepeatDays",
            label: "Repeat-offender window (days)",
            value: s.disputeAutoResolveRepeatDays(),
            min: 0,
            max: 3650,
            unit: "d",
            help: "A customer with a dispute or auto-resolve inside this window is blocked and escalated instead.",
          },
          {
            type: "text",
            key: "disputeAutoResolveReasons",
            label: "Eligible reasons",
            value: [...s.disputeAutoResolveReasons()].sort().join(","),
            placeholder: "subscription_canceled,duplicate",
            help: "Comma-separated Stripe dispute reasons. Fraud warnings ignore this list.",
          },
        ],
      };
      return [audit, billing, webhook, disputes, autoResolve];
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
        case "disputeAutoCancelSub":
        case "disputeAutoBlock":
        case "disputeAutoAttachReceipt":
          await s.updateDisputes({ [req.field]: v === true });
          await ctx.audit(`set ${req.field} → ${v === true}`);
          return { ok: true };
        case "disputeAutoPackEnabled":
        case "disputeAutoSubmitEnabled":
        case "disputeTemplateIntercomEnabled":
          await s.updateDisputeEvidenceAutomation({ [req.field]: v === true });
          await ctx.audit(`set ${req.field} → ${v === true}`);
          return { ok: true };
        case "disputeAutoSubmitHours":
        case "disputeAutoSubmitMinScore": {
          const max = req.field === "disputeAutoSubmitHours" ? 168 : 100;
          const parsed = asBoundedInt(v, 0, max);
          if (!parsed.ok) return { ok: false, fieldErrors: { [req.field]: parsed.error } };
          await s.updateDisputeEvidenceAutomation({ [req.field]: parsed.value });
          await ctx.audit(`set ${req.field} → ${parsed.value}`);
          return { ok: true };
        }
        case "disputeAutoSubmitMaxMinor":
          return boundedNull(100000000, (n) => s.updateDisputeEvidenceAutomation({ disputeAutoSubmitMaxMinor: n }));
        case "disputeReminderDays":
        case "disputeUrgentHours":
        case "disputeRatioWarnPct":
        case "disputeRatioCriticalPct": {
          const max = req.field.endsWith("Pct") ? 100 : req.field === "disputeUrgentHours" ? 168 : 30;
          const parsed = asBoundedInt(v, 0, max);
          if (!parsed.ok) return { ok: false, fieldErrors: { [req.field]: parsed.error } };
          await s.updateDisputes({ [req.field]: parsed.value });
          await ctx.audit(`set ${req.field} → ${parsed.value}`);
          return { ok: true };
        }
        case "disputeUrgentRoleId":
          await s.updateDisputes({ disputeUrgentRoleId: asOptionalId(v) });
          await ctx.audit("set dispute urgent role");
          return { ok: true };
        case "disputeAutoResolveEnabled":
        case "disputeAutoResolveEfw":
          await s.updateDisputeAutoResolve({ [req.field]: v === true });
          await ctx.audit(`set ${req.field} → ${v === true}`);
          return { ok: true };
        case "disputeAutoResolveMaxUsdMinor":
        case "disputeAutoResolveVetoMinutes":
        case "disputeAutoResolveRepeatDays": {
          const max =
            req.field === "disputeAutoResolveMaxUsdMinor" ? 100000000 : req.field === "disputeAutoResolveVetoMinutes" ? 1440 : 3650;
          const parsed = asBoundedInt(v, 0, max);
          if (!parsed.ok) return { ok: false, fieldErrors: { [req.field]: parsed.error } };
          await s.updateDisputeAutoResolve({ [req.field]: parsed.value });
          await ctx.audit(`set ${req.field} → ${parsed.value}`);
          return { ok: true };
        }
        case "disputeAutoResolveReasons": {
          const reasons = asString(v)
            .split(/[\s,]+/)
            .map((x) => x.trim().toLowerCase())
            .filter(Boolean);
          // An unknown token would silently exclude that reason forever, so it
          // is a field error rather than a value we quietly keep.
          const unknown = reasons.filter((r) => !STRIPE_DISPUTE_REASONS.includes(r));
          if (unknown.length) {
            return {
              ok: false,
              fieldErrors: {
                [req.field]: `Not a Stripe dispute reason: ${unknown.join(", ")}. Valid: ${STRIPE_DISPUTE_REASONS.join(", ")}`,
              },
            };
          }
          await s.updateDisputeAutoResolve({ disputeAutoResolveReasons: [...new Set(reasons)] });
          await ctx.audit(`set auto-resolve reasons (${reasons.length})`);
          return { ok: true };
        }
        case "radarListCardId":
        case "radarListEmailId":
        case "radarListCustomerId":
        case "radarListIpId":
          await s.updateRadarLists({ [req.field]: asString(v) || null });
          await ctx.audit(`set ${req.field}`);
          return { ok: true };
        default:
          return { ok: false, error: "Unknown field." };
      }
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      switch (req.key) {
        case "register_webhook":
          await ctx.audit("register stripe webhook");
          return { ok: true, text: await deps.registerWebhook() };
        case "provision_radar":
          await ctx.audit("provision radar lists");
          return { ok: true, text: await deps.provisionRadar() };
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}
