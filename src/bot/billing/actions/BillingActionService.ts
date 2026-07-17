import { randomUUID } from "node:crypto";
import { Client, EmbedBuilder } from "discord.js";
import { StripeClient } from "../../StripeClient";
import { SessionStore } from "../../../auth/SessionStore";
import { SettingsStore } from "../../../config/SettingsStore";
import { AuditLogger } from "../../AuditLogger";
import { TicketStore } from "../../TicketStore";
import { IntercomStore } from "../../../intercom/IntercomStore";
import type { IntercomEventExecutor } from "../../../intercom/IntercomEventExecutor";
import { BlockService } from "../BlockService";
import { RefundCoreService } from "../RefundCoreService";
import { ApprovalStore, BillingApproval } from "../ApprovalStore";
import { actionByKey, ActionActor, ActionExecCtx, BillingActionDef } from "./ActionRegistry";
import { COLORS } from "../../../util/embeds";
import { log } from "../../../util/logger";

const actionLog = log.child("billing:actions");

export type RequestOutcome =
  | { kind: "executed"; text: string }
  | { kind: "queued"; approvalId: string }
  | { kind: "denied"; error: string }
  | { kind: "invalid"; error: string }
  | { kind: "failed"; error: string };

export type ApprovalOutcome =
  | { kind: "executed"; text: string }
  | { kind: "rejected" }
  | { kind: "already_handled"; error: string }
  | { kind: "denied"; error: string }
  | { kind: "failed"; error: string };

// The Discord-independent brain behind every canvas/panel billing action.
// Level model (per action, /config → Billing → Intercom Actions):
//   none     → nobody may run it, admins included (ship-inert default)
//   approval → agents queue for admin approval; admins execute directly
//   all      → agents execute directly too
// Every entry point re-reads the level AND revalidates against live Stripe
// state at execution time — the invoker is hostile and config may have
// changed since the button was rendered (or since the approval was queued).
export class BillingActionService {
  // Late-bound Discord client for billing-audit embeds (AuditLogger idiom).
  private client: Client | null = null;
  // Double-click serialization: one in-flight execution per
  // conversation:action shape (SessionManager.runExclusive analogue).
  private inFlight = new Set<string>();

  constructor(
    private approvalStore: ApprovalStore,
    private settingsStore: SettingsStore,
    private stripe: StripeClient,
    private sessionStore: SessionStore,
    private blockService: BlockService,
    private refundCore: RefundCoreService,
    private intercomStore: IntercomStore,
    private ticketStore: TicketStore,
    private intercomExecutor: IntercomEventExecutor,
    private audit: AuditLogger
  ) {}

  bindClient(client: Client): void {
    this.client = client;
  }

  // Resolves how THIS actor may run THIS action right now.
  effectiveMode(actionKey: string, actor: ActionActor): "direct" | "queue" | "denied" {
    const def = actionByKey(actionKey);
    if (!def) return "denied";
    const level = this.settingsStore.billingActionLevel(def.key, def.defaultLevel);
    if (level === "none") return "denied";
    if (level === "all") return "direct";
    // "admin": only admins act — agents get nothing, not even a queue request.
    if (level === "admin") return actor.isAdmin ? "direct" : "denied";
    return actor.isAdmin ? "direct" : "queue";
  }

  // Mode map for a render pass (panel Overview / canvas): action key →
  // "direct" | "queue" | "hidden". Advisory only — execution re-checks.
  modeMap(actor: ActionActor, defs: BillingActionDef[]): Record<string, "direct" | "queue" | "hidden"> {
    const out: Record<string, "direct" | "queue" | "hidden"> = {};
    for (const def of defs) {
      const mode = this.effectiveMode(def.key, actor);
      out[def.key] = mode === "denied" ? "hidden" : mode;
    }
    return out;
  }

