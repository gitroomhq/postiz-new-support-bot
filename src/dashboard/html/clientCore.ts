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

// Stripe status pills carry a small leading glyph. Refunds get the return
// arrow; otherwise the glyph follows the kind (✓ ok, ✗ error, ⓘ warn/info).
D.BADGE_GLYPH = { ok: "\\u2713", error: "\\u2717", warn: "\\u24d8", info: "\\u24d8", neutral: "" };
D.badge = function (b) {
  var el = D.el("span", "badge " + (b.kind || "info"));
  var txt = b.text || "";
  var g = /refund/i.test(txt) && !/partial/i.test(txt) ? "\\u21a9" : D.BADGE_GLYPH[b.kind || "info"];
  if (g) el.appendChild(D.el("span", "bg", g));
  el.appendChild(document.createTextNode(txt));
  return el;
};

// Absolute local timestamp ("Jul 18, 2026, 11:49 PM") for cells/timelines.
D.fmtAbs = function (iso) {
  var t = Date.parse(iso);
  if (isNaN(t)) return iso;
  try {
    return new Date(t).toLocaleString(undefined,
      { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  } catch (e) { return new Date(t).toLocaleString(); }
};

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

// Quiet copy-icon affordance (Stripe's little glyph after every mono id) —
// an inline SVG, no border, no text.
D.copyBtn = function (value) {
  var b = document.createElement("button");
  b.className = "copybtn";
  b.type = "button";
  b.title = "Copy " + value;
  b.setAttribute("aria-label", "Copy " + value);
  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  var front = document.createElementNS(NS, "rect");
  front.setAttribute("x", "2.6"); front.setAttribute("y", "5"); front.setAttribute("width", "8.4"); front.setAttribute("height", "8.4");
  front.setAttribute("rx", "1.6"); front.setAttribute("fill", "none");
  front.setAttribute("stroke", "currentColor"); front.setAttribute("stroke-width", "1.5");
  var back = document.createElementNS(NS, "path");
  back.setAttribute("d", "M5.6 2.6h6.2a1.6 1.6 0 0 1 1.6 1.6v6.2");
  back.setAttribute("fill", "none");
  back.setAttribute("stroke", "currentColor"); back.setAttribute("stroke-width", "1.5"); back.setAttribute("stroke-linecap", "round");
  svg.appendChild(front); svg.appendChild(back);
  b.appendChild(svg);
  b.addEventListener("click", function (e) {
    e.stopPropagation();
    var done = function () {
      b.classList.add("copied");
      setTimeout(function () { b.classList.remove("copied"); }, 1200);
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
