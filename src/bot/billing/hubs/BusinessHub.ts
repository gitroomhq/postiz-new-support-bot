import { ButtonStyle, EmbedBuilder } from "discord.js";
import type Stripe from "stripe";
import { COLORS } from "../../../util/embeds";
import { backRow, btn, buttonRow, formatAddress, stripeErrorEmbed } from "../ui";
import type { Panel, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

// Business hub: OUR OWN Stripe account — legal/business name, address, VAT and
// contact data. Read-only; there is deliberately no write path here.
//
// Registers `billadmin_hub:business` as an EXACT route (beats the facade's
// `billadmin_hub:` prefix route) because rendering needs async Stripe calls,
// which buildHubPanel's sync panel table cannot do.
export class BusinessHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    {
      kind: "button",
      id: "billadmin_hub:business",
      match: "exact",
      handler: async (interaction) => {
        await interaction.deferUpdate();
        try {
          await interaction.editReply(await this.buildPanel());
        } catch (error) {
          await interaction.editReply({ embeds: [stripeErrorEmbed(error)], components: [backRow()] });
        }
      },
    },
  ];

  private async buildPanel(): Promise<Panel> {
    const [account, taxIds] = await Promise.all([
      this.ctx.stripe.getAccount(),
      // Accounts created before account tax IDs existed can 404/error here —
      // the panel is still useful without the VAT line.
      this.ctx.stripe.listAccountTaxIds().catch(() => [] as Stripe.TaxId[]),
    ]);

    const profile = account.business_profile;
    const displayName = account.settings?.dashboard?.display_name;
    // company/individual are only present on some account types — fall back
    // through the public-facing profile data.
    const legalName =
      account.company?.name ??
      (account.individual
        ? `${account.individual.first_name ?? ""} ${account.individual.last_name ?? ""}`.trim() || null
        : null);
    const address = account.company?.address ?? profile?.support_address;

    const taxIdText = taxIds.length
      ? taxIds
          .map((t) => `\`${t.value}\` · ${t.type.replace(/_/g, " ")}${t.country ? ` (${t.country})` : ""}`)
          .join("\n")
      : "none on file — the onboarding VAT is write-only in Stripe; IDs shown here are the account tax IDs printed on invoices";

    const support = [profile?.support_email, profile?.support_phone, profile?.support_url].filter(Boolean).join(" · ");
    const descriptor = account.settings?.payments?.statement_descriptor;

    const embed = new EmbedBuilder()
      .setTitle("🏢 Business — our Stripe account")
      .setColor(COLORS.brand)
      .addFields(
        { name: "Business name", value: (profile?.name ?? displayName ?? "—").slice(0, 1024), inline: true },
        { name: "Legal entity", value: (legalName ?? "—").slice(0, 1024), inline: true },
        { name: "Account", value: `\`${account.id}\` · ${account.country ?? "—"} · ${(account.default_currency ?? "—").toUpperCase()}`, inline: true },
        { name: "Address", value: formatAddress(address).slice(0, 1024), inline: false },
        { name: "VAT / Tax IDs", value: taxIdText.slice(0, 1024), inline: false },
        { name: "Account email", value: (account.email ?? "—").slice(0, 1024), inline: true },
        { name: "Support", value: (support || "—").slice(0, 1024), inline: true },
        { name: "Statement descriptor", value: (descriptor ?? "—").slice(0, 1024), inline: true },
        {
          name: "Status",
          value: `charges ${account.charges_enabled ? "✅" : "⛔"} · payouts ${account.payouts_enabled ? "✅" : "⛔"}`,
          inline: true,
        }
      )
      .setFooter({ text: "Read-only · account tax IDs come from /v1/tax_ids (the ones rendered on invoices)" });

    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("billadmin_hub:business", "🔄 Refresh", ButtonStyle.Secondary),
          btn("billadmin_root", "◀ Back", ButtonStyle.Secondary)
        ),
      ],
    };
  }
}
