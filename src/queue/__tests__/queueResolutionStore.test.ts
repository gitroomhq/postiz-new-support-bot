import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueResolutionStore, type QueueResolutionDb } from "../QueueResolutionStore";

// queue_resolutions: the tickets marked resolved on the queue, read once at
// boot and written on every resolve and restore.

function fakeDb() {
  const calls: Array<{ op: string; args: unknown }> = [];
  const db = {
    queueResolution: {
      findMany: async (args: unknown) => {
        calls.push({ op: "findMany", args });
        return [
          {
            conversationId: "215476423871073",
            untilReply: true,
            lastContactAt: 1792360560,
            note: null,
            title: "FarmerGrant · Report a Bug",
            ticketNumber: "146041426",
            customer: "FarmerGrant",
            resolvedById: "11070466",
            resolvedByName: "Gilad Resisi",
            resolvedAt: new Date(1_792_391_206_000),
          },
        ];
      },
      upsert: async (args: unknown) => {
        calls.push({ op: "upsert", args });
      },
      deleteMany: async (args: unknown) => {
        calls.push({ op: "deleteMany", args });
      },
    },
  };
  return { db: db as unknown as QueueResolutionDb, calls };
}

test("list reads the newest first and turns the time into ms", async () => {
  const { db, calls } = fakeDb();
  const rows = await new QueueResolutionStore(db).list();
  assert.equal(rows[0].resolvedAt, 1_792_391_206_000);
  assert.equal(rows[0].ticketNumber, "146041426");
  assert.deepEqual((calls[0].args as { orderBy: unknown }).orderBy, { resolvedAt: "desc" });
});

test("put upserts by conversation; remove deletes the given ones and skips an empty list", async () => {
  const { db, calls } = fakeDb();
  const store = new QueueResolutionStore(db);
  const [row] = await store.list();
  await store.put({ ...row, note: "tracked as a bug" });
  const upsert = calls[1].args as { where: unknown; create: { resolvedAt: Date; note: string; untilReply: boolean }; update: { note: string } };
  assert.deepEqual(upsert.where, { conversationId: "215476423871073" });
  assert.equal(upsert.create.untilReply, false, "every mark holds until restored");
  assert.equal(upsert.create.resolvedAt.getTime(), 1_792_391_206_000);
  assert.equal(upsert.update.note, "tracked as a bug");
  await store.remove([]);
  assert.equal(calls.length, 2);
  await store.remove(["1", "2"]);
  assert.deepEqual(calls[2], { op: "deleteMany", args: { where: { conversationId: { in: ["1", "2"] } } } });
});
