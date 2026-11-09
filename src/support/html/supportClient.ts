// Client module for the support dashboard (/support): router, sidebar, the
// four-step sign-in, and the three blocks the support pages add (strip,
// change, searchform). It runs on top of the dashboard's clientCore +
// clientBlocks + clientModal (same `D` namespace, same block renderer).
// Plain vanilla JS as a string (no build step). No backticks or ${} inside:
// the shell embeds this in a template literal. Dynamic text goes through
// textContent, never innerHTML.
//
// URLs (real, copyable paths):
//   /support                 page "lookup"
//   /support/requests        page "requests"
//   /support/customer/<id>   page "customer", params { id }
// Filters ride the query string as f_<key>=<value>; cursors stay in memory.

export const supportClient = `
D.BASE = "/support";
D.defaultPage = "lookup";

D.parseRoute = function () {
  var path = location.pathname || "";
  if (path.indexOf(D.BASE) === 0) path = path.slice(D.BASE.length);
  var seg = path.split("/").filter(function (s) { return s.length > 0; }).map(function (s) {
    try { return decodeURIComponent(s); } catch (e) { return ""; }
  });
  var page = D.defaultPage, params = {};
  if (seg.length >= 2 && seg[0] === "customer") { page = "customer"; params.id = seg[1]; }
  else if (seg.length >= 1 && seg[0]) page = seg[0];
  var filters = {};
  var query = (location.search || "").replace(/^\\?/, "");
  if (query) {
    query.split("&").forEach(function (kv) {
      var eq = kv.indexOf("=");
      if (eq <= 0) return;
      try {
        var k = decodeURIComponent(kv.slice(0, eq));
        var v = decodeURIComponent(kv.slice(eq + 1).replace(/\\+/g, " "));
        if (k.indexOf("f_") === 0 && v) filters[k.slice(2)] = v;
      } catch (e) {}
    });
  }
  return { page: page, params: params, filters: filters };
};

D.hrefFor = function (page, params, filters) {
  var href = D.BASE;
  if (page === "customer" && params && params.id) href += "/customer/" + encodeURIComponent(params.id);
  else if (page !== D.defaultPage) href += "/" + encodeURIComponent(page);
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

// Switching the lookup type starts an empty search: an email is no customer ID.
D.applyFilter = function (key, value) {
  var f = {};
  if (key !== "by") Object.keys(D.state.filters).forEach(function (k) { f[k] = D.state.filters[k]; });
  if (value) f[key] = value; else delete f[key];
  D.go(D.hrefFor(D.state.page, D.state.params, f));
};

D.clearFilters = function () {
  var f = {};
  if (D.state.filters.by) f.by = D.state.filters.by;
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
    if (href !== D.BASE && href.indexOf(D.BASE + "/") !== 0 && href.indexOf(D.BASE + "?") !== 0) return;
    e.preventDefault();
    D.go(href);
  });
};

D.loadSeq = 0;
D.loadPage = function () {
  var seq = ++D.loadSeq;
  var content = D.q("content");
  D.clearFlash();
  content.textContent = "";
  content.appendChild(D.el("p", "note", "Loading\\u2026"));
  var body = { page: D.state.page, params: D.state.params, filters: D.state.filters, cursor: D.state.cursor };
  D.api("view", body)
    .then(function (res) {
      if (seq !== D.loadSeq) return;
      var v = D.handle(res); if (!v) return;
      if (v.error) {
        content.textContent = "";
        content.appendChild(D.el("p", "error", v.error === "unknown page" ? "This page does not exist." : (v.error === "rate limited" ? "Too many requests. Give it a few seconds." : "Something went wrong. Try again.")));
        return;
      }
      D.renderView(v);
    })
    .catch(function () {
      if (seq !== D.loadSeq) return;
      content.textContent = "";
      content.appendChild(D.el("p", "error", "Could not reach the server. Try again."));
    });
};

D.renderView = function (v) {
  var content = D.q("content");
  D.state.view = v;
  document.title = v.title + " \\u00b7 Support";
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
  var first = content.querySelector(".sform input");
  if (first && !first.value) first.focus();
};

// ---- the support blocks ----
D.baseRenderBlocks = D.renderBlocks;
D.renderBlocks = function (container, blocks) {
  container.textContent = "";
  (blocks || []).forEach(function (b) {
    if (b.type === "strip") { container.appendChild(D.renderStrip(b)); return; }
    if (b.type === "change") { container.appendChild(D.renderChange(b)); return; }
    if (b.type === "searchform") { container.appendChild(D.renderSearchForm(b)); return; }
    var tmp = D.el("div", null);
    D.baseRenderBlocks(tmp, [b]);
    while (tmp.firstChild) container.appendChild(tmp.firstChild);
  });
};

D.renderStrip = function (b) {
  var box = D.el("div", "strip");
  if (b.title) box.appendChild(D.el("h2", null, b.title));
  var grid = D.el("div", "stripgrid");
  (b.items || []).forEach(function (it) {
    var cell = D.el("div", null);
    cell.appendChild(D.el("div", "slab", it.label));
    cell.appendChild(D.el("div", "sval" + (it.mono ? " mono" : ""), it.value));
    grid.appendChild(cell);
  });
  box.appendChild(grid);
  return box;
};

D.renderChange = function (b) {
  var box = D.el("div", "changecard");
  var head = D.el("div", "chead");
  var title = D.el("div", "ctitle", b.title);
  title.appendChild(D.badge(b.badge));
  head.appendChild(title);
  if (b.actions && b.actions.length) {
    var acts = D.el("div", null);
    b.actions.forEach(function (a) { var btn = D.actionBtn(a); btn.classList.add("sm"); acts.appendChild(btn); });
    head.appendChild(acts);
  }
  box.appendChild(head);
  var sub = b.who + ", " + D.fmtRel(b.iso).rel + (b.note ? " \\u00b7 " + b.note : "");
  box.appendChild(D.el("div", "csub", sub));
  var hdr = D.el("div", "crow chdr");
  (b.columns || []).forEach(function (c) { hdr.appendChild(D.el("span", null, c)); });
  box.appendChild(hdr);
  (b.rows || []).forEach(function (r) {
    var row = D.el("div", "crow");
    row.appendChild(D.el("span", "clab", r.label));
    row.appendChild(D.el("span", null, r.now));
    row.appendChild(D.el("span", "cnext", r.next));
    box.appendChild(row);
  });
  return box;
};

D.renderSearchForm = function (b) {
  var form = D.el("div", "sform");
  var inputs = [];
  var submit = function () {
    var f = {};
    if (D.state.filters.by) f.by = D.state.filters.by;
    inputs.forEach(function (x) { var v = x.el.value.trim(); if (v) f[x.key] = v; });
    D.go(D.hrefFor(D.state.page, D.state.params, f));
  };
  (b.fields || []).forEach(function (fd) {
    var wrap = D.el("div", "sfield" + (fd.narrow ? " narrow" : ""));
    var id = "sf_" + fd.key;
    var l = D.el("label", null, fd.label); l.htmlFor = id;
    var inp = document.createElement("input");
    inp.type = "text"; inp.id = id; inp.autocomplete = "off"; inp.spellcheck = false;
    inp.value = fd.value || "";
    if (fd.placeholder) inp.placeholder = fd.placeholder;
    if (fd.mono) inp.classList.add("mono");
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    wrap.appendChild(l); wrap.appendChild(inp);
    form.appendChild(wrap);
    inputs.push({ key: fd.key, el: inp });
  });
  var go = D.el("button", "btn primary", b.submitLabel || "Search");
  go.type = "button";
  go.addEventListener("click", submit);
  form.appendChild(go);
  return form;
};

// ---- sidebar ----
D.NAV_ICONS = {
  lookup: "M7 12.2a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4ZM10.8 10.8l3.4 3.4",
  requests: "M3.2 2.4h9.6v11.2H3.2ZM5.6 5.6h4.8M5.6 8h4.8M5.6 10.4h2.8"
};
D.navIcon = function (page) {
  var d = D.NAV_ICONS[page || ""];
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
  (v.nav || []).forEach(function (item) {
    var b = document.createElement("button");
    b.type = "button";
    var left = D.el("span", "navleft");
    var ico = D.navIcon(item.page);
    if (ico) left.appendChild(ico);
    left.appendChild(D.el("span", "navlabel", item.label));
    b.appendChild(left);
    if (item.badge) b.appendChild(D.el("span", "navcount", item.badge));
    if (item.key === v.activeNav) b.classList.add("active");
    b.addEventListener("click", function () { D.go(D.hrefFor(item.page, {}, {})); });
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
      el.appendChild(D.el("span", i === v.crumbs.length - 1 && /^cus_/.test(c.label) ? "mono" : null, c.label));
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
D.THEME_KEY = "support-theme";
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

// ---- sign-in: Discord code, DM code, password ----
D.login = { step: "code", pending: null, hasPassword: true, name: "", busy: false };
D.showLogin = function (step, extra) {
  D.q("app").hidden = true; D.q("expired").hidden = true;
  D.q("login").hidden = false;
  D.login.step = step;
  if (step === "code") D.login.pending = null;
  var title = D.q("loginTitle"), hint = D.q("loginHint");
  var codeWrap = D.q("codeWrap"), codeIn = D.q("codeIn"), codeLabel = D.q("codeLabel");
  var pwWrap = D.q("pwWrap"), pw2Wrap = D.q("pw2Wrap"), rule = D.q("pwRule"), go = D.q("loginGo");
  codeWrap.hidden = step === "password";
  pwWrap.hidden = step !== "password";
  pw2Wrap.hidden = !(step === "password" && !D.login.hasPassword);
  rule.hidden = pw2Wrap.hidden;
  codeIn.value = ""; D.q("pwIn").value = ""; D.q("pw2In").value = "";
  if (step === "code") {
    title.textContent = "Support";
    hint.textContent = "Enter the code from /support in Discord.";
    codeLabel.textContent = "Code";
    go.textContent = "Continue";
  } else if (step === "dm") {
    title.textContent = "Check your Discord DMs";
    hint.textContent = "The bot sent you a second code.";
    codeLabel.textContent = "Code from DM";
    go.textContent = "Continue";
  } else {
    title.textContent = D.login.hasPassword ? "Password" : "Choose a password";
    hint.textContent = D.login.hasPassword ? D.login.name : "";
    D.q("pwIn").autocomplete = D.login.hasPassword ? "current-password" : "new-password";
    go.textContent = "Sign in";
  }
  hint.hidden = !hint.textContent;
  var err = D.q("loginErr");
  err.textContent = (extra && extra.error) || ""; err.hidden = !err.textContent;
  (step === "password" ? D.q("pwIn") : codeIn).focus();
};

D.loginSubmit = function () {
  if (D.login.busy) return;
  var step = D.login.step, endpoint, body;
  if (step === "code") { endpoint = "login-code"; body = { code: D.q("codeIn").value }; }
  else if (step === "dm") { endpoint = "login-dm"; body = { pending: D.login.pending, code: D.q("codeIn").value }; }
  else { endpoint = "login-password"; body = { pending: D.login.pending, password: D.q("pwIn").value, repeat: D.q("pw2In").value }; }
  var err = D.q("loginErr");
  D.login.busy = true;
  D.q("loginGo").disabled = true;
  D.api(endpoint, body).then(function (res) {
    D.login.busy = false;
    D.q("loginGo").disabled = false;
    var j = res.j || {};
    if (!j.ok) {
      if (j.restart) { D.showLogin("code", { error: j.error }); return; }
      err.textContent = j.error || "Sign-in failed. Try again."; err.hidden = false;
      return;
    }
    if (j.step === "dm") { D.login.pending = j.pending; D.showLogin("dm"); return; }
    if (j.step === "password") { D.login.hasPassword = !!j.hasPassword; D.login.name = j.name || ""; D.showLogin("password"); return; }
    D.login.pending = null;
    D.startApp();
  }).catch(function () {
    D.login.busy = false;
    D.q("loginGo").disabled = false;
    err.textContent = "Could not reach the server. Try again."; err.hidden = false;
  });
};

D.bindLogin = function () {
  D.q("loginGo").addEventListener("click", D.loginSubmit);
  ["codeIn", "pwIn", "pw2In"].forEach(function (id) {
    D.q(id).addEventListener("keydown", function (e) { if (e.key === "Enter") D.loginSubmit(); });
  });
};

// ---- boot ----
D.started = false;
D.startApp = function () {
  D.q("login").hidden = true;
  D.q("app").hidden = false;
  if (D.started) { D.onRouteChange(); return; }
  D.started = true;
  D.bindModal();
  D.bindMenu();
  D.bindLinks();
  D.q("logout").addEventListener("click", function () {
    D.api("logout", {}).then(function () { location.href = D.BASE; }, function () { location.href = D.BASE; });
  });
  window.addEventListener("popstate", D.onRouteChange);
  D.onRouteChange();
};

D.boot = function () {
  D.api("status", {}).then(function (res) {
    var j = res.j || {};
    if (j.state === "active") { D.startApp(); return; }
    if (j.state === "login") { D.showLogin("code"); return; }
    D.showExpired();
  }).catch(function () { setTimeout(D.boot, 5000); });
};

document.getElementById("expiredReload").addEventListener("click", function () { location.href = D.BASE; });
D.bindTheme();
D.bindLogin();
D.boot();
`;
