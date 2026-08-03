import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLocalAccountLock, localStatePath } from "./local-files";

test("serializes local account access and blocks path traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baileys-agent-lock-"));
  const original = process.env.WA_STATE_DIR;
  process.env.WA_STATE_DIR = directory;
  try {
    assert.throws(() => localStatePath("../escape", "auth.json"), /unsupported characters/);
    const release = await acquireLocalAccountLock("test-account");
    await assert.rejects(acquireLocalAccountLock("test-account"), /Another WhatsApp action/);
    await release();
    const releaseAgain = await acquireLocalAccountLock("test-account");
    await releaseAgain();
  } finally {
    if (original === undefined) delete process.env.WA_STATE_DIR;
    else process.env.WA_STATE_DIR = original;
    await rm(directory, { recursive: true, force: true });
  }
});
