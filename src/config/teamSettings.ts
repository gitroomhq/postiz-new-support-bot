import type { OfficeHoursSchedule } from "../sla/businessTime";

// Per-team overrides of the workspace-default assignment + office-hours config
// (Intercom Expert had both per-team). Pure helpers so the resolution/merge
// rules are unit-testable without Prisma. A conversation resolves its config
// from its own team; any field absent on the team's entry inherits the
// workspace default, and a team with no entry inherits everything.

export interface ExcludedAdmin {
  id: string;
  name: string;
}

export interface TeamSettingsEntry {
  teamName?: string; // snapshotted for display
  assignEnabled?: boolean;
  assignExcludedAdmins?: ExcludedAdmin[];
  officeHoursEnabled?: boolean;
  officeHoursJson?: OfficeHoursSchedule;
}

// The four fields that make an entry worth persisting (teamName alone is not).
const MEANINGFUL_FIELDS: Array<keyof TeamSettingsEntry> = [
  "assignEnabled",
  "assignExcludedAdmins",
  "officeHoursEnabled",
  "officeHoursJson",
];

export function parseExcludedAdmins(raw: unknown): ExcludedAdmin[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { id: string; name?: unknown } => !!e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string")
    .map((e) => ({ id: e.id, name: typeof e.name === "string" ? e.name : e.id }));
}

// Defensive parse of BotSettings.teamSettingsJson (untrusted column). Unknown
// fields dropped; absent fields left undefined so `?? default` inherits.
export function parseTeamSettingsMap(raw: unknown): Record<string, TeamSettingsEntry> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TeamSettingsEntry> = {};
  for (const [teamId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const e = v as Record<string, unknown>;
    out[teamId] = {
      teamName: typeof e.teamName === "string" ? e.teamName : undefined,
      assignEnabled: typeof e.assignEnabled === "boolean" ? e.assignEnabled : undefined,
      assignExcludedAdmins: Array.isArray(e.assignExcludedAdmins) ? parseExcludedAdmins(e.assignExcludedAdmins) : undefined,
      officeHoursEnabled: typeof e.officeHoursEnabled === "boolean" ? e.officeHoursEnabled : undefined,
      officeHoursJson: e.officeHoursJson != null ? (e.officeHoursJson as OfficeHoursSchedule) : undefined,
    };
  }
  return out;
}

export function isEntryMeaningful(entry: TeamSettingsEntry): boolean {
  return MEANINGFUL_FIELDS.some((f) => entry[f] !== undefined);
}

// Merge a patch into a team's entry; drops the entry entirely if it reverts to
// all-inherit. Returns the new map (does not mutate the input).
export function mergeEntry(
  map: Record<string, TeamSettingsEntry>,
  teamId: string,
  teamName: string | null,
  patch: TeamSettingsEntry
): Record<string, TeamSettingsEntry> {
  const next = { ...map };
  const merged: TeamSettingsEntry = { ...(next[teamId] ?? {}), ...patch };
  if (teamName) merged.teamName = teamName;
  if (isEntryMeaningful(merged)) next[teamId] = merged;
  else delete next[teamId];
  return next;
}

// Remove named fields from a team's entry; drops the entry if nothing
// meaningful remains. Returns the new map.
export function stripFields(
  map: Record<string, TeamSettingsEntry>,
  teamId: string,
  fields: Array<keyof TeamSettingsEntry>
): Record<string, TeamSettingsEntry> {
  const entry = map[teamId];
  if (!entry) return map;
  const next = { ...map };
  const copy = { ...entry };
  for (const f of fields) delete copy[f];
  if (isEntryMeaningful(copy)) next[teamId] = copy;
  else delete next[teamId];
  return next;
}

export function parseCursorMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}
