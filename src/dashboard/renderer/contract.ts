// Shared server+client contract for the Stripe dashboard's generic renderer.
// The SERVER (section modules in ../sections/*) decides every block, cell and
// button; the CLIENT (inline JS assembled in ../html/) is a dumb renderer that
// draws whatever it's handed and posts interactions back. All dynamic text is
// rendered via textContent on the client — never innerHTML with data.
//
// Deliberately independent from the admin panel's renderer/contract.ts: that
// one is form-centric (settings fields), this one is read-centric (tables,
// detail pages, timelines) with actions attached. The two panels must be able
// to evolve without breaking each other — the shared part is the transport
// (panelMount.ts), not the UI contract.
//
// Keep this file dependency-free: it is imported by server code and is the
// type reference the client JS strings are written against.

export type Badge = { kind: "info" | "warn" | "error" | "ok" | "neutral"; text: string };
export type Opt = { value: string; label: string };

// Internal navigation target — the ONLY thing the client router accepts. The
// client resolves it to a hash route (#/<page>/<params.id>?f_…); free-form
// URLs never come from the server except explicit external links.
export interface ObjectRef {
  page: string; // e.g. "customers.detail"
  params?: Record<string, string>; // e.g. { id: "cus_…" }
  // Pre-applied list filters ("view this customer's payments", the change-plan
  // row picker) — serialized as f_<key> hash params.
  filters?: Record<string, string>;
}

// One rendered table/kv cell.
export type Cell =
  | { t: "text"; v: string; sub?: string; strong?: boolean } // strong = Stripe's bold dark object name
  | { t: "money"; v: string; tone?: "pos" | "neg" | "muted" }
  // Stripe amount atom: bold amount + faint ISO code, optionally the status
  // pill in the SAME cell ("€29.00 EUR  [Succeeded ✓]" — the Payments look).
  | { t: "amount"; v: string; cur: string; badge?: Badge }
  | { t: "badge"; b: Badge }
  | { t: "flags"; badges: Badge[] }
  | { t: "date"; v: string; iso: string } // v = preformatted absolute; client renders relative w/ hover
  | { t: "id"; v: string; ref?: ObjectRef; copy?: boolean }
  | { t: "link"; v: string; ref: ObjectRef }
  | { t: "external"; v: string; href: string; copy?: boolean } // explicit external link (Discord/Intercom/Stripe-hosted); copy copies the href
  // Card-brand chip + masked last4 ("VISA ···· 4242").
  | { t: "card"; brand: string; last4: string; sub?: string }
  // Object-icon avatar before a bold name (products, subscriptions, customers).
  | { t: "avatar"; icon: "customer" | "product" | "invoice" | "subscription"; v: string; sub?: string; ref?: ObjectRef };

export type InputField =
  | { type: "text"; key: string; label: string; placeholder?: string; multiline?: boolean; maxLength?: number }
  | { type: "number"; key: string; label: string; min?: number; max?: number; placeholder?: string }
  | { type: "select"; key: string; label: string; options: Opt[]; value?: string }
  | { type: "toggle"; key: string; label: string; value?: boolean };

export interface ActionButton {
  key: string; // registry key ("charge.refund_full") or section key ("section:notes.add")
  label: string;
  style?: "primary" | "secondary" | "danger";
  dangerous?: boolean; // typed-CONFIRM in the web modal (T1)
  stepUp?: boolean; // fresh-factor re-assert required (T2) — client runs the step-up flow first
  reverseConfirm?: boolean; // ALSO requires the Discord reverse code (T3)
  mode?: "direct" | "queue"; // advisory rendering ("(request approval)") — server re-checks
  inputs?: InputField[];
  // Server-baked binding (object ids). The client may only ADD input values —
  // baked params always win server-side.
  params?: Record<string, unknown>;
  summary?: string;
  disabledReason?: string; // render disabled with a tooltip instead of hiding
  // Client-special flows that need browser APIs (WebAuthn) instead of the
  // generic modal: "passkey-register" runs the create() ceremony.
  special?: "passkey-register";
}

