// Client module: the dispute evidence workbench widget. Five collapsible
// groups of text fields with per-field lifecycle chips (empty/draft/staged/
// submitted), autosave-to-draft on blur (quiet — no page reload mid-typing),
// char counts, per-group staging (typed-CONFIRM via the standard modal) and
// the six proof-file slots. Files are pre-validated client-side and travel as
// base64 JSON through the normal api route — no multipart anywhere.

export const clientEvidence = `
D.EV_CHIPS = {
  empty: { kind: "neutral", text: "Empty" },
  draft: { kind: "warn", text: "Draft (not staged)" },
  staged: { kind: "info", text: "Staged" },
  submitted: { kind: "ok", text: "Submitted" }
};

D.evChip = function (state) {
  var c = D.EV_CHIPS[state] || D.EV_CHIPS.empty;
  var el = D.badge(c);
  el.classList.add("evchip");
  return el;
};

// Quiet draft autosave: raw api call (dispatchAction would reload the page and
// destroy typing focus). Chip flips to "draft" when the new value differs from
// what's staged; errors surface in the flash bar.
D.evSaveDraft = function (b, field, value, chipBox) {
  D.api("action", {
    key: "section:disputes.draft_save",
    page: D.state.page,
    params: { disputeId: b.disputeId, key: field.key, value: value }
  }).then(function (res) {
    var j = D.handle(res); if (!j) return;
    if (!j.ok) { D.flashErr(j.error || "Draft save failed."); return; }
    field.draft = value;
    var staged = (field.staged || "").trim();
    field.state = value === staged ? "staged" : "draft";
    chipBox.textContent = "";
    chipBox.appendChild(D.evChip(field.state));
  });
};

D.renderEvidenceField = function (b, field) {
  var box = D.el("div", "evfield");
  var head = D.el("div", "evhead");
  head.appendChild(D.el("label", "evlabel", field.label));
  var chipBox = D.el("span", "evchipbox");
  chipBox.appendChild(D.evChip(field.state));
  head.appendChild(chipBox);
  var count = D.el("span", "evcount");
  head.appendChild(count);
  box.appendChild(head);

  var initial = field.draft != null ? field.draft : (field.staged || "");
  var ctrl = document.createElement(field.multiline ? "textarea" : "input");
  if (!field.multiline) ctrl.type = "text";
  else ctrl.rows = 4;
  ctrl.className = "evinput";
  ctrl.autocomplete = "off";
  ctrl.value = initial;
  ctrl.disabled = !b.editable;
  var updateCount = function () {
    count.textContent = ctrl.value.length ? ctrl.value.length + " chars" : "";
  };
  updateCount();
  var lastSaved = initial;
  ctrl.addEventListener("input", updateCount);
  ctrl.addEventListener("blur", function () {
    var v = ctrl.value.trim();
    // Empty inputs are never sent — a blank must not wipe drafted/staged text
    // (mirrors the Discord editor's Emptyable-field rule).
    if (v === lastSaved.trim() || !v) return;
    lastSaved = v;
    D.evSaveDraft(b, field, v, chipBox);
  });
  box.appendChild(ctrl);
  return box;
};

D.renderEvidenceGroup = function (b, g) {
  var det = document.createElement("details");
  det.className = "evgroup";
  if (g.recommended) det.open = true;
  var sum = document.createElement("summary");
  var title = D.el("span", "evgtitle", g.label);
  if (g.recommended) title.appendChild(D.el("span", "evstar", "\\u2b50"));
  sum.appendChild(title);
  var stagedCount = 0, draftCount = 0;
  (g.fields || []).forEach(function (f) {
    if (f.state === "staged" || f.state === "submitted") stagedCount++;
    if (f.state === "draft") draftCount++;
  });
  var meta = stagedCount + "/" + g.fields.length + " staged";
  if (draftCount) meta += " \\u00b7 " + draftCount + " draft";
  sum.appendChild(D.el("span", "evgmeta", meta));
  det.appendChild(sum);
  var bodyEl = D.el("div", "evgbody");
  (g.fields || []).forEach(function (f) { bodyEl.appendChild(D.renderEvidenceField(b, f)); });
  var foot = D.el("div", "evgfoot");
  foot.appendChild(D.actionBtn({
    key: "section:disputes.stage_group",
    label: "Stage group at Stripe",
    style: "primary",
    dangerous: true,
    params: { disputeId: b.disputeId, group: g.key },
    summary: "Stages this group's saved draft fields at Stripe with submit:false. The bank sees nothing until Submit evidence.",
    disabledReason: b.editable ? undefined : "Evidence can no longer be changed on this dispute."
  }));
  bodyEl.appendChild(foot);
  det.appendChild(bodyEl);
  return det;
};

D.renderEvidenceSlot = function (b, slot) {
  var row = D.el("div", "evslot");
  row.appendChild(D.el("span", "evslotlabel", slot.label));
  if (slot.fileId) {
    var idBox = D.el("span", "evslotfile");
    idBox.appendChild(D.el("span", "mono", slot.fileId));
    idBox.appendChild(D.copyBtn(slot.fileId));
    row.appendChild(idBox);
    row.appendChild(D.actionBtn({
      key: "section:disputes.file_remove",
      label: "Remove",
      dangerous: true,
      params: { disputeId: b.disputeId, slot: slot.key },
      summary: "Detaches this staged file from the dispute (the upload stays in your Stripe account). It will NOT reach the bank.",
      disabledReason: b.editable ? undefined : "Evidence can no longer be changed on this dispute."
    }));
    return row;
  }
  if (!b.editable) {
    row.appendChild(D.el("span", "note", "empty"));
    return row;
  }
  var inp = document.createElement("input");
  inp.type = "file";
  inp.className = "evfile";
  inp.accept = (b.fileTypes || []).join(",");
  inp.addEventListener("change", function () {
    var file = inp.files && inp.files[0];
    if (!file) return;
    var type = (file.type || "").toLowerCase();
    if ((b.fileTypes || []).indexOf(type) === -1) {
      D.flashErr("The bank only accepts PNG, JPEG or PDF evidence files.");
      inp.value = "";
      return;
    }
    if (file.size > b.maxFileBytes) {
      D.flashErr("File too large: keep each proof under " + Math.floor(b.maxFileBytes / (1024 * 1024)) + "MB.");
      inp.value = "";
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var url = String(reader.result || "");
      var comma = url.indexOf(",");
      if (comma < 0) { D.flashErr("Could not read the file."); inp.value = ""; return; }
      var dataB64 = url.slice(comma + 1);
      D.openModal({
        key: "section:disputes.file_upload",
        label: "Upload " + file.name,
        dangerous: true,
        params: { disputeId: b.disputeId, slot: slot.key, filename: file.name, contentType: type, dataB64: dataB64 },
        summary: "Stage \\"" + file.name + "\\" (" + Math.max(1, Math.round(file.size / 1024)) + "KB) as " + slot.key +
          "; it reaches the bank only when you Submit evidence."
      });
      inp.value = "";
    };
    reader.onerror = function () { D.flashErr("Could not read the file."); inp.value = ""; };
    reader.readAsDataURL(file);
  });
  row.appendChild(inp);
  return row;
};

D.renderEvidence = function (b) {
  var box = D.el("div", "section evwrap");
  var h2 = D.el("h2", null, "Evidence");
  box.appendChild(h2);
  if (!b.editable) {
    box.appendChild(D.el("p", "note", b.submitted
      ? "Evidence was submitted; the response is with the bank and can no longer be changed."
      : "This dispute is not respondable; evidence can no longer be changed."));
  } else {
    box.appendChild(D.el("p", "note",
      "Fields autosave to a local draft when you leave them. \\u2b50 groups matter most for this dispute's reason. " +
      "Stage a group to put it on file at Stripe (submit:false); nothing reaches the bank until Submit evidence."));
  }
  (b.groups || []).forEach(function (g) { box.appendChild(D.renderEvidenceGroup(b, g)); });
  var fh = D.el("h3", "evfilehead", "Proof files");
  box.appendChild(fh);
  box.appendChild(D.el("p", "note", "PNG, JPEG or PDF, max " + Math.floor(b.maxFileBytes / (1024 * 1024)) +
    "MB each, staged into a bank-visible slot on upload (still submit:false)."));
  (b.files || []).forEach(function (s) { box.appendChild(D.renderEvidenceSlot(b, s)); });
  return box;
};
`;
