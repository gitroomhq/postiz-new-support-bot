// Stripe-look design system for the billing dashboard (/billing) ONLY — the
// admin/intercom panels keep panelTheme.ts. Values sampled from a real Stripe
// sandbox capture (2026-07-18): accent #533AFD, body text #545969, headings
// #30313D, gray panel fill #F4F7FA, hairlines #ECF1F6, white page background,
// borderless gray cards, flat tables, purple-text active nav. Dark scheme is
// our adaptation of the same language.
//
// Theme selection: LIGHT is the source of truth (it's the actual Stripe
// capture). The dark tokens apply when the system prefers dark AND the user
// hasn't forced light, or when the user forces dark — the client stamps
// data-theme="light"|"dark" on <html> from localStorage (absent = follow the
// system).
//
// CSP-safe: colours/gradients/keyframes only — no url()/data:, no @import,
// no external fonts (Stripe itself falls back to this system stack).

const DARK_TOKENS = `
      color-scheme: dark;
      --bg:#16171d; --surface:#1c1d24; --fill:#21232c; --hover:#23252f;
      --border:#282a33; --border-strong:#383b46;
      --text:#a3a8b8; --heading:#eceef2; --muted:#8b91a0; --faint:#666c7a;
      --accent:#8577ff; --accent-hover:#9a8eff; --accent-fg:#101018; --accent-weak:#272348;
      --ok:#48c464; --ok-weak:#12291b;
      --warn:#f0a04c; --warn-weak:#2d2210;
      --danger:#ff7591; --danger-strong:#ff5c7c; --danger-weak:#331420;
      --info:#a29bff; --info-weak:#272348;
      --neutral:#a3a8b8; --neutral-weak:#2a2c36;
      --track:#383b46; --ring:rgba(133,119,255,.3);
      --shadow-sm:0 1px 1px rgba(0,0,0,.3);
      --shadow-card:0 1px 2px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.25);
      --shadow-pop:0 15px 35px rgba(0,0,0,.5),0 5px 15px rgba(0,0,0,.4);
`;

