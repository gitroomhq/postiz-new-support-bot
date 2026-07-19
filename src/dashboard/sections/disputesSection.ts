import type Stripe from "stripe";
import type { StripeDispute } from "../../generated/prisma/client";
import { CachedRatioEngine, RatioWindowNumbers } from "../../bot/billing/disputeRatio";
import { RESPONDABLE_DISPUTE_STATUSES } from "../../bot/billing/DisputeStore";
import {
  DisputeEvidenceService,
  EVIDENCE_FILE_SLOTS,
  EVIDENCE_GROUPS,
  EVIDENCE_KEY_SET,
  PROOF_MAX_BYTES,
  PROOF_TYPES,
  recommendedGroupKeys,
  type StagedPackage,
} from "../../bot/billing/DisputeEvidenceService";
import { exportBillingEvent } from "../../metrics/MetricsExporter";
import type { ActionActor } from "../../bot/billing/actions/BillingActionService";
import { ActionButton, Badge, Block, Cell, EvidenceBlock, TableBlock } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validId } from "./types";
import { amount, badgeCell, idCell, isoDateCell, sentence, strong, text } from "./cells";

// Disputes: the overview (ratio strip, due-date board, All list,
// History & stats); the detail page is the evidence WORKBENCH —
// the interactive editor widget (draft autosave / stage / proof files), the
// staged-evidence review subpage and every action: submit (typed CONFIRM +
// Discord reverse code), accept-as-lost (same ceremony), refund-to-prevent
// (registry, via the gateway), watch, notes and bookmarks. All evidence
// mutations run through the shared DisputeEvidenceService — the exact code
// behind /billing → Disputes — so both surfaces stay in lockstep.

const PAGE_SIZE = 25;
const BOARD_WINDOW = 50;

const DUE_URGENT_HOURS = 24;
const DUE_WARN_HOURS = 72;

interface DisputesDeps {
  ratio: CachedRatioEngine;
  evidence: DisputeEvidenceService;
}

// AI runs are long (CLI draft ≤5min, light review ≤2min) and cost money — one
// in-flight run per dispute, section-wide (double-click / second tab guard).
const aiLocks = new Set<string>();
// Last AI review per dispute so the verdict survives the page reload the
// action triggers. Memory-only, advisory content — small cap + TTL.
const aiReviews = new Map<string, { review: string; model: string; coverage: string; at: number }>();
const AI_REVIEW_TTL_MS = 30 * 60_000;
const AI_REVIEW_CAP = 24;

function rememberAiReview(disputeId: string, entry: { review: string; model: string; coverage: string }): void {
  aiReviews.set(disputeId, { ...entry, at: Date.now() });
  if (aiReviews.size > AI_REVIEW_CAP) {
    const oldest = [...aiReviews.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) aiReviews.delete(oldest[0]);
  }
}

function freshAiReview(disputeId: string): { review: string; model: string; coverage: string; at: number } | null {
  const entry = aiReviews.get(disputeId);
  if (!entry) return null;
  if (Date.now() - entry.at > AI_REVIEW_TTL_MS) {
    aiReviews.delete(disputeId);
    return null;
  }
  return entry;
}

export function makeDisputesSection(deps: DisputesDeps): DashboardSectionModule {
  return {
    nav: [{ key: "disputes", label: "Disputes", page: "disputes" }],

    ownsPage(page: string): boolean {
      return page === "disputes" || page === "disputes.detail" || page === "disputes.review";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "disputes") return list(ctx, deps, req.filters ?? {}, req.cursor ?? null);
      const id = validId("dispute", req.params?.id);
      if (!id) return notFound("That dispute id is not valid (dp_/du_…).");
      if (req.page === "disputes.review") return review(ctx, deps, id);
      return detail(ctx, deps, id);
    },

    async action(ctx: DashboardCtx, req) {
      return disputeAction(ctx, deps, req.key, req.params ?? {}, req.confirmWord);
    },

    async navBadge(ctx: DashboardCtx): Promise<string | null> {
      const counts = await ctx.stores.dispute.countsByStatus().catch(() => []);
      const needing = counts
        .filter((c) => (RESPONDABLE_DISPUTE_STATUSES as readonly string[]).includes(c.status))
        .reduce((sum, c) => sum + c.count, 0);
      return needing > 0 ? String(needing) : null;
    },
  };
}

function actionActor(ctx: DashboardCtx): ActionActor {
  return { kind: "dashboard", id: ctx.actor.id, name: ctx.actor.name, isAdmin: ctx.actor.isAdmin };
}

// Advisory render mode for a registry button: queue notice or disabled state.
// Execution re-checks server-side regardless.
function registryButton(ctx: DashboardCtx, button: ActionButton): ActionButton {
  const mode = ctx.billing.actions.effectiveMode(button.key, actionActor(ctx));
  if (mode === "denied") {
    return { ...button, disabledReason: "Disabled by /config → Billing → Intercom Actions." };
  }
  return { ...button, mode: mode === "queue" ? "queue" : "direct" };
}

// ---- section actions (the workbench verbs) ----

