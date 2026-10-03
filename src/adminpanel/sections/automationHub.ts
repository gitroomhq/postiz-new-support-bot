import { ActionResult, Opt, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asBoundedInt, asOptionalId, asString } from "./types";
import type { IntercomTicketState } from "../../intercom/types";

// Automation hub (intercom group): the workspace customer-idle sweeper for
// native / unbridged conversations (outbound nag + auto-close), the
// customer-responded ticket state and resolve on close. Mirrors /intercom →
// Automation. Agent nags
// are SLA-driven (SLA Manager → Nag Cadence). (Per-tag customer reminder TEXT
// overrides are edited on each tag in Workflow.)

const CATEGORY_LABELS: Record<string, string> = {
  submitted: "Submitted",
  in_progress: "In progress",
  waiting_on_customer: "Waiting on customer",
};

export function makeAutomationHub(deps: {
  runInactivityNow: () => Promise<string>;
  listTicketStates: () => Promise<IntercomTicketState[]>;
  syncReplyStates: () => Promise<string>;
  lastCloseSweep: () => string;
}): HubModule {
  // Live, non-resolved states: a resolved one would close tickets on every
  // customer reply.
  const pickable = async (): Promise<IntercomTicketState[]> =>
    (await deps.listTicketStates()).filter((st) => !st.archived && st.category !== "resolved");
  // Resolve on close: live Resolved-category states only.
  const resolvedStates = async (): Promise<IntercomTicketState[]> =>
    (await deps.listTicketStates()).filter((st) => !st.archived && st.category === "resolved");

  return {
    hub: "automation",
    group: "intercom",
    title: "Automation",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      let stateOpts: Opt[] = [];
      let closeStateOpts: Opt[] = [];
      let statesError: string | null = null;
      try {
        stateOpts = (await pickable()).map((st) => ({
          value: st.id,
          label: `${st.internalLabel} (${CATEGORY_LABELS[st.category ?? ""] ?? st.category ?? "?"})`,
        }));
        closeStateOpts = (await resolvedStates()).map((st) => ({ value: st.id, label: st.internalLabel }));
      } catch (e) {
        statesError = e instanceof Error ? e.message : String(e);
      }
      const backfilledAt = s.resolveOnCloseBackfilledAt();
      return [
        {
          key: "inactivity",
          title: "Customer-idle sweeper",
          fields: [
            { type: "toggle", key: "inactivityEnabled", label: "Enabled", value: s.inactivityEnabled() },
            { type: "number", key: "inactivityCustomerWaitDays", label: "Customer-idle days before nudge", value: s.inactivityCustomerWaitDays(), min: 1, max: 30 },
            { type: "number", key: "inactivityNagsBeforeClose", label: "Nudges before auto-close", value: s.inactivityNagsBeforeClose(), min: 1, max: 10 },
            { type: "text", key: "inactivityNagText", label: "Customer nudge text", value: s.inactivityNagText() ?? "", multiline: true, help: "Blank = built-in default. {days} supported." },
          ],
          actions: [{ key: "run_inactivity", label: "Run sweep now", style: "secondary" }],
        },
        {
          key: "replyState",
          title: "Customer responded state",
          description:
            "A customer reply on an Intercom ticket in Submitted, In progress or Waiting on customer moves it to this state. The next teammate reply (Intercom inbox, or a staff message in the Discord thread) moves it back where it was; Submitted goes to Waiting on customer. Fin, bots and internal notes never count, and a state changed by hand wins over the restore. Discord-bridged tickets also get their Discord status back.",
          ...(statesError ? { notice: { kind: "error" as const, text: `Could not list Intercom ticket states: ${statesError}` } } : {}),
          fields: [
            { type: "toggle", key: "replyStateEnabled", label: "Enabled", value: s.replyStateEnabled() },
            {
              type: "select",
              key: "replyStateCustomerStateId",
              label: "Customer responded state",
              value: s.replyStateCustomerStateId(),
              options: stateOpts,
              nullable: true,
              help: "Must be enabled on every ticket type you use (Intercom → Settings → Tickets). An In progress state is the safe choice: Intercom's own automatic move on a customer reply only starts from Waiting on customer and Resolved.",
            },
          ],
          actions: [{ key: "sync_reply_states", label: "Sync now", style: "secondary" }],
        },
        {
          key: "resolveOnClose",
          title: "Resolve on close",
          description:
            "An Intercom Customer ticket closed outside the Resolved category (Fin's idle close, a Workflow, the customer-idle sweep, a teammate) is moved to this Resolved state; any Resolved state already set is kept. Discord-bridged tickets whose closing status maps elsewhere are resolved too. Runs on every close plus the 5-minute SLA tick; the first sweeps after switching it on resolve the backlog.",
          ...(statesError ? { notice: { kind: "error" as const, text: `Could not list Intercom ticket states: ${statesError}` } } : {}),
          fields: [
            { type: "toggle", key: "resolveOnCloseEnabled", label: "Enabled", value: s.resolveOnCloseEnabled() },
            {
              type: "select",
              key: "resolveOnCloseStateId",
              label: "State for closed tickets",
              value: s.resolveOnCloseStateId(),
              options: closeStateOpts,
              nullable: true,
              help: "(none) = each ticket type's own Resolved state. A type that does not have the picked state enabled also gets its own.",
            },
            {
              type: "static",
              key: "resolveOnCloseStatus",
              label: "Backfill and last sweep",
              value: `Backfill ${backfilledAt ? `done ${backfilledAt.toISOString().slice(0, 10)}` : "pending"} · last sweep ${deps.lastCloseSweep()}`,
            },
          ],
        },
      ];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      switch (req.field) {
        case "inactivityEnabled":
          await s.updateInactivity({ inactivityEnabled: v === true });
          await ctx.audit(`inactivity sweeper → ${v === true}`);
          return { ok: true };
        case "inactivityCustomerWaitDays": {
          const parsed = asBoundedInt(v, 1, 30);
          if (!parsed.ok) return { ok: false, fieldErrors: { [req.field]: parsed.error } };
          await s.updateInactivity({ inactivityCustomerWaitDays: parsed.value });
          await ctx.audit(`set ${req.field} → ${parsed.value}`);
          return { ok: true };
        }
        case "inactivityNagsBeforeClose": {
          const parsed = asBoundedInt(v, 1, 10);
          if (!parsed.ok) return { ok: false, fieldErrors: { inactivityNagsBeforeClose: parsed.error } };
          await s.updateInactivity({ inactivityNagsBeforeClose: parsed.value });
          await ctx.audit(`set nags-before-close → ${parsed.value}`);
          return { ok: true };
        }
        case "inactivityNagText":
          await s.updateInactivity({ inactivityNagText: asString(v) || null });
          await ctx.audit(`set ${req.field}`);
          return { ok: true };
        case "replyStateEnabled":
          if (v === true && !s.replyStateCustomerStateId()) {
            return { ok: false, fieldErrors: { replyStateEnabled: "Pick the Customer responded state first." } };
          }
          await s.updateReplyState({ replyStateEnabled: v === true });
          await ctx.audit(`customer-responded state → ${v === true}`);
          return { ok: true };
        case "replyStateCustomerStateId": {
          const id = asOptionalId(v);
          if (id == null) {
            // Clearing the state switches the feature off with it.
            await s.updateReplyState({ replyStateCustomerStateId: null, replyStateEnabled: false });
            await ctx.audit("customer-responded state cleared (feature off)");
            return { ok: true };
          }
          let state: IntercomTicketState | undefined;
          try {
            state = (await pickable()).find((st) => st.id === id);
          } catch (e) {
            return { ok: false, error: `Could not list Intercom ticket states: ${e instanceof Error ? e.message : String(e)}` };
          }
          if (!state) return { ok: false, fieldErrors: { replyStateCustomerStateId: "Not a live, non-resolved Intercom ticket state." } };
          await s.updateReplyState({ replyStateCustomerStateId: state.id });
          await ctx.audit(`customer-responded state → ${state.internalLabel} (${state.id})`);
          return { ok: true };
        }
        case "resolveOnCloseEnabled":
          await s.updateResolveOnClose({ resolveOnCloseEnabled: v === true });
          await ctx.audit(`resolve on close → ${v === true}`);
          return { ok: true };
        case "resolveOnCloseStateId": {
          const id = asOptionalId(v);
          if (id == null) {
            await s.updateResolveOnClose({ resolveOnCloseStateId: null });
            await ctx.audit("resolve-on-close state → auto");
            return { ok: true };
          }
          let state: IntercomTicketState | undefined;
          try {
            state = (await resolvedStates()).find((st) => st.id === id);
          } catch (e) {
            return { ok: false, error: `Could not list Intercom ticket states: ${e instanceof Error ? e.message : String(e)}` };
          }
          if (!state) return { ok: false, fieldErrors: { resolveOnCloseStateId: "Not a live, Resolved-category Intercom ticket state." } };
          await s.updateResolveOnClose({ resolveOnCloseStateId: state.id });
          await ctx.audit(`resolve-on-close state → ${state.internalLabel} (${state.id})`);
          return { ok: true };
        }
        default:
          return { ok: false, error: "Unknown field." };
      }
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      if (req.key === "run_inactivity") {
        await ctx.audit("manual customer-idle sweep");
        return { ok: true, text: await deps.runInactivityNow() };
      }
      if (req.key === "sync_reply_states") {
        if (!ctx.settings.replyStateActive()) {
          return { ok: false, error: "Turn the customer-responded state on and pick its state first." };
        }
        await ctx.audit("customer-responded sync run");
        return { ok: true, text: await deps.syncReplyStates() };
      }
      return { ok: false, error: "Unknown action." };
    },
  };
}
