import { SlaRuleStore } from "../../sla/SlaRuleStore";
import { SlaTargetEntry, SLA_TARGET_VALUE_RE } from "../../sla/types";
import { ActionButton, ActionResult, Opt, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asBoundedInt, asString } from "./types";

// SLA Manager hub (intercom group): engine toggle + warn% + default target,
// the Targets registry (value + business-minute clocks), and the Rules list
// (first-match-wins, edited as free-text expressions). Mirrors /intercom → SLA
// for its core; the multi-step guided builder and per-team office hours remain
// a follow-up (rules are fully manageable here via the expression escape hatch).

export function makeSlaHub(deps: { ruleStore: SlaRuleStore }): HubModule {
  const rs = deps.ruleStore;

  function targetOpts(targets: SlaTargetEntry[]): Opt[] {
    return targets.map((t) => ({ value: t.value, label: t.note ? `${t.value} — ${t.note}` : t.value }));
  }
  function numOrU(v: unknown): number | undefined {
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  function targetInputs(t?: SlaTargetEntry): ActionButton["inputs"] {
    return [
      { type: "text", key: "value", label: "Value (matches the Intercom option)", value: t?.value ?? "" },
      { type: "text", key: "note", label: "Note", value: t?.note ?? "" },
      { type: "number", key: "firstReplyMins", label: "First-reply clock (business mins)", value: t?.firstReplyMins ?? null, nullable: true, min: 0 },
      { type: "number", key: "nextReplyMins", label: "Next-reply clock (business mins)", value: t?.nextReplyMins ?? null, nullable: true, min: 0 },
      { type: "number", key: "resolveMins", label: "Resolution clock (business mins)", value: t?.resolveMins ?? null, nullable: true, min: 0 },
      { type: "number", key: "warnPct", label: "At-risk % (blank = default)", value: t?.warnPct ?? null, nullable: true, min: 1, max: 99 },
    ];
  }

  return {
    hub: "sla",
    group: "intercom",
    title: "SLA Manager",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      const targets = s.slaTargets();
      const tOpts = targetOpts(targets);

      const engine: Section = {
        key: "engine",
        title: "SLA engine",
        fields: [
          { type: "toggle", key: "slaEnabled", label: "Enabled", value: s.slaEnabled() },
          { type: "number", key: "slaWarnPct", label: "At-risk threshold %", value: s.slaWarnPct(), min: 1, max: 99, unit: "%" },
          { type: "select", key: "slaDefaultTarget", label: "Default target (no rule matches)", value: s.slaDefaultTarget(), options: tOpts, nullable: true },
        ],
      };

      const targetsSection: Section = {
        key: "targets",
        title: "Targets",
        fields: [
          {
            type: "list",
            key: "targets",
            label: "SLA targets",
            columns: ["Value", "Note", "Clocks"],
            rows: targets.map((t) => ({
              id: t.value,
              cells: [
                t.value,
                t.note || "—",
                [t.firstReplyMins != null ? `first ${t.firstReplyMins}` : null, t.nextReplyMins != null ? `next ${t.nextReplyMins}` : null, t.resolveMins != null ? `resolve ${t.resolveMins}` : null].filter(Boolean).join(", ") || "—",
              ],
              rowActions: [
                { key: "target_edit", label: "Edit", params: { id: t.value }, inputs: targetInputs(t) },
                { key: "target_del", label: "Delete", params: { id: t.value }, dangerous: true, summary: `Delete target ${t.value}?` },
              ],
            })),
            addAction: { key: "target_add", label: "Add target", inputs: targetInputs() },
          },
        ],
      };

      const rulesSection: Section = {
        key: "rules",
        title: "Rules (first match wins)",
        fields: [
          {
            type: "list",
            key: "rules",
            label: "SLA rules",
            columns: ["Name", "Target", "Enabled", "Expression"],
            reorderable: true,
            rows: rs.list().map((r) => {
              const expr = r.expression || rs.renderExpression((r.conditions as never) ?? []);
              const ruleInputs: ActionButton["inputs"] = [
                { type: "text", key: "name", label: "Name", value: r.name },
                { type: "select", key: "target", label: "Target", value: r.target, options: tOpts },
                { type: "toggle", key: "enabled", label: "Enabled", value: r.enabled },
                { type: "text", key: "expression", label: "Expression", value: expr, multiline: true, placeholder: 'category=billing AND stripe.paying=true' },
              ];
              return {
                id: r.id,
                cells: [r.name, r.target, r.enabled ? { kind: "ok" as const, text: "on" } : { kind: "warn" as const, text: "off" }, expr || "—"],
                rowActions: [
                  { key: "rule_edit", label: "Edit", params: { id: r.id }, inputs: ruleInputs },
                  { key: r.enabled ? "rule_disable" : "rule_enable", label: r.enabled ? "Disable" : "Enable", params: { id: r.id } },
                  { key: "rule_up", label: "↑", params: { id: r.id } },
                  { key: "rule_down", label: "↓", params: { id: r.id } },
                  { key: "rule_del", label: "Delete", params: { id: r.id }, dangerous: true, summary: `Delete rule "${r.name}"?` },
                ] as ActionButton[],
              };
            }),
            addAction: {
              key: "rule_add",
              label: "Add rule",
              inputs: [
                { type: "text", key: "name", label: "Name", value: "" },
                { type: "select", key: "target", label: "Target", value: null, options: tOpts },
                { type: "text", key: "expression", label: "Expression", value: "", multiline: true, placeholder: 'category=billing AND keyword~"refund"' },
              ],
            },
          },
        ],
      };

      return [engine, targetsSection, rulesSection];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      switch (req.field) {
        case "slaEnabled":
          await s.updateSla({ slaEnabled: v === true });
          await ctx.audit(`sla engine → ${v === true}`);
          return { ok: true };
        case "slaWarnPct": {
          const parsed = asBoundedInt(v, 1, 99);
          if (!parsed.ok) return { ok: false, fieldErrors: { slaWarnPct: parsed.error } };
          await s.updateSla({ slaWarnPct: parsed.value });
          await ctx.audit(`sla warn% → ${parsed.value}`);
          return { ok: true };
        }
        case "slaDefaultTarget":
          await s.updateSla({ slaDefaultTarget: asString(v) || null });
          await ctx.audit("set sla default target");
          return { ok: true };
        default:
          return { ok: false, error: "Use the row actions." };
      }
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      const s = ctx.settings;
      const p = req.params ?? {};
      const id = asString(p.id);
      try {
        switch (req.key) {
          case "target_add":
          case "target_edit": {
            const value = asString(p.value).trim();
            if (!SLA_TARGET_VALUE_RE.test(value)) return { ok: false, error: "Value must be 1–60 chars of A–Z, 0–9, - or _." };
            const entry: SlaTargetEntry = {
              value,
              note: asString(p.note).trim(),
              firstReplyMins: numOrU(p.firstReplyMins),
              nextReplyMins: numOrU(p.nextReplyMins),
              resolveMins: numOrU(p.resolveMins),
              warnPct: numOrU(p.warnPct),
            };
            const targets = s.slaTargets().slice();
            if (req.key === "target_add") {
              if (targets.some((t) => t.value === value)) return { ok: false, error: "That target value already exists." };
              targets.push(entry);
            } else {
              const idx = targets.findIndex((t) => t.value === id);
              if (idx < 0) return { ok: false, error: "Target not found." };
              targets[idx] = entry;
            }
            await s.updateSlaTargets(targets);
            await ctx.audit(`${req.key === "target_add" ? "add" : "edit"} sla target ${value}`);
            return { ok: true, text: "Saved." };
          }
          case "target_del": {
            if (rs.targetInUse(id)) return { ok: false, error: "That target is used by a rule — reassign it first." };
            if (s.slaDefaultTarget() === id) return { ok: false, error: "That target is the default — change the default first." };
            await s.updateSlaTargets(s.slaTargets().filter((t) => t.value !== id));
            await ctx.audit(`delete sla target ${id}`);
            return { ok: true, text: "Deleted." };
          }
          case "rule_add":
            await rs.create({ name: asString(p.name), target: asString(p.target), expression: asString(p.expression), enabled: true });
            await ctx.audit("add sla rule");
            return { ok: true, text: "Rule created." };
          case "rule_edit":
            await rs.update(id, { name: asString(p.name), target: asString(p.target), enabled: p.enabled === true, expression: asString(p.expression) });
            await ctx.audit(`edit sla rule ${id}`);
            return { ok: true, text: "Rule updated." };
          case "rule_enable":
          case "rule_disable":
            await rs.setEnabled(id, req.key === "rule_enable");
            return { ok: true, text: "Saved." };
          case "rule_up":
          case "rule_down":
            await rs.move(id, req.key === "rule_up" ? -1 : 1);
            return { ok: true, text: "Reordered." };
          case "rule_del":
            await rs.remove(id);
            await ctx.audit(`delete sla rule ${id}`);
            return { ok: true, text: "Deleted." };
          default:
            return { ok: false, error: "Unknown action." };
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Action failed." };
      }
    },
  };
}
