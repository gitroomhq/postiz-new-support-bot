import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { COLORS, embed as makeEmbed } from "../util/embeds";
import { isIntercomExempt, type BridgeSourceMessage } from "../intercom/IntercomSyncService";
import type { IntercomMode, IntercomRegion } from "../config/SettingsStore";
import type { TicketWithTag } from "./TicketStore";
import { intercomInboxUrl, parseTicket } from "../queue/queueModel";
import { log } from "../util/logger";
import type { TicketOutbox } from "../temporal/producers";

// /ticket, run inside a ticket thread: the Intercom ticket behind it (the
// number teammates see in the inbox, a link, its live state) and whether the
// thread is mirrored to Intercom at all, and if not, why.
//
// Authz is the support role or Administrator, checked at RUNTIME on the
// command and again on every button (registration shows the command to
// everyone who can see the channel, so it proves nothing). Replies are
// ephemeral: the inbox link and the sync internals never reach the customer.
// Buttons act on the thread they are pressed in, never on an id they carry.
//
// Sync now (staff) re-queues the ticket's mirror: the backfill for a ticket
// that never reached Intercom, a verify-ensure plus the missed-message heal
// for one that did, and it wakes a queue parked after a failed push. Repair
// sync (staff) replaces a workflow stranded on a task queue no worker polls,
// then runs the same heal (see temporal/strandedRuns.ts). Mirror to Intercom
// (Administrator) lifts a Discord-only refund ticket's exemption and runs the
// same sequence the customer's first typed message would.

export const TICKET_PREFIX = "ticketcmd_";
const ME_TTL_MS = 60 * 60_000;

export const TICKET_COMMAND = {
  name: "ticket",
  description: "This ticket's Intercom ticket: number, link, state and sync status (support/admin only)",
};

const cmdLog = log.child("ticket-command");

export interface SyncFailureFact {
  eventType: string;
  error: string;
  attempts: number;
  failedAt: Date;
}

export type RemoteTicket =
  | { kind: "none" } // the link has no ticket id (never converted)
  | { kind: "found"; number: string | null; stateLabel: string | null }
  | { kind: "missing" } // deleted in Intercom
  | { kind: "unknown" }; // Intercom did not answer

export interface SyncFacts {
  mode: IntercomMode;
  configured: boolean;
  exempt: boolean;
  link: { conversationId: string; ticketId: string | null; createdAt: Date } | null;
  remote: RemoteTicket;
  failure: SyncFailureFact | null;
  // null = unknown (Temporal did not answer). Without Temporal nothing can be
  // queued, so the caller passes an empty queue.
  queue: { depth: number; head: string | null } | null;
  // The task queue a stranded workflow run is bound to (one this worker does
  // not poll), else null.
  stranded: string | null;
  workerPaused: boolean;
  backfillClaimed: boolean;
}

export interface SyncReport {
  synced: "yes" | "partly" | "no";
  why: string | null;
  note: string | null;
  failure: SyncFailureFact | null;
  canSync: boolean;
  // Sync now may drop the "b" backfill marker: the import it guards is
  // provably gone (nothing queued), so keeping it would block a new one.
  releaseStaleClaim: boolean;
  canLift: boolean;
  canRepair: boolean;
}

const PAUSED = "The Temporal worker is paused (/config → Temporal), so nothing delivers until it resumes.";

function events(n: number): string {
  return `${n} event${n === 1 ? "" : "s"}`;
}

