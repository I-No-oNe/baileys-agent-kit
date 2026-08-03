import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/pairing/route";

test("returns structured JSON when pairing broker storage throws", async () => {
  const originalSecret = process.env.PAIRING_BROKER_SECRET;
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.PAIRING_BROKER_SECRET = "broker-secret";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    const response = await POST(new Request("https://pair.example.com/api/pairing", {
      method: "POST",
      headers: { Authorization: "Bearer broker-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "create" }),
    }));
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
    assert.equal(body.ok, false);
    assert.equal(body.code, "MISSING_CONFIGURATION");
    assert.equal(typeof body.likelyCause, "string");
    assert.equal(Array.isArray(body.nextSteps), true);
  } finally {
    if (originalSecret === undefined) delete process.env.PAIRING_BROKER_SECRET;
    else process.env.PAIRING_BROKER_SECRET = originalSecret;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
});
