import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { WASocket } from "@whiskeysockets/baileys";
import { createRecentAccountsCollector } from "./recent-accounts";

test("collects, names, and sorts recent WhatsApp accounts", async () => {
  const events = new EventEmitter() as unknown as WASocket["ev"];
  const collector = createRecentAccountsCollector(events);
  events.emit("messaging-history.set", {
    chats: [
      { id: "15550000001@s.whatsapp.net", conversationTimestamp: 100, unreadCount: 2 },
      { id: "120363000000@g.us", name: "Team", conversationTimestamp: 200 },
      { id: "status@broadcast", conversationTimestamp: 300 },
    ],
    contacts: [{ id: "15550000001@s.whatsapp.net", name: "Ada" }],
    messages: [],
    isLatest: true,
  });
  await collector.wait(1_000);

  assert.deepEqual(collector.list(10), [
    { jid: "120363000000@g.us", name: "Team", type: "group", lastActivityAt: 200, unreadCount: null },
    { jid: "15550000001@s.whatsapp.net", name: "Ada", type: "contact", lastActivityAt: 100, unreadCount: 2 },
  ]);
  collector.dispose();
});