export function stripeBaseCss(): string {
  return `
  :root {
    color-scheme: light;
    --bg:#ffffff; --surface:#ffffff; --fill:#f4f7fa; --hover:#f4f7fa;
    --border:#ecf1f6; --border-strong:#d8dee4;
    --text:#545969; --heading:#30313d; --muted:#687385; --faint:#99a5b2;
    --accent:#533afd; --accent-hover:#4430d4; --accent-fg:#ffffff; --accent-weak:#efecff;
    --ok:#006908; --ok-weak:#d7f7c2;
    --warn:#a82c00; --warn-weak:#fcedb9;
    --danger:#b3093c; --danger-strong:#df1b41; --danger-weak:#ffe9ee;
    --info:#4430d4; --info-weak:#efecff;
    --neutral:#545969; --neutral-weak:#ebeef1;
    --track:#d8dee4; --ring:rgba(83,58,253,.24);
    --shadow-sm:0 1px 1px rgba(33,37,44,.06);
    --shadow-card:0 1px 2px rgba(33,37,44,.05),0 2px 6px rgba(33,37,44,.04);
    --shadow-pop:0 15px 35px rgba(49,49,93,.18),0 5px 15px rgba(0,0,0,.12);
    --radius:12px; --radius-sm:6px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme=light]) {
${DARK_TOKENS}
    }
  }
  :root[data-theme=dark] {
${DARK_TOKENS}
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Ubuntu,sans-serif;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
  a { color:var(--accent); }
  [hidden] { display:none !important; }
  ::selection { background:var(--accent-weak); }
  h1,h2,h3 { color:var(--heading); }

  input[type=text],input[type=number],input[type=password],select,textarea {
    width:100%; padding:8px 12px; font:inherit; font-size:14px; color:var(--heading);
    background:var(--surface); border:1px solid var(--border-strong); border-radius:var(--radius-sm);
    outline:none; box-shadow:var(--shadow-sm); transition:border-color .12s,box-shadow .12s; }
  input::placeholder,textarea::placeholder { color:var(--faint); }
  input:focus,select:focus,textarea:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--ring); }
  textarea { min-height:84px; resize:vertical; }
  select { cursor:pointer; }

  .switch { display:inline-flex; align-items:center; gap:10px; cursor:pointer; user-select:none; font-size:14px; }
  .switch input[type=checkbox] { appearance:none; -webkit-appearance:none; margin:0; position:relative;
    width:36px; height:20px; border:none; border-radius:999px; background:var(--track); cursor:pointer;
    transition:background .15s; flex:0 0 auto; box-shadow:none; }
  .switch input[type=checkbox]::after { content:""; position:absolute; top:2px; left:2px; width:16px; height:16px;
    border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3); transition:transform .15s; }
  .switch input[type=checkbox]:checked { background:var(--accent); }
  .switch input[type=checkbox]:checked::after { transform:translateX(16px); }

  .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; margin:0; padding:6px 14px;
    font:inherit; font-size:14px; font-weight:600; border:1px solid var(--border-strong);
    border-radius:var(--radius-sm); background:var(--surface); color:var(--heading); cursor:pointer;
    white-space:nowrap; box-shadow:var(--shadow-sm); transition:background .12s,border-color .12s,color .12s; }
  .btn:hover { background:var(--hover); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
  .btn.primary:hover { background:var(--accent-hover); border-color:var(--accent-hover); }
  .btn.danger { color:var(--danger-strong); }
  .btn.danger:hover { background:var(--danger-weak); border-color:var(--danger-strong); }
  .btn.sm { padding:3px 10px; font-size:13px; }
  .btn.secfoot { margin:14px 8px 0 0; }
  .btn:disabled { opacity:.45; cursor:default; box-shadow:none; }
  .btn:disabled:hover { background:var(--surface); }
  .btn.primary:disabled:hover { background:var(--accent); }

  .badge { display:inline-block; padding:1px 7px; border-radius:999px; font-size:12px; font-weight:500; line-height:1.5; }
  .badge.info { color:var(--info); background:var(--info-weak); }
  .badge.ok { color:var(--ok); background:var(--ok-weak); }
  .badge.warn { color:var(--warn); background:var(--warn-weak); }
  .badge.error { color:var(--danger); background:var(--danger-weak); }
  .badge.neutral { color:var(--neutral); background:var(--neutral-weak); }

  /* Stripe layout: content sits FLAT on the page — a "section" is a heading +
     content separated by whitespace, not a boxed card. Panels that DO need a
     surface (notices, empty states, QR) use the borderless gray fill. */
  .section { background:transparent; border:none; border-radius:0; padding:0; margin:0 0 32px; box-shadow:none; }
  .section h2 { font-size:16px; font-weight:600; margin:0 0 12px; letter-spacing:-.01em; }
  .section .desc { color:var(--muted); margin:-8px 0 12px; font-size:14px; }

  table { border-collapse:separate; border-spacing:0; width:100%; font-size:14px; }
  thead th { text-align:left; padding:6px 10px; font-size:12px; color:var(--muted); font-weight:500;
    border-bottom:1px solid var(--border-strong); white-space:nowrap; }
  td { padding:9px 10px; border-bottom:1px solid var(--border); vertical-align:middle; color:var(--heading); }
  td .sub, td .muted { color:var(--muted); }
  tbody tr:hover { background:var(--hover); }
  td.act { text-align:right; white-space:nowrap; }
  td.act .btn { margin-left:5px; }

  .flash:empty { display:none; }
  .flash.ok,.flash.error { padding:10px 14px; border-radius:var(--radius-sm); font-size:14px; margin:0 0 16px; }
  .flash.ok { background:var(--ok-weak); color:var(--ok); }
  .flash.error { background:var(--danger-weak); color:var(--danger); white-space:pre-wrap; }
  .note { color:var(--muted); }
  .muted { color:var(--muted); }
  .ok { color:var(--ok); }
  .error { color:var(--danger); white-space:pre-wrap; }

  dialog { border:none; border-radius:var(--radius); padding:24px; max-width:520px; width:92%;
    color:var(--text); background:var(--surface); box-shadow:var(--shadow-pop); }
  dialog::backdrop { background:rgba(24,26,32,.45); }
  dialog h2 { margin:0 0 4px; font-size:16px; font-weight:600; }
  dialog .summary { color:var(--muted); margin-bottom:14px; font-size:14px; white-space:pre-wrap; }
  dialog label { display:block; margin:12px 0 5px; font-weight:500; font-size:13px; color:var(--heading); }
  dialog .drow { margin-top:18px; display:flex; gap:8px; justify-content:flex-end; }

  .overlay { position:fixed; inset:0; background:var(--bg); display:flex; align-items:center; justify-content:center;
    padding:20px; z-index:50; }
  .overlay .card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:40px 44px;
    max-width:460px; text-align:center; box-shadow:var(--shadow-pop); }
  .overlay h2 { margin:0 0 8px; font-size:20px; font-weight:700; letter-spacing:-.01em; }
  .overlay .code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:30px; letter-spacing:.18em;
    font-weight:600; margin:22px 0; padding:16px; border:1px dashed var(--border-strong); border-radius:10px;
    color:var(--accent); background:var(--accent-weak); }
  .spinner { width:28px; height:28px; margin:0 auto 14px; border-radius:50%; border:3px solid var(--border);
    border-top-color:var(--accent); animation:spin .8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  `;
}
