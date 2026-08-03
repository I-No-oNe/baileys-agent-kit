import { localStatePath, readOptionalFile, writePrivateFile } from "./local-files";
import type { RiskStore, RiskStorePipeline } from "./risk-guard";

type ValueEntry = { value: unknown; expiresAt?: number };
type SetEntry = { values: string[]; expiresAt?: number };
type StoredRiskState = { values: Record<string, ValueEntry>; sets: Record<string, SetEntry> };

export class FileRiskStore implements RiskStore {
  private pending = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly data: StoredRiskState,
  ) {}

  static async create(accountId: string): Promise<FileRiskStore> {
    const path = localStatePath(accountId, "risk.json");
    const stored = await readOptionalFile(path);
    const data = stored
      ? JSON.parse(stored.toString("utf8")) as StoredRiskState
      : { values: {}, sets: {} };
    return new FileRiskStore(path, data);
  }

  private cleanKey(key: string) {
    const now = Date.now();
    if (this.data.values[key]?.expiresAt && this.data.values[key].expiresAt! <= now) delete this.data.values[key];
    if (this.data.sets[key]?.expiresAt && this.data.sets[key].expiresAt! <= now) delete this.data.sets[key];
  }

  private persist() {
    const task = this.pending.then(
      () => writePrivateFile(this.path, JSON.stringify(this.data)),
      () => writePrivateFile(this.path, JSON.stringify(this.data)),
    );
    this.pending = task.catch(() => undefined);
    return task;
  }

  private getValue<T>(key: string): T | null {
    this.cleanKey(key);
    return this.data.values[key]?.value as T ?? null;
  }

  private setValue(key: string, value: unknown, options?: { ex?: number; nx?: boolean }) {
    this.cleanKey(key);
    if (options?.nx && this.data.values[key] !== undefined) return null;
    this.data.values[key] = { value, ...(options?.ex ? { expiresAt: Date.now() + options.ex * 1_000 } : {}) };
    return "OK";
  }

  private deleteKey(key: string) {
    const existed = this.data.values[key] !== undefined || this.data.sets[key] !== undefined;
    delete this.data.values[key];
    delete this.data.sets[key];
    return existed ? 1 : 0;
  }

  private increment(key: string, amount: number) {
    const value = Number(this.getValue(key) ?? 0) + amount;
    this.data.values[key] = { value };
    return value;
  }

  private expireKey(key: string, seconds: number) {
    this.cleanKey(key);
    const expiresAt = Date.now() + seconds * 1_000;
    if (this.data.values[key]) this.data.values[key].expiresAt = expiresAt;
    else if (this.data.sets[key]) this.data.sets[key].expiresAt = expiresAt;
    else return 0;
    return 1;
  }

  private addSetMember(key: string, member: string) {
    this.cleanKey(key);
    const entry = this.data.sets[key] ?? { values: [] };
    const existed = entry.values.includes(member);
    if (!existed) entry.values.push(member);
    this.data.sets[key] = entry;
    return existed ? 0 : 1;
  }

  async get<T>(key: string): Promise<T | null> {
    return this.getValue<T>(key);
  }

  async set(key: string, value: unknown, options?: { ex?: number; nx?: boolean }) {
    const result = this.setValue(key, value, options);
    if (result) await this.persist();
    return result;
  }

  async del(key: string) {
    const result = this.deleteKey(key);
    if (result) await this.persist();
    return result;
  }

  pipeline(): RiskStorePipeline {
    const commands: Array<() => unknown> = [];
    let mutates = false;
    const pipeline = {} as RiskStorePipeline;
    pipeline.get = <T,>(key: string) => { commands.push(() => this.getValue<T>(key)); return pipeline; };
    pipeline.set = (key, value, options) => { mutates = true; commands.push(() => this.setValue(key, value, options)); return pipeline; };
    pipeline.incr = (key) => { mutates = true; commands.push(() => this.increment(key, 1)); return pipeline; };
    pipeline.incrby = (key, amount) => { mutates = true; commands.push(() => this.increment(key, amount)); return pipeline; };
    pipeline.expire = (key, seconds) => { mutates = true; commands.push(() => this.expireKey(key, seconds)); return pipeline; };
    pipeline.sadd = (key, member) => { mutates = true; commands.push(() => this.addSetMember(key, member)); return pipeline; };
    pipeline.scard = (key) => { commands.push(() => { this.cleanKey(key); return this.data.sets[key]?.values.length ?? 0; }); return pipeline; };
    pipeline.sismember = (key, member) => { commands.push(() => { this.cleanKey(key); return this.data.sets[key]?.values.includes(member) ?? false; }); return pipeline; };
    pipeline.exec = async () => {
      const results = commands.map((command) => command());
      if (mutates) await this.persist();
      return results;
    };
    return pipeline;
  }
}
