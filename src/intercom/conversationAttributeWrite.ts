// Manual conversation-attribute writes (/debug-attribute). Conversation
// attributes are TYPED in Intercom (Settings → Data → Conversations) and the
// PUT /conversations endpoint 4xx's on both undefined names and values of the
// wrong type, so a Discord string has to be resolved against the live
// definition list and coerced before it goes out. Pure so it stays testable
// away from the Discord/Intercom plumbing.

export interface ConversationAttributeDef {
  name: string;
  archived: boolean;
  dataType: string | null; // string | integer | float | boolean | date | list
}

export type AttributeResolution =
  | { ok: true; def: ConversationAttributeDef }
  | { ok: false; error: string };

// Typing "null" clears the attribute. A text attribute whose literal value
// should be the word "null" can't be set from here: an acceptable trade for a
// debug command, since clearing is otherwise impossible through Discord.
export const CLEAR_KEYWORD = "null";

export type CoercedValue = string | number | boolean | null;

export type ValueCoercion =
  | { ok: true; value: CoercedValue; display: string }
  | { ok: false; error: string };

const MAX_SUGGESTIONS = 8;

// Exact match first; a case-insensitive match is accepted only when it is
// unambiguous, because Intercom allows two definitions differing in case only.
export function resolveConversationAttribute(
  defs: ConversationAttributeDef[],
  rawName: string
): AttributeResolution {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "Attribute name is empty." };

  const live = defs.filter((d) => !d.archived);
  if (defs.length === 0) {
    return {
      ok: false,
      error: "This workspace has no conversation attributes defined. Create one in Intercom → Settings → Data → Conversations first.",
    };
  }

  const exact = defs.find((d) => d.name === name);
  if (exact) return archivedGuard(exact);

  const insensitive = defs.filter((d) => d.name.toLowerCase() === name.toLowerCase());
  if (insensitive.length === 1) return archivedGuard(insensitive[0]);
  if (insensitive.length > 1) {
    return {
      ok: false,
      error: `\`${name}\` matches ${insensitive.length} attributes that differ only in capitalisation (${insensitive
        .map((d) => `\`${d.name}\``)
        .join(", ")}). Type the exact name.`,
    };
  }

  const suggestions = live
    .filter((d) => d.name.toLowerCase().includes(name.toLowerCase()))
    .slice(0, MAX_SUGGESTIONS);
  const fallback = live.slice(0, MAX_SUGGESTIONS);
  const shown = suggestions.length > 0 ? suggestions : fallback;
  const listed = shown.map((d) => `\`${d.name}\``).join(", ");
  return {
    ok: false,
    error:
      `No conversation attribute named \`${name}\`. It must exist in Intercom → Settings → Data → Conversations before it can be written.` +
      (listed ? `\n${suggestions.length > 0 ? "Did you mean" : "Available"}: ${listed}` : ""),
  };
}

function archivedGuard(def: ConversationAttributeDef): AttributeResolution {
  if (def.archived) {
    return { ok: false, error: `\`${def.name}\` is archived in Intercom; unarchive it before writing to it.` };
  }
  return { ok: true, def };
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "on"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off"]);

export function coerceConversationAttributeValue(dataType: string | null, rawValue: string): ValueCoercion {
  const raw = rawValue.trim();
  if (raw.toLowerCase() === CLEAR_KEYWORD) return { ok: true, value: null, display: "_(cleared)_" };

  switch ((dataType ?? "string").toLowerCase()) {
    case "boolean": {
      const lower = raw.toLowerCase();
      if (TRUE_WORDS.has(lower)) return { ok: true, value: true, display: "`true`" };
      if (FALSE_WORDS.has(lower)) return { ok: true, value: false, display: "`false`" };
      return { ok: false, error: `\`${raw}\` is not a boolean. Use \`true\` or \`false\`.` };
    }
    case "integer": {
      if (!/^-?\d+$/.test(raw)) return { ok: false, error: `\`${raw}\` is not a whole number.` };
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed)) return { ok: false, error: `\`${raw}\` is out of the safe integer range.` };
      return { ok: true, value: parsed, display: `\`${parsed}\`` };
    }
    case "float": {
      const parsed = Number(raw);
      if (raw === "" || !Number.isFinite(parsed)) return { ok: false, error: `\`${raw}\` is not a number.` };
      return { ok: true, value: parsed, display: `\`${parsed}\`` };
    }
    case "date": {
      // Intercom stores date attributes as unix SECONDS. Bare digits are taken
      // as an already-unix value; anything else goes through Date parsing, so
      // `2026-07-27` (UTC midnight) works.
      if (/^\d{1,10}$/.test(raw)) {
        const seconds = Number(raw);
        return { ok: true, value: seconds, display: `\`${new Date(seconds * 1000).toISOString()}\` (${seconds})` };
      }
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        return { ok: false, error: `\`${raw}\` is not a date. Use \`2026-07-27\`, an ISO timestamp, or unix seconds.` };
      }
      const seconds = Math.floor(ms / 1000);
      return { ok: true, value: seconds, display: `\`${new Date(seconds * 1000).toISOString()}\` (${seconds})` };
    }
    // "list" values are constrained to the definition's options, which the
    // data_attributes list response doesn't expose, so send as text and let
    // Intercom reject an option that isn't on the list.
    default:
      return { ok: true, value: raw, display: `\`${raw}\`` };
  }
}

// Read-back rendering for the confirmation embed: whatever Intercom actually
// stored, which is the point of a debug command (a silently coerced or
// ignored write shows up here).
export function formatStoredAttributeValue(value: unknown, dataType: string | null): string {
  if (value === null || value === undefined) return "_(not set)_";
  if (typeof value === "boolean") return `\`${value}\``;
  if (typeof value === "number") {
    if ((dataType ?? "").toLowerCase() === "date") {
      return `\`${new Date(value * 1000).toISOString()}\` (${value})`;
    }
    return `\`${value}\``;
  }
  const text = String(value);
  return text.length > 300 ? `\`${text.slice(0, 300)}\`…` : `\`${text}\``;
}
