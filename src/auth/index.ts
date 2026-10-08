import { requiredEnv } from "../env";
import { createFileAuthState } from "./file";
import { createGcsAuthState } from "./gcs";
import type { AuthStateHandle } from "./types";
import { createUpstashAuthState } from "./upstash";

export type { AuthStateFactory, AuthStateHandle } from "./types";

export type StorageBackend = "file" | "upstash" | "gcs";

export function storageBackendFromEnv(): StorageBackend {
  const requested = process.env.WA_STORAGE_BACKEND?.trim().toLowerCase();
  if (requested && requested !== "file" && requested !== "upstash" && requested !== "gcs") {
    throw new Error("WA_STORAGE_BACKEND must be 'file', 'upstash' or 'gcs'.");
  }
  if (requested === "file") return "file";
  if (requested === "gcs") {
    requiredEnv("WA_GCS_BUCKET");
    requiredEnv("WA_STATE_ENCRYPTION_KEY");
    return "gcs";
  }

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

export async function createAuthState(accountId = process.env.WA_ACCOUNT_ID ?? "default"): Promise<AuthStateHandle> {
  switch (storageBackendFromEnv()) {
    case "upstash":
      return createUpstashAuthState(accountId);
    case "gcs":
      return createGcsAuthState(accountId);
    case "file":
      return createFileAuthState(accountId);
  }
}
