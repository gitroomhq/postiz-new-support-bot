import { IntercomMode } from "../../config/SettingsStore";
import { Opt, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, HubModule, SaveRequest, asOptionalId, oneOf } from "./types";

// Bridge hub (intercom group): bridge mode + routing team + snooze tag mapping.
// Mirrors /intercom → Bridge (core). Ticket-type / state maps and the
// preflight/gap-heal orchestration remain a follow-up.

const MODES = ["none", "push", "bi"] as const;
const MODE_OPTS: Opt[] = [
  { value: "none", label: "Off" },
  { value: "push", label: "Push (Discord → Intercom)" },
  { value: "bi", label: "Bidirectional" },
];

export function makeBridgeHub(deps: {
  listTeams: () => Promise<Array<{ id: string; name: string }>>;
  listTags: () => Promise<Array<{ id: string; name: string }>>;
}): HubModule {
  return {
    hub: "bridge",
    group: "intercom",
    title: "Bridge",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      let teamOpts: Opt[] = [];
      let tagOpts: Opt[] = [];
      let note: string | undefined;
      try {
        teamOpts = (await deps.listTeams()).map((t) => ({ value: t.id, label: t.name }));
        tagOpts = (await deps.listTags()).map((t) => ({ value: t.id, label: t.name }));
      } catch {
        note = "Intercom lists unavailable — check the access token.";
      }
      return [
        {
          key: "bridge",
          title: "Bridge",
          notice: note ? { kind: "warn", text: note } : undefined,
          fields: [
            { type: "select", key: "intercomMode", label: "Mode", value: s.intercomMode(), options: MODE_OPTS, help: "Push/Bidirectional need a valid access token + authoring admin." },
            { type: "select", key: "intercomTeamId", label: "Routing team (new conversations)", value: s.intercomTeamId(), options: teamOpts, nullable: true },
            { type: "select", key: "intercomSnoozeStatusTagId", label: "Snooze status tag", value: s.intercomSnoozeStatusTagId(), options: tagOpts, nullable: true },
          ],
        },
      ];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      switch (req.field) {
        case "intercomMode": {
          const mode = oneOf<IntercomMode>(v, MODES);
          if (!mode) return { ok: false, fieldErrors: { intercomMode: "Pick a mode." } };
          await s.setIntercomMode(mode);
          await ctx.audit(`set bridge mode → ${mode}`);
          return { ok: true };
        }
        case "intercomTeamId":
          await s.updateIntercom({ intercomTeamId: asOptionalId(v) });
          await ctx.audit("set routing team");
          return { ok: true };
        case "intercomSnoozeStatusTagId":
          await s.updateIntercom({ intercomSnoozeStatusTagId: asOptionalId(v) });
          await ctx.audit("set snooze tag");
          return { ok: true };
        default:
          return { ok: false, error: "Unknown field." };
      }
    },
  };
}
