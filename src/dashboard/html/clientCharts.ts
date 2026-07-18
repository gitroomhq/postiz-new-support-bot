// Client module: lazily-hydrated inline-SVG charts (area / bars / line with
// threshold bands). Geometry attributes + CSS classes only — CSP-safe, no
// canvas, no external assets. Values arrive in display units from the series
// endpoint; this code only draws.

export const clientCharts = `
D.CHART = { W: 520, H: 170, PL: 46, PR: 10, PT: 12, PB: 22 };

D.svgEl = function (tag, attrs) {
  var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, String(attrs[k])); });
  return e;
};

D.fmtChartVal = function (s, v) {
  if (s.unit === "percent") return v.toFixed(2) + "%";
  if (s.unit === "currency") {
    var n = Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v * 100) / 100);
    return n + (s.currency ? " " + s.currency : "");
  }
  return String(Math.round(v));
};

D.renderChart = function (b) {
  var box = D.el("div", "section chartbox");
  box.appendChild(D.el("h2", null, b.title));
  var holder = D.el("div", "chartholder");
  holder.appendChild(D.el("p", "note", "Loading\\u2026"));
  box.appendChild(holder);
  D.api("series", { key: b.key, window: b.window }).then(function (res) {
    var j = D.handle(res); if (!j) return;
    holder.textContent = "";
    if (res.status !== 200 || !j.points) {
      holder.appendChild(D.el("p", "note", "Chart unavailable."));
      return;
    }
    if (!j.points.length || !j.points.some(function (p) { return p.v !== 0; })) {
      holder.appendChild(D.el("p", "note", "No data in this window."));
      if (j.note) holder.appendChild(D.el("p", "tnotice", j.note));
      return;
    }
    holder.appendChild(D.chartSvg(b.kind, j));
    var foot = j.note || "";
    if (j.stale) foot += (foot ? " \\u00b7 " : "") + "refreshing\\u2026";
    if (foot) holder.appendChild(D.el("p", "tnotice", foot));
  }).catch(function () {
    holder.textContent = "";
    holder.appendChild(D.el("p", "note", "Chart unavailable."));
  });
  return box;
};

D.chartSvg = function (kind, s) {
  var C = D.CHART;
  var pts = s.points, n = pts.length;
  var max = 0, min = 0;
  pts.forEach(function (p) { if (p.v > max) max = p.v; if (p.v < min) min = p.v; });
  (s.bands || []).forEach(function (bd) { if (bd.v > max) max = bd.v; });
  if (max === min) max = min + 1;
  max = max * 1.08; // headroom so peaks don't kiss the frame
  var iw = C.W - C.PL - C.PR, ih = C.H - C.PT - C.PB;
  var x = function (i) { return C.PL + (n === 1 ? iw / 2 : i * (iw / (n - 1))); };
  var y = function (v) { return C.PT + ih - ((v - min) / (max - min)) * ih; };

  var svg = D.svgEl("svg", { viewBox: "0 0 " + C.W + " " + C.H, class: "chart", role: "img" });

  // y grid: min / mid / max hairlines + labels.
  [min, (min + max) / 2, max / 1.08].forEach(function (v) {
    svg.appendChild(D.svgEl("line", { x1: C.PL, x2: C.W - C.PR, y1: y(v), y2: y(v), class: "cgrid" }));
    var t = D.svgEl("text", { x: C.PL - 6, y: y(v) + 3.5, class: "clabel", "text-anchor": "end" });
    t.textContent = D.fmtChartVal(s, v);
    svg.appendChild(t);
  });

  // threshold bands (dispute ratio warn/critical).
  (s.bands || []).forEach(function (bd) {
    svg.appendChild(D.svgEl("line", {
      x1: C.PL, x2: C.W - C.PR, y1: y(bd.v), y2: y(bd.v),
      class: "cband " + (bd.kind === "error" ? "error" : "warn")
    }));
    var t = D.svgEl("text", { x: C.W - C.PR, y: y(bd.v) - 4, class: "clabel " + (bd.kind === "error" ? "error" : "warn"), "text-anchor": "end" });
    t.textContent = bd.label + " " + D.fmtChartVal(s, bd.v);
    svg.appendChild(t);
  });

  if (kind === "bars") {
    var bw = Math.max(3, (iw / n) * 0.62);
    pts.forEach(function (p, i) {
      var bx = C.PL + i * (iw / n) + (iw / n - bw) / 2;
      var rect = D.svgEl("rect", {
        x: bx, y: Math.min(y(p.v), y(0)), width: bw,
        height: Math.max(1.5, Math.abs(y(0) - y(p.v))), rx: 2, class: "cbar"
      });
      var title = D.svgEl("title", {});
      title.textContent = p.label + ": " + D.fmtChartVal(s, p.v);
      rect.appendChild(title);
      svg.appendChild(rect);
    });
  } else {
    var dLine = "";
    pts.forEach(function (p, i) { dLine += (i === 0 ? "M" : "L") + x(i).toFixed(1) + " " + y(p.v).toFixed(1); });
    if (kind === "area") {
      var dArea = dLine + "L" + x(n - 1).toFixed(1) + " " + y(Math.max(0, min)).toFixed(1) +
        "L" + x(0).toFixed(1) + " " + y(Math.max(0, min)).toFixed(1) + "Z";
      svg.appendChild(D.svgEl("path", { d: dArea, class: "carea" }));
    }
    svg.appendChild(D.svgEl("path", { d: dLine, class: "cline" }));
    pts.forEach(function (p, i) {
      var dot = D.svgEl("circle", { cx: x(i), cy: y(p.v), r: 2.6, class: "cdot" });
      var title = D.svgEl("title", {});
      title.textContent = p.label + ": " + D.fmtChartVal(s, p.v);
      dot.appendChild(title);
      svg.appendChild(dot);
    });
  }

  // x labels: first / middle / last only (quiet axis).
  [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i, idx, arr) {
    if (idx > 0 && arr.indexOf(i) < idx) return; // dedupe tiny series
    var anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    var t = D.svgEl("text", { x: x(i), y: C.H - 6, class: "clabel", "text-anchor": anchor });
    t.textContent = pts[i].label;
    svg.appendChild(t);
  });

  return svg;
};
`;