async function disputeAction(
  ctx: DashboardCtx,
  deps: DisputesDeps,
  key: string,
  p: Record<string, unknown>,
  confirmWord: string | undefined
): Promise<{ ok: boolean; text?: string; error?: string; fieldErrors?: Record<string, string>; needsReverse?: boolean }> {
  const disputeId = validId("dispute", p.disputeId);
  if (!disputeId) return { ok: false, error: "Bad dispute id." };
  const confirmed = confirmWord === "CONFIRM";

  switch (key) {
    // T0 — autosave one field into the LOCAL draft (empty never wipes).
    case "section:disputes.draft_save": {
      const fieldKey = str(p.key, 64);
      const value = str(p.value, 4000);
      if (!EVIDENCE_KEY_SET.has(fieldKey)) return { ok: false, error: "Unknown evidence field." };
      const { saved } = await deps.evidence.saveDraft(disputeId, { [fieldKey]: value });
      if (!saved) return { ok: false, error: "Nothing to save — the field was empty." };
      return { ok: true, text: "Draft saved." };
    }

    // T1 — stage one group's saved draft fields at Stripe (submit:false).
    case "section:disputes.stage_group": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const groupKey = str(p.group, 20);
      const group = EVIDENCE_GROUPS.find((g) => g.key === groupKey);
      if (!group) return { ok: false, error: "Unknown evidence group." };
      const live = await ctx.stripe.getDispute(disputeId);
      if (!deps.evidence.respondable(live.status)) {
        return { ok: false, error: `Status is ${live.status} — evidence can no longer be changed.` };
      }
      const row = await ctx.stores.dispute.get(disputeId);
      const draft = (row?.evidenceDraft ?? {}) as Record<string, string>;
      const evidence: Record<string, string> = {};
      for (const field of group.fields) {
        const value = draft[field.key]?.trim();
        if (value) evidence[field.key] = value;
      }
      if (Object.keys(evidence).length === 0) {
        return { ok: false, error: "Nothing drafted in this group yet — fill fields first (they autosave)." };
      }
      await deps.evidence.stageFields(disputeId, evidence, `dash-${Date.now().toString(36)}`);
      await ctx.audit(`Dispute evidence staged on ${disputeId} — ${Object.keys(evidence).length} field(s) from ${group.label} (NOT submitted)`);
      return { ok: true, text: `Staged ${Object.keys(evidence).length} field(s) at Stripe (not submitted).` };
    }

    // T1 — upload a proof (base64 JSON body) and stage it into a slot.
    case "section:disputes.file_upload": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const slot = str(p.slot, 40);
      const filename = str(p.filename, 200).replace(/[/\\]/g, "_") || "proof";
      const contentType = str(p.contentType, 60);
      const dataB64 = typeof p.dataB64 === "string" ? p.dataB64 : "";
      // ~5.6MB of base64 covers the 4MB proof cap; anything bigger is hostile.
      if (!dataB64 || dataB64.length > 6_000_000) return { ok: false, error: "Bad or oversized file payload." };
      let data: Buffer;
      try {
        data = Buffer.from(dataB64, "base64");
      } catch {
        return { ok: false, error: "Bad file payload." };
      }
      const outcome = await deps.evidence.uploadProof(disputeId, slot, filename, data, contentType, `dash-${Date.now().toString(36)}`);
      if (outcome.kind === "not_respondable") {
        return { ok: false, error: `Status is ${outcome.status} — evidence files can no longer be attached.` };
      }
      if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
      await ctx.audit(`Dispute evidence file staged on ${disputeId} — ${outcome.file!.id} (${filename}) as ${slot} (NOT submitted)`);
      return { ok: true, text: `${filename} staged as ${slot} — it reaches the bank when you submit evidence.` };
    }

    // T1 — detach a staged file (stays in the Stripe account).
    case "section:disputes.file_remove": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      const slot = str(p.slot, 40);
      const outcome = await deps.evidence.removeFile(disputeId, slot, `dash-${Date.now().toString(36)}`);
      if (outcome.kind === "not_respondable") {
        return { ok: false, error: `Status is ${outcome.status} — evidence can no longer be changed.` };
      }
      if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
      await ctx.audit(`Dispute evidence file removed on ${disputeId} — cleared slot ${slot} (staged only)`);
      return { ok: true, text: `File slot ${slot} cleared.` };
    }

    // T1 + T3 — submit the staged evidence to the bank. Irreversible; the
    // cross-surface claim in the service keeps it single-shot.
    case "section:disputes.submit": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true };
      const outcome = await deps.evidence.submit(disputeId, ctx.actor.id, await customerHint(ctx, disputeId));
      if (outcome.kind === "not_respondable") {
        return { ok: false, error: `Status is ${outcome.status} — evidence can no longer be submitted.` };
      }
      if (outcome.kind === "already_claimed") {
        return { ok: false, error: "Evidence for this dispute was already submitted via the bot." };
      }
      const d = outcome.dispute;
      await ctx.audit(`Dispute evidence SUBMITTED on ${disputeId} (${ctx.stripe.formatAmount(d.amount, d.currency)}) — status now ${d.status}`);
      exportBillingEvent({
        event: "evidence_submitted",
        amountMinor: d.amount,
        currency: d.currency,
        chargeId: typeof d.charge === "string" ? d.charge : d.charge?.id,
      });
      return { ok: true, text: "Evidence submitted to the bank." };
    }

    // T1 + T3 — accept the dispute (closes as LOST, irreversible).
    case "section:disputes.accept": {
      if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
      if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true };
      const live = await ctx.stripe.getDispute(disputeId);
      if (deps.evidence.terminal(live.status)) {
        return { ok: false, error: `Dispute is already ${live.status}.` };
      }
      const outcome = await deps.evidence.accept(disputeId, ctx.actor.id, await customerHint(ctx, disputeId));
      if (outcome.kind === "already_claimed") {
        return { ok: false, error: "This dispute was already accepted via the bot." };
      }
      const d = outcome.dispute;
      await ctx.audit(`Dispute ACCEPTED on ${disputeId} (${ctx.stripe.formatAmount(d.amount, d.currency)}) — closed as ${d.status} (conceded)`);
      exportBillingEvent({
        event: "dispute_accepted",
        amountMinor: d.amount,
        currency: d.currency,
        chargeId: typeof d.charge === "string" ? d.charge : d.charge?.id,
      });
      return { ok: true, text: "Dispute accepted — closed as lost." };
    }

    // T0 long-running — AI draft (Claude Code CLI over the cloned repos).
    // Merges into the LOCAL draft only; deterministic fields + shape
    // validators live in the service (shared with /billing).
    case "section:disputes.ai_draft": {
      const live = await ctx.stripe.getDispute(disputeId);
      if (!deps.evidence.respondable(live.status)) {
        return { ok: false, error: `Status is ${live.status} — there is nothing left to draft for.` };
      }
      if (aiLocks.has(disputeId)) return { ok: false, error: "An AI run is already in progress for this dispute — hang on." };
      aiLocks.add(disputeId);
      try {
        const result = await deps.evidence.aiDraft(disputeId, await customerHint(ctx, disputeId));
        await ctx.audit(
          `Dispute AI evidence draft on ${disputeId} — ${result.fields} field(s) saved locally${
            result.rejected.length ? `, ${result.rejected.length} invalid dropped (${result.rejected.join(", ")})` : ""
          }${result.usedIntercomHistory ? ", with Intercom history" : ""}${result.receiptStaged ? ", receipt staged" : ""} (${result.model})`
        );
        return {
          ok: true,
          text: `AI draft saved locally — ${result.fields} field(s) on ${result.model}${
            result.rejected.length ? ` (${result.rejected.length} invalid value(s) dropped: ${result.rejected.join(", ")})` : ""
          }${result.receiptStaged ? " · receipt PDF staged" : ""}. Review the sections below, then stage.`,
        };
      } finally {
        aiLocks.delete(disputeId);
      }
    }

    // T0 long-running — AI review of the staged package (light model, vision
    // over the staged files). Read-only; verdict renders on the page.
    case "section:disputes.ai_review": {
      if (aiLocks.has(disputeId)) return { ok: false, error: "An AI run is already in progress for this dispute — hang on." };
      aiLocks.add(disputeId);
      try {
        const result = await deps.evidence.aiReview(disputeId, {
          telemetry: { userId: ctx.actor.id, username: ctx.actor.name },
        });
        if (result.kind === "nothing_staged") {
          return { ok: false, error: "Nothing staged at Stripe yet — there is nothing to review." };
        }
        const coverage = `${result.stagedFieldCount} field(s) · ${result.filesAttached}/${result.filesTotal} file(s) reviewed${
          result.skipped.length ? ` · skipped: ${result.skipped.map((f) => `${f.slot} (${f.note})`).join(", ")}` : ""
        }`;
        rememberAiReview(disputeId, {
          review: result.review || "The model returned no review text — try again.",
          model: result.model,
          coverage,
        });
        await ctx.audit(`Dispute AI evidence review on ${disputeId} — ${coverage} (${result.model}, read-only)`);
        return { ok: true, text: "AI review complete — the verdict is rendered on the page." };
      } finally {
        aiLocks.delete(disputeId);
      }
    }

    // T0 — DM-on-status-change subscription (actor ids ARE Discord ids).
    case "section:disputes.watch": {
      const watching = await ctx.stores.dispute.isWatching(disputeId, ctx.actor.id);
      if (watching) await ctx.stores.dispute.unwatch(disputeId, ctx.actor.id);
      else await ctx.stores.dispute.watch(disputeId, ctx.actor.id);
      return { ok: true, text: watching ? "Unwatched — no more DMs for this dispute." : "Watching — you'll get a DM when its status changes." };
    }

    case "section:disputes.note_add": {
      const body = str(p.text, 1000);
      if (!body) return { ok: false, fieldErrors: { text: "Write something first." } };
      await ctx.stores.qol.addNote("dispute", disputeId, ctx.actor.id, ctx.actor.name, body);
      await ctx.audit(`Note added on ${disputeId}`);
      return { ok: true, text: "Note added." };
    }

    case "section:disputes.bookmark": {
      const row = await ctx.stores.dispute.get(disputeId);
      const label = row ? `${ctx.stripe.formatAmount(row.amount, row.currency)} · ${row.reason}` : null;
      const r = await ctx.stores.qol.toggleBookmark("dispute", disputeId, label, ctx.actor.id, ctx.actor.name);
      return { ok: true, text: r.bookmarked ? "Bookmarked for the team." : "Bookmark removed." };
    }

    default:
      return { ok: false, error: "Unknown action." };
  }
}

