import { ActionResult, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asBoundedInt, asBoundedIntOrNull, asOptionalId, asString } from "./types";
import { STRIPE_DISPUTE_REASONS } from "../../bot/billing/autoResolvePolicy";
import { RATES_SAMPLED_AT } from "../../bot/billing/fx";
import {
  DISPUTE_PHASES,
  EVIDENCE_PHASE_LABELS,
  RESOLVE_PHASE_LABELS,
  isDisputePhase,
  type DisputePhase,
} from "../../bot/billing/disputePhase";
import { POSTIZ_READ_URL_VAR } from "../../postiz/PostizActivitySource";

// Disputes hub (config group). The dispute workflow outgrew a section inside
// Audit & Billing: it now has two independent cutover pipelines, a scoring
// gate, guardrails that spend money, and three external data sources. Each of
// those deserves to be readable on its own rather than as field thirty of a
// list.
//
// The two MODE fields are the important ones and lead their sections, because
// every other knob here only matters once a mode is above "none".

export interface DisputesHubDeps {
  // Reachability of the read-only Postiz posts/channels connection, so an
  // operator can tell "not configured" from "configured but broken".
  postizReadSelfTest: () => Promise<{ ok: boolean; detail: string }>;
  provisionRadar: () => Promise<string>;
}

const phaseOptions = (labels: Record<DisputePhase, string>) =>
  DISPUTE_PHASES.map((p) => ({ value: p, label: labels[p] }));

