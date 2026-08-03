import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "@upstash/redis";
import type { AgentAction } from "./actions";
import { RiskGuard, riskConfigFromEnv, type RiskConfig } from "./risk-guard";

function memoryStore() {
  const values = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const store = {
    async get<T>(key: string) { return values.get(key) as T | null ?? null; },
    async set(key: string, value: unknown) { values.set(key, value); return "OK"; },
    async del(key: string) { return values.delete(key) ? 1 : 0; },
    async incr(key: string) { const value = Number(values.get(key) ?? 0) + 1; values.set(key, value); return value; },
    async expire() { return 1; },
    async sadd(key: string, member: string) { const set = sets.get(key) ?? new Set<string>(); const size = set.size; set.add(member); sets.set(key, set); return set.size - size; },
    async scard(key: string) { return sets.get(key)?.size ?? 0; },
    async sismember(key: string, member: string) { return sets.get(key)?.has(member) ?? false; },
  };

  type MemoryPipeline = {
    get<T>(key: string): MemoryPipeline;
    set(key: string, value: unknown, options?: unknown): MemoryPipeline;
    incr(key: string): MemoryPipeline;
    incrby(key: string, amount: number): MemoryPipeline;
    expire(key: string, seconds: number): MemoryPipeline;
    sadd(key: string, member: string): MemoryPipeline;
    scard(key: string): MemoryPipeline;
    sismember(key: string, member: string): MemoryPipeline;
    exec(): Promise<unknown[]>;
  };
  const createPipeline = () => {
    const commands: Array<() => Promise<unknown>> = [];
    const pipeline = {} as MemoryPipeline;
    pipeline.get = <T,>(key: string) => { commands.push(() => store.get<T>(key)); return pipeline; };
    pipeline.set = (key, value) => { commands.push(() => store.set(key, value)); return pipeline; };
    pipeline.incr = (key) => { commands.push(() => store.incr(key)); return pipeline; };
    pipeline.incrby = (key, amount) => { commands.push(async () => {
      const value = Number(values.get(key) ?? 0) + amount;
      values.set(key, value);
      return value;
    }); return pipeline; };
    pipeline.expire = (key) => { commands.push(() => store.expire()); return pipeline; };
    pipeline.sadd = (key, member) => { commands.push(() => store.sadd(key, member)); return pipeline; };
    pipeline.scard = (key) => { commands.push(() => store.scard(key)); return pipeline; };
    pipeline.sismember = (key, member) => { commands.push(() => store.sismember(key, member)); return pipeline; };
    pipeline.exec = () => Promise.all(commands.map((command) => command()));
    return pipeline;
  };

  return { ...store, pipeline: createPipeline } as unknown as Redis;
}

const config: RiskConfig = {
  maxSendsPerDay: 2,
  maxSendsPerRecipientPerDay: 1,
  maxUniqueRecipientsPerDay: 2,
  minimumSendIntervalMs: 0,
  failureThreshold: 2,
  circuitBreakerSeconds: 60,
  allowedRecipients: new Set(),
  groupAdminEnabled: false,
};

test("treats empty or whitespace send-limit environment values as unlimited", () => {
  const names = [
    "WA_MAX_SENDS_PER_DAY",
    "WA_MAX_SENDS_PER_RECIPIENT_PER_DAY",
    "WA_MAX_UNIQUE_RECIPIENTS_PER_DAY",
    "WA_MINIMUM_SEND_INTERVAL_MS",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  try {
    names.forEach((name, index) => { process.env[name] = index % 2 ? "   " : ""; });
    const parsed = riskConfigFromEnv();
    assert.equal(parsed.maxSendsPerDay, Infinity);
    assert.equal(parsed.maxSendsPerRecipientPerDay, Infinity);
    assert.equal(parsed.maxUniqueRecipientsPerDay, Infinity);
    assert.equal(parsed.minimumSendIntervalMs, 0);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("limits repeated sends to a recipient", async () => {
  const guard = new RiskGuard(memoryStore(), "default", config);
  const action = { action: "send_text", to: "+15551234567", text: "Hello" } as const;
  await guard.reserve(action);
  await assert.rejects(guard.reserve(action), /limit reached for/);
});

test("applies send limits to replies", async () => {
  const guard = new RiskGuard(memoryStore(), "replies", config);
  const action: AgentAction = {
    action: "reply_text",
    recipient: "+15551234567",
    messageId: "message-1",
    quotedText: "Original",
    text: "Reply",
  };
  await guard.reserve(action);
  await assert.rejects(guard.reserve(action), /limit reached for/);
});

test("counts each album item against send limits", async () => {
  const guard = new RiskGuard(memoryStore(), "albums", {
    ...config,
    maxSendsPerRecipientPerDay: 2,
  });
  const action: AgentAction = {
    action: "send_album",
    to: "+15551234567",
    items: [
      { type: "image", url: "https://example.com/one.jpg" },
      { type: "video", url: "https://example.com/two.mp4" },
    ],
  };
  await guard.reserve(action);
  await assert.rejects(guard.reserve(action), /Daily WhatsApp send limit/);
});

test("limits total and unique daily recipients", async () => {
  const uniqueGuard = new RiskGuard(memoryStore(), "unique", {
    ...config,
    maxSendsPerRecipientPerDay: 2,
    maxUniqueRecipientsPerDay: 1,
  });
  await uniqueGuard.reserve({ action: "send_text", to: "+15550000001", text: "Hello" });
  await assert.rejects(
    uniqueGuard.reserve({ action: "send_text", to: "+15550000002", text: "Hello" }),
    /unique-recipient limit/,
  );

  const dailyGuard = new RiskGuard(memoryStore(), "daily", {
    ...config,
    maxSendsPerRecipientPerDay: 2,
    maxUniqueRecipientsPerDay: 3,
  });
  await dailyGuard.reserve({ action: "send_text", to: "+15550000001", text: "One" });
  await dailyGuard.reserve({ action: "send_text", to: "+15550000002", text: "Two" });
  await assert.rejects(
    dailyGuard.reserve({ action: "send_text", to: "+15550000003", text: "Three" }),
    /Daily WhatsApp send limit/,
  );
});

test("blocks recipients outside an explicit allowlist", async () => {
  const guard = new RiskGuard(memoryStore(), "default", {
    ...config,
    allowedRecipients: new Set(["15550000000@s.whatsapp.net"]),
  });
  await assert.rejects(
    guard.reserve({ action: "send_text", to: "+15551234567", text: "Hello" }),
    /not in WA_ALLOWED_RECIPIENTS/,
  );
  await assert.rejects(
    guard.reserve({ action: "get_profile", number: "+15551234567" }),
    /not in WA_ALLOWED_RECIPIENTS/,
  );
});

test("opens a circuit after repeated failures", async () => {
  const guard = new RiskGuard(memoryStore(), "default", config);
  await guard.recordFailure();
  await guard.recordFailure();
  await assert.rejects(guard.reserve({ action: "list_groups" }), /safety circuit is open/);
});

test("requires explicit opt-in for group administration", async () => {
  const guard = new RiskGuard(memoryStore(), "default", config);
  await assert.rejects(
    guard.reserve({ action: "update_group_subject", group: "120363000000@g.us", subject: "New subject" }),
    /Group administration is disabled/,
  );
});
