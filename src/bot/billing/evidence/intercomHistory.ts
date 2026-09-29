import type { IntercomClient } from "../../../intercom/IntercomClient";
import type { SessionStore } from "../../../auth/SessionStore";
import type { SettingsStore } from "../../../config/SettingsStore";
import { hasCancelIntent } from "../disputeVerdict";
import type { SupportFacts } from "./tokens";

// Real support history for a disputing customer, lifted out of the old AI
// drafting path (it was the model's best grounding, and it is the deterministic
// pipeline's best grounding too). Quoting an exchange in which the customer
// asked us how to use the product is the strongest single fact against
// "I never received this" or "I did not authorise this".
//
// This costs up to ten Intercom round trips, which is why it runs on the
// looper's enrich pass and never inside the 60-second Stripe webhook.
//
// The same fetch answers the fight-or-accept verdict (probeSupportContact):
// whether the customer wrote to us before the dispute, and whether they asked
// to cancel before the charge. The two consumers want different standards of
// proof. The evidence pack may only ASSERT what a complete read shows, so an
// unresolved contact gives it nothing; the verdict may count "we looked
// everywhere and found no one" as a real zero, because it decides whether to
// argue, not what to say.

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

// Conversations listed per contact. One search call either way; the list is
// what lets the verdict count contact before the dispute, and what keeps the
// "no refund request" claim honest about conversations older than the three
// transcripts actually read.
const CONVERSATIONS_PER_CONTACT = 20;
// Transcripts read for the evidence text (the most recent ones).
const TRANSCRIPTS_FOR_EVIDENCE = 3;
// Transcripts read to look for a cancel request, among conversations started
// before the disputed charge. Only for a "subscription canceled" claim.
const TRANSCRIPTS_FOR_CANCEL_ASK = 3;

export interface SupportProbeOptions {
  // Contact is counted only before this moment: writing in to complain about
  // the chargeback is not a relationship with the product.
  disputeOpenedAt?: Date;
  // Look for a request to cancel in conversations started before this moment.
  chargeAt?: Date;
  scanCancelAsk?: boolean;
}

export interface SupportProbe {
  // Every Intercom lookup answered. False when Intercom is off or any single
  // lookup failed, because a failed lookup could have hidden a conversation.
  reached: boolean;
  // Conversations started before the dispute opened (all of them when no
  // dispute date was given).
  conversationsBeforeDispute: number;
  // null = not looked for, or a conversation that could have held it could
  // not be read.
  cancelAskBeforeCharge: boolean | null;
  // What the evidence pack may cite. Null whenever the pack may not assert
  // anything about support history.
  facts: SupportFacts | null;
}

type Deps = { intercom: IntercomClient; sessionStore: SessionStore; settings: SettingsStore };
type Transcript = Array<{ author: string; at: Date | null; text: string }>;

