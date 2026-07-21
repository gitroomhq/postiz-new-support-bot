import {
  ExpressionError,
  MAX_REGEX_PATTERN_LENGTH,
  ParseContext,
  ParseResult,
  SlaCondition,
} from "./types";

// Text form of SLA rule conditions. Grammar (AND only — conditions are AND-ed
// by design; OR = another rule):
//
//   expression := condition ( "AND" condition )*
//   condition  := key op value
//   key        := ident ("." ident)*         e.g. category, stripe.paying
//   op         := "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~"
//   value      := bareword | "quoted string" | number | true | false
//
// parseExpression resolves human names to ids (status tag labels, tier names,
// category ids) via ParseContext; serializeExpression renders ids back to the
// current labels. Round-trip invariant: parse(serialize(conditions)) equals
// conditions (unit-tested).

// ---- tokenizer -------------------------------------------------------------

type Token =
  | { kind: "word"; text: string; pos: number }
  | { kind: "string"; text: string; pos: number; len: number }
  | { kind: "op"; text: string; pos: number };

const OPS = [">=", "<=", "!=", "!~", "=", ">", "<", "~"] as const;
// "*" is a word char for the attr set/not-set sugar (attr:"X"=*).
const WORD_RE = /^[A-Za-z0-9_.:@*-]+/;