// customerId for the mirror upsert after submit/accept — mirror first, charge
// lookup as fallback (same derivation the hub session carries around).
async function customerHint(ctx: DashboardCtx, disputeId: string): Promise<string | null> {
  const row = await ctx.stores.dispute.get(disputeId).catch(() => null);
  return row?.customerId ?? null;
}

// ---- LIST (tabs: Needs response / All / History & stats) ----

async function list(
  ctx: DashboardCtx,
  deps: DisputesDeps,
  filters: Record<string, string>,
  cursor: string | null
): Promise<SectionPage> {
  const view = filters.view === "all" || filters.view === "history" ? filters.view : "";
  const counts = await ctx.stores.dispute.countsByStatus().catch(() => []);
  const needingCount = counts
    .filter((c) => (RESPONDABLE_DISPUTE_STATUSES as readonly string[]).includes(c.status))
    .reduce((sum, c) => sum + c.count, 0);

  const blocks: Block[] = [];
  blocks.push({
    type: "tabs",
    key: "view",
    value: view || undefined,
    items: [
      { value: "", label: "Needs response", ...(needingCount ? { badge: String(needingCount) } : {}) },
      { value: "all", label: "All disputes" },
      { value: "history", label: "History & stats" },
    ],
  });

  // Ratio strip — plain + VAMP over the three windows, level-tinted.
  blocks.push(await ratioStrip(ctx, deps.ratio));

  if (view === "history") blocks.push(...(await historyBlocks(ctx, cursor)));
  else if (view === "all") blocks.push(...(await allBlocks(ctx, filters, cursor, counts)));
  else blocks.push(await boardBlock(ctx));

  return { title: "Disputes", crumbs: [{ label: "Disputes" }], blocks };
}

async function ratioStrip(ctx: DashboardCtx, ratio: CachedRatioEngine): Promise<Block> {
  const warnPct = ctx.settings.disputeRatioWarnPct();
  const criticalPct = ctx.settings.disputeRatioCriticalPct();
  const level = (pct: number | null): Badge | undefined => {
    if (pct == null) return undefined;
    if (pct >= criticalPct) return { kind: "error", text: "critical" };
    if (pct >= warnPct) return { kind: "warn", text: "warn" };
    return { kind: "ok", text: "ok" };
  };
  const fmt = (pct: number | null): string => (pct == null ? "—" : `${pct.toFixed(2)}%`);
  try {
    const r = await ratio.get();
    const ge = r.truncated ? "≥" : "";
    const win = (label: string, w: RatioWindowNumbers) => ({
      label,
      value: fmt(w.plainPct),
      sub: `VAMP ${fmt(w.vampPct)} · ${ge}${w.chargebacks}/${w.succeeded} charges`,
      badge: level(w.plainPct),
    });
    return {
      type: "stats",
      items: [win("This month", r.month), win("Last 30 days", r.d30), win("Last 90 days", r.d90)],
    };
  } catch {
    return {
      type: "stats",
      items: [{ label: "Dispute ratio", value: "—", sub: "ratio engine unavailable right now" }],
    };
  }
}

