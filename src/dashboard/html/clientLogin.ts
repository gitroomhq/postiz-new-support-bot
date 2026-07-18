// Client module: standing login (passkey → passphrase → Discord DM code),
// TOTP fallback, passkey registration and the T2 step-up flow. WebAuthn JSON
// conversion prefers the native PublicKeyCredential JSON APIs with manual
// base64url fallbacks for slightly older browsers.

export const clientLogin = `
D.b64uToBuf = function (s) {
  var pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  var b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  var arr = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
  return arr.buffer;
};
D.bufToB64u = function (buf) {
  var bytes = new Uint8Array(buf);
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
};

D.parseGetOptions = function (json) {
  if (window.PublicKeyCredential && PublicKeyCredential.parseRequestOptionsFromJSON) {
    return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  }
  var out = {};
  Object.keys(json).forEach(function (k) { out[k] = json[k]; });
  out.challenge = D.b64uToBuf(json.challenge);
  out.allowCredentials = (json.allowCredentials || []).map(function (c) {
    return { type: c.type, id: D.b64uToBuf(c.id), transports: c.transports };
  });
  return out;
};

D.parseCreateOptions = function (json) {
  if (window.PublicKeyCredential && PublicKeyCredential.parseCreationOptionsFromJSON) {
    return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  }
  var out = {};
  Object.keys(json).forEach(function (k) { out[k] = json[k]; });
  out.challenge = D.b64uToBuf(json.challenge);
  out.user = { id: D.b64uToBuf(json.user.id), name: json.user.name, displayName: json.user.displayName || json.user.name };
  out.excludeCredentials = (json.excludeCredentials || []).map(function (c) {
    return { type: c.type, id: D.b64uToBuf(c.id), transports: c.transports };
  });
  return out;
};

D.credToJSON = function (cred) {
  if (cred.toJSON) return cred.toJSON();
  var r = cred.response;
  var out = {
    id: cred.id,
    rawId: D.bufToB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: { clientDataJSON: D.bufToB64u(r.clientDataJSON) }
  };
  if (r.attestationObject) {
    out.response.attestationObject = D.bufToB64u(r.attestationObject);
    if (r.getTransports) out.response.transports = r.getTransports();
  }
  if (r.authenticatorData) {
    out.response.authenticatorData = D.bufToB64u(r.authenticatorData);
    out.response.signature = D.bufToB64u(r.signature);
    out.response.userHandle = r.userHandle ? D.bufToB64u(r.userHandle) : null;
  }
  return out;
};

// ---- login overlay ----
D.loginState = { loginId: null };

D.loginErr = function (msg) {
  var e = D.q("loginErr");
  if (msg) { e.textContent = msg; e.hidden = false; } else { e.textContent = ""; e.hidden = true; }
};

D.showLogin = function (info) {
  D.q("lock").hidden = true; D.q("app").hidden = true; D.q("expired").hidden = true;
  D.q("login").hidden = false;
  D.q("loginStep2").hidden = true;
  D.q("loginStep3").hidden = true;
  D.q("loginStep1").hidden = false;
  D.q("loginPasskey").disabled = !(info && info.passkey && window.PublicKeyCredential);
};

D.passkeyLogin = function () {
  D.loginErr(null);
  D.api("auth-passkey-options", {}).then(function (res) {
    if (!res.j || !res.j.options) { D.loginErr((res.j && res.j.error) || "Could not start sign-in."); return; }
    return navigator.credentials.get({ publicKey: D.parseGetOptions(res.j.options) }).then(function (cred) {
      return D.api("auth-passkey", { response: D.credToJSON(cred) });
    }).then(function (res2) {
      if (!res2.j || !res2.j.ok) { D.loginErr((res2.j && res2.j.error) || "Sign-in failed."); return; }
      D.loginState.loginId = res2.j.loginId;
      D.q("loginStep1").hidden = true;
      D.q("loginStep3").hidden = true;
      D.q("loginStep2").hidden = false;
      D.q("loginPassphrase").value = "";
      D.q("loginPassphrase").focus();
    });
  }).catch(function () { D.loginErr("Passkey ceremony was cancelled or failed."); });
};

D.passphraseSubmit = function () {
  D.loginErr(null);
  var pass = D.q("loginPassphrase").value;
  if (!pass) return;
  D.api("auth-passphrase", { loginId: D.loginState.loginId, passphrase: pass }).then(function (res) {
    if (!res.j || !res.j.ok) { D.loginErr((res.j && res.j.error) || "Sign-in failed."); return; }
    // Locked session cookie is set — hand over to the activation poll (DM).
    D.q("login").hidden = true;
    D.poll();
  });
};

D.totpLoginSubmit = function () {
  D.loginErr(null);
  D.api("auth-totp-login", {
    userId: D.q("totpUserId").value.trim(),
    passphrase: D.q("totpPassphrase").value,
    code: D.q("totpCode").value.trim()
  }).then(function (res) {
    if (!res.j || !res.j.ok) { D.loginErr((res.j && res.j.error) || "Sign-in failed."); return; }
    D.q("login").hidden = true;
    D.poll();
  });
};

D.bindLogin = function () {
  D.q("loginPasskey").addEventListener("click", D.passkeyLogin);
  D.q("loginPassGo").addEventListener("click", D.passphraseSubmit);
  D.q("loginPassphrase").addEventListener("keydown", function (e) { if (e.key === "Enter") D.passphraseSubmit(); });
  D.q("loginTotpGo").addEventListener("click", D.totpLoginSubmit);
  D.q("loginTotpLink").addEventListener("click", function (e) {
    e.preventDefault();
    D.loginErr(null);
    D.q("loginStep1").hidden = true; D.q("loginStep2").hidden = true; D.q("loginStep3").hidden = false;
  });
  D.q("loginBackLink").addEventListener("click", function (e) {
    e.preventDefault();
    D.loginErr(null);
    D.q("loginStep3").hidden = true; D.q("loginStep1").hidden = false;
  });
};

// ---- passkey registration (Security page, special button) ----
D.passkeyRegister = function (label, onDone) {
  D.api("auth-register-options", {}).then(function (res) {
    if (!res.j || !res.j.options) { D.flashErr((res.j && res.j.error) || "Could not start registration."); return; }
    return navigator.credentials.create({ publicKey: D.parseCreateOptions(res.j.options) }).then(function (cred) {
      return D.api("auth-register", { response: D.credToJSON(cred), label: label || "" });
    }).then(function (res2) {
      if (res2.j && res2.j.ok) { D.flashOk(res2.j.text || "Passkey enrolled."); if (onDone) onDone(); D.loadPage(); }
      else D.flashErr((res2.j && res2.j.error) || "Registration failed.");
    });
  }).catch(function () { D.flashErr("Passkey ceremony was cancelled or failed."); });
};

// ---- T2 step-up (fresh factor re-assert) ----
// Tries a one-touch passkey assert; falls back to the TOTP dialog. onDone runs
// after the server confirmed the step-up.
D.stepUpFlow = function (onDone) {
  var fallback = function () {
    var dlg = D.q("stepup");
    D.q("stepupErr").hidden = true;
    D.q("stepupCode").value = "";
    dlg.showModal();
    D.q("stepupGo").onclick = function () {
      D.api("auth-stepup", { totp: D.q("stepupCode").value.trim() }).then(function (res) {
        if (res.j && res.j.ok) { dlg.close(); onDone(); }
        else { var e = D.q("stepupErr"); e.textContent = (res.j && res.j.error) || "That code didn't match."; e.hidden = false; }
      });
    };
    D.q("stepupCancel").onclick = function () { dlg.close(); };
  };
  if (!window.PublicKeyCredential) { fallback(); return; }
  D.api("auth-stepup-options", {}).then(function (res) {
    if (!res.j || !res.j.options) { fallback(); return; }
    navigator.credentials.get({ publicKey: D.parseGetOptions(res.j.options) }).then(function (cred) {
      return D.api("auth-stepup", { response: D.credToJSON(cred) });
    }).then(function (res2) {
      if (res2.j && res2.j.ok) onDone();
      else fallback();
    }).catch(function () { fallback(); });
  });
};
`;
