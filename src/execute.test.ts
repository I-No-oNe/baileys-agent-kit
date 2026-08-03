import assert from "node:assert/strict";
import test from "node:test";
import type { WASocket } from "@whiskeysockets/baileys";
import { executeAction } from "./execute";

test("maps a simple LLM text action to Baileys", async () => {
  const calls: unknown[][] = [];
  const socket = {
    async sendMessage(...args: unknown[]) {
      calls.push(args);
      return { key: { id: "message-1", remoteJid: String(args[0]) } };
    },
  } as unknown as WASocket;

  const result = await executeAction(socket, {
    action: "send_text",
    to: "+972 50 123 4567",
    text: "Hello",
  });

  assert.deepEqual(calls, [["972501234567@s.whatsapp.net", { text: "Hello" }]]);
  assert.deepEqual(result, { messageId: "message-1", recipient: "972501234567@s.whatsapp.net" });
});

test("maps a text reply to Baileys quoted-message options", async () => {
  const calls: unknown[][] = [];
  const socket = {
    async sendMessage(...args: unknown[]) {
      calls.push(args);
      return { key: { id: "reply-1", remoteJid: String(args[0]) } };
    },
  } as unknown as WASocket;

  const result = await executeAction(socket, {
    action: "reply_text",
    recipient: "120363000000@g.us",
    messageId: "quoted-message-1",
    participant: "+1 (555) 123-4567",
    quotedText: "Original message",
    text: "Reply",
  });

  assert.deepEqual(calls, [[
    "120363000000@g.us",
    { text: "Reply" },
    {
      quoted: {
        key: {
          remoteJid: "120363000000@g.us",
          id: "quoted-message-1",
          fromMe: false,
          participant: "15551234567@s.whatsapp.net",
        },
        message: { conversation: "Original message" },
      },
    },
  ]]);
  assert.deepEqual(result, { messageId: "reply-1", recipient: "120363000000@g.us" });
});

test("maps group participant updates and normalizes phone numbers", async () => {
  const calls: unknown[][] = [];
  const socket = {
    async groupParticipantsUpdate(...args: unknown[]) {
      calls.push(args);
      return [{ status: "200" }];
    },
  } as unknown as WASocket;

  const result = await executeAction(socket, {
    action: "update_group_participants",
    group: "120363000000@g.us",
    participants: ["+1 (555) 123-4567"],
    operation: "add",
  });

  assert.deepEqual(calls, [["120363000000@g.us", ["15551234567@s.whatsapp.net"], "add"]]);
  assert.deepEqual(result, [{ status: "200" }]);
});