function dueCells(d: { evidenceDueBy: Date | null }): Cell {
  if (!d.evidenceDueBy) return text("—");
  const hoursLeft = (d.evidenceDueBy.getTime() - Date.now()) / 3_600_000;
  const badge: Badge =
    hoursLeft < 0
      ? { kind: "error", text: "OVERDUE" }
      : hoursLeft <= DUE_URGENT_HOURS
        ? { kind: "error", text: `${Math.max(1, Math.round(hoursLeft))}h left` }
        : hoursLeft <= DUE_WARN_HOURS
          ? { kind: "warn", text: `${Math.round(hoursLeft / 24)}d left` }
          : { kind: "neutral", text: `${Math.round(hoursLeft / 24)}d left` };
  return { t: "flags", badges: [badge] };
}

function statusBadgeFor(status: string): Badge {
  const kind: Badge["kind"] = status.includes("needs_response")
    ? "error"
    : status === "won" || status === "prevented"
      ? "ok"
      : status === "lost"
        ? "error"
        : status.includes("under_review")
          ? "info"
          : "neutral";
  return { kind, text: sentence(status.replace(/_/g, " ")) };
}

function disputeRow(ctx: DashboardCtx, d: StripeDispute): TableBlock["rows"][number] {
  return {
    id: d.id,
    ref: { page: "disputes.detail", params: { id: d.id } },
    cells: [
      amount(ctx.stripe, d.amount, d.currency, statusBadgeFor(d.status)),
      text(sentence(d.reason.replace(/_/g, " "))),
      d.customerId
        ? ({ t: "link", v: d.customerId, ref: { page: "customers.detail", params: { id: d.customerId } } } as Cell)
        : text("—"),
      d.evidenceDueBy ? isoDateCell(d.evidenceDueBy) : text("—"),
      dueCells(d),
      idCell(d.id, { copy: true }),
    ] as Cell[],
  };
}

// Needs-response due-date board: the two respondable statuses, most urgent first.
async function boardBlock(ctx: DashboardCtx): Promise<Block> {
  const open = await ctx.stores.dispute.listOpen(0, BOARD_WINDOW, undefined, "due");
  const rows = open.rows
    .filter((d) => (RESPONDABLE_DISPUTE_STATUSES as readonly string[]).includes(d.status))
    .map((d) => disputeRow(ctx, d));
  return {
    type: "table",
    key: "board",
    title: "Evidence due",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "customer", label: "Customer" },
      { key: "due", label: "Evidence due" },
      { key: "urgency", label: "" },
      { key: "id", label: "ID" },
    ],
    rows,
    empty: "No disputes need a response right now.",
    ...(rows.length ? { footer: `${rows.length} item${rows.length === 1 ? "" : "s"}` } : {}),
    notice: "Sorted by evidence deadline. Open a dispute to work its evidence in the workbench.",
  };
}

// All disputes: status count-cards + reason/sort pills over the full mirror.
async function allBlocks(
  ctx: DashboardCtx,
  filters: Record<string, string>,
  cursor: string | null,
  counts: Array<{ status: string; count: number }>
): Promise<Block[]> {
  const status = /^[a-z_]{1,32}$/.test(filters.status ?? "") ? filters.status : "";
  const reason = /^[a-z_.]{1,40}$/.test(filters.reason ?? "") ? filters.reason : "";
  const sort = filters.sort === "due" || filters.sort === "amount" ? filters.sort : "new";
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;

  const [page, openReasons, closedReasons] = await Promise.all([
    ctx.stores.dispute.listMirror(offset, PAGE_SIZE, { status: status || undefined, reason: reason || undefined }, sort),
    ctx.stores.dispute.openReasons().catch(() => []),
    ctx.stores.dispute.closedReasons().catch(() => []),
  ]);
  const reasons = [...new Set([...openReasons, ...closedReasons].map((r) => r.reason))].sort();
  const total = counts.reduce((sum, c) => sum + c.count, 0);

  const table: TableBlock = {
    type: "table",
    key: "all",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "customer", label: "Customer" },
      { key: "due", label: "Evidence due" },
      { key: "urgency", label: "" },
      { key: "id", label: "ID" },
    ],
    counts: {
      key: "status",
      items: [
        { value: "", label: "All", count: total },
        ...counts
          .sort((a, b) => b.count - a.count)
          .slice(0, 6)
          .map((c) => ({ value: c.status, label: sentence(c.status.replace(/_/g, " ")), count: c.count })),
      ],
    },
    filters: [
      {
        key: "reason",
        label: "Reason",
        kind: "select",
        value: reason || undefined,
        options: reasons.map((r) => ({ value: r, label: sentence(r.replace(/_/g, " ")) })),
      },
      {
        key: "sort",
        label: "Sort",
        kind: "select",
        value: sort === "new" ? undefined : sort,
        options: [
          { value: "due", label: "Evidence deadline" },
          { value: "amount", label: "Amount" },
        ],
      },
    ],
    rows: page.rows.map((d) => disputeRow(ctx, d)),
    nextCursor: offset + PAGE_SIZE < page.total ? String(offset + PAGE_SIZE) : null,
    empty: status || reason ? "No disputes match these filters." : "No disputes mirrored yet.",
    ...(page.rows.length
      ? { footer: `${page.rows.length} of ${page.total} item${page.total === 1 ? "" : "s"}` }
      : {}),
    notice: "Local mirror kept fresh by the dispute monitor and Stripe webhooks.",
  };
  return [table];
}

