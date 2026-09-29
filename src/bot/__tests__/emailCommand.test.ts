import { test } from "node:test";
import assert from "node:assert/strict";
import { EMAIL_COMMAND, EmailCommand } from "../EmailCommand";

// /email is visible to everyone who can see the channel, so registration is
// not the gate: the runtime check is, on the command and on every button.

function commandInteraction(address: string) {
  const replies: unknown[] = [];
  return {
    replies,
    interaction: {
      user: { id: "u1", username: "sam" },
      options: { getString: () => address },
      reply: async (p: unknown) => void replies.push(p),
      deferReply: async () => {},
      editReply: async (p: unknown) => void replies.push(p),
    },
  };
}

function command(opts: { allowed: boolean }) {
  const looked: string[] = [];
  const removed: string[] = [];
  const delivery = {
    enabled: () => true,
    statusOf: async (email: string) => {
      looked.push(email);
      return {
        email,
        state: "suppressed" as const,
        suppression: { id: "s", email, origin: "bounce", sourceId: null, createdAt: new Date("2026-09-12T00:00:00Z") },
        source: null,
      };
    },
    remove: async (email: string) => {
      removed.push(email);
      return { kind: "removed" as const, previous: null };
    },
  };
  const cmd = new EmailCommand(
    () => delivery as never,
    () => null,
    async () => opts.allowed
  );
  return { cmd, looked, removed };
}

test("/email: registered without default permissions; the address is optional (no address = the hub)", () => {
  assert.equal(EMAIL_COMMAND.name, "email");
  assert.ok(!("default_member_permissions" in EMAIL_COMMAND), "the support role must be able to see it");
  assert.equal(EMAIL_COMMAND.options[0].required, false);
});

test("/email: a refused invoker gets nothing looked up", async () => {
  const { cmd, looked } = command({ allowed: false });
  const { interaction } = commandInteraction("x@example.com");
  await cmd.handleCommand(interaction as never);
  assert.deepEqual(looked, []);
});

test("/email: buttons are bound to the user who ran it and re-check the gate", async () => {
  const allowed = command({ allowed: true });
  const { interaction, replies } = commandInteraction("gone@example.com");
  await allowed.cmd.handleCommand(interaction as never);
  const panel = replies.at(-1) as { components: Array<{ components: Array<{ data: { custom_id: string } }> }> };
  const removeId = panel.components[0].components[0].data.custom_id;
  assert.match(removeId, /^emailcmd_rm:/);
  assert.ok(!removeId.includes("gone@example.com"), "the address is not in the custom id");

  // Someone else pressing it: expired, nothing removed.
  const stranger = { customId: removeId.replace("rm:", "rmx:"), user: { id: "u2", username: "eve" }, replies: [] as unknown[] };
  await allowed.cmd.handleButton({
    ...stranger,
    reply: async (p: unknown) => void stranger.replies.push(p),
    deferUpdate: async () => {},
    editReply: async () => {},
  } as never);
  assert.deepEqual(allowed.removed, []);

  // The owner, but the gate now says no (role removed mid-flight): nothing either.
  const refused = command({ allowed: false });
  await refused.cmd.handleButton({ customId: removeId.replace("rm:", "rmx:"), user: { id: "u1" } } as never);
  assert.deepEqual(refused.removed, []);

  // The owner, allowed: removed.
  const edits: unknown[] = [];
  await allowed.cmd.handleButton({
    customId: removeId.replace("rm:", "rmx:"),
    user: { id: "u1", username: "sam" },
    reply: async () => {},
    deferUpdate: async () => {},
    editReply: async (p: unknown) => void edits.push(p),
  } as never);
  assert.deepEqual(allowed.removed, ["gone@example.com"]);
});

test("/email: the suppression list, batch removal and share links are Administrator-only on every press", async () => {
  let scans = 0;
  let shares = 0;
  const delivery = {
    enabled: () => true,
    scanSuppressions: async () => {
      scans++;
      return { matches: [], scanned: 0, truncated: false };
    },
  };
  const log = { webhookRegistered: () => true, share: async () => (shares++, { ok: true, url: "https://x" }) };
  let admin = false;
  const cmd = new EmailCommand(
    () => delivery as never,
    () => null,
    async () => true,
    () => log as never,
    () => admin
  );
  const { interaction, replies } = commandInteraction("");
  await cmd.handleCommand(interaction as never);
  const hub = replies.at(-1) as { components: Array<{ components: Array<{ data: { custom_id: string } }> }> };
  const hubIds = hub.components.flatMap((r) => r.components.map((c) => c.data.custom_id));
  assert.equal(hubIds.length, 1, "a non-admin hub offers only the lookup");
  const token = hubIds[0].split(":")[1];

  const pressed: unknown[] = [];
  const press = (customId: string) =>
    cmd.handleButton({
      customId,
      user: { id: "u1", username: "sam" },
      reply: async (p: unknown) => void pressed.push(p),
      deferUpdate: async () => {},
      deferReply: async () => {},
      editReply: async (p: unknown) => void pressed.push(p),
      showModal: async () => void pressed.push("modal"),
    } as never);

  // Hand-crafted ids from a non-admin do nothing.
  await press(`emailcmd_list:${token}`);
  await press(`emailcmd_share:${token}`);
  await press(`emailcmd_bconfirm:${token}`);
  await press(`emailcmd_filter:${token}`);
  assert.equal(scans, 0);
  assert.equal(shares, 0);
  assert.ok(!pressed.includes("modal"), "no admin modal opens");

  // An admin gets the list.
  admin = true;
  await press(`emailcmd_list:${token}`);
  assert.equal(scans, 1);
});
