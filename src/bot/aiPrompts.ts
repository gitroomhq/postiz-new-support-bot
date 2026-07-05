// Prompt builders for the /ai staff command. Pure functions — no Discord or
// DB access — so the giant DiscordBot class only assembles the inputs.

export interface AiTranscriptLine {
  timestamp: Date;
  role: "Customer" | "Staff" | "Bot";
  authorName: string;
  content: string;
}

export interface AiNoteLine {
  authorName: string;
  content: string;
  createdAt: Date;
}

export interface AiHistoryLine {
  kind: string; // STATUS | PRIORITY
  fromLabel: string | null;
  toLabel: string;
  actorName: string;
  createdAt: Date;
}

export interface AiTicketContext {
  categoryLabel: string | null;
  statusLabel: string | null;
  priorityLabel: string | null;
  tierLabel: string | null;
  customerDisplayName: string | null;
  createdAt: Date;
  closed: boolean;
  question: string | null;
  transcript: AiTranscriptLine[];
  notes: AiNoteLine[];
  history: AiHistoryLine[];
  /** Only set when the Stripe MCP server is attached (admin invoker). */
  stripeCustomerId?: string | null;
  postizUserId?: string | null;
}

export interface AiToolAvailability {
  web: boolean;
  stripe: boolean;
  postiz: boolean;
}

// The prompt travels as a single argv element (Linux MAX_ARG_STRLEN is
// 128 KiB) — keep the whole context block comfortably under that.
const TRANSCRIPT_CHAR_BUDGET = 60_000;
const TRANSCRIPT_HEAD_BUDGET = 10_000;

function renderTranscript(lines: AiTranscriptLine[]): string {
  const rendered = lines.map(
    (l) => `[${l.timestamp.toISOString()}] ${l.role} ${l.authorName}: ${l.content}`
  );
  const total = rendered.reduce((sum, r) => sum + r.length + 1, 0);
  if (total <= TRANSCRIPT_CHAR_BUDGET) return rendered.join("\n");

  // Keep the opening exchange (original problem) and the most recent part.
  const head: string[] = [];
  let headLen = 0;
  let headCount = 0;
  for (const r of rendered) {
    if (headLen + r.length > TRANSCRIPT_HEAD_BUDGET) break;
    head.push(r);
    headLen += r.length + 1;
    headCount++;
  }
  const tailBudget = TRANSCRIPT_CHAR_BUDGET - headLen;
  const tail: string[] = [];
  let tailLen = 0;
  for (let i = rendered.length - 1; i > headCount - 1; i--) {
    if (tailLen + rendered[i].length > tailBudget) break;
    tail.unshift(rendered[i]);
    tailLen += rendered[i].length + 1;
  }
  const truncated = rendered.length - head.length - tail.length;
  return [...head, `[... ${truncated} messages truncated ...]`, ...tail].join("\n");
}

export function buildTicketContextBlock(ctx: AiTicketContext): string {
  const parts: string[] = [];
  parts.push("## Ticket metadata");
  parts.push(`- Category: ${ctx.categoryLabel ?? "unknown"}`);
  parts.push(`- Status: ${ctx.statusLabel ?? "none"}${ctx.closed ? " (thread closed)" : ""}`);
  parts.push(`- Priority: ${ctx.priorityLabel ?? "none"}`);
  parts.push(`- Escalation tier: ${ctx.tierLabel ?? "none"}`);
  parts.push(`- Customer: ${ctx.customerDisplayName ?? "unknown"}`);
  parts.push(`- Opened: ${ctx.createdAt.toISOString()}`);
  if (ctx.postizUserId) parts.push(`- Linked Postiz user id: ${ctx.postizUserId}`);
  if (ctx.stripeCustomerId) {
    parts.push(
      `- Linked Stripe customer id: ${ctx.stripeCustomerId} — use this directly with the stripe tools; only search by email if it fails.`
    );
  }

  parts.push("\n## Original question");
  parts.push(ctx.question?.trim() || "(not recorded)");

  parts.push("\n## Full conversation transcript");
  parts.push(ctx.transcript.length > 0 ? renderTranscript(ctx.transcript) : "(no messages)");

  if (ctx.notes.length > 0) {
    parts.push("\n## Staff-private notes");
    for (const n of ctx.notes) {
      parts.push(`- [${n.createdAt.toISOString()}] ${n.authorName}: ${n.content}`);
    }
  }

  if (ctx.history.length > 0) {
    parts.push("\n## Status / priority history");
    for (const h of ctx.history) {
      parts.push(
        `- [${h.createdAt.toISOString()}] ${h.kind}: ${h.fromLabel ?? "(none)"} → ${h.toLabel} (by ${h.actorName})`
      );
    }
  }

  return parts.join("\n");
}

