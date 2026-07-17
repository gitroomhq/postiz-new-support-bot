// Self-contained HTML for the admin web panel (/config + /intercom). Like the
// Stripe panel it ships as a template string (no build pipeline): inline CSS +
// vanilla JS, zero external requests (the strict CSP forbids them — only
// same-origin XHR to /admin/panel/api/* is allowed).
//
// The page is dumb on purpose: the server (AdminPanel + hub modules) describes
// every section, field and button; the client renders generically and posts
// changes back. All dynamic text goes through textContent — never innerHTML with
// data. Styling is driven by classes + the [hidden] attribute (never inline
// style attributes / element.style), because the CSP nonces the <style> block
// but does NOT cover inline style attributes.
//
// Auth: the page carries NO credential — GET /admin/panel exchanged the
// single-use link token for an HttpOnly SameSite=Strict cookie. The fetch
// wrapper adds X-Panel-Request (CSRF belt). The <style>/<script> tags ARE nonced
// (unlike the original Stripe panel, whose missing nonce made it inert).

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
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #f6f8fa; color: #1f2328; }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline;
           padding: 14px 20px; background: #fff; border-bottom: 1px solid #d0d7de; }
  header h1 { font-size: 16px; margin: 0; }
  header .who { color: #57606a; }
  header .grp { margin-left: auto; font-family: ui-monospace, monospace; color: #57606a; text-transform: uppercase; letter-spacing: .05em; font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 8px 20px 0; flex-wrap: wrap; }
  nav button { border: 1px solid #d0d7de; border-bottom: none; background: #eaeef2; padding: 7px 14px;
               border-radius: 6px 6px 0 0; cursor: pointer; font: inherit; }
  nav button.active { background: #fff; font-weight: 600; }
  main { padding: 16px 20px 60px; max-width: 860px; }
  .note { color: #57606a; margin: 8px 0; }
  .error { color: #cf222e; margin: 8px 0; white-space: pre-wrap; }
  .ok { color: #1a7f37; margin: 8px 0; white-space: pre-wrap; }
  .section { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 16px; margin: 0 0 16px; }
  .section h2 { font-size: 15px; margin: 0 0 2px; }
  .section .desc { color: #57606a; margin: 0 0 10px; }
  .field { padding: 10px 0; border-top: 1px solid #eaeef2; }
  .field:first-of-type { border-top: none; }
  .field label.flabel { display: block; font-weight: 600; margin-bottom: 4px; }
  .field .help { color: #57606a; font-size: 13px; margin-top: 4px; }
  .field .ferr { color: #cf222e; font-size: 13px; margin-top: 4px; }
  input[type=text], input[type=number], input[type=password], select, textarea {
    width: 100%; padding: 6px 8px; font: inherit; border: 1px solid #d0d7de; border-radius: 6px;
    background: #fff; color: inherit; }
  textarea { min-height: 70px; }
  .row-inline { display: flex; align-items: center; gap: 10px; }
  .row-inline .grow { flex: 1; }
  .switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
  .switch input { width: auto; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid; }
  .badge.info { color: #0969da; border-color: #0969da55; }
  .badge.ok { color: #1a7f37; border-color: #1a7f3755; }
  .badge.warn { color: #9a6700; border-color: #9a670055; }
  .badge.error { color: #cf222e; border-color: #cf222e55; }
  .btn { display: inline-block; margin: 2px 6px 2px 0; padding: 6px 12px; font: inherit; font-size: 13px;
         border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; cursor: pointer; }
  .btn:hover { background: #eaeef2; }
  .btn.primary { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  .btn.danger { color: #cf222e; border-color: #cf222e55; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 10px; border-top: 1px solid #eaeef2; vertical-align: top; }
  thead th { border-top: none; font-weight: 600; }
  dialog { border: 1px solid #d0d7de; border-radius: 8px; padding: 18px; max-width: 480px; width: 92%; color: inherit; background: #fff; }
  dialog h2 { margin: 0 0 6px; font-size: 15px; }
  dialog .summary { color: #57606a; margin-bottom: 12px; white-space: pre-wrap; }
  dialog label { display: block; margin: 8px 0 2px; font-weight: 600; font-size: 13px; }
  dialog .drow { margin-top: 14px; display: flex; gap: 8px; justify-content: flex-end; }
  .overlay { position: fixed; inset: 0; background: #f6f8fa; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .overlay .card { background: #fff; border: 1px solid #d0d7de; border-radius: 12px; padding: 28px 32px; max-width: 460px; text-align: center; }
  .overlay h2 { margin: 0 0 10px; font-size: 18px; }
  .overlay .code { font-family: ui-monospace, monospace; font-size: 30px; letter-spacing: .12em; font-weight: 700; margin: 16px 0; padding: 12px; border: 1px dashed #d0d7de; border-radius: 8px; }
  .muted { color: #57606a; }
  [hidden] { display: none !important; }
  @media (prefers-color-scheme: dark) {
    body, .overlay { background: #0d1117; color: #e6edf3; }
    header, .section, dialog, .overlay .card, input, select, textarea { background: #161b22; border-color: #30363d; color: #e6edf3; }
    nav button { background: #21262d; border-color: #30363d; color: #e6edf3; }
    nav button.active { background: #161b22; }
    .field { border-color: #21262d; }
    .btn { background: #21262d; border-color: #30363d; color: #e6edf3; }
    .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
    th, td { border-color: #21262d; }
    header .who, header .grp, .note, .section .desc, .field .help, dialog .summary, .muted { color: #8d96a0; }
    .overlay .code { border-color: #30363d; }
  }
</style>
</head>
<body>
<div id="lock" class="overlay" hidden>
  <div class="card">
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
  <header>
    <h1 id="brand">Admin panel</h1>
    <span class="who" id="who"></span>
    <span class="grp" id="grp"></span>
  </header>
  <nav id="tabs"></nav>
  <main>
    <div id="flash"></div>
    <div id="content"><p class="note">Loading…</p></div>
  </main>
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
    // Returns the json payload, or triggers expiry on a dead session.
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
        whoEl.textContent = j.adminName || "";
        pollTimer = setTimeout(poll, 3000);
        return;
      }
      if (j.state === "active") {
        lock.hidden = true; app.hidden = false;
        whoEl.textContent = "acting as " + (j.adminName || "");
        grpEl.textContent = j.group || "";
        state.group = j.group;
        loadHub(j.defaultHub);
        return;
      }
      showExpired();
    }).catch(function () { pollTimer = setTimeout(poll, 5000); });
  }

  // ---- flash ----
  function clearFlash() { flashEl.textContent = ""; flashEl.className = ""; }
  function flashOk(msg) { flashEl.textContent = msg; flashEl.className = "ok"; setTimeout(function () { if (flashEl.className === "ok") clearFlash(); }, 2500); }
  function flashErr(msg) { flashEl.textContent = msg; flashEl.className = "error"; }

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
      (sec.actions || []).forEach(function (a) { box.appendChild(actionBtn(v.hub, a)); });
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
      var box2 = el("div", null);
      (f.options || []).forEach(function (o) {
        var l = el("label", "switch");
        var c = document.createElement("input"); c.type = "checkbox"; c.checked = (f.values || []).indexOf(o.value) >= 0;
        c.addEventListener("change", function () {
          var vals = (f.values || []).slice();
          if (c.checked) { if (vals.indexOf(o.value) < 0) vals.push(o.value); }
          else { vals = vals.filter(function (x) { return x !== o.value; }); }
          f.values = vals; saveField(state.hub, sec.key, f.key, vals, wrap);
        });
        l.appendChild(c); l.appendChild(document.createTextNode(o.label)); box2.appendChild(l); box2.appendChild(document.createElement("br"));
      });
      wrap.appendChild(box2);
    } else if (f.type === "list") {
      wrap.appendChild(el("div", "flabel", f.label));
      wrap.appendChild(renderList(sec, f));
      if (f.addAction) wrap.appendChild(actionBtn(state.hub, f.addAction));
    } else if (f.type === "sla-condition-builder") {
      wrap.appendChild(labelFor(id, f.label));
      wrap.appendChild(el("p", "help", "Rule builder loads here (see SLA hub)."));
    }
    if (f.help) wrap.appendChild(el("div", "help", f.help));
    var errSlot = el("div", "ferr"); errSlot.id = "err_" + f.key; errSlot.hidden = true; wrap.appendChild(errSlot);
    return wrap;
  }

  function renderList(sec, f) {
    var table = document.createElement("table");
    var thead = document.createElement("thead"); var htr = document.createElement("tr");
    (f.columns || []).forEach(function (c) { var th = document.createElement("th"); th.textContent = c; htr.appendChild(th); });
    htr.appendChild(document.createElement("th")); thead.appendChild(htr); table.appendChild(thead);
    var tbody = document.createElement("tbody");
    (f.rows || []).forEach(function (row) {
      var tr = document.createElement("tr");
      (row.cells || []).forEach(function (cell) {
        var td = document.createElement("td");
        if (cell && typeof cell === "object" && cell.kind) td.appendChild(badge(cell));
        else td.textContent = String(cell);
        tr.appendChild(td);
      });
      var act = document.createElement("td");
      (row.rowActions || []).forEach(function (a) { act.appendChild(actionBtn(state.hub, a)); });
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
      var ctrl = document.createElement("input");
      ctrl.type = inp.type === "number" ? "number" : (inp.secret ? "password" : "text"); ctrl.id = "mi_" + inp.key;
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
  function badge(b) { var s = el("span", "badge " + (b.kind || "info"), b.text); return s; }
  function secretPlaceholder(stateStr) {
    if (stateStr === "local") return "configured — leave blank to keep";
    if (stateStr === "vault") return "configured (vault) — leave blank to keep";
    if (stateStr === "vault-unreachable") return "configured (vault unreachable)";
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
