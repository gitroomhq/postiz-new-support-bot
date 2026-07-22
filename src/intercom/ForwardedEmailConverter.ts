import type { AuditLogger } from "../bot/AuditLogger";
import type { SettingsStore } from "../config/SettingsStore";
import { log } from "../util/logger";
import type { ForwardConvertStore } from "./ForwardConvertStore";
import { IntercomHttpError, type IntercomClient } from "./IntercomClient";
import { archivedContactId, escapeHtmlText } from "./IntercomEventExecutor";
import { buildForwardConversationBody, parseForwardedEmail } from "./forwardedEmailParse";
import type { IntercomAdmin } from "./types";

const cvLog = log.child("intercom:fwdconvert");

// Teammate roster cache for the lite-seat forwarder check — the webhook gate
// runs per inbound email and must not hammer /admins.
const ADMINS_TTL_MS = 5 * 60 * 1000;
// Intercom reply cap for attachment_urls.
const ATTACHMENT_CHUNK = 10;

type PayloadSource = { subject?: string | null; author?: { type?: string; email?: string | null } };

// Replicates Intercom's "Detect customers in forwarded emails" for lite-seat
// teammates and listed extra addresses (the native feature only runs for
// full-seat admins): recreate the conversation authored as the original
// sender, close the misattributed one. Fully automatic on the
// conversation.user.created webhook — there is deliberately no manual surface
// (a canvas repair card existed briefly and was cut as unused); a forward the
// parser misses stays attributed to the forwarder, exactly like before this
// feature.
export class ForwardedEmailConverter {
  private adminsCache: { at: number; admins: IntercomAdmin[] } | null = null;

  constructor(
    private settingsStore: SettingsStore,
    private client: IntercomClient,
    private store: ForwardConvertStore,
    private audit: AuditLogger
  ) {}

  // Auto gate for the inbound webhook. Returns "converted" when the handler
  // must skip the creation balancer + SLA for this (now closed) original —
  // including on retried deliveries of an already-converted conversation.
  // Throws on transient failures so the inbound activity retries; the ledger
  // check makes those retries idempotent.
  async maybeConvertOnCreate(conversationId: string, payloadSource?: PayloadSource): Promise<"converted" | "skipped"> {
    if (!this.settingsStore.forwardConvertEnabled()) return "skipped";
    if (!this.settingsStore.intercomConfigured()) return "skipped";
    const adminId = this.settingsStore.intercomAdminId() ?? this.settingsStore.intercomAuthorAdminId();
    if (!adminId) return "skipped";

    if (await this.store.getByOriginalConversationId(conversationId)) return "converted";
    if (await this.store.getByNewConversationId(conversationId)) return "skipped";

    // Cheap pre-filter on the delivery-time payload — skips the conversation
    // GET for the overwhelmingly common case (a normal customer email).
    if (payloadSource) {
      const subject = payloadSource.subject;
      if (typeof subject === "string" && !/^\s*(?:fwd|fw)\s*:/i.test(subject)) return "skipped";
      const email = payloadSource.author?.email?.trim().toLowerCase();
      if (email && !(await this.isForwarderEmail(email))) return "skipped";
    }

    const src = await this.client.getConversationSource(conversationId);
    if (!src.open) return "skipped";
    if (src.hasAgentPart) return "skipped"; // an agent already engaged — repair manually if needed
    if (!src.authorEmail || !(await this.isForwarderEmail(src.authorEmail))) return "skipped";
    const parsed = parseForwardedEmail(src.subject, src.bodyPlain);
    if (!parsed.ok) {
      cvLog.info("fwdconvert.auto_skip", {
        "intercom.conversation_id": conversationId,
        "fwdconvert.reason": parsed.reason,
      });
      return "skipped";
    }
    if (parsed.email === src.authorEmail) return "skipped";
    if (await this.isProtectedTargetEmail(parsed.email)) {
      // Forward of an internal thread — a conversation authored as a teammate
      // (or listed forwarder) contact record would be wrong in every direction.
      cvLog.info("fwdconvert.auto_skip", {
        "intercom.conversation_id": conversationId,
        "fwdconvert.reason": "parsed sender is a workspace teammate or listed forwarder",
      });
      return "skipped";
    }

    await this.convert(conversationId, src, adminId, {
      email: parsed.email,
      name: parsed.name,
      subject: parsed.subject,
      bodyText: parsed.bodyText,
    });
    return "converted";
  }

