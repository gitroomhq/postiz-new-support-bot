// Client module: hash router, nav/crumb rendering, jump-to-ID, activation
// poll, nav-badge poll and boot. Hash convention (mirrors ObjectRef):
//   #/customers                → page "customers"
//   #/customers/cus_123        → page "customers.detail", params { id }
//   #/customers/cus_123/portal → page "customers.portal", params { id }
//   #/invoices/new             → page "invoices.new" (id-less subpage)
// The second segment is an object id ONLY when it looks like one (Stripe ids
// always carry an underscore); otherwise it names an id-less subpage like
// "new" — that keeps #/subscriptions/new ≠ subscriptions.detail{id:"new"}.
// Filters serialize as query params (f_<key>=<value>). Cursors stay in memory.

export const clientApp = `
D.parseHash = function () {
  var h = location.hash.replace(/^#\\/?/, "");
  var qIdx = h.indexOf("?");
  var query = "";
  if (qIdx >= 0) { query = h.slice(qIdx + 1); h = h.slice(0, qIdx); }
  var seg = h.split("/").filter(function (s) { return s.length > 0; }).map(decodeURIComponent);
  var page, params = {};
  if (seg.length === 0) page = D.defaultPage;
  else if (seg.length === 1) page = seg[0];
  else if (seg.length === 2 && seg[1].indexOf("_") < 0) page = seg[0] + "." + seg[1];
  else if (seg.length === 2) { page = seg[0] + ".detail"; params.id = seg[1]; }
  else { page = seg[0] + "." + seg[2]; params.id = seg[1]; }
  var filters = {};
  if (query) {
    query.split("&").forEach(function (kv) {
      var eq = kv.indexOf("=");
      if (eq <= 0) return;
      var k = decodeURIComponent(kv.slice(0, eq));
      var v = decodeURIComponent(kv.slice(eq + 1));
      if (k.indexOf("f_") === 0 && v) filters[k.slice(2)] = v;
    });
  }
  return { page: page, params: params, filters: filters };
};

D.hashFor = function (page, params, filters) {
  var parts = page.split(".");
  var seg = [parts[0]];
  if (params && params.id) seg.push(params.id);
  if (parts.length > 1 && parts[1] !== "detail") seg.push(parts[1]);
  var h = "#/" + seg.map(encodeURIComponent).join("/");
  var fs = [];
  Object.keys(filters || {}).forEach(function (k) {
    if (filters[k]) fs.push("f_" + encodeURIComponent(k) + "=" + encodeURIComponent(filters[k]));
  });
  if (fs.length) h += "?" + fs.join("&");
  return h;
};

D.navigateRef = function (ref) {
  if (!ref) return;
  location.hash = D.hashFor(ref.page, ref.params || {}, ref.filters || {});
};

D.applyFilter = function (key, value) {
  var f = {};
  Object.keys(D.state.filters).forEach(function (k) { f[k] = D.state.filters[k]; });
  if (value) f[key] = value; else delete f[key];
  location.hash = D.hashFor(D.state.page, D.state.params, f);
};

D.clearFilters = function () {
  location.hash = D.hashFor(D.state.page, D.state.params, {});
};

D.onHashChange = function () {
  var parsed = D.parseHash();
  var samePage = D.state.page === parsed.page && JSON.stringify(D.state.params) === JSON.stringify(parsed.params);
  var sameFilters = JSON.stringify(D.state.filters) === JSON.stringify(parsed.filters);
  D.state.page = parsed.page;
  D.state.params = parsed.params;
  D.state.filters = parsed.filters;
  if (!samePage || !sameFilters) { D.state.cursor = null; D.state.stack = []; }
  D.loadPage();
};

D.loadPage = function () {
  D.clearFlash();
  var content = D.q("content");
  content.textContent = "";
  content.appendChild(D.el("p", "note", "Loading…"));
  D.api("view", { page: D.state.page, params: D.state.params, filters: D.state.filters, cursor: D.state.cursor })
    .then(function (res) {
      var v = D.handle(res); if (!v) return;
      if (v.error) {
        content.textContent = "";
        content.appendChild(D.el("p", "error", v.error === "unknown page" ? "This page does not exist (yet)." : v.error));
        return;
      }
      D.state.view = v;
      document.title = v.title + " · Billing";
      D.q("who").textContent = "Acting as " + v.actorLabel;
      D.renderNav(v);
      D.renderCrumbs(v);
      // Consistent structure: every page opens with ONE page header. Detail
      // pages send their own header block (badges/id/actions); list pages get
      // one synthesized from the title.
      var blocks = (v.blocks || []).slice();
      var headerBlock = null;
      if (blocks.length && blocks[0].type === "header") { headerBlock = blocks.shift(); }
      else { headerBlock = { type: "header", title: v.title }; }
      content.textContent = "";
      D.renderBlocks(content, [headerBlock]);
      // Stripe detail layout: main column + right rail (Details/Insights).
      if (v.rail && v.rail.length) {
        var grid = D.el("div", "detailgrid");
        var mainCol = D.el("div", "detailmain");
        var railCol = D.el("aside", "detailrail");
        D.renderBlocks(mainCol, blocks);
        D.renderBlocks(railCol, v.rail);
        grid.appendChild(mainCol); grid.appendChild(railCol);
        content.appendChild(grid);
      } else {
        var wrap = D.el("div", null);
        D.renderBlocks(wrap, blocks);
        content.appendChild(wrap);
      }
    });
};

// Line-style nav icons (16x16, stroke geometry only — CSP-safe, no images),
// keyed by the nav root page.
D.NAV_ICONS = {
  home: "M2.5 8 8 3l5.5 5M4 7.2v6h3v-3.2h2v3.2h3v-6",
  balances: "M2.6 4h10.8M2.6 8h10.8M2.6 12h6.8",
  payments: "M2 4.6h12v6.8H2ZM2 7h12",
  customers: "M8 8.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM3.6 13.4a4.4 4.4 0 0 1 8.8 0",
  subscriptions: "M13 6a5 5 0 1 0 .3 4M13 2.8v3.3h-3.3",
  invoices: "M4 2.6h5l3 3v7.8H4ZM9 2.6V5.7h3M6 8.4h4M6 10.4h4",
  disputes: "M8 2.5 13 4.3v3.5c0 3-2.2 4.8-5 5.7-2.8-.9-5-2.7-5-5.7V4.3ZM8 6v2.6M8 10.6v.3",
  catalog: "M8 2.3 13.4 5 8 7.7 2.6 5ZM2.6 5v6L8 13.7 13.4 11V5",
  approvals: "M8 14.3A6.3 6.3 0 1 0 8 1.7a6.3 6.3 0 0 0 0 12.6ZM5.4 8l1.9 1.9L11 6.2",
  blocklist: "M8 14.3A6.3 6.3 0 1 0 8 1.7a6.3 6.3 0 0 0 0 12.6ZM3.7 3.7l8.6 8.6",
  fraud: "M8 2.5 13 4.3v3.5c0 3-2.2 4.8-5 5.7-2.8-.9-5-2.7-5-5.7V4.3Z",
  bookmarks: "M4.2 2.9h7.6v10.2L8 10.6l-3.8 2.5Z",
  security: "M4.6 7.4V6a3.4 3.4 0 0 1 6.8 0v1.4M3.9 7.4h8.2v6H3.9Z"
};
D.navIcon = function (page) {
  var d = D.NAV_ICONS[(page || "").split(".")[0]];
  if (!d) return null;
  var NS = "http://www.w3.org/2000/svg";
  var box = D.el("span", "navico");
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  var p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.5");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.appendChild(p); box.appendChild(svg);
  return box;
};

D.renderNav = function (v) {
  var nav = D.q("nav");
  nav.textContent = "";
  var lastGroup = "";
  (v.nav || []).forEach(function (item) {
    var group = item.group || "";
    if (group && group !== lastGroup) nav.appendChild(D.el("div", "navsep", group));
    lastGroup = group;
    var b = document.createElement("button");
    b.type = "button";
    var left = D.el("span", "navleft");
    var ico = D.navIcon(item.page);
    if (ico) left.appendChild(ico);
    left.appendChild(D.el("span", "navlabel", item.label));
    b.appendChild(left);
    var count = D.navBadges && D.navBadges[item.key];
    if (count) b.appendChild(D.el("span", "navcount", count));
    if (item.key === v.activeNav) b.classList.add("active");
    b.addEventListener("click", function () { location.hash = D.hashFor(item.page, {}, {}); });
    nav.appendChild(b);
  });
};

D.renderCrumbs = function (v) {
  var el = D.q("crumbs");
  el.textContent = "";
  // A single crumb just repeats the page title — show the trail only when
  // there is an actual path to walk back.
  if (!v.crumbs || v.crumbs.length < 2) return;
  (v.crumbs || []).forEach(function (c, i) {
    if (i > 0) el.appendChild(D.el("span", "sep", "/"));
    if (c.ref) {
      var a = D.el("a", null, c.label);
      a.href = D.refHref(c.ref);
      el.appendChild(a);
    } else {
      el.appendChild(D.el("span", c.copyId ? "mono" : null, c.label));
    }
    if (c.copyId) el.appendChild(D.copyBtn(c.copyId));
  });
};

// ---- nav badges (60s poll while active) ----
D.navBadges = {};
D.badgeTimer = null;
D.pollBadges = function () {
  D.api("nav-badges", {}).then(function (res) {
    if (res.status !== 200 || !res.j || !res.j.badges) return;
    D.navBadges = res.j.badges;
    if (D.state.view) D.renderNav(D.state.view);
  }).catch(function () {});
  D.badgeTimer = setTimeout(D.pollBadges, 60000);
};

// ---- id routes (shared by the palette's fast-path) ----
// D.bindJump lives in clientPalette.ts — the topbar box IS the palette.
D.ID_ROUTES = [
  { re: /^cus_[A-Za-z0-9]+$/, page: "customers.detail" },
  { re: /^(ch|py)_[A-Za-z0-9]+$/, page: "payments.detail" },
  { re: /^pi_[A-Za-z0-9]+$/, page: "payments.detail" },
  { re: /^po_[A-Za-z0-9]+$/, page: "balances.detail" },
  { re: /^sub_[A-Za-z0-9]+$/, page: "subscriptions.detail" },
  { re: /^in_[A-Za-z0-9]+$/, page: "invoices.detail" },
  { re: /^(dp|du)_[A-Za-z0-9]+$/, page: "disputes.detail" }
];

// ---- activation poll + boot ----
D.pollTimer = null;
D.poll = function () {
  D.api("activation-status", {}).then(function (res) {
    var j = res.j;
    if (res.status === 401) { D.showExpired(); return; }
    if (!j) return;
    if (j.state === "login") {
      // No session: standing sign-in.
      D.showLogin(j);
      return;
    }
    if (j.state === "locked") {
      D.q("login").hidden = true;
      D.q("lock").hidden = false; D.q("app").hidden = true;
      if (j.activationCode) D.q("lockcode").textContent = j.activationCode;
      D.pollTimer = setTimeout(D.poll, 3000);
      return;
    }
    if (j.state === "active") {
      D.q("login").hidden = true;
      D.q("lock").hidden = true; D.q("app").hidden = false;
      D.startApp();
      return;
    }
    D.showExpired();
  }).catch(function () { D.pollTimer = setTimeout(D.poll, 5000); });
};

// ---- theme (System → Light → Dark cycle; light IS the Stripe capture) ----
D.THEME_KEY = "billing-theme";
D.applyTheme = function (mode) {
  if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
  else document.documentElement.removeAttribute("data-theme");
  var btn = D.q("themebtn");
  if (btn) btn.textContent = mode === "light" ? "Light" : mode === "dark" ? "Dark" : "Auto";
};
D.storedTheme = function () {
  try {
    var v = localStorage.getItem(D.THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch (e) { return null; }
};
D.bindTheme = function () {
  D.applyTheme(D.storedTheme());
  var btn = D.q("themebtn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var cur = D.storedTheme();
    var next = cur === null ? "light" : cur === "light" ? "dark" : null;
    try {
      if (next) localStorage.setItem(D.THEME_KEY, next);
      else localStorage.removeItem(D.THEME_KEY);
    } catch (e) {}
    D.applyTheme(next);
  });
};

// Activation code: click to copy (pastes straight into the Discord modal).
D.bindLockCode = function () {
  var codeEl = D.q("lockcode");
  codeEl.addEventListener("click", function () {
    var code = codeEl.textContent || "";
    if (!code || code.indexOf("•") >= 0) return;
    var done = function () {
      codeEl.classList.add("copied");
      setTimeout(function () { codeEl.classList.remove("copied"); }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, function () {});
    else done();
  });
};

// Global "+ Create" menu (PA-8): every composer entry point in one place.
// Items navigate to hash routes — modals stay where their pages define them.
D.CREATE_ITEMS = [
  { label: "New customer", page: "customers" },
  { label: "New invoice", page: "invoices.new" },
  { label: "New subscription", page: "subscriptions.new" },
  { label: "New payment link", page: "links" },
  { label: "New quote", page: "quotes" }
];
D.bindCreate = function () {
  var btn = D.q("createbtn");
  var pop = D.q("createmenu");
  if (!btn || !pop) return;
  D.CREATE_ITEMS.forEach(function (item) {
    var mi = D.el("button", "btn menuitem", item.label);
    mi.type = "button";
    mi.addEventListener("click", function () {
      D.closeAllPops();
      location.hash = D.hashFor(item.page, {}, {});
    });
    pop.appendChild(mi);
  });
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    var wasOpen = pop.classList.contains("open");
    D.closeAllPops();
    if (!wasOpen) pop.classList.add("open");
  });
};

D.started = false;
D.startApp = function () {
  if (D.started) return;
  D.started = true;
  D.bindModal();
  D.bindJump();
  D.bindCreate();
  D.q("logout").addEventListener("click", function () {
    // Back to the sign-in screen (standing URL) rather than a dead end.
    D.api("logout", {}).then(function () { location.hash = ""; location.reload(); });
  });
  window.addEventListener("hashchange", D.onHashChange);
  D.onHashChange();
  D.pollBadges();
};

D.bindTheme();
D.bindLogin();
D.bindLockCode();
D.poll();
`;
