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

// Card-brand chip label (text stand-in for the brand logo — CSP forbids images).
D.cardLabel = function (brand) {
  var b = (brand || "").toLowerCase();
  if (b === "visa") return "VISA";
  if (b === "mastercard") return "MC";
  if (b === "amex" || b === "american_express") return "AMEX";
  if (b === "discover") return "DISC";
  if (b === "diners" || b === "diners_club") return "DC";
  if (b === "jcb") return "JCB";
  if (b === "unionpay") return "UP";
  if (b === "link") return "LINK";
  if (b === "paypal") return "PYPL";
  if (b === "sepa_debit") return "SEPA";
  if (b === "klarna") return "KLRNA";
  return (brand || "CARD").slice(0, 5).toUpperCase();
};

// Tinted rounded-square object icon (inline SVG silhouettes, geometry only).
D.OBJ_ICONS = {
  customer: "M8 7.6a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Zm-5.4 6.9a5.4 5.4 0 0 1 10.8 0Z",
  product: "M8 1.6l5.6 2.8v7.2L8 14.4l-5.6-2.8V4.4Zm0 1.7L4.6 5 8 6.7 11.4 5Zm-4 3.1v4.4L7.2 12.6V8.1Zm8 0L8.8 8.1v4.5l3.2-1.6Z",
  invoice: "M4.2 1.5h5.3l2.3 2.3v10.7H4.2Zm5 1.2v2h2ZM5.7 7h4.6v1H5.7Zm0 2.4h4.6v1H5.7Zm0 2.4h3v1h-3Z",
  subscription: "M8 2.2a5.8 5.8 0 1 1-5.7 6.9h1.6A4.2 4.2 0 1 0 8 3.8V6L4.6 3.9 8 1.1Z"
};
D.objIcon = function (kind) {
  var NS = "http://www.w3.org/2000/svg";
  var box = D.el("span", "objicon");
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  var path = document.createElementNS(NS, "path");
  path.setAttribute("d", D.OBJ_ICONS[kind] || D.OBJ_ICONS.product);
  path.setAttribute("fill", "currentColor");
  path.setAttribute("fill-rule", "evenodd");
  svg.appendChild(path);
  box.appendChild(svg);
  return box;
};

