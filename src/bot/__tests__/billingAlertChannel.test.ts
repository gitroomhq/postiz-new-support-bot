import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { billingAlertChannel } from "../billing/billingAlertChannel";

// Billing alerts (dispute alerts, auto-resolve proposals) post to the
// billing-audit channel, else the audit log. A billing-audit channel that is
// set but unusable used to drop the alert silently, and an auto-resolve
// proposal without a posted alert never refunds.

function fakeClient(channels: Record<string, { sendable: boolean } | undefined>): Client {
  return {
    channels: {
      fetch: async (id: string) => {
        const c = channels[id];
        if (!c) throw new Error("Unknown Channel");
        return { id, isSendable: () => c.sendable };
      },
    },
  } as unknown as Client;
}

test("the billing-audit channel when it works", async () => {
  const client = fakeClient({ billing: { sendable: true }, audit: { sendable: true } });
  const target = await billingAlertChannel(client, { billingAuditChannelId: "billing", auditLogChannelId: "audit" });
  assert.equal(target?.channelId, "billing");
});

test("a deleted or hidden billing-audit channel falls back to the audit log", async () => {
  const client = fakeClient({ audit: { sendable: true } });
  const target = await billingAlertChannel(client, { billingAuditChannelId: "gone", auditLogChannelId: "audit" });
  assert.equal(target?.channelId, "audit");
});

test("a billing-audit channel that is no text channel (a forum, a category) falls back too", async () => {
  const client = fakeClient({ forum: { sendable: false }, audit: { sendable: true } });
  const target = await billingAlertChannel(client, { billingAuditChannelId: "forum", auditLogChannelId: "audit" });
  assert.equal(target?.channelId, "audit");
});

test("unset billing-audit uses the audit log; nothing usable, no client: no channel", async () => {
  const client = fakeClient({ audit: { sendable: true } });
  assert.equal((await billingAlertChannel(client, { billingAuditChannelId: null, auditLogChannelId: "audit" }))?.channelId, "audit");
  assert.equal(await billingAlertChannel(client, { billingAuditChannelId: "gone", auditLogChannelId: null }), null);
  assert.equal(await billingAlertChannel(null, { billingAuditChannelId: "audit", auditLogChannelId: "audit" }), null);
});
