import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileAuthState } from "./file";
import { localStatePath } from "../local-files";

test("persists credentials and binary Signal keys with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baileys-agent-auth-"));
  const original = process.env.WA_STATE_DIR;
  process.env.WA_STATE_DIR = directory;
  try {
    const first = await createFileAuthState("test-account");
    first.state.creds.registered = true;
    await first.state.keys.set({ session: { contact: { nested: Buffer.from("signal-key") } as never } });
    await first.saveCreds();

    const second = await createFileAuthState("test-account");
    assert.equal(second.state.creds.registered, true);
    const restored = await second.state.keys.get("session", ["contact"]);
    assert.deepEqual((restored.contact as unknown as { nested: Buffer }).nested, Buffer.from("signal-key"));

    await second.state.keys.set({ session: { contact: null } });
    const third = await createFileAuthState("test-account");
    assert.deepEqual(await third.state.keys.get("session", ["contact"]), {});

    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(localStatePath("test-account", "auth.json"))).mode & 0o777, 0o600);
    }
  } finally {
    if (original === undefined) delete process.env.WA_STATE_DIR;
    else process.env.WA_STATE_DIR = original;
    await rm(directory, { recursive: true, force: true });
  }
});
