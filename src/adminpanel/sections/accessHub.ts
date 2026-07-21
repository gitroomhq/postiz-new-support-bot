import { BillingActionLevel } from "../../config/SettingsStore";
import { BILLING_ACTIONS, actionByKey } from "../../bot/billing/actions/ActionRegistry";
import { ActionResult, Opt, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, HubModule, SaveRequest, oneOf } from "./types";

// Access hub (intercom group): who counts as an Intercom "admin" for canvas/panel
// billing actions, and the per-action access level for all 17 billing actions.
// Shared authorization surface (mirrors /intercom → Intercom Admins / Actions).

const LEVEL_OPTS: Opt[] = [
  { value: "none", label: "Disabled (nobody)" },
  { value: "approval", label: "Agents → admin approval" },
  { value: "admin", label: "Admins only" },
  { value: "all", label: "Everyone" },
];
const LEVELS = ["none", "approval", "admin", "all"] as const;

export function makeAccessHub(deps: { listIntercomAdmins: () => Promise<Array<{ id: string; name: string }>> }): HubModule {
  return {
    hub: "access",
    group: "intercom",
    title: "Access",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      let adminOpts: Opt[] = [];
      let note: string | undefined;
      try {
        adminOpts = (await deps.listIntercomAdmins()).map((a) => ({ value: a.id, label: a.name }));
      } catch {
        note = "Teammate list unavailable. Check the Intercom access token.";
      }
      const admins: Section = {
        key: "admins",
        title: "Intercom admins",
        description: "Teammates who may run admin-level billing actions from the canvas / Stripe panel.",
        notice: note ? { kind: "warn", text: note } : undefined,
        fields: [
          {
            type: "multiselect",
            key: "intercomPanelAdmins",
            label: "Admin teammates",
            values: s.intercomPanelAdmins().map((a) => a.id),
            options: adminOpts,
          },
        ],
      };

      // One section per action group, each with a per-action level select.
      const groups = new Map<string, Section>();
      for (const def of BILLING_ACTIONS) {
        let sec = groups.get(def.group);
        if (!sec) {
          sec = { key: `actions_${def.group}`, title: `Action levels: ${def.group}`, fields: [] };
          groups.set(def.group, sec);
        }
        sec.fields.push({
          type: "select",
          key: def.key,
          label: `${def.label}${def.dangerous ? " ⚠" : ""}`,
          value: s.billingActionLevel(def.key, def.defaultLevel),
          options: LEVEL_OPTS,
        });
      }
      return [admins, ...groups.values()];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      if (req.field === "intercomPanelAdmins") {
        const ids = Array.isArray(req.value) ? (req.value as unknown[]).map(String) : [];
        let all: Array<{ id: string; name: string }> = [];
        try {
          all = await deps.listIntercomAdmins();
        } catch {
          return { ok: false, error: "Could not load the teammate list to resolve names." };
        }
        const selected = all.filter((a) => ids.includes(a.id));
        await s.updateIntercomPanelAdmins(selected);
        await ctx.audit(`set intercom admins (${selected.length})`);
        return { ok: true };
      }
      // Otherwise the field key is a billing action key.
      if (!actionByKey(req.field ?? "")) return { ok: false, error: "Unknown field." };
      const level = oneOf<BillingActionLevel>(req.value, LEVELS);
      if (!level) return { ok: false, fieldErrors: { [req.field!]: "Pick a level." } };
      await s.updateBillingActionLevel(req.field!, level);
      await ctx.audit(`set action level ${req.field} → ${level}`);
      return { ok: true };
    },
  };
}