// Pure: what the facts say about this ticket's mirror. Order matters: the
// bridge being off or unconfigured explains everything below it.
export function diagnoseSync(f: SyncFacts): SyncReport {
  // A failure from before the link existed was the creation push, and the
  // link proves a later one went through.
  const failure = f.failure && (!f.link || f.failure.failedAt >= f.link.createdAt) ? f.failure : null;
  const report: SyncReport = {
    synced: "no",
    why: null,
    note: null,
    failure,
    canSync: false,
    releaseStaleClaim: false,
    canLift: false,
    canRepair: false,
  };
  const mirrored = f.link != null && f.remote.kind === "found";

  if (f.mode === "none") {
    report.synced = mirrored ? "partly" : "no";
    report.why = mirrored
      ? "Intercom sync is off (/intercom → Bridge). This ticket was mirrored earlier, but new messages are not."
      : "Intercom sync is off (/intercom → Bridge), so no ticket is mirrored.";
    return report;
  }
  if (!f.configured) {
    report.synced = mirrored ? "partly" : "no";
    report.why = "The Intercom bridge is not fully set up: it needs an access token, an author admin and a default ticket type (/intercom).";
    return report;
  }
  if (f.exempt) {
    report.why = "Discord-only refund ticket. It mirrors to Intercom once the customer sends a typed message.";
    report.canLift = true;
    return report;
  }
  // Ahead of the link checks: the run swallows the creation push as well.
  // Sync now would queue into the same run; Repair sync replaces it first.
  if (f.stranded) {
    report.synced = mirrored ? "partly" : "no";
    report.why =
      `This ticket's Temporal workflow is stuck on the task queue \`${f.stranded}\`, which no worker polls. ` +
      "Everything sent to Intercom since the queue changed went into it and was never delivered.";
    report.canRepair = true;
    return report;
  }

  if (!f.link) {
    const queued = f.queue?.depth ?? 0;
    if (failure) {
      report.why = "The push to Intercom failed, so the conversation was never created.";
      if (queued > 0) report.note = `${events(queued)} are held until it goes through.`;
      report.canSync = true;
      report.releaseStaleClaim = f.queue != null && queued === 0;
      return report;
    }
    if (queued > 0) {
      report.why = `Waiting in the delivery queue (${events(queued)}). It appears in Intercom once the first push goes through.`;
      if (f.workerPaused) report.note = PAUSED;
      return report;
    }
    if (f.queue == null) {
      if (f.workerPaused) {
        report.why = `Not in Intercom yet. ${PAUSED}`;
        return report;
      }
      report.why = "Not in Intercom yet, and Temporal did not answer, so whether it is queued is unknown.";
      report.canSync = true;
      return report;
    }
    report.why = f.backfillClaimed
      ? "A transcript import was queued but never delivered."
      : "Never pushed to Intercom: nothing is queued and no failure was recorded. It may predate the bridge.";
    report.canSync = true;
    report.releaseStaleClaim = f.backfillClaimed;
    return report;
  }

  switch (f.remote.kind) {
    case "none":
      report.synced = "partly";
      report.why = "The Intercom conversation exists but was never converted to a ticket.";
      report.canSync = true;
      return report;
    case "missing":
      report.why = "The Intercom ticket was deleted. Sync now rebuilds it.";
      report.canSync = true;
      return report;
    case "unknown":
      report.synced = "yes";
      report.note = "Intercom did not answer, so the ticket number and state are unavailable right now.";
      return report;
    case "found":
      if (failure) {
        report.synced = "partly";
        report.why = "Mirrored, but a later push failed, so Intercom may be missing part of this thread.";
        report.canSync = true;
        return report;
      }
      report.synced = "yes";
      if (f.queue == null) {
        report.note = f.workerPaused ? PAUSED : "Temporal did not answer, so whether anything is still waiting to deliver is unknown.";
      } else if (f.queue.depth > 0) {
        report.note = `${events(f.queue.depth)} still waiting to deliver.${f.workerPaused ? ` ${PAUSED}` : ""}`;
      }
      return report;
  }
}

type Interaction = ChatInputCommandInteraction | ButtonInteraction;

