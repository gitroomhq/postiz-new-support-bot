import type Stripe from "stripe";
import { ActionResult, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str } from "./types";
import { badgeCell, dateCell, idCell, sentence, strong, text } from "./cells";

// Usage meters (#/meters, Operate group): the billing.meters config
// surface behind usage-based prices. List + detail (config kv + event
// summaries) + minimal create + deactivate/reactivate (T1 — deactivating
// stops event ingestion). Stripe scopes event summaries to ONE customer, so
// the detail page carries a cus_ filter + a time-window select; windows align
// to full hour/day boundaries as the API requires.

const METER_ID_RE = /^mtr_[A-Za-z0-9]{1,64}$/;
const CUSTOMER_RE = /^cus_[A-Za-z0-9]{1,64}$/;
// Stripe meter event names: short machine identifiers.
const EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const FORMULAS = ["count", "sum", "last"] as const;

const WINDOWS: Record<string, { seconds: number; granularity: "hour" | "day"; label: string }> = {
  "24h": { seconds: 24 * 3600, granularity: "hour", label: "Last 24 hours" },
  "7d": { seconds: 7 * 86400, granularity: "day", label: "Last 7 days" },
  "30d": { seconds: 30 * 86400, granularity: "day", label: "Last 30 days" },
};

export function makeMetersSection(): DashboardSectionModule {
  return {
    nav: [{ key: "meters", label: "Meters", page: "meters", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "meters" || page === "meters.detail";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      if (req.page === "meters") return list(ctx);
      const id = typeof req.params?.id === "string" && METER_ID_RE.test(req.params.id) ? req.params.id : null;
      if (!id) return notFound("That meter id is not valid (mtr_…).");
      return detail(ctx, id, req.filters ?? {});
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const p = req.params ?? {};
      switch (req.key) {
        // T0 (catalog-create tier) — a meter alone ingests nothing billable
        // until a price references it.
        case "section:meters.create": {
          const displayName = str(p.displayName, 80).trim();
          if (!displayName) return { ok: false, fieldErrors: { displayName: "Enter a display name." } };
          const eventName = str(p.eventName, 100).trim();
          if (!EVENT_NAME_RE.test(eventName)) {
            return { ok: false, fieldErrors: { eventName: "Event name: letters, digits, _ . : - (max 100)." } };
          }
          const formula = FORMULAS.includes(p.formula as (typeof FORMULAS)[number])
            ? (p.formula as (typeof FORMULAS)[number])
            : null;
          if (!formula) return { ok: false, fieldErrors: { formula: "Pick an aggregation." } };
          const meter = await ctx.stripe.createMeter(
            { displayName, eventName, formula },
            `dash-meter-${eventName}-${Date.now().toString(36)}`
          );
          await ctx.audit(`Meter ${meter.id} created (${eventName}, ${formula})`);
          return { ok: true, text: `Meter ${meter.id} created — events named "${eventName}" now aggregate by ${formula}.` };
        }
        // T1 — deactivate stops ingestion (events sent meanwhile are DROPPED);
        // reactivate resumes it. Live status revalidation, payout precedent.
        case "section:meters.toggle": {
          const id = typeof p.id === "string" && METER_ID_RE.test(p.id) ? p.id : null;
          if (!id) return { ok: false, error: "Bad meter id." };
          if (req.confirmWord !== "CONFIRM") return { ok: false, error: "Type CONFIRM to run this action." };
          const wantActive = p.active === true;
          const meter = await ctx.stripe.getMeter(id).catch(() => null);
          if (!meter) return { ok: false, error: "This meter does not exist." };
          if ((meter.status === "active") === wantActive) {
            return { ok: false, error: `Meter is already ${meter.status}.` };
          }
          await ctx.stripe.setMeterActive(id, wantActive);
          await ctx.audit(`Meter ${id} ${wantActive ? "reactivated" : "deactivated"} (${meter.event_name})`);
          return {
            ok: true,
            text: wantActive
              ? `${id} is active again — "${meter.event_name}" events are ingested.`
              : `${id} is inactive — "${meter.event_name}" events are now rejected until reactivation.`,
          };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

function meterBadge(status: Stripe.Billing.Meter.Status): Badge {
  return status === "active" ? { kind: "ok", text: "Active" } : { kind: "neutral", text: "Inactive" };
}

function toggleAction(meter: Stripe.Billing.Meter) {
  return meter.status === "active"
    ? {
        key: "section:meters.toggle",
        label: "Deactivate",
        dangerous: true,
        params: { id: meter.id, active: false },
        summary: "Stops ingestion — meter events with this event name are rejected until reactivation.",
      }
    : {
        key: "section:meters.toggle",
        label: "Reactivate",
        dangerous: true,
        params: { id: meter.id, active: true },
        summary: "Resumes ingestion for this meter's event name.",
      };
}

async function list(ctx: DashboardCtx): Promise<SectionPage> {
  const meters = await ctx.stripe.listMeters(100);

  const blocks: Block[] = [
    {
      type: "header",
      title: "Meters",
      actions: [
        {
          key: "section:meters.create",
          label: "New meter",
          style: "primary",
          inputs: [
            { type: "text", key: "displayName", label: "Display name", maxLength: 80 },
            { type: "text", key: "eventName", label: "Event name (machine id)", placeholder: "api_requests", maxLength: 100 },
            {
              type: "select",
              key: "formula",
              label: "Aggregation",
              options: [
                { value: "sum", label: "Sum — add each event's value" },
                { value: "count", label: "Count — number of events" },
                { value: "last", label: "Last — most recent event's value" },
              ],
            },
          ],
          summary:
            "Creates a usage meter. Events map to customers via the stripe_customer_id payload key; sum/last read the \"value\" key.",
        },
      ],
    },
    {
      type: "table",
      key: "meters",
      columns: [
        { key: "name", label: "Name" },
        { key: "status", label: "Status" },
        { key: "event", label: "Event name" },
        { key: "agg", label: "Aggregation" },
        { key: "created", label: "Created" },
      ],
      exportable: true,
      rows: meters.map((m) => ({
        id: m.id,
        ref: { page: "meters.detail", params: { id: m.id } },
        cells: [
          strong(m.display_name),
          badgeCell(meterBadge(m.status).kind, meterBadge(m.status).text),
          idCell(m.event_name, { copy: true }),
          text(sentence(m.default_aggregation?.formula ?? "—")),
          dateCell(m.created),
        ] as Cell[],
        actions: [toggleAction(m)],
      })),
      empty: "No usage meters — create one above to start metering billing events.",
      ...(meters.length ? { footer: `${meters.length} item${meters.length === 1 ? "" : "s"}` } : {}),
      notice: "Meters can't be deleted — deactivate to stop ingestion. Attach a meter to a usage-based price to bill on it.",
    },
  ];
  return { title: "Meters", crumbs: [{ label: "Meters" }], blocks };
}

async function detail(ctx: DashboardCtx, id: string, filters: Record<string, string>): Promise<SectionPage> {
  const meter = await ctx.stripe.getMeter(id).catch(() => null);
  if (!meter) return notFound("This meter does not exist.");

  const customerRaw = str(filters.customer, 70).trim();
  const customerId = CUSTOMER_RE.test(customerRaw) ? customerRaw : null;
  const windowKey = WINDOWS[str(filters.window, 4)] ? str(filters.window, 4) : "7d";
  const win = WINDOWS[windowKey];

  // Boundaries must align with the grouping window: full hours for 24h, full
  // UTC days for 7d/30d — so the current partial hour/day is excluded.
  const unit = win.granularity === "hour" ? 3600 : 86400;
  const endTime = Math.floor(Date.now() / 1000 / unit) * unit;
  const startTime = endTime - win.seconds;

  let summaries: Stripe.Billing.MeterEventSummary[] = [];
  let summariesError: string | null = null;
  if (customerId) {
    try {
      summaries = await ctx.stripe.listMeterEventSummaries(id, {
        customerId,
        startTime,
        endTime,
        granularity: win.granularity,
      });
    } catch {
      summariesError = "Stripe rejected the summary query — check the customer id.";
    }
  }

  const fmtBoundary = (unix: number) =>
    win.granularity === "hour"
      ? new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")
      : new Date(unix * 1000).toISOString().slice(0, 10);

  const main: Block[] = [
    {
      type: "header",
      title: meter.display_name,
      sub: "Usage meter",
      id: meter.id,
      badges: [meterBadge(meter.status)],
      actions: [toggleAction(meter)],
    },
    {
      type: "table",
      key: "summaries",
      title: "Event summaries",
      columns: [
        { key: "start", label: "Window start" },
        { key: "end", label: "Window end" },
        { key: "value", label: "Aggregated value", align: "right" },
      ],
      filters: [
        { key: "customer", label: "Customer", kind: "text", value: customerId ?? undefined, placeholder: "cus_…" },
        {
          key: "window",
          label: "Window",
          kind: "select",
          value: windowKey,
          options: Object.entries(WINDOWS).map(([value, w]) => ({ value, label: w.label })),
        },
      ],
      rows: summaries.map((s) => ({
        id: s.id,
        cells: [text(fmtBoundary(s.start_time)), text(fmtBoundary(s.end_time)), strong(String(s.aggregated_value))] as Cell[],
      })),
      empty:
        summariesError ??
        (customerId
          ? "No usage recorded for this customer in this window."
          : "Enter a customer id (cus_…) above — Stripe scopes meter event summaries to one customer."),
      notice: `Complete ${win.granularity}s only (UTC) — the current partial ${win.granularity} is excluded.`,
    },
  ];

  const rail: Block[] = [
    {
      type: "kv",
      title: "Configuration",
      rows: [
        { label: "Meter ID", cell: idCell(meter.id, { copy: true }) },
        { label: "Status", cell: badgeCell(meterBadge(meter.status).kind, meterBadge(meter.status).text) },
        { label: "Event name", cell: idCell(meter.event_name, { copy: true }) },
        { label: "Aggregation", cell: text(sentence(meter.default_aggregation?.formula ?? "—")) },
        ...(meter.value_settings?.event_payload_key
          ? [{ label: "Value key", cell: idCell(meter.value_settings.event_payload_key) }]
          : []),
        ...(meter.customer_mapping?.event_payload_key
          ? [{ label: "Customer key", cell: idCell(meter.customer_mapping.event_payload_key) }]
          : []),
        ...(meter.event_time_window ? [{ label: "Pre-aggregation", cell: text(sentence(meter.event_time_window)) }] : []),
        { label: "Created", cell: dateCell(meter.created) },
        ...(meter.status_transitions?.deactivated_at
          ? [{ label: "Deactivated", cell: dateCell(meter.status_transitions.deactivated_at) }]
          : []),
      ],
    },
  ];

  return {
    title: meter.display_name,
    crumbs: [{ label: "Meters", ref: { page: "meters" } }, { label: meter.id, copyId: meter.id }],
    blocks: main,
    rail,
  };
}

function notFound(hint: string): SectionPage {
  return {
    title: "Not found",
    crumbs: [{ label: "Meters", ref: { page: "meters" } }, { label: "Not found" }],
    blocks: [{ type: "empty", title: "Meter not found", hint }],
  };
}
