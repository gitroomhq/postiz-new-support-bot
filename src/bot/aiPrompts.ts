// Prompt builders for the /ai staff command. Pure functions — no Discord or
// DB access — so the giant DiscordBot class only assembles the inputs.

import type { PostizAccountSnapshot } from "./PostizClient";
import type { SentryIssue } from "./SentryClient";

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

export interface AiSubscriptionSummary {
  status: string;
  plan: string | null;
  interval: string | null;
  /** Pre-formatted, e.g. "$29.00 / month". */
  amount: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
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
  /** Live Postiz account snapshot (best-effort; null when unavailable/disabled). */
  postizAccount?: PostizAccountSnapshot | null;
  /** Admin-only Stripe subscription summary (null when none / non-admin invoker). */
  subscription?: AiSubscriptionSummary | null;
  /** Heuristically-correlated Sentry issues (null when read access not configured). */
  relatedSentryIssues?: SentryIssue[] | null;
  /** Only set when the Stripe MCP server is attached (admin invoker). */
  stripeCustomerId?: string | null;
  postizUserId?: string | null;
}

export interface AiToolAvailability {
  web: boolean;
  stripe: boolean;
  postiz: boolean;
  sentry: boolean;
}

// The prompt travels as a single argv element (Linux MAX_ARG_STRLEN is
// 128 KiB) — keep the whole context block comfortably under that.
const TRANSCRIPT_CHAR_BUDGET = 60_000;
const TRANSCRIPT_HEAD_BUDGET = 10_000;
// The live-account block is small metadata, not free text — keep it tight so it
// never crowds the transcript or the 128 KiB argv.
const POSTIZ_FACTS_BUDGET = 4_000;
const MAX_ERROR_POSTS = 12;
const SENTRY_FACTS_BUDGET = 6_000;

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

// Renders the customer's live Postiz account: channel health (a disabled channel
// is the most common "posts aren't going out" cause) and recent post failures.
function renderPostizAccount(acct: PostizAccountSnapshot): string {
  const lines: string[] = [];
  const disabled = acct.channels.filter((c) => c.disabled);
  const active = acct.channels.filter((c) => !c.disabled);
  lines.push(
    `- Connected channels: ${acct.channels.length}${disabled.length ? ` (${disabled.length} DISABLED)` : ""}`
  );
  if (disabled.length > 0) {
    lines.push(
      `- ⚠️ Disabled / needs reconnect: ${disabled.map((c) => `${c.name} (${c.provider})`).join(", ")}`
    );
  }
  if (active.length > 0) {
    lines.push(`- Active: ${active.map((c) => `${c.name} (${c.provider})`).join(", ")}`);
  }

  if (acct.posts.length > 0) {
    const counts: Record<string, number> = {};
    for (const p of acct.posts) counts[p.state] = (counts[p.state] ?? 0) + 1;
    const summary = Object.entries(counts)
      .map(([state, n]) => `${n} ${state.toLowerCase()}`)
      .join(", ");
    lines.push(`- Posts (last ~30d): ${summary}`);
    const errors = acct.posts
      .filter((p) => p.state === "ERROR")
      .sort((a, b) => (a.publishDate < b.publishDate ? 1 : -1))
      .slice(0, MAX_ERROR_POSTS);
    if (errors.length > 0) {
      lines.push("- Recent failed posts:");
      for (const e of errors) {
        lines.push(
          `  - [${e.publishDate}] ${e.provider ?? "?"}${e.channelName ? ` "${e.channelName}"` : ""} (post ${e.id})`
        );
      }
    }
  } else {
    lines.push("- No scheduled/published posts in the last ~30 days.");
  }

  const out = lines.join("\n");
  return out.length > POSTIZ_FACTS_BUDGET
    ? `${out.slice(0, POSTIZ_FACTS_BUDGET)}\n[... account snapshot truncated ...]`
    : out;
}

function renderSentryIssues(issues: SentryIssue[]): string {
  const lines = ["_Heuristic matches (ticket keywords) — confirm relevance before relying on them._"];
  for (const i of issues) {
    const meta = [`events: ${i.count}`, `users: ${i.userCount}`];
    if (i.lastSeen) meta.push(`last seen ${i.lastSeen}`);
    lines.push(
      `- [${i.shortId}] ${i.title}${i.culprit ? ` — culprit: ${i.culprit}` : ""} (${meta.join(", ")})` +
        (i.permalink ? `\n  ${i.permalink}` : "")
    );
  }
  const out = lines.join("\n");
  return out.length > SENTRY_FACTS_BUDGET
    ? `${out.slice(0, SENTRY_FACTS_BUDGET)}\n[... Sentry list truncated ...]`
    : out;
}

function renderSubscription(sub: AiSubscriptionSummary): string {
  const bits = [`- Status: ${sub.status}`];
  if (sub.plan) bits.push(`- Plan: ${sub.plan}`);
  if (sub.amount) bits.push(`- Amount: ${sub.amount}`);
  if (sub.currentPeriodEnd) bits.push(`- Current period ends: ${sub.currentPeriodEnd}`);
  if (sub.cancelAtPeriodEnd) bits.push("- Set to cancel at period end.");
  return bits.join("\n");
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

  if (ctx.postizAccount) {
    parts.push("\n## Postiz account (live)");
    parts.push(renderPostizAccount(ctx.postizAccount));
  }

  if (ctx.subscription) {
    parts.push("\n## Subscription (Stripe)");
    parts.push(renderSubscription(ctx.subscription));
  }

  if (ctx.relatedSentryIssues && ctx.relatedSentryIssues.length > 0) {
    parts.push("\n## Related Sentry issues");
    parts.push(renderSentryIssues(ctx.relatedSentryIssues));
  }

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
  if (tools.sentry) {
    notes.push(
      "You have read-only Sentry tools (mcp__sentry__*) for the Postiz product's error tracking: search/list issues and events, get issue details and tag values, inspect traces. Use them to confirm or extend the related Sentry issues listed above — treat matches as leads to verify, not proof, and prefer the customer's specific error over generic ones."
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
Prefer the context already assembled below (transcript, live Postiz account snapshot, subscription/billing facts, related Sentry issues); only search the Postiz source or docs when the answer isn't already there.
Ground every claim in the ticket, the code/docs, or tool results — say clearly when you cannot verify something.

Staff question: ${question}

${contextBlock}`;
}

export function buildCausePrompt(contextBlock: string, tools: AiToolAvailability): string {
  return `${PREAMBLE}

Perform a root-cause analysis of the following support ticket.
${toolNotes(tools)}
Start from the context already gathered below — the transcript, the live Postiz account snapshot (connected channels + their status, recent failed posts), any subscription/billing facts, and related Sentry issues. Lean on those first; only trace through the Postiz source code and docs to confirm or fill what the context doesn't answer, then cite file paths and line numbers for that code evidence.
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
