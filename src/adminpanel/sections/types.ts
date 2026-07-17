import { SettingsStore } from "../../config/SettingsStore";
import { GuildSnapshotProvider } from "../guildSnapshot";
import { AdminPanelGroup } from "../AdminPanelTokens";
import { ActionResult, Opt, SaveResult, Section } from "../renderer/contract";

// The identity the mutation is attributed to — snapshotted from the session
// (which was stamped at mint), never taken from the request body.
export interface AdminActor {
  id: string; // Discord user id
  name: string; // display name
  guildId: string;
}

// Per-request context handed to every hub module. Deliberately Discord-free:
// hub modules are thin adapters from a domain service to HubView JSON, so they
// call SettingsStore/SlaRuleStore/etc. — the same services the old Discord hubs
// used — and never touch discord.js.
export interface AdminHubContext {
  settings: SettingsStore;
  guild: GuildSnapshotProvider;
  actor: AdminActor;
  audit(change: string): Promise<void>;
  // For destructive (reverseConfirm) actions: whether a valid Discord→web
  // reverse code was consumed on THIS request. A module's action handler must
  // return { needsReverse: true } when its action is destructive and this is
  // false. Undefined on non-action requests.
  reverse?: { satisfied: boolean };
}

export interface SaveRequest {
  section: string;
  field?: string;
  value?: unknown;
  fields?: Record<string, unknown>;
  scope?: string; // per-team scope (DEFAULT_SETTINGS_SCOPE or a team id)
}

export interface ActionRequest {
  key: string;
  params?: Record<string, unknown>;
  confirmWord?: string;
  scope?: string;
}

// One module per web hub. AdminPanel registers them, assembles the group nav
// (tabs) from the registered set, and dispatches view/save/action.
export interface HubModule {
  readonly hub: string; // stable key, e.g. "general"
  readonly group: AdminPanelGroup;
  readonly title: string;
  buildSections(ctx: AdminHubContext, opts: { tab?: string; scope?: string }): Promise<Section[]>;
  // Per-team hubs (Assignment, office hours) return a scope selector rendered
  // above the sections; changing it reloads the hub with the chosen scope.
  buildScope?(
    ctx: AdminHubContext,
    opts: { tab?: string; scope?: string }
  ): Promise<{ key: string; label: string; options: Opt[]; value: string } | undefined>;
  save(ctx: AdminHubContext, req: SaveRequest): Promise<SaveResult>;
  action?(ctx: AdminHubContext, req: ActionRequest): Promise<ActionResult>;
}

// Small shared validators for section save handlers.
export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
export function asOptionalId(v: unknown): string | null {
  if (v == null || v === "") return null;
  return typeof v === "string" ? v : null;
}
export function asBoundedInt(v: unknown, min: number, max: number): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: "Enter a whole number." };
  if (n < min || n > max) return { ok: false, error: `Must be between ${min} and ${max}.` };
  return { ok: true, value: n };
}

// Like asBoundedInt but allows null (empty input) — for "0/blank = disabled" guardrails.
export function asBoundedIntOrNull(v: unknown, min: number, max: number): { ok: true; value: number | null } | { ok: false; error: string } {
  if (v == null || v === "") return { ok: true, value: null };
  return asBoundedInt(v, min, max);
}

export function asBoundedFloat(v: unknown, min: number, max: number): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return { ok: false, error: "Enter a number." };
  if (n < min || n > max) return { ok: false, error: `Must be between ${min} and ${max}.` };
  return { ok: true, value: n };
}

export function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}
