import assert from "node:assert/strict";
import test from "node:test";
import { pairingBrokerFromEnv } from "./pair";

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