// History & stats: outcome tiles + win-rate by reason + closed list.
async function historyBlocks(ctx: DashboardCtx, cursor: string | null): Promise<Block[]> {
  const offset = /^\d{1,6}$/.test(cursor ?? "") ? Number(cursor) : 0;
  const [stats, byReason, closed] = await Promise.all([
    ctx.stores.dispute.outcomeStats(),
    ctx.stores.dispute.statsByReason().catch(() => []),
    ctx.stores.dispute.listClosed(offset, PAGE_SIZE),
  ]);
  const fmtAmounts = (buckets: Record<string, number>): string => {
    const parts = Object.entries(buckets).map(([cur, minor]) => ctx.stripe.formatAmount(minor, cur));
    return parts.join(" + ") || "—";
  };

  const blocks: Block[] = [];
  blocks.push({
    type: "stats",
    items: [
      { label: "Won", value: String(stats.won), sub: fmtAmounts(stats.wonAmount) },
      { label: "Lost", value: String(stats.lost), sub: fmtAmounts(stats.lostAmount) },
      {
        label: "Win rate",
        value: stats.winRatePct == null ? "—" : `${stats.winRatePct.toFixed(0)}%`,
        sub: `${stats.won + stats.lost} decided`,
      },
      {
        label: "Lost unanswered",
        value: String(stats.lostUnanswered),
        ...(stats.lostUnanswered > 0 ? { badge: { kind: "error", text: "evidence never sent" } as Badge } : {}),
      },
    ],
  });

  if (byReason.length > 0) {
    blocks.push({
      type: "table",
      key: "byreason",
      title: "Win rate by reason",
      columns: [
        { key: "reason", label: "Reason" },
        { key: "won", label: "Won", align: "right" },
        { key: "lost", label: "Lost", align: "right" },
        { key: "rate", label: "Win rate", align: "right" },
      ],
      rows: byReason.map((r) => ({
        id: r.reason,
        cells: [
          strong(sentence(r.reason.replace(/_/g, " "))),
          text(String(r.won)),
          text(String(r.lost)),
          r.winRatePct == null
            ? text("—")
            : badgeCell(r.winRatePct >= 50 ? "ok" : "warn", `${r.winRatePct.toFixed(0)}%`),
        ] as Cell[],
      })),
    });
  }

  blocks.push({
    type: "table",
    key: "closed",
    title: "Closed disputes",
    columns: [
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "customer", label: "Customer" },
      { key: "closed", label: "Closed" },
      { key: "id", label: "ID" },
    ],
    rows: closed.rows.map((d) => ({
      id: d.id,
      ref: { page: "disputes.detail", params: { id: d.id } },
      cells: [
        amount(ctx.stripe, d.amount, d.currency, statusBadgeFor(d.status)),
        text(sentence(d.reason.replace(/_/g, " "))),
        d.customerId
          ? ({ t: "link", v: d.customerId, ref: { page: "customers.detail", params: { id: d.customerId } } } as Cell)
          : text("—"),
        d.closedAt ? isoDateCell(d.closedAt) : text("—"),
        idCell(d.id, { copy: true }),
      ] as Cell[],
    })),
    nextCursor: offset + PAGE_SIZE < closed.total ? String(offset + PAGE_SIZE) : null,
    empty: "No closed disputes yet.",
    ...(closed.rows.length
      ? { footer: `${closed.rows.length} of ${closed.total} item${closed.total === 1 ? "" : "s"}` }
      : {}),
  });

  return blocks;
}

// ---- DETAIL: the evidence workbench ----

