import { Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, HubModule, SaveRequest, asBoundedInt, asOptionalId, asString } from "./types";

// General settings — the M0 reference hub that proves the whole spine. Mirrors
// the old /config → General panel (threads channel, GitHub repo, ticket limits).
// All values read/write through SettingsStore.updateGeneral — zero new logic.

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export const generalHub: HubModule = {
  hub: "general",
  group: "config",
  title: "General",

  async buildSections(ctx: AdminHubContext): Promise<Section[]> {
    const s = ctx.settings;
    return [
      {
        key: "general",
        title: "General",
        description: "Core ticketing settings.",
        fields: [
          {
            type: "channel-select",
            key: "threadsChannelId",
            label: "Support threads channel",
            value: s.threadsChannelId(),
            options: ctx.guild.channels(ctx.actor.guildId),
            nullable: true,
            help: "Where new support ticket threads are opened.",
          },
          {
            type: "text",
            key: "githubRepo",
            label: "GitHub repository",
            value: s.githubRepo() ?? "",
            placeholder: "owner/repo",
            help: "Used for issue links. Format: owner/repo. Leave blank to disable.",
          },
          {
            type: "number",
            key: "maxOpenTicketsPerUser",
            label: "Max open tickets per user",
            value: s.maxOpenTicketsPerUser(),
            min: 0,
            max: 100,
            help: "0 = unlimited.",
          },
          {
            type: "number",
            key: "ticketCooldownMinutes",
            label: "Ticket cooldown (minutes)",
            value: s.ticketCooldownMinutes(),
            min: 0,
            max: 1440,
            unit: "min",
            help: "Minimum time between a user's tickets. 0 = no cooldown.",
          },
        ],
      },
    ];
  },

  async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
    const s = ctx.settings;
    switch (req.field) {
      case "threadsChannelId": {
        const id = asOptionalId(req.value);
        await s.updateGeneral({ threadsChannelId: id });
        await ctx.audit(`set threads channel → ${id ?? "none"}`);
        return { ok: true };
      }
      case "githubRepo": {
        const raw = asString(req.value).trim();
        if (raw && !REPO_RE.test(raw)) {
          return { ok: false, fieldErrors: { githubRepo: "Use owner/repo format." } };
        }
        await s.updateGeneral({ githubRepo: raw || null });
        await ctx.audit(`set github repo → ${raw || "none"}`);
        return { ok: true };
      }
      case "maxOpenTicketsPerUser": {
        const parsed = asBoundedInt(req.value, 0, 100);
        if (!parsed.ok) return { ok: false, fieldErrors: { maxOpenTicketsPerUser: parsed.error } };
        await s.updateGeneral({ maxOpenTicketsPerUser: parsed.value });
        await ctx.audit(`set max open tickets/user → ${parsed.value}`);
        return { ok: true };
      }
      case "ticketCooldownMinutes": {
        const parsed = asBoundedInt(req.value, 0, 1440);
        if (!parsed.ok) return { ok: false, fieldErrors: { ticketCooldownMinutes: parsed.error } };
        await s.updateGeneral({ ticketCooldownMinutes: parsed.value });
        await ctx.audit(`set ticket cooldown → ${parsed.value}m`);
        return { ok: true };
      }
      default:
        return { ok: false, error: "Unknown field." };
    }
  },
};
