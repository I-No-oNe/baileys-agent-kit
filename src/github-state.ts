import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { localStatePath, readOptionalFile, validateAccountId, writePrivateFile } from "./local-files";

const STATE_VERSION = 1;
const DEFAULT_BRANCH = "baileys-agent-state";
const ENCRYPTION_SECRET = "WA_STATE_ENCRYPTION_KEY";

type EncryptedEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

type StateManifest = {
  version: 1;
  accountId: string;
  files: Record<string, string>;
};

type StateMetadata = {
  version: 1;
  repository: string;
  branch: string;
  path: string;
  blobSha: string | null;
};

type GitHubConfig = {
  token: string;
  repository: string;
  branch: string;
  accountId: string;
  masterKey: Buffer;
};

type GitRef = { object: { sha: string } };
type GitCommit = { sha: string; tree: { sha: string } };
type GitTree = { sha: string; tree: Array<{ path: string; type: string; sha: string }> };
type GitBlob = { sha: string; content: string; encoding: string };

function encryptionKey(raw = process.env[ENCRYPTION_SECRET]): Buffer {
  if (!raw) throw new Error(`${ENCRYPTION_SECRET} is required for encrypted GitHub state.`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${ENCRYPTION_SECRET} must be a base64-encoded 32-byte key.`);
  return key;
}

function accountKey(masterKey: Buffer, accountId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, "baileys-agent-kit-state-v1", accountId, 32));
}

function additionalData(accountId: string): Buffer {
  return Buffer.from(`baileys-agent-kit/github-state/v1\0${accountId}`);
}

export function encryptState(plaintext: Buffer, masterKey: Buffer, accountId: string): Buffer {
  validateAccountId(accountId);
  if (masterKey.length !== 32) throw new Error("GitHub state encryption key must contain 32 bytes.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", accountKey(masterKey, accountId), iv);
  cipher.setAAD(additionalData(accountId));
  const ciphertext = Buffer.concat([cipher.update(gzipSync(plaintext)), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    version: STATE_VERSION,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope));
}

export function decryptState(encrypted: Buffer, masterKey: Buffer, accountId: string): Buffer {
  validateAccountId(accountId);
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(encrypted.toString("utf8")) as EncryptedEnvelope;
  } catch {
    throw new Error("Encrypted GitHub state is malformed.");
  }
  if (envelope.version !== STATE_VERSION || envelope.algorithm !== "aes-256-gcm") {
    throw new Error("Encrypted GitHub state uses an unsupported format.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", accountKey(masterKey, accountId), Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(additionalData(accountId));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return gunzipSync(Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]));
  } catch {
    throw new Error("Encrypted GitHub state failed authentication. Check the key and account ID; do not overwrite it.");
  }
}

function config(overrides: Partial<Pick<GitHubConfig, "token" | "repository" | "branch" | "accountId">> = {}): GitHubConfig {
  const accountId = validateAccountId(overrides.accountId ?? process.env.WA_ACCOUNT_ID ?? "default");
  const repository = overrides.repository ?? process.env.GITHUB_REPOSITORY;
  const token = overrides.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY must use OWNER/REPO format.");
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required for encrypted GitHub state.");
  return {
    accountId,
    repository,
    token,
    branch: overrides.branch ?? process.env.WA_STATE_BRANCH ?? DEFAULT_BRANCH,
    masterKey: encryptionKey(),
  };
}

function statePath(settings: GitHubConfig): string {
  const name = createHmac("sha256", settings.masterKey).update(settings.accountId).digest("base64url");
  return `accounts/${name}.enc`;
}

function metadataPath(accountId: string) {
  return localStatePath(accountId, "github.json");
}

async function api<T>(settings: GitHubConfig, path: string, init: RequestInit = {}, allow404 = false): Promise<T | undefined> {
  const response = await fetch(`https://api.github.com/repos/${settings.repository}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${settings.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (allow404 && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub encrypted state request failed with HTTP ${response.status}.`);
  if (response.status === 204) return undefined;
  return await response.json() as T;
}

function refPath(branch: string, plural = false) {
  return `/git/${plural ? "refs" : "ref"}/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

async function getBranch(settings: GitHubConfig) {
  const ref = await api<GitRef>(settings, refPath(settings.branch), {}, true);
  if (!ref) return undefined;
  const commit = await api<GitCommit>(settings, `/git/commits/${ref.object.sha}`);
  const tree = await api<GitTree>(settings, `/git/trees/${commit!.tree.sha}?recursive=1`);
  return { headSha: ref.object.sha, treeSha: commit!.tree.sha, tree: tree!.tree };
}

async function ensureBranch(settings: GitHubConfig) {
  const existing = await getBranch(settings);
  if (existing) return existing;
  const marker = await api<{ sha: string }>(settings, "/git/blobs", {
    method: "POST",
    body: JSON.stringify({ content: "Encrypted WhatsApp state only. Do not commit plaintext here.\n", encoding: "utf-8" }),
  });
  const tree = await api<{ sha: string }>(settings, "/git/trees", {
    method: "POST",
    body: JSON.stringify({ tree: [{ path: "README.txt", mode: "100644", type: "blob", sha: marker!.sha }] }),
  });
  const commit = await api<{ sha: string }>(settings, "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message: "chore(state): initialize encrypted WhatsApp state", tree: tree!.sha, parents: [] }),
  });
  try {
    await api(settings, "/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${settings.branch}`, sha: commit!.sha }),
    });
  } catch (error) {
    const raced = await getBranch(settings);
    if (raced) return raced;
    throw error;
  }
  return (await getBranch(settings))!;
}

