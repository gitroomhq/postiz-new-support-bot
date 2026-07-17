import { PrismaClient, SlaRule } from "../generated/prisma/client";
import { SettingsStore } from "../config/SettingsStore";
import { parseExpression, serializeExpression } from "./expression";
import { ExpressionError, ParseContext, SlaCondition, SlaDim, SlaRuleLike, slaConditionsSchema } from "./types";

// Ordered SLA rule list, cached in memory (EscalationTierStore pattern) so
// evaluation never hits the DB. Every mutation validates the structured
// conditions with zod, checks the target against the managed registry,
// regenerates the canonical expression text, reloads the cache, and pings
// the (late-bound) change listener so the sweep re-converges open subjects.

export class SlaValidationError extends Error {
  constructor(public errors: ExpressionError[]) {
    super(errors.map((e) => e.message).join("; ") || "invalid SLA rule");
    this.name = "SlaValidationError";
  }
}

export interface SlaRuleInput {
  name: string;
  target: string;
  enabled?: boolean;
  conditions?: SlaCondition[];
  expression?: string;
}

export class SlaRuleStore {
  private rules: SlaRule[] = [];
  private parsed: SlaRuleLike[] = [];
  private dims = new Set<SlaDim>();
  private onChange: (() => void) | null = null;

  constructor(
    private prisma: PrismaClient,
    private settingsStore: SettingsStore,
    private categoryIds: () => Array<{ id: string; label?: string }>
  ) {}

  // Called after every mutation (SlaService.onRulesChanged — late-bound to
  // break the construction cycle).
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  async load(): Promise<void> {
    this.rules = await this.prisma.slaRule.findMany({ orderBy: { position: "asc" } });
    this.parsed = this.rules.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      position: r.position,
      conditions: (r.conditions as SlaCondition[]) ?? [],
      target: r.target,
    }));
    this.dims = new Set<SlaDim>();
    for (const r of this.parsed) {
      if (!r.enabled) continue;
      for (const c of r.conditions) this.dims.add(c.dim);
    }
  }

  list(): SlaRule[] {
    return this.rules;
  }

  // Evaluator-ready snapshot (enabled + disabled — the evaluator skips and
  // traces disabled rules itself).
  snapshot(): SlaRuleLike[] {
    return this.parsed;
  }

  byId(id: string): SlaRule | undefined {
    return this.rules.find((r) => r.id === id);
  }

  count(): number {
    return this.rules.length;
  }

  enabledCount(): number {
    return this.rules.filter((r) => r.enabled).length;
  }

  // Dimensions referenced by ENABLED rules — gates Stripe/Intercom fetches in
  // the facts loader.
  referencedDims(): Set<SlaDim> {
    return this.dims;
  }

  buildParseContext(): ParseContext {
    return {
      categories: this.categoryIds(),
      tags: this.settingsStore.tags().map((t) => ({ id: t.id, label: t.label, emoji: t.emoji })),
    };
  }

  renderExpression(conditions: SlaCondition[]): string {
    return serializeExpression(conditions, this.buildParseContext());
  }

  // ---- mutations ----

  async create(input: SlaRuleInput): Promise<SlaRule> {
    const { conditions, expression } = this.validate(input);
    const created = await this.prisma.slaRule.create({
      data: {
        name: input.name.trim(),
        enabled: input.enabled ?? true,
        position: this.rules.length,
        conditions,
        expression,
        target: input.target,
      },
    });
    await this.reloadAndNotify();
    return created;
  }

  async update(
    id: string,
    patch: { name?: string; target?: string; enabled?: boolean; conditions?: SlaCondition[]; expression?: string }
  ): Promise<SlaRule> {
    const existing = this.byId(id);
    if (!existing) throw new Error("Rule not found — it may have been deleted.");
    const merged: SlaRuleInput = {
      name: patch.name ?? existing.name,
      target: patch.target ?? existing.target,
      enabled: patch.enabled ?? existing.enabled,
      conditions: patch.conditions ?? (patch.expression === undefined ? (existing.conditions as SlaCondition[]) : undefined),
      expression: patch.expression,
    };
    const { conditions, expression } = this.validate(merged);
    const updated = await this.prisma.slaRule.update({
      where: { id },
      data: {
        name: merged.name.trim(),
        target: merged.target,
        enabled: merged.enabled,
        conditions,
        expression,
      },
    });
    await this.reloadAndNotify();
    return updated;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.prisma.slaRule.update({ where: { id }, data: { enabled } });
    await this.reloadAndNotify();
  }

  async remove(id: string): Promise<void> {
    const remaining = this.rules.filter((r) => r.id !== id);
    await this.prisma.$transaction([
      this.prisma.slaRule.delete({ where: { id } }),
      ...remaining.map((r, i) => this.prisma.slaRule.update({ where: { id: r.id }, data: { position: i } })),
    ]);
    await this.reloadAndNotify();
  }

  // Swap with the neighbor (dir -1 = up/higher priority, +1 = down).
  async move(id: string, dir: -1 | 1): Promise<void> {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const other = idx + dir;
    if (other < 0 || other >= this.rules.length) return;
    const order = [...this.rules];
    [order[idx], order[other]] = [order[other], order[idx]];
    await this.prisma.$transaction(
      order.map((r, i) => this.prisma.slaRule.update({ where: { id: r.id }, data: { position: i } }))
    );
    await this.reloadAndNotify();
  }

  // Is a target value referenced by any rule (registry-removal guard)?
  targetInUse(value: string): boolean {
    return this.rules.some((r) => r.target === value);
  }

  // ---- internals ----

  private validate(input: SlaRuleInput): { conditions: SlaCondition[]; expression: string } {
    if (!input.name?.trim()) {
      throw new SlaValidationError([{ pos: 0, len: 0, message: "rule name is required" }]);
    }
    if (!this.settingsStore.slaTargetExists(input.target)) {
      throw new SlaValidationError([
        {
          pos: 0,
          len: 0,
          message: `unknown SLA target "${input.target}"`,
          hint: "add it in SLA Manager → Targets first (and give it a Workflow branch in Intercom)",
        },
      ]);
    }
    const ctx = this.buildParseContext();
    let conditions: SlaCondition[];
    if (input.expression !== undefined) {
      const parsed = parseExpression(input.expression, ctx);
      if (!parsed.ok) throw new SlaValidationError(parsed.errors);
      conditions = parsed.conditions;
    } else if (input.conditions) {
      conditions = input.conditions;
    } else {
      throw new SlaValidationError([{ pos: 0, len: 0, message: "a rule needs at least one condition" }]);
    }
    const checked = slaConditionsSchema.safeParse(conditions);
    if (!checked.success) {
      throw new SlaValidationError(
        checked.error.issues.map((i) => ({ pos: 0, len: 0, message: `${i.path.join(".")}: ${i.message}` }))
      );
    }
    return { conditions: checked.data, expression: serializeExpression(checked.data, ctx) };
  }

  private async reloadAndNotify(): Promise<void> {
    await this.load();
    try {
      this.onChange?.();
    } catch {
      // convergence ping is best-effort; the periodic sweep covers it
    }
  }
}
