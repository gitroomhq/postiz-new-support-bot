import { ButtonStyle, type ButtonInteraction, type ThreadChannel } from "discord.js";
import { embed as makeEmbed, COLORS } from "../../../util/embeds";
import { log } from "../../../util/logger";
import { IntercomHttpError } from "../../../intercom/IntercomClient";
import { btn, buttonRow, backRow, panelEmbed } from "../ui";
import type { Panel, RouteEntry } from "../types";
import type { HubContext } from "./HubContext";

const maintLog = log.child("intercom-admin:maint");

// /intercom → Maintenance: backfill, heal message gaps, closed-state re-sync,
// reset bridge data, wipe Intercom data (all verbatim ports of the /config
// handlers) plus "Revoke Stripe Panel Links" (panel token epoch bump).
export class MaintenanceHub {
  constructor(private ctx: HubContext) {}

  readonly routes: RouteEntry[] = [
    { kind: "button", id: "icadmin_maint_backfill", match: "exact", handler: (i) => this.handleBackfillConfirm(i) },
    { kind: "button", id: "icadmin_maint_backfill_go", match: "exact", handler: (i) => this.handleBackfillGo(i) },
    { kind: "button", id: "icadmin_maint_heal", match: "exact", handler: (i) => this.handleHeal(i) },
    { kind: "button", id: "icadmin_maint_resync", match: "exact", handler: (i) => this.handleResync(i) },
    { kind: "button", id: "icadmin_maint_reset", match: "exact", handler: (i) => this.handleResetConfirm(i) },
    { kind: "button", id: "icadmin_maint_reset_go", match: "exact", handler: (i) => this.handleResetGo(i) },
    { kind: "button", id: "icadmin_maint_wipe", match: "exact", handler: (i) => this.handleWipeConfirm(i) },
    { kind: "button", id: "icadmin_maint_wipe_go", match: "exact", handler: (i) => this.handleWipeGo(i) },
    { kind: "button", id: "icadmin_maint_revoke_panel", match: "exact", handler: (i) => this.handleRevokePanelLinks(i) },
  ];

  async buildPanel(): Promise<Panel> {
    const [links, total] = await Promise.all([
      this.ctx.intercomStore.countLinks().catch(() => 0),
      this.ctx.ticketStore.getAllWithTag().then((t) => t.length).catch(() => 0),
    ]);
    const embed = panelEmbed(
      "Intercom Maintenance",
      [
        `**Bridged tickets:** ${links}/${total}`,
        "",
        "**Backfill tickets**: replay every unbridged ticket (open + closed, full transcripts) into Intercom.",
        "**Heal Message Gaps**: outage repair over OPEN tickets, both directions (missed outbound messages + dropped agent-reply relays).",
        "**Sync Closed Tickets**: re-assert the closed state of Discord-closed tickets onto Intercom (fixes incident auto-reopens).",
        "**Reset bridge data**: wipe the bot's LOCAL bridge state (nothing deleted in Intercom).",
        "**Wipe Intercom data**: permanently delete bridge-created conversations/tickets from Intercom + clear local state.",
        "**Revoke Stripe Panel Links**: instantly invalidate every outstanding Stripe-panel link and session.",
        "",
        "Destructive tools ask twice.",
      ].join("\n")
    );
    return {
      embeds: [embed],
      components: [
        buttonRow(
          btn("icadmin_maint_backfill", "Backfill tickets", ButtonStyle.Primary),
          btn("icadmin_maint_heal", "Heal Message Gaps", ButtonStyle.Primary),
          btn("icadmin_maint_resync", "Sync Closed Tickets", ButtonStyle.Secondary)
        ),
        buttonRow(
          btn("icadmin_maint_reset", "Reset bridge data", ButtonStyle.Danger),
          btn("icadmin_maint_wipe", "Wipe Intercom data", ButtonStyle.Danger),
          btn("icadmin_maint_revoke_panel", "Revoke Stripe Panel Links", ButtonStyle.Secondary)
        ),
        backRow(),
      ],
    };
  }

  // ---- backfill ----

