import { Redis } from "@upstash/redis";
import { DEFAULT_CONNECTION_CONFIG, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { createUpstashAuthState } from "./auth/upstash";

export type DoctorResult = {
  ok: boolean;
  node: string;
  environment: Record<string, boolean>;
  redis: "ok" | "not_configured" | "error";
  whatsapp: {
    paired: boolean | null;
    bundledProtocol: string;
    currentProtocol: string | null;
    protocolCurrent: boolean | null;
  };
  problems: string[];
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

  if (!redisUrl || !redisToken) {
    problems.push("Upstash Redis environment variables are missing.");
  } else {
    try {
      const redis = new Redis({ url: redisUrl, token: redisToken });
      await redis.ping();
      redisStatus = "ok";
      const { state } = await createUpstashAuthState(accountId);
      paired = Boolean(state.creds.registered || state.creds.me);
      if (!paired) problems.push("WhatsApp is not paired.");
    } catch {
      redisStatus = "error";
      problems.push("Could not read the Upstash Redis session.");
    }
  }

  return {
    ok: problems.length === 0,
    node: process.version,
    environment,
    redis: redisStatus,
    whatsapp: { paired, bundledProtocol, currentProtocol, protocolCurrent },
    problems,
  };
}
