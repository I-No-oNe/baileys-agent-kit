import { Redis } from "@upstash/redis";
import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { requiredEnv } from "../env";
import { validateAccountId } from "../local-files";

const encode = (value: unknown) => JSON.stringify(value, BufferJSON.replacer);
const decode = <T>(value: string) => JSON.parse(value, BufferJSON.reviver) as T;

export async function createUpstashAuthState(accountId = process.env.WA_ACCOUNT_ID ?? "default"): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  validateAccountId(accountId);

  const redis = new Redis({
    url: requiredEnv("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"),
    token: requiredEnv("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"),
    automaticDeserialization: false,
  });
  const prefix = `baileys_agent:${accountId}:auth:`;
  const storedCreds = await redis.get<string>(`${prefix}creds`);
  const creds = storedCreds ? decode<AuthenticationState["creds"]>(storedCreds) : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        if (!ids.length) return {};
        const keys = ids.map((id) => `${prefix}${type}:${id}`);
        const values = await redis.mget<(string | null)[]>(keys);
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        values.forEach((value, index) => {
          if (value) result[ids[index]] = decode<SignalDataTypeMap[T]>(value);
        });
        return result;
      },
      async set(data: SignalDataSet) {
        const pipeline = redis.pipeline();
        let writes = 0;
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries ?? {})) {
            const key = `${prefix}${type}:${id}`;
            if (value === null) pipeline.del(key);
            else pipeline.set(key, encode(value));
            writes += 1;
          }
        }
        if (writes) await pipeline.exec();
      },
    },
  };

  return {
    state,
    saveCreds: () => redis.set(`${prefix}creds`, encode(state.creds)).then(() => undefined),
  };
}
