import {
  MAX_REGEX_INPUT_LENGTH,
  SlaCondition,
  SlaConditionTrace,
  SlaEvaluation,
  SlaFacts,
  SlaRuleLike,
  SlaRuleTrace,
} from "./types";

// Pure rule evaluation: first ENABLED rule (position order) whose conditions
// ALL pass wins. Missing data = condition FALSE, uniformly — including negated
// ops (a `status!=x` cannot pass on a subject with no status at all). The
// per-condition trace feeds the /intercom Preview Match panel.

const ci = (s: string) => s.toLowerCase();

function safeRegexTest(pattern: string, input: string): boolean {
  try {
    return new RegExp(pattern, "i").test(input.slice(0, MAX_REGEX_INPUT_LENGTH));
  } catch {
    return false; // validated at save time; a broken persisted pattern just never matches
  }
}

function pass(reason: string): { pass: boolean; reason: string } {
  return { pass: true, reason };
}
function fail(reason: string): { pass: boolean; reason: string } {
  return { pass: false, reason };
}

function evaluateCondition(cond: SlaCondition, facts: SlaFacts): { pass: boolean; reason: string } {
  switch (cond.dim) {
    case "category": {
      if (facts.categoryId == null) return fail("no category (native conversation?)");
      const eq = ci(facts.categoryId) === ci(cond.value);
      return (cond.op === "eq") === eq ? pass(`category is ${facts.categoryId}`) : fail(`category is ${facts.categoryId}`);
    }
    case "status": {
      if (facts.statusTagId == null) return fail("no status tag");
      const eq = facts.statusTagId === cond.tagId;
      return (cond.op === "eq") === eq ? pass("status matches") : fail("status differs");
    }
    case "tier": {
      if (facts.tierId == null) return fail("no escalation tier");
      const eq = facts.tierId === cond.tierId;
      return (cond.op === "eq") === eq ? pass("tier matches") : fail("tier differs");
    }
    case "open":
      if (facts.open == null) return fail("open/closed unknown");
      return facts.open === cond.value ? pass(`ticket is ${facts.open ? "open" : "closed"}`) : fail(`ticket is ${facts.open ? "open" : "closed"}`);
    case "exempt":
      if (facts.exempt == null) return fail("exempt state unknown");
      return facts.exempt === cond.value ? pass(`exempt=${facts.exempt}`) : fail(`exempt=${facts.exempt}`);
    case "mirrored":
      if (facts.mirrored == null) return fail("mirror state unknown");
      return facts.mirrored === cond.value ? pass(`mirrored=${facts.mirrored}`) : fail(`mirrored=${facts.mirrored}`);
    case "stripe.linked": {
      const linked = facts.stripe?.linked;
      if (linked == null) return fail("no Stripe data for this subject");
      return linked === cond.value ? pass(`stripe.linked=${linked}`) : fail(`stripe.linked=${linked}`);
    }
    case "stripe.paying":
    case "stripe.dispute":
    case "stripe.refund_review": {
      const s = facts.stripe;
      if (!s || s.unavailable) return fail(s?.unavailable ? "Stripe data unavailable (fetch failed)" : "no Stripe data");
      const actual =
        cond.dim === "stripe.paying" ? s.paying : cond.dim === "stripe.dispute" ? s.openDispute : s.refundReview;
      if (actual == null) return fail("no Stripe data for this field");
      return actual === cond.value ? pass(`${cond.dim}=${actual}`) : fail(`${cond.dim}=${actual}`);
    }
    case "stripe.plan": {
      const keys = facts.stripe && !facts.stripe.unavailable ? facts.stripe.planKeys : undefined;
      if (keys == null) return fail("no plan data");
      if (cond.op === "matches") {
        const hit = keys.some((k) => safeRegexTest(cond.value, k));
        return hit ? pass("a plan key matches") : fail(`no plan key matches (${keys.length} keys)`);
      }
      const has = keys.some((k) => ci(k) === ci(cond.value));
      return (cond.op === "eq") === has ? pass(has ? "plan present" : "plan absent") : fail(has ? "plan present" : "plan absent");
    }
    case "stripe.spend": {
      const spend = facts.stripe && !facts.stripe.unavailable ? facts.stripe.spendMajor : undefined;
      if (spend == null) return fail("no spend data");
      const ok =
        cond.op === "gt" ? spend > cond.value : cond.op === "gte" ? spend >= cond.value : cond.op === "lt" ? spend < cond.value : spend <= cond.value;
      return ok ? pass(`spend=${spend}`) : fail(`spend=${spend}`);
    }
    case "intercom.team": {
      const ic = facts.intercom;
      const id = ic?.teamId ?? null;
      const name = ic?.teamName ?? null;
      if (id == null && name == null) return fail("no team assigned");
      const eq = (id != null && id === cond.value) || (name != null && ci(name) === ci(cond.value));
      return (cond.op === "eq") === eq ? pass(`team=${name ?? id}`) : fail(`team=${name ?? id}`);
    }
    case "intercom.kind": {
      const kind = facts.intercom?.kind;
      if (kind == null) return fail("conversation/ticket kind unknown");
      return kind === cond.value ? pass(`kind=${kind}`) : fail(`kind=${kind}`);
    }
    case "intercom.ticket_type": {
      const t = facts.intercom?.ticketTypeId;
      if (t == null) return fail("no ticket type");
      const eq = t === cond.value;
      return (cond.op === "eq") === eq ? pass(`ticket_type=${t}`) : fail(`ticket_type=${t}`);
    }
    case "intercom.tag": {
      const tags = facts.intercom?.tags;
      if (tags == null) return fail("no Intercom tag data");
      const has = tags.some((t) => ci(t) === ci(cond.value));
      return (cond.op === "has") === has ? pass(has ? "tag present" : "tag absent") : fail(has ? "tag present" : "tag absent");
    }
    case "keyword": {
      if (facts.text == null || facts.text === "") return fail("no text to match");
      const hit = safeRegexTest(cond.value, facts.text);
      return (cond.op === "matches") === hit ? pass(hit ? "keyword found" : "keyword absent") : fail(hit ? "keyword found" : "keyword absent");
    }
  }
}

export function evaluateRules(rules: SlaRuleLike[], facts: SlaFacts): SlaEvaluation {
  const ordered = [...rules].sort((a, b) => a.position - b.position);
  const trace: SlaRuleTrace[] = [];
  let winner: SlaEvaluation["winner"] = null;

  for (const rule of ordered) {
    if (!rule.enabled) {
      trace.push({ ruleId: rule.id, name: rule.name, target: rule.target, matched: false, skipped: "disabled", conditions: [] });
      continue;
    }
    const conditions: SlaConditionTrace[] = [];
    let matched = true;
    for (const cond of rule.conditions) {
      const res = evaluateCondition(cond, facts);
      conditions.push({ condition: cond, ...res });
      if (!res.pass) matched = false;
      // Keep evaluating remaining conditions for a complete preview trace only
      // while the winner is still undecided; after a winner exists we still
      // record the rule but can stop at the first failure.
      if (!res.pass && winner) break;
    }
    trace.push({ ruleId: rule.id, name: rule.name, target: rule.target, matched, conditions });
    if (matched && !winner) {
      winner = { ruleId: rule.id, name: rule.name, target: rule.target };
    }
  }

  return { winner, trace };
}
