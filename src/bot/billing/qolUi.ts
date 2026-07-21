import {
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { COLORS } from "../../util/embeds";
import { btn, buttonRow, textInput } from "./ui";
import type { RenderInteraction } from "./types";
import type { HubContext } from "./hubs/HubContext";
import type { BillingObjectType } from "./BillingQolStore";

// Shared notes-panel + note-modal helpers. Each hub owns its panels' QoL
// button/modal routes (so the post-action re-render stays in the owning hub);
// the rendering they delegate to lives here so every notes panel looks alike.

const TYPE_TITLES: Record<BillingObjectType, string> = {
  dispute: "Dispute",
  customer: "Customer",
  charge: "Charge",
  subscription: "Subscription",
  invoice: "Invoice",
  payout: "Payout",
  link: "Payment link",
  quote: "Quote",
  product: "Product",
};

const NOTES_PAGE_SIZE = 10;

export async function renderNotesPanel(
  ctx: HubContext,
  interaction: RenderInteraction,
  p: {
    type: BillingObjectType;
    objectId: string;
    // Re-render custom-id of the panel the notes were opened from (its Back).
    backId: string;
    // Custom-id of the button that opens the add-note modal.
    addNoteId: string;
    // Custom-id prefix a page number is appended to (":<page>") for Prev/Next.
    pageBaseId: string;
    page?: number;
    notice?: string;
  }
): Promise<void> {
  const page = Math.max(0, p.page ?? 0);
  const { rows, total } = await ctx.qolStore.listNotes(p.type, p.objectId, page * NOTES_PAGE_SIZE, NOTES_PAGE_SIZE);
  const lines = rows.map(
    (n) => `<t:${Math.floor(n.createdAt.getTime() / 1000)}:R> **${n.authorName}**: ${n.text.slice(0, 300)}`
  );
  const embed = new EmbedBuilder()
    .setTitle(`📝 Notes: ${TYPE_TITLES[p.type]} \`${p.objectId}\` (${total})`)
    .setColor(COLORS.brand)
    .setDescription(
      [p.notice, lines.length ? lines.join("\n") : "No notes yet."].filter(Boolean).join("\n\n").slice(0, 4096)
    )
    .setFooter({ text: `Team-visible · newest first · page ${page + 1}/${Math.max(1, Math.ceil(total / NOTES_PAGE_SIZE))}` });
  await interaction.editReply({
    embeds: [embed],
    components: [
      buttonRow(
        btn(p.addNoteId, "Add Note", ButtonStyle.Primary),
        btn(`${p.pageBaseId}:${page - 1}`, "Prev", ButtonStyle.Secondary, page <= 0),
        btn(`${p.pageBaseId}:${page + 1}`, "Next", ButtonStyle.Secondary, (page + 1) * NOTES_PAGE_SIZE >= total),
        btn(p.backId, "Back", ButtonStyle.Secondary)
      ),
    ],
  });
}

export function buildNoteModal(customId: string, objectId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(`Note on ${objectId}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        textInput("note_text", "Note (team-visible)", {
          required: true,
          style: TextInputStyle.Paragraph,
          maxLength: 1000,
          placeholder: "Context for the team…",
        })
      )
    );
}