export interface TicketCommandDeps {
  // Replies with the refusal itself when it says no.
  authorize(interaction: Interaction): Promise<boolean>;
  isAdmin(interaction: Interaction): boolean;
  getTicket(threadId: string): Promise<TicketWithTag | null>;
  store: {
    getLink(threadId: string): Promise<{ conversationId: string; ticketId: string | null; createdAt: Date } | null>;
    getSyncFailure(threadId: string): Promise<SyncFailureFact | null>;
    clearSyncFailure(threadId: string): Promise<void>;
    hasBackfillClaim(threadId: string): Promise<boolean>;
  };
  settings: {
    intercomMode(): IntercomMode;
    intercomConfigured(): boolean;
    intercomRegion(): IntercomRegion;
  };
  intercom: {
    getTicketRaw(ticketId: string): Promise<unknown | null>;
    getMe(): Promise<{ appIdCode?: string | null }>;
  };
  // Null until index.ts binds the Temporal stack.
  temporal(): {
    routable(): boolean;
    enabled(): boolean;
    ticketOutbox(threadId: string): Promise<TicketOutbox | null>;
    intercomRetryNow(threadId: string): Promise<unknown>;
  } | null;
  sync: {
    repairTicket(
      ticket: TicketWithTag,
      messages: BridgeSourceMessage[] | null,
      opts: { releaseStaleClaim: boolean }
    ): Promise<{ kind: "backfill"; events: number } | { kind: "heal"; messages: number } | { kind: "queued" } | { kind: "skipped" }>;
    liftRefundTicket(
      ticket: TicketWithTag,
      actorName: string,
      loadPriorMessages: () => Promise<BridgeSourceMessage[]>
    ): Promise<"flipped" | "relayed" | "skipped" | "failed">;
  };
  // Null when the thread is gone.
  threadMessages(threadId: string): Promise<BridgeSourceMessage[] | null>;
  // Agent replies whose relay into the thread was dropped (bi mode only).
  inboundHeal(threadId: string, conversationId: string): Promise<number>;
  // Terminates the ticket's stranded runs, then heals it (StrandedRunRepair).
  repairStranded(threadId: string): Promise<{ terminated: number; recovered: number; inbound: number }>;
  // SLA rules for a ticket that just started mirroring.
  slaTrigger(threadId: string): void;
  audit(entry: {
    title: string;
    severity: "info" | "warn";
    actor: string;
    actorIconUrl: string;
    threadId: string;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
  }): void;
}

type Panel = { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] };

export class TicketCommand {
  private me: { at: number; idCode: string | null } | null = null;

