import { test } from "node:test";
import assert from "node:assert/strict";
import { queueClient } from "../html/queueClient";

function client() {
  const requests: Array<(response: unknown) => void> = [];
  const bodies: Array<Record<string, unknown>> = [];
  const timers: Array<{ fn: () => void; delay: number; cancelled: boolean }> = [];
  const elements = new Map<string, { textContent: string; appendChild: () => void }>();
  const document = { title: "", hidden: false, overlay: false, querySelector: () => (document.overlay ? {} : null) };
  const D: any = {
    state: { page: "mine", params: {}, filters: {}, cursor: null, stack: [] },
    q: (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", appendChild() {} });
      return elements.get(id);
    },
    clearFlash() {},
    el: () => ({ appendChild() {} }),
    api: (_endpoint: string, body: Record<string, unknown>) =>
      new Promise((resolve) => {
        requests.push(resolve);
        bodies.push(body);
      }),
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
  const lastTimer = () => timers.filter((t) => !t.cancelled).at(-1);
  return { D, document, requests, bodies, timers, lastTimer, elements };
}

function response(title: string, version: string) {
  return { j: { title, actorLabel: "Ada", blocks: [], version } };
}

test("the page long-polls on the version it shows and redraws when the list changes", async () => {
  const c = client();
  c.D.loadPage();
  c.requests[0](response("Reading tickets", "abcd0123.0"));
  await Promise.resolve();
  assert.equal(c.document.title, "Reading tickets · Intercom Queue");
  assert.equal(c.elements.get("who")?.textContent, "Ada");
  assert.equal(c.requests.length, 2, "a long-poll follows the page at once");
  assert.equal(c.bodies[1].since, "abcd0123.0");
  assert.equal(c.bodies[0].since, undefined, "the page itself never waits");

  c.requests[1](response("Mine", "abcd0123.1"));
  await Promise.resolve();
  assert.equal(c.document.title, "Mine · Intercom Queue");
  assert.equal(c.lastTimer()?.delay, 2000, "a burst of changes redraws at most every two seconds");
  c.lastTimer()!.fn();
  assert.equal(c.bodies[2].since, "abcd0123.1");

  // No change in the wait: ask again, but not in a tight loop when the
  // answer came back at once.
  c.requests[2]({ j: { unchanged: true } });
  await Promise.resolve();
  assert.equal(c.lastTimer()?.delay, 5000);
});

test("an old answer cannot overwrite a newer route or start a second long-poll", async () => {
  const c = client();
  c.D.loadPage();
  c.D.loadPage();
  c.requests[1](response("Global", "abcd0123.1"));
  await Promise.resolve();
  c.requests[0](response("Mine", "abcd0123.0"));
  await Promise.resolve();
  assert.equal(c.document.title, "Global · Intercom Queue");
  assert.equal(c.requests.length, 3, "one long-poll, for the newer page");
  assert.equal(c.bodies[2].since, "abcd0123.1");
});

test("a change waits while a dialog or popover is open, then redraws", async () => {
  const c = client();
  c.D.loadPage();
  c.requests[0](response("Mine", "abcd0123.0"));
  await Promise.resolve();
  c.document.overlay = true;
  c.requests[1](response("Mine, changed", "abcd0123.1"));
  await Promise.resolve();
  assert.equal(c.document.title, "Mine · Intercom Queue", "not under an open dialog");
  assert.equal(c.lastTimer()?.delay, 1000);
  c.document.overlay = false;
  c.lastTimer()!.fn();
  assert.equal(c.document.title, "Mine, changed · Intercom Queue");
});

test("a hidden tab stops asking until it is shown again", async () => {
  const c = client();
  c.document.hidden = true;
  c.D.loadPage();
  c.requests[0](response("Mine", "abcd0123.0"));
  await Promise.resolve();
  assert.equal(c.requests.length, 1);
  assert.equal(c.D.watchPaused, true);
});
