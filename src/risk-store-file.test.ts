import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RiskGuard, type RiskConfig } from "./risk-guard";
import { FileRiskStore } from "./risk-store-file";

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

test("persists local send limits and circuit state across processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baileys-agent-risk-"));
  const original = process.env.WA_STATE_DIR;
  process.env.WA_STATE_DIR = directory;
  try {
    const action = { action: "send_text", to: "+15551234567", text: "Hello" } as const;
    const first = new RiskGuard(await FileRiskStore.create("test-account"), "test-account", config);
    await first.reserve(action);

    const second = new RiskGuard(await FileRiskStore.create("test-account"), "test-account", config);
    await assert.rejects(second.reserve(action), /limit reached for/);
    await second.recordFailure();
    await second.recordFailure();

    const third = new RiskGuard(await FileRiskStore.create("test-account"), "test-account", config);
    await assert.rejects(third.reserve({ action: "list_groups" }), /safety circuit is open/);
  } finally {
    if (original === undefined) delete process.env.WA_STATE_DIR;
    else process.env.WA_STATE_DIR = original;
    await rm(directory, { recursive: true, force: true });
  }
});
