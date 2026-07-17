import { z } from "zod";

// SLA rule engine core types. Rules are an ordered list (position asc, 0 =
// highest priority); the first ENABLED rule whose conditions ALL pass wins and
// its `target` is written to the "SLA Target" conversation attribute. A rule's
// conditions exist in two equivalent forms that round-trip: the structured
// SlaCondition[] (guided builder) and the canonical expression text
// ("category=billing AND stripe.paying=true AND keyword~\"refund\"").
//
// Evaluation semantics: missing data = condition FALSE, uniformly — a
// stripe.paying=true rule can never match a subject without a Stripe link;
// authors gate explicitly with stripe.linked=true (linked itself is always
// computable for bridged tickets, and always false-y for native conversations).

// ---- conditions -----------------------------------------------------------

// Regex-valued conditions are bounded against ReDoS: pattern length capped at
// validation time, input truncated at evaluation time.
export const MAX_REGEX_PATTERN_LENGTH = 200;
export const MAX_REGEX_INPUT_LENGTH = 10_000;

const eqNeq = z.enum(["eq", "neq"]);

const zCondition = z.discriminatedUnion("dim", [
  // Ticket basics (bridged tickets only).
  z.object({ dim: z.literal("category"), op: eqNeq, value: z.string().min(1) }),
  z.object({ dim: z.literal("status"), op: eqNeq, tagId: z.string().min(1) }),
  z.object({ dim: z.literal("open"), op: z.literal("eq"), value: z.boolean() }),
  z.object({ dim: z.literal("exempt"), op: z.literal("eq"), value: z.boolean() }),
  z.object({ dim: z.literal("mirrored"), op: z.literal("eq"), value: z.boolean() }),
  // Stripe (bridged tickets with a linked customer).
  z.object({ dim: z.literal("stripe.linked"), op: z.literal("eq"), value: z.boolean() }),
  z.object({ dim: z.literal("stripe.paying"), op: z.literal("eq"), value: z.boolean() }),
  z.object({ dim: z.literal("stripe.dispute"), op: z.literal("eq"), value: z.boolean() }),
  z.object({ dim: z.literal("stripe.refund_review"), op: z.literal("eq"), value: z.boolean() }),
  z.object({ dim: z.literal("stripe.plan"), op: z.enum(["eq", "neq", "matches"]), value: z.string().min(1) }),
  z.object({ dim: z.literal("stripe.spend"), op: z.enum(["gt", "gte", "lt", "lte"]), value: z.number().finite() }),
  // Intercom-side (bridged + native).
  z.object({ dim: z.literal("intercom.team"), op: eqNeq, value: z.string().min(1) }),
  z.object({ dim: z.literal("intercom.kind"), op: z.literal("eq"), value: z.enum(["conversation", "ticket"]) }),
  z.object({ dim: z.literal("intercom.ticket_type"), op: eqNeq, value: z.string().min(1) }),
  z.object({ dim: z.literal("intercom.tag"), op: z.enum(["has", "not_has"]), value: z.string().min(1) }),
  // Conversation custom attribute (any definition, incl. Fin attributes).
  // "set"/"not_set" ignore `value`; the others require it.
  z.object({
    dim: z.literal("intercom.attribute"),
    name: z.string().min(1),
    op: z.enum(["eq", "neq", "matches", "set", "not_set"]),
    value: z.string().optional(),
  }),
  z.object({ dim: z.literal("intercom.assignee"), op: eqNeq, value: z.string().min(1) }),
  // Content (ticket question / conversation source body).
  z.object({ dim: z.literal("keyword"), op: z.enum(["matches", "not_matches"]), value: z.string().min(1) }),
]);

export type SlaCondition = z.infer<typeof zCondition>;
export type SlaDim = SlaCondition["dim"];