D.renderCell = function (td, cell) {
  if (cell == null) { td.textContent = ""; return; }
  if (cell.t === "text") {
    if (cell.strong) td.appendChild(D.el("span", "strongname", cell.v));
    else td.appendChild(document.createTextNode(cell.v));
    if (cell.sub) td.appendChild(D.el("span", "sub", cell.sub));
  } else if (cell.t === "money") {
    td.classList.add("money");
    if (cell.tone) td.classList.add(cell.tone);
    td.textContent = cell.v;
  } else if (cell.t === "amount") {
    td.classList.add("amountcell");
    td.appendChild(D.el("span", "amt", cell.v));
    td.appendChild(D.el("span", "cur", cell.cur));
    if (cell.badge) td.appendChild(D.badge(cell.badge));
  } else if (cell.t === "card") {
    var KNOWN = { visa: 1, mastercard: 1, amex: 1, discover: 1, jcb: 1, diners: 1, unionpay: 1, link: 1 };
    var bkey = (cell.brand || "").toLowerCase().replace(/[^a-z]/g, "");
    var ccell = D.el("span", "cardcell");
    ccell.appendChild(D.el("span", "cardchip" + (KNOWN[bkey] ? " " + bkey : ""), D.cardLabel(cell.brand)));
    // Wallet chips (Link, PayPal, SEPA…) have no last4 — chip only.
    if (cell.last4) ccell.appendChild(D.el("span", "cardnum", "\\u00b7\\u00b7\\u00b7\\u00b7 " + cell.last4));
    td.appendChild(ccell);
    if (cell.sub) td.appendChild(D.el("span", "sub", cell.sub));
  } else if (cell.t === "avatar") {
    var av = D.el("span", "avcell");
    av.appendChild(D.objIcon(cell.icon));
    if (cell.ref) {
      var aname = D.el("a", "reflink strongname", cell.v);
      aname.href = D.refHref(cell.ref);
      av.appendChild(aname);
    } else {
      av.appendChild(D.el("span", "strongname", cell.v));
    }
    td.appendChild(av);
    if (cell.sub) td.appendChild(D.el("span", "sub subindent", cell.sub));
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
  if (b.titleSuffix) h1.appendChild(D.el("span", "tsuffix", b.titleSuffix));
  (b.badges || []).forEach(function (bd) { h1.appendChild(D.badge(bd)); });
  titles.appendChild(h1);
  if (b.sub) {
    var sl = D.el("div", "subline");
    sl.appendChild(D.el("span", null, b.sub));
    if (b.subCopy) sl.appendChild(D.copyBtn(b.sub));
    titles.appendChild(sl);
  }
  if (b.id) {
    var idl = D.el("div", "objid");
    idl.appendChild(D.el("span", null, b.id));
    idl.appendChild(D.copyBtn(b.id));
    titles.appendChild(idl);
  }
  head.appendChild(titles);
  if (b.actions && b.actions.length) {
    var acts = D.el("div", "headactions");
    // Stripe shows 1–2 named actions + a "···" More menu — never a button row.
    var inline = b.actions, overflow = [];
    if (b.actions.length > 3) { inline = b.actions.slice(0, 2); overflow = b.actions.slice(2); }
    inline.forEach(function (a) { acts.appendChild(D.actionBtn(a)); });
    if (overflow.length) {
      var wrap = D.el("span", "morewrap");
      var more = D.el("button", "btn morebtn", "\\u00b7\\u00b7\\u00b7");
      more.type = "button";
      more.title = "More actions";
      more.setAttribute("aria-label", "More actions");
      var pop = D.el("div", "morepop");
      overflow.forEach(function (a) { var mi = D.actionBtn(a); mi.classList.add("menuitem"); pop.appendChild(mi); });
      more.addEventListener("click", function (e) {
        e.stopPropagation();
        var wasOpen = pop.classList.contains("open");
        D.closeAllPops();
        if (!wasOpen) pop.classList.add("open");
      });
      wrap.appendChild(more); wrap.appendChild(pop);
      acts.appendChild(wrap);
    }
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
  if (b.counts) box.appendChild(D.renderCounts(b));
  var searches = (b.filters || []).filter(function (f) { return f.kind === "search"; });
  var pills = (b.filters || []).filter(function (f) { return f.kind !== "search"; });
  searches.forEach(function (f) { box.appendChild(D.renderSearch(f)); });
  if (pills.length) box.appendChild(D.renderPills(pills));
  if (!b.rows || b.rows.length === 0) {
    box.appendChild(D.el("p", "note", b.empty || "Nothing here."));
    if (b.notice) box.appendChild(D.el("p", "tnotice", b.notice));
    if (D.state.stack.length > 0) box.appendChild(D.renderFootRow(b, false));
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
  if (b.footer || b.nextCursor || D.state.stack.length > 0) box.appendChild(D.renderFootRow(b, true));
  return box;
};

// "N items" footer + prev/next chevrons on one quiet row under the table.
D.renderFootRow = function (b, withFooter) {
  var row = D.el("div", "tfootrow");
  if (b.nextCursor || D.state.stack.length > 0) row.appendChild(D.renderPager(b));
  if (withFooter && b.footer) {
    if (b.footerRef) {
      var fa = D.el("a", "tfoot link", b.footer);
      fa.href = D.refHref(b.footerRef);
      row.appendChild(fa);
    } else {
      row.appendChild(D.el("span", "tfoot", b.footer));
    }
  }
  return row;
};

// Count-card segmented filter row (the LIST-archetype status filter).
D.renderCounts = function (b) {
  var row = D.el("div", "countrow");
  var current = D.state.filters[b.counts.key] || "";
  (b.counts.items || []).forEach(function (it) {
    var card = D.el("button", "countcard" + ((it.value || "") === current ? " active" : ""));
    card.type = "button";
    card.appendChild(D.el("span", "clabel", it.label));
    card.appendChild(D.el("span", "cnum", String(it.count)));
    card.addEventListener("click", function () { D.applyFilter(b.counts.key, it.value); });
    row.appendChild(card);
  });
  return row;
};

// Wide standalone search box (Customers-list style) for kind:"search" filters.
D.renderSearch = function (f) {
  var wrap = D.el("div", "tsearch");
  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  var c = document.createElementNS(NS, "circle");
  c.setAttribute("cx", "7"); c.setAttribute("cy", "7"); c.setAttribute("r", "4.4");
  c.setAttribute("fill", "none"); c.setAttribute("stroke", "currentColor"); c.setAttribute("stroke-width", "1.6");
  var l = document.createElementNS(NS, "line");
  l.setAttribute("x1", "10.4"); l.setAttribute("y1", "10.4"); l.setAttribute("x2", "14"); l.setAttribute("y2", "14");
  l.setAttribute("stroke", "currentColor"); l.setAttribute("stroke-width", "1.6"); l.setAttribute("stroke-linecap", "round");
  svg.appendChild(c); svg.appendChild(l);
  wrap.appendChild(svg);
  var inp = document.createElement("input");
  inp.type = "text"; inp.autocomplete = "off";
  inp.value = f.value || "";
  inp.placeholder = f.placeholder || f.label;
  inp.setAttribute("aria-label", f.label);
  inp.addEventListener("keydown", function (e) { if (e.key === "Enter") D.applyFilter(f.key, inp.value.trim()); });
  inp.addEventListener("blur", function () {
    if ((f.value || "") !== inp.value.trim()) D.applyFilter(f.key, inp.value.trim());
  });
  wrap.appendChild(inp);
  return wrap;
};

// Filter pills ("⊕ Label" → popover with the control; set pills show the value
// + a clear ×) and the header "···" menu. One popover open at a time; outside
// click closes.
D.closeAllPops = function () {
  var pops = document.querySelectorAll(".fpop.open, .morepop.open");
  for (var i = 0; i < pops.length; i++) pops[i].classList.remove("open");
};
document.addEventListener("click", function (e) {
  var t = e.target;
  while (t) {
    if (t.classList && (t.classList.contains("fpillwrap") || t.classList.contains("morewrap"))) return;
    t = t.parentNode;
  }
  D.closeAllPops();
});

D.filterPill = function (f) {
  var wrap = D.el("span", "fpillwrap");
  var pill = D.el("button", "fpill" + (f.value ? " set" : ""));
  pill.type = "button";
  if (!f.value) {
    pill.appendChild(D.el("span", "pplus", "+"));
    pill.appendChild(D.el("span", null, f.label));
  } else {
    var valLabel = f.value;
    if (f.kind === "select") {
      (f.options || []).forEach(function (o) { if (o.value === f.value) valLabel = o.label; });
    }
    pill.appendChild(D.el("span", "plab", f.label));
    pill.appendChild(D.el("span", "psep", "|"));
    pill.appendChild(D.el("span", "pval", valLabel));
    var x = D.el("span", "px", "\\u00d7");
    x.title = "Clear";
    x.addEventListener("click", function (e) { e.stopPropagation(); D.applyFilter(f.key, ""); });
    pill.appendChild(x);
  }
  var pop = D.el("div", "fpop");
  pop.appendChild(D.el("label", null, f.label));
  if (f.kind === "select") {
    var sel = document.createElement("select");
    sel.appendChild(new Option("All", ""));
    (f.options || []).forEach(function (o) { sel.appendChild(new Option(o.label, o.value)); });
    sel.value = f.value || "";
    sel.addEventListener("change", function () { D.applyFilter(f.key, sel.value); });
    pop.appendChild(sel);
  } else {
    var inp = document.createElement("input");
    inp.type = "text"; inp.autocomplete = "off";
    inp.value = f.value || "";
    if (f.placeholder) inp.placeholder = f.placeholder;
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter") D.applyFilter(f.key, inp.value.trim()); });
    pop.appendChild(inp);
    var go = D.el("button", "btn sm primary", "Apply");
    go.type = "button";
    go.addEventListener("click", function () { D.applyFilter(f.key, inp.value.trim()); });
    pop.appendChild(go);
  }
  pill.addEventListener("click", function (e) {
    e.stopPropagation();
    var wasOpen = pop.classList.contains("open");
    D.closeAllPops();
    if (!wasOpen) {
      pop.classList.add("open");
      var focusable = pop.querySelector("input");
      if (focusable) focusable.focus();
    }
  });
  wrap.appendChild(pill);
  wrap.appendChild(pop);
  return wrap;
};

D.renderPills = function (pills) {
  var bar = D.el("div", "pillbar");
  pills.forEach(function (f) { bar.appendChild(D.filterPill(f)); });
  if (pills.some(function (f) { return f.value; })) {
    var clear = D.el("button", "pillclear", "Clear filters");
    clear.type = "button";
    clear.addEventListener("click", function () { D.clearFilters(); });
    bar.appendChild(clear);
  }
  return bar;
};

D.renderPager = function (b) {
  var pager = D.el("div", "pager");
  var back = D.el("button", "pgbtn", "\\u2039");
  back.type = "button";
  back.title = "Previous page";
  back.setAttribute("aria-label", "Previous page");
  back.disabled = D.state.stack.length === 0;
  back.addEventListener("click", function () {
    D.state.cursor = D.state.stack.pop() || null;
    D.loadPage();
  });
  var next = D.el("button", "pgbtn", "\\u203a");
  next.type = "button";
  next.title = "Next page";
  next.setAttribute("aria-label", "Next page");
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
  var box = D.el("div", "section kv" + (b.big ? " kvbig" : "") + (b.amounts ? " amounts" : ""));
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
