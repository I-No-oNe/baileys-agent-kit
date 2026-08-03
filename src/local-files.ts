import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { lock } from "proper-lockfile";

export function validateAccountId(accountId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(accountId)) throw new Error("WA_ACCOUNT_ID contains unsupported characters.");
  return accountId;
}

export function localStateDirectory(): string {
  const configured = process.env.WA_STATE_DIR ?? process.env.WA_LOCAL_STATE_DIR;
  if (configured) return resolve(configured);
  if (process.env.XDG_STATE_HOME) return resolve(process.env.XDG_STATE_HOME, "baileys-agent-kit");
  if (process.platform === "win32") return resolve(process.env.LOCALAPPDATA ?? homedir(), "baileys-agent-kit");
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Application Support", "baileys-agent-kit");
  return resolve(homedir(), ".local", "state", "baileys-agent-kit");
}

export function localStatePath(accountId: string, suffix: string): string {
  return resolve(localStateDirectory(), `${validateAccountId(accountId)}.${suffix}`);
}

export async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`Local state path is not a regular file: ${path}`);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensurePrivateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`Local state directory is unsafe: ${directory}`);
  await chmod(directory, 0o700);
}

export async function writePrivateFile(path: string, contents: string | Buffer): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const existing = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`Local state path is unsafe: ${path}`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directoryHandle = await open(directory, "r").catch(() => undefined);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function probeLocalStateDirectory(): Promise<void> {
  const path = resolve(localStateDirectory(), `.doctor-${randomUUID()}`);
  await writePrivateFile(path, "ok");
  await unlink(path);
}

export async function acquireLocalAccountLock(accountId: string): Promise<() => Promise<void>> {
  const path = localStatePath(accountId, "account");
  await ensurePrivateDirectory(dirname(path));
  try {
    return await lock(path, { realpath: false, stale: 30_000, update: 10_000, retries: 0 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error(`Another WhatsApp action is running for account '${accountId}'.`);
    }
    throw error;
  }
}
