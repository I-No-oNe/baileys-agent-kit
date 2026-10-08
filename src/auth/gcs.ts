import { randomUUID } from "node:crypto";
import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { requiredEnv } from "../env";
import { decryptState, encryptState } from "../github-state";
import { validateAccountId } from "../local-files";
import type { AuthStateHandle } from "./types";

const PURPOSE = "gcs-auth";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

type StoredAuth = {
  version: 1;
  creds: AuthenticationState["creds"];
  keys: Record<string, Record<string, unknown>>;
};

export type GcsAuthStateOptions = {
  /** Defaults to WA_GCS_BUCKET. */
  bucket?: string;
  /** Object name prefix. Defaults to WA_GCS_PREFIX, then "baileys-agent-kit/". */
  prefix?: string;
  /** 32-byte key. Defaults to base64 WA_STATE_ENCRYPTION_KEY. */
  masterKey?: Buffer;
  /** Defaults to WA_GCS_ACCESS_TOKEN, then the metadata server (Cloud Run, GCE, GKE). */
  accessToken?: () => Promise<string>;
  /** Defaults to WA_GCS_ENDPOINT, then https://storage.googleapis.com. Set for an emulator. */
  endpoint?: string;
  fetch?: typeof fetch;
};

type Settings = {
  bucket: string;
  prefix: string;
  masterKey: Buffer;
  accessToken: () => Promise<string>;
  endpoint: string;
  fetch: typeof fetch;
};

const encode = (value: unknown) => JSON.stringify(value, BufferJSON.replacer);
const decode = <T>(value: string) => JSON.parse(value, BufferJSON.reviver) as T;

function gcsMasterKey(raw = process.env.WA_STATE_ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error("WA_STATE_ENCRYPTION_KEY is required for GCS session storage.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("WA_STATE_ENCRYPTION_KEY must be a base64-encoded 32-byte key for GCS session storage.");
  return key;
}

function metadataAccessToken(fetchImpl: typeof fetch): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const response = await fetchImpl(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } }).catch(() => undefined);
    if (!response?.ok) {
      throw new Error("GCS session storage could not get an access token from the metadata server. Outside Google Cloud, set WA_GCS_ACCESS_TOKEN.");
    }
    const body = await response.json() as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1_000 };
    return cached.token;
  };
}

function settings(options: GcsAuthStateOptions): Settings {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const staticToken = process.env.WA_GCS_ACCESS_TOKEN;
  return {
    bucket: options.bucket ?? requiredEnv("WA_GCS_BUCKET"),
    prefix: options.prefix ?? process.env.WA_GCS_PREFIX ?? "baileys-agent-kit/",
    masterKey: options.masterKey ?? gcsMasterKey(),
    accessToken: options.accessToken ?? (staticToken ? async () => staticToken : metadataAccessToken(fetchImpl)),
    endpoint: (options.endpoint ?? process.env.WA_GCS_ENDPOINT ?? "https://storage.googleapis.com").replace(/\/$/, ""),
    fetch: fetchImpl,
  };
}

async function request(config: Settings, method: string, path: string, init: { body?: Buffer; contentType?: string } = {}) {
  const response = await config.fetch(`${config.endpoint}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await config.accessToken()}`,
      ...(init.contentType ? { "Content-Type": init.contentType } : {}),
    },
    ...(init.body ? { body: new Uint8Array(init.body) } : {}),
  });
  return response;
}

function objectPath(config: Settings, name: string) {
  return `/storage/v1/b/${encodeURIComponent(config.bucket)}/o/${encodeURIComponent(name)}`;
}

