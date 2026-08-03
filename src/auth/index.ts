import { requiredEnv } from "../env";
import { createFileAuthState } from "./file";
import { createUpstashAuthState } from "./upstash";

export type StorageBackend = "file" | "upstash";

export function storageBackendFromEnv(): StorageBackend {
  const requested = process.env.WA_STORAGE_BACKEND?.trim().toLowerCase();
  if (requested && requested !== "file" && requested !== "upstash") {
    throw new Error("WA_STORAGE_BACKEND must be 'file' or 'upstash'.");
  }
  if (requested === "file") return "file";

  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (requested === "upstash") {
    requiredEnv("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL");
    requiredEnv("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN");
    return "upstash";
  }
  if (Boolean(url) !== Boolean(token)) {
    throw new Error("Upstash Redis URL and token must be configured together, or set WA_STORAGE_BACKEND=file.");
  }
  return url && token ? "upstash" : "file";
}

export async function createAuthState(accountId = process.env.WA_ACCOUNT_ID ?? "default") {
  return storageBackendFromEnv() === "upstash"
    ? createUpstashAuthState(accountId)
    : createFileAuthState(accountId);
}