  private async handleBackfillConfirm(interaction: ButtonInteraction): Promise<void> {
    // Confirm with counts first — a replay of every unbridged ticket is a
    // long, noisy drain.
    const [links, total] = await Promise.all([
      this.ctx.intercomStore.countLinks().catch(() => 0),
      this.ctx.ticketStore.getAllWithTag().then((t) => t.length).catch(() => 0),
    ]);
    const unbridged = Math.max(0, total - links);
    await interaction.update({
      embeds: [
        makeEmbed(
          [
            `This replays **${unbridged}** unbridged ticket(s) (open + closed, full transcripts) into Intercom; ${links} already-bridged ticket(s) are skipped.`,
            "",
            "The drain is paced (~1 event / 300ms) and runs in the background via the ticket workflows. Closed tickets are re-closed at the end of each replay.",
          ].join("\n"),
          COLORS.warn
        ),
      ],
      components: [
        buttonRow(
          btn("icadmin_maint_backfill_go", "Start backfill", ButtonStyle.Primary, unbridged === 0),
          btn("icadmin_hub:maintenance", "Cancel", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async handleBackfillGo(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    await this.runBackfill(interaction);
  }

  private async runBackfill(interaction: ButtonInteraction): Promise<void> {
    const progress = await interaction
      .followUp({ embeds: [makeEmbed("Intercom backfill started…", COLORS.neutral)], flags: 64 })
      .catch(() => null);
    const report = async (text: string, color: number = COLORS.neutral) => {
      if (!progress) return;
      await interaction.webhook.editMessage(progress.id, { embeds: [makeEmbed(text, color)] }).catch(() => {});
    };

    try {
      const discord = this.ctx.discord();
      const tickets = await this.ctx.ticketStore.getAllWithTag(); // oldest first
      let enqueuedTickets = 0;
      let enqueuedEvents = 0;
      let skipped = 0;
      let processed = 0;

      for (const ticket of tickets) {
        processed++;
        if (await this.ctx.intercomStore.getLink(ticket.threadId)) {
          skipped++;
          continue;
        }

        const channel = await discord?.client.channels.fetch(ticket.threadId).catch(() => null);
        const thread = channel?.isThread() ? (channel as ThreadChannel) : null;
        const messages = thread && discord ? await discord.fetchAllThreadMessages(thread) : null;

        // Messages-only mirroring: notes/status history stay in Discord.
        const count = await this.ctx.intercomSync.backfillTicket(ticket, messages);
        if (count != null) {
          enqueuedTickets++;
          enqueuedEvents += count;
        } else {
          skipped++;
        }

        if (processed % 10 === 0) {
          await report(`Intercom backfill: ${processed}/${tickets.length} tickets scanned, ${enqueuedEvents} events queued…`);
        }
      }

      const summary = `Intercom backfill queued **${enqueuedTickets}** ticket(s) (**${enqueuedEvents}** events), skipped ${skipped} already bridged. The ticket workflows push them in the background; watch the delivery workflows in /config → Temporal.`;
      await report(summary, COLORS.success);
      void this.ctx.auditLogger.log({
        title: "🌉 Intercom backfill",
        severity: "info",
        actor: interaction.user.displayName,
        fields: [{ name: "Result", value: summary }],
      });
    } catch (error) {
      maintLog.error("intercom backfill failed", error);
      await report("Intercom backfill failed. Check the logs; you can safely run it again from /intercom → Maintenance.", COLORS.danger);
    }
  }

  // ---- heal message gaps ----

  private async handleHeal(interaction: ButtonInteraction): Promise<void> {
    // Outage repair over OPEN tickets, BOTH directions — see runHeal.
    await interaction.deferReply({ flags: 64 });
    if (this.ctx.settingsStore.intercomMode() === "none") {
      await interaction.editReply({
        embeds: [makeEmbed("The bridge is off. Enable Push or Bidirectional first (Bridge hub), then heal.", COLORS.warn)],
      });
      return;
    }
    await this.runHeal(interaction);
  }

  // "Heal Message Gaps": outage repair over OPEN tickets only (closed ones
  // are Backfill's job). Bridged → healMessageGaps re-enqueues human messages
  // missing from the delivered ledger, THEN the ticket's full Intercom part
  // history is re-fed through the inbound relay path. Unbridged mirrorable →
  // backfillTicket. Idempotent end to end.
  private async runHeal(interaction: ButtonInteraction): Promise<void> {
    const progress = await interaction
      .followUp({ embeds: [makeEmbed("Intercom gap heal started…", COLORS.neutral)], flags: 64 })
      .catch(() => null);
    const report = async (text: string, color: number = COLORS.neutral) => {
      if (!progress) return;
      await interaction.webhook.editMessage(progress.id, { embeds: [makeEmbed(text, color)] }).catch(() => {});
    };

    try {
      const discord = this.ctx.discord();
      const tickets = (await this.ctx.ticketStore.getAllWithTag()).filter((t) => !t.closed);
      let healedTickets = 0;
      let healedMessages = 0;
      let bridgedTickets = 0;
      let untouched = 0;
      let gone = 0;
      let processed = 0;
      let inboundParts = 0;
      let inboundTickets = 0;
      let inboundFailures = 0;
      const pause = () => new Promise((r) => setTimeout(r, 150));

      for (const ticket of tickets) {
        processed++;
        const channel = await discord?.client.channels.fetch(ticket.threadId).catch(() => null);
        const thread = channel?.isThread() ? (channel as ThreadChannel) : null;
        if (!thread || !discord) {
          gone++;
          continue;
        }
        const messages = await discord.fetchAllThreadMessages(thread);
        const link = await this.ctx.intercomStore.getLink(ticket.threadId);
        if (link) {
          const healed = await this.ctx.intercomSync.healMessageGaps(ticket, messages).catch(() => null);
          if (healed != null && healed > 0) {
            healedTickets++;
            healedMessages += healed;
          } else {
            untouched++;
          }
          // Inbound half: agent replies whose webhook relay was dropped —
          // re-fetch the FULL part history and feed it through the relay
          // path. The part-id ledger no-ops everything already relayed.
          await pause(); // politeness pacing — one Intercom GET per bridged ticket
          try {
            const parts = await this.ctx.intercomClient.getConversationPartsSince(link.conversationId, 0);
            const fed = await this.ctx.intercomWebhook.relayHealedParts(ticket.threadId, parts);
            if (fed > 0) {
              inboundTickets++;
              inboundParts += fed;
            }
          } catch (e) {
            inboundFailures++;
            maintLog.warn("inbound gap heal failed", {
              "ticket.thread_id": ticket.threadId,
              "error.message": e instanceof Error ? e.message : String(e),
            });
          }
        } else {
          const count = await this.ctx.intercomSync.backfillTicket(ticket, messages).catch(() => null);
          if (count != null) bridgedTickets++;
          else untouched++;
        }
        if (processed % 10 === 0) {
          await report(`Gap heal: ${processed}/${tickets.length} open tickets scanned, ${healedMessages} messages queued…`);
        }
      }

      const summary = [
        `Gap heal finished over **${tickets.length}** open ticket(s):`,
        `• **${healedMessages}** missed message(s) re-queued across **${healedTickets}** bridged ticket(s)`,
        `• **${inboundParts}** Intercom agent part(s) re-checked across **${inboundTickets}** bridged ticket(s): missed replies were relayed into their threads, already-relayed ones no-op`,
        `• **${bridgedTickets}** unbridged ticket(s) sent to backfill (link + full transcript)`,
        `• ${untouched} needed nothing, ${gone} thread(s) gone`,
        ...(inboundFailures > 0 ? [`⚠️ ${inboundFailures} ticket(s) failed the inbound re-check; safe to run the heal again.`] : []),
        "",
        "Delivery is paced through the ticket workflows; replayed parts keep their original timestamps (created_at backdating).",
      ].join("\n");
      await report(summary, COLORS.success);
      void this.ctx.auditLogger.log({
        title: "🌉 Intercom gap heal",
        severity: "info",
        actor: interaction.user.displayName,
        fields: [{ name: "Result", value: summary.slice(0, 1024) }],
      });
    } catch (error) {
      maintLog.error("intercom gap heal failed", error);
      await report("Gap heal failed. Check the audit channel; it is safe to run again from /intercom → Maintenance.", COLORS.danger);
    }
  }

  // ---- closed-state re-sync ----

  private async handleResync(interaction: ButtonInteraction): Promise<void> {
    // Drift reconcile: every ticket closed/resolved in Discord re-asserts its
    // closed state onto Intercom (damper-bypassing), closing conversations
    // that incident auto-reopens left open. Nothing is deleted.
    await interaction.deferReply({ flags: 64 });
    if (this.ctx.settingsStore.intercomMode() === "none") {
      await interaction.editReply({
        embeds: [makeEmbed("The bridge is off. Enable Push or Bidirectional first (Bridge hub), then run the sync.", COLORS.warn)],
      });
      return;
    }
    const links = await this.ctx.intercomStore.listAllLinks();
    let enqueued = 0;
    for (const link of links) {
      const ticket = await this.ctx.ticketStore.getByThreadId(link.ticketThreadId).catch(() => null);
      if (!ticket) continue;
      if (await this.ctx.intercomSync.resyncClosedStatus(ticket).catch(() => false)) enqueued++;
    }
    const summary = `Re-sync queued for **${enqueued}** closed/resolved ticket(s) (of ${links.length} bridged). Their Intercom conversations close in the background via the normal paced delivery queue.`;
    await interaction.editReply({ embeds: [makeEmbed(summary, COLORS.success)] });
    this.ctx.auditConfig(interaction, `Intercom closed-state re-sync (${enqueued} tickets)`);
  }

  // ---- reset (local) ----

  private async handleResetConfirm(interaction: ButtonInteraction): Promise<void> {
    const links = await this.ctx.intercomStore.countLinks();
    await interaction.update({
      embeds: [
        makeEmbed(
          [
            `This deletes the bot's local bridge state: **${links}** link(s) plus the echo/pending ledgers.`,
            "",
            "Nothing is deleted in Intercom itself. Use this when the Intercom side was cleared or recreated and the bookkeeping is stale; the next **Backfill** rebuilds every ticket from Discord.",
            "⚠️ If the conversations/tickets still exist in Intercom, the next backfill will create duplicates.",
          ].join("\n"),
          COLORS.warn
        ),
      ],
      components: [
        buttonRow(
          btn("icadmin_maint_reset_go", "Yes, wipe bridge data", ButtonStyle.Danger),
          btn("icadmin_hub:maintenance", "Cancel", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async handleResetGo(interaction: ButtonInteraction): Promise<void> {
    // Queued (pre-reset) events in the ticket workflows would resurrect the
    // bridge state being reset — clear their outboxes (targets collected
    // before resetAll, signals sent after).
    const clearTargets = await this.collectClearTargets();
    const result = await this.ctx.intercomStore.resetAll();
    await this.signalClear(clearTargets);
    this.ctx.auditConfig(interaction, `Intercom bridge data reset (${result.links} links, ${result.parts} echo/pending rows deleted)`);
    await interaction.update(await this.buildPanel());
    await interaction.followUp({
      embeds: [makeEmbed(`Bridge data wiped: ${result.links} link(s). Run **Backfill tickets** to rebuild.`, COLORS.success)],
      flags: 64,
    });
  }

  // ---- wipe (remote + local) ----

  private async handleWipeConfirm(interaction: ButtonInteraction): Promise<void> {
    const links = await this.ctx.intercomStore.listAllLinks();
    const contacts = new Set(links.map((l) => l.contactId)).size;
    const tickets = links.filter((l) => l.ticketId).length;
    await interaction.update({
      embeds: [
        makeEmbed(
          [
            `⚠️ From Intercom this **permanently deletes** **${links.length}** conversation(s) and **${tickets}** converted ticket(s), and **archives** **${contacts}** bridge-created contact(s) (archiving keeps their external_ids reusable; a permanent contact delete would lock them for 7 days and block re-backfilling).`,
            "",
            "The bot's local bridge state (links + queued events + echo ledger) is wiped too, so a later **Backfill** can rebuild everything cleanly.",
            "Only bridge-created objects are touched; Intercom-native conversations/contacts and all Discord threads stay untouched.",
          ].join("\n"),
          COLORS.danger
        ),
      ],
      components: [
        buttonRow(
          btn("icadmin_maint_wipe_go", "Yes, delete everything from Intercom", ButtonStyle.Danger, links.length === 0),
          btn("icadmin_hub:maintenance", "Cancel", ButtonStyle.Secondary)
        ),
      ],
    });
  }

  private async handleWipeGo(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: 64 });
    await this.runWipe(interaction);
  }

  // Remote wipe: hard-deletes bridge-created tickets and conversations, and
  // ARCHIVES contacts. Local state goes FIRST so the outbox drainer can't race
  // the wipe. Failures are collected and reported, never fatal.
  private async runWipe(interaction: ButtonInteraction): Promise<void> {
    const report = async (text: string, color: number = COLORS.neutral) => {
      await interaction.editReply({ embeds: [makeEmbed(text, color)] }).catch(() => {});
    };
    const pause = () => new Promise((r) => setTimeout(r, 150));
    const isGone = (e: unknown) => e instanceof IntercomHttpError && e.status === 404;

    try {
      const links = await this.ctx.intercomStore.listAllLinks();
      const clearTargets = await this.collectClearTargets();
      const local = await this.ctx.intercomStore.resetAll();
      await this.signalClear(clearTargets);
      await report(`Intercom wipe started: ${links.length} conversation(s) to delete…`);

      let tickets = 0;
      let conversations = 0;
      let contacts = 0;
      const failures: string[] = [];
      let processed = 0;

      for (const link of links) {
        processed++;
        if (link.ticketId) {
          try {
            await this.ctx.intercomClient.deleteTicket(link.ticketId);
            tickets++;
          } catch (e) {
            if (!isGone(e)) failures.push(`ticket ${link.ticketId}`);
          }
          await pause();
        }
        try {
          await this.ctx.intercomClient.deleteConversation(link.conversationId);
          conversations++;
        } catch (e) {
          if (!isGone(e)) failures.push(`conversation ${link.conversationId}`);
        }
        await pause();
        if (processed % 10 === 0) {
          await report(`Intercom wipe: ${processed}/${links.length} conversations processed…`);
        }
      }

      // Contacts last (deduped — one contact can own several conversations).
      for (const contactId of [...new Set(links.map((l) => l.contactId))]) {
        try {
          await this.ctx.intercomClient.archiveContact(contactId);
          contacts++;
        } catch (e) {
          if (!isGone(e)) failures.push(`contact ${contactId}`);
        }
        await pause();
      }

      const summary = [
        `Intercom wipe done: deleted **${tickets}** ticket(s), **${conversations}** conversation(s); archived **${contacts}** contact(s); local state cleared (${local.links} links).`,
        ...(failures.length > 0
          ? [`⚠️ ${failures.length} deletion(s) failed; remove these in Intercom by hand: ${failures.slice(0, 10).join(", ")}${failures.length > 10 ? ", …" : ""}`]
          : []),
      ].join("\n");
      await report(summary, failures.length > 0 ? COLORS.warn : COLORS.success);
      void this.ctx.auditLogger.log({
        title: "🌉 Intercom data wiped",
        severity: "warn",
        actor: interaction.user.displayName,
        fields: [{ name: "Result", value: summary.slice(0, 1024) }],
      });
    } catch (error) {
      maintLog.error("wipe failed", error);
      await report(
        "Intercom wipe failed. Check the logs. Local state may already be cleared; re-running the wipe only affects objects that still have links, so remaining Intercom objects must be removed by hand.",
        COLORS.danger
      );
    }
  }

  // ---- Stripe panel link revocation ----

  private async handleRevokePanelLinks(interaction: ButtonInteraction): Promise<void> {
    const epoch = await this.ctx.settingsStore.bumpPanelTokenEpoch();
    this.ctx.auditConfig(interaction, `Stripe panel links revoked (token epoch → ${epoch})`);
    await interaction.reply({
      embeds: [
        makeEmbed(
          "All outstanding Stripe-panel links and sessions are now invalid. Agents reopen the panel from the Intercom conversation (Open Stripe Panel).",
          COLORS.success
        ),
      ],
      flags: 64,
    });
  }

  // ---- shared: outbox clearing (reset/wipe) ----

  // Queued Intercom events live in workflow state and survive resetAll, so
  // they must be cleared by signal. Collect BEFORE resetAll (it deletes the
  // "b" backfill markers), signal AFTER resetAll.
  private async collectClearTargets(): Promise<string[]> {
    const targets = new Set<string>();
    for (const link of await this.ctx.intercomStore.listAllLinks().catch(() => [])) targets.add(link.ticketThreadId);
    for (const threadId of await this.ctx.intercomStore.listBackfillClaimedThreadIds().catch(() => [])) {
      targets.add(threadId);
    }
    for (const ticket of await this.ctx.ticketStore.listOpenWithTag().catch(() => [])) targets.add(ticket.threadId);
    return [...targets];
  }

  private async signalClear(targets: string[]): Promise<void> {
    if (!this.ctx.producers.routable()) return;
    const CHUNK = 20;
    for (let i = 0; i < targets.length; i += CHUNK) {
      await Promise.allSettled(targets.slice(i, i + CHUNK).map((threadId) => this.ctx.producers.intercomClearOutbox(threadId)));
    }
  }
}