  // The conversion core. Caller supplies the target identity; this method owns
  // contact find-or-create, the recreated conversation, the ledger commit, and
  // the best-effort decorations (which never throw once the ledger row exists —
  // a retry would duplicate the conversation, not repair the decoration).
  private async convert(
    originalConversationId: string,
    src: Awaited<ReturnType<IntercomClient["getConversationSource"]>>,
    adminId: string,
    input: {
      email: string;
      name: string | null;
      subject: string | null;
      bodyText: string;
    }
  ): Promise<string> {
    // Contact: prefer an existing user-role match (real customer record); a
    // lead-only match is reused as-is; else create — same ladder as the Sentry
    // feedback importer, plus the executor's archived-409 unarchive.
    const matches = await this.client.searchContactsByEmail(input.email);
    let match = matches.find((m) => m.role === "user") ?? matches.find((m) => m.role === "lead") ?? null;
    if (!match) {
      try {
        match = { id: (await this.client.createEmailContact({ email: input.email, name: input.name })).id, role: "user" };
      } catch (e) {
        if (!(e instanceof IntercomHttpError && e.status === 409)) throw e;
        const archivedId = archivedContactId(e);
        if (archivedId) {
          await this.client.unarchiveContact(archivedId);
          match = { id: archivedId, role: "user" };
        } else {
          const retry = await this.client.searchContactsByEmail(input.email);
          match = retry.find((m) => m.role === "user") ?? retry[0] ?? null;
          if (!match) throw e;
        }
      }
    }
    const fromType = match.role === "lead" ? "lead" : "user";
    // The conversation author is the forwarder's CONTACT record; the matching
    // teammate id (when their email is on a seat) is the useful audit datum.
    // Resolved before the create so the create→ledger crash window stays free
    // of extra calls.
    const forwarderAdmin = src.authorEmail
      ? (await this.admins().catch(() => [] as IntercomAdmin[])).find((a) => a.email?.toLowerCase() === src.authorEmail)
      : undefined;

    const body = buildForwardConversationBody(input.subject, input.bodyText);
    const newConversationId = await this.client.createConversation(match.id, body, undefined, fromType);
    // Commit point — create-then-insert, same tradeoff as the Sentry importer:
    // a crash inside this window duplicates ONE visible conversation instead of
    // silently losing the forward.
    await this.store.insertConverted({
      originalConversationId,
      newConversationId,
      forwarderAdminId: forwarderAdmin?.id ?? null,
      forwarderEmail: src.authorEmail,
      customerEmail: input.email,
      customerName: input.name,
      intercomContactId: match.id,
      contactRole: fromType,
      trigger: "auto",
      actorLabel: null,
      attachmentsCount: src.attachments.length,
    });

    // Decorations — each best-effort; the conversion already committed.
    if (src.teamAssigneeId) {
      // Keep Intercom's email routing decision: without a team the creation
      // balancer skips the recreation AND the stray sweep ignores it.
      try {
        await this.client.assignConversationToTeam(newConversationId, src.teamAssigneeId, adminId);
      } catch (e) {
        this.warnDecoration("team assignment", newConversationId, e);
      }
    }
    try {
      const tag = await this.client.findOrCreateTag(this.settingsStore.forwardConvertTagName());
      await this.client.tagConversation(newConversationId, tag.id, adminId);
    } catch (e) {
      this.warnDecoration("tag", newConversationId, e);
    }
    if (src.attachments.length > 0) {
      await this.reuploadAttachments(originalConversationId, newConversationId, match.id, fromType, adminId, src.attachments);
    }
    try {
      await this.client.replyAsAdmin(newConversationId, {
        adminId,
        note: true,
        body: this.provenanceNote(originalConversationId, src),
      });
    } catch (e) {
      this.warnDecoration("provenance note", newConversationId, e);
    }
    try {
      await this.client.replyAsAdmin(originalConversationId, {
        adminId,
        note: true,
        body: this.closeNote(input.email, newConversationId),
      });
      await this.client.setConversationOpen(originalConversationId, false, adminId);
    } catch (e) {
      this.warnDecoration("close of the original", originalConversationId, e);
    }

    cvLog.info("fwdconvert.converted", {
      "intercom.conversation_id": originalConversationId,
      "fwdconvert.new_conversation_id": newConversationId,
      "fwdconvert.contact_role": fromType,
      "fwdconvert.attachments": src.attachments.length,
    });
    void this.audit.log({
      title: "📨 Forwarded email converted",
      description: [
        `Original conversation ${originalConversationId} (forwarded by ${src.authorEmail ?? "unknown"}) was closed;`,
        `recreated as conversation ${newConversationId} for the original sender.`,
      ].join(" "),
      severity: "info",
    });
    return newConversationId;
  }

