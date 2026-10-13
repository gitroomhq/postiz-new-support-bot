import type {
  ActionButton,
  Badge,
  Cell,
  Crumb,
  EmptyBlock,
  FilterDef,
  NavItem,
  NoticeBlock,
  ObjectRef,
  StatsBlock,
  TabsBlock,
} from "../dashboard/renderer/contract";

// The Intercom Queue's page contract. It reuses the dashboard's block renderer
// (clientBlocks) and its types, with two additions the queue client handles
// itself:
//  - an "age" cell: a live wait time ("3h 12m") the page keeps ticking;
//  - an href on a button: an external link (Open in Intercom) instead of an
//    action post. The server only ever sets Intercom inbox URLs here.
// Everything else is the dashboard contract unchanged, so the two pages look
// and behave the same.

export type { Badge, ObjectRef, NavItem, Crumb };

export type QueueCell = Cell | { t: "age"; iso: string; sub?: string };

export type QueueAction = ActionButton & { href?: string };

// Sidebar entries carry params: an inbox or a teammate is one page with an id.
export type QueueNavItem = NavItem & { params?: Record<string, string> };

export interface QueueHeaderBlock {
  type: "header";
  title: string;
  sub?: string;
  badges?: Badge[];
  meta?: Array<{ label: string; value: string; badge?: Badge }>;
  actions?: QueueAction[];
}

export interface QueueTableBlock {
  type: "table";
  key: string;
  title?: string;
  columns: Array<{ key: string; label: string; align?: "left" | "right" }>;
  rows: Array<{ id: string; cells: QueueCell[]; ref?: ObjectRef }>;
  counts?: { key: string; items: Array<{ value: string; label: string; count: number | string }> };
  filters?: FilterDef[];
  nextCursor?: string | null;
  empty?: string;
  notice?: string;
  footer?: string;
}

export interface QueueKvBlock {
  type: "kv";
  title?: string;
  rows: Array<{ label: string; cell: QueueCell }>;
  actions?: QueueAction[];
}

export type QueueBlock = QueueHeaderBlock | QueueTableBlock | QueueKvBlock | StatsBlock | TabsBlock | NoticeBlock | EmptyBlock;

export interface QueuePageView {
  page: string;
  title: string;
  crumbs: Crumb[];
  nav: QueueNavItem[];
  activeNav: string;
  blocks: QueueBlock[];
  actorLabel: string;
  updatedAt: string; // ISO: when the data was read from Intercom
}

export interface QueueViewRequest {
  page: string;
  params: Record<string, string>;
  filters: Record<string, string>;
  cursor: string | null;
}

export interface QueueActionResult {
  ok: boolean;
  text?: string;
  error?: string;
}