export function makeDisputesHub(deps: DisputesHubDeps): HubModule {
  return {
    hub: "disputes",
    group: "config",
    title: "Disputes",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      const roles = ctx.guild.roles(ctx.actor.guildId);

      const evidence: Section = {
        key: "evidence",
        title: "Evidence pipeline",
        fields: [
          {
            type: "select",
            key: "disputeEvidenceMode",
            label: "Mode",
            value: s.disputeEvidenceMode(),
            options: phaseOptions(EVIDENCE_PHASE_LABELS),
            help: "Evidence is written from templates and real account facts. No model is involved.",
          },
          {
            type: "number",
            key: "disputeAutoSubmitHours",
            label: "Auto-submit lead (hours)",
            value: s.disputeAutoSubmitHours(),
            min: 1,
            max: 168,
            unit: "h",
            help: "Only used in auto: how long before the evidence deadline an untouched package is submitted.",
          },
          {
            type: "number",
            key: "disputeAutoSubmitMinScore",
            label: "Minimum completeness to submit",
            value: s.disputeAutoSubmitMinScore(),
            min: 0,
            max: 100,
            unit: "%",
            help: "Below this the package is left staged and a human is paged instead.",
          },
          {
            type: "number",
            key: "disputeAutoSubmitMaxMinor",
            label: "Amount ceiling for auto-submit",
            value: s.disputeAutoSubmitMaxMinor(),
            min: 0,
            max: 100000000,
            nullable: true,
            unit: "¢",
            help: "Blank = no ceiling. Above it a human always submits.",
          },
          { type: "toggle", key: "disputeAutoAttachReceipt", label: "Auto-attach the receipt PDF", value: s.disputeAutoAttachReceipt() },
        ],
      };

      const resolve: Section = {
        key: "autoresolve",
        title: "Auto-resolve (refund to prevent)",
        fields: [
          {
            type: "select",
            key: "disputeResolveMode",
            label: "Mode",
            value: s.disputeResolveMode(),
            options: phaseOptions(RESOLVE_PHASE_LABELS),
            help: "Refunding an inquiry-stage dispute closes it as prevented, so it never counts toward the ratio.",
          },
          {
            type: "toggle",
            key: "disputeAutoResolveEfw",
            label: "Also act on actionable fraud warnings",
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
            help: "How long the alert can be cancelled before the refund fires. Only used in auto.",
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
          { type: "toggle", key: "disputeAutoCancelSub", label: "Cancel subscriptions on a new dispute", value: s.disputeAutoCancelSub() },
          { type: "toggle", key: "disputeAutoBlock", label: "Blocklist on a new dispute", value: s.disputeAutoBlock() },
        ],
      };

      const alerts: Section = {
        key: "alerts",
        title: "Deadlines and ratio alerts",
        fields: [
          { type: "number", key: "disputeReminderDays", label: "Reminder lead (days)", value: s.disputeReminderDays(), min: 0, max: 30 },
          { type: "number", key: "disputeUrgentHours", label: "Urgent threshold (hours)", value: s.disputeUrgentHours(), min: 0, max: 168 },
          { type: "role-select", key: "disputeUrgentRoleId", label: "Urgent ping role", value: s.disputeUrgentRoleId(), options: roles, nullable: true },
          { type: "number", key: "disputeRatioWarnPct", label: "Ratio warn %", value: s.disputeRatioWarnPct(), min: 0, max: 100, unit: "%" },
          { type: "number", key: "disputeRatioCriticalPct", label: "Ratio critical %", value: s.disputeRatioCriticalPct(), min: 0, max: 100, unit: "%" },
        ],
      };

      const probe = await deps.postizReadSelfTest().catch((e) => ({ ok: false, detail: String(e).slice(0, 160) }));
      const sources: Section = {
        key: "sources",
        title: "Evidence data sources",
        fields: [
          {
            type: "static",
            key: "postizRead",
            label: "Postiz posts and channels",
            // Env-only on purpose: a second database's credentials should never
            // be rendered in a panel or editable from Discord.
            value: `${probe.ok ? "connected" : "unavailable"} · ${probe.detail}`,
            help: `Read-only, set by ${POSTIZ_READ_URL_VAR} in the environment. Without it, every usage claim is omitted from evidence.`,
          },
          {
            type: "toggle",
            key: "disputeTemplateIntercomEnabled",
            label: "Use support history in evidence",
            value: s.disputeTemplateIntercomEnabled(),
            help: "Lets evidence state that no refund was ever requested. Without it that claim is never made.",
          },
          { type: "text", key: "radarListCardId", label: "Radar list: card", value: s.radarListId("card_fingerprint") ?? "" },
          { type: "text", key: "radarListEmailId", label: "Radar list: email", value: s.radarListId("email") ?? "" },
          { type: "text", key: "radarListCustomerId", label: "Radar list: customer", value: s.radarListId("customer_id") ?? "" },
          { type: "text", key: "radarListIpId", label: "Radar list: IP", value: s.radarListId("ip_address") ?? "" },
        ],
        actions: [{ key: "provision_radar", label: "Provision Radar lists", style: "secondary" }],
      };

      return [evidence, resolve, alerts, sources];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      switch (req.field) {
        case "disputeEvidenceMode":
        case "disputeResolveMode": {
          const mode = asString(v);
          if (!isDisputePhase(mode)) return { ok: false, fieldErrors: { [req.field]: "Not a valid phase." } };
          if (req.field === "disputeEvidenceMode") await s.updateDisputeEvidenceAutomation({ disputeEvidenceMode: mode });
          else await s.updateDisputeAutoResolve({ disputeResolveMode: mode });
          await ctx.audit(`set ${req.field} → ${mode}`);
          return { ok: true };
        }
        case "disputeAutoAttachReceipt":
        case "disputeAutoCancelSub":
        case "disputeAutoBlock":
          await s.updateDisputes({ [req.field]: v === true });
          await ctx.audit(`set ${req.field} → ${v === true}`);
          return { ok: true };
        case "disputeTemplateIntercomEnabled":
          await s.updateDisputeEvidenceAutomation({ disputeTemplateIntercomEnabled: v === true });
          await ctx.audit(`set ${req.field} → ${v === true}`);
          return { ok: true };
        case "disputeAutoResolveEfw":
          await s.updateDisputeAutoResolve({ disputeAutoResolveEfw: v === true });
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
        case "disputeAutoSubmitMaxMinor": {
          const parsed = asBoundedIntOrNull(v, 0, 100000000);
          if (!parsed.ok) return { ok: false, fieldErrors: { [req.field]: parsed.error } };
          await s.updateDisputeEvidenceAutomation({ disputeAutoSubmitMaxMinor: parsed.value });
          await ctx.audit(`set ${req.field} → ${parsed.value ?? "none"}`);
          return { ok: true };
        }
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
          const reasons = asString(v).split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
          // An unknown token would silently exclude that reason forever.
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
      if (req.key === "provision_radar") {
        await ctx.audit("provision radar lists");
        return { ok: true, text: await deps.provisionRadar() };
      }
      return { ok: false, error: "Unknown action." };
    },
  };
}
