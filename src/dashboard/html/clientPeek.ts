// Client module: hover peek cards. 300ms hover-intent on reflink
// anchors whose target page is allowlisted; a singleton fixed-position card
// hydrated from the cached `peek` endpoint. textContent only — never
// innerHTML. Self-binding (document-level listeners), like clientBlocks'
// outside-click handler.

export const clientPeek = `
D.PEEK_PAGES = { "customers.detail": 1, "payments.detail": 1 };
D.peekMem = {};
D.peekTimer = null;
D.peekCard = null;
D.peekKey = null;

// Parse a path href ("/billing/customers/cus_1") back into { page, id } —
// detail pages only (second segment must look like a Stripe id).
D.peekTarget = function (href) {
  var base = (D.BASE || "/billing") + "/";
  if (!href || href.indexOf(base) !== 0) return null;
  var h = href.slice(base.length);
  var q = h.indexOf("?");
  if (q >= 0) h = h.slice(0, q);
  var seg = h.split("/").filter(function (s) { return s.length > 0; }).map(decodeURIComponent);
  if (seg.length !== 2 || seg[1].indexOf("_") < 0) return null;
  var page = seg[0] + ".detail";
  if (!D.PEEK_PAGES[page]) return null;
  return { page: page, id: seg[1] };
};

D.hidePeek = function () {
  if (D.peekTimer) { clearTimeout(D.peekTimer); D.peekTimer = null; }
  D.peekKey = null;
  if (D.peekCard) { D.peekCard.remove(); D.peekCard = null; }
};

D.showPeek = function (data, anchor) {
  D.hidePeek();
  var card = D.el("div", "peekcard");
  var head = D.el("div", "peekhead");
  head.appendChild(D.el("span", "peektitle", data.title || ""));
  if (data.badge) head.appendChild(D.badge(data.badge));
  card.appendChild(head);
  (data.lines || []).slice(0, 5).forEach(function (line) {
    card.appendChild(D.el("div", "peekline", line));
  });
  document.body.appendChild(card);
  // Clamp to the viewport: below the anchor, flipped up when out of room.
  var r = anchor.getBoundingClientRect();
  var cw = card.offsetWidth, ch = card.offsetHeight;
  var x = Math.min(Math.max(8, r.left), window.innerWidth - cw - 8);
  var y = r.bottom + 8;
  if (y + ch > window.innerHeight - 8) y = Math.max(8, r.top - ch - 8);
  card.style.left = x + "px";
  card.style.top = y + "px";
  D.peekCard = card;
};

document.addEventListener("mouseover", function (e) {
  var t = e.target;
  while (t && t !== document.body && !(t.tagName === "A" && t.classList && t.classList.contains("reflink"))) {
    t = t.parentNode;
  }
  if (!t || t === document.body || !t.getAttribute) return;
  var target = D.peekTarget(t.getAttribute("href"));
  if (!target) return;
  var key = target.page + ":" + target.id;
  if (key === D.peekKey && D.peekCard) return;
  if (D.peekTimer) clearTimeout(D.peekTimer);
  // 300ms hover intent, then serve from the 30s client cache or fetch.
  D.peekTimer = setTimeout(function () {
    D.peekTimer = null;
    var hit = D.peekMem[key];
    if (hit && Date.now() - hit.at < 30000) {
      if (hit.data) { D.peekKey = key; D.showPeek(hit.data, t); }
      return;
    }
    D.api("peek", { page: target.page, id: target.id }).then(function (res) {
      var data = res.status === 200 && res.j && res.j.title ? res.j : null;
      D.peekMem[key] = { at: Date.now(), data: data };
      if (data && t.isConnected) { D.peekKey = key; D.showPeek(data, t); }
    }).catch(function () {});
  }, 300);
});

document.addEventListener("mouseout", function (e) {
  var t = e.target;
  var going = e.relatedTarget;
  // Leaving the anchor (and not entering the card) hides the card.
  if (going && D.peekCard && (going === D.peekCard || D.peekCard.contains(going))) return;
  if (t && t.tagName === "A" && t.classList && t.classList.contains("reflink")) D.hidePeek();
  else if (D.peekTimer) { clearTimeout(D.peekTimer); D.peekTimer = null; }
});
document.addEventListener("scroll", function () { D.hidePeek(); }, true);
window.addEventListener("dashroute", function () { D.hidePeek(); });
`;
