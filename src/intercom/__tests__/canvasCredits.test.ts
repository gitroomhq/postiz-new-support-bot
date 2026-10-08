import { test } from "node:test";
import assert from "node:assert/strict";
import { IntercomInboxApp } from "../IntercomInboxApp";
import { PostizCreditService } from "../../postiz/PostizCreditService";
import type { PostizAccount, PostizClient } from "../../postiz/PostizClient";
import type { PostizCreditResetLedger, PostizCreditResetRow } from "../../postiz/PostizCreditResetStore";
import type { SettingsStore } from "../../config/SettingsStore";

// The AI credit reset in the sidebar's Postiz view: the field starts with who
// the conversation is, any teammate can point it elsewhere, and the confirm
// step names the organization the server resolved before anything resets.

type Component = { type: string; id?: string; text?: string; value?: string; label?: string };

const account = (over: Partial<PostizAccount> = {}): PostizAccount =>
  ({
    membershipId: "uo_1",
    userId: "usr_1",
    name: "Jamie",
    email: "jamie@example.com",
    orgId: "org_1",
    orgName: "Acme",
    role: "ADMIN",
    tier: "PRO",
    orgDeletedAt: null,
    userDeletedAt: null,
    ...over,
  }) as PostizAccount;

function harness(opts: { enabled?: boolean; directory?: Record<string, PostizAccount[]>; prior?: PostizCreditResetRow } = {}) {
  const notes: Array<{ conversationId: string; text: string }> = [];
  const resets: Array<{ orgId: string; type: string }> = [];
  const rows: PostizCreditResetRow[] = opts.prior ? [opts.prior] : [];
  const directory = opts.directory ?? {
    "jamie@example.com": [account()],
    "other@example.com": [account({ email: "other@example.com", orgId: "org_9", orgName: "Globex", userId: "usr_9" })],
  };
  const client = {
    searchUsers: async (term: string) => {
      const accounts = directory[term.toLowerCase()] ?? [];
      return { accounts, capped: false, matched: accounts.length };
    },
    resetCredits: async (orgId: string, type: string) => {
      resets.push({ orgId, type });
      return { deleted: 14 };
    },
  } as unknown as PostizClient;
  const ledger: PostizCreditResetLedger = {
    record: async (row) => void rows.push({ ...row, createdAt: new Date() }),
    last: async (orgId, type) => [...rows].reverse().find((r) => r.orgId === orgId && r.creditType === type) ?? null,
  };
  const credits = new PostizCreditService(
    client,
    { postizLookupEnabled: () => opts.enabled ?? true, postizConfigured: () => true } as unknown as SettingsStore,
    ledger,
    null
  );
  const app = new IntercomInboxApp(
    { isIntercomPanelAdmin: () => false, intercomClientSecret: () => "s" } as never,
    { getLinkByConversationId: async () => null } as never,
    {} as never,
    {} as never,
    { findCustomersByEmail: async () => [] } as never,
    () => null,
    { pendingForConversation: async () => [] } as never,
    { getConversationContact: async () => ({ email: "jamie@example.com", name: "Jamie", contactId: "c_1" }) } as never,
    { resolve: async () => account() } as never,
    null,
    async (conversationId: string, text: string) => void notes.push({ conversationId, text }),
    null,
    credits
  );
  const press = async (componentId: string, inputs: Record<string, string> = {}): Promise<Component[]> => {
    const out = (await app.submit({
      conversation: { id: 99 },
      admin: { id: 7, name: "Sam" },
      component_id: componentId,
      input_values: inputs,
    })) as { canvas: { content: { components: Component[] } } };
    return out.canvas.content.components;
  };
  return { press, notes, resets, rows };
}

const texts = (c: Component[]) => c.map((x) => x.text ?? "");
const ids = (c: Component[]) => c.map((x) => x.id).filter(Boolean);
const field = (c: Component[]) => c.find((x) => x.id === "credits_email");

test("the Postiz view offers both resets with the conversation's email prefilled", async () => {
  const view = await harness().press("nav:postiz");
  assert.equal(field(view)?.value, "jamie@example.com");
  assert.ok(ids(view).includes("credits_ask:ai_images"));
  assert.ok(ids(view).includes("credits_ask:ai_videos"));
});

test("with the Postiz lookup off the section is not rendered", async () => {
  const view = await harness({ enabled: false }).press("nav:postiz");
  assert.equal(field(view), undefined);
  assert.ok(!ids(view).some((id) => id?.startsWith("credits_")));
});

test("asking names the organization the server resolved, and resets nothing yet", async () => {
  const h = harness();
  const view = await h.press("credits_ask:ai_images", { credits_email: "jamie@example.com" });
  assert.ok(texts(view).some((t) => t.includes("Reset AI image credits for Acme (org_1)?")));
  assert.ok(texts(view).some((t) => t.includes("No earlier AI image credit reset")));
  assert.ok(ids(view).includes("credits_do:ai_images:org_1"));
  assert.equal(h.resets.length, 0);
});

test("a typed address targets its own organization, not the conversation's", async () => {
  const h = harness();
  const view = await h.press("credits_ask:ai_videos", { credits_email: "other@example.com" });
  assert.equal(field(view)?.value, "other@example.com");
  assert.ok(ids(view).includes("credits_do:ai_videos:org_9"));
});

test("confirming resets, reports what came back and leaves a note", async () => {
  const h = harness();
  const view = await h.press("credits_do:ai_images:org_1", { credits_email: "jamie@example.com" });
  assert.deepEqual(h.resets, [{ orgId: "org_1", type: "ai_images" }]);
  assert.ok(texts(view).some((t) => t.startsWith("✅") && t.includes("14 credits restored")));
  assert.equal(h.rows.length, 1);
  // The note is chained to the reset, so give it a tick.
  await new Promise((r) => setImmediate(r));
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0].text, /Sam reset the AI image credits of Acme \(org_1\)/);
});

test("a forged or stale organization id resets nothing", async () => {
  const h = harness();
  const view = await h.press("credits_do:ai_images:org_9", { credits_email: "jamie@example.com" });
  assert.equal(h.resets.length, 0);
  assert.ok(texts(view).some((t) => t.startsWith("⚠️") && t.includes("no longer resolves")));
});

test("an address in two organizations is refused before the confirm step", async () => {
  const h = harness({ directory: { "jamie@example.com": [account(), account({ orgId: "org_2" })] } });
  const view = await h.press("credits_ask:ai_images", { credits_email: "jamie@example.com" });
  assert.ok(texts(view).some((t) => t.includes("belongs to 2 organizations")));
  assert.ok(!ids(view).some((id) => id?.startsWith("credits_do:")));
});

test("a recent reset of the same kind is called out on the confirm step", async () => {
  const prior: PostizCreditResetRow = {
    orgId: "org_1",
    orgName: "Acme",
    creditType: "ai_images",
    email: "jamie@example.com",
    restored: 20,
    actorId: "3",
    actorName: "Alex",
    conversationId: "12",
    createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
  };
  const view = await harness({ prior }).press("credits_ask:ai_images", { credits_email: "jamie@example.com" });
  assert.ok(texts(view).some((t) => t.startsWith("⚠️ Last reset 9 days ago") && t.includes("by Alex: 20 credits restored")));
});

test("cancel goes back to the buttons and keeps what was typed", async () => {
  const view = await harness().press("credits_cancel", { credits_email: "other@example.com" });
  assert.equal(field(view)?.value, "other@example.com");
  assert.ok(ids(view).includes("credits_ask:ai_images"));
});
