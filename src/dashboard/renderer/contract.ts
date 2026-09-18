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
  // pre keeps the value's own line breaks (white-space: pre-wrap). Evidence
  // text is written in paragraphs and read by a bank analyst, so the operator
  // has to see the shape they will see; every other text cell is one line and
  // collapses as before.
  | { t: "text"; v: string; sub?: string; strong?: boolean; pre?: boolean } // strong = Stripe's bold dark object name
  | { t: "money"; v: string; tone?: "pos" | "neg" | "muted" }
  // Stripe amount atom: bold amount + faint ISO code, optionally the status
  // pill in the SAME cell ("€29.00 EUR  [Succeeded ✓]" — the Payments look).
  // major carries the numeric major-unit value so the client can sum selected
  // rows for bulk-action ceremonies without parsing formatted strings.
  | { t: "amount"; v: string; cur: string; badge?: Badge; major?: number }
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
  // `value` prefills the control, which a textarea needs for an EDIT dialog:
  // retyping three thousand characters of policy text is not an edit. `rows`
  // sizes a multiline control.
  | {
      type: "text";
      key: string;
      label: string;
      placeholder?: string;
      multiline?: boolean;
      maxLength?: number;
      value?: string;
      rows?: number;
    }
  | { type: "number"; key: string; label: string; min?: number; max?: number; placeholder?: string }
  | { type: "select"; key: string; label: string; options: Opt[]; value?: string }
  | { type: "toggle"; key: string; label: string; value?: boolean }
  // A file the browser reads and sends inline. The action receives three keys
  // derived from this one: `<key>B64`, `<key>Name` and `<key>Type`. Bounds are
  // enforced client-side for the error message and AGAIN on the server, which
  // is the one that counts.
  | { type: "file"; key: string; label: string; accept: string[]; maxBytes: number };

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
  // Link-button: navigates to a page instead of POSTing an action (composer
  // entry points). Mutually exclusive with inputs/params — nothing is posted.
  ref?: ObjectRef;
}

export interface HeaderBlock {
  type: "header";
  title: string;
  titleSuffix?: string; // faint inline suffix after the title (currency code after an amount)
  sub?: string; // muted line under the title (customer email, "Charged to …")
  subCopy?: boolean; // copy affordance on the sub line
  id?: string; // mono object id with a copy button
  badges?: Badge[];
  // The status-bar row under the title: the facts a page is judged by, on one
  // line, beside the actions rather than stacked above them as notices. Each
  // entry is a label, a short value and an optional pill; a sentence belongs in
  // a NoticeBlock, not here.
  meta?: Array<{ label: string; value: string; badge?: Badge }>;
  actions?: ActionButton[];
}
export interface StatsBlock {
  type: "stats";
  items: Array<{ label: string; value: string; sub?: string; badge?: Badge; ref?: ObjectRef }>;
  // Compact inline variant: one hairline-separated row instead of a card grid.
  // For a strip that is context beside the real content (the dispute ratio)
  // rather than the headline figures of the page itself.
  dense?: boolean;
}
export interface FilterDef {
  key: string;
  label: string;
  // select/text render as Stripe "⊕ Label" pills with a popover; search renders
  // as the wide standalone search box (Customers-list style). daterange is a
  // preset select plus a "Custom…" two-date picker; its value is either a
  // preset token ("7d") or "YYYY-MM-DD..YYYY-MM-DD" in ONE filter key.
  kind: "select" | "text" | "search" | "daterange";
  options?: Opt[]; // select/daterange (daterange: the preset rows)
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
  // Stripe list-toolbar affordances (client-side; the server just opts in):
  selectable?: boolean; // leading checkbox column + a "N selected" bulk bar
  exportable?: boolean; // header "Export" → client CSV of the currently-rendered rows
  editableColumns?: boolean; // header "Edit columns" → client show/hide, persisted per `key`
  // Optional server actions over the selected row ids. The client injects the
  // selected ids as params.ids (money-moving bulk ops still ride the tier ladder
  // server-side); the built-in "Export selected" is always available when selectable.
  bulkActions?: ActionButton[];
}
export interface KeyValueBlock {
  type: "kv";
  title?: string;
  // Rail "Insights" variant: bigger, darker values (Spent €152.00 / MRR €29.00).
  big?: boolean;
  // Stripe "Payment breakdown" variant: label left, amount flush right, the
  // LAST row emphasized as the Net/Total line with a hairline above.
  amounts?: boolean;
  // Folded away behind its own title until the reader asks for it. For a block
  // that answers a question nobody has yet (how a package came to be built the
  // way it was) but must still be one click from the thing it explains.
  // Requires a title: there would otherwise be nothing to click.
  collapsed?: boolean;
  rows: Array<{ label: string; cell: Cell }>;
  actions?: ActionButton[];
}
export interface TimelineBlock {
  type: "timeline";
  title?: string;
  // Show only the three most RECENT entries, the rest behind an expander. The
  // client picks them by `iso` rather than by position and then draws them in
  // the order given, so this means the same thing whichever way a section
  // sorted its items.
  collapsed?: boolean;
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
// filter, exactly like count-cards — value "" is the first/default tab. A tab
// with a ref navigates to another page instead (cross-section tab rows, e.g.
// Payments → Payouts).
export interface TabsBlock {
  type: "tabs";
  key: string; // filter key the tabs steer ("view")
  value?: string; // active tab value (echoed back; "" = default)
  items: Array<{ value: string; label: string; badge?: string; ref?: ObjectRef }>;
}

// ---- dispute evidence workbench ----

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
  // A full-page navigation instead of SPA routing. Used for surfaces that live
  // under the same login and the same path prefix but render their own shell,
  // which is currently the configuration panel.
  href?: string;
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
  // Small binary download riding the JSON action channel (quote PDFs). The
  // client decodes b64 → Blob → <a download>; old clients ignore unknown keys.
  file?: { name: string; mime: string; b64: string };
  // Follow-up anchor rendered into the success flash (short-lived report
  // links). textContent + rel="noopener" on the client — never innerHTML.
  link?: { href: string; label: string };
}

export type DashboardUiState = "locked" | "active" | "expired" | "login";

export interface ActivationStatusResponse {
  state: DashboardUiState;
  adminName: string;
  activationCode?: string; // present only while locked
  passkey?: boolean; // login mode: is the passkey ceremony available?
  yubikey?: boolean; // login mode: is YubiKey OTP sign-in configured?
}

export interface NavBadgesResponse {
  badges: Record<string, string>; // NavItem.key → count label
  // Needs-attention items for the topbar bell (collected from module
  // attention() hooks, newest-first, capped at 15). Rides the same 60s poll
  // as the badges — one request feeds both.
  attention?: AttentionItem[];
}

// One needs-attention row (bell popover): what, how bad, when, where to go.
export interface AttentionItem {
  label: string;
  badge: Badge;
  iso: string;
  ref: ObjectRef;
}

// Hover peek card payload (the `peek` endpoint). Lines are plain text —
// last4 at most, never full PANs or secrets.
export interface PeekResponse {
  title: string;
  badge?: Badge;
  lines: string[]; // ≤5
}
