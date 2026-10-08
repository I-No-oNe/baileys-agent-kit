import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { diagnoseWhatsApp } from "../doctor";
import { decryptState } from "../github-state";
import { createGcsAuthState, probeGcsStorage, type GcsAuthStateOptions } from "./gcs";

// The subset of the Cloud Storage JSON API the backend uses, with generation preconditions.
function fakeGcs() {
  const objects = new Map<string, { body: Buffer; generation: number }>();
  let nextGeneration = 1;
  const calls: string[] = [];
  const hooks: { beforeWrite?: () => "drop-response" | undefined; readOnly?: boolean } = {};

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-token");

    const read = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
    if (read && method === "GET") {
      const object = objects.get(decodeURIComponent(read[2]));
      if (!object) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(object.body), { headers: { "x-goog-generation": String(object.generation) } });
    }
    if (read && method === "DELETE") {
      if (hooks.readOnly) return new Response(null, { status: 403 });
      return new Response(null, { status: objects.delete(decodeURIComponent(read[2])) ? 204 : 404 });
    }
    if (url.pathname === "/upload/storage/v1/b/bucket/o" && method === "POST") {
      if (hooks.readOnly) return new Response(null, { status: 403 });
      const name = url.searchParams.get("name")!;
      const expected = Number(url.searchParams.get("ifGenerationMatch"));
      if ((objects.get(name)?.generation ?? 0) !== expected) return new Response(null, { status: 412 });
      const generation = nextGeneration++;
      objects.set(name, { body: Buffer.from(init!.body as Uint8Array), generation });
      if (hooks.beforeWrite?.() === "drop-response") throw new TypeError("fetch failed");
      return Response.json({ generation: String(generation) });
    }
    return new Response(null, { status: 400 });
  }) as typeof fetch;

  return { objects, calls, hooks, fetch: fetchImpl };
}

const masterKey = randomBytes(32);
const options = (gcs: ReturnType<typeof fakeGcs>, overrides: GcsAuthStateOptions = {}): GcsAuthStateOptions => ({
  bucket: "bucket",
  masterKey,
  accessToken: async () => "test-token",
  endpoint: "https://gcs.test",
  fetch: gcs.fetch,
  ...overrides,
});

test("round-trips credentials and binary Signal keys as one sealed object", async () => {
  const gcs = fakeGcs();
  const first = await createGcsAuthState("office-1", options(gcs));
  first.state.creds.registered = true;
  await first.state.keys.set({ session: { contact: { nested: Buffer.from("signal-key") } as never } });
  await first.saveCreds();

  assert.deepEqual([...gcs.objects.keys()], ["baileys-agent-kit/office-1/auth.enc"]);
  const sealed = gcs.objects.get("baileys-agent-kit/office-1/auth.enc")!.body;
  assert.equal(sealed.includes(Buffer.from("registered")), false);
  assert.equal(sealed.includes(Buffer.from(Buffer.from("signal-key").toString("base64"))), false);
  // Bound to this store: the same key and account cannot open it as GitHub state.
  assert.throws(() => decryptState(sealed, masterKey, "office-1"), /failed authentication/);

  const second = await createGcsAuthState("office-1", options(gcs));
  assert.equal(second.state.creds.registered, true);
  const restored = await second.state.keys.get("session", ["contact"]);
  assert.deepEqual((restored.contact as unknown as { nested: Buffer }).nested, Buffer.from("signal-key"));

  await second.state.keys.set({ session: { contact: null } });
  const third = await createGcsAuthState("office-1", options(gcs));
  assert.deepEqual(await third.state.keys.get("session", ["contact"]), {});
});

test("refuses to open state sealed with another key", async () => {
  const gcs = fakeGcs();
  await (await createGcsAuthState("office-1", options(gcs))).saveCreds();
  await assert.rejects(
    createGcsAuthState("office-1", options(gcs, { masterKey: randomBytes(32) })),
    /could not decrypt the stored auth state/,
  );
});

test("stops writing once another process changed the object", async () => {
  const gcs = fakeGcs();
  const first = await createGcsAuthState("office-1", options(gcs));
  const second = await createGcsAuthState("office-1", options(gcs));
  await first.saveCreds();

  await assert.rejects(second.saveCreds(), /changed by another process/);
  await assert.rejects(async () => second.state.keys.set({ session: { a: null } }), /changed by another process/);
  // The first writer's object is untouched and still opens.
  const reread = await createGcsAuthState("office-1", options(gcs));
  assert.ok(reread.state.creds.noiseKey);
});

test("adopts its own write when the response was lost after GCS committed it", async () => {
  const gcs = fakeGcs();
  const handle = await createGcsAuthState("office-1", options(gcs));
  gcs.hooks.beforeWrite = () => "drop-response";
  await assert.rejects(handle.saveCreds(), /fetch failed/);
  gcs.hooks.beforeWrite = undefined;

  handle.state.creds.registered = true;
  await handle.saveCreds();
  assert.equal((await createGcsAuthState("office-1", options(gcs))).state.creds.registered, true);
});