// Validates one condition, including regex compilability for regex-valued ops.
export const slaConditionSchema = zCondition.superRefine((cond, ctx) => {
  if (cond.dim === "intercom.attribute") {
    const needsValue = cond.op === "eq" || cond.op === "neq" || cond.op === "matches";
    if (needsValue && !cond.value) {
      ctx.addIssue({ code: "custom", message: `attribute condition with op "${cond.op}" needs a value` });
      return;
    }
  }
  const usesRegex =
    cond.dim === "keyword" ||
    (cond.dim === "stripe.plan" && cond.op === "matches") ||
    (cond.dim === "intercom.attribute" && cond.op === "matches");
  if (!usesRegex) return;
  const pattern = (cond as { value?: string }).value ?? "";
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    ctx.addIssue({ code: "custom", message: `pattern longer than ${MAX_REGEX_PATTERN_LENGTH} characters` });
    return;
  }
  try {
    new RegExp(pattern, "i");
  } catch (e) {
    ctx.addIssue({ code: "custom", message: `invalid regex: ${e instanceof Error ? e.message : String(e)}` });
  }
});

export const slaConditionsSchema = z.array(slaConditionSchema).min(1);

// ---- facts ----------------------------------------------------------------

export interface SlaStripeFacts {
  linked: boolean;
  // Set only when a Stripe fetch ran; `unavailable` marks a timed-out/errored
  // fetch — every stripe.* condition except `linked` then evaluates false.
  unavailable?: boolean;
  paying?: boolean;
  planKeys?: string[]; // price ids + nicknames + lookup keys of active subs
  spendMajor?: number; // lifetime captured charge sum, major units
  truncatedSpend?: boolean; // page cap hit — spendMajor is a partial sum
  openDispute?: boolean;
  refundReview?: boolean;
}

export interface SlaIntercomFacts {
  teamId?: string | null;
  teamName?: string | null;
  adminAssigneeId?: string | null;
  kind?: "conversation" | "ticket";
  ticketTypeId?: string | null;
  tags?: string[];
  attributes?: Record<string, unknown>;
}

export interface SlaFacts {
  kind: "bridged" | "native";
  categoryId?: string;
  statusTagId?: string;
  open?: boolean;
  exempt?: boolean;
  mirrored?: boolean;
  stripe?: SlaStripeFacts;
  intercom?: SlaIntercomFacts;
  text?: string; // Ticket.question (bridged) | conversation source body, HTML-stripped (native)
}

// ---- rules + evaluation results -------------------------------------------

// The evaluator only needs this shape (the Prisma SlaRule row satisfies it
// once `conditions` is parsed).
export interface SlaRuleLike {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  conditions: SlaCondition[];
  target: string;
}

export interface SlaConditionTrace {
  condition: SlaCondition;
  pass: boolean;
  reason: string;
}

export interface SlaRuleTrace {
  ruleId: string;
  name: string;
  target: string;
  matched: boolean;
  skipped?: "disabled";
  conditions: SlaConditionTrace[];
}

export interface SlaEvaluation {
  winner: { ruleId: string; name: string; target: string } | null;
  trace: SlaRuleTrace[];
}

// ---- expression parse context ---------------------------------------------

// Name→id resolution data for parsing and id→name rendering for serialization.
// Built by SlaRuleStore from live stores; Intercom-side values (team, ticket
// type, tag) are stored RAW (id-or-name) and resolved at evaluation time, so
// parsing never needs an Intercom API call.
export interface ParseContext {
  categories: Array<{ id: string; label?: string }>;
  tags: Array<{ id: string; label: string; emoji: string }>;
}

export interface ExpressionError {
  pos: number; // 0-based character offset into the expression text
  len: number;
  message: string;
  hint?: string;
}

export type ParseResult = { ok: true; conditions: SlaCondition[] } | { ok: false; errors: ExpressionError[] };

// Managed target registry entry (BotSettings.slaTargetsJson). Durations are
// BUSINESS minutes for the bot-native clocks — a clock left unset is disabled
// for that target; a target with no durations gets no clocks at all.
export interface SlaTargetEntry {
  value: string;
  note: string;
  firstReplyMins?: number;
  nextReplyMins?: number;
  resolveMins?: number;
  warnPct?: number; // per-target at_risk threshold override (default: BotSettings.slaWarnPct)
}

export function hasClockDurations(t: SlaTargetEntry): boolean {
  return t.firstReplyMins != null || t.nextReplyMins != null || t.resolveMins != null;
}

// Case-sensitive: the value must EXACTLY match the Intercom List-attribute
// option.
export const SLA_TARGET_VALUE_RE = /^[A-Za-z0-9-_]{1,60}$/;
