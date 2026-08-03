import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseWhatsApp } from "./doctor";

test("doctor rejects a read-only Redis token", async () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.startsWith("https://redis.example.com")) return originalFetch(request);
    const body = await request.json() as string[] | string[][];
    const commands = Array.isArray(body[0]) ? body as string[][] : [body as string[]];
    const results = commands.map((command) => String(command[0]).toLowerCase() === "set"
      ? { error: "ERR read only token" }
      : { result: String(command[0]).toLowerCase() === "ping" ? "PONG" : null });
    return Response.json(Array.isArray(body[0]) ? results : results[0]);
  }) as typeof fetch;

  try {
    const result = await diagnoseWhatsApp();
    assert.equal(result.ok, false);
    assert.equal(result.redis, "read_only", JSON.stringify(result));
    assert.equal(result.guidance.some((item) => item.code === "SESSION_STORAGE_READ_ONLY"), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  }
});
