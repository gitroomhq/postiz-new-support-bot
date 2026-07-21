import { EscalationTierStore } from "../../config/EscalationTierStore";
import { TagInput } from "../../config/SettingsStore";
import { ActionButton, ActionResult, ListField, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asString } from "./types";

// Workflow hub (config group): status Tags + Staff-role tiers. Mirrors
// /config → Workflow. Both are list editors with add/edit/reorder/remove.

const REMINDER_TARGETS = [
  { value: "SUPPORT", label: "Support" },
  { value: "CUSTOMER", label: "Customer" },
];

function tagEditInputs(t: {
  emoji: string;
  label: string;
  reminderTarget: string;
  reminderDays: number;
  autoCloseAfter: number | null;
  isInitial: boolean;
  closesThread: boolean;
  reminderEnabled: boolean;
  isCustomerReplyTarget: boolean;
}): ActionButton["inputs"] {
  return [
    { type: "text", key: "emoji", label: "Emoji", value: t.emoji },
    { type: "text", key: "label", label: "Label", value: t.label },
    { type: "select", key: "reminderTarget", label: "Reminder target", value: t.reminderTarget, options: REMINDER_TARGETS },
    { type: "number", key: "reminderDays", label: "Reminder after (days)", value: t.reminderDays, min: 0, max: 60 },
    { type: "number", key: "autoCloseAfter", label: "Auto-close after (days, blank = never)", value: t.autoCloseAfter, min: 0, max: 365, nullable: true },
    { type: "toggle", key: "isInitial", label: "Initial status for new tickets", value: t.isInitial },
    { type: "toggle", key: "closesThread", label: "Closes the thread", value: t.closesThread },
    { type: "toggle", key: "reminderEnabled", label: "Send reminders", value: t.reminderEnabled },
    { type: "toggle", key: "isCustomerReplyTarget", label: "Customer-reply target", value: t.isCustomerReplyTarget },
  ];
}

