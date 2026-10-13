// Client module for the Intercom Queue (/queue): router, sidebar, sign-in
// screen, the 60-second refresh and the live wait timers. It runs on top of
// the dashboard's clientCore + clientBlocks + clientModal (same `D`
// namespace, same block renderer), so the two pages look and behave alike.
// Plain vanilla JS as a string (no build step). No backticks or ${} inside:
// the shell embeds this in a template literal. Dynamic text goes through
// textContent, never innerHTML.
//
// URLs (real, copyable paths):
//   /queue                 page "mine"
//   /queue/global          page "global"
//   /queue/inboxes         page "inboxes"
//   /queue/people          page "people"
//   /queue/inbox/<id>      page "inbox.detail", params { id }
//   /queue/person/<id>     page "person.detail", params { id }
// Filters ride the query string as f_<key>=<value>; cursors stay in memory.

export const queueClient = `
D.BASE = "/queue";
D.defaultPage = "mine";

D.parseRoute = function () {
  var path = location.pathname || "";
  if (path.indexOf(D.BASE) === 0) path = path.slice(D.BASE.length);
  var seg = path.split("/").filter(function (s) { return s.length > 0; }).map(function (s) {
    try { return decodeURIComponent(s); } catch (e) { return ""; }
  });
  var page = D.defaultPage, params = {};
  if (seg.length >= 2 && (seg[0] === "inbox" || seg[0] === "person")) { page = seg[0] + ".detail"; params.id = seg[1]; }
  else if (seg.length >= 1 && seg[0]) page = seg[0];
  var filters = {};
  var query = (location.search || "").replace(/^\\?/, "");
  if (query) {
    query.split("&").forEach(function (kv) {
      var eq = kv.indexOf("=");
      if (eq <= 0) return;
      try {
        var k = decodeURIComponent(kv.slice(0, eq));
        var v = decodeURIComponent(kv.slice(eq + 1));
        if (k.indexOf("f_") === 0 && v) filters[k.slice(2)] = v;
      } catch (e) {}
    });
  }
  return { page: page, params: params, filters: filters };
};

D.hrefFor = function (page, params, filters) {
  var parts = page.split(".");
  var href = D.BASE;
  if (parts[1] === "detail" && params && params.id) href += "/" + encodeURIComponent(parts[0]) + "/" + encodeURIComponent(params.id);
  else if (page !== D.defaultPage) href += "/" + encodeURIComponent(parts[0]);
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
  // A filter change starts the Longest waiting walk from the top again.
  if (key !== "i") delete f.i;
  D.go(D.hrefFor(D.state.page, D.state.params, f));
};

D.clearFilters = function () {
  var f = {};
  if (D.state.filters.view) f.view = D.state.filters.view;
  D.go(D.hrefFor(D.state.page, D.state.params, f));
};

D.onRouteChange = function () {
  var parsed = D.parseRoute();
  var samePage = D.state.page === parsed.page && JSON.stringify(D.state.params) === JSON.stringify(parsed.params);
  var sameFilters = JSON.stringify(D.state.filters) === JSON.stringify(parsed.filters);
  D.state.page = parsed.page;
  D.state.params = parsed.params;
  D.state.filters = parsed.filters;
  if (!samePage || !sameFilters) { D.state.cursor = null; D.state.stack = []; }
  try { window.dispatchEvent(new CustomEvent("dashroute")); } catch (e) {}
  D.loadPage();
};

D.bindLinks = function () {
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    while (t && t !== document.body && t.tagName !== "A") t = t.parentNode;
    if (!t || t.tagName !== "A" || t.target === "_blank") return;
    var href = t.getAttribute("href") || "";
    if (href.indexOf(D.BASE + "/oauth/") === 0) return;
    if (href !== D.BASE && href.indexOf(D.BASE + "/") !== 0 && href.indexOf(D.BASE + "?") !== 0) return;
    e.preventDefault();
    D.go(href);
  });
};

// silent = the 60-second refresh: keep the page (and the scroll position)
// until the new one is in, and stay quiet on a failed poll.
D.loadPage = function (silent) {
  var content = D.q("content");
  if (!silent) {
    D.clearFlash();
    content.textContent = "";
    content.appendChild(D.el("p", "note", "Loading\\u2026"));
  }
  var scrollY = window.scrollY;
  D.api("view", { page: D.state.page, params: D.state.params, filters: D.state.filters, cursor: D.state.cursor })
    .then(function (res) {
      var v = D.handle(res); if (!v) return;
      if (v.error) {
        if (silent) return;
        content.textContent = "";
        content.appendChild(D.el("p", "error", v.error === "unknown page" ? "This page does not exist." : (v.error === "rate limited" ? "Too many requests. Give it a few seconds." : "Something went wrong. Try again.")));
        return;
      }
      D.state.view = v;
      document.title = v.title + " \\u00b7 Intercom Queue";
      D.q("who").textContent = v.actorLabel;
      D.renderNav(v);
      D.renderCrumbs(v);
      var blocks = (v.blocks || []).slice();
      var headerBlock = null;
      if (blocks.length && blocks[0].type === "header") headerBlock = blocks.shift();
      else headerBlock = { type: "header", title: v.title };
      content.textContent = "";
      D.renderBlocks(content, [headerBlock]);
      var wrap = D.el("div", null);
      D.renderBlocks(wrap, blocks);
      content.appendChild(wrap);
      if (silent) window.scrollTo(0, scrollY);
    })
    .catch(function () {
      if (silent) return;
      content.textContent = "";
      content.appendChild(D.el("p", "error", "Could not reach the server. Try again."));
    });
};

// ---- wait times: "3h 12m", ticking while the page is open ----
D.waitFmt = function (iso) {
  var t = Date.parse(iso);
  if (isNaN(t)) return "";
  var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? h + "h " + (m % 60) + "m" : h + "h";
  var d = Math.floor(h / 24);
  return h % 24 ? d + "d " + (h % 24) + "h" : d + "d";
};
D.tickAges = function () {
  var els = document.querySelectorAll(".agecell[data-iso]");
  for (var i = 0; i < els.length; i++) els[i].textContent = D.waitFmt(els[i].getAttribute("data-iso"));
};

// The queue's two additions to the shared renderer: the "age" cell and the
// external-link button (Open in Intercom). Everything else falls through.
D.baseRenderCell = D.renderCell;
D.renderCell = function (td, cell) {
  if (cell && cell.t === "age") {
    var sp = D.el("span", "agecell nowrap", D.waitFmt(cell.iso));
    sp.setAttribute("data-iso", cell.iso);
    sp.title = "Waiting since " + D.fmtAbs(cell.iso);
    td.appendChild(sp);
    if (cell.sub) td.appendChild(D.el("span", "sub", cell.sub));
    return;
  }
  D.baseRenderCell(td, cell);
};
D.baseActionBtn = D.actionBtn;
D.actionBtn = function (a) {
  if (a && typeof a.href === "string" && a.href.indexOf("https://") === 0) {
    var l = D.el("a", "btn" + (a.style === "primary" ? " primary" : ""), a.label);
    l.href = a.href;
    l.target = "_blank";
    l.rel = "noopener noreferrer";
    return l;
  }
  return D.baseActionBtn(a);
};

// ---- sidebar ----
D.NAV_ICONS = {
  mine: "M8 8.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM3.6 13.4a4.4 4.4 0 0 1 8.8 0",
  global: "M8 14.3A6.3 6.3 0 1 0 8 1.7a6.3 6.3 0 0 0 0 12.6ZM1.9 8h12.2M8 1.7c1.7 1.8 2.5 3.9 2.5 6.3S9.7 12.5 8 14.3C6.3 12.5 5.5 10.4 5.5 8S6.3 3.5 8 1.7",
  inbox: "M2.4 8.6 4 3.4h8l1.6 5.2v4H2.4ZM2.4 8.6h3.2l.8 1.6h3.2l.8-1.6h3.2",
  inboxes: "M2.4 8.6 4 3.4h8l1.6 5.2v4H2.4ZM2.4 8.6h3.2l.8 1.6h3.2l.8-1.6h3.2",
  person: "M8 8.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM3.6 13.4a4.4 4.4 0 0 1 8.8 0",
  people: "M6 7.6a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM1.9 13a4.1 4.1 0 0 1 8.2 0M10.6 3.4a2.2 2.2 0 0 1 0 4.2M11.9 9.2a4.1 4.1 0 0 1 2.2 3.8"
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
    if (item.badge) b.appendChild(D.el("span", "navcount", item.badge));
    if (item.key === v.activeNav) b.classList.add("active");
    b.addEventListener("click", function () { D.go(D.hrefFor(item.page, item.params || {}, {})); });
    nav.appendChild(b);
  });
};

D.renderCrumbs = function (v) {
  var el = D.q("crumbs");
  el.textContent = "";
  if (!v.crumbs || v.crumbs.length < 2) return;
  v.crumbs.forEach(function (c, i) {
    if (i > 0) el.appendChild(D.el("span", "sep", "/"));
    if (c.ref) {
      var a = D.el("a", null, c.label);
      a.href = D.refHref(c.ref);
      el.appendChild(a);
    } else {
      el.appendChild(D.el("span", null, c.label));
    }
  });
};

// ---- mobile menu ----
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

// ---- theme (Auto, Light, Dark), remembered per browser ----
D.THEME_KEY = "queue-theme";
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

// ---- sign-in screen ----
// The server redirects a refused sign-in to /queue?e=<code>; the text is
// fixed here, nothing from the URL is shown.
D.LOGIN_ERRORS = {
  denied: "Sign-in was cancelled in Intercom.",
  expired: "That sign-in link expired or was already used. Try again.",
  config: "Sign-in is not set up yet. An admin finishes it in Discord: /intercom \\u2192 Queue.",
  error: "Intercom did not confirm the sign-in. Try again in a minute.",
  unverified: "Your Intercom email address is not verified. Verify it in Intercom, then try again.",
  workspace: "That Intercom account belongs to a different workspace.",
  seat: "Only teammates with an Intercom inbox seat can use the queue."
};
D.showLogin = function (j) {
  D.q("app").hidden = true; D.q("expired").hidden = true;
  D.q("login").hidden = false;
  var code = "";
  var m = /(?:^|[?&])e=([a-z]+)/.exec(location.search || "");
  if (m) code = m[1];
  var err = D.q("loginErr");
  var msg = Object.prototype.hasOwnProperty.call(D.LOGIN_ERRORS, code) ? D.LOGIN_ERRORS[code] : "";
  err.textContent = msg; err.hidden = !msg;
  if (m) { try { history.replaceState({}, "", location.pathname); } catch (e) {} }
  var ready = !!(j && j.ready);
  D.q("loginGo").hidden = !ready;
  D.q("loginNotReady").hidden = ready || code === "config";
};

// ---- boot ----
D.started = false;
D.startApp = function () {
  if (D.started) return;
  D.started = true;
  D.q("login").hidden = true;
  D.q("app").hidden = false;
  D.bindModal();
  D.bindMenu();
  D.bindLinks();
  D.q("logout").addEventListener("click", function () {
    D.api("logout", {}).then(function () { location.href = D.BASE; }, function () { location.href = D.BASE; });
  });
  D.q("refreshbtn").addEventListener("click", function () { D.loadPage(true); });
  window.addEventListener("popstate", D.onRouteChange);
  D.onRouteChange();
  setInterval(D.tickAges, 30000);
  // The data behind the page is a one-minute snapshot: refresh as often,
  // but never under an open dialog, menu or filter popover, or in a hidden tab.
  setInterval(function () {
    if (document.hidden) return;
    if (document.querySelector("dialog[open], .fpop.open, .morepop.open")) return;
    D.loadPage(true);
  }, 60000);
};

// A busy or failing server is not a sign-out: say so and try again.
D.showRetry = function () {
  D.q("app").hidden = true; D.q("expired").hidden = true;
  D.q("login").hidden = false;
  D.q("loginGo").hidden = true; D.q("loginNotReady").hidden = true;
  var err = D.q("loginErr");
  err.textContent = "Could not reach the queue. Trying again in a few seconds.";
  err.hidden = false;
  setTimeout(D.boot, 5000);
};
D.boot = function () {
  D.api("status", {}).then(function (res) {
    var j = res.j || {};
    if (res.status !== 200 || j.error === "rate limited") { D.showRetry(); return; }
    if (j.state === "active") { D.startApp(); return; }
    if (j.state === "login") { D.showLogin(j); return; }
    D.showExpired();
  }).catch(function () { D.showRetry(); });
};

document.getElementById("expiredReload").addEventListener("click", function () { location.href = D.BASE; });
D.bindTheme();
D.boot();
`;
