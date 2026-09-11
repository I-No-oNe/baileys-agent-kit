import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileAuthState } from "./auth/file";
import { decryptState, encryptState, restoreGitHubState, saveGitHubState } from "./github-state";

test("encrypts GitHub state with authenticated account-bound ciphertext", () => {
  const key = randomBytes(32);
  const plaintext = randomBytes(512);
  const first = encryptState(plaintext, key, "account-one");
  const second = encryptState(plaintext, key, "account-one");
  assert.notDeepEqual(first, second);
  assert.deepEqual(decryptState(first, key, "account-one"), plaintext);
  assert.throws(() => decryptState(first, randomBytes(32), "account-one"), /failed authentication/);
  assert.throws(() => decryptState(first, key, "account-two"), /failed authentication/);

  const envelope = JSON.parse(first.toString("utf8")) as { ciphertext: string };
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  ciphertext[0] ^= 1;
  envelope.ciphertext = ciphertext.toString("base64");
  assert.throws(() => decryptState(Buffer.from(JSON.stringify(envelope)), key, "account-one"), /failed authentication/);
});

test("rejects malformed encryption keys and envelopes", () => {
  assert.throws(() => encryptState(Buffer.from("state"), Buffer.alloc(16), "default"), /32 bytes/);
  assert.throws(() => decryptState(Buffer.from("not-json"), Buffer.alloc(32), "default"), /malformed/);
});

