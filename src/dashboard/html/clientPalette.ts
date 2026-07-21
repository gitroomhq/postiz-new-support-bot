// Client module: the ⌘K command palette living on the topbar search box.
// Instant id fast-path (client-side), 400ms-debounced server search, keyboard
// navigation, sessionStorage recents, static go-to commands. Defines
// D.bindJump — called by startApp in place of the plain jump box.

export const clientPalette = `
D.pal = { hits: [], sel: -1, timer: null, seq: 0 };

D.NAV_COMMANDS = [
  { title: "Go to Home", ref: { page: "home" } },
  { title: "Go to Balances", ref: { page: "balances" } },
  { title: "Go to Payments", ref: { page: "payments" } },
  { title: "Go to Customers", ref: { page: "customers" } },
  { title: "Go to Approvals", ref: { page: "approvals" } },
  { title: "Go to Security", ref: { page: "security" } }
];

D.palRecents = function () {
  try { return JSON.parse(sessionStorage.getItem("billing-recents") || "[]") || []; } catch (e) { return []; }
};
D.palRemember = function (hit) {
  try {
    var key = function (h) { return h.ref.page + ":" + ((h.ref.params && h.ref.params.id) || ""); };
    var rows = D.palRecents().filter(function (x) { return key(x) !== key(hit); });
    rows.unshift({ title: hit.title, id: hit.id, ref: hit.ref });
    sessionStorage.setItem("billing-recents", JSON.stringify(rows.slice(0, 15)));
  } catch (e) {}
};

D.palClose = function () {
  var pop = D.q("palpop");
  pop.classList.remove("open");
  D.pal.hits = []; D.pal.sel = -1;
};

D.palGo = function (hit) {
  D.palClose();
  D.palRemember(hit);
  var jump = D.q("jump");
  jump.value = ""; jump.blur();
  D.navigateRef(hit.ref);
};

D.palPaint = function (groups, notice) {
  var pop = D.q("palpop");
  pop.textContent = "";
  D.pal.hits = []; D.pal.sel = -1;
  var any = false;
  (groups || []).forEach(function (g) {
    if (!g.hits || !g.hits.length) return;
    any = true;
    pop.appendChild(D.el("div", "palgroup", g.label));
    g.hits.forEach(function (h) {
      var row = D.el("button", "palrow");
      row.type = "button";
      row.appendChild(D.el("span", "pt", h.title));
      if (h.sub) row.appendChild(D.el("span", "ps", h.sub));
      if (h.id) row.appendChild(D.el("span", "pid", h.id));
      var idx = D.pal.hits.length;
      row.addEventListener("click", function () { D.palGo(h); });
      row.addEventListener("mousemove", function () { D.palSelect(idx); });
      pop.appendChild(row);
      D.pal.hits.push({ hit: h, el: row });
    });
  });
  if (!any) pop.appendChild(D.el("div", "palnote", notice || "No matches."));
  else if (notice) pop.appendChild(D.el("div", "palnote", notice));
  pop.classList.add("open");
};

D.palSelect = function (idx) {
  if (D.pal.sel >= 0 && D.pal.hits[D.pal.sel]) D.pal.hits[D.pal.sel].el.classList.remove("sel");
  D.pal.sel = idx;
  var row = D.pal.hits[idx];
  if (row) { row.el.classList.add("sel"); if (row.el.scrollIntoView) row.el.scrollIntoView({ block: "nearest" }); }
};

D.palEmptyState = function () {
  var groups = [];
  var recents = D.palRecents();
  if (recents.length) groups.push({ label: "Recent", hits: recents });
  groups.push({ label: "Go to", hits: D.NAV_COMMANDS });
  D.palPaint(groups, "Type a name, email, amount, last4 or any Stripe id.");
};

D.palQuery = function (term) {
  if (D.pal.timer) { clearTimeout(D.pal.timer); D.pal.timer = null; }
  if (!term) { D.palEmptyState(); return; }
  // Instant id fast-path — no server round-trip for a pasted id.
  for (var i = 0; i < D.ID_ROUTES.length; i++) {
    if (D.ID_ROUTES[i].re.test(term)) {
      D.palPaint([{ label: "Go to", hits: [{ title: "Open " + term, id: term, ref: { page: D.ID_ROUTES[i].page, params: { id: term } } }] }]);
      return;
    }
  }
  if (term.length < 2) { D.palPaint([], "Keep typing\\u2026"); return; }
  var pop = D.q("palpop");
  if (!pop.classList.contains("open")) D.palPaint([], "Searching\\u2026");
  D.pal.timer = setTimeout(function () {
    var seq = ++D.pal.seq;
    D.palPaint([], "Searching\\u2026");
    D.api("search", { term: term }).then(function (res) {
      if (seq !== D.pal.seq) return; // a newer query superseded this one
      var j = res.j || {};
      if (res.status !== 200) { D.palPaint([], "Search failed."); return; }
      D.palPaint(j.groups || [], j.notice);
    }).catch(function () { if (seq === D.pal.seq) D.palPaint([], "Search failed."); });
  }, 400);
};

D.bindJump = function () {
  var jump = D.q("jump");
  jump.addEventListener("input", function () { D.palQuery(jump.value.trim()); });
  jump.addEventListener("focus", function () { D.palQuery(jump.value.trim()); });
  jump.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); D.palSelect(Math.min(D.pal.sel + 1, D.pal.hits.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); D.palSelect(Math.max(D.pal.sel - 1, 0)); return; }
    if (e.key === "Escape") { D.palClose(); jump.blur(); return; }
    if (e.key === "Enter") {
      var pick = D.pal.sel >= 0 ? D.pal.hits[D.pal.sel] : D.pal.hits[0];
      if (pick) { D.palGo(pick.hit); return; }
      D.flashErr("No match: try a name, email, amount, last4 or a Stripe id.");
    }
  });
  document.addEventListener("keydown", function (e) {
    var tag = document.activeElement ? document.activeElement.tagName : "";
    var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); jump.focus(); return; }
    if (e.key === "/" && !typing && !D.q("modal").open) { e.preventDefault(); jump.focus(); }
  });
  document.addEventListener("click", function (e) {
    var t = e.target;
    while (t) {
      if (t.classList && t.classList.contains("jumpwrap")) return;
      t = t.parentNode;
    }
    D.palClose();
  });
};
`;