async function readBlob(settings: GitHubConfig, sha: string): Promise<Buffer> {
  const blob = await api<GitBlob>(settings, `/git/blobs/${sha}`);
  if (blob!.encoding !== "base64") throw new Error("GitHub encrypted state blob uses an unsupported encoding.");
  return Buffer.from(blob!.content.replace(/\n/g, ""), "base64");
}

async function collectManifest(accountId: string): Promise<StateManifest | undefined> {
  const files: Record<string, string> = {};
  for (const name of ["auth.json", "risk.json"] as const) {
    const contents = await readOptionalFile(localStatePath(accountId, name));
    if (contents) files[name] = contents.toString("base64");
  }
  if (!files["auth.json"]) return undefined;
  return { version: STATE_VERSION, accountId, files };
}

async function restoreManifest(manifest: StateManifest, accountId: string) {
  if (manifest.version !== STATE_VERSION || manifest.accountId !== accountId) throw new Error("Encrypted GitHub state belongs to another account or version.");
  for (const [name, encoded] of Object.entries(manifest.files)) {
    if (name !== "auth.json" && name !== "risk.json") throw new Error("Encrypted GitHub state contains an unsafe file path.");
    await writePrivateFile(localStatePath(accountId, name), Buffer.from(encoded, "base64"));
  }
}

async function readMetadata(accountId: string): Promise<StateMetadata | undefined> {
  const stored = await readOptionalFile(metadataPath(accountId));
  return stored ? JSON.parse(stored.toString("utf8")) as StateMetadata : undefined;
}

async function writeMetadata(accountId: string, metadata: StateMetadata) {
  await writePrivateFile(metadataPath(accountId), JSON.stringify(metadata));
}

export async function restoreGitHubState(overrides: Parameters<typeof config>[0] = {}) {
  const settings = config(overrides);
  const path = statePath(settings);
  const branch = await getBranch(settings);
  const entry = branch?.tree.find((item) => item.path === path && item.type === "blob");
  if (entry) {
    const plaintext = decryptState(await readBlob(settings, entry.sha), settings.masterKey, settings.accountId);
    const manifest = JSON.parse(plaintext.toString("utf8")) as StateManifest;
    await restoreManifest(manifest, settings.accountId);
  }
  await writeMetadata(settings.accountId, {
    version: STATE_VERSION,
    repository: settings.repository,
    branch: settings.branch,
    path,
    blobSha: entry?.sha ?? null,
  });
  return { restored: Boolean(entry), accountId: settings.accountId, branch: settings.branch };
}

