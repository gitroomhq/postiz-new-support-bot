import { STANDING_DOCUMENT_SLOTS } from "../../../bot/billing/evidence/EvidenceDocumentStore";
import { templateTokens } from "../../../bot/billing/evidence/renderTemplate";
import { TOKEN_NAMES } from "../../../bot/billing/evidence/tokens";
import {
  PACK_FIELDS_BY_REASON,
  PACK_REASONS,
  TEMPLATE_LIBRARY,
  TEMPLATE_VERSION,
  templateFor,
  type PackReason,
} from "../../../bot/billing/evidence/templates";
import { ActionButton, Badge, Block, Cell, TableBlock } from "../../renderer/contract";
import { SectionPage } from "../types";
import { sentence, strong, text } from "../cells";
import { DisputesDeps, DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, TEMPLATE_PAGE_SIZE } from "./cells";

// The evidence library: everything a pack is built OUT of, on one page.
//
// These were two pages reached by two header buttons, which asked the operator
// to know in advance whether the thing they wanted to change was words or a
// file. It is one question ("what does the auto-maker have to work with?") so
// it is one page with two tabs.

const LIBRARY_CRUMBS = [{ label: "Disputes", ref: { page: "disputes" } }, { label: "Evidence library" }];

export type LibraryTab = "" | "documents";

export async function libraryPage(
  deps: DisputesDeps,
  filters: Record<string, string>,
  cursor: string | null,
  forcedTab?: LibraryTab
): Promise<SectionPage> {
  const tab: LibraryTab = forcedTab ?? (filters.tab === "documents" ? "documents" : "");

  const blocks: Block[] = [
    {
      type: "header",
      title: "Evidence library",
      sub: "What every pack is assembled from: the words the templates write, and the published policies attached alongside them.",
    },
    {
      type: "tabs",
      key: "tab",
      value: tab || undefined,
      items: [
        { value: "", label: "Templates" },
        { value: "documents", label: "Policy documents" },
      ],
    },
  ];

  blocks.push(...(tab === "documents" ? await documentBlocks(deps) : await templateBlocks(deps, filters, cursor)));

  return { title: "Evidence library", crumbs: LIBRARY_CRUMBS, blocks };
}

// Evidence template editor.
//
// The shipped corpus is reviewed text in the repository; a row here overrides
// exactly one (reason, field) pair so wording can be fixed without a deploy.
// The per-field fallback means most fields show as inherited from "general",
// which is what keeps the corpus small enough to maintain.
async function templateBlocks(
  deps: DisputesDeps,
  filters: Record<string, string>,
  cursor: string | null
): Promise<Block[]> {
  const store = deps.templateStore;
  if (!store) {
    return [{ type: "notice", badge: { kind: "info", text: "Off" }, text: "The template store is not configured." }];
  }

  const reason = (PACK_REASONS as readonly string[]).includes(filters.reason ?? "")
    ? (filters.reason as PackReason)
    : "general";
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;
  const overrides = await store.overrides();

  const fields = PACK_FIELDS_BY_REASON[reason];
  const shown = fields.slice(offset, offset + TEMPLATE_PAGE_SIZE);

  const blocks: Block[] = [
    {
      type: "tabs",
      key: "reason",
      value: reason === "general" ? undefined : reason,
      items: PACK_REASONS.map((r) => ({ value: r === "general" ? "" : r, label: sentence(r.replace(/_/g, " ")) })),
    },
  ];

  const table: TableBlock = {
    type: "table",
    key: "templates",
    columns: [
      { key: "field", label: "Evidence field" },
      { key: "source", label: "Source" },
      { key: "length", label: "Length" },
      { key: "tokens", label: "Tokens used" },
    ],
    rows: shown.map((field) => {
      const own = overrides.get(`${reason}:${field}`);
      const general = overrides.get(`general:${field}`);
      const template = templateFor(reason, field, overrides);
      const body = (template?.blocks ?? []).map((b) => b.text).join("\n\n");
      const tokens = template ? templateTokens(template) : [];
      const source: Badge = own
        ? { kind: "warn", text: "Override" }
        : general
          ? { kind: "warn", text: "Override (general)" }
          : TEMPLATE_LIBRARY[reason]?.[field]
            ? { kind: "ok", text: "Shipped" }
            : { kind: "neutral", text: "Inherited" };
      return {
        id: field,
        cells: [
          strong(field),
          { t: "badge", b: source } as Cell,
          text(`${body.length} chars`),
          text(tokens.slice(0, 4).join(", ") + (tokens.length > 4 ? ` +${tokens.length - 4}` : "")),
        ] as Cell[],
        actions: [
          {
            key: "section:disputes.template_save",
            label: "Edit",
            style: "secondary",
            params: { reason, field },
            inputs: [
              {
                type: "text",
                key: "body",
                label: "Template text (paragraphs separated by a blank line)",
                multiline: true,
                rows: 14,
                maxLength: 3500,
                value: body,
              },
            ],
          },
          ...(own
            ? ([
                {
                  key: "section:disputes.template_reset",
                  label: "Reset to shipped",
                  style: "danger",
                  dangerous: true,
                  params: { reason, field },
                },
              ] as ActionButton[])
            : []),
        ] as ActionButton[],
      };
    }),
    nextCursor: offset + TEMPLATE_PAGE_SIZE < fields.length ? String(offset + TEMPLATE_PAGE_SIZE) : null,
    empty: "No templated fields for this reason.",
    footer: `${shown.length} of ${fields.length} field${fields.length === 1 ? "" : "s"} · corpus ${TEMPLATE_VERSION}`,
    notice:
      "A field renders only when every token in it resolves. Anything unresolved drops that paragraph, or the whole field, rather than reaching a bank with a gap in it.",
  };
  blocks.push(table);
  blocks.push({
    type: "notice",
    badge: { kind: "info", text: "Tokens" },
    text: `Available tokens: ${TOKEN_NAMES.join(", ")}`,
  });
  return blocks;
}

