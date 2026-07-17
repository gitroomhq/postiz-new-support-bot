import { panelThemeCss } from "../util/panelTheme";

// Self-contained HTML for the admin web panel (/config + /intercom). Ships as a
// template string (no build pipeline): inline CSS + vanilla JS, zero external
// requests (strict CSP allows only same-origin XHR to /admin/panel/api/*).
//
// The page is dumb on purpose: the server (AdminPanel + hub modules) describes
// every section/field/button; the client renders generically and posts changes
// back. Dynamic text goes through textContent — never innerHTML with data.
// Styling is class/attribute driven (never inline style attributes), and the
// <style>/<script> tags ARE nonced. Visual language comes from panelTheme.ts;
// this file adds only the app shell (sidebar + topbar) layout.

export interface AdminShellCtx {
  nonce: string;
}

export function renderAdminShell(ctx: AdminShellCtx): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Admin panel</title>
<style nonce="${ctx.nonce}">
${panelThemeCss()}
  #app { display:grid; grid-template-columns:236px 1fr; min-height:100vh; }
  .side { background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column;
    padding:16px 12px; position:sticky; top:0; height:100vh; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:700; font-size:15px; padding:6px 8px 18px; letter-spacing:-.01em; }
  .brand .dot { width:24px; height:24px; border-radius:7px; background:var(--accent); color:#fff;
    display:inline-flex; align-items:center; justify-content:center; font-size:13px; }
  #tabs { display:flex; flex-direction:column; gap:2px; overflow-y:auto; }
  #tabs button { all:unset; display:block; padding:9px 12px; border-radius:8px; cursor:pointer;
    color:var(--muted); font-weight:500; font-size:13.5px; transition:background .12s,color .12s; }
  #tabs button:hover { background:var(--accent-weak); color:var(--text); }
  #tabs button.active { background:var(--accent-weak); color:var(--accent); font-weight:650; box-shadow:inset 2px 0 0 var(--accent); }
  .side-foot { margin-top:auto; padding:12px 8px 4px; }
  .chip { display:inline-block; text-transform:uppercase; font-size:10.5px; letter-spacing:.08em; color:var(--muted);
    border:1px solid var(--border); border-radius:999px; padding:3px 10px; }
  .mainwrap { display:flex; flex-direction:column; min-width:0; }
  .topbar { min-height:56px; display:flex; align-items:center; padding:0 30px; border-bottom:1px solid var(--border);
    color:var(--muted); font-size:13px; position:sticky; top:0; background:var(--bg); z-index:5; }
  main { padding:26px 30px 90px; width:100%; max-width:1000px; }
  @media (max-width:760px) {
    #app { grid-template-columns:1fr; }
    .side { position:static; height:auto; flex-direction:row; align-items:center; overflow-x:auto; padding:10px 12px; }
    .brand { padding:6px 8px; }
    #tabs { flex-direction:row; }
    .side-foot { display:none; }
    main { padding:18px 16px 70px; }
  }
</style>
</head>
<body>
<div id="lock" class="overlay" hidden>
  <div class="card">
    <div class="spinner"></div>
    <h2>Confirm in Discord to unlock</h2>
    <p class="muted">In Discord, press <strong>Activate session</strong> and enter this code:</p>
    <div id="lockcode" class="code">••••-••••</div>
    <p class="muted" id="lockstatus">Waiting for confirmation…</p>
  </div>
</div>
<div id="expired" class="overlay" hidden>
  <div class="card">
    <h2>Session ended</h2>
    <p class="muted">This panel session expired or was revoked. Re-run <strong>/config</strong> or <strong>/intercom</strong> in Discord for a fresh link.</p>
  </div>
</div>
<div id="app" hidden>
  <aside class="side">
    <div class="brand"><span class="dot">⚙</span> Admin panel</div>
    <nav id="tabs"></nav>
    <div class="side-foot"><span class="chip" id="grp"></span></div>
  </aside>
  <div class="mainwrap">
    <header class="topbar"><span id="who"></span></header>
    <main>
      <div id="flash" class="flash"></div>
      <div id="content"><p class="note">Loading…</p></div>
    </main>
  </div>
</div>
<dialog id="modal">
  <h2 id="modalTitle"></h2>
  <div class="summary" id="modalSummary"></div>
  <div id="modalInputs"></div>
  <div id="modalReverse" hidden>
    <label>Reverse code from Discord</label>
    <p class="muted">Press <strong>Show destructive-action code</strong> in Discord and enter the code:</p>
    <input type="text" id="reverseCode" autocomplete="off">
  </div>
  <div id="modalConfirm" hidden>
    <label>This action is destructive — type CONFIRM to proceed</label>
    <input type="text" id="confirmWord" autocomplete="off">
  </div>
  <div id="modalErr" class="error" hidden></div>
  <div class="drow">
    <button class="btn" id="modalCancel" type="button">Cancel</button>
    <button class="btn primary" id="modalGo" type="button">Run</button>
  </div>
