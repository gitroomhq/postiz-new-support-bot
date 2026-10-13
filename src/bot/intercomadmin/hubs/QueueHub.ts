import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { btn, buttonRow, backRow, selectRow, panelEmbed, textInput } from "../ui";
import type { Panel, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";
import type { QueueExclusions, SecretState } from "../../../config/SettingsStore";
import {
  queueReadiness,
  QUEUE_CLIENT_ID_RE,
  QUEUE_CLIENT_SECRET_RE,
  QUEUE_EXCLUSION_KINDS,
  type QueueExclusionKind,
} from "../../../queue/queueConfig";

const PICK_PAGE_SIZE = 10;

const SECRET_LABEL: Record<SecretState, string> = {
  none: "not set",
  local: "set (encrypted locally)",
  vault: "set (Vault)",
  "vault-unreachable": "set (Vault unreachable right now)",
  "local-unreadable": "unreadable: enter it again",
};

const KIND_LABEL: Record<QueueExclusionKind, string> = { teams: "Teams", tags: "Tags", ticketTypes: "Ticket types" };

// /intercom → Queue: the Intercom Queue web page (/queue). Kill switch, the
// OAuth app it signs in with, what counts as a reply, exclusions and "sign
// everyone out". Mirrored in the web panel's Queue hub.
export class QueueHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    { kind: "button", id: "icadmin_queue_toggle", match: "exact", handler: (i) => this.handleToggle(i) },
    { kind: "button", id: "icadmin_queue_creds", match: "exact", handler: (i) => this.handleCredsOpen(i) },
    { kind: "button", id: "icadmin_queue_fin", match: "exact", handler: (i) => this.handleFlag(i, "fin") },
    { kind: "button", id: "icadmin_queue_notes", match: "exact", handler: (i) => this.handleFlag(i, "notes") },
    { kind: "button", id: "icadmin_queue_ex:", match: "prefix", handler: (i) => this.handlePickOpen(i) },
    { kind: "select", id: "icadmin_queue_exsel:", match: "prefix", handler: (i) => this.handlePick(i) },
    { kind: "button", id: "icadmin_queue_signout", match: "exact", handler: (i) => this.handleSignOutAsk(i) },
    { kind: "button", id: "icadmin_queue_signout_yes", match: "exact", handler: (i) => this.handleSignOut(i) },
    { kind: "modal", id: "icadmin_queue_creds_m", match: "exact", handler: (i) => this.handleCredsSubmit(i) },
  ];

  async buildPanel(): Promise<Panel> {
    const s = this.ctx.settingsStore;
    const ready = queueReadiness(s);
    const live = await this.ctx.queue?.liveSessions().catch(() => null);
    const x = s.queueExclusions();
    const names = (list: Array<{ name: string }>) => (list.length ? list.map((e) => e.name).join(", ").slice(0, 300) : "none");
    const embed = panelEmbed(
      "Intercom Queue",
      [
        "A web page of the tickets that wait on a reply from the team: per inbox, per teammate and for the whole workspace, each with **All**, **Longest waiting** and a **Randomizer**. Teammates sign in with their Intercom account (any teammate with an inbox seat); the page reads Intercom with the bridge's own token.",
        "",
        `**Status:** ${s.queueEnabled() ? "**on**" : "**off** (the page answers 404)"} · **Sign-in:** ${ready.ok ? "ready" : `not ready: ${ready.missing.join("; ")}`}`,
        `**Page:** ${ready.pageUrl ?? "needs the public URL (/config → Billing → Webhooks → Set Public URL)"}`,
        `**Redirect URL** (register exactly this in the OAuth app): ${ready.callbackUrl ? `\`${ready.callbackUrl}\`` : "needs an https public URL"}`,
        `**OAuth app:** client id ${s.queueOauthClientId() ? `\`${s.queueOauthClientId()}\`` : "not set"} · client secret ${SECRET_LABEL[s.secretState("queueOauthClientSecret")]}`,
        `**Signed in now:** ${live == null ? "unknown" : live}`,
        "",
        "**Counts as a reply:** a teammate's message (and a Discord staff message on a bridged ticket), plus:",
        `Fin replies: **${s.queueFinCountsAsReply() ? "on" : "off"}** · Internal notes: **${s.queueNotesCountAsReply() ? "on" : "off"}**`,
        "Waiting on customer and Resolved tickets are never listed; snoozed ones only behind the page's Snoozed filter.",
        "",
        `**Excluded teams:** ${names(x.teams)}`,
        `**Excluded tags:** ${names(x.tags)}`,
        `**Excluded ticket types:** ${names(x.ticketTypes)}`,
      ].join("\n")
    ).setFooter({ text: "OAuth app: Developer Hub → New app → Authentication: Use OAuth + the redirect URL above, Permissions: Read admins only" });

    const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
      buttonRow(
        btn("icadmin_queue_toggle", `Queue: ${s.queueEnabled() ? "on" : "off"}`, s.queueEnabled() ? ButtonStyle.Success : ButtonStyle.Secondary),
        btn("icadmin_queue_creds", "OAuth App", ButtonStyle.Primary),
        btn("icadmin_queue_signout", "Sign Everyone Out", ButtonStyle.Danger, (live ?? 1) === 0),
        ...(ready.pageUrl && s.queueEnabled() ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open Queue").setURL(ready.pageUrl)] : [])
      ),
      buttonRow(
        btn("icadmin_queue_fin", `Fin Replies Count: ${s.queueFinCountsAsReply() ? "on" : "off"}`, s.queueFinCountsAsReply() ? ButtonStyle.Success : ButtonStyle.Secondary),
        btn("icadmin_queue_notes", `Notes Count: ${s.queueNotesCountAsReply() ? "on" : "off"}`, s.queueNotesCountAsReply() ? ButtonStyle.Success : ButtonStyle.Secondary)
      ),
      buttonRow(
        btn("icadmin_queue_ex:teams:0", "Exclude Teams", ButtonStyle.Primary),
        btn("icadmin_queue_ex:tags:0", "Exclude Tags", ButtonStyle.Primary),
        btn("icadmin_queue_ex:ticketTypes:0", "Exclude Ticket Types", ButtonStyle.Primary)
      ),
      backRow(),
    ];
    return { embeds: [embed], components: rows };
  }

  private async refresh(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
    await interaction.editReply(await this.buildPanel());
  }

  private async handleToggle(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    const enabling = !this.ctx.settingsStore.queueEnabled();
    await this.ctx.settingsStore.updateQueue({ queueEnabled: enabling });
    this.ctx.auditConfig(interaction, `Intercom Queue → ${enabling ? "on" : "off"}`);
    await this.refresh(interaction);
  }

  private async handleFlag(interaction: ButtonInteraction, which: "fin" | "notes"): Promise<void> {
    await interaction.deferUpdate();
    const s = this.ctx.settingsStore;
    if (which === "fin") {
      const on = !s.queueFinCountsAsReply();
      await s.updateQueue({ queueFinCountsAsReply: on });
      this.ctx.auditConfig(interaction, `Intercom Queue: Fin replies count as a reply → ${on ? "on" : "off"}`);
    } else {
      const on = !s.queueNotesCountAsReply();
      await s.updateQueue({ queueNotesCountAsReply: on });
      this.ctx.auditConfig(interaction, `Intercom Queue: internal notes count as a reply → ${on ? "on" : "off"}`);
    }
    await this.refresh(interaction);
  }

  // ---- OAuth app credentials (the secret is never shown back) ----

  private async handleCredsOpen(interaction: ButtonInteraction): Promise<void> {
    const s = this.ctx.settingsStore;
    const modal = new ModalBuilder().setCustomId("icadmin_queue_creds_m").setTitle("Intercom Queue OAuth app");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("client_id", "Client ID (Basic information)", { required: false, value: s.queueOauthClientId() ?? "", maxLength: 100 })
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("client_secret", "Client secret (blank keeps, none clears)", {
          required: false,
          placeholder: s.secretState("queueOauthClientSecret") === "none" ? "paste the client secret" : "configured: leave blank to keep",
          maxLength: 200,
        })
      )
    );
    await interaction.showModal(modal);
  }

  private async handleCredsSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const idRaw = interaction.fields.getTextInputValue("client_id").trim();
    const secretRaw = interaction.fields.getTextInputValue("client_secret").trim();
    const update: { queueOauthClientId?: string | null; queueOauthClientSecret?: string | null } = {};
    const changes: string[] = [];
    if (idRaw !== (this.ctx.settingsStore.queueOauthClientId() ?? "")) {
      if (idRaw && !QUEUE_CLIENT_ID_RE.test(idRaw)) {
        await interaction.reply({ embeds: [makeEmbed("That does not look like an Intercom client ID (letters, digits and dashes).", COLORS.danger)], flags: 64 });
        return;
      }
      update.queueOauthClientId = idRaw || null;
      changes.push(`client id ${idRaw ? "set" : "cleared"}`);
    }
    if (secretRaw) {
      const clears = secretRaw.toLowerCase() === "none";
      if (!clears && !QUEUE_CLIENT_SECRET_RE.test(secretRaw)) {
        await interaction.reply({ embeds: [makeEmbed("That does not look like an Intercom client secret.", COLORS.danger)], flags: 64 });
        return;
      }
      update.queueOauthClientSecret = clears ? null : secretRaw;
      changes.push(`client secret ${clears ? "cleared" : "set"}`);
    }
    if (changes.length) {
      await this.ctx.settingsStore.updateQueue(update);
      this.ctx.auditConfig(interaction, `Intercom Queue OAuth app: ${changes.join(", ")}`);
    }
    await interaction.reply({
      embeds: [makeEmbed(changes.length ? `Saved: ${changes.join(", ")}. Reopen the Queue panel to see the sign-in status.` : "Nothing changed.", COLORS.success)],
      flags: 64,
    });
  }

  // ---- exclusions: paginated multi-selects, saved per page ----

  private async options(kind: QueueExclusionKind): Promise<Array<{ id: string; name: string; description?: string }>> {
    const c = this.ctx.intercomClient;
    if (kind === "teams") return (await c.listTeams()).map((t) => ({ id: t.id, name: t.name }));
    if (kind === "tags") return (await c.listTags()).map((t) => ({ id: t.id, name: t.name }));
    return (await c.listTicketTypes())
      .filter((t) => (t.category ?? "Customer") === "Customer")
      .map((t) => ({ id: t.id, name: t.name, description: t.category ?? undefined }));
  }

  private async handlePickOpen(interaction: ButtonInteraction): Promise<void> {
    const [, kindRaw, pageRaw] = interaction.customId.split(":");
    const kind = QUEUE_EXCLUSION_KINDS.find((k) => k === kindRaw);
    if (!kind) return;
    await interaction.deferUpdate();
    await interaction.editReply(await this.buildPicker(kind, Number(pageRaw) || 0));
  }

  private async buildPicker(kind: QueueExclusionKind, page: number): Promise<Panel> {
    let all: Array<{ id: string; name: string; description?: string }>;
    try {
      all = (await this.options(kind)).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      return {
        embeds: [makeEmbed(`Could not list ${KIND_LABEL[kind].toLowerCase()} from Intercom: ${e instanceof Error ? e.message : String(e)}`, COLORS.danger)],
        components: [backRow("icadmin_hub:queue")],
      };
    }
    const excluded = this.ctx.settingsStore.queueExclusions()[kind];
    const embed = panelEmbed(
      `Intercom Queue: exclude ${KIND_LABEL[kind].toLowerCase()}`,
      [
        `Conversations in an excluded ${kind === "teams" ? "team inbox" : kind === "tags" ? "tag" : "ticket type"} never appear in the queue.`,
        "",
        `**Excluded now:** ${excluded.length ? excluded.map((e) => e.name).join(", ").slice(0, 1500) : "none"}`,
      ].join("\n")
    );
    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (!all.length) {
      embed.addFields({ name: "Nothing to pick", value: `Intercom returned no ${KIND_LABEL[kind].toLowerCase()}.` });
      components.push(backRow("icadmin_hub:queue"));
      return { embeds: [embed], components };
    }
    const pages = Math.max(1, Math.ceil(all.length / PICK_PAGE_SIZE));
    const clamped = Math.min(Math.max(0, page), pages - 1);
    const slice = all.slice(clamped * PICK_PAGE_SIZE, (clamped + 1) * PICK_PAGE_SIZE);
    const ids = new Set(excluded.map((e) => e.id));
    components.push(
      selectRow(
        new StringSelectMenuBuilder()
          .setCustomId(`icadmin_queue_exsel:${kind}:${clamped}`)
          .setPlaceholder(`Select the ${KIND_LABEL[kind].toLowerCase()} to exclude`)
          .setMinValues(0)
          .setMaxValues(slice.length)
          .addOptions(
            slice.map((o) => ({
              label: o.name.slice(0, 100) || o.id,
              value: o.id,
              description: (o.description ? `${o.description} · id ${o.id}` : `id ${o.id}`).slice(0, 100),
              default: ids.has(o.id),
            }))
          )
      )
    );
    if (pages > 1) embed.setFooter({ text: `Page ${clamped + 1}/${pages}: the selection saves per page` });
    components.push(
      buttonRow(
        ...(pages > 1
          ? [
              btn(`icadmin_queue_ex:${kind}:${clamped - 1}`, "Prev", ButtonStyle.Secondary, clamped <= 0),
              btn(`icadmin_queue_ex:${kind}:${clamped + 1}`, "Next", ButtonStyle.Secondary, clamped >= pages - 1),
            ]
          : []),
        btn("icadmin_hub:queue", "Back", ButtonStyle.Secondary)
      )
    );
    return { embeds: [embed], components };
  }

  private async handlePick(interaction: StringSelectMenuInteraction): Promise<void> {
    const [, kindRaw, pageRaw] = interaction.customId.split(":");
    const kind = QUEUE_EXCLUSION_KINDS.find((k) => k === kindRaw);
    if (!kind) return;
    await interaction.deferUpdate();
    const page = Number(pageRaw) || 0;
    let all: Array<{ id: string; name: string }>;
    try {
      all = (await this.options(kind)).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      await interaction.followUp({ embeds: [makeEmbed(`Could not list them from Intercom: ${e instanceof Error ? e.message : String(e)}`, COLORS.danger)], flags: 64 });
      return;
    }
    // Keep what is excluded off this page; replace this page's part with the
    // selection. Only ids Intercom actually listed on the page are accepted.
    const slice = all.slice(page * PICK_PAGE_SIZE, (page + 1) * PICK_PAGE_SIZE);
    const pageIds = new Set(slice.map((o) => o.id));
    const byId = new Map(slice.map((o) => [o.id, o.name]));
    const current = this.ctx.settingsStore.queueExclusions();
    const kept = current[kind].filter((e) => !pageIds.has(e.id));
    const added = interaction.values.filter((v) => pageIds.has(v)).map((id) => ({ id, name: byId.get(id) ?? id }));
    const next: QueueExclusions = { ...current, [kind]: [...kept, ...added] };
    await this.ctx.settingsStore.updateQueue({ queueExclusions: next });
    this.ctx.auditConfig(
      interaction,
      `Intercom Queue excluded ${KIND_LABEL[kind].toLowerCase()} → ${next[kind].length ? next[kind].map((e) => e.name).join(", ").slice(0, 900) : "none"}`
    );
    await interaction.editReply(await this.buildPicker(kind, page));
  }

  // ---- sign everyone out ----

  private async handleSignOutAsk(interaction: ButtonInteraction): Promise<void> {
    await interaction.update({
      embeds: [
        panelEmbed(
          "Sign everyone out of the Intercom Queue?",
          "Every open queue session ends at once; teammates sign in with Intercom again. Use it after an OAuth secret leak or a teammate leaving."
        ),
      ],
      components: [
        buttonRow(btn("icadmin_queue_signout_yes", "Sign Everyone Out", ButtonStyle.Danger), btn("icadmin_hub:queue", "Cancel", ButtonStyle.Secondary)),
      ],
    });
  }

  private async handleSignOut(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    const n = (await this.ctx.queue?.signOutAll().catch(() => null)) ?? null;
    this.ctx.auditConfig(interaction, `Intercom Queue: everyone signed out${n != null ? ` (${n} session(s))` : ""}`);
    await this.refresh(interaction);
    await interaction.followUp({ embeds: [makeEmbed("Everyone is signed out of the Intercom Queue.", COLORS.success)], flags: 64 });
  }
}