test("coalesces writes that arrive while one is running", async () => {
  const gcs = fakeGcs();
  const handle = await createGcsAuthState("office-1", options(gcs));
  await Promise.all(Array.from({ length: 10 }, (_, index) =>
    handle.state.keys.set({ session: { [`contact-${index}`]: { index } as never } })));
  const uploads = gcs.calls.filter((call) => call.startsWith("POST")).length;
  assert.ok(uploads <= 2, `expected at most 2 uploads, got ${uploads}`);
  const reread = await createGcsAuthState("office-1", options(gcs));
  assert.equal(Object.keys(await reread.state.keys.get("session", Array.from({ length: 10 }, (_, index) => `contact-${index}`))).length, 10);
});

test("clear deletes the stored state and starts fresh", async () => {
  const gcs = fakeGcs();
  const handle = await createGcsAuthState("office-1", options(gcs));
  handle.state.creds.registered = true;
  await handle.saveCreds();
  await handle.clear!();
  assert.equal(gcs.objects.size, 0);
  assert.equal(handle.state.creds.registered, false);
  await handle.saveCreds();
  assert.equal(gcs.objects.size, 1);
});

test("gets and caches a metadata-server token when none is configured", async () => {
  const gcs = fakeGcs();
  const previous = process.env.WA_GCS_ACCESS_TOKEN;
  delete process.env.WA_GCS_ACCESS_TOKEN;
  let tokenRequests = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("http://metadata.google.internal/")) {
      tokenRequests += 1;
      assert.equal((init?.headers as Record<string, string>)["Metadata-Flavor"], "Google");
      return Response.json({ access_token: "test-token", expires_in: 3600 });
    }
    return gcs.fetch(input, init);
  }) as typeof fetch;
  try {
    const handle = await createGcsAuthState("office-1", options(gcs, { accessToken: undefined, fetch: fetchImpl }));
    await handle.saveCreds();
    await handle.saveCreds();
    assert.equal(tokenRequests, 1);
  } finally {
    if (previous !== undefined) process.env.WA_GCS_ACCESS_TOKEN = previous;
  }
});

test("probe proves write access without touching auth state", async () => {
  const gcs = fakeGcs();
  await probeGcsStorage("office-1", options(gcs));
  assert.equal(gcs.objects.size, 0);
  gcs.hooks.readOnly = true;
  await assert.rejects(probeGcsStorage("office-1", options(gcs)), /read-only/);
});

test("doctor probes GCS storage and reports a read-only identity", async () => {
  const gcs = fakeGcs();
  const settings = {
    WA_STORAGE_BACKEND: "gcs",
    WA_GCS_BUCKET: "bucket",
    WA_GCS_ENDPOINT: "https://gcs.test",
    WA_GCS_ACCESS_TOKEN: "test-token",
    WA_STATE_ENCRYPTION_KEY: masterKey.toString("base64"),
  };
  const previous = Object.fromEntries(Object.keys(settings).map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, settings);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith("https://gcs.test") ? gcs.fetch(input, init) : originalFetch(input, init)) as typeof fetch;
  try {
    const healthy = await diagnoseWhatsApp("office-1");
    assert.deepEqual(healthy.sessionStorage, { backend: "gcs", status: "ok" });
    assert.equal(healthy.redis, "unused");
    assert.equal(healthy.guidance.some((item) => item.code === "WHATSAPP_NOT_PAIRED"), true);

    gcs.hooks.readOnly = true;
    const readOnly = await diagnoseWhatsApp("office-1");
    assert.deepEqual(readOnly.sessionStorage, { backend: "gcs", status: "read_only" });
    assert.equal(readOnly.guidance.some((item) => item.code === "SESSION_STORAGE_READ_ONLY"), true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("doctor reads an injected store without consulting the environment backend", async () => {
  const previous = process.env.WA_STORAGE_BACKEND;
  process.env.WA_STORAGE_BACKEND = "not-a-backend";
  try {
    const gcs = fakeGcs();
    const result = await diagnoseWhatsApp("office-1", { authState: (accountId) => createGcsAuthState(accountId, options(gcs)) });
    assert.deepEqual(result.sessionStorage, { backend: "custom", status: "ok" });
    assert.equal(result.guidance.some((item) => item.code === "INVALID_CONFIGURATION"), false);
    assert.equal(result.guidance.some((item) => item.code === "WHATSAPP_NOT_PAIRED"), true);
  } finally {
    if (previous === undefined) delete process.env.WA_STORAGE_BACKEND;
    else process.env.WA_STORAGE_BACKEND = previous;
  }
});