/** Reads an object; undefined when it does not exist. */
async function readObject(config: Settings, name: string): Promise<{ body: Buffer; generation: string } | undefined> {
  const response = await request(config, "GET", `${objectPath(config, name)}?alt=media`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GCS session storage read failed with HTTP ${response.status}.`);
  const generation = response.headers.get("x-goog-generation");
  if (!generation) throw new Error("GCS session storage read returned no object generation.");
  return { body: Buffer.from(await response.arrayBuffer()), generation };
}

/** Writes an object only if its generation still matches ("0" = must not exist). Returns the new generation, or undefined on a precondition failure. */
async function writeObject(config: Settings, name: string, body: Buffer, ifGenerationMatch: string): Promise<string | undefined> {
  const query = new URLSearchParams({ uploadType: "media", name, ifGenerationMatch });
  const response = await request(config, "POST", `/upload/storage/v1/b/${encodeURIComponent(config.bucket)}/o?${query}`, {
    body,
    contentType: "application/octet-stream",
  });
  if (response.status === 412) return undefined;
  if (response.status === 403) throw new Error("GCS session storage is read-only for this identity.");
  if (!response.ok) throw new Error(`GCS session storage write failed with HTTP ${response.status}.`);
  return String((await response.json() as { generation: string | number }).generation);
}

async function deleteObject(config: Settings, name: string): Promise<void> {
  const response = await request(config, "DELETE", objectPath(config, name));
  if (!response.ok && response.status !== 404) throw new Error(`GCS session storage delete failed with HTTP ${response.status}.`);
}

/**
 * Keeps one account's whole auth state (credentials and Signal keys) as a single object, sealed with
 * encryptState (AES-256-GCM, per-account key, purpose-bound). Every write is conditional on the generation
 * this process last read or wrote, so two processes can never silently overwrite each other's keys.
 * Writes are serialized and coalesced: calls that arrive while a write is running share the next one.
 */
export async function createGcsAuthState(
  accountId = process.env.WA_ACCOUNT_ID ?? "default",
  options: GcsAuthStateOptions = {},
): Promise<AuthStateHandle> {
  validateAccountId(accountId);
  const config = settings(options);
  const name = `${config.prefix}${accountId}/auth.enc`;

  const open = (body: Buffer) => {
    try {
      return decryptState(body, config.masterKey, accountId, PURPOSE).toString("utf8");
    } catch {
      throw new Error("GCS session storage could not decrypt the stored auth state. Check WA_STATE_ENCRYPTION_KEY and the account ID; do not overwrite it.");
    }
  };

  const existing = await readObject(config, name);
  let generation = existing?.generation ?? "0";
  const stored: StoredAuth = existing
    ? decode<StoredAuth>(open(existing.body))
    : { version: 1, creds: initAuthCreds(), keys: {} };
  if (stored.version !== 1) throw new Error("GCS session storage holds an unsupported auth state version.");

  let conflict = false;
  // The last plaintext whose write failed without a clear answer (network error after GCS may have committed it).
  let unconfirmed: string | undefined;

  const upload = async () => {
    if (conflict) throw new Error("GCS session storage was changed by another process. Stop this process; do not overwrite it.");
    const plaintext = encode(stored);
    const sealed = encryptState(Buffer.from(plaintext), config.masterKey, accountId, PURPOSE);
    let next: string | undefined;
    try {
      next = await writeObject(config, name, sealed, generation);
    } catch (error) {
      unconfirmed = plaintext;
      throw error;
    }
    if (next === undefined && unconfirmed !== undefined) {
      // Our previous write may have landed after all: adopt it if the stored object is exactly what we sent.
      const current = await readObject(config, name);
      if (current && open(current.body) === unconfirmed) {
        generation = current.generation;
        next = await writeObject(config, name, sealed, generation);
      }
    }
    if (next === undefined) {
      conflict = true;
      throw new Error("GCS session storage was changed by another process. Stop this process; do not overwrite it.");
    }
    generation = next;
    unconfirmed = undefined;
  };

  let tail: Promise<void> = Promise.resolve();
  let queued: Promise<void> | undefined;
  const persist = () => {
    if (queued) return queued;
    const task = tail.catch(() => undefined).then(() => {
      queued = undefined;
      return upload();
    });
    queued = task;
    tail = task;
    return task;
  };

  const state: AuthenticationState = {
    creds: stored.creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const entries = stored.keys[type] ?? {};
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          if (entries[id] !== undefined) result[id] = entries[id] as SignalDataTypeMap[T];
        }
        return result;
      },
      async set(data: SignalDataSet) {
        for (const [type, entries] of Object.entries(data)) {
          const values = stored.keys[type] ?? {};
          for (const [id, value] of Object.entries(entries ?? {})) {
            if (value === null) delete values[id];
            else values[id] = value;
          }
          if (Object.keys(values).length) stored.keys[type] = values;
          else delete stored.keys[type];
        }
        await persist();
      },
    },
  };

  return {
    state,
    saveCreds: persist,
    async clear() {
      await tail.catch(() => undefined);
      await deleteObject(config, name);
      stored.creds = initAuthCreds();
      stored.keys = {};
      state.creds = stored.creds;
      generation = "0";
      conflict = false;
      unconfirmed = undefined;
    },
  };
}

/** Write/delete probe for doctor: proves the identity can write to the bucket without touching auth state. */
export async function probeGcsStorage(accountId: string, options: GcsAuthStateOptions = {}): Promise<void> {
  validateAccountId(accountId);
  const config = settings(options);
  const name = `${config.prefix}${accountId}/doctor-${randomUUID()}`;
  const written = await writeObject(config, name, Buffer.from("ok"), "0");
  if (written === undefined) throw new Error("GCS session storage probe object already exists.");
  await deleteObject(config, name);
}
