import { Badge, Opt, Section } from "../renderer/contract";
import { ActionResult, SaveResult } from "../renderer/contract";
import { envPin, envPinNote } from "../../config/env";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asBoundedFloat, asString, oneOf } from "./types";

// Integrations hub (config group): the Intercom CONNECTION (bridge/SLA/automation
// live in the /intercom hubs) + Sentry + the Postiz platform lookup. Mirrors
// /config → Integrations.

export interface IntegrationsHubDeps {
  listIntercomAdmins: () => Promise<Array<{ id: string; name: string }>>;
  reconfigureSentry: () => Promise<string>;
  // Probes the platform search endpoint and reports which of its gates
  // (key valid / org has a superadmin / org has a subscription) let us through.
  testPostiz: () => Promise<string>;
}

// POSTIZ_ADMIN_TOKEN overrides the stored key (see config/env.ts). The field
// stays editable so the value is ready the moment the variable is removed; the
// badge is what keeps the panel honest about which one is actually in force.
const postizKeyBadge = (): Badge | undefined => {
  const name = envPin("postizApiKey");
  return name ? { kind: "warn", text: `env: ${name}` } : undefined;
};

const REGIONS = ["us", "eu", "au"] as const;

export function makeIntegrationsHub(deps: IntegrationsHubDeps): HubModule {
  return {
    hub: "integrations",
    group: "config",
    title: "Integrations",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      let adminOpts: Opt[] = [];
      let adminNote: string | undefined;
      try {
        adminOpts = (await deps.listIntercomAdmins()).map((a) => ({ value: a.id, label: a.name }));
      } catch {
        adminNote = "Admin list unavailable. Check the access token.";
      }
      const intercom: Section = {
        key: "intercom",
        title: "Intercom connection",
        description: "Bridge, SLA, automation and maintenance moved to the /intercom hubs. This is only the connection.",
        fields: [
          { type: "text", key: "intercomAccessToken", label: "Access token", value: "", secret: true, secretState: s.secretState("intercomAccessToken") },
          { type: "text", key: "intercomClientSecret", label: "Client secret", value: "", secret: true, secretState: s.secretState("intercomClientSecret") },
          {
            type: "select",
            key: "intercomAdminId",
            label: "Fallback / authoring admin",
            value: s.intercomAdminId(),
            options: adminOpts,
            nullable: true,
            help: adminNote,
          },
          {
            type: "select",
            key: "intercomRegion",
            label: "Region",
            value: s.intercomRegion(),
            options: [
              { value: "us", label: "US" },
              { value: "eu", label: "EU" },
              { value: "au", label: "AU" },
            ],
          },
        ],
      };
      const sentry: Section = {
        key: "sentry",
        title: "Sentry",
        fields: [
          {
            type: "text",
            key: "sentryDsn",
            label: "DSN",
            value: "",
            secret: true,
            secretState: s.sentryDsn() ? "local" : "none",
            help: "Write-only. Leave blank to keep; type 'none' to clear.",
          },
          { type: "text", key: "sentryEnvironment", label: "Environment", value: s.sentryEnvironment() },
          { type: "number", key: "sentryTracesSampleRate", label: "Traces sample rate", value: s.sentryTracesSampleRate(), min: 0, max: 1, step: 0.01 },
          { type: "number", key: "sentryProfilesSampleRate", label: "Profiles sample rate", value: s.sentryProfilesSampleRate(), min: 0, max: 1, step: 0.01 },
          { type: "toggle", key: "sentryLogsEnabled", label: "Send logs", value: s.sentryLogsEnabled() },
          { type: "toggle", key: "sentryDebug", label: "Debug", value: s.sentryDebug() },
          { type: "toggle", key: "sentrySendDefaultPii", label: "Send default PII", value: s.sentrySendDefaultPii() },
          { type: "toggle", key: "sentryAiRecordContent", label: "Record AI request/response content", value: s.sentryAiRecordContent() },
        ],
        actions: [{ key: "sentry_test", label: "Reload & test Sentry", style: "secondary" }],
      };
      const postiz: Section = {
        key: "postiz",
        title: "Postiz platform lookup",
        description:
          "Resolves a support contact to a Postiz account (user, organization and plan). The API key's organization must contain a superadmin user and hold a subscription.",
        fields: [
          {
            type: "toggle",
            key: "postizLookupEnabled",
            label: "Enabled",
            value: s.postizLookupEnabled(),
            help: "Off means no lookups run and tickets keep null identity columns.",
          },
          {
            type: "text",
            key: "postizBaseUrl",
            label: "Backend base URL",
            value: s.postizBaseUrl() ?? "",
            help: "Origin the /public/v1 routes hang off, for example https://api.postiz.com. Point at the backend, not the frontend.",
          },
          {
            type: "text",
            key: "postizApiKey",
            label: "API key",
            value: "",
            secret: true,
            secretState: s.secretState("postizApiKey"),
            badge: postizKeyBadge(),
            help: envPinNote("postizApiKey") ?? "Write-only. Blank = keep; type 'none' to clear.",
          },
        ],
        actions: [{ key: "postiz_test", label: "Test connection", style: "secondary" }],
      };
      return [intercom, sentry, postiz];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      switch (req.field) {
        case "intercomAccessToken":
        case "intercomClientSecret": {
          const val = asString(v);
          if (!val) return { ok: true }; // blank = keep
          await s.updateIntercom({ [req.field]: val === "none" ? null : val });
          await ctx.audit(`updated ${req.field}`);
          return { ok: true };
        }
        case "intercomAdminId": {
          const id = asString(v) || null;
          await s.updateIntercom({ intercomAdminId: id });
          await ctx.audit(`set intercom authoring admin → ${id ?? "none"}`);
          return { ok: true };
        }
        case "intercomRegion": {
          const region = oneOf(v, REGIONS);
          if (!region) return { ok: false, fieldErrors: { intercomRegion: "Pick US, EU or AU." } };
          await s.updateIntercom({ intercomRegion: region });
          await ctx.audit(`set intercom region → ${region}`);
          return { ok: true };
        }
        case "sentryDsn": {
          const val = asString(v);
          if (!val) return { ok: true };
          await s.updateSentry({ sentryDsn: val === "none" ? null : val });
          await ctx.audit("updated sentry dsn");
          return { ok: true };
        }
        case "sentryEnvironment":
          await s.updateSentry({ sentryEnvironment: asString(v) });
          await ctx.audit("set sentry environment");
          return { ok: true };
        case "sentryTracesSampleRate":
        case "sentryProfilesSampleRate": {
          const parsed = asBoundedFloat(v, 0, 1);
          if (!parsed.ok) return { ok: false, fieldErrors: { [req.field]: parsed.error } };
          await s.updateSentry({ [req.field]: parsed.value });
          await ctx.audit(`set ${req.field} → ${parsed.value}`);
          return { ok: true };
        }
        case "sentryLogsEnabled":
        case "sentryDebug":
        case "sentrySendDefaultPii":
        case "sentryAiRecordContent":
          await s.updateSentry({ [req.field]: v === true });
          await ctx.audit(`set ${req.field} → ${v === true}`);
          return { ok: true };
        case "postizLookupEnabled":
          await s.updatePostiz({ postizLookupEnabled: v === true });
          await ctx.audit(`set postiz lookup → ${v === true ? "on" : "off"}`);
          return { ok: true };
        case "postizBaseUrl": {
          const raw = asString(v);
          const url = raw === "none" ? null : raw || null;
          if (url && !/^https?:\/\//i.test(url)) {
            return { ok: false, fieldErrors: { postizBaseUrl: "Enter a full http(s) URL." } };
          }
          await s.updatePostiz({ postizBaseUrl: url });
          // The URL is not a secret, but the key it is used with is, so the
          // audit line records the change without echoing either.
          await ctx.audit(`set postiz base url → ${url ?? "none"}`);
          return { ok: true };
        }
        case "postizApiKey": {
          const val = asString(v);
          if (!val) return { ok: true }; // blank = keep
          await s.updatePostiz({ postizApiKey: val === "none" ? null : val });
          await ctx.audit(val === "none" ? "cleared postiz api key" : "updated postiz api key");
          return { ok: true };
        }
        default:
          return { ok: false, error: "Unknown field." };
      }
    },

    async action(_ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      if (req.key === "sentry_test") {
        const msg = await deps.reconfigureSentry();
        return { ok: true, text: msg };
      }
      if (req.key === "postiz_test") {
        return { ok: true, text: await deps.testPostiz() };
      }
      return { ok: false, error: "Unknown action." };
    },
  };
}
