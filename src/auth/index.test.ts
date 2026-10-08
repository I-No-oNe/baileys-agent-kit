import assert from "node:assert/strict";
import test from "node:test";
import { storageBackendFromEnv } from ".";

const names = ["WA_STORAGE_BACKEND", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN", "WA_GCS_BUCKET", "WA_STATE_ENCRYPTION_KEY"] as const;

test("uses local files by default and preserves explicit Upstash compatibility", () => {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    names.forEach((name) => delete process.env[name]);
    assert.equal(storageBackendFromEnv(), "file");

    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
    assert.throws(storageBackendFromEnv, /configured together/);

    process.env.WA_STORAGE_BACKEND = "file";
    assert.equal(storageBackendFromEnv(), "file");

    process.env.WA_STORAGE_BACKEND = "upstash";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    assert.equal(storageBackendFromEnv(), "upstash");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("selects GCS only when asked and configured", () => {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    names.forEach((name) => delete process.env[name]);
    process.env.WA_GCS_BUCKET = "bucket";
    assert.equal(storageBackendFromEnv(), "file");

    process.env.WA_STORAGE_BACKEND = "gcs";
    assert.throws(storageBackendFromEnv, /WA_STATE_ENCRYPTION_KEY/);
    process.env.WA_STATE_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
    assert.equal(storageBackendFromEnv(), "gcs");

    process.env.WA_STORAGE_BACKEND = "postgres";
    assert.throws(storageBackendFromEnv, /must be 'file', 'upstash' or 'gcs'/);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