  // Entry point for canvas submits and panel action calls.
  async request(conversationId: string, actor: ActionActor, actionKey: string, rawParams: unknown): Promise<RequestOutcome> {
    const def = actionByKey(actionKey);
    if (!def) return { kind: "invalid", error: "Unknown action." };
    const parsed = def.parseParams(rawParams);
    if (!parsed.ok) return { kind: "invalid", error: parsed.error };

    // Level check NOW (hostile invoker: never trust the rendered UI).
    const mode = this.effectiveMode(actionKey, actor);
    if (mode === "denied") return { kind: "denied", error: "This action is disabled (/config → Billing → Intercom Actions)." };

    const ctx = await this.buildCtx(conversationId, actor, randomUUID());
    if (!ctx) return { kind: "invalid", error: "Not a Discord-bridged conversation." };

    const summary = def.summarize(parsed.params, this.stripe);

    if (mode === "queue") {
      const approval = await this.approvalStore.create({
        actionKey: def.key,
        params: parsed.params,
        summary,
        conversationId,
        ticketThreadId: ctx.ticketThreadId,
        stripeCustomerId: ctx.stripeCustomerId,
        requestedById: actor.id,
        requestedByName: actor.name,
      });
      await this.postNote(ctx, `📋 **Approval requested** by ${actor.name}: ${summary}\nAwaiting admin approval (expires in 7 days).`);
      await this.postBillingAudit({
        title: "Billing: Approval requested (Intercom)",
        summary,
        ctx,
        fields: [
          { name: "Requested by", value: actor.name, inline: true },
          { name: "Action", value: def.label, inline: true },
        ],
      });
      actionLog.info("billing.action.queued", {
        "action.key": def.key,
        "intercom.conversation_id": conversationId,
        "actor.id": actor.id,
      });
      return { kind: "queued", approvalId: approval.id };
    }

    const result = await this.executeNow(def, ctx, parsed.params, summary);
    return result.ok ? { kind: "executed", text: result.text } : { kind: "failed", error: result.error };
  }

  // Approve/reject a queued approval (canvas, panel, or Discord /billing hub).
  async actOnApproval(approvalId: string, reviewer: ActionActor, decision: "approve" | "reject"): Promise<ApprovalOutcome> {
    const approval = await this.approvalStore.get(approvalId);
    if (!approval) return { kind: "already_handled", error: "Approval not found." };
    const reviewerId = `${reviewer.kind}:${reviewer.id}`;

    if (decision === "reject") {
      // Rejection needs no admin bit: the requester (or any teammate) backing
      // out is harmless — but non-admins may only reject their OWN requests.
      if (!reviewer.isAdmin && !(reviewer.kind === "intercom" && reviewer.id === approval.requestedById)) {
        return { kind: "denied", error: "Only admins (or the requester) can reject an approval." };
      }
      const rejected = await this.approvalStore.reject(approvalId, reviewerId, reviewer.name);
      if (!rejected) return { kind: "already_handled", error: "Approval was already handled." };
      const ctx = await this.buildCtx(approval.conversationId, reviewer, approvalId);
      if (ctx) await this.postNote(ctx, `🚫 **Approval rejected** by ${reviewer.name}: ${approval.summary}`);
      await this.postBillingAudit({
        title: "Billing: Approval rejected (Intercom)",
        summary: approval.summary,
        ctx,
        fields: [
          { name: "Requested by", value: approval.requestedByName, inline: true },
          { name: "Rejected by", value: reviewer.name, inline: true },
        ],
      });
      return { kind: "rejected" };
    }

    if (!reviewer.isAdmin) return { kind: "denied", error: "Only configured admins can approve." };
    const def = actionByKey(approval.actionKey);
    if (!def) return { kind: "failed", error: "Action no longer exists in this build." };

    // Atomic single-winner claim — the double-approve guard.
    if (!(await this.approvalStore.claimForExecution(approvalId, reviewerId, reviewer.name))) {
      return { kind: "already_handled", error: "Already being handled by another reviewer." };
    }

    // Config may have changed since queueing: a now-disabled action must not
    // execute just because it was queued while enabled.
    const level = this.settingsStore.billingActionLevel(def.key, def.defaultLevel);
    if (level === "none") {
      await this.approvalStore.markFailed(approvalId, "Action was disabled after this approval was queued.");
      return { kind: "failed", error: "Action was disabled after this approval was queued." };
    }

    const parsed = def.parseParams(approval.paramsJson);
    if (!parsed.ok) {
      await this.approvalStore.markFailed(approvalId, `Stored params no longer parse: ${parsed.error}`);
      return { kind: "failed", error: `Stored params no longer parse: ${parsed.error}` };
    }

    // Rebuild ctx fresh — link/customer may have changed since queueing.
    const ctx = await this.buildCtx(approval.conversationId, reviewer, approvalId);
    if (!ctx) {
      await this.approvalStore.markFailed(approvalId, "Conversation is no longer bridged.");
      return { kind: "failed", error: "Conversation is no longer bridged." };
    }

    const result = await this.executeNow(def, ctx, parsed.params, approval.summary, approval);
    if (result.ok) {
      await this.approvalStore.markExecuted(approvalId, result.text);
      return { kind: "executed", text: result.text };
    }
    await this.approvalStore.markFailed(approvalId, result.error);
    return { kind: "failed", error: result.error };
  }

