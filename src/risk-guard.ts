import type { AgentAction } from "./actions";
import { toJid } from "./jid";

export type RiskStorePipeline = {
  get<T>(key: string): RiskStorePipeline;
  set(key: string, value: unknown, options?: { ex?: number }): RiskStorePipeline;
  incr(key: string): RiskStorePipeline;
  incrby(key: string, amount: number): RiskStorePipeline;
  expire(key: string, seconds: number): RiskStorePipeline;
  sadd(key: string, member: string): RiskStorePipeline;
  scard(key: string): RiskStorePipeline;
  sismember(key: string, member: string): RiskStorePipeline;
  exec(): Promise<any[]>;
};

export type RiskStore = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { ex?: number; nx?: boolean }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  pipeline(): RiskStorePipeline;
};

const SEND_ACTIONS = new Set<AgentAction["action"]>([
  "send_text",
  "send_image",
  "send_document",
  "send_location",
  "send_poll",
  "send_album",
  "reply_text",
]);
const GROUP_ADMIN_ACTIONS = new Set<AgentAction["action"]>([
  "create_group",
  "update_group_subject",
  "update_group_participants",
]);

export type RiskConfig = {
  maxSendsPerDay: number;
  maxSendsPerRecipientPerDay: number;
  maxUniqueRecipientsPerDay: number;
  minimumSendIntervalMs: number;
  failureThreshold: number;
  circuitBreakerSeconds: number;
  allowedRecipients: Set<string>;
  groupAdminEnabled: boolean;
};

function integerEnv(name: string, fallback: number, minimum: number, maximum: number, emptyValue = fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!raw.trim()) return emptyValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function riskConfigFromEnv(): RiskConfig {
  const allowedRecipients = new Set(
    (process.env.WA_ALLOWED_RECIPIENTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(toJid),
  );
  return {
    maxSendsPerDay: integerEnv("WA_MAX_SENDS_PER_DAY", 50, 1, 10_000, Infinity),
    maxSendsPerRecipientPerDay: integerEnv("WA_MAX_SENDS_PER_RECIPIENT_PER_DAY", 10, 1, 1_000, Infinity),
    maxUniqueRecipientsPerDay: integerEnv("WA_MAX_UNIQUE_RECIPIENTS_PER_DAY", 20, 1, 1_000, Infinity),
    minimumSendIntervalMs: integerEnv("WA_MINIMUM_SEND_INTERVAL_MS", 3_500, 0, 60_000, 0),
    failureThreshold: integerEnv("WA_FAILURE_THRESHOLD", 3, 1, 20),
    circuitBreakerSeconds: integerEnv("WA_CIRCUIT_BREAKER_SECONDS", 30 * 60, 60, 24 * 60 * 60),
    allowedRecipients,
    groupAdminEnabled: process.env.WA_ENABLE_GROUP_ADMIN === "true",
  };
}

function targets(action: AgentAction): string[] {
  switch (action.action) {
    case "send_text":
    case "send_image":
    case "send_document":
    case "send_location":
    case "send_poll":
      return [toJid(action.to)];
    case "send_album":
      return [toJid(action.to)];
    case "reply_text":
    case "react":
    case "edit_text":
    case "delete_message":
    case "mark_read":
      return [toJid(action.recipient)];
    case "wait_for_message":
      return [toJid(action.from)];
    case "get_profile":
      return [toJid(action.number)];
    case "get_group":
    case "update_group_subject":
    case "update_group_participants":
      return [toJid(action.group)];
    case "create_group":
      return action.participants.map(toJid);
    case "list_recent_accounts":
    case "list_groups":
      return [];
  }
}

function sendAmount(action: AgentAction): number {
  return action.action === "send_album" ? action.items.length : 1;
}

export function isSendAction(action: AgentAction): boolean {
  return SEND_ACTIONS.has(action.action);
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class RiskGuard {
  constructor(
    private readonly store: RiskStore,
    private readonly accountId: string,
    private readonly config: RiskConfig = riskConfigFromEnv(),
  ) {}

  private prefix() {
    return `baileys_agent:${this.accountId}:risk`;
  }

  async reserve(action: AgentAction): Promise<void> {
    const prefix = this.prefix();
    if (GROUP_ADMIN_ACTIONS.has(action.action) && !this.config.groupAdminEnabled) {
      throw new Error("Group administration is disabled. Set WA_ENABLE_GROUP_ADMIN=true to enable it.");
    }

    const actionTargets = targets(action);
    if (this.config.allowedRecipients.size) {
      const blocked = actionTargets.find((target) => !this.config.allowedRecipients.has(target));
      if (blocked) throw new Error(`Recipient ${blocked} is not in WA_ALLOWED_RECIPIENTS.`);
    }
    if (!SEND_ACTIONS.has(action.action)) {
      if (await this.store.get(`${prefix}:circuit_open`)) {
        throw new Error("WhatsApp safety circuit is open after repeated failures. Wait before retrying.");
      }
      return;
    }

    const recipient = actionTargets[0];
    const amount = sendAmount(action);
    const day = new Date().toISOString().slice(0, 10);
    const dailyKey = `${prefix}:${day}:sends`;
    const recipientKey = `${prefix}:${day}:recipient:${recipient}`;
    const recipientsKey = `${prefix}:${day}:recipients`;
    const [circuitOpen, dailyCount, recipientCount, knownRecipient, uniqueRecipients, lastSend] = await this.store
      .pipeline()
      .get<number>(`${prefix}:circuit_open`)
      .get<number>(dailyKey)
      .get<number>(recipientKey)
      .sismember(recipientsKey, recipient)
      .scard(recipientsKey)
      .get<number>(`${prefix}:last_send_at`)
      .exec();

    if (circuitOpen) throw new Error("WhatsApp safety circuit is open after repeated failures. Wait before retrying.");
    if ((dailyCount ?? 0) + amount > this.config.maxSendsPerDay) throw new Error("Daily WhatsApp send limit reached.");
    if ((recipientCount ?? 0) + amount > this.config.maxSendsPerRecipientPerDay) throw new Error(`Daily send limit reached for ${recipient}.`);
    if (!knownRecipient && uniqueRecipients >= this.config.maxUniqueRecipientsPerDay) {
      throw new Error("Daily unique-recipient limit reached.");
    }

    const remainingDelay = lastSend ? this.config.minimumSendIntervalMs - (Date.now() - lastSend) : 0;
    if (remainingDelay > 0) await wait(remainingDelay);

    await this.store
      .pipeline()
      .incrby(dailyKey, amount)
      .expire(dailyKey, 2 * 24 * 60 * 60)
      .incrby(recipientKey, amount)
      .expire(recipientKey, 2 * 24 * 60 * 60)
      .sadd(recipientsKey, recipient)
      .expire(recipientsKey, 2 * 24 * 60 * 60)
      .set(`${prefix}:last_send_at`, Date.now(), { ex: 24 * 60 * 60 })
      .exec();
  }

  async recordSuccess(): Promise<void> {
    await this.store.del(`${this.prefix()}:failures`);
  }

  async recordFailure(): Promise<void> {
    const prefix = this.prefix();
    const [failures] = await this.store
      .pipeline()
      .incr(`${prefix}:failures`)
      .expire(`${prefix}:failures`, 10 * 60)
      .exec();
    if (failures >= this.config.failureThreshold) {
      await this.store.set(`${prefix}:circuit_open`, 1, { ex: this.config.circuitBreakerSeconds });
    }
  }
}
