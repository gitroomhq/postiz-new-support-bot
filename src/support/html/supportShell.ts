import { stripeBaseCss } from "../../dashboard/html/stripeTheme";
import { dashboardCss } from "../../dashboard/html/styles";
import { clientCore } from "../../dashboard/html/clientCore";
import { clientBlocks } from "../../dashboard/html/clientBlocks";
import { clientModal } from "../../dashboard/html/clientModal";
import { supportClient } from "./supportClient";

// Self-contained HTML shell for the support dashboard (/support). Same
// substrate as the dashboard and the queue: inline CSS + vanilla JS under a
// per-response CSP nonce, zero external requests, the dashboard's theme and
// block renderer. Its own sign-in (Discord code, DM code, password), cookie
// and sidebar.

export function renderSupportShell(ctx: { nonce: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Support</title>
<style nonce="${ctx.nonce}">
${stripeBaseCss()}
${dashboardCss()}
${supportCss()}
</style>
</head>
<body>
<div id="lock" hidden></div>
<div id="expired" class="overlay" hidden>
  <div class="card">
    <h2>Signed out</h2>
    <p class="muted">Your support session ended or was revoked.</p>
    <button class="btn primary" id="expiredReload" type="button">Sign in again</button>
  </div>
</div>
<div id="login" class="overlay" hidden>
  <div class="card logincard">
    <h2 id="loginTitle">Support</h2>
    <p class="muted" id="loginHint"></p>
    <div id="loginErr" class="error" hidden></div>
    <div class="lfield" id="codeWrap" hidden><label for="codeIn" id="codeLabel">Code</label><input type="text" id="codeIn" class="codein" autocomplete="one-time-code" spellcheck="false" maxlength="20"></div>
    <div class="lfield" id="pwWrap" hidden><label for="pwIn">Password</label><input type="password" id="pwIn" autocomplete="current-password" maxlength="200"></div>
    <div class="lfield" id="pw2Wrap" hidden><label for="pw2In">Repeat password</label><input type="password" id="pw2In" autocomplete="new-password" maxlength="200"></div>
    <p class="muted small" id="pwRule" hidden>At least 12 characters.</p>
    <button class="btn primary wide" id="loginGo" type="button">Continue</button>
  </div>
</div>
<div id="app" hidden>
  <aside class="side">
    <div class="brand"><span class="dot">S</span> Support</div>
    <nav id="nav"></nav>
  </aside>
  <div class="mainwrap">
    <header class="topbar">
      <button class="btn sm" id="menubtn" type="button" aria-label="Menu" aria-expanded="false">☰</button>
      <span class="who" id="who"></span>
      <button class="btn sm" id="themebtn" type="button" title="Color theme: click to switch">Auto</button>
      <button class="btn sm" id="logout" type="button">Sign out</button>
    </header>
    <main>
      <div id="crumbs"></div>
      <div id="flash" class="flash"></div>
      <div id="content"><p class="note">Loading…</p></div>
    </main>
  </div>
  <div id="scrim"></div>
</div>
<dialog id="modal">
  <h2 id="modalTitle"></h2>
  <div class="summary" id="modalSummary"></div>
  <p class="muted" id="modalQueue" hidden></p>
  <div id="modalInputs"></div>
  <div id="modalReverse" hidden><input type="text" id="reverseCode" autocomplete="off"></div>
  <div id="modalConfirm" hidden>
    <label>Type CONFIRM to proceed</label>
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
${clientCore}
${clientBlocks}
${clientModal}
${supportClient}
})();
</script>
</body>
</html>`;
}

// The few rules the support dashboard adds on top of the dashboard stylesheet.
function supportCss(): string {
  return `
  a.btn { text-decoration:none; }
  .btn.wide { display:flex; width:100%; margin-top:6px; }
  .topbar .who { margin-right:auto; }
  .logincard { text-align:left !important; min-width:min(380px, 100%); }
  .logincard .error { margin:8px 0 12px; }
  .logincard .lfield { margin:0 0 12px; }
  .logincard label { display:block; font-size:13px; font-weight:500; color:var(--heading); margin:0 0 5px; }
  .logincard .codein { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:20px; letter-spacing:.16em; text-align:center; }
  .logincard .small { font-size:13px; margin:-4px 0 12px; }
  .section.kv + .section { margin-top:28px; }

  .strip { margin:0 0 28px; }
  .strip h2 { font-size:16px; font-weight:600; margin:0 0 12px; }
  .stripgrid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:24px; background:var(--fill);
    border-radius:10px; padding:16px 18px; }
  .stripgrid .slab { color:var(--muted); font-size:13px; margin:0 0 2px; }
  .stripgrid .sval { color:var(--heading); overflow-wrap:anywhere; }
  .stripgrid .sval.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }

  .changecard { background:var(--warn-weak); border-radius:10px; padding:14px 16px; margin:0 0 28px; }
  .changecard .chead { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .changecard .ctitle { color:var(--heading); font-weight:600; display:flex; align-items:center; gap:8px; }
  .changecard .csub { color:var(--muted); font-size:13px; margin:2px 0 10px; }
  .changecard .crow { display:grid; grid-template-columns:110px minmax(0,1fr) minmax(0,1fr); gap:8px; padding:6px 0;
    border-top:1px solid var(--border-strong); font-size:13.5px; color:var(--heading); }
  .changecard .crow.chdr { border-top:none; color:var(--muted); font-size:12px; font-weight:500; }
  .changecard .crow .clab { color:var(--muted); }
  .changecard .crow .cnext { font-weight:600; overflow-wrap:anywhere; }
  .changecard .crow span { overflow-wrap:anywhere; }

  .sform { display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; max-width:640px; margin:0 0 32px; }
  .sform .sfield { flex:1 1 240px; min-width:0; }
  .sform .sfield.narrow { flex:1 1 140px; max-width:200px; }
  .sform label { display:block; font-size:13px; font-weight:500; color:var(--heading); margin:0 0 5px; }
  .sform input.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .sform .btn { min-height:38px; }
  @media (max-width:560px) {
    .changecard .crow { grid-template-columns:1fr; gap:2px; }
    .changecard .crow.chdr { display:none; }
    .sform .sfield.narrow { max-width:none; }
  }
  `;
}