  async pendingForConversation(conversationId: string, limit: number): Promise<BillingApproval[]> {
    return this.approvalStore.listActionableForConversation(conversationId, limit);
  }

  // Read-only revalidation preview for admin views (Discord Approvals hub):
  // null = the action would still execute; a string = the refusal it would
  // hit. Never throws and moves no money.
  async previewRevalidation(approval: BillingApproval): Promise<string | null> {
    const def = actionByKey(approval.actionKey);
    if (!def) return "Action no longer exists in this build.";
    const parsed = def.parseParams(approval.paramsJson);
    if (!parsed.ok) return `Stored params no longer parse: ${parsed.error}`;
    const ctx = await this.buildCtx(approval.conversationId, { kind: "discord", id: "preview", name: "preview", isAdmin: true }, "preview");
    if (!ctx) return "Conversation is no longer bridged.";
    return def.revalidate(ctx, parsed.params).catch((e) => `Revalidation errored: ${e instanceof Error ? e.message : String(e)}`);
  }

  async pendingPage(offset: number, limit: number): Promise<{ rows: BillingApproval[]; total: number }> {
    return this.approvalStore.listActionable(offset, limit);
  }

  // ---- internals ----

  // Server-side resolution: conversation → IntercomLink → Ticket →
  // session.stripeCustomerId. The client NEVER supplies the customer.
  private async buildCtx(conversationId: string, actor: ActionActor, idemScope: string): Promise<ActionExecCtx | null> {
    const link = await this.intercomStore.getLinkByConversationId(conversationId);
    if (!link) return null;
    const ticket = await this.ticketStore.getByThreadId(link.ticketThreadId).catch(() => null);
    const discordCustomerId = ticket?.customerId ?? null;
    const session = discordCustomerId ? await this.sessionStore.getSession(discordCustomerId).catch(() => null) : null;
    return {
      stripe: this.stripe,
      sessionStore: this.sessionStore,
      settingsStore: this.settingsStore,
      blockService: this.blockService,
      refundCore: this.refundCore,
      stripeCustomerId: session?.stripeCustomerId ?? null,
      conversationId,
      ticketThreadId: link.ticketThreadId,
      discordCustomerId,
      actor,
      idemScope,
    };
  }

