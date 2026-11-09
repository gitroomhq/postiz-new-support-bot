import type { ActionButton, Badge, Block, Crumb, NavItem } from "../dashboard/renderer/contract";

// The support dashboard's page contract: the dashboard's blocks (rendered by
// the shared clientBlocks), plus three the support client draws itself:
//  - strip: a row of label-over-value facts on a gray fill (Billing details);
//  - change: the pending change request, field by field, with its actions;
//  - searchform: inline fields and a Search button that write page filters.

export interface StripBlock {
  type: "strip";
  title?: string;
  items: Array<{ label: string; value: string; mono?: boolean }>;
}

export interface ChangeBlock {
  type: "change";
  title: string;
  badge: Badge;
  who: string;
  iso: string; // when it was requested (the client shows it relative)
  note?: string;
  columns: [string, string, string];
  rows: Array<{ label: string; now: string; next: string }>;
  actions?: ActionButton[];
}

export interface SearchFormBlock {
  type: "searchform";
  fields: Array<{ key: string; label: string; value?: string; placeholder?: string; mono?: boolean; narrow?: boolean }>;
  submitLabel: string;
}

export type SupportBlock = Block | StripBlock | ChangeBlock | SearchFormBlock;

export interface SupportPageView {
  page: string;
  title: string;
  crumbs: Crumb[];
  nav: NavItem[];
  activeNav: string;
  blocks: SupportBlock[];
  actorLabel: string;
}

export interface SupportViewRequest {
  page: string;
  params: Record<string, string>;
  filters: Record<string, string>;
  cursor: string | null;
}

export interface SupportActionResult {
  ok: boolean;
  text?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  queued?: boolean;
}
