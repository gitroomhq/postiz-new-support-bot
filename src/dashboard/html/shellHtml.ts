import { stripeBaseCss } from "./stripeTheme";
import { dashboardCss } from "./styles";
import { clientCore } from "./clientCore";
import { clientBlocks } from "./clientBlocks";
import { clientModal } from "./clientModal";
import { clientPalette } from "./clientPalette";
import { clientCharts } from "./clientCharts";
import { clientEvidence } from "./clientEvidence";
import { clientLogin } from "./clientLogin";
import { clientApp } from "./clientApp";

// Self-contained HTML shell for the Stripe dashboard (/billing). Ships as a
// template string (no build pipeline): inline CSS + vanilla JS, zero external
// requests (strict CSP allows only same-origin XHR to /billing/api/*).
//
// The page is dumb on purpose: the server (Dashboard + section modules)
// describes every block/cell/button; the client renders generically and posts
// interactions back. Dynamic text goes through textContent — never innerHTML
// with data. The client JS is assembled from the sibling client*.ts string
// modules (core → blocks → modal → app), all sharing the single `D` namespace
// inside one IIFE.

export interface DashboardShellCtx {
  nonce: string;
}

export function renderDashboardShell(ctx: DashboardShellCtx): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Billing</title>
<style nonce="${ctx.nonce}">
${stripeBaseCss()}
${dashboardCss()}
</style>
</head>
<body>
<div id="lock" class="overlay" hidden>
  <div class="card">
    <div class="spinner"></div>
    <h2>Confirm in Discord to unlock</h2>
    <p class="muted">Check your Discord DMs (or /billing → <strong>Activate session</strong>) and enter this code:</p>
    <div id="lockcode" class="code" title="Click to copy">••••-••••</div>
    <p class="codehint">Click the code to copy it</p>
    <p class="muted">Waiting for confirmation…</p>
  </div>
</div>
<div id="expired" class="overlay" hidden>
  <div class="card">
    <h2>Session ended</h2>
    <p class="muted">This dashboard session expired or was revoked.</p>
    <button class="btn primary" id="expiredReload" type="button">Sign in again</button>
  </div>
</div>
<div id="login" class="overlay" hidden>
  <div class="card logincard">
    <h2>Sign in</h2>
    <p class="muted">Passkey + passphrase, then confirm in Discord.</p>
    <div id="loginErr" class="error" hidden></div>
    <div id="loginStep1">
      <button class="btn primary wide" id="loginPasskey" type="button">Sign in with passkey</button>
      <p class="muted small"><a id="loginTotpLink" href="#">Use authenticator code instead</a></p>
    </div>
    <div id="loginStep2" hidden>
      <label>Passphrase</label>
      <input type="password" id="loginPassphrase" autocomplete="current-password">
      <button class="btn primary wide" id="loginPassGo" type="button">Continue</button>
    </div>
    <div id="loginStep3" hidden>
      <label>Discord user ID</label>
      <input type="text" id="totpUserId" autocomplete="username" inputmode="numeric">
      <label>Passphrase</label>
      <input type="password" id="totpPassphrase" autocomplete="current-password">
      <label>Authenticator code</label>
      <input type="text" id="totpCode" autocomplete="one-time-code" inputmode="numeric">
      <button class="btn primary wide" id="loginTotpGo" type="button">Sign in</button>
      <p class="muted small"><a id="loginBackLink" href="#">Back to passkey</a></p>
    </div>
  </div>
</div>
<div id="app" hidden>
  <aside class="side">
    <div class="brand"><span class="dot">$</span> Billing</div>
    <nav id="nav"></nav>
  </aside>
  <div class="mainwrap">
    <header class="topbar">
      <span class="jumpwrap"><input type="text" id="jump" placeholder="Search — name, email, amount, last4 or Stripe id (Ctrl+K)" autocomplete="off"><div id="palpop" class="palpop"></div></span>
      <span class="who" id="who"></span>
      <span class="morewrap createwrap"><button class="btn sm primary" id="createbtn" type="button">+ Create</button><div id="createmenu" class="morepop"></div></span>
      <button class="btn sm" id="themebtn" type="button" title="Color theme — click to switch">Auto</button>
      <button class="btn sm" id="logout" type="button">End session</button>
    </header>
    <main>
      <div id="crumbs"></div>
      <div id="flash" class="flash"></div>
      <div id="content"><p class="note">Loading…</p></div>
    </main>
  </div>
</div>
<dialog id="modal">
  <h2 id="modalTitle"></h2>
  <div class="summary" id="modalSummary"></div>
  <p class="muted" id="modalQueue" hidden>You are not an admin for this action — it will be queued for admin approval.</p>
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
<dialog id="stepup">
  <h2>Verify it's you</h2>
  <div class="summary">This action needs a fresh factor. No passkey on this device? Enter an authenticator code:</div>
  <label>Authenticator code</label>
  <input type="text" id="stepupCode" autocomplete="one-time-code" inputmode="numeric">
  <div id="stepupErr" class="error" hidden></div>
  <div class="drow">
    <button class="btn" id="stepupCancel" type="button">Cancel</button>
    <button class="btn primary" id="stepupGo" type="button">Verify</button>
  </div>
</dialog>
<script nonce="${ctx.nonce}">
"use strict";
(function () {
${clientCore}
${clientBlocks}
${clientModal}
${clientPalette}
${clientCharts}
${clientEvidence}
${clientLogin}
D.defaultPage = "home";
document.getElementById("expiredReload").addEventListener("click", function () { location.hash = ""; location.reload(); });
${clientApp}
})();
</script>
</body>
</html>`;
}
