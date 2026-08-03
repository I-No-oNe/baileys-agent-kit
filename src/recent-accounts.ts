import type { BaileysEventMap, WASocket } from "@whiskeysockets/baileys";

const MAX_CAPTURED_ACCOUNTS = 500;

export type RecentAccount = {
  jid: string;
  name: string | null;
  type: "contact" | "group";
  lastActivityAt: number | null;
  unreadCount: number | null;
};

type Entry = RecentAccount;

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return null;
}

export function createRecentAccountsCollector(events: WASocket["ev"]) {
  const entries = new Map<string, Entry>();
  const names = new Map<string, string>();
  let ready: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => { ready = resolve; });

  const upsertChat = (chat: { id?: string | null; name?: string | null; conversationTimestamp?: unknown; lastMessageRecvTimestamp?: unknown; unreadCount?: unknown }) => {
    const jid = chat.id;
    if (!jid || jid.endsWith("@broadcast") || (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid") && !jid.endsWith("@g.us"))) return;
    const existing = entries.get(jid);
    entries.set(jid, {
      jid,
      name: chat.name ?? names.get(jid) ?? existing?.name ?? null,
      type: jid.endsWith("@g.us") ? "group" : "contact",
      lastActivityAt: numberValue(chat.lastMessageRecvTimestamp ?? chat.conversationTimestamp) ?? existing?.lastActivityAt ?? null,
      unreadCount: numberValue(chat.unreadCount) ?? existing?.unreadCount ?? null,
    });
  };

  const upsertContact = (contact: { id?: string; name?: string | null; notify?: string | null; verifiedName?: string | null }) => {
    if (!contact.id) return;
    const name = contact.name ?? contact.verifiedName ?? contact.notify;
    if (!name) return;
    if (names.size < MAX_CAPTURED_ACCOUNTS || names.has(contact.id)) names.set(contact.id, name);
    const existing = entries.get(contact.id);
    if (existing) entries.set(contact.id, { ...existing, name });
  };

  const history = (event: BaileysEventMap["messaging-history.set"]) => {
    event.chats.slice(0, MAX_CAPTURED_ACCOUNTS).forEach(upsertChat);
    event.contacts.forEach(upsertContact);
    if (event.isLatest) ready?.();
  };
  const chats = (items: BaileysEventMap["chats.upsert"] | BaileysEventMap["chats.update"]) => items.forEach(upsertChat);
  const contacts = (items: BaileysEventMap["contacts.upsert"] | BaileysEventMap["contacts.update"]) => items.forEach(upsertContact);
  const historyStatus = (event: BaileysEventMap["messaging-history.status"]) => {
    if (event.status === "complete") ready?.();
  };

  events.on("messaging-history.set", history);
  events.on("messaging-history.status", historyStatus);
  events.on("chats.upsert", chats);
  events.on("chats.update", chats);
  events.on("contacts.upsert", contacts);
  events.on("contacts.update", contacts);

  return {
    async wait(timeoutMs: number) {
      if (timeoutMs > 0) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, timeoutMs);
          void readyPromise.then(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    },
    list(limit: number): RecentAccount[] {
      return [...entries.values()]
        .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
        .slice(0, limit);
    },
    dispose() {
      events.off("messaging-history.set", history);
      events.off("messaging-history.status", historyStatus);
      events.off("chats.upsert", chats);
      events.off("chats.update", chats);
      events.off("contacts.upsert", contacts);
      events.off("contacts.update", contacts);
    },
  };
}