function fakeGitHub(options: { staleRefReads?: number } = {}) {
  let sequence = 0;
  let head: string | undefined;
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Array<{ path: string; type: string; sha: string }>>();
  const commits = new Map<string, string>();
  const parents = new Map<string, string[]>();
  const sha = (prefix: string) => `${prefix}-${++sequence}`;

  // GitHub can still answer 404 on a ref read that immediately follows the ref
  // write. `staleRefReads` replays that, which is what the first save against a
  // brand new repository actually hits.
  let staleRefReads = options.staleRefReads ?? 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace("/repos/owner/repo", "");
    const body = request.method === "GET" ? undefined : await request.json() as Record<string, any>;
    if (request.method === "GET" && path.startsWith("/git/ref/heads/")) {
      if (head && staleRefReads > 0) {
        staleRefReads -= 1;
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return head ? Response.json({ object: { sha: head } }) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (request.method === "GET" && path.startsWith("/git/commits/")) {
      const commitSha = path.split("/").at(-1)!;
      return Response.json({ sha: commitSha, tree: { sha: commits.get(commitSha) } });
    }
    if (request.method === "GET" && path.startsWith("/git/trees/")) {
      const treeSha = path.split("/").at(-1)!;
      return Response.json({ sha: treeSha, tree: trees.get(treeSha) ?? [] });
    }
    if (request.method === "GET" && path.startsWith("/git/blobs/")) {
      const blobSha = path.split("/").at(-1)!;
      return Response.json({ sha: blobSha, encoding: "base64", content: blobs.get(blobSha)!.toString("base64") });
    }
    if (request.method === "POST" && path === "/git/blobs") {
      const blobSha = sha("blob");
      blobs.set(blobSha, Buffer.from(body!.content, body!.encoding === "base64" ? "base64" : "utf8"));
      return Response.json({ sha: blobSha }, { status: 201 });
    }
    if (request.method === "POST" && path === "/git/trees") {
      const treeSha = sha("tree");
      const entries = body!.base_tree ? [...(trees.get(body!.base_tree) ?? [])] : [];
      for (const entry of body!.tree as Array<{ path: string; type: string; sha: string }>) {
        const index = entries.findIndex((candidate) => candidate.path === entry.path);
        if (index >= 0) entries[index] = entry;
        else entries.push(entry);
      }
      trees.set(treeSha, entries);
      return Response.json({ sha: treeSha }, { status: 201 });
    }
    if (request.method === "POST" && path === "/git/commits") {
      const commitSha = sha("commit");
      commits.set(commitSha, body!.tree);
      parents.set(commitSha, body!.parents ?? []);
      return Response.json({ sha: commitSha }, { status: 201 });
    }
    if (request.method === "POST" && path === "/git/refs") {
      head = body!.sha;
      return Response.json({ ref: body!.ref, object: { sha: head } }, { status: 201 });
    }
    if (request.method === "PATCH" && path.startsWith("/git/refs/heads/")) {
      head = body!.sha;
      return Response.json({ object: { sha: head } });
    }
    return Response.json({ message: `Unhandled ${request.method} ${path}` }, { status: 500 });
  };
  return Object.assign(fetch, { parentsOf: (commitSha: string) => parents.get(commitSha) ?? [], headSha: () => head });
}

test("saves to an orphan Git branch and restores into a clean local state directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baileys-agent-github-"));
  const originalFetch = globalThis.fetch;
  const previous = new Map(["WA_STATE_DIR", "WA_STATE_ENCRYPTION_KEY", "WA_ACCOUNT_ID"].map((name) => [name, process.env[name]]));
  process.env.WA_STATE_DIR = directory;
  process.env.WA_STATE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WA_ACCOUNT_ID = "github-test";
  globalThis.fetch = fakeGitHub();
  try {
    const auth = await createFileAuthState("github-test");
    auth.state.creds.registered = true;
    await auth.saveCreds();
    assert.deepEqual(await saveGitHubState({ repository: "owner/repo", token: "test-token" }), {
      saved: true,
      accountId: "github-test",
      branch: "baileys-agent-state",
    });

    await rm(directory, { recursive: true, force: true });
    const restored = await restoreGitHubState({ repository: "owner/repo", token: "test-token" });
    assert.equal(restored.restored, true);
    assert.equal((await createFileAuthState("github-test")).state.creds.registered, true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("saves even when the new branch ref is not readable yet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baileys-agent-github-"));
  const originalFetch = globalThis.fetch;
  const previous = new Map(["WA_STATE_DIR", "WA_STATE_ENCRYPTION_KEY", "WA_ACCOUNT_ID"].map((name) => [name, process.env[name]]));
  process.env.WA_STATE_DIR = directory;
  process.env.WA_STATE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WA_ACCOUNT_ID = "github-test";
  globalThis.fetch = fakeGitHub({ staleRefReads: 1 });
  try {
    const auth = await createFileAuthState("github-test");
    auth.state.creds.registered = true;
    await auth.saveCreds();
    const saved = await saveGitHubState({ repository: "owner/repo", token: "test-token" });
    assert.equal(saved.saved, true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps no history, so a repeatedly saved session cannot grow the branch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "baileys-agent-github-"));
  const originalFetch = globalThis.fetch;
  const previous = new Map(["WA_STATE_DIR", "WA_STATE_ENCRYPTION_KEY", "WA_ACCOUNT_ID"].map((name) => [name, process.env[name]]));
  process.env.WA_STATE_DIR = directory;
  process.env.WA_STATE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.WA_ACCOUNT_ID = "github-test";
  const github = fakeGitHub();
  globalThis.fetch = github;
  try {
    const auth = await createFileAuthState("github-test");
    auth.state.creds.registered = true;
    await auth.saveCreds();

    for (let round = 0; round < 3; round += 1) {
      auth.state.creds.advSecretKey = randomBytes(8).toString("base64");
      await auth.saveCreds();
      await saveGitHubState({ repository: "owner/repo", token: "test-token" });
      assert.deepEqual(github.parentsOf(github.headSha()!), [], "each state commit must be parentless");
    }

    // The newest state is still the one that comes back.
    await rm(directory, { recursive: true, force: true });
    await restoreGitHubState({ repository: "owner/repo", token: "test-token" });
    assert.equal((await createFileAuthState("github-test")).state.creds.advSecretKey, auth.state.creds.advSecretKey);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
