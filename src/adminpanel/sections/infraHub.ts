import { ActionResult, Section, SaveResult } from "../renderer/contract";
import { AdminHubContext, ActionRequest, HubModule, SaveRequest, asString } from "./types";

// Infrastructure hub (config group): Vault secret storage + Temporal worker.
// Mirrors /config → Infrastructure. Secrets/certs are write-only.

export interface InfraHubDeps {
  vaultReconfigure: () => Promise<string>; // apply settings to the live client; returns a status line
  vaultMigrate: () => Promise<string>; // local → Vault (returns a report summary)
  vaultReverse: () => Promise<string>; // Vault → local
  setTemporalEnabled: (on: boolean) => Promise<void>; // worker pause switch
}

export function makeInfraHub(deps: InfraHubDeps): HubModule {
  return {
    hub: "infra",
    group: "config",
    title: "Infrastructure",

    async buildSections(ctx): Promise<Section[]> {
      const s = ctx.settings;
      const vault: Section = {
        key: "vault",
        title: "Vault (secret storage)",
        fields: [
          { type: "toggle", key: "vaultEnabled", label: "Enabled", value: s.vaultEnabled() },
          { type: "text", key: "vaultAddr", label: "Address", value: s.vaultAddr() ?? "", placeholder: "https://vault.example.com:8200" },
          { type: "text", key: "vaultToken", label: "Token", value: "", secret: true, secretState: s.vaultToken() ? "local" : "none", help: "Write-only. Blank = keep." },
          { type: "text", key: "vaultKvMount", label: "KV mount", value: s.vaultKvMount() },
          { type: "text", key: "vaultKvBasePath", label: "KV base path", value: s.vaultKvBasePath() },
          { type: "text", key: "vaultTransitMount", label: "Transit mount", value: s.vaultTransitMount() },
          { type: "text", key: "vaultTransitKey", label: "Transit key", value: s.vaultTransitKey() },
        ],
        actions: [
          { key: "vault_reload", label: "Reload Vault client", style: "secondary" },
          { key: "vault_migrate", label: "Migrate secrets local → Vault", dangerous: true, reverseConfirm: true, summary: "Copies every stored secret into Vault and flips columns to the vault sentinel." },
          { key: "vault_reverse", label: "Reverse (Vault → local)", dangerous: true, reverseConfirm: true, summary: "Pulls secrets back out of Vault into local-encrypted columns." },
        ],
      };
      const temporal: Section = {
        key: "temporal",
        title: "Temporal (background worker)",
        fields: [
          { type: "toggle", key: "temporalEnabled", label: "Worker enabled", value: s.temporalEnabled(), help: "Off drains the worker; background work pauses." },
          { type: "text", key: "temporalAddress", label: "Address", value: s.temporalAddress() ?? "" },
          { type: "text", key: "temporalNamespace", label: "Namespace", value: s.temporalNamespace() ?? "" },
          { type: "text", key: "temporalTaskQueue", label: "Task queue", value: s.temporalTaskQueue() },
          { type: "text", key: "temporalDeploymentName", label: "Deployment name", value: s.temporalDeploymentName() },
          { type: "text", key: "temporalTlsServerName", label: "TLS server name (SNI)", value: s.temporalTlsServerName() ?? "", placeholder: "optional" },
          { type: "static", key: "temporalCerts", label: "mTLS certs", value: "Managed in Vault KV (PEM cert/key/CA).", badge: { kind: "info", text: "vault-only" } },
        ],
      };
      return [vault, temporal];
    },

    async save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult> {
      const s = ctx.settings;
      const v = req.value;
      switch (req.field) {
        case "vaultEnabled":
          await s.updateVault({ vaultEnabled: v === true });
          await deps.vaultReconfigure().catch(() => {});
          await ctx.audit(`set vault enabled → ${v === true}`);
          return { ok: true };
        case "vaultAddr":
        case "vaultKvMount":
        case "vaultKvBasePath":
        case "vaultTransitMount":
        case "vaultTransitKey":
          await s.updateVault({ [req.field]: asString(v) });
          await deps.vaultReconfigure().catch(() => {});
          await ctx.audit(`set ${req.field}`);
          return { ok: true };
        case "vaultToken": {
          const val = asString(v);
          if (!val) return { ok: true };
          await s.updateVault({ vaultToken: val === "none" ? null : val });
          await deps.vaultReconfigure().catch(() => {});
          await ctx.audit("updated vault token");
          return { ok: true };
        }
        case "temporalEnabled": {
          const on = v === true;
          await s.updateTemporal({ temporalEnabled: on });
          await deps.setTemporalEnabled(on);
          await ctx.audit(`temporal worker → ${on ? "enabled" : "paused"}`);
          return { ok: true };
        }
        case "temporalAddress":
        case "temporalNamespace":
        case "temporalTlsServerName":
          await s.updateTemporal({ [req.field]: asString(v) || null });
          await ctx.audit(`set ${req.field}`);
          return { ok: true };
        case "temporalTaskQueue":
        case "temporalDeploymentName":
          await s.updateTemporal({ [req.field]: asString(v) });
          await ctx.audit(`set ${req.field}`);
          return { ok: true };
        default:
          return { ok: false, error: "Unknown field." };
      }
    },

    async action(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult> {
      switch (req.key) {
        case "vault_reload":
          return { ok: true, text: await deps.vaultReconfigure() };
        case "vault_migrate": {
          if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true, error: "Confirm with the Discord code." };
          const text = await deps.vaultMigrate();
          await ctx.audit("vault migrate local→vault");
          return { ok: true, text };
        }
        case "vault_reverse": {
          if (!ctx.reverse?.satisfied) return { ok: false, needsReverse: true, error: "Confirm with the Discord code." };
          const text = await deps.vaultReverse();
          await ctx.audit("vault reverse vault→local");
          return { ok: true, text };
        }
        default:
          return { ok: false, error: "Unknown action." };
      }
    },
  };
}