  constructor(private deps: TicketCommandDeps) {}

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.deps.authorize(interaction))) return;
    const ticket = await this.deps.getTicket(interaction.channelId);
    if (!ticket) {
      await interaction.reply({ embeds: [makeEmbed("Run /ticket inside a ticket thread.", COLORS.warn)], flags: 64 });
      return;
    }
    await interaction.deferReply({ flags: 64 });
    await interaction.editReply(await this.render(ticket, this.deps.isAdmin(interaction), null));
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!(await this.deps.authorize(interaction))) return;
    const action = interaction.customId.slice(TICKET_PREFIX.length);
    const ticket = await this.deps.getTicket(interaction.channelId);
    if (!ticket) {
      await interaction.reply({ embeds: [makeEmbed("This is no longer a ticket thread.", COLORS.warn)], flags: 64 });
      return;
    }
    const admin = this.deps.isAdmin(interaction);
    await interaction.deferUpdate();
    let notice: string | null = null;
    if (action === "sync") notice = await this.syncNow(interaction, ticket);
    else if (action === "repair") notice = await this.repairNow(interaction, ticket);
    else if (action === "lift") notice = admin ? await this.lift(interaction, ticket) : "Administrator permission required.";
    // "refresh" and anything unknown just re-read the state.
    const fresh = (await this.deps.getTicket(ticket.threadId)) ?? ticket;
    await interaction.editReply(await this.render(fresh, admin, notice));
  }

  private async syncNow(interaction: ButtonInteraction, ticket: TicketWithTag): Promise<string> {
    const report = diagnoseSync(await this.facts(ticket));
    if (!report.canSync) return `Nothing to sync. ${report.why ?? "This ticket is mirrored."}`;

    const link = await this.deps.store.getLink(ticket.threadId);
    // Cleared first: a direct (Temporal-less) push that fails during the
    // repair records a fresh failure that must survive.
    await this.deps.store.clearSyncFailure(ticket.threadId);
    let result: Awaited<ReturnType<TicketCommandDeps["sync"]["repairTicket"]>>;
    try {
      const messages = await this.deps.threadMessages(ticket.threadId);
      result = await this.deps.sync.repairTicket(ticket, messages, { releaseStaleClaim: report.releaseStaleClaim });
    } catch (e) {
      cmdLog.error("ticket sync now failed", e, { "ticket.thread_id": ticket.threadId });
      return "Sync now failed before anything was queued. It is safe to press it again.";
    }
    let inbound = 0;
    if (link && result.kind === "heal") {
      inbound = await this.deps.inboundHeal(ticket.threadId, link.conversationId).catch(() => 0);
    }
    const temporal = this.deps.temporal();
    if (temporal?.routable()) await temporal.intercomRetryNow(ticket.threadId).catch(() => {});

    const summary =
      result.kind === "backfill"
        ? `Sync queued: ${events(result.events)} (conversation, ticket and transcript).`
        : result.kind === "heal"
          ? `Sync queued: the Intercom conversation and ticket are re-checked, ${result.messages} missed message${result.messages === 1 ? "" : "s"} re-queued${inbound > 0 ? `, ${inbound} Intercom repl${inbound === 1 ? "y" : "ies"} re-checked` : ""}.`
          : result.kind === "queued"
            ? "Already queued. The queue was asked to retry now."
            : "Nothing was queued: the bridge is off or this ticket is Discord-only.";
    if (result.kind !== "skipped") {
      this.deps.audit({
        title: "🔁 Intercom sync re-queued",
        severity: "info",
        actor: interaction.user.displayName,
        actorIconUrl: interaction.user.displayAvatarURL(),
        threadId: ticket.threadId,
        fields: [
          { name: "Was", value: report.why ?? "mirrored", inline: false },
          { name: "Result", value: summary, inline: false },
        ],
      });
    }
    return summary;
  }

  private async repairNow(interaction: ButtonInteraction, ticket: TicketWithTag): Promise<string> {
    const report = diagnoseSync(await this.facts(ticket));
    if (!report.canRepair) return `Nothing to repair. ${report.why ?? "This ticket's workflow is running normally."}`;
    let result: Awaited<ReturnType<TicketCommandDeps["repairStranded"]>>;
    try {
      result = await this.deps.repairStranded(ticket.threadId);
    } catch (e) {
      cmdLog.error("ticket repair failed", e, { "ticket.thread_id": ticket.threadId });
      return "Repair failed partway. It is safe to press it again.";
    }
    const summary =
      `Repaired: the stuck workflow was replaced, ${result.recovered} missed message${result.recovered === 1 ? "" : "s"} re-queued for Intercom` +
      `${result.inbound > 0 ? `, ${result.inbound} Intercom repl${result.inbound === 1 ? "y" : "ies"} re-checked` : ""}.`;
    this.deps.audit({
      title: "🧵 Intercom sync repaired",
      severity: "info",
      actor: interaction.user.displayName,
      actorIconUrl: interaction.user.displayAvatarURL(),
      threadId: ticket.threadId,
      fields: [
        { name: "Was", value: report.why ?? "stranded", inline: false },
        { name: "Result", value: summary, inline: false },
      ],
    });
    return summary;
  }

  private async lift(interaction: ButtonInteraction, ticket: TicketWithTag): Promise<string> {
    if (!isIntercomExempt(ticket)) return "This ticket is no longer Discord-only.";
    if (this.deps.settings.intercomMode() === "none" || !this.deps.settings.intercomConfigured()) {
      return "Intercom sync is off or not set up, so nothing can be mirrored.";
    }
    const result = await this.deps.sync.liftRefundTicket(ticket, interaction.user.displayName, async () =>
      (await this.deps.threadMessages(ticket.threadId)) ?? []
    );
    if (result === "flipped") {
      if (!ticket.closed) this.deps.slaTrigger(ticket.threadId);
      this.deps.audit({
        title: "🔀 Refund ticket flipped to Intercom",
        severity: "info",
        actor: interaction.user.displayName,
        actorIconUrl: interaction.user.displayAvatarURL(),
        threadId: ticket.threadId,
        fields: [{ name: "Trigger", value: "Lifted by staff with /ticket", inline: false }],
      });
      return "Mirroring to Intercom: the refund context, the transcript and the ticket are queued.";
    }
    if (result === "relayed") return "Already mirrored or queued; nothing new was sent.";
    if (result === "failed") return "Mirroring failed while queueing. It is safe to press it again.";
    return "Nothing was mirrored: the bridge is off or the ticket is gone.";
  }

  private async facts(ticket: TicketWithTag): Promise<SyncFacts> {
    const temporal = this.deps.temporal();
    const routable = temporal?.routable() ?? false;
    const idle: TicketOutbox = { kind: "queue", depth: 0, head: null };
    const [link, failure, claimed, outbox] = await Promise.all([
      this.deps.store.getLink(ticket.threadId),
      this.deps.store.getSyncFailure(ticket.threadId),
      this.deps.store.hasBackfillClaim(ticket.threadId),
      routable ? temporal!.ticketOutbox(ticket.threadId) : Promise.resolve(idle),
    ]);
    let remote: RemoteTicket = { kind: "none" };
    if (link?.ticketId) {
      try {
        const raw = await this.deps.intercom.getTicketRaw(link.ticketId);
        const parsed = raw == null ? null : parseTicket(raw);
        remote = parsed ? { kind: "found", number: parsed.number, stateLabel: parsed.stateLabel } : { kind: "missing" };
      } catch {
        remote = { kind: "unknown" };
      }
    }
    return {
      mode: this.deps.settings.intercomMode(),
      configured: this.deps.settings.intercomConfigured(),
      exempt: isIntercomExempt(ticket),
      link,
      remote,
      failure,
      queue: outbox?.kind === "queue" ? { depth: outbox.depth, head: outbox.head } : null,
      stranded: outbox?.kind === "stranded" ? outbox.taskQueue : null,
      workerPaused: routable && !temporal!.enabled(),
      backfillClaimed: claimed,
    };
  }

  // The bot's workspace id for inbox links, cached: it never changes for a token.
  private async workspaceIdCode(): Promise<string | null> {
    if (this.me && Date.now() - this.me.at < ME_TTL_MS) return this.me.idCode;
    try {
      const me = await this.deps.intercom.getMe();
      this.me = { at: Date.now(), idCode: me.appIdCode ?? null };
    } catch {
      return this.me?.idCode ?? null;
    }
    return this.me.idCode;
  }

  private async render(ticket: TicketWithTag, admin: boolean, notice: string | null): Promise<Panel> {
    const facts = await this.facts(ticket);
    const report = diagnoseSync(facts);
    const number = facts.remote.kind === "found" ? facts.remote.number : null;

    const embed = new EmbedBuilder()
      .setTitle(number ? `🎫 Intercom ticket #${number}` : "🎫 Intercom ticket")
      .setColor(report.synced === "yes" ? COLORS.success : report.failure ? COLORS.danger : COLORS.warn);
    const text = [
      notice ? `**${notice}**` : null,
      report.why ? `**Why:** ${report.why}` : null,
      report.note,
    ].filter(Boolean);
    if (text.length > 0) embed.setDescription(text.join("\n\n"));
    embed.addFields({ name: "Synced", value: { yes: "Yes", partly: "Partly", no: "No" }[report.synced], inline: true });
    if (facts.remote.kind === "found") {
      embed.addFields({ name: "State", value: facts.remote.stateLabel ?? "Unknown", inline: true });
    }
    if (report.failure) {
      const f = report.failure;
      const error = f.error.replace(/`/g, "'").slice(0, 700);
      embed.addFields({
        name: "Last failed push",
        value: `\`${f.eventType}\` after ${f.attempts} attempt${f.attempts === 1 ? "" : "s"}, <t:${Math.floor(f.failedAt.getTime() / 1000)}:R>\n${error}`,
        inline: false,
      });
    }

    const buttons: ButtonBuilder[] = [];
    if (facts.link) {
      const url = intercomInboxUrl(this.deps.settings.intercomRegion(), await this.workspaceIdCode(), facts.link.conversationId);
      buttons.push(new ButtonBuilder().setLabel("Open in Intercom").setStyle(ButtonStyle.Link).setURL(url));
    }
    if (report.canSync) {
      buttons.push(new ButtonBuilder().setCustomId(`${TICKET_PREFIX}sync`).setLabel("Sync now").setStyle(ButtonStyle.Primary));
    }
    if (report.canRepair) {
      buttons.push(new ButtonBuilder().setCustomId(`${TICKET_PREFIX}repair`).setLabel("Repair sync").setStyle(ButtonStyle.Primary));
    }
    if (report.canLift && admin) {
      buttons.push(new ButtonBuilder().setCustomId(`${TICKET_PREFIX}lift`).setLabel("Mirror to Intercom").setStyle(ButtonStyle.Primary));
    }
    buttons.push(new ButtonBuilder().setCustomId(`${TICKET_PREFIX}refresh`).setLabel("Refresh").setStyle(ButtonStyle.Secondary));
    return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] };
  }
}
