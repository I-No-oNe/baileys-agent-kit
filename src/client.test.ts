import assert from "node:assert/strict";
import test from "node:test";
import { initAuthCreds } from "@whiskeysockets/baileys";
import type { AuthStateFactory } from "./auth";
import { connectWhatsApp } from "./client";
import { pairWhatsApp } from "./pair";

const memoryState = (requested: string[]): AuthStateFactory => async (accountId) => {
  requested.push(accountId);
  return {
    state: { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => undefined } },
    saveCreds: async () => undefined,
  };
};

async function withBrokenEnvBackend(run: () => Promise<void>) {
  const previous = process.env.WA_STORAGE_BACKEND;
  process.env.WA_STORAGE_BACKEND = "not-a-backend";
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.WA_STORAGE_BACKEND;
    else process.env.WA_STORAGE_BACKEND = previous;
  }
}

test("connect uses an injected session store instead of the environment backend", async () => {
  const requested: string[] = [];
  await withBrokenEnvBackend(async () => {
    await assert.rejects(connectWhatsApp({ accountId: "office-1", authState: memoryState(requested) }), /not linked/);
  });
  assert.deepEqual(requested, ["office-1"]);
});

test("pairing that is already cancelled never opens the store", async () => {
  const requested: string[] = [];
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    pairWhatsApp({ accountId: "office-1", phoneNumber: "+15551234567", authState: memoryState(requested), signal: controller.signal }),
    /pairing was cancelled/,
  );
  assert.deepEqual(requested, []);
});

test("pairing cancelled before the socket opens stops without connecting", async () => {
  const requested: string[] = [];
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  // The protocol-version lookup is the last step before a socket opens; cancel during it.
  globalThis.fetch = (async () => {
    controller.abort();
    throw new TypeError("offline");
  }) as typeof fetch;
  try {
    await withBrokenEnvBackend(async () => {
      await assert.rejects(
        pairWhatsApp({ accountId: "office-1", phoneNumber: "+15551234567", authState: memoryState(requested), signal: controller.signal }),
        /pairing was cancelled/,
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requested, ["office-1"]);
});
