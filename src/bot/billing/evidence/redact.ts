// What must not travel to a bank inside a support transcript.
//
// The transcript itself is already narrower than it looks: the Intercom reader
// keeps only `part_type === "comment"` and drops bot parts, so internal notes
// never reach this file. What remains is the messages the customer and the
// agent could both see, and the job here is the rest: identifying details of
// people who are not party to this dispute, and anything resembling a payment
// credential.
//
// The bias is deliberate and one-directional. A redaction that fires when it
// need not costs a line of context in a document that is corroboration rather
// than argument. A redaction that fails to fire hands a card number or a third
// party's email address to an external analyst, and cannot be taken back.

const REDACTED = "[redacted]";

// Long digit runs, separators and all: card numbers survive being typed as
// "4242 4242 4242 4242" or "4242-4242-4242-4242", and a customer pasting one
// into a support chat is common enough to plan for.
// Written so the final character is always a DIGIT: the obvious form,
// (?:\d[ -]?){12,19}, swallows the space after the last digit and glues the
// replacement onto the next word.
const CARD_LIKE = /\b\d(?:[ -]?\d){11,18}\b/g;
// Anything that reads as an email address.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// A phone number needs separators AND nine or more digits, so an order number
// or an invoice reference is left alone.
const PHONE = /(?:(?:\+|00)\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}(?:[ .-]\d{2,5}){2,}/g;
// A credential riding in a query string. The path stays, so the link still
// shows WHERE the customer was sent.
const URL_WITH_SECRET = /(https?:\/\/[^\s?]+)\?[^\s]*\b(?:token|key|secret|password|signature|sig|auth)=[^\s]*/gi;
// IBANs are not common in this product's support, but they cost one pattern.
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g;

export interface RedactOptions {
  // The email address already named elsewhere in this evidence package. The
  // bank has it, so masking it in the transcript would only make the document
  // harder to follow without protecting anything.
  keepEmail?: string | null;
}

/** Strip third-party and credential-shaped material from one message body. */
export function redactForBank(text: string, opts: RedactOptions = {}): string {
  const keep = opts.keepEmail?.trim().toLowerCase() || null;
  let out = text;
  out = out.replace(URL_WITH_SECRET, (_m, base: string) => `${base}?${REDACTED}`);
  out = out.replace(IBAN, REDACTED);
  out = out.replace(CARD_LIKE, (m) => {
    // Count digits, not characters: the pattern's separators inflate the length.
    const digits = m.replace(/\D/g, "");
    return digits.length >= 12 ? REDACTED : m;
  });
  out = out.replace(EMAIL, (m) => (keep && m.toLowerCase() === keep ? m : REDACTED));
  out = out.replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 9 ? REDACTED : m));
  // A dialling prefix left stranded when the digits after it were taken by an
  // earlier pattern. "+[redacted]" reads as a redaction that went wrong, and a
  // document that looks mishandled invites the reader to distrust the rest.
  out = out.replace(/(?:\+|00)\s*\[redacted\]/g, REDACTED);
  return out;
}

/** How an author is named in an exported transcript. */
export function redactAuthor(author: string): string {
  // The Intercom reader labels agents "agent" or "agent <name>". A support
  // agent's personal name is theirs, not evidence, and the analyst only needs
  // to know which side spoke.
  return /^agent\b/i.test(author.trim()) ? "Postiz Support" : "Customer";
}
