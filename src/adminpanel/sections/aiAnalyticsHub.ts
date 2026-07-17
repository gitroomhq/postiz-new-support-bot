import { ActionResult, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asBoundedFloat, asBoundedInt, asString } from "./types";

// AI & Analytics hub (config group). AI = dispute-evidence model + KB refresh;
// Analytics = InfluxDB. Mirrors /config → AI & Analytics.

export interface AiAnalyticsHubDeps {
  refreshKbNow: () => Promise<{ ok: number; failed: number }>;
}

export function makeAiAnalyticsHub(deps: AiAnalyticsHubDeps): HubModule {
  return {
    hub: "aianalytics",
    group: "config",
    title: "AI & Analytics",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      const last = s.kbLastRefreshAt();
      const ai: Section = {
        key: "ai",
        title: "AI (dispute evidence)",
        fields: [
          { type: "text", key: "aiModel", label: "Model", value: s.aiModel() },
          { type: "text", key: "aiModelLight", label: "Light model", value: s.aiModelLight() },
          { type: "text", key: "aiEffortAsk", label: "Effort", value: s.aiEffortAsk(), placeholder: "low | medium | high", help: "Caps exploration depth." },
          { type: "number", key: "aiMaxBudgetUsdAsk", label: "Max budget (USD/run)", value: s.aiMaxBudgetUsdAsk(), min: 0, max: 100, step: 0.5, unit: "USD" },
          { type: "toggle", key: "kbRefreshEnabled", label: "Auto-refresh knowledge base", value: s.kbRefreshEnabled() },
          { type: "number", key: "kbRefreshIntervalHours", label: "KB refresh interval (hours)", value: s.kbRefreshIntervalHours(), min: 1, max: 168, unit: "h" },
          {
            type: "static",
            key: "kbLast",
            label: "Last KB refresh",
            value: last ? last.toISOString().replace("T", " ").slice(0, 16) : "never",
          },
        ],
        actions: [{ key: "kb_refresh", label: "Refresh knowledge base now", style: "secondary" }],
      };
      const analytics: Section = {
        key: "analytics",
        title: "Analytics (InfluxDB)",
        fields: [
          { type: "toggle", key: "influxEnabled", label: "Enabled", value: s.influxEnabled() },
          { type: "text", key: "influxUrl", label: "URL", value: s.influxUrl() ?? "" },
          { type: "text", key: "influxOrg", label: "Org", value: s.influxOrg() ?? "" },
          { type: "text", key: "influxBucket", label: "Bucket", value: s.influxBucket() ?? "" },
          { type: "text", key: "influxToken", label: "Token", value: "", secret: true, secretState: s.secretState("influxToken") },
        ],
      };
      return [ai, analytics];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      switch (req.field) {
        case "aiModel":
        case "aiModelLight":
        case "aiEffortAsk":
          await s.updateGeneral({ [req.field]: asString(v) });
          await ctx.audit(`set ${req.field}`);
          return { ok: true };
        case "aiMaxBudgetUsdAsk": {
          const parsed = asBoundedFloat(v, 0, 100);
          if (!parsed.ok) return { ok: false, fieldErrors: { aiMaxBudgetUsdAsk: parsed.error } };
          await s.updateGeneral({ aiMaxBudgetUsdAsk: parsed.value });
          await ctx.audit(`set ai budget → ${parsed.value}`);
          return { ok: true };
        }
        case "kbRefreshEnabled":
          await s.updateKnowledge({ kbRefreshEnabled: v === true });
          await ctx.audit(`set kb auto-refresh → ${v === true}`);
          return { ok: true };
        case "kbRefreshIntervalHours": {
          const parsed = asBoundedInt(v, 1, 168);
          if (!parsed.ok) return { ok: false, fieldErrors: { kbRefreshIntervalHours: parsed.error } };
          await s.updateKnowledge({ kbRefreshIntervalHours: parsed.value });
          await ctx.audit(`set kb interval → ${parsed.value}h`);
          return { ok: true };
        }
        case "influxEnabled":
          await s.updateAnalytics({ influxEnabled: v === true });
          await ctx.audit(`set influx enabled → ${v === true}`);
          return { ok: true };
        case "influxUrl":
        case "influxOrg":
        case "influxBucket":
          await s.updateAnalytics({ [req.field]: asString(v) || null });
          await ctx.audit(`set ${req.field}`);
          return { ok: true };
        case "influxToken": {
          const val = asString(v);
          if (!val) return { ok: true };
          await s.updateAnalytics({ influxToken: val === "none" ? null : val });
          await ctx.audit("updated influx token");
          return { ok: true };
        }
        default:
          return { ok: false, error: "Unknown field." };
      }
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      if (req.key === "kb_refresh") {
        const r = await deps.refreshKbNow();
        await ctx.audit("manual KB refresh");
        return { ok: true, text: `Knowledge base refreshed: ${r.ok} ok, ${r.failed} failed.`, view: undefined };
      }
      return { ok: false, error: "Unknown action." };
    },
  };
}
