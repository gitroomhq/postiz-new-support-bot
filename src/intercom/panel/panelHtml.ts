// Self-contained HTML for the Stripe panel page. No build pipeline exists in
// this repo, so the page ships as a template string: inline CSS + vanilla JS,
// zero external requests (the CSP forbids them anyway — only same-origin XHR
// to /intercom/panel/api/* is allowed).
//
// The page is dumb on purpose: every table row and every action button is
// described by the server (IntercomPanel), so authorization and Stripe
// knowledge live server-side only. The client renders sections generically:
//   section = { title, columns[], rows[], sectionActions[], nextCursor }
//   row     = { cells[], actions[] }
//   action  = { label, actionKey, params, dangerous, mode, inputs[], approvalId?, decision? }
// Auth: the page carries NO credential at all — GET /intercom/panel exchanged
// the single-use link token for an HttpOnly SameSite=Strict session cookie,
// which the browser attaches to the same-origin API calls automatically. The
// fetch wrapper adds the X-Panel-Request header (CSRF belt: cross-origin forms
// can't send custom headers without a CORS preflight, which the server never
// answers). All dynamic rendering uses textContent — never innerHTML with
// data. The inline style/script blocks are CSP-nonced.

export interface PanelShellCtx {
  adminName: string;
  isAdmin: boolean;
  customerLabel: string; // e.g. "cus_… (mail@x)" or "no linked Stripe customer"
  hasCustomer: boolean;
  nonce: string; // CSP nonce for the inline <style nonce="${ctx.nonce}"> and <script nonce="${ctx.nonce}">
}

