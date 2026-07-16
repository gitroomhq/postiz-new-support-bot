import { ActionRowBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
import { COLORS } from "../../../util/embeds";
import { btn, buttonRow } from "../ui";
import type { Panel, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";
import type { BillingApproval } from "../ApprovalStore";

const PAGE_SIZE = 10;

// /billing → Approvals: the queued Intercom canvas/panel billing actions.
// Every route here is behind BillingAdmin.requireAdmin (Discord Administrator
// permission), so a Discord approver always acts as an admin. Double-approve
// races are settled by ApprovalStore.claimForExecution — no session locking
// needed.
export class ApprovalsHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    {
      kind: "button",
      id: "billadmin_apr_list:",
      match: "prefix",
      handler: async (interaction) => {
        const page = parseInt(interaction.customId.split(":")[1], 10) || 0;
        await interaction.deferUpdate();
        await interaction.editReply(await this.buildListPanel(page));
      },
    },
    {
      kind: "select",
      id: "billadmin_apr_pick:",
      match: "prefix",
      handler: async (interaction) => {
        const page = parseInt(interaction.customId.split(":")[1], 10) || 0;
        await interaction.deferUpdate();
        await interaction.editReply(await this.buildDetailPanel(interaction.values[0], page));
      },
    },
    {
      kind: "button",
      id: "billadmin_apr_det:",
      match: "prefix",
      handler: async (interaction) => {
        const [, id, pageRaw] = interaction.customId.split(":");
        await interaction.deferUpdate();
        await interaction.editReply(await this.buildDetailPanel(id, parseInt(pageRaw, 10) || 0));
      },
    },
    {
      kind: "button",
      id: "billadmin_apr_ok:",
      match: "prefix",
      handler: async (interaction) => {
        const [, id, pageRaw] = interaction.customId.split(":");
        await interaction.deferUpdate();
        const outcome = await this.ctx.billingActions.actOnApproval(
          id,
          { kind: "discord", id: interaction.user.id, name: interaction.user.displayName, isAdmin: true },
          "approve"
        );
        const notice =
          outcome.kind === "executed"
            ? `✅ ${outcome.text}`
            : outcome.kind === "already_handled"
              ? `⚠️ ${outcome.error}`
              : `⚠️ ${"error" in outcome ? outcome.error : "Failed."}`;
        await interaction.editReply(await this.buildDetailPanel(id, parseInt(pageRaw, 10) || 0, notice));
      },
    },
    {
      kind: "button",
      id: "billadmin_apr_no:",
      match: "prefix",
      handler: async (interaction) => {
        const [, id, pageRaw] = interaction.customId.split(":");
        await interaction.deferUpdate();
        const outcome = await this.ctx.billingActions.actOnApproval(
          id,
          { kind: "discord", id: interaction.user.id, name: interaction.user.displayName, isAdmin: true },
          "reject"
        );
        const notice =
          outcome.kind === "rejected" ? "🚫 Approval rejected." : `⚠️ ${"error" in outcome ? outcome.error : "Failed."}`;
        await interaction.editReply(await this.buildDetailPanel(id, parseInt(pageRaw, 10) || 0, notice));
      },
    },
  ];

  private async buildListPanel(page: number): Promise<Panel> {
    const { rows, total } = await this.ctx.billingActions.pendingPage(page * PAGE_SIZE, PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const lines = rows.map((approval, i) => {
      const age = Math.max(0, Math.floor((Date.now() - approval.createdAt.getTime()) / (60 * 60 * 1000)));
      const state = approval.status === "FAILED" ? " · **FAILED (retryable)**" : "";
      return `**${page * PAGE_SIZE + i + 1}.** ${approval.summary}\n· ${approval.requestedByName} · ${age}h ago${state}`;
    });

    const embed = new EmbedBuilder()
      .setTitle("Billing Approvals")
      .setColor(COLORS.brand)
      .setDescription(
        total === 0
          ? "No pending approvals. Support agents queue actions from the Intercom canvas or the Stripe panel; they land here (and in the canvas/panel Approvals views)."
          : lines.join("\n")
      )
      .setFooter({ text: `${total} pending · page ${page + 1}/${pages} · expire after 7 days` });

    const components: Panel["components"] = [];
    if (rows.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`billadmin_apr_pick:${page}`)
        .setPlaceholder("Open an approval")
        .addOptions(
          rows.map((approval) => ({
            label: approval.summary.slice(0, 100),
            description: `by ${approval.requestedByName}`.slice(0, 100),
            value: approval.id,
          }))
        );
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    }
    components.push(
      buttonRow(
        btn(`billadmin_apr_list:${page - 1}`, "Prev", ButtonStyle.Secondary, page <= 0),
        btn(`billadmin_apr_list:${page + 1}`, "Next", ButtonStyle.Secondary, page + 1 >= pages),
        btn(`billadmin_apr_list:${page}`, "Refresh", ButtonStyle.Secondary),
        btn("billadmin_root", "Back", ButtonStyle.Secondary)
      )
    );
    return { embeds: [embed], components };
  }

  private async buildDetailPanel(id: string, page: number, notice?: string): Promise<Panel> {
    const approval = await this.ctx.approvalStore.get(id);
    if (!approval) {
      return {
        embeds: [new EmbedBuilder().setColor(COLORS.warn).setDescription("Approval not found.")],
        components: [buttonRow(btn(`billadmin_apr_list:${page}`, "Back", ButtonStyle.Secondary))],
      };
    }

    const actionable = approval.status === "PENDING" || approval.status === "FAILED";
    // Read-only preview: would this still execute right now?
    const refusal = actionable ? await this.ctx.billingActions.previewRevalidation(approval) : null;

    const embed = new EmbedBuilder()
      .setTitle("Approval detail")
      .setColor(approval.status === "FAILED" ? COLORS.warn : COLORS.brand)
      .setDescription(notice ?? null)
      .addFields(
        { name: "Action", value: approval.summary.slice(0, 1024), inline: false },
        { name: "Key", value: `\`${approval.actionKey}\``, inline: true },
        { name: "Requested by", value: approval.requestedByName, inline: true },
        { name: "Status", value: this.describeStatus(approval), inline: true },
        { name: "Queued", value: `<t:${Math.floor(approval.createdAt.getTime() / 1000)}:R>`, inline: true },
        { name: "Expires", value: `<t:${Math.floor(approval.expiresAt.getTime() / 1000)}:R>`, inline: true },
        ...(approval.stripeCustomerId ? [{ name: "Customer", value: `\`${approval.stripeCustomerId}\``, inline: true }] : []),
        { name: "Params", value: `\`\`\`json\n${JSON.stringify(approval.paramsJson).slice(0, 950)}\n\`\`\``, inline: false },
        ...(actionable
          ? [
              {
                name: "Live check",
                value: refusal ? `⚠️ Would refuse: ${refusal.slice(0, 900)}` : "✅ Would still execute (revalidated just now)",
                inline: false,
              },
            ]
          : []),
        ...(approval.errorText ? [{ name: "Last error", value: approval.errorText.slice(0, 1024), inline: false }] : []),
        ...(approval.resultText ? [{ name: "Result", value: approval.resultText.slice(0, 1024), inline: false }] : [])
      );

    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn(`billadmin_apr_ok:${approval.id}:${page}`, approval.status === "FAILED" ? "Retry" : "Approve and execute", ButtonStyle.Danger, !actionable),
          btn(`billadmin_apr_no:${approval.id}:${page}`, "Reject", ButtonStyle.Secondary, !actionable),
          btn(`billadmin_apr_det:${approval.id}:${page}`, "Refresh", ButtonStyle.Secondary),
          btn(`billadmin_apr_list:${page}`, "Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }

  private describeStatus(approval: BillingApproval): string {
    if (approval.status === "FAILED") return "FAILED (retryable)";
    if (approval.reviewerName && approval.status !== "PENDING") return `${approval.status} by ${approval.reviewerName}`;
    return approval.status;
  }
}
