import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { SettingsStore, BillingActionLevel } from "../config/SettingsStore";
import { BILLING_ACTIONS, actionByKey } from "./billing/actions/ActionRegistry";
import type { IntercomAdmin } from "../intercom/types";

// /config → Billing → Intercom Actions / Intercom Admins panel builders.
// Pure builders (no I/O) so DiscordBot's config router stays thin. Custom-id
// map (all admin-gated by handleConfigButton's existing check):
//   config_bact                     → levels list, page 0
//   config_bact_page:<n>            → levels list, page n
//   config_bact_pick:<n>            → select an action on page n
//   config_bact_view:<key>:<n>      → per-action panel (back returns to page n)
//   config_bact_set:<key>:<level>:<n> → set the level, re-render
//   config_badm                     → admins panel, page 0
//   config_badm_page:<n>            → admins panel, page n
//   config_badm_pick:<n>            → teammate multi-select on page n

export const ACTIONS_PAGE_SIZE = 10;
export const ADMINS_PAGE_SIZE = 25; // Discord select-menu option cap

const LEVEL_LABEL: Record<BillingActionLevel, string> = {
  none: "None (disabled for everyone)",
  approval: "Agent Approval",
  admin: "Admin Only (agents denied)",
  all: "All (agents direct)",
};

function sortedActions() {
  // Group order keeps the list scannable; registry order within a group.
  const groupOrder = ["Reviews", "Charges", "Subscriptions", "Invoices", "Customer"];
  return [...BILLING_ACTIONS].sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
}

