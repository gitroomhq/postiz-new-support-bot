import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsStore } from "../SettingsStore";

function harness() {
  let row = { assignRotationCursorsJson: {} as Record<string, string> };
  let fail = false;
  const store = new SettingsStore({ botSettings: {
    update: async ({ data }: { data: { assignRotationCursorsJson: Record<string, string> } }) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (fail) throw new Error("database unavailable");
      row = { ...row, ...data };
      return row;
    },
  } } as never);
  Object.assign(store, { settings: row });
  return { store, setFail: (value: boolean) => { fail = value; } };
}

test("concurrent team rotation writes preserve all cursors", async () => {
  const { store } = harness();
  await Promise.all([store.setTeamRotationCursor("one", "a"), store.setTeamRotationCursor("two", "b")]);
  assert.equal(store.teamRotationCursor("one"), "a");
  assert.equal(store.teamRotationCursor("two"), "b");
  await Promise.all([store.setTeamRotationCursor("one", null), store.setTeamRotationCursor("two", "c")]);
  assert.equal(store.teamRotationCursor("one"), null);
  assert.equal(store.teamRotationCursor("two"), "c");
});

test("a failed cursor write does not block later teams", async () => {
  const h = harness(); h.setFail(true);
  await assert.rejects(h.store.setTeamRotationCursor("one", "a"), /database unavailable/);
  h.setFail(false);
  await h.store.setTeamRotationCursor("two", "b");
  assert.equal(h.store.teamRotationCursor("two"), "b");
});
