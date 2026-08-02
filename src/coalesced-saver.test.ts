import assert from "node:assert/strict";
import test from "node:test";
import { createCoalescedSaver } from "./coalesced-saver";

test("coalesces repeated save requests while preserving the latest state", async () => {
  let saves = 0;
  let releaseFirstSave: (() => void) | undefined;
  const firstSave = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const saver = createCoalescedSaver(async () => {
    saves += 1;
    if (saves === 1) await firstSave;
  });

  saver.schedule();
  saver.schedule();
  saver.schedule();
  assert.equal(saves, 1);

  releaseFirstSave?.();
  await saver.flush();
  assert.equal(saves, 2);
});

test("flush is a no-op when no save was requested", async () => {
  let saves = 0;
  const saver = createCoalescedSaver(async () => { saves += 1; });
  await saver.flush();
  assert.equal(saves, 0);
});

test("flush reports a failed save", async () => {
  const saver = createCoalescedSaver(async () => { throw new Error("save failed"); });
  saver.schedule();
  await assert.rejects(saver.flush(), /save failed/);
});
