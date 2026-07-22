import { test } from "node:test";
import assert from "node:assert/strict";
import { IntercomInboxApp } from "../IntercomInboxApp";
import type { SettingsStore } from "../../config/SettingsStore";
import type { IntercomStore } from "../IntercomStore";
import type { TicketStore } from "../../bot/TicketStore";
import type { SessionStore } from "../../auth/SessionStore";
import type { StripeClient } from "../../bot/StripeClient";
import type { BillingActionService } from "../../bot/billing/actions/BillingActionService";
import type { PanelTokens } from "../panel/PanelTokens";
import type { PanelSessions } from "../panel/PanelSessions";
import type { ForwardedEmailConverter, ForwardPreview } from "../ForwardedEmailConverter";

// The canvas forward tools: level gate enforced in submit() (component ids are
// client-supplied), input override passthrough, and the three render states of
// the unbridged card.

interface HarnessOpts {
  level?: "none" | "admin" | "all";
  actorIsAdmin?: boolean;
  preview?: Partial<ForwardPreview>;
}

interface Harness {
  app: IntercomInboxApp;
  convertCalls: Array<{ conversationId: string; overrideEmail: string | null; actorLabel: string }>;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const convertCalls: Harness["convertCalls"] = [];
  const settings = {
    forwardConvertActionLevel: () => opts.level ?? "admin",
    isIntercomPanelAdmin: () => opts.actorIsAdmin ?? false,
  } as unknown as SettingsStore;
  const preview: ForwardPreview = {
    converted: null,
    isConvertedNew: false,
    forwarderEmail: "nevo@postiz.com",
    forwarderLiteSeat: true,
    detected: { email: "jane@example.com", name: "Jane" },
    parseReason: null,
    agentEngaged: false,
    open: true,
    ...opts.preview,
  };
  const converter = {
    preview: async () => preview,
    convertManual: async (conversationId: string, input: { overrideEmail?: string | null; actorLabel: string }) => {
      convertCalls.push({ conversationId, overrideEmail: input.overrideEmail ?? null, actorLabel: input.actorLabel });
      return { kind: "converted", newConversationId: "new-1", customerEmail: input.overrideEmail ?? "jane@example.com", already: false };
    },
  } as unknown as ForwardedEmailConverter;
  const app = new IntercomInboxApp(
    settings,
    { getLinkByConversationId: async () => null } as unknown as IntercomStore,
    {} as unknown as TicketStore,
    {} as unknown as SessionStore,
    {} as unknown as StripeClient,
    () => null,
    {} as unknown as BillingActionService,
    {} as unknown as PanelTokens,
    {} as unknown as PanelSessions,
    converter
  );
  return { app, convertCalls };
}

const submitBody = (inputEmail?: string) => ({
  component_id: "fwd_convert",
  conversation: { id: "c1" },
  admin: { id: "77", name: "Clicker" },
  ...(inputEmail !== undefined ? { input_values: { fwd_email: inputEmail } } : {}),
});

test("level none refuses everyone, even panel admins", async () => {
  const h = makeHarness({ level: "none", actorIsAdmin: true });
  const res = JSON.stringify(await h.app.submit(submitBody()));
  assert.match(res, /not allowed/);
  assert.equal(h.convertCalls.length, 0);
});

test("level admin refuses non-admin clickers", async () => {
  const h = makeHarness({ level: "admin", actorIsAdmin: false });
  const res = JSON.stringify(await h.app.submit(submitBody()));
  assert.match(res, /not allowed/);
  assert.equal(h.convertCalls.length, 0);
});

test("level admin lets a panel admin convert, passing the typed override through", async () => {
  const h = makeHarness({ level: "admin", actorIsAdmin: true });
  const res = JSON.stringify(await h.app.submit(submitBody("  typed@example.com ")));
  assert.match(res, /Created conversation new-1/);
  assert.deepEqual(h.convertCalls, [{ conversationId: "c1", overrideEmail: "typed@example.com", actorLabel: "Clicker" }]);
});

test("level all lets any teammate convert with the detected sender (blank input)", async () => {
  const h = makeHarness({ level: "all", actorIsAdmin: false });
  const res = JSON.stringify(await h.app.submit(submitBody("")));
  assert.match(res, /Created conversation new-1/);
  assert.deepEqual(h.convertCalls[0], { conversationId: "c1", overrideEmail: null, actorLabel: "Clicker" });
});

test("unbridged initialize renders the forward tools with detection and the convert button", async () => {
  const h = makeHarness();
  const res = JSON.stringify(await h.app.initialize({ conversation: { id: "c1" } }));
  assert.match(res, /Forwarded-email tools/);
  assert.match(res, /jane@example\.com/);
  assert.match(res, /fwd_convert/);
  assert.match(res, /lite seat/);
});

test("converted and recreated conversations render their terminal states without the button", async () => {
  const done = makeHarness({ preview: { converted: { newConversationId: "new-9", customerEmail: "jane@example.com" } } });
  const doneRes = JSON.stringify(await done.app.initialize({ conversation: { id: "orig-9" } }));
  assert.match(doneRes, /Converted for/);
  assert.match(doneRes, /new-9/);
  assert.ok(!doneRes.includes("fwd_convert"));

  const recreated = makeHarness({ preview: { isConvertedNew: true } });
  const recreatedRes = JSON.stringify(await recreated.app.initialize({ conversation: { id: "new-9" } }));
  assert.match(recreatedRes, /created from a forwarded email/);
  assert.ok(!recreatedRes.includes("fwd_convert"));
});
