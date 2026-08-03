import assert from "node:assert/strict";
import test from "node:test";
import { createBrokerPairingSession, normalizePairingPhoneNumber, pairingBrokerFromEnv } from "./pair";
import { PAIRING_QR_TTL_MS } from "./pairing/constants";

test("pairing broker configuration requires both URL and secret", () => {
  const originalUrl = process.env.PAIRING_BROKER_URL;
  const originalSecret = process.env.PAIRING_BROKER_SECRET;
  try {
    delete process.env.PAIRING_BROKER_URL;
    delete process.env.PAIRING_BROKER_SECRET;
    assert.equal(pairingBrokerFromEnv(), undefined);

    process.env.PAIRING_BROKER_URL = "https://pair.example.com";
    assert.throws(pairingBrokerFromEnv, /must be configured together/);

    process.env.PAIRING_BROKER_SECRET = "secret";
    assert.deepEqual(pairingBrokerFromEnv(), { url: "https://pair.example.com", secret: "secret" });
  } finally {
    if (originalUrl === undefined) delete process.env.PAIRING_BROKER_URL;
    else process.env.PAIRING_BROKER_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.PAIRING_BROKER_SECRET;
    else process.env.PAIRING_BROKER_SECRET = originalSecret;
  }
});

test("creates a reusable private broker session for GitHub Actions", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), init };
    return Response.json({ id: "session-id", shareUrl: "https://pair.example.com/pair/session-id#token=private" });
  }) as typeof fetch;

  try {
    const result = await createBrokerPairingSession({ url: "https://pair.example.com/", secret: "broker-secret" });
    assert.deepEqual(result, {
      id: "session-id",
      shareUrl: "https://pair.example.com/pair/session-id#token=private",
    });
    assert.equal(request?.url, "https://pair.example.com/api/pairing");
    assert.equal(request?.init?.method, "POST");
    assert.equal((request?.init?.headers as Record<string, string>).Authorization, "Bearer broker-secret");
    assert.equal(request?.init?.body, JSON.stringify({ operation: "create" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps a QR visible for its full native validity window", () => {
  assert.equal(PAIRING_QR_TTL_MS, 60_000);
});

test("normalizes international phone numbers for one-time-code pairing", () => {
  assert.equal(normalizePairingPhoneNumber("+1 (555) 123-4567"), "15551234567");
  assert.throws(() => normalizePairingPhoneNumber("055-1234"), /country code/);
});
