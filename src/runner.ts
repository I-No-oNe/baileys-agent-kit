import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { actionSchema } from "./actions";
import { storageBackendFromEnv } from "./auth";
import { connectWhatsApp } from "./client";
import { requiredEnv } from "./env";
import { executeAction, MessageWaitTimeoutError } from "./execute";
import { acquireLocalAccountLock } from "./local-files";
import { RiskGuard, isSendAction, type RiskStore } from "./risk-guard";
import { FileRiskStore } from "./risk-store-file";

const LOCK_TTL_SECONDS = 10 * 60;

export async function runAgentAction(
  input: unknown,
  accountId = process.env.WA_ACCOUNT_ID ?? "default",
  options: { afterReserve?: () => Promise<void> } = {},
) {
  const action = actionSchema.parse(input);
  const backend = storageBackendFromEnv();
  let store: RiskStore;
  let redis: Redis | undefined;
  let lockKey: string | undefined;
  let lockToken: string | undefined;
  let releaseLocalLock: (() => Promise<void>) | undefined;
  if (backend === "upstash") {
    redis = new Redis({
      url: requiredEnv("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"),
      token: requiredEnv("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"),
    });
    store = redis;
    lockKey = `baileys_agent:${accountId}:lock`;
    lockToken = randomUUID();
    const acquired = await redis.set(lockKey, lockToken, { nx: true, ex: LOCK_TTL_SECONDS });
    if (!acquired) throw new Error(`Another WhatsApp action is running for account '${accountId}'.`);
  } else {
    releaseLocalLock = await acquireLocalAccountLock(accountId);
    store = await FileRiskStore.create(accountId);
  }

  const riskGuard = new RiskGuard(store, accountId);
  let close: (() => Promise<void>) | undefined;
  let reserved = false;
  try {
    await riskGuard.reserve(action);
    reserved = true;
    if (isSendAction(action)) await options.afterReserve?.();
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
    await releaseLocalLock?.().catch(() => undefined);
    if (redis && lockKey && lockToken) {
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        [lockKey],
        [lockToken],
      ).catch(() => undefined);
    }
  }
}