export interface HeaderBlock {
  type: "header";
  title: string;
  titleSuffix?: string; // faint inline suffix after the title (currency code after an amount)
  sub?: string; // muted line under the title (customer email, "Charged to …")
  subCopy?: boolean; // copy affordance on the sub line
  id?: string; // mono object id with a copy button
  badges?: Badge[];
  actions?: ActionButton[];
}
export interface StatsBlock {
  type: "stats";
  items: Array<{ label: string; value: string; sub?: string; badge?: Badge; ref?: ObjectRef }>;
}
export interface FilterDef {
  key: string;
  label: string;
  // select/text render as Stripe "⊕ Label" pills with a popover; search renders
  // as the wide standalone search box (Customers-list style).
  kind: "select" | "text" | "search";
  options?: Opt[]; // select only
  value?: string; // current value (echoed back by the client)
  placeholder?: string; // text/search only
}
export interface TableBlock {
  type: "table";
  key: string; // reload scope for filter/cursor changes (one table per page may paginate)
  title?: string;
  columns: Array<{ key: string; label: string; align?: "left" | "right" }>;
  rows: Array<{ id: string; cells: Cell[]; ref?: ObjectRef; actions?: ActionButton[] }>;
  // Stripe count-card segmented filter (the LIST-archetype status row). A card
  // click sets filters[counts.key] = value; value "" = the All card.
  counts?: { key: string; items: Array<{ value: string; label: string; count: number | string }> };
  filters?: FilterDef[];
  nextCursor?: string | null; // opaque Stripe cursor; client keeps its own back-stack
  empty?: string; // shown when rows is empty
  notice?: string; // footnote under the table
  footer?: string; // Stripe "N items" gray count under the table
  footerRef?: ObjectRef; // renders the footer as a link ("3 results" → filtered list page)
}
export interface KeyValueBlock {
  type: "kv";
  title?: string;
  // Rail "Insights" variant: bigger, darker values (Spent €152.00 / MRR €29.00).
  big?: boolean;
  // Stripe "Payment breakdown" variant: label left, amount flush right, the
  // LAST row emphasized as the Net/Total line with a hairline above.
  amounts?: boolean;
  rows: Array<{ label: string; cell: Cell }>;
  actions?: ActionButton[];
}
export interface TimelineBlock {
  type: "timeline";
  title?: string;
  items: Array<{ label: string; iso: string; text?: string; kind?: Badge["kind"]; ref?: ObjectRef }>;
}
export interface NoticeBlock {
  type: "notice";
  badge: Badge;
  text: string;
  actions?: ActionButton[];
}
export interface EmptyBlock {
  type: "empty";
  title: string;
  hint?: string;
}
// Inline-SVG QR (TOTP enrollment). The server pre-renders the module matrix
// into one path string; the client just draws <svg viewBox><path d>. Geometry
// only — CSP-safe, no images.
export interface QrBlock {
  type: "qr";
  path: string; // SVG path data
  size: number; // viewBox edge (modules incl. quiet zone)
  caption?: string;
}
// Lazily-hydrated chart: the page ships only {key, window}; the client POSTs
// `series` and draws inline SVG (area/bars/line). Keeps view builds <500ms.
export interface ChartBlock {
  type: "chart";
  key: string; // HomeMetrics series key ("gross_volume", …)
  title: string;
  kind: "area" | "bars" | "line";
  window: string; // "7d" | "30d" | "90d" — baked from the page's window filter
}
// Stripe tab row under the H1 (active = blurple underline). Tabs write a page
// filter, exactly like count-cards — value "" is the first/default tab.
export interface TabsBlock {
  type: "tabs";
  key: string; // filter key the tabs steer ("view")
  value?: string; // active tab value (echoed back; "" = default)
  items: Array<{ value: string; label: string; badge?: string }>;
}

// ---- dispute evidence workbench (M6.2) ----

