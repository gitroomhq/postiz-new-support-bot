import type Stripe from "stripe";
import { ActionResult, Badge, Block, Cell } from "../renderer/contract";
import { DashboardCtx, DashboardSectionModule, SectionPage, str } from "./types";
import { badgeCell, dateCell, idCell, text } from "./cells";

// Webhooks (#/webhooks): endpoint manager. The bot's OWN endpoint
// (StripeWebhookHandler.ensureEndpoint owns settings.stripeWebhookEndpointId)
// is badged "Bot-managed" and rendered without row actions — and the server
// refuses disable/delete on that id regardless of client input, because
// killing it silently severs ticket billing alerts.
//
// SECRET POLICY: the whsec_ signing secret exists in exactly ONE response —
// the create ActionResult.text ("copy it NOW"). It is never stored, never
// audited (the audit line records only that a disclosure happened).

const ENDPOINT_ID_RE = /^we_[A-Za-z0-9]{1,64}$/;
const URL_RE = /^https:\/\/[^\s]{1,290}$/;
const EVENT_TOKEN_RE = /^[a-z0-9_.]+(\.\*)?$/;

export function makeWebhooksSection(): DashboardSectionModule {
  return {
    nav: [{ key: "webhooks", label: "Webhooks", page: "webhooks", group: "Operate" }],

    ownsPage(page: string): boolean {
      return page === "webhooks";
    },

    async buildPage(ctx: DashboardCtx, _req): Promise<SectionPage | null> {
      const endpoints = await ctx.stripe.listWebhookEndpoints(100);
      const botManagedId = ctx.settings.stripeWebhookEndpointId();

      const blocks: Block[] = [
        {
          type: "header",
          title: "Webhooks",
          actions: [
            {
              key: "section:webhooks.create",
              label: "Add endpoint",
              style: "primary",
              dangerous: true,
              inputs: [
                { type: "text", key: "url", label: "Endpoint URL (https://…)", placeholder: "https://example.com/stripe", maxLength: 300 },
                { type: "toggle", key: "all", label: "Listen to ALL events (*)" },
                {
                  type: "text",
                  key: "events",
                  label: "Or event types (comma/space separated, max 20)",
                  placeholder: "invoice.paid charge.refunded customer.subscription.*",
                  maxLength: 800,
                },
                { type: "text", key: "description", label: "Description (optional)", maxLength: 100 },
              ],
              summary:
                "Creates the endpoint and shows its signing secret ONCE: copy it immediately, Stripe never returns it again.",
            },
          ],
        },
        {
          type: "table",
          key: "webhooks",
          columns: [
            { key: "url", label: "URL" },
            { key: "status", label: "Status" },
            { key: "events", label: "Events" },
            { key: "api", label: "API version" },
            { key: "created", label: "Created" },
          ],
          rows: endpoints.map((ep) => {
            const botManaged = botManagedId != null && ep.id === botManagedId;
            return {
              id: ep.id,
              cells: [
                idCell(ep.url, { copy: true }),
                botManaged
                  ? ({ t: "flags", badges: [statusBadge(ep.status), { kind: "info", text: "Bot-managed" }] } as Cell)
                  : badgeCell(statusBadge(ep.status).kind, statusBadge(ep.status).text),
                text(eventsLabel(ep), eventsSub(ep)),
                text(ep.api_version ?? "account default"),
                dateCell(ep.created),
              ] as Cell[],
              // The bot-managed endpoint shows NO actions — its lifecycle
              // belongs to StripeWebhookHandler.ensureEndpoint.
              ...(botManaged
                ? {}
                : {
                    actions: [
                      ep.status === "enabled"
                        ? {
                            key: "section:webhooks.toggle",
                            label: "Disable",
                            dangerous: true,
                            params: { id: ep.id, enabled: false },
                            summary: "Stripe stops delivering events to this URL until it is re-enabled.",
                          }
                        : {
                            key: "section:webhooks.toggle",
                            label: "Enable",
                            dangerous: true,
                            params: { id: ep.id, enabled: true },
                          },
                      {
                        key: "section:webhooks.delete",
                        label: "Delete",
                        style: "danger" as const,
                        dangerous: true,
                        params: { id: ep.id },
                        summary: "Deletes the endpoint permanently; its signing secret stops working immediately.",
                      },
                    ],
                  }),
            };
          }),
          empty: "No webhook endpoints.",
          ...(endpoints.length ? { footer: `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"}` } : {}),
          notice: "The bot-managed endpoint delivers billing alerts to this bot; manage it via the bot, not here.",
        },
      ];
      return { title: "Webhooks", crumbs: [{ label: "Webhooks" }], blocks };
    },

    async action(ctx: DashboardCtx, req): Promise<ActionResult> {
      const p = req.params ?? {};
      const confirmed = req.confirmWord === "CONFIRM";
      switch (req.key) {
        // T1 — create an endpoint; the ONLY place the signing secret ever
        // appears (in text, never in the audit line, never stored).
        case "section:webhooks.create": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const url = str(p.url, 300).trim();
          if (!URL_RE.test(url)) return { ok: false, fieldErrors: { url: "Must be an https:// URL." } };
          let events: string[];
          if (p.all === true) {
            events = ["*"];
          } else {
            const tokens = str(p.events, 800).split(/[\s,]+/).filter(Boolean);
            if (tokens.length === 0) {
              return { ok: false, fieldErrors: { events: "List event types or enable the ALL toggle." } };
            }
            if (tokens.length > 20 || tokens.some((t) => !EVENT_TOKEN_RE.test(t))) {
              return { ok: false, fieldErrors: { events: "Max 20 tokens; letters, digits, dots (optional .* suffix)." } };
            }
            events = tokens;
          }
          const description = str(p.description, 100).trim();
          let created: { id: string; secret: string | null };
          try {
            created = await ctx.stripe.createWebhookEndpoint(
              url,
              events as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
              `dash-wh-${Date.now().toString(36)}`,
              description ? { description } : {}
            );
          } catch (e) {
            // Stripe validates enabled_events serverside — surface its message
            // on the events field (unknown type names are the common case).
            const msg = e instanceof Error ? e.message : "Stripe rejected the endpoint.";
            return { ok: false, fieldErrors: { events: msg.slice(0, 300) } };
          }
          // Audit records THAT a disclosure happened — never the secret.
          await ctx.audit(`Webhook endpoint ${created.id} created for ${url} (${events.length === 1 && events[0] === "*" ? "all events" : `${events.length} event types`}); signing secret disclosed once to ${ctx.actor.name}`);
          return {
            ok: true,
            text: created.secret
              ? `Endpoint ${created.id} created. Signing secret (copy NOW, never shown again): ${created.secret}`
              : `Endpoint ${created.id} created. Stripe did not return a signing secret.`,
          };
        }
        // T1 — enable/disable with live re-read; the bot-managed endpoint is
        // refused server-side no matter what the client sent.
        case "section:webhooks.toggle": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const id = typeof p.id === "string" && ENDPOINT_ID_RE.test(p.id) ? p.id : null;
          if (!id) return { ok: false, error: "Bad endpoint id." };
          if (id === ctx.settings.stripeWebhookEndpointId()) {
            return { ok: false, error: "This endpoint is bot-managed: the bot re-creates and reconciles it itself." };
          }
          const live = (await ctx.stripe.listWebhookEndpoints(100)).find((ep) => ep.id === id);
          if (!live) return { ok: false, error: "This endpoint no longer exists." };
          const enable = p.enabled === true;
          if ((live.status === "enabled") === enable) {
            return { ok: false, error: `Endpoint is already ${live.status}.` };
          }
          await ctx.stripe.updateWebhookEndpoint(id, { disabled: !enable });
          await ctx.audit(`Webhook endpoint ${id} ${enable ? "enabled" : "disabled"} (${live.url})`);
          return { ok: true, text: `${id} is now ${enable ? "enabled" : "disabled"}.` };
        }
        // T1 — delete (danger-styled); bot-managed refused server-side.
        case "section:webhooks.delete": {
          if (!confirmed) return { ok: false, error: "Type CONFIRM to run this action." };
          const id = typeof p.id === "string" && ENDPOINT_ID_RE.test(p.id) ? p.id : null;
          if (!id) return { ok: false, error: "Bad endpoint id." };
          if (id === ctx.settings.stripeWebhookEndpointId()) {
            return { ok: false, error: "This endpoint is bot-managed: deleting it would sever the bot's billing alerts." };
          }
          const live = (await ctx.stripe.listWebhookEndpoints(100)).find((ep) => ep.id === id);
          if (!live) return { ok: false, error: "This endpoint no longer exists." };
          await ctx.stripe.deleteWebhookEndpoint(id);
          await ctx.audit(`Webhook endpoint ${id} DELETED (${live.url})`);
          return { ok: true, text: `${id} deleted. Its signing secret is dead.` };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}

function statusBadge(status: string): Badge {
  return status === "enabled" ? { kind: "ok", text: "Enabled" } : { kind: "neutral", text: "Disabled" };
}

function eventsLabel(ep: Stripe.WebhookEndpoint): string {
  const events = ep.enabled_events ?? [];
  if (events.length === 1 && events[0] === "*") return "All events";
  return `${events.length} event${events.length === 1 ? "" : "s"}`;
}

function eventsSub(ep: Stripe.WebhookEndpoint): string | undefined {
  const events = ep.enabled_events ?? [];
  if (events.length === 1 && events[0] === "*") return undefined;
  const head = events.slice(0, 3).join(", ");
  return events.length > 3 ? `${head}, …` : head || undefined;
}
