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

// The inbound-creation gate: a successful forward conversion must swallow the
// event BEFORE the balancer and native SLA touch the (now closed) original;
// everything else flows the pre-existing path untouched.

interface Harness {
  handler: IntercomWebhookHandler;
  ops: string[];
  setConverter: (outcome: "converted" | "skipped") => void;
}

function makeHarness(link: object | null = null): Harness {
  const ops: string[] = [];
  const handler = new IntercomWebhookHandler(
    {} as unknown as SettingsStore,
    {} as unknown as TicketStore,
    {} as unknown as StatusService,
    { getLinkByConversationId: async () => link } as unknown as IntercomStore,
    {} as unknown as IntercomSyncService,
    {} as unknown as AuditLogger,
    {} as unknown as IntercomClient
  );
  handler.setAssignmentService({
    async maybeAssignOnCreate(conversationId, teamId) {
      ops.push(`assign.create:${conversationId}:${teamId}`);
    },
    async maybeReassignOnCustomerReply(conversationId) {
      ops.push(`assign.reply:${conversationId}`);
    },
  });
  handler.setSlaService({
    async applyForNative(conversationId, reason) {
      ops.push(`sla:${conversationId}:${reason}`);
    },
    async onTicketTrigger() {
      ops.push("sla.ticket");
    },
  });
  return {
    handler,
    ops,
    setConverter: (outcome) => {
      handler.setForwardedEmailConverter({
        async maybeConvertOnCreate(conversationId) {
          ops.push(`convert:${conversationId}:${outcome}`);
          return outcome;
        },
      });
    },
  };
}

const createdEvent = { data: { item: { id: "c1", team_assignee_id: 7, source: { subject: "Fwd: x" } } } };

test("converted original: balancer and SLA are skipped", async () => {
  const h = makeHarness();
  h.setConverter("converted");
  await h.handler.process("conversation.user.created", createdEvent, 0);
  assert.deepEqual(h.ops, ["convert:c1:converted"]);
});

test("skipped conversion: the pre-existing create path runs untouched", async () => {
  const h = makeHarness();
  h.setConverter("skipped");
  await h.handler.process("conversation.user.created", createdEvent, 0);
  assert.deepEqual(h.ops, ["convert:c1:skipped", "assign.create:c1:7", "sla:c1:conversation.user.created"]);
});

test("no converter bound: identical to the pre-feature behavior", async () => {
  const h = makeHarness();
  await h.handler.process("conversation.user.created", createdEvent, 0);
  assert.deepEqual(h.ops, ["assign.create:c1:7", "sla:c1:conversation.user.created"]);
});

test("customer replies never enter the gate", async () => {
  const h = makeHarness();
  h.setConverter("converted");
  await h.handler.process("conversation.user.replied", { data: { item: { id: "c2" } } }, 0);
  assert.ok(!h.ops.some((o) => o.startsWith("convert:")));
  assert.deepEqual(h.ops, ["assign.reply:c2", "sla:c2:conversation.user.replied"]);
});

test("bridged conversations never enter the gate", async () => {
  const h = makeHarness({ ticketThreadId: "t1" });
  h.setConverter("converted");
  await h.handler.process("conversation.user.created", createdEvent, 0);
  assert.ok(!h.ops.some((o) => o.startsWith("convert:")));
});