export function renderPanelShell(ctx: PanelShellCtx): string {
  const banner = `${escapeHtml(ctx.adminName)} · ${ctx.isAdmin ? "admin" : "support agent"}`;
  const customer = escapeHtml(ctx.customerLabel);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Stripe panel</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #f6f8fa; color: #1f2328; }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline;
           padding: 14px 20px; background: #fff; border-bottom: 1px solid #d0d7de; }
  header h1 { font-size: 16px; margin: 0; }
  header .who { color: #57606a; }
  header .cus { margin-left: auto; font-family: ui-monospace, monospace; color: #57606a; }
  nav { display: flex; gap: 4px; padding: 8px 20px 0; flex-wrap: wrap; }
  nav button { border: 1px solid #d0d7de; border-bottom: none; background: #eaeef2; padding: 7px 14px;
               border-radius: 6px 6px 0 0; cursor: pointer; font: inherit; }
  nav button.active { background: #fff; font-weight: 600; }
  main { padding: 16px 20px 60px; }
  .note { color: #57606a; margin: 8px 0; }
  .error { color: #cf222e; margin: 8px 0; white-space: pre-wrap; }
  .ok { color: #1a7f37; margin: 8px 0; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #d0d7de;
          border-radius: 6px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-top: 1px solid #d0d7de; vertical-align: top; }
  thead th { border-top: none; background: #f6f8fa; font-weight: 600; }
  td.actions { white-space: nowrap; }
  .btn { display: inline-block; margin: 2px 4px 2px 0; padding: 4px 10px; font: inherit; font-size: 13px;
         border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; cursor: pointer; }
  .btn:hover { background: #eaeef2; }
  .btn.danger { color: #cf222e; border-color: #cf222e33; }
  .btn.queue { font-style: italic; }
  .pager { margin: 10px 0; display: flex; gap: 8px; }
  .sectionActions { margin: 0 0 12px; }
  dialog { border: 1px solid #d0d7de; border-radius: 8px; padding: 18px; max-width: 460px; width: 90%; }
  dialog h2 { margin: 0 0 6px; font-size: 15px; }
  dialog .summary { color: #57606a; margin-bottom: 12px; white-space: pre-wrap; }
  dialog label { display: block; margin: 8px 0 2px; font-weight: 600; font-size: 13px; }
  dialog input[type=text], dialog input[type=number] { width: 100%; padding: 6px 8px; font: inherit;
         border: 1px solid #d0d7de; border-radius: 6px; }
  dialog .row { margin-top: 14px; display: flex; gap: 8px; justify-content: flex-end; }
  .confirmWord { border-color: #cf222e !important; }
  .expiredWrap { padding: 40px 20px; font: 15px sans-serif; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    header, table { background: #161b22; border-color: #30363d; }
    thead th { background: #21262d; }
    th, td { border-color: #30363d; }
    nav button { background: #21262d; border-color: #30363d; color: #e6edf3; }
    nav button.active { background: #161b22; }
    .btn { background: #21262d; border-color: #30363d; color: #e6edf3; }
    dialog { background: #161b22; color: #e6edf3; border-color: #30363d; }
    dialog input[type=text], dialog input[type=number] { background: #0d1117; color: #e6edf3; border-color: #30363d; }
    header .who, header .cus, .note, dialog .summary { color: #8d96a0; }
  }
</style>
</head>
<body>
<header>
  <h1>Stripe panel</h1>
  <span class="who">acting as ${banner}</span>
  <span class="cus">${customer}</span>
</header>
<nav id="tabs"></nav>
<main>
  <div id="flash"></div>
  <div id="content"><p class="note">Loading…</p></div>
</main>
<dialog id="modal">
  <h2 id="modalTitle"></h2>
  <div class="summary" id="modalSummary"></div>
  <div id="modalInputs"></div>
  <div id="modalConfirm" hidden>
    <label>This action is destructive — type CONFIRM to proceed</label>
    <input type="text" id="confirmWord" class="confirmWord" autocomplete="off">
  </div>
  <div class="row">
    <button class="btn" id="modalCancel" type="button">Cancel</button>
    <button class="btn danger" id="modalGo" type="button">Run</button>
  </div>
</dialog>
<script>
"use strict";
(function () {
  var SECTIONS = ${JSON.stringify([
    { key: "overview", title: "Overview" },
    { key: "charges", title: "Charges" },
    { key: "subscriptions", title: "Subscriptions" },
    { key: "invoices", title: "Invoices" },
    { key: "payment_methods", title: "Payment methods" },
    { key: "balance", title: "Balance" },
    { key: "disputes", title: "Disputes" },
    { key: "approvals", title: "Approvals" },
  ])};
  var current = "overview";
  var cursors = {}; // section -> stack of cursors for Back
  var flash = document.getElementById("flash");
  var content = document.getElementById("content");

  function api(endpoint, body) {
    return fetch("/intercom/panel/api/" + endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Panel-Request": "1" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      if (res.status === 401) { expired(); throw new Error("expired"); }
      return res.json().then(function (json) {
        if (!res.ok) throw new Error(json && json.error ? json.error : ("HTTP " + res.status));
        return json;
      });
    });
  }

  function expired() {
    // Static markup only — never data. (Class, not a style attribute: the
    // CSP nonce covers the <style> block but not inline style attributes.)
    document.body.innerHTML = '<main class="expiredWrap">' +
      "<h1>Session expired</h1><p>Panel sessions end after 10 minutes idle (30 minutes max). " +
      "Reopen it from the Intercom conversation (Open Stripe Panel).</p></main>";
  }

  function setFlash(kind, text) {
    flash.innerHTML = "";
    if (!text) return;
    var p = document.createElement("p");
    p.className = kind;
    p.textContent = text;
    flash.appendChild(p);
  }

  function el(tag, cls, textContent) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (textContent != null) node.textContent = textContent;
    return node;
  }

  // ---- modal ----
  var modal = document.getElementById("modal");
  var pendingRun = null;
  function openModal(action) {
    document.getElementById("modalTitle").textContent = action.label;
    document.getElementById("modalSummary").textContent =
      (action.mode === "queue" ? "Will be QUEUED for admin approval.\\n" : "") + (action.summary || "");
    var inputsBox = document.getElementById("modalInputs");
    inputsBox.innerHTML = "";
    (action.inputs || []).forEach(function (input) {
      var label = el("label", null, input.label);
      var field = document.createElement("input");
      field.type = input.type === "number" ? "number" : "text";
      field.id = "in_" + input.key;
      if (input.placeholder) field.placeholder = input.placeholder;
      inputsBox.appendChild(label);
      inputsBox.appendChild(field);
    });
    var confirmBox = document.getElementById("modalConfirm");
    confirmBox.hidden = !action.dangerous;
    document.getElementById("confirmWord").value = "";
    document.getElementById("modalGo").textContent = action.mode === "queue" ? "Request approval" : "Run";
    pendingRun = action;
    modal.showModal();
  }
  document.getElementById("modalCancel").onclick = function () { modal.close(); pendingRun = null; };
  document.getElementById("modalGo").onclick = function () {
    if (!pendingRun) return;
    var action = pendingRun;
    if (action.dangerous && document.getElementById("confirmWord").value.trim() !== "CONFIRM") {
      alert("Type CONFIRM to proceed."); return;
    }
    var params = {};
    Object.keys(action.params || {}).forEach(function (k) { params[k] = action.params[k]; });
    var bad = null;
    (action.inputs || []).forEach(function (input) {
      var raw = document.getElementById("in_" + input.key).value.trim();
      if (!raw) { bad = input.label + " is required."; return; }
      params[input.key] = input.type === "number" ? Number(raw) : raw;
    });
    if (bad) { alert(bad); return; }
    modal.close(); pendingRun = null;
    setFlash("note", "Running…");
    var call = action.approvalId
      ? api("approval-act", { approvalId: action.approvalId, decision: action.decision })
      : api("action", { actionKey: action.actionKey, params: params });
    call.then(function (result) {
      setFlash(result.ok ? "ok" : "error", result.text || result.error || "done");
      load(current);
    }).catch(function (e) {
      if (e.message !== "expired") setFlash("error", e.message);
    });
  };

  // ---- rendering ----
  function renderActions(actions, container) {
    (actions || []).forEach(function (action) {
      var btn = el("button", "btn" + (action.dangerous ? " danger" : "") + (action.mode === "queue" ? " queue" : ""),
        action.label + (action.mode === "queue" ? " (request approval)" : ""));
      btn.type = "button";
      // Every action goes through the modal — even one-click ones get the
      // summary + explicit Run step.
      btn.onclick = function () { openModal(action); };
      container.appendChild(btn);
    });
  }

  function renderSection(section) {
    content.innerHTML = "";
    if (section.notice) content.appendChild(el("p", "note", section.notice));
    if (section.sectionActions && section.sectionActions.length) {
      var box = el("div", "sectionActions");
      renderActions(section.sectionActions, box);
      content.appendChild(box);
    }
    if (section.rows && section.rows.length) {
      var table = document.createElement("table");
      var thead = document.createElement("thead");
      var headRow = document.createElement("tr");
      (section.columns || []).forEach(function (c) { headRow.appendChild(el("th", null, c)); });
      if (section.hasRowActions) headRow.appendChild(el("th", null, "Actions"));
      thead.appendChild(headRow);
      table.appendChild(thead);
      var tbody = document.createElement("tbody");
      section.rows.forEach(function (row) {
        var tr = document.createElement("tr");
        row.cells.forEach(function (cell) { tr.appendChild(el("td", null, cell)); });
        if (section.hasRowActions) {
          var td = el("td", "actions");
          renderActions(row.actions, td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      content.appendChild(table);
    } else if (!section.notice) {
      content.appendChild(el("p", "note", "Nothing here."));
    }
    var pager = el("div", "pager");
    var stack = cursors[current] || [];
    if (stack.length > 0) {
      var back = el("button", "btn", "◀ Back");
      back.type = "button";
      back.onclick = function () { stack.pop(); load(current); };
      pager.appendChild(back);
    }
    if (section.nextCursor) {
      var next = el("button", "btn", "Load next ▶");
      next.type = "button";
      next.onclick = function () { (cursors[current] = cursors[current] || []).push(section.nextCursor); load(current); };
      pager.appendChild(next);
    }
    if (pager.children.length) content.appendChild(pager);
  }

  function load(sectionKey) {
    current = sectionKey;
    Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (b) {
      b.className = b.dataset.key === sectionKey ? "active" : "";
    });
    content.innerHTML = '<p class="note">Loading…</p>';
    var stack = cursors[sectionKey] || [];
    api("list", { section: sectionKey, cursor: stack.length ? stack[stack.length - 1] : null })
      .then(renderSection)
      .catch(function (e) {
        if (e.message === "expired") return;
        content.innerHTML = "";
        content.appendChild(el("p", "error", e.message)); // textContent — server errors can echo request data
      });
  }

  // ---- boot ----
  var tabs = document.getElementById("tabs");
  SECTIONS.forEach(function (s) {
    var b = el("button", null, s.title);
    b.dataset.key = s.key;
    b.type = "button";
    b.onclick = function () { setFlash(null, null); load(s.key); };
    tabs.appendChild(b);
  });
  load("overview");
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