async function detail(ctx: DashboardCtx, deps: DisputesDeps, id: string): Promise<SectionPage> {
  let dispute: Stripe.Dispute | null = null;
  let missing = false;
  try {
    dispute = await ctx.stripe.getDispute(id);
  } catch (e) {
    if ((e as Stripe.errors.StripeError).code === "resource_missing") missing = true;
  }
  if (!dispute) {
    if (missing) return notFound("This dispute no longer exists at Stripe.");
    // Stripe unreachable: degrade to the mirror, read-only, instead of a 500.
    const row = await ctx.stores.dispute.get(id);
    if (!row) return notFound("Stripe is unreachable and this dispute is not in the local mirror.");
    return mirrorFallback(ctx, row);
  }

  // Keep the mirror fresh exactly like the Discord hub's detail renderer
  // (customerId backfilled from the charge when the mirror lacks it).
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id ?? "");
  const before = await ctx.stores.dispute.get(id);
  const customerId =
    before?.customerId ?? (chargeId ? await ctx.stripe.getChargeCustomerId(chargeId).catch(() => null) : null);
  const row = await ctx.stores.dispute.upsertFromStripe(dispute, customerId);
  const pkg = deps.evidence.packageFrom(dispute, row);

  const [watching, bookmarked, notes] = await Promise.all([
    ctx.stores.dispute.isWatching(id, ctx.actor.id),
    ctx.stores.qol.isBookmarked("dispute", id),
    ctx.stores.qol.listNotes("dispute", id, 0, 5).catch(() => ({ rows: [], total: 0 })),
  ]);

  const ed = dispute.evidence_details;
  const draftFields = Object.keys(pkg.draft).length;
  const pastDue = !!ed?.past_due;

  // Header actions: submit + refund-to-prevent inline, the rest in "···".
  const actions: ActionButton[] = [];
  actions.push(submitButton(ctx, pkg, draftFields));
  if (dispute.is_charge_refundable && chargeId) {
    actions.push(
      registryButton(ctx, {
        key: "charge.refund_full",
        label: "Refund to prevent",
        dangerous: true,
        params: { chargeId },
        summary:
          dispute.status === "warning_needs_response" || dispute.status === "warning_under_review"
            ? `Fully refund ${ctx.stripe.formatAmount(dispute.amount, dispute.currency)} now — at the warning stage this prevents the dispute from becoming a formal chargeback.`
            : `Fully refund the disputed charge (${ctx.stripe.formatAmount(dispute.amount, dispute.currency)}). Stripe still allows a refund on this dispute.`,
      })
    );
  }
  actions.push({
    key: "section:disputes.accept",
    label: "Accept as lost",
    style: "danger",
    dangerous: true,
    reverseConfirm: true,
    params: { disputeId: id },
    summary: `Accept ${id} (${ctx.stripe.formatAmount(dispute.amount, dispute.currency)}, ${dispute.reason}) — the dispute closes as LOST immediately, the funds stay withdrawn and no evidence can be submitted afterwards. Irreversible. Needs the Discord reverse code (/billing → Show destructive-action code).`,
    ...(pkg.terminal ? { disabledReason: `Dispute is already ${dispute.status}.` } : {}),
  });
  actions.push({
    key: "section:disputes.watch",
    label: watching ? "Unwatch" : "Watch",
    params: { disputeId: id },
  });
  actions.push({
    key: "section:disputes.bookmark",
    label: bookmarked ? "Remove bookmark" : "Bookmark",
    params: { disputeId: id },
  });
  actions.push({
    key: "section:disputes.note_add",
    label: "Add note",
    params: { disputeId: id },
    inputs: [{ type: "text", key: "text", label: "Team note", multiline: true, maxLength: 1000 }],
  });

  const headBadges: Badge[] = [statusBadgeFor(dispute.status)];
  if (pkg.submissions > 0) headBadges.push({ kind: "info", text: `Submitted ${pkg.submissions}×` });
  if (pastDue) headBadges.push({ kind: "error", text: "Past due" });

  const main: Block[] = [];
  const rail: Block[] = [];

  main.push({
    type: "header",
    title: ctx.stripe.formatAmount(dispute.amount, dispute.currency),
    titleSuffix: dispute.currency.toUpperCase(),
    sub: sentence((dispute.reason || "unknown").replace(/_/g, " ")),
    badges: headBadges,
    actions,
  });

  if (pkg.terminal) {
    const won = dispute.status === "won" || dispute.status === "prevented";
    main.push({
      type: "notice",
      badge: { kind: won ? "ok" : "error", text: sentence(dispute.status.replace(/_/g, " ")) },
      text: won
        ? "This dispute is closed in your favor — everything below is the submitted record."
        : "This dispute is closed. The evidence below is the read-only record of what was (or wasn't) sent.",
    });
  } else if (!pkg.respondable) {
    main.push({
      type: "notice",
      badge: { kind: "info", text: "Under review" },
      text: "The response is with the bank — evidence can no longer be changed. A decision usually takes 60–75 days.",
    });
  } else if (pastDue) {
    main.push({
      type: "notice",
      badge: { kind: "error", text: "Past due" },
      text: "The evidence deadline has passed — Stripe may still accept a submission briefly, but the bank can ignore late responses. Submit immediately or accept.",
    });
  }
  if (pkg.respondable && pkg.unstagedDraft.length > 0) {
    main.push({
      type: "notice",
      badge: { kind: "warn", text: `${pkg.unstagedDraft.length} draft` },
      text: `Local draft fields not staged at Stripe yet: ${pkg.unstagedDraft.slice(0, 6).join(", ")}${pkg.unstagedDraft.length > 6 ? ", …" : ""} — stage their groups below or they won't reach the bank.`,
    });
  }

  // Evidence at a glance; the staged counts click through to the review page.
  main.push({
    type: "stats",
    items: [
      {
        label: "Staged fields",
        value: String(pkg.textFields.length),
        sub: "view exactly what the bank gets",
        ref: { page: "disputes.review", params: { id } },
      },
      {
        label: "Files",
        value: String(pkg.files.length),
        sub: "staged proof documents",
        ref: { page: "disputes.review", params: { id } },
      },
      { label: "Submissions", value: String(pkg.submissions), ...(pkg.submissions > 0 ? { badge: { kind: "info", text: "sent" } as Badge } : {}) },
      {
        label: "Evidence due",
        value: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString().slice(0, 10) : "—",
        ...(row.evidenceDueBy ? { badge: dueBadge(row.evidenceDueBy) } : {}),
      },
    ],
  });

  main.push(...aiToolsBlocks(ctx, pkg));
  main.push(evidenceBlockFrom(pkg));

  const timeline: Array<{ label: string; iso: string; text?: string; kind?: Badge["kind"] }> = [];
  if (row.closedAt)
    timeline.push({
      label: `Closed — ${sentence(row.status.replace(/_/g, " "))}`,
      iso: row.closedAt.toISOString(),
      kind: row.status === "won" ? "ok" : row.status === "lost" ? "error" : "info",
    });
  if (row.evidenceSubmittedAt)
    timeline.push({ label: "Evidence submitted", iso: row.evidenceSubmittedAt.toISOString(), kind: "info" });
  if (row.evidenceDueBy)
    timeline.push({
      label: "Evidence deadline",
      iso: row.evidenceDueBy.toISOString(),
      kind: row.evidenceDueBy.getTime() < Date.now() && !row.evidenceSubmittedAt && !row.closedAt ? "error" : "warn",
    });
  timeline.push({ label: "Dispute opened", iso: row.disputeCreatedAt.toISOString(), kind: "error" });
  main.push({ type: "timeline", title: "Timeline", items: timeline });

  // ---- rail ----
  const card = dispute.payment_method_details?.card;
  const fees = (dispute.balance_transactions ?? []).reduce((sum, bt) => sum + (bt.fee ?? 0), 0);
  rail.push({
    type: "kv",
    title: "Details",
    rows: [
      { label: "Dispute ID", cell: idCell(id, { copy: true }) },
      { label: "Status", cell: badgeCell(statusBadgeFor(dispute.status).kind, statusBadgeFor(dispute.status).text) },
      { label: "Reason", cell: text(sentence((dispute.reason || "unknown").replace(/_/g, " "))) },
      ...(card?.case_type ? [{ label: "Case type", cell: text(sentence(card.case_type)) }] : []),
      ...(card?.network_reason_code ? [{ label: "Network code", cell: text(card.network_reason_code) }] : []),
      ...(fees ? [{ label: "Dispute fee", cell: text(ctx.stripe.formatAmount(fees, dispute.currency)) }] : []),
      { label: "Opened", cell: isoDateCell(row.disputeCreatedAt) },
      ...(chargeId
        ? [{ label: "Charge", cell: idCell(chargeId, { copy: true, ref: { page: "payments.detail", params: { id: chargeId } } }) }]
        : []),
      ...(row.paymentIntentId
        ? [{ label: "Payment intent", cell: idCell(row.paymentIntentId, { copy: true, ref: { page: "payments.detail", params: { id: row.paymentIntentId } } }) }]
        : []),
    ],
  });
  rail.push({
    type: "kv",
    title: "Customer",
    rows: customerId
      ? [{ label: "ID", cell: idCell(customerId, { copy: true, ref: { page: "customers.detail", params: { id: customerId } } }) }]
      : [{ label: "Customer", cell: text("No customer on the charge (guest or deleted).") }],
  });
  const refundableText = pkg.terminal
    ? "dispute closed"
    : dispute.is_charge_refundable
      ? "yes — refund prevents/settles this"
      : "no — respond with evidence";
  rail.push({
    type: "kv",
    title: "Response",
    rows: [
      { label: "Deadline", cell: row.evidenceDueBy ? isoDateCell(row.evidenceDueBy) : text("no response window") },
      { label: "Urgency", cell: dueCells(row) },
      { label: "Draft fields", cell: draftFields ? badgeCell("info", `${draftFields} local`) : text("none") },
      { label: "Refundable", cell: text(refundableText) },
    ],
  });
  if (notes.rows.length > 0) {
    rail.push({
      type: "timeline",
      title: `Team notes (${notes.total})`,
      items: notes.rows.map((n) => ({
        label: n.authorName,
        iso: n.createdAt.toISOString(),
        text: n.text,
        kind: "info" as const,
      })),
    });
  }

  return {
    title: ctx.stripe.formatAmount(dispute.amount, dispute.currency),
    crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: id, copyId: id }],
    blocks: main,
    rail,
  };
}

