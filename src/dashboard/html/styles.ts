// Dashboard-only CSS, layered on top of panelThemeCss() (design tokens, form
// controls, buttons, badges, tables, dialogs, overlays). Class/attribute
// driven — never inline style attributes; geometry-only inline SVG attributes
// are allowed later for charts. CSP-safe: no url()/data:/@import.

export function dashboardCss(): string {
  return `
  #app { display:grid; grid-template-columns:248px 1fr; min-height:100vh; }
  .side { background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column;
    padding:16px 12px; position:sticky; top:0; height:100vh; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:700; font-size:15px; padding:6px 8px 18px; letter-spacing:-.01em; }
  .brand .dot { width:24px; height:24px; border-radius:7px; background:var(--accent); color:var(--accent-fg);
    display:inline-flex; align-items:center; justify-content:center; font-size:13px; }
  #nav { display:flex; flex-direction:column; gap:2px; overflow-y:auto; flex:1; }
  #nav .navsep { text-transform:uppercase; font-size:10.5px; letter-spacing:.08em; color:var(--faint);
    padding:14px 12px 4px; }
  #nav button { all:unset; display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding:9px 12px; border-radius:8px; cursor:pointer; color:var(--muted); font-weight:500; font-size:13.5px;
    transition:background .12s,color .12s; }
  #nav button:hover { background:var(--accent-weak); color:var(--text); }
  #nav button.active { background:var(--accent-weak); color:var(--accent); font-weight:650; box-shadow:inset 2px 0 0 var(--accent); }
  #nav .navcount { font-size:11px; font-weight:700; color:var(--danger); background:var(--danger-weak);
    border-radius:999px; padding:1px 8px; }
  .side-foot { margin-top:auto; padding:12px 8px 4px; }
  .chip { display:inline-block; text-transform:uppercase; font-size:10.5px; letter-spacing:.08em; color:var(--muted);
    border:1px solid var(--border); border-radius:999px; padding:3px 10px; }
  .mainwrap { display:flex; flex-direction:column; min-width:0; }
  .topbar { min-height:56px; display:flex; align-items:center; gap:14px; padding:0 30px; border-bottom:1px solid var(--border);
    color:var(--muted); font-size:13px; position:sticky; top:0; background:var(--bg); z-index:5; }
  .topbar .jumpwrap { flex:1; max-width:420px; }
  .topbar input#jump { padding:8px 12px; font-size:13px; }
  .topbar .who { white-space:nowrap; }
  body.testmode { border-top:3px solid var(--warn); }
  main { padding:22px 30px 90px; width:100%; max-width:1200px; }
  #crumbs { display:flex; align-items:center; gap:6px; flex-wrap:wrap; color:var(--muted); font-size:13px; margin:0 0 14px; }
  #crumbs a { color:var(--accent); text-decoration:none; cursor:pointer; }
  #crumbs a:hover { text-decoration:underline; }
  #crumbs .sep { color:var(--faint); }
  #crumbs .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; color:var(--text); }

  .pagehead { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin:0 0 16px; flex-wrap:wrap; }
  .pagehead .titles { min-width:0; }
  .pagehead h1 { margin:0; font-size:20px; font-weight:700; letter-spacing:-.01em; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .pagehead .objid { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; color:var(--muted); margin-top:4px;
    display:flex; align-items:center; gap:6px; }
  .pagehead .headactions { display:flex; gap:8px; flex-wrap:wrap; }

  .statrow { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:0 0 18px; }
  .stat { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px 16px; box-shadow:var(--shadow); }
  .stat .slabel { color:var(--muted); font-size:12px; font-weight:600; }
  .stat .svalue { font-size:19px; font-weight:700; margin-top:3px; letter-spacing:-.01em; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .stat .ssub { color:var(--faint); font-size:12px; margin-top:2px; }
  .stat.link { cursor:pointer; }
  .stat.link:hover { border-color:var(--accent); }

  .tablewrap { overflow-x:auto; }
  td .sub { display:block; color:var(--faint); font-size:11.5px; }
  td.money { font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; }
  td.money.pos { color:var(--ok); }
  td.money.neg { color:var(--danger); }
  td.money.muted { color:var(--muted); font-weight:500; }
  td .mono, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  td a.rowlink { color:var(--text); text-decoration:none; }
  td a.rowlink:hover { color:var(--accent); }
  td a.reflink { color:var(--accent); text-decoration:none; }
  td a.reflink:hover { text-decoration:underline; }
  tbody tr.clickable { cursor:pointer; }
  td .flagset { display:flex; gap:4px; flex-wrap:wrap; }
  th.aright, td.aright { text-align:right; }

  .filterbar { display:flex; gap:8px; align-items:flex-end; flex-wrap:wrap; margin:0 0 12px; }
  .filterbar .fitem { display:flex; flex-direction:column; gap:3px; }
  .filterbar label { font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  .filterbar select, .filterbar input { width:auto; min-width:130px; padding:7px 10px; font-size:12.5px; }
  .filterbar .btn { padding:7px 12px; }

  .pager { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }

  .kv { margin:0; }
  .kv .kvrow { display:grid; grid-template-columns:200px 1fr; gap:10px; padding:9px 0; border-top:1px solid var(--border); font-size:13px; }
  .kv .kvrow:first-of-type { border-top:none; }
  .kv .kvlabel { color:var(--muted); font-weight:600; }
  .kv .kvval { min-width:0; overflow-wrap:anywhere; display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; }

  .timeline { list-style:none; margin:0; padding:0; }
  .timeline li { position:relative; padding:0 0 16px 22px; }
  .timeline li:before { content:""; position:absolute; left:5px; top:6px; bottom:-6px; width:2px; background:var(--border); }
  .timeline li:last-child:before { display:none; }
  .timeline .tdot { position:absolute; left:0; top:4px; width:12px; height:12px; border-radius:50%; background:var(--faint); border:2px solid var(--surface); }
  .timeline li.ok .tdot { background:var(--ok); }
  .timeline li.warn .tdot { background:var(--warn); }
  .timeline li.error .tdot { background:var(--danger); }
  .timeline li.info .tdot { background:var(--accent); }
  .timeline .ttitle { font-weight:600; font-size:13px; display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .timeline .twhen { color:var(--faint); font-size:12px; font-weight:400; }
  .timeline .ttext { color:var(--muted); font-size:12.5px; margin-top:2px; }

  .noticebar { display:flex; align-items:center; gap:10px; padding:12px 16px; border-radius:var(--radius);
    border:1px solid var(--border); background:var(--surface); margin:0 0 18px; font-size:13px; flex-wrap:wrap; }
  .noticebar.error { border-color:var(--danger); background:var(--danger-weak); }
  .noticebar.warn { border-color:var(--warn); background:var(--warn-weak); }
  .noticebar .ntext { flex:1; min-width:200px; }

  .emptybox { text-align:center; color:var(--muted); padding:40px 16px; }
  .emptybox .etitle { font-size:15px; font-weight:650; color:var(--text); }
  .emptybox .ehint { font-size:13px; margin-top:4px; }

  .copybtn { all:unset; cursor:pointer; color:var(--faint); font-size:12px; border:1px solid var(--border);
    border-radius:6px; padding:1px 7px; line-height:1.5; }
  .copybtn:hover { color:var(--accent); border-color:var(--accent); }
  .copybtn.copied { color:var(--ok); border-color:var(--ok); }

  .tnotice { color:var(--faint); font-size:12px; margin-top:8px; }
  .logincard { text-align:left; min-width:320px; }
  .logincard h2, .logincard > .muted:first-of-type { text-align:center; }
  .logincard label { display:block; font-weight:600; font-size:12.5px; margin:12px 0 5px; }
  .logincard .btn.wide { width:100%; justify-content:center; margin-top:14px; }
  .logincard .small { font-size:12px; text-align:center; margin-top:12px; }
  .logincard .error { margin:10px 0 0; }
  .qrbox { text-align:center; }
  .qrbox svg { width:230px; height:230px; border-radius:12px; }
  .skel { border-radius:8px; background:linear-gradient(100deg,var(--elev) 40%,var(--accent-weak) 50%,var(--elev) 60%);
    background-size:200% 100%; animation:shimmer 1.2s linear infinite; }
  @keyframes shimmer { to { background-position:-200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skel { animation:none; } .spinner { animation:none; } }

  @media (max-width:760px) {
    #app { grid-template-columns:1fr; }
    .side { position:static; height:auto; flex-direction:row; align-items:center; overflow-x:auto; padding:10px 12px; }
    .brand { padding:6px 8px; }
    #nav { flex-direction:row; }
    #nav .navsep { padding:0 6px; }
    .side-foot { display:none; }
    main { padding:18px 16px 70px; }
    .kv .kvrow { grid-template-columns:1fr; gap:2px; }
    .topbar { padding:0 16px; }
  }
  `;
}
