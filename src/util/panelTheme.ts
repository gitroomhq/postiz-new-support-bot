// Shared modern-dashboard CSS for the self-contained panels (admin web panel +
// Stripe panel). Returned as a raw CSS string (no <style> tags) so each page can
// drop it inside its own nonced <style> block. Design tokens are CSS variables
// with a light + dark scheme; every colour resolves through them so a control
// can never end up (e.g.) light text on a white field.
//
// CSP-safe: colours/gradients/keyframes only — no url()/data: (default-src 'none'
// forbids external + data images), no @import, no external fonts.

export function panelThemeCss(): string {
  return `
  :root {
    color-scheme: light dark;
    --bg:#f6f7f9; --surface:#ffffff; --elev:#ffffff; --border:#e5e8ee; --border-strong:#d3d8e0;
    --text:#101625; --muted:#5b6472; --faint:#98a1b0;
    --accent:#4f6bff; --accent-fg:#ffffff; --accent-weak:#eef1ff;
    --ok:#0c8a4e; --ok-weak:#e7f6ee; --warn:#b25e09; --warn-weak:#fbf1e3; --danger:#d92d20; --danger-weak:#fdeceb;
    --track:#c9cfda; --ring:rgba(79,107,255,.20); --shadow:0 1px 2px rgba(16,24,40,.05),0 2px 6px rgba(16,24,40,.06);
    --radius:12px; --radius-sm:9px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0a0d13; --surface:#111621; --elev:#161c28; --border:#222a37; --border-strong:#2c3543;
      --text:#e7edf4; --muted:#96a0b1; --faint:#6a7686;
      --accent:#6d8bff; --accent-fg:#0a0d13; --accent-weak:#161f36;
      --ok:#3fb950; --ok-weak:#10241a; --warn:#d29922; --warn-weak:#28230f; --danger:#f76a63; --danger-weak:#2b1517;
      --track:#3a4351; --ring:rgba(109,139,255,.28); --shadow:0 1px 2px rgba(0,0,0,.4),0 3px 10px rgba(0,0,0,.3);
    }
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
  a { color:var(--accent); }
  [hidden] { display:none !important; }
  ::selection { background:var(--accent-weak); }

  input[type=text],input[type=number],input[type=password],select,textarea {
    width:100%; padding:10px 12px; font:inherit; font-size:13.5px; color:var(--text);
    background:var(--elev); border:1px solid var(--border-strong); border-radius:var(--radius-sm);
    outline:none; transition:border-color .12s,box-shadow .12s; }
  input::placeholder,textarea::placeholder { color:var(--faint); }
  input:focus,select:focus,textarea:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--ring); }
  textarea { min-height:84px; resize:vertical; }
  select { cursor:pointer; }

  .switch { display:inline-flex; align-items:center; gap:10px; cursor:pointer; user-select:none; font-size:13.5px; }
  .switch input[type=checkbox] { appearance:none; -webkit-appearance:none; margin:0; position:relative;
    width:38px; height:22px; border:none; border-radius:999px; background:var(--track); cursor:pointer;
    transition:background .15s; flex:0 0 auto; }
  .switch input[type=checkbox]::after { content:""; position:absolute; top:2px; left:2px; width:18px; height:18px;
    border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.35); transition:transform .15s; }
  .switch input[type=checkbox]:checked { background:var(--accent); }
  .switch input[type=checkbox]:checked::after { transform:translateX(16px); }

  .btn { display:inline-flex; align-items:center; gap:6px; margin:0; padding:8px 14px; font:inherit;
    font-size:13px; font-weight:550; border:1px solid var(--border-strong); border-radius:var(--radius-sm);
    background:var(--elev); color:var(--text); cursor:pointer; white-space:nowrap;
    transition:background .12s,border-color .12s,filter .12s; }
  .btn:hover { border-color:var(--faint); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
  .btn.primary:hover { filter:brightness(1.08); }
  .btn.danger { color:var(--danger); border-color:var(--danger); background:transparent; }
  .btn.danger:hover { background:var(--danger-weak); }
  .btn.sm { padding:5px 9px; font-size:12px; }
  .btn.secfoot { margin:16px 8px 0 0; }
  .btn:disabled { opacity:.5; cursor:default; }

  .badge { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11.5px; font-weight:600; }
  .badge.info { color:var(--accent); background:var(--accent-weak); }
  .badge.ok { color:var(--ok); background:var(--ok-weak); }
  .badge.warn { color:var(--warn); background:var(--warn-weak); }
  .badge.error { color:var(--danger); background:var(--danger-weak); }

  .section { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
    padding:20px 22px; margin:0 0 18px; box-shadow:var(--shadow); }
  .section h2 { font-size:15px; font-weight:650; margin:0 0 3px; letter-spacing:-.01em; }
  .section .desc { color:var(--muted); margin:0 0 6px; font-size:13px; }

  .field { padding:14px 0; border-top:1px solid var(--border); }
  .field:first-of-type { border-top:none; padding-top:2px; }
  .field label.flabel { display:block; font-weight:600; margin-bottom:7px; font-size:13px; }
  .field .help { color:var(--muted); font-size:12.5px; margin-top:6px; }
  .field .ferr { color:var(--danger); font-size:12.5px; margin-top:6px; }
  .ms { display:flex; flex-wrap:wrap; gap:8px; }
  .ms .switch { border:1px solid var(--border); border-radius:999px; padding:5px 12px 5px 10px; background:var(--elev); font-size:12.5px; }

  table { border-collapse:separate; border-spacing:0; width:100%; font-size:13px; }
  thead th { text-align:left; padding:9px 12px; font-size:11px; text-transform:uppercase; letter-spacing:.05em;
    color:var(--muted); font-weight:600; border-bottom:1px solid var(--border); }
  td { padding:11px 12px; border-bottom:1px solid var(--border); vertical-align:middle; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr:hover { background:var(--accent-weak); }
  td.act { text-align:right; white-space:nowrap; }
  td.act .btn { margin-left:5px; }
  td.grip { width:26px; padding-right:0; }
  .grip-h { cursor:grab; color:var(--faint); font-size:15px; line-height:1; }
  tr[draggable=true] .grip-h:active { cursor:grabbing; }
  tr.dragging { opacity:.45; }
  tr.drop-above td { box-shadow:inset 0 2px 0 var(--accent); }
  tr.drop-below td { box-shadow:inset 0 -2px 0 var(--accent); }

  .flash:empty { display:none; }
  .flash.ok,.flash.error { padding:10px 14px; border-radius:var(--radius-sm); font-size:13px; margin:0 0 16px; }
  .flash.ok { background:var(--ok-weak); color:var(--ok); }
  .flash.error { background:var(--danger-weak); color:var(--danger); white-space:pre-wrap; }
  .note { color:var(--muted); }
  .muted { color:var(--muted); }
  .ok { color:var(--ok); }
  .error { color:var(--danger); white-space:pre-wrap; }

  dialog { border:1px solid var(--border); border-radius:var(--radius); padding:22px; max-width:520px; width:92%;
    color:var(--text); background:var(--surface); box-shadow:0 24px 60px rgba(0,0,0,.4); }
  dialog::backdrop { background:rgba(3,6,12,.55); }
  dialog h2 { margin:0 0 4px; font-size:16px; }
  dialog .summary { color:var(--muted); margin-bottom:14px; font-size:13px; white-space:pre-wrap; }
  dialog label { display:block; margin:12px 0 5px; font-weight:600; font-size:12.5px; }
  dialog .drow { margin-top:18px; display:flex; gap:8px; justify-content:flex-end; }

  .overlay { position:fixed; inset:0; background:var(--bg); display:flex; align-items:center; justify-content:center; padding:20px; z-index:50; }
  .overlay .card { background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:40px 44px;
    max-width:460px; text-align:center; box-shadow:var(--shadow); }
  .overlay h2 { margin:0 0 8px; font-size:20px; letter-spacing:-.01em; }
  .overlay .code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:32px; letter-spacing:.2em;
    font-weight:700; margin:22px 0; padding:18px; border:1px dashed var(--border-strong); border-radius:14px;
    color:var(--accent); background:var(--accent-weak); }
  .spinner { width:32px; height:32px; margin:0 auto 14px; border-radius:50%; border:3px solid var(--border);
    border-top-color:var(--accent); animation:spin .8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  `;
}
