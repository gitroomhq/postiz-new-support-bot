import { Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str, validCursor } from "./types";
import { dateCell, idCell, refForId, sentence, text } from "./cells";

// Events (#/events, PA-12): read-only browse of the account's Stripe event
// stream — the "what did the API just do" debugging surface. 25/page with a
// curated type filter plus a free-form `typeq` pill (validated, wins over the
// select). Stripe retains events for 30 days.

const EVENT_ID_RE = /^evt_[A-Za-z0-9]{1,64}$/;
// Stripe event-type filter forms: exact ("invoice.paid"), family wildcard
// ("invoice.*") or the global "*".
const TYPE_QUERY_RE = /^[a-z0-9_.]+(\.\*)?$|^\*$/;

const CURATED_TYPES = [
  { value: "charge.succeeded", label: "Charge succeeded" },
  { value: "charge.failed", label: "Charge failed" },
  { value: "charge.refunded", label: "Charge refunded" },
  { value: "charge.dispute.created", label: "Dispute created" },
  { value: "payment_intent.succeeded", label: "Payment intent succeeded" },
  { value: "payment_intent.payment_failed", label: "Payment intent failed" },
  { value: "invoice.paid", label: "Invoice paid" },
  { value: "invoice.payment_failed", label: "Invoice payment failed" },
  { value: "invoice.finalized", label: "Invoice finalized" },
  { value: "customer.created", label: "Customer created" },
  { value: "customer.subscription.created", label: "Subscription created" },
  { value: "customer.subscription.updated", label: "Subscription updated" },
  { value: "customer.subscription.deleted", label: "Subscription deleted" },
  { value: "payout.paid", label: "Payout paid" },
  { value: "radar.early_fraud_warning.created", label: "Early fraud warning" },
];

export function makeEventsSection(): DashboardSectionModule {
  return {
    nav: [{ key: "events", label: "Events", page: "events", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "events";
    },

    async buildPage(ctx: DashboardCtx, req): Promise<SectionPage | null> {
      const filters = req.filters ?? {};
      const curated = CURATED_TYPES.some((t) => t.value === filters.type) ? filters.type : "";
      // Free-form query pill: validated hard (it flows into the Stripe list
      // param) and wins over the curated select when both are set.
      const typeqRaw = str(filters.typeq, 60).trim();
      const typeq = TYPE_QUERY_RE.test(typeqRaw) ? typeqRaw : "";
      const type = typeq || curated;

      const rawCursor = validCursor(req.cursor ?? null) ?? "";
      const startingAfter = EVENT_ID_RE.test(rawCursor) ? rawCursor : undefined;
      const { events, hasMore } = await ctx.stripe.listEventsPage({
        limit: 25,
        ...(type && type !== "*" ? { type } : {}),
        ...(startingAfter ? { startingAfter } : {}),
      });

      const blocks: Block[] = [
        {
          type: "table",
          key: "events",
          columns: [
            { key: "type", label: "Type" },
            { key: "object", label: "Object" },
            { key: "created", label: "Created" },
            { key: "id", label: "ID" },
          ],
          filters: [
            { key: "type", label: "Type", kind: "select", value: curated || undefined, options: CURATED_TYPES },
            {
              key: "typeq",
              label: "Type query",
              kind: "text",
              value: typeq || undefined,
              placeholder: "invoice.* — wins over the select",
            },
          ],
          exportable: true,
          rows: events.map((e) => {
            const obj = e.data.object as { id?: string; object?: string };
            const objId = typeof obj.id === "string" ? obj.id : null;
            const ref = objId ? refForId(objId) : null;
            return {
              id: e.id,
              cells: [
                { t: "text", v: sentence(e.type.replace(/[._]/g, " ")), strong: true, sub: e.type } as Cell,
                objId ? idCell(objId, { copy: true, ...(ref ? { ref } : {}) }) : text(obj.object ?? "—"),
                dateCell(e.created),
                idCell(e.id, { copy: true }),
              ] as Cell[],
            };
          }),
          nextCursor: hasMore && events.length > 0 ? events[events.length - 1].id : null,
          empty: type ? "No events of this type in the retained window." : "No events yet.",
          ...(events.length ? { footer: `${events.length}${hasMore ? "+" : ""} item${events.length === 1 ? "" : "s"}` } : {}),
          notice:
            "Read-only. Stripe retains events for 30 days" +
            (typeqRaw && !typeq ? " · type query ignored (letters, digits, dots; optional .* suffix)." : "."),
        },
      ];
      return { title: "Events", crumbs: [{ label: "Events" }], blocks };
    },
  };
}
