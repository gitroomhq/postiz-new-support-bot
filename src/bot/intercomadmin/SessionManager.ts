import type { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import { embed as makeEmbed, COLORS } from "../../util/embeds";
import { log } from "../../util/logger";
import { backRow, errorEmbed } from "./ui";
import { SESSION_TTL_MS, type IcAdminSession, type Panel } from "./types";

const sessionLog = log.child("intercom-admin");

// Token sessions for the /intercom panels (billing SessionManager pattern,
// re-typed to IcAdminSession and /intercom copy). TTL is sliding: every owned
// access refreshes the timestamp.
export class SessionManager {
  private sessions = new Map<string, IcAdminSession>();
  // Serializes destructive handlers per panel token (double-click guard).
  private inFlight = new Set<string>();

  get(token: string): IcAdminSession | undefined {
    return this.sessions.get(token);
  }

  newSession(interaction: { id: string; user: { id: string } }, data: Partial<IcAdminSession>): string {
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
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction
  ): Promise<IcAdminSession | null> {
    const session = this.sessions.get(token);
    if (!session) {
      await interaction
        .reply({
          embeds: [makeEmbed("This /intercom session has expired. Run /intercom again.", COLORS.warn)],
          flags: 64,
        })
        .catch(() => undefined);
      return null;
    }
    if (session.ownerUserId !== interaction.user.id) {
      await interaction
        .reply({ embeds: [makeEmbed("Only the person who opened this panel can use it.", COLORS.danger)], flags: 64 })
        .catch(() => undefined);
      return null;
    }
    session.createdAt = Date.now();
    return session;
  }

  prune(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [token, session] of this.sessions) {
      if (session.createdAt < cutoff) this.sessions.delete(token);
    }
  }

  // For a modal launched from a panel message, deferUpdate keeps the flow on
  // that message; the fallback covers modals whose message is gone.
  async ackModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.isFromMessage()) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: 64 });
  }

  // Wraps post-defer work: errors land as a danger embed instead of the
  // silent "interaction failed" Discord shows on an unhandled rejection.
  async tryRender(
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    work: () => Promise<void>
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      sessionLog.error("intercom admin panel error", error);
      await interaction.editReply({ embeds: [errorEmbed(error)], components: [backRow()] }).catch(() => undefined);
    }
  }

  // tryRender for destructive handlers: refuses a second run for the same
  // panel token while one is in flight (the duplicate click was already
  // deferUpdate-acked, so dropping it silently is correct).
  async runExclusive(
    token: string,
    interaction: { editReply: (payload: Panel) => Promise<unknown> },
    work: () => Promise<void>
  ): Promise<void> {
    if (this.inFlight.has(token)) return;
    this.inFlight.add(token);
    try {
      await this.tryRender(interaction, work);
    } finally {
      this.inFlight.delete(token);
    }
  }
}