</dialog>
<script nonce="${ctx.nonce}">
"use strict";
(function () {
  var lock = document.getElementById("lock");
  var lockcode = document.getElementById("lockcode");
  var expired = document.getElementById("expired");
  var app = document.getElementById("app");
  var whoEl = document.getElementById("who");
  var grpEl = document.getElementById("grp");
  var tabsEl = document.getElementById("tabs");
  var flashEl = document.getElementById("flash");
  var contentEl = document.getElementById("content");
  var modal = document.getElementById("modal");
  var state = { group: null, hub: null, view: null, scope: null };
  var dragSrc = null;

  function api(endpoint, body) {
    return fetch("/admin/panel/api/" + endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Panel-Request": "1" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; },
        function () { return { status: r.status, j: {} }; });
    });
  }

  function showExpired() { app.hidden = true; lock.hidden = true; expired.hidden = false; }

  function handle(res) {
    if (res.status === 401 || (res.j && res.j.state === "expired")) { showExpired(); return null; }
    return res.j;
  }

  // ---- activation poll ----
  var pollTimer = null;
  function poll() {
    api("activation-status", {}).then(function (res) {
      var j = handle(res);
      if (!j) return;
      if (j.state === "locked") {
        lock.hidden = false; app.hidden = true;
        if (j.activationCode) lockcode.textContent = j.activationCode;
        pollTimer = setTimeout(poll, 3000);
        return;
      }
      if (j.state === "active") {
        lock.hidden = true; app.hidden = false;
        whoEl.textContent = "Acting as " + (j.adminName || "");
        grpEl.textContent = j.group || "";
        state.group = j.group;
        loadHub(j.defaultHub);
        return;
      }
      showExpired();
    }).catch(function () { pollTimer = setTimeout(poll, 5000); });
  }

  // ---- flash ----
  function clearFlash() { flashEl.textContent = ""; flashEl.className = "flash"; }
  function flashOk(msg) { flashEl.textContent = msg; flashEl.className = "flash ok"; setTimeout(function () { if (flashEl.classList.contains("ok")) clearFlash(); }, 2600); }
  function flashErr(msg) { flashEl.textContent = msg; flashEl.className = "flash error"; }

  // ---- hub load / render ----
  function loadHub(hub, tab, scope) {
    clearFlash();
    contentEl.textContent = "";
    contentEl.appendChild(el("p", "note", "Loading…"));
    api("view", { hub: hub, tab: tab, scope: scope }).then(function (res) {
      var v = handle(res); if (!v) return;
      if (v.error) { contentEl.textContent = ""; contentEl.appendChild(el("p", "error", v.error)); return; }
      state.hub = v.hub; state.view = v;
      renderTabs(v); renderView(v);
    });
  }

  function renderTabs(v) {
    tabsEl.textContent = "";
    (v.tabs || []).forEach(function (t) {
      var b = document.createElement("button");
      b.textContent = t.label;
      if (t.key === v.activeTab) b.className = "active";
      b.addEventListener("click", function () { loadHub(t.key); });
      tabsEl.appendChild(b);
    });
  }

  function renderView(v) {
    contentEl.textContent = "";
    state.scope = v.scope ? v.scope.value : null;
    if (v.scope) {
      var sc = el("div", "section");
      sc.appendChild(labelFor("scope_sel", v.scope.label));
      var scsel = document.createElement("select"); scsel.id = "scope_sel";
      (v.scope.options || []).forEach(function (o) { scsel.appendChild(opt(o.value, o.label)); });
      scsel.value = v.scope.value;
      scsel.addEventListener("change", function () { loadHub(v.hub, v.activeTab, scsel.value); });
      sc.appendChild(scsel);
      contentEl.appendChild(sc);
    }
    (v.sections || []).forEach(function (sec) {
      var box = el("div", "section");
      box.appendChild(el("h2", null, sec.title));
      if (sec.description) box.appendChild(el("p", "desc", sec.description));
      if (sec.notice) box.appendChild(badge(sec.notice));
      (sec.fields || []).forEach(function (f) { box.appendChild(renderField(sec, f)); });
      (sec.actions || []).forEach(function (a) { var b = actionBtn(v.hub, a); b.classList.add("secfoot"); box.appendChild(b); });
      contentEl.appendChild(box);
    });
  }

  // ---- fields ----
  function renderField(sec, f) {
    var wrap = el("div", "field");
    var id = "f_" + f.key;
    if (f.type === "toggle") {
      var lab = el("label", "switch");
      var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!f.value; cb.disabled = !!f.disabled;
      cb.addEventListener("change", function () { saveField(state.hub, sec.key, f.key, cb.checked, wrap); });
      lab.appendChild(cb); lab.appendChild(document.createTextNode(f.label));
      wrap.appendChild(lab);
    } else if (f.type === "static") {
      wrap.appendChild(labelFor(id, f.label));
      var line = el("div", null, f.value + " ");
      if (f.badge) line.appendChild(badge(f.badge));
      wrap.appendChild(line);
    } else if (f.type === "text") {
      wrap.appendChild(labelFor(id, f.label));
      var inp = document.createElement(f.multiline ? "textarea" : "input");
      if (!f.multiline) inp.type = f.secret ? "password" : "text";
      inp.id = id; inp.value = f.value || ""; inp.disabled = !!f.disabled;
      inp.autocomplete = "off";
      if (f.placeholder) inp.placeholder = f.placeholder;
      if (f.secret && f.secretState) inp.placeholder = secretPlaceholder(f.secretState);
      commitOnBlur(inp, function () { saveField(state.hub, sec.key, f.key, inp.value, wrap); });
      wrap.appendChild(inp);
    } else if (f.type === "number") {
      wrap.appendChild(labelFor(id, f.label));
      var n = document.createElement("input"); n.type = "number"; n.id = id;
      n.value = (f.value === null || f.value === undefined) ? "" : String(f.value);
      if (f.min !== undefined) n.min = String(f.min);
      if (f.max !== undefined) n.max = String(f.max);
      if (f.step !== undefined) n.step = String(f.step);
      commitOnBlur(n, function () { saveField(state.hub, sec.key, f.key, n.value === "" ? null : Number(n.value), wrap); });
      wrap.appendChild(n);
    } else if (f.type === "select" || f.type === "channel-select" || f.type === "role-select") {
      wrap.appendChild(labelFor(id, f.label));
      var sel = document.createElement("select"); sel.id = id; sel.disabled = !!f.disabled;
      if (f.nullable) sel.appendChild(opt("", "— none —"));
      (f.options || []).forEach(function (o) { sel.appendChild(opt(o.value, o.label)); });
      sel.value = f.value == null ? "" : f.value;
      sel.addEventListener("change", function () { saveField(state.hub, sec.key, f.key, sel.value === "" ? null : sel.value, wrap); });
      wrap.appendChild(sel);
      if ((f.options || []).length === 0) wrap.appendChild(el("div", "help", "No options available (is the bot in the guild?)."));
    } else if (f.type === "multiselect") {
      wrap.appendChild(labelFor(id, f.label));
      var box2 = el("div", "ms");
      (f.options || []).forEach(function (o) {
        var l = el("label", "switch");
        var c = document.createElement("input"); c.type = "checkbox"; c.checked = (f.values || []).indexOf(o.value) >= 0;
        c.addEventListener("change", function () {
          var vals = (f.values || []).slice();
          if (c.checked) { if (vals.indexOf(o.value) < 0) vals.push(o.value); }
          else { vals = vals.filter(function (x) { return x !== o.value; }); }
          f.values = vals; saveField(state.hub, sec.key, f.key, vals, wrap);
        });
        l.appendChild(c); l.appendChild(document.createTextNode(o.label)); box2.appendChild(l);
      });
      wrap.appendChild(box2);
      if ((f.options || []).length === 0) wrap.appendChild(el("div", "help", "No options available."));
    } else if (f.type === "list") {
      wrap.appendChild(el("div", "flabel", f.label));
      wrap.appendChild(renderList(sec, f));
      if (f.addAction) { var ab = actionBtn(state.hub, f.addAction); ab.classList.add("secfoot"); wrap.appendChild(ab); }
    } else if (f.type === "sla-condition-builder") {
      wrap.appendChild(labelFor(id, f.label));
      wrap.appendChild(el("p", "help", "Rule builder loads here (see SLA hub)."));
    }
    if (f.help) wrap.appendChild(el("div", "help", f.help));
    var errSlot = el("div", "ferr"); errSlot.id = "err_" + f.key; errSlot.hidden = true; wrap.appendChild(errSlot);
    return wrap;
  }

  function clearDropMarks(tbody) {
    Array.prototype.forEach.call(tbody.children, function (tr) { tr.classList.remove("drop-above", "drop-below"); });
  }

  function reorderRow(f, id, from, to) {
    var steps = Math.abs(to - from);
    var key = to < from ? f.reorder.upKey : f.reorder.downKey;
    var chain = Promise.resolve();
    for (var i = 0; i < steps; i++) {
      chain = chain.then(function () { return api("action", { hub: state.hub, key: key, params: { id: id }, scope: state.scope }); });
    }
    chain.then(function () { flashOk("Reordered."); loadHub(state.hub); });
  }

  function renderList(sec, f) {
    var table = document.createElement("table");
    var thead = document.createElement("thead"); var htr = document.createElement("tr");
    if (f.reorder) htr.appendChild(document.createElement("th"));
    (f.columns || []).forEach(function (c) { var th = document.createElement("th"); th.textContent = c; htr.appendChild(th); });
    htr.appendChild(document.createElement("th"));
    thead.appendChild(htr); table.appendChild(thead);
    var tbody = document.createElement("tbody");
    (f.rows || []).forEach(function (row, idx) {
      var tr = document.createElement("tr");
      if (f.reorder) {
        tr.draggable = true;
        tr.addEventListener("dragstart", function (e) { dragSrc = { f: f, id: row.id, idx: idx }; tr.classList.add("dragging"); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; });
        tr.addEventListener("dragend", function () { tr.classList.remove("dragging"); clearDropMarks(tbody); });
        tr.addEventListener("dragover", function (e) { if (!dragSrc) return; e.preventDefault(); clearDropMarks(tbody); tr.classList.add(idx < dragSrc.idx ? "drop-above" : "drop-below"); });
        tr.addEventListener("drop", function (e) { if (!dragSrc) return; e.preventDefault(); var from = dragSrc.idx, id = dragSrc.id, rf = dragSrc.f; dragSrc = null; clearDropMarks(tbody); if (idx !== from) reorderRow(rf, id, from, idx); });
        var g = document.createElement("td"); g.className = "grip"; var h = el("span", "grip-h", "⠿"); h.title = "Drag to reorder"; g.appendChild(h); tr.appendChild(g);
      }
      (row.cells || []).forEach(function (cell) {
        var td = document.createElement("td");
        if (cell && typeof cell === "object" && cell.kind) td.appendChild(badge(cell));
        else td.textContent = String(cell);
        tr.appendChild(td);
      });
      var act = document.createElement("td"); act.className = "act";
      (row.rowActions || []).forEach(function (a) { var b = actionBtn(state.hub, a); b.classList.add("sm"); act.appendChild(b); });
      tr.appendChild(act); tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  // ---- save ----
  function saveField(hub, section, field, value, wrap) {
    setFieldErr(field, null);
    api("save", { hub: hub, section: section, field: field, value: value, scope: state.scope }).then(function (res) {
      var j = handle(res); if (!j) return;
      if (j.ok) { flashOk("Saved."); if (j.view) { state.view = j.view; renderView(j.view); } }
      else {
        if (j.fieldErrors) Object.keys(j.fieldErrors).forEach(function (k) { setFieldErr(k, j.fieldErrors[k]); });
        if (j.error) flashErr(j.error); else if (!j.fieldErrors) flashErr("Save failed.");
      }
    });
  }

  function setFieldErr(field, msg) {
    var slot = document.getElementById("err_" + field); if (!slot) return;
    if (msg) { slot.textContent = msg; slot.hidden = false; } else { slot.textContent = ""; slot.hidden = true; }
  }

  // ---- action modal ----
  var modalState = null;
  function actionBtn(hub, a) {
    var b = document.createElement("button");
    b.className = "btn" + (a.style === "primary" ? " primary" : "") + (a.dangerous || a.style === "danger" ? " danger" : "");
    b.textContent = a.label;
    var simple = !(a.inputs && a.inputs.length) && !a.dangerous && !a.reverseConfirm;
    b.addEventListener("click", function () {
      if (simple) dispatchAction({ hub: hub, key: a.key, params: a.params || {} }, null);
      else openModal(hub, a);
    });
    return b;
  }

  function dispatchAction(body, onErr) {
    if (state.scope) body.scope = state.scope;
    api("action", body).then(function (res) {
      var j = handle(res); if (!j) return;
      if (j.ok) { if (modal.open) modal.close(); flashOk(j.text || "Done."); if (j.view) { state.view = j.view; renderView(j.view); } else loadHub(state.hub); }
      else if (j.needsReverse) { if (onErr) onErr("reverse"); else flashErr("This action needs the Discord reverse code — reopen it."); }
      else { if (onErr) onErr(j.error || "Action failed."); else flashErr(j.error || "Action failed."); }
    });
  }

  function openModal(hub, a) {
    modalState = { hub: hub, action: a };
    document.getElementById("modalTitle").textContent = a.label;
    document.getElementById("modalSummary").textContent = a.summary || "";
    var inputsEl = document.getElementById("modalInputs"); inputsEl.textContent = "";
    (a.inputs || []).forEach(function (inp) {
      if (inp.type === "toggle") {
        var tl = document.createElement("label"); tl.className = "switch";
        var cb = document.createElement("input"); cb.type = "checkbox"; cb.id = "mi_" + inp.key; cb.checked = !!inp.value;
        tl.appendChild(cb); tl.appendChild(document.createTextNode(" " + inp.label)); inputsEl.appendChild(tl);
        return;
      }
      var l = document.createElement("label"); l.textContent = inp.label; inputsEl.appendChild(l);
      if (inp.type === "select") {
        var sel = document.createElement("select"); sel.id = "mi_" + inp.key;
        if (inp.nullable) sel.appendChild(opt("", "— none —"));
        (inp.options || []).forEach(function (o) { sel.appendChild(opt(o.value, o.label)); });
        sel.value = inp.value == null ? "" : inp.value;
        inputsEl.appendChild(sel);
        return;
      }
      var ctrl = document.createElement(inp.multiline ? "textarea" : "input");
      if (!inp.multiline) ctrl.type = inp.type === "number" ? "number" : (inp.secret ? "password" : "text");
      ctrl.id = "mi_" + inp.key; ctrl.autocomplete = "off";
      if (inp.value != null && inp.value !== "" && !inp.secret) ctrl.value = String(inp.value);
      if (inp.placeholder) ctrl.placeholder = inp.placeholder;
      inputsEl.appendChild(ctrl);
    });
    document.getElementById("modalReverse").hidden = !a.reverseConfirm;
    document.getElementById("reverseCode").value = "";
    document.getElementById("modalConfirm").hidden = !a.dangerous;
    document.getElementById("confirmWord").value = "";
    var errEl = document.getElementById("modalErr"); errEl.hidden = true; errEl.textContent = "";
    modal.showModal();
  }

  document.getElementById("modalCancel").addEventListener("click", function () { modal.close(); });
  document.getElementById("modalGo").addEventListener("click", function () {
    if (!modalState) return;
    var a = modalState.action;
    var params = Object.assign({}, a.params || {});
    (a.inputs || []).forEach(function (inp) {
      var c = document.getElementById("mi_" + inp.key);
      if (inp.type === "toggle") params[inp.key] = c.checked;
      else if (inp.type === "number") params[inp.key] = c.value === "" ? null : Number(c.value);
      else params[inp.key] = c.value;
    });
    var body = { hub: modalState.hub, key: a.key, params: params };
    if (a.dangerous) body.confirmWord = document.getElementById("confirmWord").value;
    if (a.reverseConfirm) body.reverseCode = document.getElementById("reverseCode").value;
    if (a.dangerous && body.confirmWord !== "CONFIRM") { modalErr("Type CONFIRM to proceed."); return; }
    dispatchAction(body, function (kind) {
      if (kind === "reverse") { document.getElementById("modalReverse").hidden = false; modalErr("Enter the reverse code from Discord."); }
      else modalErr(kind);
    });
  });
  function modalErr(msg) { var e = document.getElementById("modalErr"); e.textContent = msg; e.hidden = false; }

  // ---- helpers ----
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function labelFor(id, text) { var l = document.createElement("label"); l.className = "flabel"; l.htmlFor = id; l.textContent = text; return l; }
  function opt(value, label) { var o = document.createElement("option"); o.value = value; o.textContent = label; return o; }
  function badge(b) { return el("span", "badge " + (b.kind || "info"), b.text); }
  function secretPlaceholder(stateStr) {
    if (stateStr === "local") return "configured — leave blank to keep";
    if (stateStr === "vault") return "configured (vault) — leave blank to keep";
    if (stateStr === "vault-unreachable") return "configured (vault unreachable)";
    if (stateStr === "local-unreadable") return "configured (unreadable — re-enter)";
    return "not set";
  }
  function commitOnBlur(inp, fn) {
    inp.addEventListener("blur", fn);
    inp.addEventListener("keydown", function (e) { if (e.key === "Enter" && inp.tagName !== "TEXTAREA") { inp.blur(); } });
  }

  poll();
})();
</script>
</body>
</html>`;
}
