import { ActionResult, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asBoundedInt, asString } from "./types";

// Automation hub (intercom group): the workspace customer-idle sweeper for
// native / unbridged conversations (outbound nag + auto-close). Mirrors
// /intercom → Automation. Agent nags are SLA-driven (SLA Manager → Nag
// Cadence). (Per-tag customer reminder TEXT overrides are edited on each tag
// in Workflow.)

export function makeAutomationHub(deps: { runInactivityNow: () => Promise<string> }): HubModule {
  return {
    hub: "automation",
    group: "intercom",
    title: "Automation",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      return [
        {
          key: "inactivity",
          title: "Customer-idle sweeper",
          fields: [
            { type: "toggle", key: "inactivityEnabled", label: "Enabled", value: s.inactivityEnabled() },
            { type: "number", key: "inactivityCustomerWaitDays", label: "Customer-idle days before nudge", value: s.inactivityCustomerWaitDays(), min: 1, max: 30 },
            { type: "number", key: "inactivityNagsBeforeClose", label: "Nudges before auto-close", value: s.inactivityNagsBeforeClose(), min: 1, max: 10 },
            { type: "text", key: "inactivityNagText", label: "Customer nudge text", value: s.inactivityNagText() ?? "", multiline: true, help: "Blank = built-in default. {days} supported." },
          ],
          actions: [{ key: "run_inactivity", label: "Run sweep now", style: "secondary" }],
        },
      ];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      switch (req.field) {
        case "inactivityEnabled":
          await s.updateInactivity({ inactivityEnabled: v === true });
          await ctx.audit(`inactivity sweeper → ${v === true}`);
          return { ok: true };
        case "inactivityCustomerWaitDays": {
          const parsed = asBoundedInt(v, 1, 30);
          if (!parsed.ok) return { ok: false, fieldErrors: { [req.field]: parsed.error } };
          await s.updateInactivity({ inactivityCustomerWaitDays: parsed.value });
          await ctx.audit(`set ${req.field} → ${parsed.value}`);
          return { ok: true };
        }
        case "inactivityNagsBeforeClose": {
          const parsed = asBoundedInt(v, 1, 10);
          if (!parsed.ok) return { ok: false, fieldErrors: { inactivityNagsBeforeClose: parsed.error } };
          await s.updateInactivity({ inactivityNagsBeforeClose: parsed.value });
          await ctx.audit(`set nags-before-close → ${parsed.value}`);
          return { ok: true };
        }
        case "inactivityNagText":
          await s.updateInactivity({ inactivityNagText: asString(v) || null });
          await ctx.audit(`set ${req.field}`);
          return { ok: true };
        default:
          return { ok: false, error: "Unknown field." };
      }
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      if (req.key === "run_inactivity") {
        await ctx.audit("manual customer-idle sweep");
        return { ok: true, text: await deps.runInactivityNow() };
      }
      return { ok: false, error: "Unknown action." };
    },
  };
}