export async function probeSupportContact(
  deps: Deps,
  customerId: string | null,
  email: string | null,
  opts: SupportProbeOptions = {}
): Promise<SupportProbe> {
  // Intercom off means we know nothing, which is NOT the same as "the customer
  // never contacted us". Returning null facts keeps every support claim unmade.
  if (deps.settings.intercomMode() === "none") {
    return { reached: false, conversationsBeforeDispute: 0, cancelAskBeforeCharge: null, facts: null };
  }

  let failed = false;
  const contactIds = new Set<string>();
  if (customerId) {
    const discordIds = await deps.sessionStore.findDiscordIdsByStripeId(customerId).catch(() => {
      failed = true;
      return [] as string[];
    });
    for (const discordId of discordIds.slice(0, 3)) {
      const contact = await deps.intercom.findContactByExternalId(discordId).catch(() => {
        failed = true;
        return null;
      });
      if (contact) contactIds.add(contact.id);
    }
  }
  if (email) {
    const found = await deps.intercom.searchContactsByEmail(email).catch(() => {
      failed = true;
      return [] as Array<{ id: string }>;
    });
    for (const c of found) contactIds.add(c.id);
  }
  // No contact resolved at all: the pack cannot tell whether they wrote to us,
  // so it must not say they did not. The verdict can: we looked under every id
  // we hold for them and nobody is there.
  if (contactIds.size === 0) {
    return { reached: !failed, conversationsBeforeDispute: 0, cancelAskBeforeCharge: failed ? null : false, facts: null };
  }

  const conversations: Array<{ id: string; createdAt: Date | null }> = [];
  for (const contactId of [...contactIds].slice(0, 3)) {
    const found = await deps.intercom.searchConversationsByContact(contactId, CONVERSATIONS_PER_CONTACT).catch(() => {
      failed = true;
      return [] as Array<{ id: string; createdAt: Date | null }>;
    });
    conversations.push(...found);
  }
  const unique = [...new Map(conversations.map((c) => [c.id, c])).values()].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
  );
  const beforeDispute = opts.disputeOpenedAt
    ? unique.filter((c) => c.createdAt != null && c.createdAt < opts.disputeOpenedAt!).length
    : unique.length;

  if (!unique.length) {
    return {
      reached: !failed,
      conversationsBeforeDispute: 0,
      cancelAskBeforeCharge: failed ? null : false,
      // The contact exists and has no conversations: a real, checkable
      // negative, unless a search failed and could have hidden one.
      facts: {
        historyLines: null,
        conversationCount: 0,
        firstContactIso: null,
        lastContactIso: null,
        transcript: [],
        noRefundRequest: failed ? null : true,
      },
    };
  }

  // One read per conversation, shared by the evidence pass and the cancel scan.
  const transcripts = new Map<string, Transcript | null>();
  const read = async (id: string): Promise<Transcript | null> => {
    if (transcripts.has(id)) return transcripts.get(id)!;
    const t = await deps.intercom.getConversationTranscript(id).catch(() => null);
    transcripts.set(id, t);
    return t;
  };

  const blocks: string[] = [];
  const docTranscript: SupportFacts["transcript"] = [];
  let budget = 5000; // transcripts can be huge; evidence fields are capped anyway
  let sawRefundRequest = false;
  let readAll = !failed;

  for (const convo of unique.slice(0, TRANSCRIPTS_FOR_EVIDENCE)) {
    const transcript = await read(convo.id);
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
  if (unique.length > TRANSCRIPTS_FOR_EVIDENCE) readAll = false;

  const cancelAskBeforeCharge =
    opts.scanCancelAsk && opts.chargeAt ? await scanCancelAsk(unique, opts.chargeAt, read, failed) : null;

  const dates = unique.map((c) => c.createdAt).filter((d): d is Date => d != null);
  return {
    reached: !failed,
    conversationsBeforeDispute: beforeDispute,
    cancelAskBeforeCharge,
    facts: {
      historyLines: blocks.length ? blocks.join("\n\n") : null,
      conversationCount: unique.length,
      firstContactIso: dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString() : null,
      lastContactIso: dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString() : null,
      transcript: docTranscript,
      // Only a complete read with no refund language anywhere licenses the claim.
      noRefundRequest: readAll && !sawRefundRequest ? true : null,
    },
  };
}

// Did the CUSTOMER ask to cancel before the charge was taken? Only their own
// messages count (an agent explaining how cancelling works is not a request),
// and only messages written before the charge.
async function scanCancelAsk(
  conversations: Array<{ id: string; createdAt: Date | null }>,
  chargeAt: Date,
  read: (id: string) => Promise<Transcript | null>,
  lookupFailed: boolean
): Promise<boolean | null> {
  const candidates = conversations
    .filter((c) => c.createdAt != null && c.createdAt < chargeAt)
    .slice(0, TRANSCRIPTS_FOR_CANCEL_ASK);
  let unreadable = lookupFailed;
  for (const convo of candidates) {
    const transcript = await read(convo.id);
    if (transcript == null) {
      unreadable = true;
      continue;
    }
    const asked = transcript.some(
      (m) => m.author === "customer" && (m.at ?? convo.createdAt!) < chargeAt && hasCancelIntent(m.text)
    );
    if (asked) return true;
  }
  return unreadable ? null : false;
}