function toolNotes(tools: AiToolAvailability): string {
  const notes: string[] = [
    "You can Read/Glob/Grep the Postiz source code (./postiz-app) and documentation (./postiz-docs) in the working directory.",
  ];
  if (tools.web) {
    notes.push("You can use WebSearch and WebFetch to check docs, changelogs and known issues online.");
  }
  if (tools.stripe) {
    notes.push(
      "You have read-only Stripe tools (mcp__stripe__*) to inspect the customer's billing: customer, subscriptions, invoices, charges, payment intents, disputes, cards, tax ids."
    );
    notes.push(
      "When a customer id / exact email isn't known, or a card/last4/charge lookup comes up empty, SEARCH account-wide: " +
        "search_customers (partial name/email — Postiz stores the org name as the customer name), " +
        "search_payment_intents_by_amount (finds DECLINED / bank-blocked attempts that never became a charge — the " +
        "usual reason a 'charge' is invisible), and search_charges_by_last4 / _card_fingerprint. A refused payment is " +
        "not a charge, so a subscription can still be live (past_due) even when charge lookups return nothing."
    );
  }
  if (tools.postiz) {
    notes.push(
      "You have read-only Postiz tools for this customer's own account (mcp__postiz__*): list their connected channels/integrations and platform schemas."
    );
  }
  return notes.map((n) => `- ${n}`).join("\n");
}

const PREAMBLE = `You are assisting a Postiz support staff member inside a private staff-only tool.
Your output is shown only to staff — never to the customer. Postiz cloud version only (not self-hosted).
Do not modify any code or data; you only have read access.`;

export function buildSummarizePrompt(contextBlock: string): string {
  return `${PREAMBLE}

Summarize the following support ticket for a staff member who has not read it.
Structure the answer with exactly these markdown sections:
**Problem(s)** — what the customer is actually facing (there may be several).
**What happened** — chronological gist of the conversation, including what was already tried.
**Current state** — where things stand right now, who is waiting on whom.
**Suggested next steps** — concrete actions for staff.
Keep the whole summary under 2500 characters. Do not invent details that are not in the ticket.

${contextBlock}`;
}

export function buildAskPrompt(
  contextBlock: string,
  question: string,
  tools: AiToolAvailability
): string {
  return `${PREAMBLE}

A staff member has a question about the following support ticket. Answer it as precisely as possible.
${toolNotes(tools)}
Ground every claim in the ticket, the code/docs, or tool results — say clearly when you cannot verify something.

Staff question: ${question}

${contextBlock}`;
}

export function buildCausePrompt(contextBlock: string, tools: AiToolAvailability): string {
  return `${PREAMBLE}

Perform a root-cause analysis of the following support ticket.
${toolNotes(tools)}
Investigate properly: trace the reported behavior through the Postiz source code, check the docs, and verify with the available tools where useful. Cite file paths and line numbers for code evidence.
End your answer with exactly these markdown sections:
**Most likely root cause**
**Evidence** — what supports this conclusion (code references, ticket facts, tool results).
**Confidence** — high / medium / low, with one sentence why.
**Suggested fix or workaround** — what staff can do or tell the customer.

${contextBlock}`;
}

export function buildDraftPrompt(contextBlock: string, instructions: string | null): string {
  return `${PREAMBLE}

Write a reply that a support staff member can send to the customer in the following ticket.
Output ONLY the customer-facing reply text — no preamble, no meta commentary, no subject line.
Friendly, professional support tone. Address the customer's latest open point. Keep it under 1800 characters.
Do not promise refunds, releases or timelines unless the ticket already establishes them.${
    instructions ? `\nStaff instructions for this draft: ${instructions}` : ""
  }

${contextBlock}`;
}
