// Client module: path router (History API), nav/crumb rendering, jump-to-ID,
// activation poll, nav-badge poll and boot. URL convention (mirrors ObjectRef;
// REAL copyable paths, not hash routes — user decision):
//   /billing/customers            → page "customers"
//   /billing/customers/cus_123    → page "customers.detail", params { id }
//   /billing/customers/cus_1/portal → page "customers.portal", params { id }
//   /billing/invoices/new         → page "invoices.new" (id-less subpage)
// The second segment is an object id ONLY when it looks like one (Stripe ids
// always carry an underscore); otherwise it names an id-less subpage like
// "new" — that keeps /billing/subscriptions/new ≠ detail{id:"new"}.
// Filters serialize as real query params (f_<key>=<value>). Cursors stay in
// memory. Legacy #/… links still parse and are canonicalized on route change.

export const clientApp = `
D.BASE = "/billing";

D.parseRoute = function () {
  var path = location.pathname || "";
  var query = (location.search || "").replace(/^\\?/, "");
  // Legacy hash route (#/customers/cus_1?f_x=y) wins when present — old
  // bookmarks keep working; onRouteChange canonicalizes it to a path.
  if (location.hash && location.hash.indexOf("#/") === 0) {
    var h = location.hash.slice(2);
    var qIdx = h.indexOf("?");
    query = "";
    if (qIdx >= 0) { query = h.slice(qIdx + 1); h = h.slice(0, qIdx); }
    path = D.BASE + "/" + h;
  }
  if (path.indexOf(D.BASE) === 0) path = path.slice(D.BASE.length);
  var seg = path.split("/").filter(function (s) { return s.length > 0; }).map(decodeURIComponent);
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

D.hrefFor = function (page, params, filters) {
  var parts = page.split(".");
  var seg = [parts[0]];
  if (params && params.id) seg.push(params.id);
  if (parts.length > 1 && parts[1] !== "detail") seg.push(parts[1]);
  var href = D.BASE + "/" + seg.map(encodeURIComponent).join("/");
  var fs = [];
  Object.keys(filters || {}).forEach(function (k) {
    if (filters[k]) fs.push("f_" + encodeURIComponent(k) + "=" + encodeURIComponent(filters[k]));
  });
  if (fs.length) href += "?" + fs.join("&");
  return href;
};

D.go = function (href) {
  try { history.pushState({}, "", href); } catch (e) { location.href = href; return; }
  D.onRouteChange();
};

D.navigateRef = function (ref) {
  if (!ref) return;
  D.go(D.hrefFor(ref.page, ref.params || {}, ref.filters || {}));
};

D.applyFilter = function (key, value) {
  var f = {};
  Object.keys(D.state.filters).forEach(function (k) { f[k] = D.state.filters[k]; });
  if (value) f[key] = value; else delete f[key];
  D.go(D.hrefFor(D.state.page, D.state.params, f));
};

D.clearFilters = function () {
  D.go(D.hrefFor(D.state.page, D.state.params, {}));
};

D.onRouteChange = function () {
  var parsed = D.parseRoute();
  // Canonicalize a legacy #/… URL into its path form (copyable, shareable).
  if (location.hash && location.hash.indexOf("#/") === 0) {
    try { history.replaceState({}, "", D.hrefFor(parsed.page, parsed.params, parsed.filters)); } catch (e) {}
  }
  var samePage = D.state.page === parsed.page && JSON.stringify(D.state.params) === JSON.stringify(parsed.params);
  var sameFilters = JSON.stringify(D.state.filters) === JSON.stringify(parsed.filters);
  D.state.page = parsed.page;
  D.state.params = parsed.params;
  D.state.filters = parsed.filters;
  if (!samePage || !sameFilters) { D.state.cursor = null; D.state.stack = []; }
  try { window.dispatchEvent(new CustomEvent("dashroute")); } catch (e) {}
  D.loadPage();
};

// Internal anchors (refHref emits real /billing/… hrefs) SPA-navigate on a
// plain left click; modified clicks and middle clicks keep native new-tab
// behavior — the server serves the shell for any /billing path.
D.bindLinks = function () {
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    while (t && t !== document.body && t.tagName !== "A") t = t.parentNode;
    if (!t || t.tagName !== "A" || t.target === "_blank") return;
    var href = t.getAttribute("href") || "";
    if (href !== D.BASE && href.indexOf(D.BASE + "/") !== 0) return;
    e.preventDefault();
    D.go(href);
  });
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
  links: "M10 4.7h2a3.3 3.3 0 0 1 0 6.6h-2M6 11.3H4a3.3 3.3 0 0 1 0-6.6h2M5.3 8h5.4",
  quotes: "M2.8 3.6h10.4v6.8H8.2L5 13v-2.6H2.8Z",
  approvals: "M8 14.3A6.3 6.3 0 1 0 8 1.7a6.3 6.3 0 0 0 0 12.6ZM5.4 8l1.9 1.9L11 6.2",
  blocklist: "M8 14.3A6.3 6.3 0 1 0 8 1.7a6.3 6.3 0 0 0 0 12.6ZM3.7 3.7l8.6 8.6",
  fraud: "M8 2.5 13 4.3v3.5c0 3-2.2 4.8-5 5.7-2.8-.9-5-2.7-5-5.7V4.3Z",
  portal: "M7 3.2H3.2v9.6h9.6V9M9.8 3.2h3v3M12.8 3.2 7.6 8.4",
  meters: "M3.1 11.6a5.6 5.6 0 1 1 9.8 0M8 10.2l2.6-3.8",
  events: "M8.6 2.2 3.4 9h3.4l-1 4.8L11 7.2H7.6l1-5Z",
  webhooks: "M5.2 10.8a2.1 2.1 0 1 0 2.1 2.1V8.4l2.8-4.6a2.1 2.1 0 1 1 2.6 1.2M4.4 8.5a2.1 2.1 0 1 0 3.5 2.3h5a2.1 2.1 0 1 0 0 .1",
  reports: "M3 13.4h10.8M4.6 13V8.6h2V13M7.9 13V4.6h2V13M11.2 13V6.6h2V13",
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
    b.addEventListener("click", function () { D.go(D.hrefFor(item.page, {}, {})); });
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

// ---- nav badges + bell attention (one 60s poll while active) ----
D.navBadges = {};
D.attention = [];
D.badgeTimer = null;
D.pollBadges = function () {
  D.api("nav-badges", {}).then(function (res) {
    if (res.status !== 200 || !res.j || !res.j.badges) return;
    D.navBadges = res.j.badges;
    D.attention = res.j.attention || [];
    D.syncBell();
    if (D.state.view) D.renderNav(D.state.view);
  }).catch(function () {});
  D.badgeTimer = setTimeout(D.pollBadges, 60000);
};

// ---- needs-attention bell ----
D.syncBell = function () {
  var count = D.q("bellcount");
  if (!count) return;
  var n = D.attention.length;
  count.hidden = n === 0;
  count.textContent = n ? String(n) : "";
};
D.renderBellPop = function (pop) {
  pop.textContent = "";
  if (!D.attention.length) {
    pop.appendChild(D.el("div", "palnote", "Nothing needs attention."));
    return;
  }
  D.attention.forEach(function (it) {
    var row = D.el("button", "btn menuitem bellitem");
    row.type = "button";
    row.appendChild(D.badge(it.badge));
    var lab = D.el("span", "belllabel", it.label);
    lab.title = D.fmtAbs(it.iso);
    row.appendChild(lab);
    row.addEventListener("click", function () {
      D.closeAllPops();
      D.navigateRef(it.ref);
    });
    pop.appendChild(row);
  });
};
D.bindBell = function () {
  var btn = D.q("bellbtn");
  var pop = D.q("bellpop");
  if (!btn || !pop) return;
  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  var p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M8 2.2a3.8 3.8 0 0 0-3.8 3.8v2.4L3 10.6h10l-1.2-2.2V6A3.8 3.8 0 0 0 8 2.2ZM6.6 12.4a1.5 1.5 0 0 0 2.8 0");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.4");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.appendChild(p);
  btn.appendChild(svg);
  var count = D.el("span", "navcount", "");
  count.id = "bellcount";
  count.hidden = true;
  btn.appendChild(count);
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    var wasOpen = pop.classList.contains("open");
    D.closeAllPops();
    if (!wasOpen) { D.renderBellPop(pop); pop.classList.add("open"); }
  });
};

// ---- keyboard shortcuts: g-then-key navigation + ? help ----
D.SHORTCUT_PAGES = { p: "payments", c: "customers", h: "home", b: "balances", i: "invoices", d: "disputes" };
D.gArmedAt = 0;
D.bindShortcuts = function () {
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+K stays with the palette
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (document.querySelector("dialog[open]") && e.key !== "?") return;
    if (e.key === "?") {
      var hm = D.q("helpmodal");
      if (hm && !hm.open) { hm.showModal(); e.preventDefault(); }
      return;
    }
    if (e.key === "g") { D.gArmedAt = Date.now(); return; }
    if (D.gArmedAt && Date.now() - D.gArmedAt < 1500) {
      var page = D.SHORTCUT_PAGES[e.key];
      D.gArmedAt = 0;
      if (page) { e.preventDefault(); D.go(D.hrefFor(page, {}, {})); }
    }
  });
  var help = D.q("helpmodal");
  var close = D.q("helpClose");
  if (close && help) close.addEventListener("click", function () { help.close(); });
};

// ---- mobile hamburger: slides the fixed sidebar in/out ----
D.bindMenu = function () {
  var btn = D.q("menubtn");
  var side = document.querySelector(".side");
  var scrim = D.q("scrim");
  if (!btn || !side) return;
  var close = function () {
    side.classList.remove("open");
    if (scrim) scrim.classList.remove("show");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", function () {
    var open = side.classList.toggle("open");
    if (scrim) scrim.classList.toggle("show", open);
    btn.setAttribute("aria-expanded", String(open));
  });
  if (scrim) scrim.addEventListener("click", close);
  window.addEventListener("dashroute", close);
  var nav = D.q("nav");
  if (nav) nav.addEventListener("click", close);
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

// Global "+ Create" menu: every composer entry point in one place.
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
      D.go(D.hrefFor(item.page, {}, {}));
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
  D.bindBell();
  D.bindShortcuts();
  D.bindMenu();
  D.q("logout").addEventListener("click", function () {
    // Back to the sign-in screen at the panel root (standing URL).
    D.api("logout", {}).then(function () { location.href = D.BASE; });
  });
  D.bindLinks();
  window.addEventListener("popstate", D.onRouteChange);
  // Legacy #/… deep links still fire hashchange — route them too.
  window.addEventListener("hashchange", D.onRouteChange);
  D.onRouteChange();
  D.pollBadges();
};

D.bindTheme();
D.bindLogin();
D.bindLockCode();
D.poll();
`;