export function buildActionLevelsPanel(settings: SettingsStore, page: number, backTarget = "config_billing") {
  const actions = sortedActions();
  const pages = Math.max(1, Math.ceil(actions.length / ACTIONS_PAGE_SIZE));
  const clamped = Math.min(Math.max(page, 0), pages - 1);
  const slice = actions.slice(clamped * ACTIONS_PAGE_SIZE, (clamped + 1) * ACTIONS_PAGE_SIZE);

  const lines = slice.map((def) => {
    const stored = settings.billingActionLevels()[def.key];
    const level = settings.billingActionLevel(def.key, def.defaultLevel);
    const suffix = stored === undefined ? " _(default)_" : "";
    return `**${def.group} · ${def.label}** — ${LEVEL_LABEL[level]}${suffix}`;
  });

  const embed = new EmbedBuilder()
    .setTitle("Intercom Billing Actions")
    .setColor(0x5865f2)
    .setDescription(
      [
        "Access level per canvas/panel action. **None disables the action for everyone, including admins.**",
        "Agent Approval: agents queue for admin approval, admins execute directly. All: agents execute directly too.",
        "Default is None for every action except Charge review (Agent Approval).",
        "",
        ...lines,
      ].join("\n")
    )
    .setFooter({ text: `Page ${clamped + 1}/${pages} — pick an action below to change its level` });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`config_bact_pick:${clamped}`)
    .setPlaceholder("Pick an action to configure")
    .addOptions(
      slice.map((def) => ({
        label: def.label.slice(0, 100),
        description: `${def.group} — ${LEVEL_LABEL[settings.billingActionLevel(def.key, def.defaultLevel)]}`.slice(0, 100),
        value: def.key,
      }))
    );

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`config_bact_page:${clamped - 1}`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clamped <= 0),
    new ButtonBuilder()
      .setCustomId(`config_bact_page:${clamped + 1}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clamped >= pages - 1),
    new ButtonBuilder().setCustomId(backTarget).setLabel("Back").setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), nav],
  };
}

export function buildActionDetailPanel(settings: SettingsStore, key: string, page: number) {
  const def = actionByKey(key);
  if (!def) return buildActionLevelsPanel(settings, page);
  const current = settings.billingActionLevel(def.key, def.defaultLevel);
  const stored = settings.billingActionLevels()[def.key];

  const embed = new EmbedBuilder()
    .setTitle(`Action: ${def.label}`)
    .setColor(0x5865f2)
    .setDescription(
      [
        `**Group:** ${def.group}`,
        `**Current level:** ${LEVEL_LABEL[current]}${stored === undefined ? " _(default)_" : ""}`,
        `**Registry default:** ${LEVEL_LABEL[def.defaultLevel]}`,
        def.dangerous ? "**Dangerous:** panel requires typed CONFIRM." : "",
        "",
        "None — nobody can run it (admins included).",
        "Agent Approval — agents queue for admin approval; admins execute directly.",
        "Admin Only — admins execute directly; agents get nothing (not even a queue request).",
        "All — agents execute directly too.",
      ]
        .filter(Boolean)
        .join("\n")
    );

  const levelButton = (level: BillingActionLevel, label: string) =>
    new ButtonBuilder()
      .setCustomId(`config_bact_set:${def.key}:${level}:${page}`)
      .setLabel(label)
      .setStyle(current === level ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(current === level);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    levelButton("none", "None"),
    levelButton("approval", "Agent Approval"),
    levelButton("admin", "Admin Only"),
    levelButton("all", "All"),
    new ButtonBuilder().setCustomId(`config_bact_page:${page}`).setLabel("Back").setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

export function buildIntercomAdminsPanel(
  settings: SettingsStore,
  teammates: IntercomAdmin[] | null, // null = fetch failed
  page: number
, backTarget = "config_billing") {
  const marked = settings.intercomPanelAdmins();
  const lines =
    marked.length > 0
      ? marked.map((a) => `• **${a.name}** (\`${a.id}\`)`)
      : ["_none — nobody can approve or execute admin-gated actions from Intercom (Discord /billing still works)_"];

  const embed = new EmbedBuilder()
    .setTitle("Intercom Billing Admins")
    .setColor(0x5865f2)
    .setDescription(
      [
        "Teammates marked here count as **admins** for canvas/panel billing actions: they execute directly where the level is Agent Approval and act on the approval queue.",
        "Everyone else with inbox access is a support agent.",
        "",
        "**Currently marked:**",
        ...lines,
      ].join("\n")
    );

  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
  let pages = 1;
  let clamped = 0;
  if (teammates === null) {
    embed.addFields({
      name: "Teammate list unavailable",
      value: "Could not fetch the workspace teammates from Intercom — check the Intercom connection in /config → Intercom.",
    });
  } else if (teammates.length === 0) {
    embed.addFields({ name: "No teammates", value: "The Intercom workspace returned no teammates." });
  } else {
    pages = Math.max(1, Math.ceil(teammates.length / ADMINS_PAGE_SIZE));
    clamped = Math.min(Math.max(page, 0), pages - 1);
    const slice = teammates.slice(clamped * ADMINS_PAGE_SIZE, (clamped + 1) * ADMINS_PAGE_SIZE);
    const markedIds = new Set(marked.map((a) => a.id));
    const select = new StringSelectMenuBuilder()
      .setCustomId(`config_badm_pick:${clamped}`)
      .setPlaceholder("Select the teammates who count as admins")
      .setMinValues(0)
      .setMaxValues(slice.length)
      .addOptions(
        slice.map((t) => ({
          label: (t.name || `Teammate ${t.id}`).slice(0, 100),
          description: (t.email ?? t.id).slice(0, 100),
          value: t.id,
          default: markedIds.has(t.id),
        }))
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    if (pages > 1) embed.setFooter({ text: `Teammates page ${clamped + 1}/${pages} — selection saves per page` });
  }

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...(teammates && pages > 1
      ? [
          new ButtonBuilder()
            .setCustomId(`config_badm_page:${clamped - 1}`)
            .setLabel("Prev")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(clamped <= 0),
          new ButtonBuilder()
            .setCustomId(`config_badm_page:${clamped + 1}`)
            .setLabel("Next")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(clamped >= pages - 1),
        ]
      : []),
    new ButtonBuilder().setCustomId(backTarget).setLabel("Back").setStyle(ButtonStyle.Secondary)
  );
  components.push(nav);

  return { embeds: [embed], components };
}

// Per-page merge for the admins multi-select: keep marked teammates that are
// NOT on the rendered page, replace the page's subset with the selection.
export function mergeAdminSelection(
  settings: SettingsStore,
  teammates: IntercomAdmin[],
  page: number,
  selectedIds: string[]
): Array<{ id: string; name: string }> {
  const slice = teammates.slice(page * ADMINS_PAGE_SIZE, (page + 1) * ADMINS_PAGE_SIZE);
  const pageIds = new Set(slice.map((t) => t.id));
  const byId = new Map(teammates.map((t) => [t.id, t.name || `Teammate ${t.id}`]));
  const kept = settings.intercomPanelAdmins().filter((a) => !pageIds.has(a.id));
  const added = selectedIds.filter((id) => pageIds.has(id)).map((id) => ({ id, name: byId.get(id) ?? id }));
  return [...kept, ...added];
}
