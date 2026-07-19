// Billing-dashboard layout on top of stripeBaseCss() (tokens + controls).
// Stripe Dashboard idioms: borderless left nav on the page background with
// quiet rounded hovers, a centered pill search, whitespace-led content column,
// hairline-bordered white cards, sentence-case micro-labels.

export function dashboardCss(): string {
  return `
  #app { display:grid; grid-template-columns:222px 1fr; min-height:100vh; }
  .side { display:flex; flex-direction:column; padding:14px 12px; position:sticky; top:0; height:100vh; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:600; font-size:15px; color:var(--heading);
    padding:4px 10px 16px; letter-spacing:-.01em; }
  .brand .dot { width:26px; height:26px; border-radius:7px; background:linear-gradient(135deg,#635bff,#9a66ff);
    color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; }
  #nav { display:flex; flex-direction:column; gap:1px; overflow-y:auto; flex:1; }
  #nav .navsep { font-size:12px; font-weight:600; color:var(--muted); padding:16px 10px 4px; }
  #nav button { all:unset; display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding:6px 10px; border-radius:var(--radius-sm); cursor:pointer; color:var(--text); font-weight:450;
    font-size:14px; transition:background .1s,color .1s; }
  #nav button:hover { background:var(--hover); }
  #nav button.active { background:var(--accent-weak); color:var(--accent); font-weight:600; }
  #nav .navleft { display:flex; align-items:center; gap:9px; min-width:0; }
  #nav .navico { width:16px; height:16px; color:var(--faint); flex:0 0 auto; display:inline-flex; }
  #nav .navico svg { width:16px; height:16px; }
  #nav button:hover .navico { color:var(--muted); }
  #nav button.active .navico { color:var(--accent); }
  #nav .navlabel { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #nav .navcount { font-size:12px; font-weight:500; color:var(--danger); background:var(--danger-weak);
    border-radius:4px; padding:0 6px; }
  .mainwrap { display:flex; flex-direction:column; min-width:0; }
  .topbar { min-height:56px; display:flex; align-items:center; gap:14px; padding:0 32px;
    border-bottom:1px solid var(--border); color:var(--muted); font-size:13.5px; position:sticky; top:0;
    background:var(--bg); z-index:5; }
  .topbar .jumpwrap { flex:1; max-width:430px; position:relative; }
  /* Search stays left; identity + session controls pin to the right edge. */
  .topbar .who { margin-left:auto; }
  /* Global "+ Create" menu (PA-8): reuses the ··· popover chrome. */
  .topbar .createwrap .morepop { right:0; left:auto; min-width:220px; }

  /* Needs-attention bell (PA-13): same popover chrome, wider for the labels. */
  .topbar .bellwrap .morepop { right:0; left:auto; min-width:320px; max-width:420px; max-height:60vh; overflow-y:auto; }
  #bellbtn { position:relative; display:inline-flex; align-items:center; gap:4px; padding:6px 8px; }
  #bellbtn svg { width:15px; height:15px; }
  #bellbtn .navcount { position:absolute; top:-5px; right:-6px; }
  .bellitem { display:flex; align-items:flex-start; gap:8px; text-align:left; white-space:normal; }
  .bellitem .belllabel { flex:1; min-width:0; font-size:13px; line-height:1.35; }
  .bellitem .badge { flex:0 0 auto; margin-top:1px; }

  /* Hover peek card (PA-13): singleton fixed card, viewport-clamped. */
  .peekcard { position:fixed; z-index:60; background:var(--surface); border:1px solid var(--border);
    border-radius:10px; box-shadow:var(--shadow-pop); padding:12px 14px; max-width:320px; min-width:200px;
    pointer-events:auto; }
  .peekcard .peekhead { display:flex; align-items:center; gap:8px; margin:0 0 6px; flex-wrap:wrap; }
  .peekcard .peektitle { font-weight:600; color:var(--heading); font-size:14px; }
  .peekcard .peekline { color:var(--muted); font-size:12.5px; line-height:1.5; overflow-wrap:anywhere; }

  /* daterange filter (PA-13): the custom two-date row inside the pill popover. */
  .fpop .rangerow { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .fpop .rangerow input[type=date] { font-size:12.5px; padding:5px 7px; }

  /* ?-help dialog (PA-13). */
  .helptable { border-collapse:collapse; margin:8px 0 4px; }
  .helptable td { padding:5px 14px 5px 0; font-size:13.5px; color:var(--muted); }
  .helptable kbd { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:var(--heading);
    background:var(--fill); border:1px solid var(--border-strong); border-radius:4px; padding:1px 5px; }

  #menubtn { display:none; }
  #scrim { display:none; }

  /* Command palette (⌘K) under the topbar search box. */
  .palpop { position:absolute; top:calc(100% + 8px); left:0; width:560px; max-width:min(80vw,560px); z-index:30;
    background:var(--surface); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow-pop);
    padding:6px; display:none; max-height:70vh; overflow-y:auto; }
  .palpop.open { display:block; }
  .palgroup { font-size:11px; font-weight:600; color:var(--faint); text-transform:uppercase; letter-spacing:.05em;
    padding:8px 10px 4px; }
  .palrow { all:unset; display:flex; align-items:center; gap:8px; width:100%; box-sizing:border-box;
    padding:7px 10px; border-radius:8px; cursor:pointer; font-size:13.5px; }
  .palrow.sel { background:var(--hover); }
  .palrow .pt { color:var(--heading); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .palrow .ps { color:var(--muted); font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .palrow .pid { margin-left:auto; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px;
    color:var(--faint); flex:0 0 auto; }
  .palnote { color:var(--faint); font-size:12px; padding:8px 10px; }

  /* Home charts: two-up responsive grid, quiet axes, accent marks. */
  .chartgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:8px 40px; margin:0 0 24px; }
  .chartbox { margin:0 0 8px; }
  .chart { width:100%; height:auto; display:block; }
  .cgrid { stroke:var(--border); stroke-width:1; }
  .clabel { fill:var(--faint); font-size:10.5px; }
  .clabel.warn { fill:var(--warn); }
  .clabel.error { fill:var(--danger-strong); }
  .cband { stroke-width:1; stroke-dasharray:4 3; }
  .cband.warn { stroke:var(--warn); }
  .cband.error { stroke:var(--danger-strong); }
  .cline { fill:none; stroke:var(--accent); stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
  .carea { fill:var(--accent); opacity:.14; }
  .cbar { fill:var(--accent); opacity:.85; }
  .cdot { fill:var(--surface); stroke:var(--accent); stroke-width:1.6; }
  .topbar input#jump { padding:7px 12px; font-size:13.5px; background:var(--elev); border-color:transparent;
    box-shadow:none; border-radius:var(--radius); }
  .topbar input#jump:focus { background:var(--surface); border-color:var(--accent); box-shadow:0 0 0 3px var(--ring); }
  .topbar .who { white-space:nowrap; }
  /* Stripe fills the viewport — no centered column cap. */
  main { padding:24px 40px 90px; width:100%; }
  #crumbs { display:flex; align-items:center; gap:6px; flex-wrap:wrap; color:var(--muted); font-size:13px; margin:0 0 10px; }
  #crumbs:empty { display:none; }
  #crumbs a { color:var(--accent); text-decoration:none; cursor:pointer; font-weight:500; }
  #crumbs a:hover { text-decoration:underline; }
  #crumbs .sep { color:var(--faint); }
  #crumbs .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; color:var(--text); }

  .pagehead { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin:0 0 18px; flex-wrap:wrap; }
  .pagehead .titles { min-width:0; }
  .pagehead h1 { margin:0; font-size:22px; font-weight:600; letter-spacing:-.015em; display:flex; align-items:center;
    gap:10px; flex-wrap:wrap; }
  .pagehead h1 .tsuffix { color:var(--faint); font-weight:600; margin-left:-4px; }
  .pagehead .subline { color:var(--muted); font-size:14px; margin-top:3px; display:flex; align-items:center; gap:6px; }
  .pagehead .objid { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; color:var(--muted);
    margin-top:4px; display:flex; align-items:center; gap:6px; }
  .pagehead .headactions { display:flex; gap:8px; flex-wrap:wrap; }
  .morewrap { position:relative; display:inline-flex; }
  .morebtn { letter-spacing:.1em; padding:6px 10px; }
  .morepop { position:absolute; top:calc(100% + 6px); right:0; z-index:20; background:var(--surface);
    border:1px solid var(--border); border-radius:8px; box-shadow:var(--shadow-pop); padding:6px;
    min-width:200px; display:none; }
  .morepop.open { display:flex; flex-direction:column; gap:2px; }
  .morepop .btn.menuitem { justify-content:flex-start; border:none; box-shadow:none; background:transparent;
    font-weight:500; width:100%; box-sizing:border-box; padding:7px 10px; border-radius:6px; }
  .morepop .btn.menuitem:hover { background:var(--hover); }
  .morepop .btn.menuitem.primary { color:var(--heading); }
  .morepop .btn.menuitem.danger { color:var(--danger-strong); }
  .morepop .btn.menuitem.danger:hover { background:var(--danger-weak); }

  /* Detail-page layout: main column + Stripe-style right rail. */
  .detailgrid { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:40px; align-items:start; }
  .detailmain { min-width:0; }
  .detailrail { display:flex; flex-direction:column; gap:0; }
  /* Rail "Details/Insights" cards stack label-over-value (not a 2-col kv),
     separated by hairlines rather than boxes. */
  .detailrail .section { margin:0; padding:0 0 22px; }
  .detailrail .section + .section { border-top:1px solid var(--border); padding-top:20px; }
  .detailrail .section h2 { font-size:16px; margin:0 0 14px; }
  .detailrail .kv .kvrow { grid-template-columns:1fr; gap:2px; padding:0 0 14px; border-top:none; }
  .detailrail .kv .kvrow:last-of-type { padding-bottom:2px; }
  .detailrail .kv .kvlabel { color:var(--heading); font-weight:600; font-size:13px; }
  .detailrail .kv .kvval { color:var(--muted); font-size:13.5px; }
  .detailrail .kvbig .kvval { color:var(--heading); font-size:16px; font-weight:600; }
  .detailrail .btn.secfoot { margin:6px 8px 0 0; }
  @media (max-width:980px) { .detailgrid { grid-template-columns:1fr; gap:8px; } .detailrail { flex-direction:column; } }

  .statrow { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:0 0 16px; }
  .stat { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px 16px;
    box-shadow:var(--shadow-card); }
  .stat .slabel { color:var(--muted); font-size:12.5px; font-weight:500; }
  .stat .svalue { font-size:19px; font-weight:600; color:var(--heading); margin-top:3px; letter-spacing:-.01em;
    display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .stat .ssub { color:var(--faint); font-size:12.5px; margin-top:2px; }
  .stat.link { cursor:pointer; transition:border-color .1s; }
  .stat.link:hover { border-color:var(--accent); }

  .tablewrap { overflow-x:auto; margin:0 -20px; padding:0 20px; }
  /* Sticky table headers (PA-13, desktop only): overflow-x:auto makes
     .tablewrap the scroll container and kills sticky — desktop gives up
     h-scroll for pinned headers; mobile keeps the trade the other way.
     Sections are transparent, so the th background is the PAGE token. */
  @media (min-width:761px) {
    .tablewrap { overflow-x:visible; }
    .tablewrap thead th { position:sticky; top:56px; background:var(--bg); z-index:2;
      box-shadow:0 1px 0 var(--border); }
  }
  td .sub { display:block; color:var(--faint); font-size:12px; }
  td.money { font-variant-numeric:tabular-nums; font-weight:500; white-space:nowrap; }
  td.money.pos { color:var(--ok); }
  td.money.neg { color:var(--danger); }
  td.money.muted { color:var(--muted); }
  td .mono, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  td a.reflink { color:var(--accent); text-decoration:none; }
  td a.reflink:hover { text-decoration:underline; }
  tbody tr.clickable { cursor:pointer; }
  td .flagset { display:flex; gap:4px; flex-wrap:wrap; }
  th.aright, td.aright { text-align:right; }

  /* Stripe tab row (under the H1): quiet labels, blurple underline. */
  .tabrow { display:flex; gap:22px; border-bottom:1px solid var(--border); margin:0 0 18px; }
  .tab { all:unset; display:inline-flex; align-items:center; gap:6px; cursor:pointer; padding:0 2px 9px;
    font-size:14px; font-weight:500; color:var(--muted); border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tab:hover { color:var(--heading); }
  .tab.active { color:var(--accent); font-weight:600; border-bottom-color:var(--accent); }
  .tab .tabcount { font-size:12px; font-weight:500; color:var(--danger); background:var(--danger-weak);
    border-radius:999px; padding:0 7px; }
  .tab:focus-visible { box-shadow:0 0 0 3px var(--ring); border-radius:4px; }

  /* Stripe atoms ------------------------------------------------------- */
  .badge { display:inline-flex; align-items:center; gap:3px; }
  .badge .bg { font-size:10px; line-height:1; opacity:.85; }
  .nowrap { white-space:nowrap; }
  .strongname { font-weight:600; color:var(--heading); }
  a.reflink.strongname { color:var(--heading); }
  a.reflink.strongname:hover { color:var(--accent); text-decoration:none; }

  td.amountcell { white-space:nowrap; font-variant-numeric:tabular-nums; }
  .amountcell .amt { font-weight:600; color:var(--heading); }
  .amountcell .cur { color:var(--faint); font-size:12.5px; margin-left:5px; }
  .amountcell .badge { margin-left:9px; }

  .cardcell { display:inline-flex; align-items:center; gap:7px; }
  /* Stripe-style monochrome card-brand mark: a quiet bordered chip, not a
     bold filled colour badge (true SVG brand logos can come later). */
  .cardchip { display:inline-flex; align-items:center; justify-content:center; min-width:32px; height:20px;
    padding:0 5px; border-radius:4px; font-size:9px; font-weight:700; letter-spacing:.04em; color:var(--muted);
    background:var(--fill); border:1px solid var(--border-strong); }
  .cardnum { font-variant-numeric:tabular-nums; color:var(--heading); }

  .avcell { display:inline-flex; align-items:center; gap:8px; }
  .objicon { width:22px; height:22px; border-radius:6px; background:var(--accent-weak); color:var(--accent);
    display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; }
  .objicon svg { width:13px; height:13px; }
  td .sub.subindent { margin-left:30px; }

  .countrow { display:flex; gap:12px; flex-wrap:wrap; margin:0 0 14px; }
  /* Cards stretch evenly across the full row, like Stripe's segmented filter. */
  .countcard { all:unset; box-sizing:border-box; flex:1 1 0; min-width:110px; max-width:230px; cursor:pointer;
    background:var(--surface); border:1px solid var(--border-strong); border-radius:var(--radius);
    padding:10px 14px; display:flex; flex-direction:column; transition:border-color .1s,background .1s; }
  .countcard:hover { border-color:var(--accent); }
  .countcard:focus-visible { outline:none; box-shadow:0 0 0 3px var(--ring); }
  .countcard.active { border-color:var(--accent); background:var(--accent-weak); }
  .countcard .clabel { font-size:13px; font-weight:500; color:var(--muted); }
  .countcard.active .clabel { color:var(--accent); }
  .countcard .cnum { font-size:18px; font-weight:600; color:var(--heading); margin-top:2px;
    font-variant-numeric:tabular-nums; }

  .pillbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 14px; }
  .fpillwrap { position:relative; display:inline-flex; }
  .fpill { all:unset; display:inline-flex; align-items:center; gap:6px; padding:3px 12px 3px 9px;
    border-radius:999px; border:1px solid var(--border-strong); color:var(--muted); font-size:13px;
    font-weight:500; cursor:pointer; transition:border-color .1s,color .1s,background .1s; }
  .fpill:hover { border-color:var(--accent); color:var(--accent); }
  .fpill:focus-visible { box-shadow:0 0 0 3px var(--ring); }
  .fpill .pplus { width:14px; height:14px; border-radius:50%; border:1px solid currentColor; display:inline-flex;
    align-items:center; justify-content:center; font-size:11px; line-height:1; flex:0 0 auto; }
  .fpill.set { border-color:var(--accent); color:var(--accent); background:var(--accent-weak); padding-left:12px; }
  .fpill .psep { opacity:.4; }
  .fpill .pval { font-weight:600; }
  .fpill .px { font-size:14px; padding-left:2px; line-height:1; }
  .fpill .px:hover { color:var(--danger); }
  .pillclear { all:unset; cursor:pointer; font-size:13px; color:var(--muted); padding:3px 8px; }
  .pillclear:hover { color:var(--accent); }
  .fpop { position:absolute; top:calc(100% + 6px); left:0; z-index:20; background:var(--surface);
    border:1px solid var(--border); border-radius:8px; box-shadow:var(--shadow-pop); padding:12px;
    min-width:220px; display:none; }
  .fpop.open { display:flex; flex-direction:column; gap:8px; }
  .fpop label { font-size:12px; font-weight:600; color:var(--heading); }
  .fpop .btn { align-self:flex-end; }

  /* List toolbar (filter pills left, Export / Edit-columns right) + bulk bar. */
  .listtoolbar { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin:0 0 14px; flex-wrap:wrap; }
  .listtoolbar .pillbar { margin:0; }
  .listtoolbar .toolright { display:flex; gap:8px; align-items:center; margin-left:auto; }
  .bulkbar { display:flex; align-items:center; gap:8px; margin:12px 0 0; padding:8px 12px; border-radius:var(--radius-sm);
    background:var(--accent-weak); border:1px solid var(--accent); flex-wrap:wrap; }
  .bulkbar .bulkcount { font-weight:600; color:var(--accent); font-size:13px; margin-right:4px; }
  th.selcol, td.selcol { width:34px; text-align:center; padding-right:0; }
  th.selcol input, td.selcol input { cursor:pointer; margin:0; vertical-align:middle; }
  .colmenu { min-width:180px; }
  .colmenu .colopt { display:flex; align-items:center; gap:8px; padding:5px 8px; border-radius:6px; font-weight:500;
    font-size:13px; color:var(--heading); cursor:pointer; white-space:nowrap; }
  .colmenu .colopt:hover { background:var(--hover); }
  .colmenu .colopt input { margin:0; cursor:pointer; }

  .tsearch { margin:0 0 14px; position:relative; max-width:560px; }
  .tsearch input { padding:8px 12px 8px 34px; font-size:13.5px; }
  .tsearch svg { position:absolute; left:12px; top:50%; transform:translateY(-50%); width:14px; height:14px;
    color:var(--faint); pointer-events:none; }

  .tfootrow { display:flex; align-items:center; gap:12px; margin-top:10px; }
  .tfoot { color:var(--muted); font-size:13px; }
  a.tfoot.link { color:var(--accent); text-decoration:none; }
  a.tfoot.link:hover { text-decoration:underline; }
  .pager { display:flex; gap:4px; }
  .pgbtn { all:unset; box-sizing:border-box; min-width:24px; height:24px; display:inline-flex; align-items:center;
    justify-content:center; border:1px solid var(--border-strong); border-radius:6px; color:var(--muted);
    font-size:15px; line-height:1; cursor:pointer; padding:0 4px; background:var(--surface); }
  .pgbtn:hover { color:var(--accent); border-color:var(--accent); }
  .pgbtn:disabled { opacity:.4; cursor:default; }
  .pgbtn:disabled:hover { color:var(--muted); border-color:var(--border-strong); }

  .kv { margin:0; }
  .kv .kvrow { display:grid; grid-template-columns:210px 1fr; gap:10px; padding:8px 0; border-top:1px solid var(--border);
    font-size:14px; }
  .kv .kvrow:first-of-type { border-top:none; padding-top:4px; }
  .kv .kvlabel { color:var(--muted); font-weight:450; font-size:13.5px; }
  .kv .kvval { min-width:0; overflow-wrap:anywhere; display:flex; align-items:baseline; gap:6px; flex-wrap:wrap; }
  .kvval .sub { display:block; flex-basis:100%; color:var(--faint); font-size:12px; }

  /* Stripe "Payment breakdown": label left, amount flush right, bold Net row
     with a hairline above — hairlines between the other rows are dropped. */
  .kv.amounts .kvrow { grid-template-columns:1fr auto; border-top:none; padding:7px 0; }
  .kv.amounts .kvval { justify-content:flex-end; text-align:right; font-variant-numeric:tabular-nums; }
  .kv.amounts .kvrow:last-of-type { border-top:1px solid var(--border); margin-top:6px; padding-top:13px; }
  .kv.amounts .kvrow:last-of-type .kvlabel { color:var(--heading); font-weight:600; }
  .kv.amounts .kvrow:last-of-type .kvval { font-weight:600; }

  .timeline { list-style:none; margin:0; padding:0; }
  .timeline li { position:relative; padding:0 0 14px 22px; }
  .timeline li:before { content:""; position:absolute; left:5px; top:6px; bottom:-6px; width:1px; background:var(--border); }
  .timeline li:last-child:before { display:none; }
  .timeline .tdot { position:absolute; left:0; top:5px; width:11px; height:11px; border-radius:50%;
    background:var(--faint); border:2px solid var(--surface); }
  .timeline li.ok .tdot { background:var(--ok); }
  .timeline li.warn .tdot { background:var(--warn); }
  .timeline li.error .tdot { background:var(--danger-strong); }
  .timeline li.info .tdot { background:var(--accent); }
  .timeline .ttitle { font-weight:500; font-size:13.5px; display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  .timeline .twhen { color:var(--faint); font-size:12.5px; font-weight:400; margin-left:auto; white-space:nowrap; }
  .timeline .ttext { color:var(--muted); font-size:13px; margin-top:1px; }

  .noticebar { display:flex; align-items:center; gap:10px; padding:11px 14px; border-radius:var(--radius);
    border:1px solid var(--border); background:var(--surface); margin:0 0 16px; font-size:13.5px; flex-wrap:wrap;
    box-shadow:var(--shadow-card); }
  .noticebar.error { border-color:var(--danger-strong); }
  .noticebar.warn { border-color:var(--warn); }
  .noticebar .ntext { flex:1; min-width:200px; }

  .emptybox { text-align:center; color:var(--muted); padding:44px 16px; }
  .emptybox .eicon { width:44px; height:44px; margin:0 auto 12px; border-radius:11px; background:var(--accent-weak);
    color:var(--accent); display:flex; align-items:center; justify-content:center; }
  .emptybox .eicon svg { width:22px; height:22px; }
  .emptybox .etitle { font-size:15px; font-weight:600; color:var(--heading); }
  .emptybox .ehint { font-size:13.5px; margin-top:4px; }

  .copybtn { all:unset; cursor:pointer; color:var(--faint); display:inline-flex; align-items:center;
    padding:2px; border-radius:4px; line-height:0; vertical-align:middle; }
  .copybtn svg { width:13px; height:13px; }
  .copybtn:hover { color:var(--accent); background:var(--hover); }
  .copybtn.copied { color:var(--ok); }

  .tnotice { color:var(--faint); font-size:12.5px; margin-top:8px; }
  .overlay .code { cursor:pointer; transition:border-color .12s; }
  .overlay .code:hover { border-color:var(--accent); border-style:solid; }
  .overlay .code.copied { border-color:var(--ok); border-style:solid; color:var(--ok); background:var(--ok-weak); }
  .codehint { color:var(--faint); font-size:12.5px; margin-top:-14px; }

  .logincard { text-align:left; min-width:340px; }
  .logincard h2, .logincard > .muted:first-of-type { text-align:center; }
  .logincard label { display:block; font-weight:500; font-size:13px; color:var(--heading); margin:12px 0 5px; }
  .logincard .btn.wide { width:100%; margin-top:14px; padding:8px 12px; }
  .logincard .small { font-size:12.5px; text-align:center; margin-top:12px; }
  .logincard .error { margin:10px 0 0; }
  .qrbox { text-align:center; }
  .qrbox svg { width:230px; height:230px; border-radius:10px; border:1px solid var(--border); }

  /* ---- dispute evidence workbench ---- */
  .evgroup { border:1px solid var(--border); border-radius:var(--radius); margin:0 0 10px; background:var(--surface); }
  .evgroup summary { cursor:pointer; display:flex; align-items:center; gap:10px; padding:10px 14px;
    font-weight:600; font-size:13.5px; color:var(--heading); list-style:none; }
  .evgroup summary::-webkit-details-marker { display:none; }
  .evgroup summary:before { content:"\\203A"; color:var(--faint); transition:transform .12s; }
  .evgroup[open] summary:before { transform:rotate(90deg); }
  .evgroup .evgtitle { display:inline-flex; align-items:center; gap:6px; }
  .evgroup .evstar { font-size:12px; }
  .evgroup .evgmeta { margin-left:auto; color:var(--faint); font-weight:400; font-size:12.5px; white-space:nowrap; }
  .evgbody { padding:2px 14px 12px; border-top:1px solid var(--border); }
  .evfield { margin:12px 0 0; }
  .evhead { display:flex; align-items:baseline; gap:8px; }
  .evlabel { font-weight:500; font-size:13px; color:var(--heading); }
  .evchip { font-size:11px; }
  .evcount { margin-left:auto; color:var(--faint); font-size:12px; font-variant-numeric:tabular-nums; }
  .evinput { width:100%; margin-top:5px; font:inherit; font-size:13.5px; color:var(--body);
    background:var(--surface); border:1px solid var(--border-strong); border-radius:6px; padding:7px 9px; resize:vertical; }
  .evinput:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-weak); }
  .evinput:disabled { background:var(--fill); color:var(--muted); }
  .evgfoot { margin-top:12px; display:flex; justify-content:flex-end; }
  .evfilehead { font-size:14px; font-weight:600; color:var(--heading); margin:18px 0 2px; }
  .evslot { display:flex; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid var(--border);
    font-size:13px; flex-wrap:wrap; }
  .evslot:last-child { border-bottom:none; }
  .evslotlabel { min-width:220px; font-weight:500; color:var(--heading); }
  .evslotfile { display:inline-flex; align-items:center; gap:4px; }
  .evfile { font-size:12.5px; color:var(--muted); }

  .skel { border-radius:6px; background:linear-gradient(100deg,var(--elev) 40%,var(--hover) 50%,var(--elev) 60%);
    background-size:200% 100%; animation:shimmer 1.2s linear infinite; }
  @keyframes shimmer { to { background-position:-200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skel { animation:none; } .spinner { animation:none; } }

  /* Mobile pass (PA-13): hamburger + sliding drawer replaces the old
     horizontal nav strip; tables keep overflow-x h-scroll. */
  @media (max-width:760px) {
    #app { grid-template-columns:1fr; }
    .side { position:fixed; left:0; top:0; bottom:0; width:242px; z-index:40; background:var(--bg);
      border-right:1px solid var(--border); transform:translateX(-100%); transition:transform .18s ease;
      height:100vh; height:100dvh; }
    .side.open { transform:translateX(0); box-shadow:var(--shadow-pop); }
    #scrim.show { display:block; position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:35; }
    #menubtn { display:inline-flex; padding:6px 10px; }
    main { padding:18px 16px 70px; }
    .kv .kvrow { grid-template-columns:1fr; gap:2px; }
    .topbar { padding:0 12px; gap:8px; }
    .tablewrap { -webkit-overflow-scrolling:touch; }
    .countcard { min-width:88px; padding:8px 10px; }
    .countcard .cnum { font-size:16px; }
    .palpop { width:calc(100vw - 24px); max-width:calc(100vw - 24px); }
  }
  @media (max-width:560px) { .topbar .who { display:none; } }
  `;
}
