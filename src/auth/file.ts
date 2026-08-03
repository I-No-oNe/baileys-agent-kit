import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { localStatePath, readOptionalFile, validateAccountId, writePrivateFile } from "../local-files";

type StoredAuth = {
  version: 1;
  creds: AuthenticationState["creds"];
  keys: Record<string, Record<string, unknown>>;
};

const encode = (value: unknown) => JSON.stringify(value, BufferJSON.replacer);
const decode = <T>(value: string) => JSON.parse(value, BufferJSON.reviver) as T;

export async function createFileAuthState(accountId = process.env.WA_ACCOUNT_ID ?? "default"): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  validateAccountId(accountId);
  const path = localStatePath(accountId, "auth.json");
  const storedFile = await readOptionalFile(path);
  const stored = storedFile
    ? decode<StoredAuth>(storedFile.toString("utf8"))
    : { version: 1 as const, creds: initAuthCreds(), keys: {} };
  if (stored.version !== 1) throw new Error("Local WhatsApp auth state uses an unsupported version.");
  let pending = Promise.resolve();

  const persist = () => {
    const task = pending.then(
      () => writePrivateFile(path, encode(stored)),
      () => writePrivateFile(path, encode(stored)),
    );
    pending = task.catch(() => undefined);
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

  return { state, saveCreds: persist };
}