  // Attachment re-upload onto the recreation. Contact-authored for user-role
  // contacts; lead-role contacts get an admin NOTE instead — replyAsContact
  // rejects lead ids, and an admin COMMENT would email the customer their own
  // files back, stamp first_admin_reply_at (satisfying the SLA first-reply
  // clock unearned), and flip the idle sweeper into agent-spoke-last.
  private async reuploadAttachments(
    originalConversationId: string,
    newConversationId: string,
    contactId: string,
    role: "user" | "lead",
    adminId: string,
    attachments: Array<{ name: string; url: string }>
  ): Promise<void> {
    let allPosted = true;
    for (let i = 0; i < attachments.length; i += ATTACHMENT_CHUNK) {
      const chunk = attachments.slice(i, i + ATTACHMENT_CHUNK);
      const urls = chunk.map((a) => a.url);
      try {
        if (role === "user") {
          await this.client.replyAsContact(newConversationId, {
            intercomUserId: contactId,
            body: "<p>📎 Attachments from the original email</p>",
            attachmentUrls: urls,
          });
        } else {
          await this.client.replyAsAdmin(newConversationId, {
            adminId,
            note: true,
            body: "<p>📎 Attachments from the forwarded email</p>",
            attachmentUrls: urls,
          });
        }
      } catch (e) {
        allPosted = false;
        this.warnDecoration("attachment re-upload", newConversationId, e);
        // Degrade to a link list — the signed URLs still open for teammates
        // while they remain valid, and the original conversation keeps them.
        try {
          const items = chunk
            .map((a) => `<p>📎 <a href="${escapeHtmlText(a.url)}">${escapeHtmlText(a.name)}</a></p>`)
            .join("");
          await this.client.replyAsAdmin(newConversationId, {
            adminId,
            note: true,
            body: `<p><b>Attachments could not be re-uploaded</b> — links from the original (conversation ${escapeHtmlText(originalConversationId)}):</p>${items}`,
          });
        } catch (e2) {
          this.warnDecoration("attachment link note", newConversationId, e2);
        }
      }
    }
    if (allPosted) {
      await this.store.setAttachmentsReuploaded(originalConversationId).catch(() => undefined);
    }
  }

  private provenanceNote(
    originalConversationId: string,
    src: Awaited<ReturnType<IntercomClient["getConversationSource"]>>
  ): string {
    const lines = [
      `<p><b>Forwarded-email conversion</b></p>`,
      `<p>Forwarded by: ${escapeHtmlText(src.authorEmail ?? "unknown")}</p>`,
      `<p>Original conversation id: ${escapeHtmlText(originalConversationId)}</p>`,
    ];
    if (src.attachments.length > 0) lines.push(`<p>Attachments in original: ${src.attachments.length}</p>`);
    return lines.join("");
  }

  private closeNote(customerEmail: string, newConversationId: string): string {
    const template =
      this.settingsStore.forwardConvertCloseNote() ??
      "Forwarded-email conversion: a new conversation was created for the original sender ({email}). This one is closed; continue there.";
    const rendered = escapeHtmlText(template.split("{email}").join(customerEmail));
    return `<p>${rendered}</p><p>New conversation id: ${escapeHtmlText(newConversationId)}</p>`;
  }

  private warnDecoration(what: string, conversationId: string, e: unknown): void {
    cvLog.warn(`fwdconvert: ${what} failed`, {
      "intercom.conversation_id": conversationId,
      "error.message": e instanceof Error ? e.message : String(e),
    });
  }

  private async admins(): Promise<IntercomAdmin[]> {
    const now = Date.now();
    if (this.adminsCache && now - this.adminsCache.at < ADMINS_TTL_MS) return this.adminsCache.admins;
    const admins = await this.client.listAdmins();
    this.adminsCache = { at: now, admins };
    return admins;
  }

  private async isLiteSeatEmail(email: string): Promise<boolean> {
    const admins = await this.admins();
    return admins.some((a) => !a.hasInboxSeat && a.email?.toLowerCase() === email);
  }

  private async isAnyAdminEmail(email: string): Promise<boolean> {
    const admins = await this.admins();
    return admins.some((a) => a.email?.toLowerCase() === email);
  }

  // Forwarder set = lite-seat teammates (dynamic) ∪ the configured extra
  // addresses (personal mailboxes etc.). Listed entries check first — no
  // roster fetch needed when they match.
  private async isForwarderEmail(email: string): Promise<boolean> {
    if (this.settingsStore.forwardConvertExtraEmails().includes(email)) return true;
    return this.isLiteSeatEmail(email);
  }

  // Addresses that must never become the conversion TARGET: teammates and the
  // listed forwarders themselves (a "customer" conversation for either would
  // be wrong in every direction).
  private async isProtectedTargetEmail(email: string): Promise<boolean> {
    if (this.settingsStore.forwardConvertExtraEmails().includes(email)) return true;
    return this.isAnyAdminEmail(email);
  }
}