export function makeWorkflowHub(deps: { tiers: EscalationTierStore }): HubModule {
  return {
    hub: "workflow",
    group: "config",
    title: "Workflow",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      const tagRows = s.tags().map((t) => {
        const flags = [
          t.isInitial ? "initial" : null,
          t.closesThread ? "closes" : null,
          t.reminderEnabled ? `reminder ${t.reminderDays}d` : null,
          t.isCustomerReplyTarget ? "reply-target" : null,
        ].filter(Boolean).join(" · ");
        return {
          id: t.id,
          cells: [`${t.emoji} ${t.label}`, flags || "N/A"],
          rowActions: [
            { key: "tag_edit", label: "Edit", params: { id: t.id }, inputs: tagEditInputs(t) },
            { key: "tag_up", label: "↑", params: { id: t.id } },
            { key: "tag_down", label: "↓", params: { id: t.id } },
            { key: "tag_del", label: "Delete", params: { id: t.id }, dangerous: true, summary: `Delete ${t.emoji} ${t.label}? Open tickets on it are reassigned.` },
          ] as ActionButton[],
        };
      });
      const tags: ListField = {
        type: "list",
        key: "tags",
        label: "Status tags",
        columns: ["Tag", "Flags"],
        rows: tagRows,
        reorderable: true,
        reorder: { upKey: "tag_up", downKey: "tag_down" },
        addAction: {
          key: "tag_add",
          label: "Add tag",
          inputs: [
            { type: "text", key: "emoji", label: "Emoji", value: "" },
            { type: "text", key: "label", label: "Label", value: "" },
          ],
        },
      };

      const roleMap = new Map(ctx.guild.roles(ctx.actor.guildId).map((r) => [r.value, r.label]));
      const tierRows = deps.tiers.list().map((t) => ({
        id: t.id,
        cells: [t.name, roleMap.get(t.roleId) ? `@${roleMap.get(t.roleId)}` : t.roleId],
        rowActions: [
          { key: "tier_rename", label: "Rename", params: { id: t.id }, inputs: [{ type: "text", key: "name", label: "Name", value: t.name }] },
          { key: "tier_up", label: "↑", params: { id: t.id } },
          { key: "tier_down", label: "↓", params: { id: t.id } },
          { key: "tier_del", label: "Delete", params: { id: t.id }, dangerous: true, summary: `Delete tier ${t.name}?` },
        ] as ActionButton[],
      }));
      const tiers: ListField = {
        type: "list",
        key: "tiers",
        label: "Escalation tiers (staff roles)",
        columns: ["Tier", "Role"],
        rows: tierRows,
        reorderable: true,
        reorder: { upKey: "tier_up", downKey: "tier_down" },
        addAction: {
          key: "tier_add",
          label: "Add tier",
          inputs: [
            { type: "text", key: "name", label: "Tier name", value: "" },
            { type: "role-select", key: "roleId", label: "Role", value: null, options: ctx.guild.roles(ctx.actor.guildId) },
          ],
        },
      };

      return [
        { key: "tags", title: "Status tags", fields: [tags] },
        { key: "tiers", title: "Staff roles", fields: [tiers] },
      ];
    },

    async save(_ctx: AdminHubContext, _req: SaveRequest): Promise<SaveResult> {
      return { ok: false, error: "Use the row actions." };
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      const s = ctx.settings;
      const p = req.params ?? {};
      const id = asString(p.id);
      switch (req.key) {
        case "tag_add": {
          const emoji = asString(p.emoji).trim();
          const label = asString(p.label).trim();
          if (!emoji || !label) return { ok: false, error: "Emoji and label are required." };
          await s.addTag({ emoji, label });
          await ctx.audit(`add tag ${emoji} ${label}`);
          return { ok: true, text: "Tag added." };
        }
        case "tag_edit": {
          const patch: Partial<TagInput> = {
            emoji: asString(p.emoji).trim(),
            label: asString(p.label).trim(),
            reminderTarget: (p.reminderTarget === "CUSTOMER" ? "CUSTOMER" : "SUPPORT") as TagInput["reminderTarget"],
            reminderDays: numOr(p.reminderDays, 3),
            autoCloseAfter: p.autoCloseAfter == null || p.autoCloseAfter === "" ? null : numOr(p.autoCloseAfter, 0),
            isInitial: p.isInitial === true,
            closesThread: p.closesThread === true,
            reminderEnabled: p.reminderEnabled === true,
            isCustomerReplyTarget: p.isCustomerReplyTarget === true,
          };
          await s.editTag(id, patch);
          await ctx.audit(`edit tag ${id}`);
          return { ok: true, text: "Tag updated." };
        }
        case "tag_up":
        case "tag_down":
          await s.moveTag(id, req.key === "tag_up" ? "up" : "down");
          return { ok: true, text: "Reordered." };
        case "tag_del":
          await s.removeTag(id);
          await ctx.audit(`delete tag ${id}`);
          return { ok: true, text: "Tag deleted." };
        case "tier_add": {
          const name = asString(p.name).trim();
          const roleId = asString(p.roleId);
          if (!name || !roleId) return { ok: false, error: "Name and role are required." };
          await deps.tiers.add(name, roleId);
          await ctx.audit(`add tier ${name}`);
          return { ok: true, text: "Tier added." };
        }
        case "tier_rename": {
          const name = asString(p.name).trim();
          if (!name) return { ok: false, error: "Name required." };
          await deps.tiers.rename(id, name);
          await ctx.audit(`rename tier ${id}`);
          return { ok: true, text: "Tier renamed." };
        }
        case "tier_up":
        case "tier_down":
          await deps.tiers.move(id, req.key === "tier_up" ? -1 : 1);
          return { ok: true, text: "Reordered." };
        case "tier_del":
          await deps.tiers.remove(id);
          await ctx.audit(`delete tier ${id}`);
          return { ok: true, text: "Tier deleted." };
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

function numOr(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
