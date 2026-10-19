import { stripeBaseCss } from "../../dashboard/html/stripeTheme";
import { dashboardCss } from "../../dashboard/html/styles";
import { clientCore } from "../../dashboard/html/clientCore";
import { clientBlocks } from "../../dashboard/html/clientBlocks";
import { clientModal } from "../../dashboard/html/clientModal";
import { queueClient } from "./queueClient";

// Self-contained HTML shell for the Intercom Queue (/queue). Same substrate as
// the dashboard: inline CSS + vanilla JS under a per-response CSP nonce, zero
// external requests, and the dashboard's own theme and block renderer, so the
// two pages share one look. The queue has its own sign-in (Intercom OAuth),
// its own cookie and its own sidebar.

export function renderQueueShell(ctx: { nonce: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Intercom Queue</title>
<style nonce="${ctx.nonce}">
${stripeBaseCss()}
${dashboardCss()}
${queueCss()}
</style>
</head>
<body>
<div id="lock" hidden></div>
<div id="expired" class="overlay" hidden>
  <div class="card">
    <h2>Signed out</h2>
    <p class="muted">Your queue session ended or was revoked.</p>
    <button class="btn primary" id="expiredReload" type="button">Sign in again</button>
  </div>
</div>
<div id="login" class="overlay" hidden>
  <div class="card logincard">
    <h2>Intercom Queue</h2>
    <p class="muted">Tickets waiting on a reply from the team. Sign in with your Intercom account.</p>
    <div id="loginErr" class="error" hidden></div>
    <a class="btn primary wide" id="loginGo" href="/queue/oauth/start" hidden>Sign in with Intercom</a>
    <p class="muted small" id="loginNotReady" hidden>Sign-in is not set up yet. An admin finishes it in Discord: /intercom → Queue.</p>
  </div>
</div>
<div id="app" hidden>
  <aside class="side">
    <div class="brand"><span class="dot">Q</span> Intercom Queue</div>
    <nav id="nav"></nav>
  </aside>
  <div class="mainwrap">
    <header class="topbar">
      <button class="btn sm" id="menubtn" type="button" aria-label="Menu" aria-expanded="false">☰</button>
      <span class="who" id="who"></span>
      <span class="badge warn livestate" id="livestate" title="The page lost its connection to the server and is trying again. Refresh reloads it now." hidden>Not live: reconnecting</span>
      <button class="btn sm" id="refreshbtn" type="button" title="Read the queue again">Refresh</button>
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
${queueClient}
})();
</script>
</body>
</html>`;
}

// The few rules the queue adds on top of the dashboard stylesheet.
function queueCss(): string {
  return `
  a.btn { text-decoration:none; }
  a.btn.wide { display:flex; }
  .agecell { font-variant-numeric: tabular-nums; }
  .topbar .who { margin-right:auto; }
  .livestate[hidden] { display:none !important; }
  .logincard .error { margin:8px 0 12px; }
  .section.kv + .section { margin-top:28px; }
  `;
}
