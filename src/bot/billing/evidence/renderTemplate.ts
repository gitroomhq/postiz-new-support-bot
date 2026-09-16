import type { EvidenceFacts } from "./tokens";

// Template shape and the renderer. The rule this file exists to enforce is that
// a rendered field is either fully grounded in real facts or absent: there is
// no partial fill, no placeholder left behind, and no hedge.

export interface TemplateBlock {
  // One paragraph. Tokens are {{dotted.name}} and are extracted automatically,
  // so every token a block mentions is implicitly required BY THAT BLOCK.
  text: string;
  // An extra gate for variant selection, e.g. "a same-amount charge exists".
  // Pure: no IO, no Date.now(), so a render is reproducible.
  when?: (f: EvidenceFacts) => boolean;
  // Tokens the block reads only through `when`, which the extractor cannot see.
  alsoNeeds?: string[];
}

export interface EvidenceTemplate {
  field: string; // a TEXT_EVIDENCE_KEYS member
  blocks: TemplateBlock[];
  // Tokens without which the WHOLE field is meaningless, even if some blocks
  // would survive. Unresolved means the field is omitted.
  requires?: string[];
  // Below this the field is dropped: a two-sentence stub dilutes a package
  // rather than strengthening it.
  minChars?: number;
  maxChars?: number;
  // "enrich" templates depend on facts too slow to gather inside the webhook
  // (Intercom), so they are skipped on the fast path and added by the looper.
  stage?: "fast" | "enrich";
}

export const DEFAULT_MIN_CHARS = 40;
export const DEFAULT_MAX_CHARS = 3500;

const TOKEN_RE = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;

export function tokensIn(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[1]);
}

export function templateTokens(template: EvidenceTemplate): string[] {
  const names = new Set<string>(template.requires ?? []);
  for (const block of template.blocks) {
    for (const t of tokensIn(block.text)) names.add(t);
    for (const t of block.alsoNeeds ?? []) names.add(t);
  }
  return [...names];
}

// ---- post-render safety net ----

// These are no longer anti-hallucination guards: there is no model. They catch
// a DB override written by a tired human and anything a manual editor typed.
export const NO_UNRESOLVED_TOKEN = /\{\{|\}\}/;
// Mined from the old drafting prompt's rules, which stay correct without it:
// the reader is a bank analyst, not a developer.
export const NO_INTERNAL_ARTIFACT = /(\.\/|\bsrc\/|postiz-app|postiz-docs|\.mdx\b|\.ts\b|localhost|prisma|node_modules)/i;
// Written as an escape so the codebase itself stays free of literal em-dashes.
const EM_DASH = /\u2014/g;

export type DropReason = "unresolved_token" | "internal_artifact" | "too_short" | "no_blocks" | "missing_requires";

export interface RenderedField {
  field: string;
  text: string | null;
  dropped: DropReason | null;
  // Which tokens were missing, so a preview can say WHY a field is absent
  // instead of just showing a gap.
  missing: string[];
}

function truncateAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut).trim();
}

// An em-dash is scrubbed rather than dropping the field: it is punctuation, and
// losing a whole paragraph of evidence over it would be a bad trade.
function scrub(text: string): string {
  return text.replace(EM_DASH, ", ");
}

export function renderField(
  template: EvidenceTemplate,
  tokens: Record<string, string | null>,
  facts: EvidenceFacts
): RenderedField {
  const missing: string[] = [];
  const fail = (dropped: DropReason): RenderedField => ({ field: template.field, text: null, dropped, missing });

  for (const required of template.requires ?? []) {
    if (!tokens[required]) missing.push(required);
  }
  if (missing.length) return fail("missing_requires");

  const paragraphs: string[] = [];
  for (const block of template.blocks) {
    const needed = [...tokensIn(block.text), ...(block.alsoNeeds ?? [])];
    const absent = needed.filter((t) => !tokens[t]);
    if (absent.length) {
      missing.push(...absent);
      continue;
    }
    if (block.when && !block.when(facts)) continue;
    paragraphs.push(block.text.replace(TOKEN_RE, (_m, name: string) => tokens[name] as string));
  }

  if (!paragraphs.length) return fail("no_blocks");

  let text = scrub(paragraphs.join("\n\n"))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  if (NO_UNRESOLVED_TOKEN.test(text)) return fail("unresolved_token");
  if (NO_INTERNAL_ARTIFACT.test(text)) return fail("internal_artifact");
  if (text.length < (template.minChars ?? DEFAULT_MIN_CHARS)) return fail("too_short");

  text = truncateAtSentence(text, template.maxChars ?? DEFAULT_MAX_CHARS);
  return { field: template.field, text, dropped: null, missing };
}
