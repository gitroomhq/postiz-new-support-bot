// Client module: action buttons + the action modal (inputs, typed CONFIRM,
// Discord reverse-code slot). Ported from the admin panel's modal — the same
// three ceremony slots, plus the queue notice for approval-routed actions.

export const clientModal = `
D.modalState = null;

D.actionBtn = function (a) {
  var b = document.createElement("button");
  b.type = "button";
  // Color comes from style ONLY — "dangerous" is the typed-CONFIRM ceremony
  // flag, not a color (a primary Refund button must stay a primary button).
  b.className = "btn" + (a.style === "primary" ? " primary" : "") + (a.style === "danger" ? " danger" : "");
  b.textContent = a.label;
  if (a.disabledReason) {
    b.disabled = true;
    b.title = a.disabledReason;
    return b;
  }
  if (a.special === "passkey-register") {
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      var label = window.prompt("Name this passkey (e.g. MacBook Touch ID):", "") || "";
      D.passkeyRegister(label, a.params || {});
    });
    return b;
  }
  if (a.ref) {
    // Link-button: pure navigation (composer entry points) — nothing is posted.
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      D.navigateRef(a.ref);
    });
    return b;
  }
  var simple = !(a.inputs && a.inputs.length) && !a.dangerous && !a.reverseConfirm && a.mode !== "queue";
  b.addEventListener("click", function (e) {
    e.stopPropagation();
    if (D.closeAllPops) D.closeAllPops();
    if (simple) D.dispatchAction({ key: a.key, params: a.params || {} }, null);
    else D.openModal(a);
  });
  return b;
};

D.dispatchAction = function (body, onErr) {
  body.page = D.state.page;
  D.api("action", body).then(function (res) {
    var j = D.handle(res); if (!j) return;
    var modal = D.q("modal");
    if (j.ok) {
      if (modal.open) modal.close();
      // ActionResult.file: small binary riding the JSON channel (quote PDFs) —
      // b64 → bytes → Blob download.
      if (j.file && j.file.b64) {
        try {
          var bin = atob(j.file.b64);
          var bytes = new Uint8Array(bin.length);
          for (var bi = 0; bi < bin.length; bi++) bytes[bi] = bin.charCodeAt(bi);
          D.saveBlob(j.file.name || "download", j.file.mime || "application/octet-stream", bytes);
        } catch (e) {}
      }
      // loadPage clears the flash on entry — flash AFTER so the message (and
      // any short-lived j.link anchor) survives the reload.
      D.loadPage();
      D.flashOk(j.queued ? (j.text || "Queued for admin approval.") : (j.text || "Done."), j.link || null);
    } else if (j.needsStepUp) {
      // Fresh factor required (T2): run the step-up ceremony, then retry the
      // exact same request once.
      D.stepUpFlow(function () { D.dispatchAction(body, onErr); });
    } else if (j.needsReverse) {
      if (onErr) onErr("reverse");
      else D.flashErr("This action needs the Discord reverse code; reopen it.");
    } else {
      if (onErr) onErr(j.error || "Action failed.");
      else D.flashErr(j.error || "Action failed.");
    }
  });
};

D.openModal = function (a) {
  D.modalState = { action: a };
  D.q("modalTitle").textContent = a.label;
  var summary = a.summary || "";
  D.q("modalSummary").textContent = summary;
  D.q("modalQueue").hidden = a.mode !== "queue";
  var inputsEl = D.q("modalInputs"); inputsEl.textContent = "";
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
      (inp.options || []).forEach(function (o) { sel.appendChild(new Option(o.label, o.value)); });
      if (inp.value != null) sel.value = inp.value;
      inputsEl.appendChild(sel);
      return;
    }
    var ctrl = document.createElement(inp.multiline ? "textarea" : "input");
    if (!inp.multiline) ctrl.type = inp.type === "number" ? "number" : "text";
    ctrl.id = "mi_" + inp.key; ctrl.autocomplete = "off";
    if (inp.placeholder) ctrl.placeholder = inp.placeholder;
    if (inp.type === "number") {
      if (inp.min !== undefined) ctrl.min = String(inp.min);
      if (inp.max !== undefined) ctrl.max = String(inp.max);
    }
    inputsEl.appendChild(ctrl);
  });
  D.q("modalReverse").hidden = !a.reverseConfirm;
  D.q("reverseCode").value = "";
  D.q("modalConfirm").hidden = !a.dangerous;
  D.q("confirmWord").value = "";
  var errEl = D.q("modalErr"); errEl.hidden = true; errEl.textContent = "";
  D.q("modal").showModal();
};

D.modalErr = function (msg) { var e = D.q("modalErr"); e.textContent = msg; e.hidden = false; };

D.bindModal = function () {
  D.q("modalCancel").addEventListener("click", function () { D.q("modal").close(); });
  D.q("modalGo").addEventListener("click", function () {
    if (!D.modalState) return;
    var a = D.modalState.action;
    var params = {};
    var baked = a.params || {};
    Object.keys(baked).forEach(function (k) { params[k] = baked[k]; });
    (a.inputs || []).forEach(function (inp) {
      var c = D.q("mi_" + inp.key);
      if (!c) return;
      if (inp.type === "toggle") params[inp.key] = c.checked;
      else if (inp.type === "number") params[inp.key] = c.value === "" ? null : Number(c.value);
      else params[inp.key] = c.value;
    });
    var body = { key: a.key, params: params };
    if (a.dangerous) body.confirmWord = D.q("confirmWord").value;
    if (a.reverseConfirm) body.reverseCode = D.q("reverseCode").value;
    if (a.dangerous && body.confirmWord !== "CONFIRM") { D.modalErr("Type CONFIRM to proceed."); return; }
    D.dispatchAction(body, function (kind) {
      if (kind === "reverse") { D.q("modalReverse").hidden = false; D.modalErr("Enter the reverse code from Discord."); }
      else D.modalErr(kind);
    });
  });
};
`;
