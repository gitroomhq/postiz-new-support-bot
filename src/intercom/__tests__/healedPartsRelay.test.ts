import { test } from "node:test";
import assert from "node:assert/strict";
import { IntercomWebhookHandler } from "../IntercomWebhookHandler";
import type { SettingsStore } from "../../config/SettingsStore";
import type { TicketStore } from "../../bot/TicketStore";
import type { StatusService } from "../../bot/StatusService";
import type { IntercomStore } from "../IntercomStore";
import type { IntercomSyncService } from "../IntercomSyncService";
import type { AuditLogger } from "../../bot/AuditLogger";
import type { IntercomClient } from "../IntercomClient";

// The full-history heal outlives the 14-day part claims: a part the message
// map already knows (relayed in, or created from Discord) must never be fed
// through the relay again.

test("heal: mapped parts are skipped, unmapped agent replies go through the relay path", async () => {
  const handler = new IntercomWebhookHandler(
    { intercomMode: () => "bi" } as unknown as SettingsStore,
    {} as unknown as TicketStore,
    {} as unknown as StatusService,
    { getMessageMapByPartId: async (id: string) => (id === "old" ? { id: "m1" } : null) } as unknown as IntercomStore,
    {} as unknown as IntercomSyncService,
    {} as unknown as AuditLogger,
    {} as unknown as IntercomClient
  );
  const fed: string[] = [];
  (handler as unknown as { processAgentPart: (k: string, t: string, p: { id: string }) => Promise<void> }).processAgentPart =
    async (_kind, _thread, part) => void fed.push(part.id);
  const reply = (id: string) => ({ id, part_type: "comment", author: { type: "admin" }, body: "<p>hi</p>" });
  const n = await handler.relayHealedParts("t1", [reply("old"), reply("new"), { id: "n1", part_type: "note", author: { type: "admin" } }] as never);
  assert.equal(n, 1);
  assert.deepEqual(fed, ["new"]);
});