function dueBadge(dueBy: Date): Badge {
  const hoursLeft = (dueBy.getTime() - Date.now()) / 3_600_000;
  if (hoursLeft < 0) return { kind: "error", text: "OVERDUE" };
  if (hoursLeft <= DUE_URGENT_HOURS) return { kind: "error", text: `${Math.max(1, Math.round(hoursLeft))}h left` };
  if (hoursLeft <= DUE_WARN_HOURS) return { kind: "warn", text: `${Math.round(hoursLeft / 24)}d left` };
  return { kind: "neutral", text: `${Math.round(hoursLeft / 24)}d left` };
}

// The submit ceremony button: typed CONFIRM + Discord reverse code, with the
// staged summary baked into the modal text (single-submission warning).
function submitButton(ctx: DashboardCtx, pkg: StagedPackage, draftFields: number): ActionButton {
  const d = pkg.dispute;
  const dueTs = d.evidence_details?.due_by || null;
  const summary = [
    `Submit the staged evidence for ${d.id} (${ctx.stripe.formatAmount(d.amount, d.currency)}, ${d.reason}) to the bank.`,
    `Staged right now: ${pkg.textFields.length} text field(s) + ${pkg.files.length} file(s).`,
    pkg.unstagedDraft.length
      ? `⚠ ${pkg.unstagedDraft.length} local draft field(s) are NOT staged and will not be sent.`
      : null,
    dueTs ? `Deadline: ${new Date(dueTs * 1000).toISOString().slice(0, 10)}.` : null,
    pkg.submissions > 0
      ? `⚠ Evidence was already submitted ${pkg.submissions}× — banks typically accept only ONE submission; resubmit only if Stripe support advised it.`
      : "Banks typically allow exactly one submission — make sure the staged evidence is complete.",
    "This cannot be recalled. Needs the Discord reverse code (/billing → Show destructive-action code).",
  ]
    .filter(Boolean)
    .join(" ");
  const disabled = !pkg.respondable
    ? `Status is ${d.status} — evidence can no longer be submitted.`
    : !(pkg.hasEvidence || draftFields > 0)
      ? "Nothing staged at Stripe yet — stage evidence first."
      : undefined;
  return {
    key: "section:disputes.submit",
    label: "Submit evidence",
    style: "primary",
    dangerous: true,
    reverseConfirm: true,
    params: { disputeId: d.id },
    summary,
    ...(disabled ? { disabledReason: disabled } : {}),
  };
}

// AI tools row (draft + review buttons w/ model/cost from settings, as the
// hub surfaces them) plus the last stored review verdict, if fresh. The
// verdict must survive the page reload a successful action triggers — it
// lives in the section-level store, advisory-only.
function aiToolsBlocks(ctx: DashboardCtx, pkg: StagedPackage): Block[] {
  const id = pkg.dispute.id;
  const blocks: Block[] = [];
  blocks.push({
    type: "notice",
    badge: { kind: "info", text: "AI" },
    text: `AI draft researches the ⭐ recommended fields from real account data (${ctx.settings.aiModel()}, effort ${ctx.settings.aiEffortAsk()}, ≤$${ctx.settings.aiMaxBudgetUsdAsk()}) and saves a LOCAL draft only. AI review critiques the staged package on ${ctx.settings.aiModelLight()} with the staged files as vision input. Both are advisory — nothing is sent to the bank.`,
    actions: [
      {
        key: "section:disputes.ai_draft",
        label: "AI draft",
        params: { disputeId: id },
        ...(pkg.respondable ? {} : { disabledReason: "Dispute is no longer respondable — nothing to draft for." }),
      },
      {
        key: "section:disputes.ai_review",
        label: "AI review",
        params: { disputeId: id },
        ...(pkg.textFields.length || pkg.files.length ? {} : { disabledReason: "Nothing staged at Stripe to review yet." }),
      },
    ],
  });
  const stored = freshAiReview(id);
  if (stored) {
    blocks.push({
      type: "kv",
      title: "AI evidence review",
      rows: [
        { label: "Model", cell: text(stored.model) },
        { label: "Coverage", cell: text(stored.coverage) },
        { label: "Ran", cell: isoDateCell(new Date(stored.at)) },
      ],
    });
    blocks.push({ type: "notice", badge: { kind: "info", text: "Advisory" }, text: stored.review });
  }
  return blocks;
}

// Build the interactive evidence widget from the staged package + catalog.
function evidenceBlockFrom(pkg: StagedPackage): EvidenceBlock {
  const recommended = recommendedGroupKeys(pkg.dispute.reason);
  const ordered = [...EVIDENCE_GROUPS].sort((a, b) => {
    const ai = recommended.indexOf(a.key);
    const bi = recommended.indexOf(b.key);
    return (ai === -1 ? recommended.length : ai) - (bi === -1 ? recommended.length : bi);
  });
  const groups = ordered.map((g) => ({
    key: g.key,
    label: g.label,
    ...(recommended.includes(g.key) ? { recommended: true } : {}),
    fields: g.fields.map((f) => {
      const staged = typeof pkg.staged[f.key] === "string" ? (pkg.staged[f.key] as string).trim() : "";
      const draft = pkg.draft[f.key]?.trim() ?? "";
      const state: "empty" | "draft" | "staged" | "submitted" =
        draft && draft !== staged ? "draft" : staged ? (pkg.submissions > 0 ? "submitted" : "staged") : "empty";
      return {
        key: f.key,
        label: f.label,
        multiline: f.multiline,
        state,
        ...(draft ? { draft } : {}),
        ...(staged ? { staged } : {}),
      };
    }),
  }));
  // The six upload slots, plus any file staged into a non-slot key elsewhere
  // (webhook receipt auto-attach, Stripe Dashboard uploads) so nothing hides.
  const files: EvidenceBlock["files"] = EVIDENCE_FILE_SLOTS.map((s) => ({
    key: s.key,
    label: s.label,
    ...(typeof pkg.staged[s.key] === "string" && pkg.staged[s.key] ? { fileId: String(pkg.staged[s.key]) } : {}),
  }));
  for (const f of pkg.files) {
    if (!EVIDENCE_FILE_SLOTS.some((s) => s.key === f.slot)) {
      files.push({ key: f.slot, label: sentence(f.slot.replace(/_/g, " ")), fileId: f.fileId });
    }
  }
  return {
    type: "evidence",
    disputeId: pkg.dispute.id,
    editable: pkg.respondable,
    submitted: pkg.submissions > 0,
    groups,
    files,
    maxFileBytes: PROOF_MAX_BYTES,
    fileTypes: [...PROOF_TYPES],
  };
}

