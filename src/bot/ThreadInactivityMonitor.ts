import {
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { ThreadStore } from "../auth/ThreadStore";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INACTIVITY_WARN_THRESHOLD_MS = 24 * 24 * 60 * 60 * 1000; // 24 days → send warning
const INACTIVITY_CLOSE_THRESHOLD_MS = 24 * 60 * 60 * 1000;     // 24 hours → close after warning

export class ThreadInactivityMonitor {
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private threadStore: ThreadStore,
    private client: Client,
    private supportRoleId: string
  ) {}

  start(): void {
    // Run an initial check immediately, then every CHECK_INTERVAL_MS
    this.check().catch(console.error);
    this.intervalId = setInterval(
      () => this.check().catch(console.error),
      CHECK_INTERVAL_MS
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async check(): Promise<void> {
    const warnThreshold = new Date(Date.now() - INACTIVITY_WARN_THRESHOLD_MS);
    const closeThreshold = new Date(Date.now() - INACTIVITY_CLOSE_THRESHOLD_MS);

    // 1. Send inactivity warning to threads idle for 24 days
    const stale = await this.threadStore.getStaleThreads(warnThreshold);
    for (const record of stale) {
      await this.sendInactivityWarning(record.threadId).catch((err) =>
        console.error(`[InactivityMonitor] Failed to warn thread ${record.threadId}:`, err)
      );
    }

    // 2. Auto-close threads where the warning was sent 24 h ago with no response
    const timedOut = await this.threadStore.getTimedOutWarnings(closeThreshold);
    for (const record of timedOut) {
      await this.autoCloseThread(record.threadId, record.warningMessageId).catch((err) =>
        console.error(`[InactivityMonitor] Failed to auto-close thread ${record.threadId}:`, err)
      );
    }
  }

  private async sendInactivityWarning(threadId: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId).catch(() => null);

    // Thread no longer accessible or already archived → mark closed
    if (!channel || !channel.isThread() || channel.archived) {
      await this.threadStore.closeThread(threadId);
      return;
    }

    const yesButton = new ButtonBuilder()
      .setCustomId("inactivity_yes")
      .setLabel("Yes, I still need help")
      .setEmoji("✋")
      .setStyle(ButtonStyle.Primary);

    const noButton = new ButtonBuilder()
      .setCustomId("inactivity_no")
      .setLabel("No, close this ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(yesButton, noButton);

    const embed = new EmbedBuilder()
      .setTitle("Are you still waiting for help?")
      .setDescription(
        "This ticket has been inactive for **24 days**.\n\n" +
        "• Click **Yes** to keep this ticket open and ping the support team again.\n" +
        "• Click **No** to close this ticket.\n\n" +
        "If there is no response in the next **24 days**, this ticket will be automatically closed."
      )
      .setColor(0xfee75c); // Yellow

    const msg = await channel.send({ embeds: [embed], components: [row] });
    await this.threadStore.setWarning(threadId, msg.id);
    console.log(`[InactivityMonitor] Warning sent to thread ${threadId}`);
  }

  private async autoCloseThread(
    threadId: string,
    warningMessageId: string | null
  ): Promise<void> {
    const channel = await this.client.channels.fetch(threadId).catch(() => null);

    if (channel && channel.isThread() && !channel.archived) {
      // Disable the warning message buttons
      if (warningMessageId) {
        const warningMsg = await channel.messages.fetch(warningMessageId).catch(() => null);
        if (warningMsg) {
          const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId("inactivity_auto_closed")
              .setLabel("Ticket Auto-Closed")
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true)
          );
          await warningMsg.edit({ components: [disabledRow] }).catch(() => {});
        }
      }

      const embed = new EmbedBuilder()
        .setTitle("Ticket Automatically Closed")
        .setDescription(
          "This ticket has been closed after **24 hours** of no response following the inactivity warning.\n\n" +
          "Feel free to open a new ticket if you still need help!"
        )
        .setColor(0xed4245); // Red

      await channel.send({ embeds: [embed] }).catch(() => {});
      await channel.setArchived(true);
    }

    await this.threadStore.closeThread(threadId);
    console.log(`[InactivityMonitor] Auto-closed thread ${threadId}`);
  }
}
