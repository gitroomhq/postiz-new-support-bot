// Client module: generic block + cell renderers. The server describes every
// block; this code just draws it. Dynamic text via textContent only.

export const clientBlocks = `
D.refHref = function (ref) {
  if (!ref) return null;
  var parts = ref.page.split(".");
  var seg = [parts[0]];
  var id = ref.params && ref.params.id;
  if (id) seg.push(id);
  if (parts.length > 1 && parts[1] !== "detail") seg.push(parts[1]);
  return "#/" + seg.map(encodeURIComponent).join("/");
};

D.renderCell = function (td, cell) {
  if (cell == null) { td.textContent = ""; return; }
  if (cell.t === "text") {
    td.appendChild(document.createTextNode(cell.v));
    if (cell.sub) td.appendChild(D.el("span", "sub", cell.sub));
  } else if (cell.t === "money") {
    td.classList.add("money");
    if (cell.tone) td.classList.add(cell.tone);
    td.textContent = cell.v;
  } else if (cell.t === "badge") {
    td.appendChild(D.badge(cell.b));
  } else if (cell.t === "flags") {
    var set = D.el("span", "flagset");
    (cell.badges || []).forEach(function (b) { set.appendChild(D.badge(b)); });
    td.appendChild(set);
  } else if (cell.t === "date") {
    var f = D.fmtRel(cell.iso);
    var sp = D.el("span", null, f.rel);
    sp.title = f.abs;
    td.appendChild(sp);
  } else if (cell.t === "id") {
    if (cell.ref) {
      var a = D.el("a", "reflink mono", cell.v);
      a.href = D.refHref(cell.ref);
      td.appendChild(a);
    } else {
      td.appendChild(D.el("span", "mono", cell.v));
    }
    if (cell.copy) td.appendChild(D.copyBtn(cell.v));
  } else if (cell.t === "link") {
    var a2 = D.el("a", "reflink", cell.v);
    a2.href = D.refHref(cell.ref);
    td.appendChild(a2);
  } else if (cell.t === "external") {
    var a3 = D.el("a", "reflink", cell.v);
    a3.href = cell.href; a3.target = "_blank"; a3.rel = "noopener noreferrer";
    td.appendChild(a3);
  } else {
    td.textContent = String(cell.v || "");
  }
};

D.renderBlocks = function (container, blocks) {
  container.textContent = "";
  (blocks || []).forEach(function (b) {
    if (b.type === "header") container.appendChild(D.renderHeader(b));
    else if (b.type === "stats") container.appendChild(D.renderStats(b));
    else if (b.type === "table") container.appendChild(D.renderTable(b));
    else if (b.type === "kv") container.appendChild(D.renderKv(b));
    else if (b.type === "timeline") container.appendChild(D.renderTimeline(b));
    else if (b.type === "notice") container.appendChild(D.renderNotice(b));
    else if (b.type === "empty") container.appendChild(D.renderEmpty(b));
    else if (b.type === "qr") container.appendChild(D.renderQr(b));
  });
};

D.renderQr = function (b) {
  var box = D.el("div", "section qrbox");
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + b.size + " " + b.size);
  svg.setAttribute("role", "img");
  // Literal black-on-white regardless of theme: scanners need contrast.
  var bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", String(b.size));
  bg.setAttribute("height", String(b.size));
  bg.setAttribute("fill", "#ffffff");
  svg.appendChild(bg);
  var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", b.path);
  path.setAttribute("fill", "#000000");
  svg.appendChild(path);
  box.appendChild(svg);
  if (b.caption) box.appendChild(D.el("p", "note", b.caption));
  return box;
};

D.renderHeader = function (b) {
  var head = D.el("div", "pagehead");
  var titles = D.el("div", "titles");
  var h1 = D.el("h1", null, b.title);
  (b.badges || []).forEach(function (bd) { h1.appendChild(D.badge(bd)); });
  titles.appendChild(h1);
  if (b.id) {
    var idl = D.el("div", "objid");
    idl.appendChild(D.el("span", null, b.id));
    idl.appendChild(D.copyBtn(b.id));
    titles.appendChild(idl);
  }
  head.appendChild(titles);
  if (b.actions && b.actions.length) {
    var acts = D.el("div", "headactions");
    b.actions.forEach(function (a) { acts.appendChild(D.actionBtn(a)); });
    head.appendChild(acts);
  }
  return head;
};

D.renderStats = function (b) {
  var row = D.el("div", "statrow");
  (b.items || []).forEach(function (it) {
    var card = D.el("div", "stat" + (it.ref ? " link" : ""));
    card.appendChild(D.el("div", "slabel", it.label));
    var val = D.el("div", "svalue", it.value);
    if (it.badge) val.appendChild(D.badge(it.badge));
    card.appendChild(val);
    if (it.sub) card.appendChild(D.el("div", "ssub", it.sub));
    if (it.ref) card.addEventListener("click", function () { D.navigateRef(it.ref); });
    row.appendChild(card);
  });
  return row;
};

D.renderTable = function (b) {
  var box = D.el("div", "section");
  if (b.title) box.appendChild(D.el("h2", null, b.title));
  if (b.filters && b.filters.length) box.appendChild(D.renderFilters(b));
  if (!b.rows || b.rows.length === 0) {
    box.appendChild(D.el("p", "note", b.empty || "Nothing here."));
    if (b.notice) box.appendChild(D.el("p", "tnotice", b.notice));
    if (D.state.stack.length > 0) box.appendChild(D.renderPager(b));
    return box;
  }
  var wrap = D.el("div", "tablewrap");
  var table = document.createElement("table");
  var thead = document.createElement("thead");
  var htr = document.createElement("tr");
  (b.columns || []).forEach(function (c) {
    var th = document.createElement("th");
    th.textContent = c.label;
    if (c.align === "right") th.className = "aright";
    htr.appendChild(th);
  });
  var hasRowActions = b.rows.some(function (r) { return r.actions && r.actions.length; });
  if (hasRowActions) htr.appendChild(document.createElement("th"));
  thead.appendChild(htr); table.appendChild(thead);
  var tbody = document.createElement("tbody");
  b.rows.forEach(function (row) {
    var tr = document.createElement("tr");
    if (row.ref) {
      tr.className = "clickable";
      tr.addEventListener("click", function (e) {
        var t = e.target;
        while (t && t !== tr) {
          if (t.tagName === "A" || t.tagName === "BUTTON" || t.tagName === "INPUT" || t.tagName === "SELECT") return;
          t = t.parentNode;
        }
        D.navigateRef(row.ref);
      });
    }
    (row.cells || []).forEach(function (cell, i) {
      var td = document.createElement("td");
      var col = (b.columns || [])[i];
      if (col && col.align === "right") td.classList.add("aright");
      D.renderCell(td, cell);
      tr.appendChild(td);
    });
    if (hasRowActions) {
      var act = document.createElement("td"); act.className = "act";
      (row.actions || []).forEach(function (a) { var btn = D.actionBtn(a); btn.classList.add("sm"); act.appendChild(btn); });
      tr.appendChild(act);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  box.appendChild(wrap);
  if (b.notice) box.appendChild(D.el("p", "tnotice", b.notice));
  if (b.nextCursor || D.state.stack.length > 0) box.appendChild(D.renderPager(b));
  return box;
};

D.renderFilters = function (b) {
  var bar = D.el("div", "filterbar");
  (b.filters || []).forEach(function (f) {
    var item = D.el("div", "fitem");
    item.appendChild(D.el("label", null, f.label));
    if (f.kind === "select") {
      var sel = document.createElement("select");
      sel.appendChild(new Option("All", ""));
      (f.options || []).forEach(function (o) { sel.appendChild(new Option(o.label, o.value)); });
      sel.value = f.value || "";
      sel.addEventListener("change", function () { D.applyFilter(f.key, sel.value); });
      item.appendChild(sel);
    } else {
      var inp = document.createElement("input");
      inp.type = "text"; inp.autocomplete = "off";
      inp.value = f.value || "";
      if (f.placeholder) inp.placeholder = f.placeholder;
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") D.applyFilter(f.key, inp.value.trim()); });
      inp.addEventListener("blur", function () {
        if ((f.value || "") !== inp.value.trim()) D.applyFilter(f.key, inp.value.trim());
      });
      item.appendChild(inp);
    }
    bar.appendChild(item);
  });
  var hasValue = (b.filters || []).some(function (f) { return f.value; });
  if (hasValue) {
    var clear = D.el("button", "btn", "Clear filters");
    clear.type = "button";
    clear.addEventListener("click", function () { D.clearFilters(); });
    bar.appendChild(clear);
  }
  return bar;
};

D.renderPager = function (b) {
  var pager = D.el("div", "pager");
  var back = D.el("button", "btn sm", "Back");
  back.type = "button";
  back.disabled = D.state.stack.length === 0;
  back.addEventListener("click", function () {
    D.state.cursor = D.state.stack.pop() || null;
    D.loadPage();
  });
  var next = D.el("button", "btn sm", "Next");
  next.type = "button";
  next.disabled = !b.nextCursor;
  next.addEventListener("click", function () {
    D.state.stack.push(D.state.cursor);
    D.state.cursor = b.nextCursor;
    D.loadPage();
  });
  pager.appendChild(back); pager.appendChild(next);
  return pager;
};

D.renderKv = function (b) {
  var box = D.el("div", "section kv");
  if (b.title) box.appendChild(D.el("h2", null, b.title));
  (b.rows || []).forEach(function (r) {
    var row = D.el("div", "kvrow");
    row.appendChild(D.el("div", "kvlabel", r.label));
    var val = D.el("div", "kvval");
    D.renderCell(val, r.cell);
    row.appendChild(val);
    box.appendChild(row);
  });
  (b.actions || []).forEach(function (a) { var btn = D.actionBtn(a); btn.classList.add("secfoot"); box.appendChild(btn); });
  return box;
};

D.renderTimeline = function (b) {
  var box = D.el("div", "section");
  if (b.title) box.appendChild(D.el("h2", null, b.title));
  var ul = D.el("ul", "timeline");
  (b.items || []).forEach(function (it) {
    var li = D.el("li", it.kind || null);
    li.appendChild(D.el("span", "tdot"));
    var title = D.el("div", "ttitle");
    if (it.ref) {
      var a = D.el("a", "reflink", it.label);
      a.href = D.refHref(it.ref);
      title.appendChild(a);
    } else {
      title.appendChild(document.createTextNode(it.label));
    }
    var f = D.fmtRel(it.iso);
    var when = D.el("span", "twhen", f.rel);
    when.title = f.abs;
    title.appendChild(when);
    li.appendChild(title);
    if (it.text) li.appendChild(D.el("div", "ttext", it.text));
    ul.appendChild(li);
  });
  box.appendChild(ul);
  return box;
};

D.renderNotice = function (b) {
  var bar = D.el("div", "noticebar " + (b.badge.kind === "error" ? "error" : b.badge.kind === "warn" ? "warn" : ""));
  bar.appendChild(D.badge(b.badge));
  bar.appendChild(D.el("span", "ntext", b.text));
  (b.actions || []).forEach(function (a) { bar.appendChild(D.actionBtn(a)); });
  return bar;
};

D.renderEmpty = function (b) {
  var box = D.el("div", "section emptybox");
  box.appendChild(D.el("div", "etitle", b.title));
  if (b.hint) box.appendChild(D.el("div", "ehint", b.hint));
  return box;
};
`;