  // Shared by the direct and approved paths: in-flight guard → revalidate →
  // execute → note + audit. Never throws.
  private async executeNow(
    def: BillingActionDef,
    ctx: ActionExecCtx,
    params: unknown,
    summary: string,
    approval?: BillingApproval
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const flightKey = `${ctx.conversationId}:${def.key}`;
    if (this.inFlight.has(flightKey)) return { ok: false, error: "This action is already running — refresh in a moment." };
    this.inFlight.add(flightKey);
    try {
      const refusal = await def.revalidate(ctx, params).catch((e) => `Revalidation failed: ${e instanceof Error ? e.message : String(e)}`);
      if (refusal) return { ok: false, error: refusal };

      let result: { ok: true; text: string } | { ok: false; error: string };
      try {
        result = await def.execute(ctx, params);
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      const actorLine = approval
        ? `approved by ${ctx.actor.name} (requested by ${approval.requestedByName})`
        : `by ${ctx.actor.name}`;
      if (result.ok) {
        await this.postNote(ctx, `✅ **${def.label}** ${actorLine}: ${summary}\n${result.text}`);
      } else {
        await this.postNote(ctx, `⚠️ **${def.label}** ${actorLine} FAILED: ${summary}\n${result.error}`);
      }
      await this.postBillingAudit({
        title: `Billing: ${def.label} (Intercom)`,
        summary,
        ctx,
        fields: [
          ...(approval ? [{ name: "Requested by", value: approval.requestedByName, inline: true }] : []),
          { name: approval ? "Approved by" : "Actor", value: ctx.actor.name, inline: true },
          { name: "Outcome", value: result.ok ? result.text : `FAILED: ${result.error}`, inline: false },
        ],
      });
      actionLog.info("billing.action.executed", {
        "action.key": def.key,
        "action.ok": result.ok,
        "intercom.conversation_id": ctx.conversationId,
        "actor.id": ctx.actor.id,
        "approval.id": approval?.id ?? "",
      });
      return result;
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  // Best-effort internal note — a note failure must never fail the action.
  private async postNote(ctx: ActionExecCtx, body: string): Promise<void> {
    if (!ctx.ticketThreadId) return;
    await this.intercomExecutor.postPanelNote(ctx.ticketThreadId, ctx.conversationId, body).catch((e) => {
      actionLog.warn("panel note failed", { "error.message": e instanceof Error ? e.message : String(e) });
    });
  }

  // Billing-audit embed (no role pings), mirrored into the general audit
  // trail unless both settings point at the same channel — same convention as
  // BillingCategory.notifyBillingAudit.
  private async postBillingAudit(input: {
    title: string;
    summary: string;
    ctx: ActionExecCtx | null;
    fields: { name: string; value: string; inline?: boolean }[];
  }): Promise<void> {
    try {
      const embed = new EmbedBuilder()
        .setTitle(input.title)
        .setColor(COLORS.brand)
        .addFields(
          { name: "Summary", value: input.summary.slice(0, 1024), inline: false },
          ...(input.ctx?.stripeCustomerId ? [{ name: "Customer", value: `\`${input.ctx.stripeCustomerId}\``, inline: true }] : []),
          ...(input.ctx?.ticketThreadId ? [{ name: "Ticket", value: `<#${input.ctx.ticketThreadId}>`, inline: true }] : []),
          ...input.fields.map((f) => ({ ...f, value: f.value.slice(0, 1024) || "—" }))
        )
        .setTimestamp();
      const channelId = this.settingsStore.billingAuditChannelId();
      if (channelId && this.client) {
        const channel = await this.client.channels.fetch(channelId).catch(() => null);
        if (channel?.isSendable()) await channel.send({ embeds: [embed] });
      }
    } catch (e) {
      actionLog.warn("billing audit post failed", { "error.message": e instanceof Error ? e.message : String(e) });
    } finally {
      if (this.settingsStore.auditLogChannelId() !== this.settingsStore.billingAuditChannelId()) {
        void this.audit.log({
          title: `💳 ${input.title}`,
          severity: "warn",
          description: input.summary,
          fields: input.fields,
        });
      }
    }
  }
}
