// Client module: hash router, nav/crumb rendering, jump-to-ID, activation
// poll, nav-badge poll and boot. Hash convention (mirrors ObjectRef):
//   #/customers                → page "customers"
//   #/customers/cus_123        → page "customers.detail", params { id }
//   #/customers/cus_123/edit   → page "customers.edit", params { id }
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
  location.hash = D.hashFor(ref.page, ref.params || {}, {});
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
      document.body.classList.toggle("testmode", !!v.testMode);
      D.q("modebadge").textContent = v.testMode ? "TEST MODE" : "LIVE";
      D.q("modebadge").className = "badge " + (v.testMode ? "warn" : "ok");
      D.q("who").textContent = "Acting as " + v.actorLabel;
      D.renderNav(v);
      D.renderCrumbs(v);
      D.renderBlocks(content, v.blocks);
    });
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
    b.appendChild(D.el("span", null, item.label));
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

// ---- jump-to-ID ----
D.ID_ROUTES = [
  { re: /^cus_[A-Za-z0-9]+$/, page: "customers.detail" },
  { re: /^(ch|py)_[A-Za-z0-9]+$/, page: "payments.detail" },
  { re: /^pi_[A-Za-z0-9]+$/, page: "payments.detail" },
  { re: /^sub_[A-Za-z0-9]+$/, page: "subscriptions.detail" },
  { re: /^in_[A-Za-z0-9]+$/, page: "invoices.detail" },
  { re: /^(dp|du)_[A-Za-z0-9]+$/, page: "disputes.detail" }
];
D.bindJump = function () {
  var jump = D.q("jump");
  jump.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var v = jump.value.trim();
    if (!v) return;
    for (var i = 0; i < D.ID_ROUTES.length; i++) {
      if (D.ID_ROUTES[i].re.test(v)) {
        jump.value = "";
        D.navigateRef({ page: D.ID_ROUTES[i].page, params: { id: v } });
        return;
      }
    }
    D.flashErr("Not a recognized Stripe id (cus_, ch_, py_, pi_, sub_, in_, dp_, du_).");
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement && document.activeElement.tagName !== "INPUT" &&
        document.activeElement.tagName !== "TEXTAREA" && document.activeElement.tagName !== "SELECT" &&
        !D.q("modal").open) {
      e.preventDefault();
      jump.focus();
    }
  });
};

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

D.started = false;
D.startApp = function () {
  if (D.started) return;
  D.started = true;
  D.bindModal();
  D.bindJump();
  D.q("logout").addEventListener("click", function () {
    // Back to the sign-in screen (standing URL) rather than a dead end.
    D.api("logout", {}).then(function () { location.hash = ""; location.reload(); });
  });
  window.addEventListener("hashchange", D.onHashChange);
  D.onHashChange();
  D.pollBadges();
};

D.bindLogin();
D.poll();
`;
