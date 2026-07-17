import { ActionResult, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest } from "./types";

// Maintenance hub (intercom group): the safe operational tools + link revocation.
// Mirrors /intercom → Maintenance for the ops replicable without the Discord
// per-ticket batch orchestration (backfill/heal/resync/wipe stay in Discord for
// now). Destructive tools require the Discord→web reverse code ("force both").

export function makeMaintenanceHub(deps: {
  resetBridgeData: () => Promise<string>;
  runInactivityNow: () => Promise<string>;
  runSlaNow: () => Promise<string>;
}): HubModule {
  return {
    hub: "maintenance",
    group: "intercom",
    title: "Maintenance",

    async buildSections(): Promise<Section[]> {
      return [
        {
          key: "sweeps",
          title: "Run now",
          fields: [],
          actions: [
            { key: "run_inactivity", label: "Run inactivity sweep now", style: "secondary" },
            { key: "run_sla", label: "Run SLA / assignment sweep now", style: "secondary" },
          ],
        },
        {
          key: "revoke",
          title: "Revoke panel links",
          description: "Instantly invalidates every outstanding link and session for a panel.",
          fields: [],
          actions: [
            { key: "revoke_admin", label: "Revoke admin panel links", dangerous: true, summary: "Logs everyone out of the /config + /intercom web panels (including you)." },
            { key: "revoke_stripe", label: "Revoke Stripe panel links", dangerous: true, summary: "Invalidates every outstanding Stripe-panel link/session." },
          ],
        },
        {
          key: "danger",
          title: "Destructive",
          fields: [],
          notice: { kind: "info", text: "Backfill / heal / resync / wipe remain in the Discord /intercom Maintenance hub for now." },
          actions: [
            { key: "reset_bridge", label: "Reset local bridge data", dangerous: true, reverseConfirm: true, summary: "Wipes local bridge links + message maps (does NOT touch Intercom)." },
          ],
        },
      ];
    },

    async save(): Promise<SaveResult> {
      return { ok: false, error: "No editable fields here." };
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      switch (req.key) {
        case "run_inactivity":
          await ctx.audit("manual inactivity sweep");
          return { ok: true, text: await deps.runInactivityNow() };
        case "run_sla":
          await ctx.audit("manual sla/assignment sweep");
          return { ok: true, text: await deps.runSlaNow() };
        case "revoke_admin": {
          const n = await ctx.settings.bumpAdminPanelEpoch();
          await ctx.audit("revoke admin panel links");
          return { ok: true, text: `Admin panel links revoked (epoch ${n}). Re-run /config for a fresh link.` };
        }
        case "revoke_stripe": {
          const n = await ctx.settings.bumpPanelTokenEpoch();
          await ctx.audit("revoke stripe panel links");
          return { ok: true, text: `Stripe panel links revoked (epoch ${n}).` };
        }
        case "reset_bridge": {
          if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true, error: "Confirm with the Discord code." };
          const text = await deps.resetBridgeData();
          await ctx.audit("reset local bridge data");
          return { ok: true, text };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}
