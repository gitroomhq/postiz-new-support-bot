import { escapeHtmlText } from "./IntercomEventExecutor";

// Pure parsing/formatting for the forwarded-email converter — no I/O so every
// Gmail format edge case is unit-testable. Input is the conversation source
// fetched with display_as=plaintext, so no HTML stripping happens here.

export type ForwardParse =
  | {
      ok: true;
      email: string; // original sender, lowercased
      name: string | null;
      subject: string | null; // forward block's Subject: line, else outer subject minus the Fwd: prefix
      bodyText: string; // original message text (plaintext; may be empty)
    }
  | { ok: false; reason: string };

// Gmail EN emits "Fwd:"; "Fw:" covers Outlook-style forwards arriving the same
// way. Localized prefixes are out of scope — the canvas manual path covers them.
const SUBJECT_PREFIX = /^\s*(?:fwd|fw)\s*:/i;

// Gmail EN plaintext marker. Dash counts vary across client versions.
const FORWARD_MARKER = /-{2,}\s*Forwarded message\s*-{2,}/i;

const HEADER_LINE = /^\s*(from|date|subject|to|cc|reply-to)\s*:\s*(.*)$/i;

// Light shape check, deliberately loose — Intercom is the real validator.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isLikelyEmail(value: string): boolean {
  return EMAIL_SHAPE.test(value.trim());
}

export function hasForwardSubject(subject: string | null | undefined): boolean {
  return !!subject && SUBJECT_PREFIX.test(subject);
}

export function stripForwardPrefix(subject: string): string {
  let s = subject.trim();
  while (SUBJECT_PREFIX.test(s)) s = s.replace(SUBJECT_PREFIX, "").trim();
  return s;
}

// From-line value → name/email. Accepts `Name <a@b.com>`, `"Name" <a@b.com>`
// and bare `a@b.com`.
function parseFromValue(value: string): { email: string; name: string | null } | null {
  const angled = /<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(value);
  if (angled) {
    const name = value.slice(0, angled.index).replace(/["']/g, "").trim();
    return { email: angled[1].toLowerCase(), name: name || null };
  }
  const bare = /([^\s<>",;]+@[^\s<>",;]+)/.exec(value);
  if (bare && EMAIL_SHAPE.test(bare[1])) return { email: bare[1].toLowerCase(), name: null };
  return null;
}

// Extracts the ORIGINAL sender + message from a forwarded email's plaintext.
// Strategy: find the first forward marker (nested double-forwards resolve to
// the outermost block — same behavior as Intercom's native detection), else
// fall back to the first From: header line; then consume the contiguous header
// block and treat everything after it as the original message. The subject
// gate is skippable for the manual canvas path (operators repair forwards
// whose subject was edited).
export function parseForwardedEmail(
  subject: string | null,
  bodyPlain: string,
  opts?: { requireForwardSubject?: boolean }
): ForwardParse {
  if (opts?.requireForwardSubject !== false && !hasForwardSubject(subject)) {
    return { ok: false, reason: "subject has no forward prefix" };
  }
  const text = bodyPlain.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  let headerStart = -1;
  const marker = FORWARD_MARKER.exec(text);
  if (marker) {
    const upToMarker = text.slice(0, marker.index + marker[0].length);
    headerStart = upToMarker.split("\n").length; // first line after the marker line
  } else {
    headerStart = lines.findIndex((l) => {
      const m = HEADER_LINE.exec(l);
      return !!m && m[1].toLowerCase() === "from" && /@/.test(m[2]);
    });
    if (headerStart === -1) return { ok: false, reason: "no forward block found" };
  }

  let from: { email: string; name: string | null } | null = null;
  let blockSubject: string | null = null;
  let i = headerStart;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      // Blank lines directly after the marker are tolerated until the first
      // header was seen; after that a blank line ends the block.
      if (from || blockSubject) break;
      if (i - headerStart > 3) return { ok: false, reason: "no headers after forward marker" };
      continue;
    }
    const m = HEADER_LINE.exec(line);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (key === "from") from = parseFromValue(m[2]) ?? from;
    if (key === "subject") blockSubject = m[2].trim() || null;
  }
  if (!from) return { ok: false, reason: "no parseable From header in forward block" };

  const bodyText = lines
    .slice(i)
    .join("\n")
    .replace(/^\s*\n+/, "")
    .trim();
  const fallbackSubject = subject ? stripForwardPrefix(subject) : "";
  return {
    ok: true,
    email: from.email,
    name: from.name,
    subject: blockSubject ?? (fallbackSubject || null),
    bodyText,
  };
}

// Intercom caps conversation bodies well above this; the cap only guards
// against a pathological forward blowing the request (same as the Sentry
// import's body builder).
const MAX_BODY_CHARS = 60_000;

// Opening message for the recreated conversation, authored as the customer.
// Everything is end-user-controlled: escape, then re-introduce structure.
export function buildForwardConversationBody(subject: string | null, bodyText: string): string {
  let text = bodyText.trim();
  let truncated = false;
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS);
    truncated = true;
  }
  const paragraphs = escapeHtmlText(text)
    .split(/\n{2,}/)
    .map((p) => p.trim().replace(/\n/g, "<br>"))
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p}</p>`);
  if (paragraphs.length === 0) paragraphs.push("<p>(empty forwarded message)</p>");
  const head = subject ? [`<p><b>Subject:</b> ${escapeHtmlText(subject)}</p>`] : [];
  if (truncated) paragraphs.push("<p><i>[message truncated by import]</i></p>");
  return [...head, ...paragraphs].join("");
}
