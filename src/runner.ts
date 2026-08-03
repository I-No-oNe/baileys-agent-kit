import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { actionSchema } from "./actions";
import { connectWhatsApp } from "./client";
import { requiredEnv } from "./env";
import { executeAction, MessageWaitTimeoutError } from "./execute";
import { RiskGuard } from "./risk-guard";

const LOCK_TTL_SECONDS = 10 * 60;

export async function runAgentAction(input: unknown, accountId = process.env.WA_ACCOUNT_ID ?? "default") {
  const action = actionSchema.parse(input);
  const store = new Redis({
    url: requiredEnv("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"),
    token: requiredEnv("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"),
  });
  const lockKey = `baileys_agent:${accountId}:lock`;
  const lockToken = randomUUID();
  const acquired = await store.set(lockKey, lockToken, { nx: true, ex: LOCK_TTL_SECONDS });
  if (!acquired) throw new Error(`Another WhatsApp action is running for account '${accountId}'.`);

  const riskGuard = new RiskGuard(store, accountId);
  let close: (() => Promise<void>) | undefined;
  let reserved = false;
  try {
    await riskGuard.reserve(action);
    reserved = true;
    const connection = await connectWhatsApp({
      accountId,
      ...(action.action === "list_recent_accounts"
        ? { prefetchRecentAccountsMs: (action.prefetchSeconds ?? 5) * 1_000 }
        : {}),
    });
    close = connection.close;
    const result = await executeAction(connection.socket, action, { recentAccounts: connection.recentAccounts });
    await riskGuard.recordSuccess();
    return result;
  } catch (error) {
    if (reserved && !(error instanceof MessageWaitTimeoutError)) {
      await riskGuard.recordFailure().catch(() => undefined);
    }
    throw error;
  } finally {
    if (close) await close().catch(() => undefined);
    await store.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      [lockKey],
      [lockToken],
    ).catch(() => undefined);
  }
}