export async function saveGitHubState(overrides: Parameters<typeof config>[0] = {}, allowMissing = false) {
  const settings = config(overrides);
  const manifest = await collectManifest(settings.accountId);
  if (!manifest) {
    if (allowMissing) return { saved: false, accountId: settings.accountId, branch: settings.branch };
    throw new Error("No local WhatsApp auth state exists. Pair locally before enabling GitHub state.");
  }
  const encrypted = encryptState(Buffer.from(JSON.stringify(manifest)), settings.masterKey, settings.accountId);
  const path = statePath(settings);
  const metadata = await readMetadata(settings.accountId);
  if (metadata && (metadata.repository !== settings.repository || metadata.branch !== settings.branch || metadata.path !== path)) {
    throw new Error("Local GitHub state metadata does not match this repository or branch.");
  }
  const expectedBlob = metadata?.blobSha ?? null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const branch = await ensureBranch(settings);
    const current = branch.tree.find((item) => item.path === path && item.type === "blob")?.sha ?? null;
    if (current !== expectedBlob) throw new Error("GitHub encrypted state changed after restore. Refusing to overwrite newer session data.");
    const blob = await api<{ sha: string }>(settings, "/git/blobs", {
      method: "POST",
      body: JSON.stringify({ content: encrypted.toString("base64"), encoding: "base64" }),
    });
    const tree = await api<{ sha: string }>(settings, "/git/trees", {
      method: "POST",
      body: JSON.stringify({ base_tree: branch.treeSha, tree: [{ path, mode: "100644", type: "blob", sha: blob!.sha }] }),
    });
    const commit = await api<{ sha: string }>(settings, "/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: `chore(state): update encrypted WhatsApp account ${settings.accountId}`, tree: tree!.sha, parents: [branch.headSha] }),
    });
    try {
      await api(settings, refPath(settings.branch, true), {
        method: "PATCH",
        body: JSON.stringify({ sha: commit!.sha, force: false }),
      });
      await writeMetadata(settings.accountId, {
        version: STATE_VERSION,
        repository: settings.repository,
        branch: settings.branch,
        path,
        blobSha: blob!.sha,
      });
      return { saved: true, accountId: settings.accountId, branch: settings.branch };
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error("GitHub encrypted state could not be updated after concurrent changes.");
}

function run(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8").trim())
      : reject(new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`)));
    child.stdin.end(input);
  });
}

export async function setupGitHubState(repository?: string, accountId?: string) {
  const resolvedRepository = repository ?? await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const token = await run("gh", ["auth", "token"]);
  const existingSecrets = await run("gh", ["secret", "list", "--repo", resolvedRepository, "--json", "name", "--jq", ".[].name"]);
  if (existingSecrets.split(/\s+/).includes(ENCRYPTION_SECRET)) {
    throw new Error(`${ENCRYPTION_SECRET} already exists. Refusing to rotate it because existing encrypted state could become unreadable.`);
  }
  const key = randomBytes(32).toString("base64");
  const previous = process.env[ENCRYPTION_SECRET];
  process.env[ENCRYPTION_SECRET] = key;
  try {
    const result = await saveGitHubState({ repository: resolvedRepository, token, accountId });
    await run("gh", ["secret", "set", ENCRYPTION_SECRET, "--repo", resolvedRepository], key);
    return result;
  } finally {
    if (previous === undefined) delete process.env[ENCRYPTION_SECRET];
    else process.env[ENCRYPTION_SECRET] = previous;
  }
}
