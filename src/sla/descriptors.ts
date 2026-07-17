import { SlaCondition } from "./types";

// Guided-builder field descriptors: the /intercom SLA hub renders its
// "Add condition…" flow 100% generically from this list — a select of ops for
// the dimension, then a value step whose UI comes from `kind`:
//   enum    → StringSelectMenu fed by options(deps)
//   boolean → two-button true/false pick
//   number  → modal with a numeric input
//   text    → modal with a text input (regex allowed where noted)
// `conditionFor` maps the collected (key, op, value) back to a typed
// SlaCondition; store-level zod validation still runs on save.

export interface DescriptorOption {
  label: string;
  value: string;
  description?: string;
}

export interface DescriptorDeps {
  categories: () => DescriptorOption[];
  statusTags: () => DescriptorOption[];
  intercomTeams: () => Promise<DescriptorOption[]>;
  intercomTicketTypes: () => Promise<DescriptorOption[]>;
  intercomTags: () => Promise<DescriptorOption[]>;
  intercomAdmins: () => Promise<DescriptorOption[]>;
  intercomAttributes: () => Promise<DescriptorOption[]>;
}

export interface FieldDescriptor {
  key: SlaCondition["dim"];
  label: string;
  kind: "enum" | "boolean" | "number" | "text";
  // op value → human label, in display order. The op strings are the
  // structured op names (eq/neq/…), not expression symbols.
  ops: Array<{ op: string; label: string }>;
  hint?: string;
  options?: (deps: DescriptorDeps) => Promise<DescriptorOption[]>;
}

const EQ_NEQ = [
  { op: "eq", label: "is" },
  { op: "neq", label: "is not" },
];

export const FIELD_DESCRIPTORS: FieldDescriptor[] = [
  {
    key: "category",
    label: "Ticket category",
    kind: "enum",
    ops: EQ_NEQ,
    options: async (d) => d.categories(),
  },
  {
    key: "status",
    label: "Status tag",
    kind: "enum",
    ops: EQ_NEQ,
    options: async (d) => d.statusTags(),
  },
  { key: "open", label: "Ticket open", kind: "boolean", ops: [{ op: "eq", label: "is" }] },
  { key: "exempt", label: "Intercom-exempt (Discord-only)", kind: "boolean", ops: [{ op: "eq", label: "is" }] },
  { key: "mirrored", label: "Mirrored to Intercom", kind: "boolean", ops: [{ op: "eq", label: "is" }] },
  { key: "stripe.linked", label: "Stripe customer linked", kind: "boolean", ops: [{ op: "eq", label: "is" }] },
  { key: "stripe.paying", label: "Paying customer (active sub)", kind: "boolean", ops: [{ op: "eq", label: "is" }] },
  { key: "stripe.dispute", label: "Has open dispute", kind: "boolean", ops: [{ op: "eq", label: "is" }] },
  { key: "stripe.refund_review", label: "Refund review pending", kind: "boolean", ops: [{ op: "eq", label: "is" }] },
  {
    key: "stripe.plan",
    label: "Stripe plan (price id / nickname)",
    kind: "text",
    ops: [...EQ_NEQ, { op: "matches", label: "matches regex" }],
    hint: "price id, nickname or lookup key; ~ accepts a case-insensitive regex",
  },
  {
    key: "stripe.spend",
    label: "Lifetime spend (major units)",
    kind: "number",
    ops: [
      { op: "gte", label: "at least" },
      { op: "gt", label: "more than" },
      { op: "lte", label: "at most" },
      { op: "lt", label: "less than" },
    ],
    hint: "e.g. 100 = $100 across captured charges",
  },
  {
    key: "intercom.team",
    label: "Assigned Intercom team",
    kind: "enum",
    ops: EQ_NEQ,
    options: (d) => d.intercomTeams(),
  },
  {
    key: "intercom.kind",
    label: "Conversation or ticket",
    kind: "enum",
    ops: [{ op: "eq", label: "is" }],
    options: async () => [
      { label: "Conversation", value: "conversation" },
      { label: "Ticket", value: "ticket" },
    ],
  },
  {
    key: "intercom.ticket_type",
    label: "Intercom ticket type",
    kind: "enum",
    ops: EQ_NEQ,
    options: (d) => d.intercomTicketTypes(),
  },
  {
    key: "intercom.tag",
    label: "Intercom tag",
    kind: "enum",
    ops: [
      { op: "has", label: "has" },
      { op: "not_has", label: "does not have" },
    ],
    options: (d) => d.intercomTags(),
  },
  {
    key: "intercom.assignee",
    label: "Assigned teammate",
    kind: "enum",
    ops: EQ_NEQ,
    options: (d) => d.intercomAdmins(),
  },
  {
    // Two-step in the builder: pick the attribute definition (enum), then the
    // op, then a value modal (skipped for set/not-set). Expression form:
    // attr:"Name"=value / attr:"Name"~"regex" / attr:"Name"=* (set) / !=* (not set).
    key: "intercom.attribute",
    label: "Conversation attribute",
    kind: "enum",
    ops: [
      { op: "eq", label: "is" },
      { op: "neq", label: "is not" },
      { op: "matches", label: "matches regex" },
      { op: "set", label: "is set" },
      { op: "not_set", label: "is not set" },
    ],
    hint: "any conversation data attribute, incl. Fin attributes",
    options: (d) => d.intercomAttributes(),
  },
  {
    key: "keyword",
    label: "Keyword in question/body",
    kind: "text",
    ops: [
      { op: "matches", label: "contains/matches" },
      { op: "not_matches", label: "does not contain/match" },
    ],
    hint: "case-insensitive; a plain word is a substring match, regex allowed",
  },
];

export function descriptorFor(key: string): FieldDescriptor | undefined {
  return FIELD_DESCRIPTORS.find((d) => d.key === key);
}

// (key, op, raw value) → typed condition. Throws on malformed input — callers
// (the guided builder) only offer valid ops, and store validation re-checks.
export function conditionFor(key: string, op: string, value: string): SlaCondition {
  switch (key) {
    case "category":
      return { dim: "category", op: op as "eq" | "neq", value };
    case "status":
      return { dim: "status", op: op as "eq" | "neq", tagId: value };
    case "open":
    case "exempt":
    case "mirrored":
    case "stripe.linked":
    case "stripe.paying":
    case "stripe.dispute":
    case "stripe.refund_review":
      return { dim: key, op: "eq", value: value === "true" } as SlaCondition;
    case "stripe.plan":
      return { dim: "stripe.plan", op: op as "eq" | "neq" | "matches", value };
    case "stripe.spend": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`stripe.spend needs a number, got "${value}"`);
      return { dim: "stripe.spend", op: op as "gt" | "gte" | "lt" | "lte", value: n };
    }
    case "intercom.team":
      return { dim: "intercom.team", op: op as "eq" | "neq", value };
    case "intercom.kind":
      return { dim: "intercom.kind", op: "eq", value: value as "conversation" | "ticket" };
    case "intercom.ticket_type":
      return { dim: "intercom.ticket_type", op: op as "eq" | "neq", value };
    case "intercom.tag":
      return { dim: "intercom.tag", op: op as "has" | "not_has", value };
    case "intercom.assignee":
      return { dim: "intercom.assignee", op: op as "eq" | "neq", value };
    case "keyword":
      return { dim: "keyword", op: op as "matches" | "not_matches", value };
    default:
      throw new Error(`unknown condition key "${key}"`);
  }
}
