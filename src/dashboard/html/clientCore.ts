// Client module: namespace, api wrapper, DOM + formatting helpers, flash.
// Plain vanilla JS as a string (no build step). No backticks / ${} inside —
// the shell embeds these fragments in a template literal. All dynamic text is
// set via textContent, never innerHTML.

export const clientCore = `
var D = {
  state: { page: null, params: {}, filters: {}, cursor: null, stack: [], view: null },
  els: {}
};

D.q = function (id) { return document.getElementById(id); };

D.api = function (endpoint, body) {
  return fetch("/billing/api/" + endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Panel-Request": "1" },
    body: JSON.stringify(body || {})
  }).then(function (r) {
    return r.json().then(function (j) { return { status: r.status, j: j }; },
      function () { return { status: r.status, j: {} }; });
  });
};

D.showExpired = function () {
  D.q("app").hidden = true; D.q("lock").hidden = true; D.q("expired").hidden = false;
};

D.handle = function (res) {
  if (res.status === 401 || (res.j && res.j.state === "expired")) { D.showExpired(); return null; }
  return res.j;
};

D.el = function (tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

D.badge = function (b) { return D.el("span", "badge " + (b.kind || "info"), b.text); };

// Relative time from an ISO string; absolute local string on hover (title).
D.fmtRel = function (iso) {
  var t = Date.parse(iso);
  if (isNaN(t)) return { rel: iso, abs: iso };
  var s = Math.round((Date.now() - t) / 1000);
  var abs = new Date(t).toLocaleString();
  var future = s < 0; if (future) s = -s;
  var rel;
  if (s < 60) rel = s + "s";
  else if (s < 3600) rel = Math.floor(s / 60) + "m";
  else if (s < 86400) rel = Math.floor(s / 3600) + "h";
  else if (s < 86400 * 30) rel = Math.floor(s / 86400) + "d";
  else if (s < 86400 * 365) rel = Math.floor(s / (86400 * 30)) + "mo";
  else rel = Math.floor(s / (86400 * 365)) + "y";
  return { rel: future ? "in " + rel : rel + " ago", abs: abs };
};

D.copyBtn = function (value) {
  var b = D.el("button", "copybtn", "copy");
  b.type = "button";
  b.title = "Copy " + value;
  b.addEventListener("click", function (e) {
    e.stopPropagation();
    var done = function () {
      b.textContent = "copied"; b.classList.add("copied");
      setTimeout(function () { b.textContent = "copy"; b.classList.remove("copied"); }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, function () {});
    else done();
  });
  return b;
};

D.clearFlash = function () { var f = D.q("flash"); f.textContent = ""; f.className = "flash"; };
D.flashOk = function (msg) {
  var f = D.q("flash"); f.textContent = msg; f.className = "flash ok";
  setTimeout(function () { if (f.classList.contains("ok")) D.clearFlash(); }, 2600);
};
D.flashErr = function (msg) { var f = D.q("flash"); f.textContent = msg; f.className = "flash error"; };
`;
