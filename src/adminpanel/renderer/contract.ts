// Shared server+client contract for the admin web panel's generic form renderer.
// The SERVER (section builders in ../sections/*) decides every control; the
// CLIENT (inline JS in ../adminPanelHtml.ts) is a dumb renderer that draws
// whatever it's handed and posts changes back. All dynamic text is rendered via
// textContent on the client — never innerHTML with data.
//
// Keep this file dependency-free: it is imported by both Node (server) and is
// the type reference the client JS is written against.

export type Badge = { kind: "info" | "warn" | "error" | "ok"; text: string };
export type Opt = { value: string; label: string; description?: string };

/** Write-only secret state — a secret field NEVER ships its value.
 *  Mirrors SettingsStore.SecretState exactly. */
export type SecretState = "none" | "local" | "vault" | "vault-unreachable" | "local-unreadable";

export interface ToggleField {
  type: "toggle";
  key: string;
  label: string;
  value: boolean;
  help?: string;
  disabled?: boolean;
}
export interface TextField {
  type: "text";
  key: string;
  label: string;
  value: string; // ALWAYS "" when secret
  help?: string;
  disabled?: boolean;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
  pattern?: string;
  secret?: boolean;
  secretState?: SecretState;
}
export interface NumberField {
  type: "number";
  key: string;
  label: string;
  value: number | null; // null = unset (e.g. guardrail disabled)
  help?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  nullable?: boolean;
  unit?: string;
}
export interface SelectField {
  type: "select";
  key: string;
  label: string;
  value: string | null;
  options: Opt[];
  help?: string;
  disabled?: boolean;
  nullable?: boolean;
}
export interface MultiSelectField {
  type: "multiselect";
  key: string;
  label: string;
  values: string[];
  options: Opt[];
  help?: string;
  disabled?: boolean;
  max?: number;
}
export interface ChannelRoleField {
  type: "channel-select" | "role-select";
  key: string;
  label: string;
  value: string | null;
  options: Opt[]; // injected from the guild snapshot
  help?: string;
  disabled?: boolean;
  nullable?: boolean;
}
export interface StaticField {
  type: "static";
  key: string;
  label: string;
  value: string; // read-only status line
  badge?: Badge;
  help?: string;
}
export interface ListRow {
  id: string;
  cells: Array<string | Badge>;
  rowActions: ActionButton[];
}
export interface ListField {
  type: "list";
  key: string;
  label: string;
  columns: string[];
  rows: ListRow[];
  help?: string;
  addAction?: ActionButton;
  reorderable?: boolean;
  // Enables drag-and-drop reordering: the client calls upKey/downKey (each a
  // single-step move action `{id}`) the right number of times on drop.
  reorder?: { upKey: string; downKey: string };
  nextCursor?: string | null;
  prevCursor?: string | null;
}
export interface SlaConditionBuilderField {
  type: "sla-condition-builder";
  key: string;
  label: string;
  dimensions: Array<{
    key: string;
    label: string;
    kind: "enum" | "boolean" | "number" | "text";
    ops: Array<{ op: string; label: string }>;
    hint?: string;
    needsOptions: boolean;
  }>;
  conditions: Array<{ dim: string; op: string; value: string; display: string }>;
  expression: string;
  expressionErrors?: Array<{ pos: number; len: number; message: string; hint?: string }>;
}

export type FieldDescriptor =
  | ToggleField
  | TextField
  | NumberField
  | SelectField
  | MultiSelectField
  | ChannelRoleField
  | StaticField
  | ListField
  | SlaConditionBuilderField;

export interface ActionButton {
  key: string; // dispatched to POST /admin/panel/api/action
  label: string;
  style?: "primary" | "secondary" | "danger";
  dangerous?: boolean; // requires a typed CONFIRM in the web modal
  reverseConfirm?: boolean; // ALSO requires the Discord→web reverse code ("force both")
  inputs?: FieldDescriptor[]; // collected in the web modal before dispatch (no 5-input cap)
  params?: Record<string, unknown>;
  summary?: string;
}

export interface Section {
  key: string;
  title: string;
  description?: string;
  fields: FieldDescriptor[];
  actions?: ActionButton[];
  notice?: Badge;
}

export interface HubView {
  hub: string; // e.g. "general"
  title: string;
  group: "config" | "intercom";
  tabs?: Array<{ key: string; label: string }>; // sibling hubs in this group's nav
  activeTab?: string;
  scope?: { key: string; label: string; options: Opt[]; value: string }; // per-team selector
  sections: Section[];
}

// ---- API request/response shapes (POST /admin/panel/api/:endpoint) ----

export interface ActivationStatusResponse {
  state: AdminSessionUiState;
  adminName: string;
  activationCode?: string; // present only while locked
  group?: "config" | "intercom";
}
export type AdminSessionUiState = "locked" | "active" | "expired";

export interface SaveResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  view?: HubView; // fresh view so side effects re-render
}
export interface ActionResult {
  ok: boolean;
  text?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  needsReverse?: boolean; // destructive reverseConfirm gate not yet satisfied
  view?: HubView;
}