// Degraded detail when Stripe is unreachable: mirror data, zero actions.
function mirrorFallback(ctx: DashboardCtx, d: StripeDispute): SectionPage {
  return {
    title: ctx.stripe.formatAmount(d.amount, d.currency),
    crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: d.id, copyId: d.id }],
    blocks: [
      {
        type: "header",
        title: ctx.stripe.formatAmount(d.amount, d.currency),
        titleSuffix: d.currency.toUpperCase(),
        sub: sentence(d.reason.replace(/_/g, " ")),
        badges: [statusBadgeFor(d.status)],
      },
      {
        type: "notice",
        badge: { kind: "warn", text: "Live fetch failed" },
        text: "Stripe is unreachable right now — showing the local mirror, read-only. Reload to retry.",
      },
      {
        type: "kv",
        title: "Mirror",
        rows: [
          { label: "Status", cell: badgeCell(statusBadgeFor(d.status).kind, statusBadgeFor(d.status).text) },
          { label: "Deadline", cell: d.evidenceDueBy ? isoDateCell(d.evidenceDueBy) : text("—") },
          { label: "Charge", cell: idCell(d.chargeId, { copy: true, ref: { page: "payments.detail", params: { id: d.chargeId } } }) },
        ],
      },
    ],
  };
}

// ---- REVIEW: staged-evidence read-back (exactly what the bank receives) ----

async function review(ctx: DashboardCtx, deps: DisputesDeps, id: string): Promise<SectionPage> {
  let pkg: StagedPackage;
  try {
    pkg = await deps.evidence.stagedPackage(id);
  } catch (e) {
    if ((e as Stripe.errors.StripeError).code === "resource_missing") {
      return notFound("This dispute no longer exists at Stripe.");
    }
    throw e;
  }
  const d = pkg.dispute;
  const draftFields = Object.keys(pkg.draft).length;

  const main: Block[] = [];
  main.push({
    type: "header",
    title: "Staged evidence",
    sub: `${d.id} · ${ctx.stripe.formatAmount(d.amount, d.currency)} · ${sentence((d.reason || "unknown").replace(/_/g, " "))}`,
    badges: [
      statusBadgeFor(d.status),
      ...(pkg.submissions > 0 ? [{ kind: "info", text: `Submitted ${pkg.submissions}×` } as Badge] : []),
    ],
    actions: [submitButton(ctx, pkg, draftFields)],
  });
  main.push({
    type: "notice",
    badge: { kind: "info", text: "Read-back" },
    text:
      pkg.submissions > 0
        ? "This is what the bank received (and would receive again on a resubmission)."
        : "This is exactly what the bank receives when you submit. Nothing here has been sent yet.",
  });

  main.push({
    type: "table",
    key: "stagedfields",
    title: `Text fields (${pkg.textFields.length})`,
    columns: [
      { key: "field", label: "Field" },
      { key: "len", label: "Length", align: "right" },
      { key: "value", label: "Content" },
    ],
    rows: pkg.textFields.map((f) => ({
      id: f.key,
      cells: [
        idCell(f.key),
        text(`${f.value.length}`),
        text(f.value.length > 300 ? `${f.value.slice(0, 300)}…` : f.value),
      ] as Cell[],
    })),
    empty: "No text evidence staged.",
    ...(pkg.textFields.length ? { footer: `${pkg.textFields.length} field${pkg.textFields.length === 1 ? "" : "s"}` } : {}),
  });

  main.push({
    type: "table",
    key: "stagedfiles",
    title: `Files (${pkg.files.length})`,
    columns: [
      { key: "slot", label: "Slot" },
      { key: "file", label: "File ID" },
    ],
    rows: pkg.files.map((f) => ({
      id: f.slot,
      cells: [text(sentence(f.slot.replace(/_/g, " "))), idCell(f.fileId, { copy: true })] as Cell[],
      actions: [
        {
          key: "section:disputes.file_remove",
          label: "Remove",
          dangerous: true,
          params: { disputeId: id, slot: f.slot },
          summary: "Detaches this staged file from the dispute (the upload stays in your Stripe account). It will NOT reach the bank.",
          ...(pkg.respondable ? {} : { disabledReason: "Evidence can no longer be changed on this dispute." }),
        },
      ],
    })),
    empty: "No evidence files attached.",
  });

  if (pkg.unstagedDraft.length > 0) {
    main.push({
      type: "notice",
      badge: { kind: "warn", text: `${pkg.unstagedDraft.length} unstaged` },
      text: `Local draft field(s) NOT staged yet: ${pkg.unstagedDraft.slice(0, 8).join(", ")}${pkg.unstagedDraft.length > 8 ? ", …" : ""} — go back to the workbench and stage their groups, or they won't reach the bank.`,
    });
  }

  // AI critique of exactly this package (works on closed disputes too —
  // post-mortem of what was actually sent), plus the last verdict if fresh.
  main.push(...aiToolsBlocks(ctx, pkg));

  return {
    title: "Staged evidence",
    crumbs: [
      { label: "Disputes", ref: { page: "disputes" } },
      { label: d.id, ref: { page: "disputes.detail", params: { id } } },
      { label: "Staged evidence", copyId: d.id },
    ],
    blocks: main,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Disputes", ref: { page: "disputes" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Dispute not found", hint }],
  };
}
