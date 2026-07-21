import { DashboardAdminRole } from "../../config/SettingsStore";
import { ActionResult, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, HubModule, SaveRequest, asBool } from "./types";

// Dashboard hub (config group): the Discord-anchored control surface for the
// Stripe dashboard (/dashboard). Enable/disable, the allowlist, and the
// emergency levers live HERE — the dashboard itself may only ever reduce its
// own privilege (ratchet asymmetry), never re-enable or restore.

const DISCORD_ID_RE = /^\d{15,21}$/;

export function makeDashboardHub(deps: { resetCredentials: (userId: string) => Promise<number> }): HubModule {
  return {
    hub: "dashboard",
    group: "config",
    title: "Billing Dashboard",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      const admins = s.dashboardAdmins();
      const enabled: Section = {
        key: "state",
        title: "Stripe dashboard",
        description:
          "The account-wide billing dashboard at /dashboard. Open it from /billing → Open Web Dashboard. " +
          "While disabled, the routes answer 404 and no links can be minted.",
        fields: [
          {
            type: "toggle",
            key: "dashboardEnabled",
            label: "Enable the web dashboard",
            value: s.dashboardEnabled(),
            help: "Re-enabling always happens here. A dashboard session can disable but never enable.",
          },
          {
            type: "static",
            key: "dashboardEpoch",
            label: "Revocation epoch",
            value: String(s.dashboardEpoch()),
            help: "Bumping it (Revoke dashboard links) instantly kills every outstanding link and session.",
          },
        ],
        actions: [
          {
            key: "dash_revoke",
            label: "Revoke dashboard links + sessions",
            style: "danger",
            dangerous: true,
            summary: "Bumps the dashboard epoch: every outstanding link and live session dies immediately.",
          },
          {
            key: "dash_lockdown",
            label: "LOCKDOWN dashboard",
            style: "danger",
            dangerous: true,
            reverseConfirm: true,
            summary:
              "Disables the dashboard AND bumps the epoch: the surface goes dark instantly. " +
              "Re-enable it afterwards with the toggle above.",
          },
          {
            key: "dash_reset_mine",
            label: "Reset MY dashboard credentials",
            style: "danger",
            dangerous: true,
            summary:
              "Lost a device? Revokes ALL of your dashboard credentials (passkeys, authenticator, passphrase) " +
              "and every session, then re-enroll via /billing → Open Web Dashboard → Security.",
          },
        ],
      };

      const allowlist: Section = {
        key: "admins",
        title: "Dashboard admins",
        description:
          "Who may open the dashboard (Discord user ids are the authority; checked on every request). " +
          "Role: admin = full authority per the billing action levels; operator = read-only + queued actions.",
        fields: [
          {
            type: "list",
            key: "dashboardAdmins",
            label: "Allowlist",
            columns: ["Name", "Discord id", "Role"],
            rows: admins.map((a) => ({
              id: a.id,
              cells: [a.name, a.id, { kind: a.role === "admin" ? "info" : "warn", text: a.role }],
              rowActions: [
                {
                  key: "dash_role",
                  label: a.role === "admin" ? "Make operator" : "Make admin",
                  params: { id: a.id },
                },
                { key: "dash_remove", label: "Remove", style: "danger", dangerous: true, params: { id: a.id } },
              ],
            })),
            addAction: {
              key: "dash_add",
              label: "Add admin",
              style: "primary",
              inputs: [
                { type: "text", key: "id", label: "Discord user id", value: "", placeholder: "e.g. 123456789012345678" },
                { type: "text", key: "name", label: "Display name (for audit logs)", value: "" },
                {
                  type: "select",
                  key: "role",
                  label: "Role",
                  value: "admin",
                  options: [
                    { value: "admin", label: "Admin (full authority)" },
                    { value: "operator", label: "Operator (read-only + queued actions)" },
                  ],
                },
              ],
              summary: "Adds a Discord user to the dashboard allowlist. They also need the Discord Administrator permission to mint links.",
            },
          },
        ],
      };

      return [enabled, allowlist];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      if (req.field === "dashboardEnabled") {
        const on = asBool(req.value);
        await ctx.settings.updateDashboardEnabled(on);
        await ctx.audit(`dashboard ${on ? "enabled" : "disabled"}`);
        return { ok: true };
      }
      return { ok: false, error: "Unknown field." };
    },

    async action(ctx: AdminHubContext, req): Promise<ActionResult> {
      const s = ctx.settings;
      switch (req.key) {
        case "dash_add": {
          const id = typeof req.params?.id === "string" ? req.params.id.trim() : "";
          const name = typeof req.params?.name === "string" ? req.params.name.trim() : "";
          const role: DashboardAdminRole = req.params?.role === "operator" ? "operator" : "admin";
          if (!DISCORD_ID_RE.test(id)) return { ok: false, fieldErrors: { id: "That is not a Discord user id." } };
          const admins = s.dashboardAdmins();
          if (admins.some((a) => a.id === id)) return { ok: false, error: "Already on the allowlist." };
          admins.push({ id, name: name || id, role });
          await s.updateDashboardAdmins(admins);
          await ctx.audit(`dashboard admin added: ${name || id} (${role})`);
          return { ok: true, text: "Added." };
        }
        case "dash_role": {
          const id = typeof req.params?.id === "string" ? req.params.id : "";
          const admins = s.dashboardAdmins();
          const entry = admins.find((a) => a.id === id);
          if (!entry) return { ok: false, error: "Not on the allowlist." };
          entry.role = entry.role === "admin" ? "operator" : "admin";
          await s.updateDashboardAdmins(admins);
          await ctx.audit(`dashboard role ${entry.name} → ${entry.role}`);
          return { ok: true, text: `Now ${entry.role}.` };
        }
        case "dash_remove": {
          const id = typeof req.params?.id === "string" ? req.params.id : "";
          const admins = s.dashboardAdmins();
          const entry = admins.find((a) => a.id === id);
          if (!entry) return { ok: false, error: "Not on the allowlist." };
          await s.updateDashboardAdmins(admins.filter((a) => a.id !== id));
          await ctx.audit(`dashboard admin removed: ${entry.name}`);
          return { ok: true, text: "Removed. Their live sessions die on the next request." };
        }
        case "dash_revoke": {
          const epoch = await s.bumpDashboardEpoch();
          await ctx.audit(`dashboard links revoked (epoch ${epoch})`);
          return { ok: true, text: `Revoked. Dashboard epoch is now ${epoch}.` };
        }
        case "dash_lockdown": {
          if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true };
          await s.updateDashboardEnabled(false);
          const epoch = await s.bumpDashboardEpoch();
          await ctx.audit(`dashboard LOCKDOWN (disabled + epoch ${epoch})`);
          return { ok: true, text: "Dashboard locked down: disabled + all links/sessions revoked." };
        }
        case "dash_reset_mine": {
          const count = await deps.resetCredentials(ctx.actor.id);
          await ctx.audit(`dashboard credentials self-reset (${count} revoked)`);
          return { ok: true, text: `Revoked ${count} credential(s) + all dashboard sessions. Re-enroll via the dashboard's Security page.` };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}
