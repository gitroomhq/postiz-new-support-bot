import type { SupportCredential, SupportLookup } from "../../generated/prisma/client";
import { ActionResult, SaveResult, Section } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest } from "./types";

// Support Dashboard hub (config group): the /support page. Kill switch,
// signing everyone out, resetting a teammate's password, and the log of which
// customer each teammate opened.

const PAGE_SIZE = 10;
const DISCORD_ID_RE = /^\d{15,21}$/;

export function makeSupportHub(deps: {
  liveSessions: () => Promise<number>;
  signOutAll: () => Promise<number>;
  listPasswords: (offset: number, limit: number) => Promise<{ rows: SupportCredential[]; total: number }>;
  resetPassword: (discordUserId: string) => Promise<{ removed: boolean; sessions: number }>;
  listLookups: (offset: number, limit: number) => Promise<{ rows: SupportLookup[]; total: number }>;
  pageUrl: () => string | null;
}): HubModule {
  return {
    hub: "support",
    group: "config",
    title: "Support Dashboard",

    async buildSections(ctx, opts): Promise<Section[]> {
      const s = ctx.settings;
      const pwOffset = offsetFor(opts.cursor, "pw");
      const logOffset = offsetFor(opts.cursor, "log");
      const [live, passwords, lookups] = await Promise.all([
        deps.liveSessions().catch(() => null),
        deps.listPasswords(pwOffset, PAGE_SIZE),
        deps.listLookups(logOffset, PAGE_SIZE),
      ]);
      return [
        {
          key: "support",
          title: "Support dashboard",
          description: "Change requests from /support wait for an admin in /billing → Approvals.",
          fields: [
            { type: "toggle", key: "supportDashEnabled", label: "Enabled", value: s.supportDashEnabled(), help: "Off: every /support route answers 404 and /support in Discord refuses." },
            { type: "static", key: "supportPage", label: "Page", value: deps.pageUrl() ?? "Needs an https public URL" },
            { type: "static", key: "supportLive", label: "Signed in", value: live == null ? "Unknown" : `${live} session(s)` },
          ],
          actions: [
            {
              key: "support_sign_out_all",
              label: "Sign everyone out",
              style: "danger",
              dangerous: true,
              summary: "Ends every support dashboard session now. Passwords stay.",
            },
          ],
        },
        {
          key: "supportPasswords",
          title: "Passwords",
          fields: [
            {
              type: "list",
              key: "supportPasswordList",
              label: "Teammates with a password",
              columns: ["Name", "Discord ID", "Set", "Last sign-in"],
              rows: passwords.rows.map((r) => ({
                id: r.discordUserId,
                cells: [r.name, r.discordUserId, day(r.createdAt), r.lastLoginAt ? day(r.lastLoginAt) : "Never"],
                rowActions: [
                  {
                    key: "support_reset_password",
                    label: "Reset password",
                    style: "danger",
                    dangerous: true,
                    params: { id: r.discordUserId },
                    summary: `Removes ${r.name}'s password and ends their sessions. They choose a new one at their next sign-in.`,
                  },
                ],
              })),
              ...pager("pw", pwOffset, passwords.total),
            },
          ],
        },
        {
          key: "supportLookups",
          title: "Lookup log",
          description: "Kept 180 days.",
          fields: [
            {
              type: "list",
              key: "supportLookupList",
              label: "Lookups",
              columns: ["When", "Teammate", "Customer", "Found by"],
              rows: lookups.rows.map((r) => ({
                id: r.id,
                cells: [stamp(r.createdAt), r.actorName, r.customerName ? `${r.customerName} (${r.customerId})` : r.customerId, VIA_LABEL[r.via] ?? r.via],
                rowActions: [],
              })),
              ...pager("log", logOffset, lookups.total),
            },
          ],
        },
      ];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      if (req.field === "supportDashEnabled") {
        const on = req.value === true;
        await ctx.settings.updateSupportDash({ supportDashEnabled: on });
        await ctx.audit(`support dashboard ${on ? "enabled" : "disabled"}`);
        return { ok: true };
      }
      return { ok: false, error: "Unknown field." };
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      if (req.key === "support_sign_out_all") {
        if (req.confirmWord !== "CONFIRM") return { ok: false, error: "Type CONFIRM to sign everyone out." };
        const n = await deps.signOutAll();
        await ctx.audit(`support dashboard: everyone signed out (${n} session(s))`);
        return { ok: true, text: `Everyone is signed out (${n} session(s) ended).` };
      }
      if (req.key === "support_reset_password") {
        if (req.confirmWord !== "CONFIRM") return { ok: false, error: "Type CONFIRM to reset the password." };
        const id = typeof req.params?.id === "string" && DISCORD_ID_RE.test(req.params.id) ? req.params.id : null;
        if (!id) return { ok: false, error: "Bad request." };
        const res = await deps.resetPassword(id);
        await ctx.audit(`support dashboard: password reset for ${id} (${res.sessions} session(s) ended)`);
        return { ok: true, text: res.removed ? "Password removed. They choose a new one at their next sign-in." : "They had no password." };
      }
      return { ok: false, error: "Unknown action." };
    },
  };
}

const VIA_LABEL: Record<string, string> = { email: "Email", customer: "Customer ID", postiz: "Postiz", card: "Card", link: "Link" };

function offsetFor(cursor: string | undefined, list: string): number {
  const m = /^([a-z]+):(\d{1,6})$/.exec(cursor ?? "");
  return m && m[1] === list ? Number(m[2]) : 0;
}

function pager(list: string, offset: number, total: number): { nextCursor?: string | null; prevCursor?: string | null } {
  if (total <= PAGE_SIZE) return {};
  return {
    nextCursor: offset + PAGE_SIZE < total ? `${list}:${offset + PAGE_SIZE}` : null,
    prevCursor: offset > 0 ? `${list}:${Math.max(0, offset - PAGE_SIZE)}` : null,
  };
}

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function stamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