// One text-evidence field with its full lifecycle state. draft carries the
// LOCAL draft value, staged what Stripe holds; the client shows draft ?? staged
// in the control and autosaves edits back to the draft on blur.
export interface EvidenceFieldView {
  key: string; // the Stripe evidence key ("product_description")
  label: string;
  multiline: boolean;
  state: "empty" | "draft" | "staged" | "submitted"; // draft = local draft differs from staged
  draft?: string;
  staged?: string;
}
export interface EvidenceGroupView {
  key: string; // catalog group key ("core")
  label: string;
  recommended?: boolean; // ⭐ for this dispute's reason; rendered open
  fields: EvidenceFieldView[];
}
// One FILE evidence slot; fileId present = a proof is staged there.
export interface EvidenceFileSlotView {
  key: string;
  label: string;
  fileId?: string;
}
// The interactive evidence editor. Field edits autosave to the local draft
// (section action, T0); staging/upload/remove are separate ceremonied actions
// the client builds from the baked ids. Files travel as base64 JSON on the
// normal api route — never multipart.
export interface EvidenceBlock {
  type: "evidence";
  disputeId: string;
  editable: boolean; // respondable: controls + stage/upload enabled
  submitted: boolean; // at least one past submission
  groups: EvidenceGroupView[];
  files: EvidenceFileSlotView[];
  maxFileBytes: number;
  fileTypes: string[]; // accepted MIME types for proofs
}

export type Block =
  | HeaderBlock
  | StatsBlock
  | TableBlock
  | KeyValueBlock
  | TimelineBlock
  | NoticeBlock
  | EmptyBlock
  | QrBlock
  | ChartBlock
  | TabsBlock
  | EvidenceBlock;

// ---- series endpoint payloads (chart hydration) ----

export interface SeriesPoint {
  label: string; // x label ("07-14", "Jun")
  v: number; // value in DISPLAY units (major currency units / counts / percent)
}
export interface SeriesBand {
  v: number; // horizontal threshold in display units
  kind: "warn" | "error";
  label: string;
}
export interface SeriesResponse {
  key: string;
  unit: "currency" | "count" | "percent";
  currency?: string; // ISO code when unit=currency
  points: SeriesPoint[];
  bands?: SeriesBand[];
  note?: string; // truncation/estimate footnote
  stale?: boolean; // served from an expired cache while refreshing
}

export interface Crumb {
  label: string;
  ref?: ObjectRef; // absent on the leaf
  copyId?: string; // leaf object id → copy button next to the crumb
}

// One sidebar entry. group "" = the main block; "Operate" renders under a
// separator label. badge = live count pill ("3"), hidden when absent.
export interface NavItem {
  key: string;
  label: string;
  page: string;
  group?: string;
  badge?: string;
}

export interface PageView {
  page: string;
  title: string;
  crumbs: Crumb[];
  nav: NavItem[];
  activeNav: string; // NavItem.key
  blocks: Block[];
  // Stripe detail-page pattern: blocks placed in the narrow right rail
  // (Details / Insights / related-object cards) beside the main column. When
  // empty the main column spans full width.
  rail?: Block[];
  testMode: boolean; // Stripe TEST-mode banner
  actorLabel: string; // "Enno · admin"
}

// ---- API request/response shapes (POST /dashboard/api/:endpoint) ----

export interface ViewRequest {
  page: string;
  params?: Record<string, string>;
  filters?: Record<string, string>;
  cursor?: string | null;
}

export interface ActionRequest {
  key: string;
  params?: Record<string, unknown>;
  confirmWord?: string;
  reverseCode?: string;
}

export interface ActionResult {
  ok: boolean;
  text?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  needsReverse?: boolean; // destructive reverseConfirm gate not yet satisfied
  needsStepUp?: boolean; // fresh-factor re-assert (T2) not fresh — client runs step-up, then retries
  queued?: boolean; // routed into the approval queue
}

export type DashboardUiState = "locked" | "active" | "expired" | "login";

export interface ActivationStatusResponse {
  state: DashboardUiState;
  adminName: string;
  activationCode?: string; // present only while locked
  passkey?: boolean; // login mode: is the passkey ceremony available?
}

export interface NavBadgesResponse {
  badges: Record<string, string>; // NavItem.key → count label
}
