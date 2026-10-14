import { test } from "node:test";
import assert from "node:assert/strict";
import { queueClient } from "../html/queueClient";

function client() {
  const requests: Array<(response: unknown) => void> = [];
  const timers: Array<{ fn: () => void; delay: number; cancelled: boolean }> = [];
  const elements = new Map<string, { textContent: string; appendChild: () => void }>();
  const document = { title: "" };
  const D: any = {
    state: { page: "mine", params: {}, filters: {}, cursor: null, stack: [] },
    q: (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", appendChild() {} });
      return elements.get(id);
    },
    clearFlash() {},
    el: () => ({ appendChild() {} }),
    api: () => new Promise((resolve) => requests.push(resolve)),
    handle: (response: { j: unknown }) => response.j,
    renderBlocks() {},
  };
  // Load the client functions without the page's boot event bindings. The
  // DOM renderer is stubbed so these tests exercise request/poll ordering.
  const functions = queueClient.slice(0, queueClient.lastIndexOf('document.getElementById("expiredReload")'));
  new Function("D", "document", "window", "setTimeout", "clearTimeout", functions)(
    D, document, { scrollY: 0, scrollTo() {} },
    (fn: () => void, delay: number) => {
      timers.push({ fn, delay, cancelled: false });
      return timers.length;
    },
    (id: number) => { timers[id - 1].cancelled = true; }
  );
  D.renderNav = () => {};
  D.renderCrumbs = () => {};
  return { D, document, requests, timers, elements };
}

function response(title: string, refreshing = false) {
  return { j: { title, actorLabel: "Ada", blocks: [], ...(refreshing ? { refreshing: true } : {}) } };
}

test("the queue polls an unfinished scan and stops polling when the list is ready", async () => {
  const c = client();
  c.D.loadPage();
  c.requests[0](response("Reading tickets", true));
  await Promise.resolve();
  assert.equal(c.document.title, "Reading tickets · Intercom Queue");
  assert.equal(c.timers.length, 1);
  assert.equal(c.timers[0].delay, 5000);
  c.timers[0].fn();
  assert.equal(c.requests.length, 2);
  c.requests[1](response("Mine"));
  await Promise.resolve();
  assert.equal(c.document.title, "Mine · Intercom Queue");
  assert.equal(c.elements.get("who")?.textContent, "Ada");
  assert.equal(c.timers.length, 1, "a completed scan does not keep polling every five seconds");
});

test("an old scan response cannot overwrite a newer route or schedule another poll", async () => {
  const c = client();
  c.D.loadPage();
  c.D.loadPage();
  c.requests[1](response("Global"));
  await Promise.resolve();
  c.requests[0](response("Mine", true));
  await Promise.resolve();
  assert.equal(c.document.title, "Global · Intercom Queue");
  assert.equal(c.timers.length, 0);
});
