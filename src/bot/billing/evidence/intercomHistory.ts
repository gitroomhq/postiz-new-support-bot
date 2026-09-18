import type { IntercomClient } from "../../../intercom/IntercomClient";
import type { SessionStore } from "../../../auth/SessionStore";
import type { SettingsStore } from "../../../config/SettingsStore";
import type { SupportFacts } from "./tokens";

// Real support history for a disputing customer, lifted out of the old AI
// drafting path (it was the model's best grounding, and it is the deterministic
// pipeline's best grounding too). Quoting an exchange in which the customer
// asked us how to use the product is the strongest single fact against
// "I never received this" or "I did not authorise this".
//
// This costs up to ten Intercom round trips, which is why it runs on the
// looper's enrich pass and never inside the 60-second Stripe webhook.

// Words that mark a conversation as a refund request. Used only to decide
// whether we may ASSERT that no refund was ever requested, so the bar is
// deliberately low: any hint at all withdraws the claim.
const REFUND_HINTS = /\b(refund|money back|chargeback|reimburse|cancel.{0,20}charge|charge.{0,20}back)\b/i;

// Bounds for the transcript DOCUMENT, which is a PDF and so far less cramped
// than an evidence text field. Generous enough to hold a real conversation,
// bounded so one pathological thread cannot produce a hundred-page attachment
// that an analyst will not read anyway.
const DOC_MESSAGES_PER_CONVERSATION = 60;
const DOC_MESSAGE_CHARS = 4000;

export async function collectSupportFacts(
  deps: { intercom: IntercomClient; sessionStore: SessionStore; settings: SettingsStore },
  customerId: string | null,
  email: string | null
): Promise<SupportFacts | null> {
  // Intercom off means we know nothing, which is NOT the same as "the customer
  // never contacted us". Returning null keeps every support claim unmade.
  if (deps.settings.intercomMode() === "none") return null;

  const contactIds = new Set<string>();
  if (customerId) {
    const discordIds = await deps.sessionStore.findDiscordIdsByStripeId(customerId).catch(() => []);
    for (const discordId of discordIds.slice(0, 3)) {
      const contact = await deps.intercom.findContactByExternalId(discordId).catch(() => null);
      if (contact) contactIds.add(contact.id);
    }
  }
  if (email) {
    for (const c of await deps.intercom.searchContactsByEmail(email).catch(() => [])) contactIds.add(c.id);
  }
  // No contact resolved at all: we cannot tell whether they wrote to us, so we
  // must not say they did not.
  if (contactIds.size === 0) return null;

  const conversations: Array<{ id: string; createdAt: Date | null }> = [];
  for (const contactId of [...contactIds].slice(0, 3)) {
    conversations.push(...(await deps.intercom.searchConversationsByContact(contactId, 3).catch(() => [])));
  }
  const unique = [...new Map(conversations.map((c) => [c.id, c])).values()].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
  );
  if (!unique.length) {
    // The contact exists and has no conversations: a real, checkable negative.
    return {
      historyLines: null,
      conversationCount: 0,
      firstContactIso: null,
      lastContactIso: null,
      transcript: [],
      noRefundRequest: true,
    };
  }

  const blocks: string[] = [];
  const docTranscript: SupportFacts["transcript"] = [];
  let budget = 5000; // transcripts can be huge; evidence fields are capped anyway
  let sawRefundRequest = false;
  let readAll = true;

  for (const convo of unique.slice(0, 3)) {
    const transcript = await deps.intercom.getConversationTranscript(convo.id).catch(() => null);
    if (transcript == null) {
      // A failed read means we did not see this conversation, so we cannot
      // claim anything about what is NOT in it.
      readAll = false;
      continue;
    }
    if (!transcript.length) continue;
    if (transcript.some((m) => REFUND_HINTS.test(m.text))) sawRefundRequest = true;
    // Kept whole for the attached document, on this same fetch. Redaction
    // happens where the document is built, not here: these facts also feed the
    // text fields, which have their own rules.
    docTranscript.push({
      conversationId: convo.id,
      startedAtIso: convo.createdAt ? convo.createdAt.toISOString() : null,
      messages: transcript.slice(0, DOC_MESSAGES_PER_CONVERSATION).map((m) => ({
        atIso: m.at ? m.at.toISOString() : null,
        author: m.author,
        text: m.text.slice(0, DOC_MESSAGE_CHARS),
      })),
      clipped: transcript.length > DOC_MESSAGES_PER_CONVERSATION,
    });
    const lines = transcript
      .slice(0, 12)
      .map((m) => `  ${m.at ? m.at.toISOString().slice(0, 10) : "date unknown"} ${m.author}: ${m.text.replace(/\s+/g, " ").slice(0, 300)}`);
    const block = `Conversation started ${convo.createdAt ? convo.createdAt.toISOString().slice(0, 10) : "date unknown"}:\n${lines.join("\n")}`;
    if (block.length > budget) {
      readAll = false;
      break;
    }
    budget -= block.length;
    blocks.push(block);
  }
  // More conversations than we read means the ones we skipped could contain a
  // refund request, so the negative claim is withdrawn.
  if (unique.length > 3) readAll = false;

  const dates = unique.map((c) => c.createdAt).filter((d): d is Date => d != null);
  return {
    historyLines: blocks.length ? blocks.join("\n\n") : null,
    conversationCount: unique.length,
    firstContactIso: dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString() : null,
    lastContactIso: dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : null,
    transcript: docTranscript,
    // Only a complete read with no refund language anywhere licenses the claim.
    noRefundRequest: readAll && !sawRefundRequest ? true : null,
  };
}
