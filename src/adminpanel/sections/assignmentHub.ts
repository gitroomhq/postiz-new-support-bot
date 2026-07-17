import { DEFAULT_SETTINGS_SCOPE } from "../../config/SettingsStore";
import { ActionButton, ActionResult, Opt, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asString } from "./types";

// Assignment hub (intercom group, PER-TEAM): bot-driven balanced assignment,
// scoped to the workspace default or a specific team (workspace-default
// fallback). Mirrors /intercom → Assignment.

export function makeAssignmentHub(deps: {
  listTeams: () => Promise<Array<{ id: string; name: string }>>;
  listIntercomAdmins: () => Promise<Array<{ id: string; name: string }>>;
  runSlaNow: () => Promise<string>;
}): HubModule {
  const teamIdOf = (scope?: string): string | null =>
    !scope || scope === DEFAULT_SETTINGS_SCOPE ? null : scope;

  return {
    hub: "assignment",
    group: "intercom",
    title: "Assignment",

    async buildScope(_ctx, { scope }): Promise<{ key: string; label: string; options: Opt[]; value: string }> {
      let teams: Array<{ id: string; name: string }> = [];
      try {
        teams = await deps.listTeams();
      } catch {
        /* leave empty */
      }
      const options: Opt[] = [{ value: DEFAULT_SETTINGS_SCOPE, label: "Workspace default" }, ...teams.map((t) => ({ value: t.id, label: t.name }))];
      return { key: "scope", label: "Scope", options, value: scope || DEFAULT_SETTINGS_SCOPE };
    },

    async buildSections(ctx, { scope }): Promise<Section[]> {
      const s = ctx.settings;
      const teamId = teamIdOf(scope);
      let adminOpts: Opt[] = [];
      try {
        adminOpts = (await deps.listIntercomAdmins()).map((a) => ({ value: a.id, label: a.name }));
      } catch {
        /* leave empty */
      }
      const excluded = s.resolveAssignExcludedAdmins(teamId).map((a) => a.id);
      const actions: ActionButton[] = [{ key: "run_sla", label: "Run stray sweep now", style: "secondary" }];
      if (teamId) actions.push({ key: "revert", label: "Revert to workspace default", dangerous: true, summary: "Drops this team's assignment override." });
      return [
        {
          key: "assignment",
          title: teamId ? "Team assignment" : "Workspace-default assignment",
          description: teamId ? "Overrides the workspace default for this team. Blank fields inherit the default." : undefined,
          fields: [
            { type: "toggle", key: "assignEnabled", label: "Balanced assignment enabled", value: s.resolveAssignEnabled(teamId) },
            { type: "multiselect", key: "assignExcludedAdmins", label: "Excluded teammates (benched)", values: excluded, options: adminOpts },
          ],
          actions,
        },
      ];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const scope = req.scope || DEFAULT_SETTINGS_SCOPE;
      switch (req.field) {
        case "assignEnabled":
          await ctx.settings.updateAssignmentScoped(scope, null, { assignEnabled: req.value === true });
          await ctx.audit(`assignment enabled (${scope}) → ${req.value === true}`);
          return { ok: true };
        case "assignExcludedAdmins": {
          const ids = Array.isArray(req.value) ? (req.value as unknown[]).map(String) : [];
          let all: Array<{ id: string; name: string }> = [];
          try {
            all = await deps.listIntercomAdmins();
          } catch {
            return { ok: false, error: "Could not load the teammate list." };
          }
          const selected = all.filter((a) => ids.includes(a.id));
          await ctx.settings.updateAssignmentScoped(scope, null, { assignExcludedAdmins: selected });
          await ctx.audit(`assignment exclusions (${scope}) → ${selected.length}`);
          return { ok: true };
        }
        default:
          return { ok: false, error: "Unknown field." };
      }
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      switch (req.key) {
        case "run_sla":
          await ctx.audit("manual stray sweep");
          return { ok: true, text: await deps.runSlaNow() };
        case "revert": {
          const teamId = teamIdOf(req.scope);
          if (!teamId) return { ok: false, error: "Nothing to revert on the workspace default." };
          await ctx.settings.clearTeamAssignOverride(teamId);
          await ctx.audit(`revert team assignment override ${teamId}`);
          return { ok: true, text: "Reverted to workspace default." };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}
