import { ActionResult, Opt, SaveResult, Section } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asString } from "./types";
import type { QueueExclusions } from "../../config/SettingsStore";
import { queueReadiness, QUEUE_CLIENT_ID_RE, QUEUE_CLIENT_SECRET_RE, type QueueExclusionKind } from "../../queue/queueConfig";

// Queue hub (intercom group): the Intercom Queue web page (/queue). Mirrors
// /intercom → Queue: kill switch, the OAuth app it signs in with (the client
// secret is write-only), what counts as a reply, exclusions, and signing
// everyone out.

type Named = { id: string; name: string };

const EXCLUSION_FIELDS: Record<string, QueueExclusionKind> = {
  queueExcludedTeams: "teams",
  queueExcludedTags: "tags",
  queueExcludedTicketTypes: "ticketTypes",
};

export function makeQueueHub(deps: {
  listTeams: () => Promise<Named[]>;
  listTags: () => Promise<Named[]>;
  listTicketTypes: () => Promise<Array<Named & { category?: string | null }>>;
  liveSessions: () => Promise<number>;
  signOutAll: () => Promise<number>;
}): HubModule {
  const options = async (kind: QueueExclusionKind): Promise<Named[]> => {
    if (kind === "teams") return deps.listTeams();
    if (kind === "tags") return deps.listTags();
    return (await deps.listTicketTypes()).filter((t) => (t.category ?? "Customer") === "Customer");
  };
  const toOpts = (list: Named[]): Opt[] =>
    [...list].sort((a, b) => a.name.localeCompare(b.name)).map((o) => ({ value: o.id, label: o.name }));

  return {
    hub: "queue",
    group: "intercom",
    title: "Queue",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      const ready = queueReadiness(s);
      const live = await deps.liveSessions().catch(() => null);
      const x = s.queueExclusions();
      const lists: Partial<Record<QueueExclusionKind, Opt[]>> = {};
      const errors: string[] = [];
      for (const kind of ["teams", "tags", "ticketTypes"] as const) {
        try {
          lists[kind] = toOpts(await options(kind));
        } catch {
          errors.push(kind === "ticketTypes" ? "ticket types" : kind);
          // Keep what is saved selectable (and visible) without Intercom.
          lists[kind] = toOpts(x[kind]);
        }
      }
      return [
        {
          key: "queue",
          title: "Intercom Queue",
          description:
            "A web page of the tickets that wait on a reply from the team, per inbox, per teammate and for the whole workspace, each with All, Longest waiting and a Randomizer. Teammates sign in with their Intercom account (any teammate with an inbox seat); the page reads Intercom with the bridge's own token. Create the OAuth app in Intercom: Developer Hub → New app → Authentication: tick Use OAuth and add the redirect URL below; Permissions: Read admins only.",
          ...(ready.ok ? {} : { notice: { kind: "warn" as const, text: `Sign-in not ready: ${ready.missing.join("; ")}` } }),
          fields: [
            { type: "toggle", key: "queueEnabled", label: "Enabled", value: s.queueEnabled(), help: "Off: every /queue route answers 404." },
            { type: "static", key: "queuePage", label: "Page", value: ready.pageUrl ?? "Needs an https public URL" },
            {
              type: "static",
              key: "queueCallback",
              label: "OAuth redirect URL",
              value: ready.callbackUrl ?? "Needs an https public URL",
              help: "Register exactly this URL in the OAuth app's Authentication page.",
            },
            {
              type: "text",
              key: "queueOauthClientId",
              label: "OAuth client ID",
              value: s.queueOauthClientId() ?? "",
              maxLength: 100,
              help: "Developer Hub → your queue app → Basic information. Blank clears it.",
            },
            {
              type: "text",
              key: "queueOauthClientSecret",
              label: "OAuth client secret",
              value: "",
              secret: true,
              secretState: s.secretState("queueOauthClientSecret"),
              help: "Write-only. Blank = keep; type 'none' to clear.",
            },
            { type: "static", key: "queueLive", label: "Signed in now", value: live == null ? "unknown" : String(live) },
          ],
          actions: [
            {
              key: "queue_sign_out_all",
              label: "Sign everyone out",
              style: "danger",
              dangerous: true,
              summary: "Every open queue session ends at once; teammates sign in with Intercom again.",
            },
          ],
        },
        {
          key: "queueReplies",
          title: "What counts as a reply",
          description:
            "A teammate's message always counts (and a Discord staff message on a bridged ticket). Waiting on customer and Resolved tickets are never listed; snoozed ones only behind the page's Snoozed filter.",
          fields: [
            { type: "toggle", key: "queueFinCountsAsReply", label: "Fin replies count as a reply", value: s.queueFinCountsAsReply() },
            {
              type: "toggle",
              key: "queueNotesCountAsReply",
              label: "Internal notes count as a reply",
              value: s.queueNotesCountAsReply(),
              help: "Only notes by people; the bot's own notes (SLA, reminders) never count.",
            },
          ],
        },
        {
          key: "queueExclusions",
          title: "Exclusions",
          description: "Conversations in these team inboxes, with these tags or of these ticket types never appear in the queue.",
          ...(errors.length ? { notice: { kind: "warn" as const, text: `Could not list ${errors.join(", ")} from Intercom; only saved picks are shown.` } } : {}),
          fields: [
            { type: "multiselect", key: "queueExcludedTeams", label: "Excluded teams", values: x.teams.map((e) => e.id), options: lists.teams ?? [] },
            { type: "multiselect", key: "queueExcludedTags", label: "Excluded tags", values: x.tags.map((e) => e.id), options: lists.tags ?? [] },
            {
              type: "multiselect",
              key: "queueExcludedTicketTypes",
              label: "Excluded ticket types",
              values: x.ticketTypes.map((e) => e.id),
              options: lists.ticketTypes ?? [],
            },
          ],
        },
      ];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      switch (req.field) {
        case "queueEnabled":
          await s.updateQueue({ queueEnabled: v === true });
          await ctx.audit(`intercom queue → ${v === true ? "on" : "off"}`);
          return { ok: true };
        case "queueFinCountsAsReply":
          await s.updateQueue({ queueFinCountsAsReply: v === true });
          await ctx.audit(`intercom queue: fin replies count → ${v === true}`);
          return { ok: true };
        case "queueNotesCountAsReply":
          await s.updateQueue({ queueNotesCountAsReply: v === true });
          await ctx.audit(`intercom queue: internal notes count → ${v === true}`);
          return { ok: true };
        case "queueOauthClientId": {
          const val = asString(v).trim();
          if (val && !QUEUE_CLIENT_ID_RE.test(val)) {
            return { ok: false, fieldErrors: { queueOauthClientId: "That does not look like an Intercom client ID (letters, digits and dashes)." } };
          }
          await s.updateQueue({ queueOauthClientId: val || null });
          await ctx.audit(val ? "set intercom queue oauth client id" : "cleared intercom queue oauth client id");
          return { ok: true };
        }
        case "queueOauthClientSecret": {
          const val = asString(v).trim();
          if (!val) return { ok: true }; // blank = keep
          if (val !== "none" && !QUEUE_CLIENT_SECRET_RE.test(val)) {
            return { ok: false, fieldErrors: { queueOauthClientSecret: "That does not look like an Intercom client secret." } };
          }
          await s.updateQueue({ queueOauthClientSecret: val === "none" ? null : val });
          await ctx.audit(val === "none" ? "cleared intercom queue oauth client secret" : "updated intercom queue oauth client secret");
          return { ok: true };
        }
        default: {
          const kind = req.field ? EXCLUSION_FIELDS[req.field] : undefined;
          if (!kind) return { ok: false, error: "Unknown field." };
          const wanted = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
          if (!wanted) return { ok: false, fieldErrors: { [req.field!]: "Pick from the list." } };
          const current = s.queueExclusions();
          let known: Named[];
          try {
            known = await options(kind);
          } catch {
            // Intercom unreachable: only removals of saved picks are possible.
            known = current[kind];
          }
          // Only ids Intercom lists (or already saved) are accepted.
          const byId = new Map([...current[kind], ...known].map((o) => [o.id, o.name]));
          const picked = [...new Set(wanted)].filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)! }));
          const next: QueueExclusions = { ...current, [kind]: picked };
          await s.updateQueue({ queueExclusions: next });
          await ctx.audit(`intercom queue excluded ${kind} → ${picked.length ? picked.map((p) => p.name).join(", ").slice(0, 500) : "none"}`);
          return { ok: true };
        }
      }
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      if (req.key === "queue_sign_out_all") {
        // dangerous: the typed CONFIRM is re-checked server-side.
        if (req.confirmWord !== "CONFIRM") return { ok: false, error: "Type CONFIRM to sign everyone out." };
        const n = await deps.signOutAll();
        await ctx.audit(`intercom queue: everyone signed out (${n} session(s))`);
        return { ok: true, text: `Everyone is signed out (${n} session(s) ended).` };
      }
      return { ok: false, error: "Unknown action." };
    },
  };
}