function tokenize(text: string): { tokens: Token[] } | { error: ExpressionError } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\" && j + 1 < text.length && (text[j + 1] === '"' || text[j + 1] === "\\")) {
          value += text[j + 1];
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          j++;
          break;
        }
        value += c;
        j++;
      }
      if (!closed) {
        return { error: { pos: i, len: text.length - i, message: "unterminated quoted string" } };
      }
      tokens.push({ kind: "string", text: value, pos: i, len: j - i });
      i = j;
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) {
      tokens.push({ kind: "op", text: op, pos: i });
      i += op.length;
      continue;
    }
    const m = WORD_RE.exec(text.slice(i));
    if (m) {
      tokens.push({ kind: "word", text: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    return { error: { pos: i, len: 1, message: `unexpected character "${ch}"` } };
  }
  return { tokens };
}

function tokenLen(t: Token): number {
  return t.kind === "string" ? t.len : t.text.length;
}

// ---- key/op specs ----------------------------------------------------------

type OpSymbol = (typeof OPS)[number];

interface KeySpec {
  // op symbol → structured op name; the value builder validates/resolves.
  ops: Partial<Record<OpSymbol, string>>;
  opHint?: string;
  build: (
    op: string,
    raw: { text: string; quoted: boolean },
    ctx: ParseContext
  ) => SlaCondition | { message: string; hint?: string };
}

function boolValue(raw: { text: string; quoted: boolean }): boolean | null {
  const t = raw.text.toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  return null;
}

function boolSpec(dim: "open" | "exempt" | "mirrored" | "stripe.linked" | "stripe.paying" | "stripe.dispute" | "stripe.refund_review"): KeySpec {
  return {
    ops: { "=": "eq" },
    opHint: `${dim} only supports "=" with true/false (negate via =false)`,
    build: (_op, raw) => {
      const v = boolValue(raw);
      if (v === null) return { message: `${dim} needs true or false`, hint: `${dim}=true` };
      return { dim, op: "eq", value: v } as SlaCondition;
    },
  };
}

function regexError(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return `pattern longer than ${MAX_REGEX_PATTERN_LENGTH} characters`;
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (e) {
    return `invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const ci = (s: string) => s.toLowerCase();

function availableHint(label: string, options: string[]): string {
  const shown = options.slice(0, 8).join(", ");
  return `known ${label}: ${shown}${options.length > 8 ? ", …" : ""}`;
}

const KEY_SPECS: Record<string, KeySpec> = {
  category: {
    ops: { "=": "eq", "!=": "neq" },
    build: (op, raw, ctx) => {
      const match = ctx.categories.find(
        (c) => ci(c.id) === ci(raw.text) || (c.label != null && ci(c.label) === ci(raw.text))
      );
      if (!match) {
        return {
          message: `unknown category "${raw.text}"`,
          hint: availableHint("categories", ctx.categories.map((c) => c.id)),
        };
      }
      return { dim: "category", op: op as "eq" | "neq", value: match.id };
    },
  },
  status: {
    ops: { "=": "eq", "!=": "neq" },
    build: (op, raw, ctx) => {
      const match = ctx.tags.find(
        (t) => ci(t.label) === ci(raw.text) || t.emoji === raw.text || t.id === raw.text
      );
      if (!match) {
        return {
          message: `unknown status tag "${raw.text}"`,
          hint: availableHint("tags", ctx.tags.map((t) => t.label)),
        };
      }
      return { dim: "status", op: op as "eq" | "neq", tagId: match.id };
    },
  },
  open: boolSpec("open"),
  exempt: boolSpec("exempt"),
  mirrored: boolSpec("mirrored"),
  "stripe.linked": boolSpec("stripe.linked"),
  "stripe.paying": boolSpec("stripe.paying"),
  "stripe.dispute": boolSpec("stripe.dispute"),
  "stripe.refund_review": boolSpec("stripe.refund_review"),
  "stripe.plan": {
    ops: { "=": "eq", "!=": "neq", "~": "matches" },
    opHint: 'stripe.plan supports =, != (exact) and ~ (regex)',
    build: (op, raw) => {
      if (op === "matches") {
        const err = regexError(raw.text);
        if (err) return { message: err };
      }
      return { dim: "stripe.plan", op: op as "eq" | "neq" | "matches", value: raw.text };
    },
  },
  "stripe.spend": {
    ops: { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" },
    opHint: "stripe.spend supports >, >=, <, <= (major units, e.g. 100 = $100)",
    build: (op, raw) => {
      const n = Number(raw.text);
      if (raw.quoted || !Number.isFinite(n)) {
        return { message: `stripe.spend needs a number, got "${raw.text}"`, hint: "stripe.spend>=100" };
      }
      return { dim: "stripe.spend", op: op as "gt" | "gte" | "lt" | "lte", value: n };
    },
  },
  "intercom.team": {
    ops: { "=": "eq", "!=": "neq" },
    build: (op, raw) => ({ dim: "intercom.team", op: op as "eq" | "neq", value: raw.text }),
  },
  "intercom.assignee": {
    ops: { "=": "eq", "!=": "neq" },
    opHint: "intercom.assignee compares the assigned teammate's admin id",
    build: (op, raw) => ({ dim: "intercom.assignee", op: op as "eq" | "neq", value: raw.text }),
  },
  "intercom.kind": {
    ops: { "=": "eq" },
    build: (_op, raw) => {
      const v = ci(raw.text);
      if (v !== "conversation" && v !== "ticket") {
        return { message: `intercom.kind must be conversation or ticket, got "${raw.text}"` };
      }
      return { dim: "intercom.kind", op: "eq", value: v };
    },
  },
  "intercom.ticket_type": {
    ops: { "=": "eq", "!=": "neq" },
    build: (op, raw) => ({ dim: "intercom.ticket_type", op: op as "eq" | "neq", value: raw.text }),
  },
  "intercom.tag": {
    ops: { "=": "has", "!=": "not_has" },
    opHint: "intercom.tag supports = (has) and != (does not have)",
    build: (op, raw) => ({ dim: "intercom.tag", op: op as "has" | "not_has", value: raw.text }),
  },
  keyword: {
    ops: { "~": "matches", "!~": "not_matches" },
    opHint: 'keyword supports ~ and !~ (case-insensitive regex; a plain word is a substring match)',
    build: (op, raw) => {
      const err = regexError(raw.text);
      if (err) return { message: err };
      return { dim: "keyword", op: op as "matches" | "not_matches", value: raw.text };
    },
  },
};

export const EXPRESSION_KEYS = Object.keys(KEY_SPECS);

// ---- parser ----------------------------------------------------------------

export function parseExpression(text: string, ctx: ParseContext): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, errors: [{ pos: 0, len: 0, message: "expression is empty" }] };

  const tok = tokenize(text);
  if ("error" in tok) return { ok: false, errors: [tok.error] };
  const tokens = tok.tokens;

  const errors: ExpressionError[] = [];
  const conditions: SlaCondition[] = [];
  let i = 0;

  const parseAttributeCondition = (): boolean => {
    const key = tokens[i] as Token & { kind: "word" };
    let name = key.text.slice("attr:".length);
    let consumed = 1;
    if (!name) {
      const nameTok = tokens[i + 1];
      if (!nameTok || nameTok.kind !== "string") {
        errors.push({ pos: key.pos, len: tokenLen(key), message: 'attr: needs a name (attr:Sentiment or attr:"AI Title")' });
        return false;
      }
      name = nameTok.text;
      consumed = 2;
    }
    const opTok = tokens[i + consumed];
    const attrOps: Partial<Record<OpSymbol, string>> = { "=": "eq", "!=": "neq", "~": "matches" };
    const opName = opTok && opTok.kind === "op" ? attrOps[opTok.text as OpSymbol] : undefined;
    if (!opName) {
      errors.push({
        pos: opTok ? opTok.pos : key.pos + tokenLen(key),
        len: opTok ? tokenLen(opTok) : 0,
        message: `attribute conditions support =, != and ~ (regex); "*" as the value means set/not-set`,
      });
      return false;
    }
    const valTok = tokens[i + consumed + 1];
    if (!valTok || valTok.kind === "op" || (valTok.kind === "word" && ci(valTok.text) === "and")) {
      errors.push({
        pos: valTok ? valTok.pos : opTok!.pos + tokenLen(opTok!),
        len: valTok ? tokenLen(valTok) : 0,
        message: `expected a value after attr:"${name}"${opTok!.text}`,
      });
      return false;
    }
    i += consumed + 2;
    // "*" = existence check (unquoted only — a quoted "*" is a literal value).
    if (valTok.kind === "word" && valTok.text === "*" && opName !== "matches") {
      conditions.push({ dim: "intercom.attribute", name, op: opName === "eq" ? "set" : "not_set" });
      return true;
    }
    if (opName === "matches") {
      const err = regexError(valTok.text);
      if (err) {
        errors.push({ pos: valTok.pos, len: tokenLen(valTok), message: err });
        return true; // recoverable
      }
    }
    conditions.push({ dim: "intercom.attribute", name, op: opName as "eq" | "neq" | "matches", value: valTok.text });
    return true;
  };

  const expectCondition = (): boolean => {
    const key = tokens[i];
    if (!key || key.kind !== "word") {
      errors.push({
        pos: key ? key.pos : text.length,
        len: key ? tokenLen(key) : 0,
        message: "expected a condition key",
        hint: availableHint("keys", EXPRESSION_KEYS),
      });
      return false;
    }
    // Conversation attribute conditions: attr:Name=value / attr:"AI Title"~"x"
    // (bareword names ride in the key token — ":" is a word char; quoted
    // names arrive as a separate string token after a bare `attr:`).
    if (ci(key.text).startsWith("attr:")) {
      return parseAttributeCondition();
    }
    const spec = KEY_SPECS[ci(key.text)];
    if (!spec) {
      errors.push({
        pos: key.pos,
        len: tokenLen(key),
        message: `unknown key "${key.text}"`,
        hint: availableHint("keys", EXPRESSION_KEYS),
      });
      return false;
    }
    const opTok = tokens[i + 1];
    if (!opTok || opTok.kind !== "op") {
      errors.push({
        pos: opTok ? opTok.pos : key.pos + tokenLen(key),
        len: opTok ? tokenLen(opTok) : 0,
        message: `expected an operator after "${key.text}"`,
        hint: spec.opHint,
      });
      return false;
    }
    const opName = spec.ops[opTok.text as OpSymbol];
    if (!opName) {
      errors.push({
        pos: opTok.pos,
        len: tokenLen(opTok),
        message: `operator "${opTok.text}" not supported for ${ci(key.text)}`,
        hint: spec.opHint ?? `supported: ${Object.keys(spec.ops).join(" ")}`,
      });
      return false;
    }
    const valTok = tokens[i + 2];
    if (!valTok || valTok.kind === "op" || (valTok.kind === "word" && ci(valTok.text) === "and")) {
      errors.push({
        pos: valTok ? valTok.pos : opTok.pos + tokenLen(opTok),
        len: valTok ? tokenLen(valTok) : 0,
        message: `expected a value after "${key.text}${opTok.text}"`,
      });
      return false;
    }
    const built = spec.build(opName, { text: valTok.text, quoted: valTok.kind === "string" }, ctx);
    if ("message" in built && !("dim" in built)) {
      errors.push({ pos: valTok.pos, len: tokenLen(valTok), message: built.message, hint: built.hint });
      i += 3;
      return true; // recoverable: keep parsing to surface further errors
    }
    conditions.push(built as SlaCondition);
    i += 3;
    return true;
  };

  if (!expectCondition()) return { ok: false, errors };
  while (i < tokens.length) {
    const joiner = tokens[i];
    if (joiner.kind === "word" && ci(joiner.text) === "and") {
      i++;
      if (!expectCondition()) return { ok: false, errors };
      continue;
    }
    if (joiner.kind === "word" && ci(joiner.text) === "or") {
      errors.push({
        pos: joiner.pos,
        len: tokenLen(joiner),
        message: "OR is not supported; conditions are AND-ed",
        hint: "express OR as a second rule",
      });
      return { ok: false, errors };
    }
    errors.push({
      pos: joiner.pos,
      len: tokenLen(joiner),
      message: `expected AND, got "${joiner.kind === "string" ? '"…"' : joiner.text}"`,
    });
    return { ok: false, errors };
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, conditions };
}

// ---- serializer ------------------------------------------------------------

const BAREWORD_RE = /^[A-Za-z0-9_.:@-]+$/;
const RESERVED = new Set(["and", "or", "true", "false"]);

function renderValue(value: string): string {
  if (BAREWORD_RE.test(value) && !RESERVED.has(value.toLowerCase()) && !/^\d+(\.\d+)?$/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const OP_SYMBOL: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  matches: "~",
  not_matches: "!~",
  has: "=",
  not_has: "!=",
};

export function serializeCondition(cond: SlaCondition, ctx: ParseContext): string {
  const sym = OP_SYMBOL[cond.op];
  switch (cond.dim) {
    case "status": {
      const tag = ctx.tags.find((t) => t.id === cond.tagId);
      return `status${sym}${renderValue(tag ? tag.label : cond.tagId)}`;
    }
    case "stripe.spend":
      return `stripe.spend${sym}${cond.value}`;
    case "open":
    case "exempt":
    case "mirrored":
    case "stripe.linked":
    case "stripe.paying":
    case "stripe.dispute":
    case "stripe.refund_review":
      return `${cond.dim}=${cond.value}`;
    case "intercom.attribute": {
      const name = `attr:"${cond.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      if (cond.op === "set") return `${name}=*`;
      if (cond.op === "not_set") return `${name}!=*`;
      const opSym = cond.op === "matches" ? "~" : cond.op === "eq" ? "=" : "!=";
      return `${name}${opSym}"${(cond.value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    // keyword/plan regexes always quote so the pattern survives barewording.
    case "keyword":
      return `keyword${sym}"${cond.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    default:
      return `${cond.dim}${sym}${renderValue(cond.value)}`;
  }
}

export function serializeExpression(conditions: SlaCondition[], ctx: ParseContext): string {
  return conditions.map((c) => serializeCondition(c, ctx)).join(" AND ");
}
