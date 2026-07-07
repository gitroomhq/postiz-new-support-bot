import type { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction, UserSelectMenuInteraction } from "discord.js";
import { embed as makeEmbed, COLORS } from "../../util/embeds";
import { Logger } from "../../util/logger";
import { backRow, stripeErrorEmbed } from "./ui";
import { SESSION_TTL_MS, type BillAdminSession, type RenderInteraction } from "./types";

const logger = new Logger("billing-admin");

// Per-panel state held in a token session keyed by the creating interaction id.
// TTL is sliding: every owned access refreshes the timestamp.
export class SessionManager {
  private sessions = new Map<string, BillAdminSession>();
  // Panel-session tokens whose money-moving confirm handler is currently in
  // flight. A human double-click arrives as a *second* interaction (new id →
  // new Stripe idempotency key), so the per-click keys can't dedupe it — this
  // serializes writes per panel so only the first click executes.
  private inFlight = new Set<string>();

  get(token: string): BillAdminSession | undefined {
    return this.sessions.get(token);
  }

  newSession(interaction: { id: string; user: { id: string } }, data: Partial<BillAdminSession>): string {
    this.prune();
    this.sessions.set(interaction.id, {
      ownerUserId: interaction.user.id,
      createdAt: Date.now(),
      ...data,
    });
    return interaction.id;
  }

  async getOwnedSession(
    token: string,
    interaction: ButtonInteraction | StringSelectMenuInteraction | UserSelectMenuInteraction | ModalSubmitInteraction
  ): Promise<BillAdminSession | null> {
    const session = this.sessions.get(token);
    if (!session) {
      await interaction.reply({
        embeds: [makeEmbed("This /billing session has expired — run /billing again.", COLORS.warn)],
        flags: 64,
      });
      return null;
    }
    if (session.ownerUserId !== interaction.user.id) {
      await interaction.reply({
        embeds: [makeEmbed("Only the person who opened this panel can use it.", COLORS.danger)],
        flags: 64,
      });
      return null;
    }
    // Sliding TTL: an actively used panel stays alive.
    session.createdAt = Date.now();
    return session;
  }

  prune(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [token, session] of this.sessions) {
      if (session.createdAt < cutoff) this.sessions.delete(token);
    }
  }

  // For a modal launched from the panel message, deferUpdate keeps the whole flow
  // on that one message; the fallback covers modals whose message is gone.
  async ackModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.isFromMessage()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: 64 });
  }

  // Wraps post-defer work: Stripe/DB errors land as a danger embed instead of
  // the silent "interaction failed" Discord shows on an unhandled rejection.
  async tryRender(interaction: RenderInteraction, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      logger.error("Billing admin error:", error);
      await interaction
        .editReply({ embeds: [stripeErrorEmbed(error)], components: [backRow()] })
        .catch(() => undefined);
    }
  }

  // tryRender for money-moving handlers: refuses to run a second write for the
  // same panel session while one is still in flight. The duplicate click was
  // already deferUpdate-acked by the caller, so dropping it silently shows no
  // error and the in-flight call renders the result for everyone.
  async runExclusive(token: string, interaction: RenderInteraction, work: () => Promise<void>): Promise<void> {
    if (this.inFlight.has(token)) return;
    this.inFlight.add(token);
    try {
      await this.tryRender(interaction, work);
    } finally {
      this.inFlight.delete(token);
    }
  }
}
