import { escapeHtmlText } from "../intercom/IntercomEventExecutor";

// Pure formatting/planning helpers for the Sentry feedback import — no I/O so
// every watermark/escaping edge case is unit-testable.

// Intercom caps conversation bodies well above this; the cap only guards
// against a pathological multi-hundred-KB submission blowing the request.
const MAX_BODY_CHARS = 60_000;

// Feedback text is end-user-controlled: escape everything, then re-introduce
// structure (blank line = paragraph, single newline = <br>). Intercom bodies
// are HTML.
export function buildConversationBody(message: string): string {
  let text = message.trim();
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
  if (paragraphs.length === 0) paragraphs.push("<p>(empty feedback message)</p>");
  if (truncated) paragraphs.push("<p><i>[message truncated by import]</i></p>");
  return paragraphs.join("");
}

export interface FeedbackNoteInput {
  pageUrl: string | null;
  shortId: string | null;
  permalink: string | null;
}

// Agent-facing internal note: Sentry provenance + page context. Customers
// never see notes, so the debug metadata lives here instead of the opening
// message. Deliberately minimal (operator-tuned): the conversation already
// carries the submitter identity and the backdated submission time, and the
// project is visible behind the Sentry link.
export function buildMetadataNote(input: FeedbackNoteInput): string {
  const lines: string[] = [];
  lines.push(`<p><b>Sentry feedback</b>${input.shortId ? ` — ${escapeHtmlText(input.shortId)}` : ""}</p>`);
  if (input.pageUrl) {
    lines.push(`<p>Page: <a href="${escapeHtmlText(input.pageUrl)}">${escapeHtmlText(input.pageUrl)}</a></p>`);
  }
  if (input.permalink) {
    lines.push(`<p><a href="${escapeHtmlText(input.permalink)}">Open in Sentry</a></p>`);
  }
  return lines.join("");
}

// Ticket attributes for the customer-ticket conversion — same default-field
// keys the bridge's attachTicket uses.
export function buildTicketAttributes(input: {
  name: string | null;
  email: string;
  message: string | null;
  projectSlug: string | null;
}): Record<string, string> {
  const who = input.name?.trim() || input.email;
  const title = `${who} — Feedback${input.projectSlug ? ` (${input.projectSlug})` : ""}`;
  return {
    _default_title_: title.slice(0, 250),
    _default_description_: (input.message?.trim() || "(empty feedback message)").slice(0, 4000),
  };
}

// One page-walk plan: everything newer than the floor, oldest first (so the
// watermark can advance monotonically), deduped by id (the floor overlap can
// re-list items across ticks), capped with an explicit overflow count — the
// caller logs the remainder, never silently drops it.
export function planFeedbackWalk<T extends { id: string; firstSeen: string }>(
  items: T[],
  floor: Date,
  cap: number
): { todo: T[]; overflow: number } {
  const seen = new Set<string>();
  const eligible = items
    .filter((i) => {
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      const t = Date.parse(i.firstSeen);
      return Number.isFinite(t) && t > floor.getTime();
    })
    .sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen));
  return { todo: eligible.slice(0, cap), overflow: Math.max(0, eligible.length - cap) };
}

// Outcomes MUST be in ascending feedbackAt order (planFeedbackWalk order). The
// watermark advances past terminal items (imported / skipped / deduped) and
// freezes at the first non-terminal (failed) one: the next tick retries the
// failure while the ledger dedups everything already committed behind it.
export function advanceWatermark(outcomes: Array<{ feedbackAt: Date; terminal: boolean }>, current: Date): Date {
  let mark = current;
  for (const o of outcomes) {
    if (!o.terminal) break;
    if (o.feedbackAt.getTime() > mark.getTime()) mark = o.feedbackAt;
  }
  return mark;
}

// Sentry paginates via the Link RESPONSE HEADER:
//   <https://…&cursor=X>; rel="next"; results="true"; cursor="X", <…>; rel="previous"; …
// results="false" on the next rel means the current page is the last one.
export function parseSentryLinkHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    if (/rel="next"/.test(part) === false) continue;
    if (/results="true"/.test(part) === false) return null;
    return /cursor="([^"]+)"/.exec(part)?.[1] ?? null;
  }
  return null;
}