// The standing policy documents: uploaded once here, stamped into every
// dispute that has an empty slot for them.
//
// Three rows, so no pagination: Stripe has exactly these file slots a published
// policy can occupy, and inventing more would only produce slots a bank does
// not read.
async function documentBlocks(deps: DisputesDeps): Promise<Block[]> {
  const store = deps.evidenceDocuments;
  if (!store) {
    return [{ type: "notice", badge: { kind: "info", text: "Off" }, text: "The document store is not configured." }];
  }

  const held = await store.bySlot();
  const table: TableBlock = {
    type: "table",
    key: "documents",
    columns: [
      { key: "slot", label: "Slot" },
      { key: "file", label: "Document" },
      { key: "size", label: "Size", align: "right" },
      { key: "who", label: "Uploaded" },
    ],
    rows: STANDING_DOCUMENT_SLOTS.map((spec) => {
      const doc = held.get(spec.slot);
      const upload: ActionButton = {
        key: "section:disputes.document_put",
        label: doc ? "Replace" : "Upload",
        style: doc ? "secondary" : "primary",
        params: { slot: spec.slot },
        summary: `${doc ? "Replaces" : "Sets"} the ${spec.label.toLowerCase()} copied onto every dispute from now on. PDF, PNG or JPEG, up to 4MB. Disputes already staged keep the copy they were given.`,
        inputs: [
          { type: "file", key: "doc", label: `${spec.label} (PDF, PNG or JPEG)`, accept: DOCUMENT_TYPES, maxBytes: DOCUMENT_MAX_BYTES },
        ],
      };
      return {
        id: spec.slot,
        cells: [
          strong(spec.label),
          doc ? text(doc.fileName) : ({ t: "badge", b: { kind: "warn", text: "none" } } as Cell),
          text(doc ? `${Math.max(1, Math.round(doc.sizeBytes / 1024))}KB` : ""),
          text(doc ? `${doc.uploadedByName}, ${doc.uploadedAt.toISOString().slice(0, 10)}` : spec.help),
        ] as Cell[],
        actions: [
          upload,
          ...(doc
            ? ([
                {
                  key: "section:disputes.document_remove",
                  label: "Stop attaching",
                  style: "danger",
                  dangerous: true,
                  params: { slot: spec.slot },
                  summary: `Future disputes stop receiving the ${spec.label.toLowerCase()}. Nothing already staged is touched and the file stays in the Stripe account.`,
                },
              ] as ActionButton[])
            : []),
        ] as ActionButton[],
      };
    }),
    nextCursor: null,
    empty: "No document slots.",
    notice:
      "Uploaded once here and copied per dispute, because Stripe binds an evidence file to a single dispute. They attach whenever a pack is built, never overwrite a slot a human has filled, and reach the bank only when you submit evidence.",
  };

  return [
    {
      type: "notice",
      badge: { kind: "info", text: "Which document" },
      text: "Attach the policy exactly as published. An analyst is checking whether what you assert in the text is a real, published rule, so a document written for the dispute argues less than the page the customer could have read.",
    },
    table,
  ];
}
