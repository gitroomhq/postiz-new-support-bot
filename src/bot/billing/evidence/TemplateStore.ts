import type { PrismaClient, DisputeEvidenceTemplate as TemplateRow } from "../../../generated/prisma/client";
import type { EvidenceTemplate } from "./renderTemplate";
import { templateFor, type PackReason } from "./templates";

// Operator overrides for the shipped corpus. A row replaces exactly one
// (reason, field) pair; anything not overridden keeps the reviewed text in the
// repository.
//
// An override body is plain prose: paragraphs separated by a blank line, with
// {{token}} interpolation. Each paragraph becomes a block, so the same
// per-paragraph omission rule applies to edited text as to shipped text.

export type OverrideMap = Map<string, EvidenceTemplate>;

export function overrideKey(reason: string, field: string): string {
  return `${reason}:${field}`;
}

// The shipped template's `requires` are carried onto the override deliberately.
// refund_refusal_explanation asserts that no refund was ever requested, and it
// may only do so when Intercom actually confirmed it. An operator rewording
// that paragraph must not be able to drop the gate that makes the claim
// truthful, so the gate is not theirs to edit.
export function overrideToTemplate(row: TemplateRow): EvidenceTemplate {
  const shipped = templateFor(row.reason as PackReason, row.fieldKey);
  const blocks = row.body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
  return {
    field: row.fieldKey,
    blocks,
    requires: shipped?.requires,
    minChars: shipped?.minChars,
    maxChars: shipped?.maxChars,
    stage: shipped?.stage,
  };
}

export class TemplateStore {
  // A pack build reads every field at once, so the map is cached whole rather
  // than per field. Short TTL: an operator editing text wants to preview it.
  private cache: { at: number; map: OverrideMap } | null = null;

  constructor(
    private prisma: PrismaClient,
    private ttlMs = 60_000
  ) {}

  async overrides(): Promise<OverrideMap> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.map;
    const rows = await this.prisma.disputeEvidenceTemplate
      .findMany({ where: { enabled: true } })
      .catch(() => [] as TemplateRow[]);
    const map: OverrideMap = new Map();
    for (const row of rows) map.set(overrideKey(row.reason, row.fieldKey), overrideToTemplate(row));
    this.cache = { at: Date.now(), map };
    return map;
  }

  private invalidate(): void {
    this.cache = null;
  }

  async list(skip: number, take: number, reason?: string): Promise<{ rows: TemplateRow[]; total: number }> {
    const where = reason ? { reason } : {};
    const [rows, total] = await Promise.all([
      this.prisma.disputeEvidenceTemplate.findMany({ where, orderBy: [{ reason: "asc" }, { fieldKey: "asc" }], skip, take }),
      this.prisma.disputeEvidenceTemplate.count({ where }),
    ]);
    return { rows, total };
  }

  async get(reason: string, fieldKey: string): Promise<TemplateRow | null> {
    return this.prisma.disputeEvidenceTemplate.findUnique({ where: { reason_fieldKey: { reason, fieldKey } } });
  }

  async save(reason: string, fieldKey: string, body: string, actorId: string, actorName: string): Promise<TemplateRow> {
    const row = await this.prisma.disputeEvidenceTemplate.upsert({
      where: { reason_fieldKey: { reason, fieldKey } },
      create: { reason, fieldKey, body, updatedById: actorId, updatedByName: actorName },
      update: { body, updatedById: actorId, updatedByName: actorName, enabled: true },
    });
    this.invalidate();
    return row;
  }

  // Deleting restores the shipped text, which is why there is no "disable"
  // action in the UI: an operator either has their own wording or ours.
  async reset(reason: string, fieldKey: string): Promise<boolean> {
    const res = await this.prisma.disputeEvidenceTemplate.deleteMany({ where: { reason, fieldKey } });
    this.invalidate();
    return res.count > 0;
  }
}
