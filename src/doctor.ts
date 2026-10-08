import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONNECTION_CONFIG, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { createAuthState, storageBackendFromEnv, type AuthStateFactory, type StorageBackend } from "./auth";
import { probeGcsStorage } from "./auth/gcs";
import { baileysLogLevel } from "./baileys-logger";
import { explainError, type ExplainedFailure } from "./explain-error";
import { localStateDirectory, probeLocalStateDirectory } from "./local-files";

export type DoctorResult = {
  ok: boolean;
  node: string;
  environment: Record<string, boolean>;
  redis: "ok" | "not_configured" | "unused" | "read_only" | "error";
  sessionStorage: {
    /** "custom" when the caller passed its own authState. */
    backend: StorageBackend | "custom";
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

export async function diagnoseWhatsApp(
  accountId = process.env.WA_ACCOUNT_ID ?? "default",
  options: { authState?: AuthStateFactory } = {},
): Promise<DoctorResult> {
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
  let backend: DoctorResult["sessionStorage"]["backend"] = options.authState ? "custom" : "file";
  let storageStatus: DoctorResult["sessionStorage"]["status"] = "error";

  try {
    baileysLogLevel();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

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

  if (!options.authState) {
    try {
      backend = storageBackendFromEnv();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (options.authState) {
    redisStatus = "unused";
    try {
      const { state } = await options.authState(accountId);
      paired = Boolean(state.creds.registered || state.creds.me);
      storageStatus = "ok";
      if (!paired) problems.push("WhatsApp is not paired.");
    } catch {
      problems.push("Could not read the injected WhatsApp session store.");
    }
  } else if (backend === "gcs") {
    redisStatus = "unused";
    try {
      const { state } = await createAuthState(accountId);
      paired = Boolean(state.creds.registered || state.creds.me);
      if (!paired) problems.push("WhatsApp is not paired.");
      try {
        await probeGcsStorage(accountId);
        storageStatus = "ok";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        storageStatus = /read-only/.test(message) ? "read_only" : "error";
        problems.push(/read-only/.test(message) ? "GCS session storage is read-only for this identity." : "Could not write to the GCS session storage.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // GCS store messages name the setting or condition and never contain state or credentials.
      problems.push(/GCS session storage/.test(message) ? message : "Could not read the GCS session storage.");
    }
  } else if (!problems.some((problem) => /WA_STORAGE_BACKEND|Upstash Redis URL and token|Missing required environment/.test(problem)) && backend === "file") {
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
