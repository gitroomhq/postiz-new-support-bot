import type { AuditLogger } from "../bot/AuditLogger";
import type { SettingsStore } from "../config/SettingsStore";
import { log } from "../util/logger";
import type { IntercomClient } from "./IntercomClient";
import { escapeHtmlText } from "./IntercomEventExecutor";
import type { ForwarderRoster } from "./forwarderRoster";

const dtLog = log.child("intercom:fwddetach");

export type DetachOutcome = "detached" | "skipped" | "unsupported";

// Cleanup for Intercom's NATIVE "detect customers in forwarded emails".
//
// When a full-seat teammate (or any address the native feature covers) forwards
// a customer email in, Intercom attaches the real sender to the conversation —
// which is the half that works. What it does NOT do is remove the forwarder, so
// the thread is left with two participants and every reply also emails the
// person who forwarded it. This detaches the forwarder afterwards.
//
// This is the counterpart to ForwardedEmailConverter: that class handles the
// conversations Intercom's native detection SKIPS (lite seats, listed
// addresses) by recreating them; this one repairs the ones it handled. Both
// share ForwarderRoster so they can never disagree about who a forwarder is.
//
// Idempotency needs no ledger: once a forwarder is detached the conversation no
// longer has a forwarder participant, so the check simply stops matching.
export class ForwarderDetacher {
  // Remembers conversations whose workspace does not support the participant
  // endpoint, so the sweep does not re-probe the same 404 every five minutes.
  private unsupported = false;

  constructor(
    private settingsStore: SettingsStore,
    private client: IntercomClient,
    private roster: ForwarderRoster,
    private audit: AuditLogger
  ) {}

  // Fast pre-filter for the sweep, using ids the conversation search already
  // returned. One participant can never be a forwarder that needs removing.
  needsCheck(participantIds: string[]): boolean {
    return this.enabled() && participantIds.length >= 2;
  }

  private enabled(): boolean {
    return (
      !this.unsupported &&
      this.settingsStore.forwardConvertEnabled() &&
      this.settingsStore.forwardDetachForwarder() &&
      this.settingsStore.intercomConfigured()
    );
  }

  // Best-effort by construction: never throws. A detach failure must not fail
  // the webhook or sweep that noticed it — the next pass tries again.
  async maybeDetach(conversationId: string): Promise<DetachOutcome> {
    if (!this.enabled()) return "skipped";
    const adminId = this.settingsStore.intercomAdminId() ?? this.settingsStore.intercomAuthorAdminId();
    if (!adminId) return "skipped";

    try {
      return await this.detach(conversationId, adminId);
    } catch (e) {
      dtLog.warn("fwddetach failed", {
        "intercom.conversation_id": conversationId,
        "error.message": e instanceof Error ? e.message : String(e),
      });
      return "skipped";
    }
  }

  private async detach(conversationId: string, adminId: string): Promise<DetachOutcome> {
    const participants = await this.client.listConversationParticipants(conversationId);
    if (participants.length < 2) return "skipped";

    const forwarders: Array<{ id: string; email: string | null }> = [];
    const keep: Array<{ id: string; email: string | null }> = [];
    for (const p of participants) {
      if (p.email && (await this.roster.isForwarderEmail(p.email))) forwarders.push(p);
      else keep.push(p);
    }
    if (forwarders.length === 0) return "skipped";

    // The guard that matters: removing every forwarder must still leave a real
    // customer on the thread. A conversation whose ONLY participants are
    // forwarders is an internal thread, not a converted forward — emptying it
    // would orphan the conversation and lose the reply-to address.
    if (keep.length === 0) {
      dtLog.info("fwddetach.skip", {
        "intercom.conversation_id": conversationId,
        "fwddetach.reason": "every participant is a forwarder; nothing would remain",
      });
      return "skipped";
    }

    const removed: string[] = [];
    for (const f of forwarders) {
      const outcome = await this.client.removeConversationParticipant(conversationId, f.id, adminId);
      if (outcome === "unsupported") {
        // The workspace's API version has no participant endpoint. Stop asking
        // — and say so out loud rather than silently doing nothing forever.
        this.unsupported = true;
        dtLog.warn("fwddetach.unsupported", {
          "intercom.conversation_id": conversationId,
          "fwddetach.reason": "Intercom rejected the participant endpoint; forwarder detaching is now disabled for this process",
        });
        return "unsupported";
      }
      removed.push(f.email ?? f.id);
    }

    // Internal NOTE, never a comment: a comment would email the customer and
    // stamp first_admin_reply_at, satisfying the SLA first-reply clock unearned
    // and flipping the idle sweeper into agent-spoke-last.
    await this.client
      .replyAsAdmin(conversationId, {
        adminId,
        note: true,
        body:
          `<p><b>Forwarder detached</b></p>` +
          `<p>Removed from this conversation: ${removed.map((r) => escapeHtmlText(r)).join(", ")}</p>` +
          `<p>Intercom attached the original sender but left the forwarding address as a participant; replies would have emailed them too.</p>`,
      })
      .catch((e) => {
        dtLog.warn("fwddetach: note failed", {
          "intercom.conversation_id": conversationId,
          "error.message": e instanceof Error ? e.message : String(e),
        });
      });

    dtLog.info("fwddetach.detached", {
      "intercom.conversation_id": conversationId,
      "fwddetach.removed": removed.length,
      "fwddetach.remaining": keep.length,
    });
    void this.audit.log({
      title: "📨 Forwarder detached",
      description: [
        `Conversation ${conversationId}: removed ${removed.join(", ")} as participant(s).`,
        `${keep.length} customer participant(s) remain.`,
      ].join(" "),
      severity: "info",
    });
    return "detached";
  }
}
