import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONNECTION_CONFIG, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { createAuthState, storageBackendFromEnv, type StorageBackend } from "./auth";
import { explainError, type ExplainedFailure } from "./explain-error";
import { localStateDirectory, probeLocalStateDirectory } from "./local-files";

export type DoctorResult = {
  ok: boolean;
  node: string;
  environment: Record<string, boolean>;
  redis: "ok" | "not_configured" | "unused" | "read_only" | "error";
  sessionStorage: {
    backend: StorageBackend;
    status: "ok" | "read_only" | "error";
    path?: string;
  };
  whatsapp: {
    paired: boolean | null;
    bundledProtocol: string;
    currentProtocol: string | null;
    protocolCurrent: boolean | null;
  };
  problems: string[];
  guidance: ExplainedFailure[];
};

export async function diagnoseWhatsApp(accountId = process.env.WA_ACCOUNT_ID ?? "default"): Promise<DoctorResult> {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  const environment = {
    redisUrl: Boolean(redisUrl),
    redisToken: Boolean(redisToken),
    pairingBroker: Boolean(process.env.PAIRING_BROKER_URL && process.env.PAIRING_BROKER_SECRET),
    recipientAllowlist: Boolean(process.env.WA_ALLOWED_RECIPIENTS),
  };
  const problems: string[] = [];
  const bundledProtocol = DEFAULT_CONNECTION_CONFIG.version.join(".");
  let currentProtocol: string | null = null;
  let protocolCurrent: boolean | null = null;
  let paired: boolean | null = null;
  let redisStatus: DoctorResult["redis"] = "not_configured";
  let backend: StorageBackend = "file";
  let storageStatus: DoctorResult["sessionStorage"]["status"] = "error";

  try {
    const latest = await fetchLatestBaileysVersion();
    if (latest.isLatest) {
      currentProtocol = latest.version.join(".");
      protocolCurrent = currentProtocol === bundledProtocol;
      if (!protocolCurrent) problems.push(`Baileys protocol is outdated: bundled ${bundledProtocol}, current ${currentProtocol}.`);
    } else {
      problems.push("Could not fetch the current WhatsApp protocol version.");
    }
  } catch {
    problems.push("Could not fetch the current WhatsApp protocol version.");
  }

  try {
    backend = storageBackendFromEnv();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (!problems.some((problem) => /WA_STORAGE_BACKEND|Upstash Redis URL and token|Missing required environment/.test(problem)) && backend === "file") {
    redisStatus = "unused";
    try {
      await probeLocalStateDirectory();
      const { state } = await createAuthState(accountId);
      paired = Boolean(state.creds.registered || state.creds.me);
      storageStatus = "ok";
      if (!paired) problems.push("WhatsApp is not paired.");
    } catch {
      storageStatus = "error";
      problems.push("Could not read or write the local WhatsApp session store.");
    }
  } else if (backend === "upstash") {
    try {
      const redis = new Redis({ url: redisUrl, token: redisToken });
      await redis.ping();
      const { state } = await createAuthState(accountId);
      paired = Boolean(state.creds.registered || state.creds.me);
      if (!paired) problems.push("WhatsApp is not paired.");
      const probeKey = `baileys_agent:${accountId}:doctor:${randomUUID()}`;
      try {
        await redis.set(probeKey, "ok", { ex: 60 });
        await redis.del(probeKey);
        redisStatus = "ok";
        storageStatus = "ok";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/read.?only|write.*not.*allowed|permission.*write|NOPERM/i.test(message)) {
          redisStatus = "read_only";
          storageStatus = "read_only";
          problems.push("Upstash Redis session storage is read-only.");
        } else {
          redisStatus = "error";
          storageStatus = "error";
          problems.push("Could not write to the Upstash Redis session.");
        }
      }
    } catch {
      redisStatus = "error";
      storageStatus = "error";
      problems.push("Could not read the Upstash Redis session.");
    }
  }

  return {
    ok: problems.length === 0,
    node: process.version,
    environment,
    redis: redisStatus,
    sessionStorage: {
      backend,
      status: storageStatus,
      ...(backend === "file" ? { path: localStateDirectory() } : {}),
    },
    whatsapp: { paired, bundledProtocol, currentProtocol, protocolCurrent },
    problems,
    guidance: problems.map((problem) => explainError(new Error(problem))),
  };
}
