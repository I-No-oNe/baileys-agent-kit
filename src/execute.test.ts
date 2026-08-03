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

test("sends image and video items as one WhatsApp album", async () => {
  const calls: unknown[][] = [];
  const socket = {
    async sendMessage(...args: unknown[]) {
      calls.push(args);
      return { key: { id: `message-${calls.length}`, remoteJid: String(args[0]) } };
    },
  } as unknown as WASocket;

  const result = await executeAction(socket, {
    action: "send_album",
    to: "+972 50 123 4567",
    items: [
      { type: "image", url: "https://example.com/one.jpg", caption: "One" },
      { type: "video", url: "https://example.com/two.mp4", caption: "Two" },
    ],
  });

  const parentKey = { id: "message-1", remoteJid: "972501234567@s.whatsapp.net" };
  assert.deepEqual(calls, [
    ["972501234567@s.whatsapp.net", { album: { expectedImageCount: 1, expectedVideoCount: 1 } }],
    ["972501234567@s.whatsapp.net", { image: { url: "https://example.com/one.jpg" }, caption: "One", albumParentKey: parentKey }],
    ["972501234567@s.whatsapp.net", { video: { url: "https://example.com/two.mp4" }, caption: "Two", albumParentKey: parentKey }],
  ]);
  assert.deepEqual(result, {
    albumMessageId: "message-1",
    recipient: "972501234567@s.whatsapp.net",
    messages: [
      { messageId: "message-2", recipient: "972501234567@s.whatsapp.net" },
      { messageId: "message-3", recipient: "972501234567@s.whatsapp.net" },
    ],
  });
});

test("waits for a new matching inbound message and returns reply context", async () => {
  type Upsert = Parameters<Parameters<WASocket["ev"]["on"]>[1]>[0];
  let listener: ((event: Upsert) => void) | undefined;
  const socket = {
    ev: {
      on(event: string, next: (event: Upsert) => void) {
        if (event === "messages.upsert") listener = next;
      },
      off(event: string, current: (event: Upsert) => void) {
        if (event === "messages.upsert" && listener === current) listener = undefined;
      },
    },
  } as unknown as WASocket;

  const waiting = executeAction(socket, {
    action: "wait_for_message",
    from: "120363000000@g.us",
    participant: "+1 (555) 123-4567",
    timeoutSeconds: 30,
  });
  listener?.({
    type: "append",
    messages: [{
      key: { id: "history-1", remoteJid: "120363000000@g.us", fromMe: false },
      message: { conversation: "Old history" },
    }],
  });
  listener?.({
    type: "notify",
    messages: [{
      key: { id: "own-1", remoteJid: "120363000000@g.us", fromMe: true },
      message: { conversation: "Own message" },
    }],
  });
  listener?.({
    type: "notify",
    messages: [{
      key: {
        id: "incoming-1",
        remoteJid: "120363000000@g.us",
        fromMe: false,
        participant: "15551234567@s.whatsapp.net",
      },
      messageTimestamp: 123,
      message: { extendedTextMessage: { text: "Incoming text" } },
    }],
  });

  assert.deepEqual(await waiting, {
    messageId: "incoming-1",
    recipient: "120363000000@g.us",
    participant: "15551234567@s.whatsapp.net",
    timestamp: 123,
    type: "text",
    text: "Incoming text",
    media: null,
    replyTo: {
      recipient: "120363000000@g.us",
      messageId: "incoming-1",
      participant: "15551234567@s.whatsapp.net",
      quotedText: "Incoming text",
    },
  });
  assert.equal(listener, undefined);
});

test("fetches available profile fields for one WhatsApp number", async () => {
  const calls: unknown[][] = [];
  const socket = {
    async onWhatsApp(...args: unknown[]) {
      calls.push(["onWhatsApp", ...args]);
      return [{ jid: "15551234567@s.whatsapp.net", exists: true }];
    },
    async profilePictureUrl(...args: unknown[]) {
      calls.push(["profilePictureUrl", ...args]);
      return "https://pps.whatsapp.net/profile.jpg";
    },
    async fetchStatus(...args: unknown[]) {
      calls.push(["fetchStatus", ...args]);
      return [{ id: "15551234567@s.whatsapp.net", status: { status: "Available", setAt: new Date("2026-08-03T10:00:00.000Z") } }];
    },
    async getBusinessProfile(...args: unknown[]) {
      calls.push(["getBusinessProfile", ...args]);
      return {
        wid: "15551234567@s.whatsapp.net",
        address: "1 Main Street",
        description: "Example business",
        website: ["https://example.com"],
        email: "hello@example.com",
        category: "RETAIL",
        business_hours: { timezone: "Asia/Jerusalem", business_config: [] },
      };
    },
  } as unknown as WASocket;

  const result = await executeAction(socket, { action: "get_profile", number: "+1 (555) 123-4567" });

  assert.deepEqual(calls, [
    ["onWhatsApp", "15551234567@s.whatsapp.net"],
    ["profilePictureUrl", "15551234567@s.whatsapp.net", "image"],
    ["fetchStatus", "15551234567@s.whatsapp.net"],
    ["getBusinessProfile", "15551234567@s.whatsapp.net"],
  ]);
  assert.deepEqual(result, {
    jid: "15551234567@s.whatsapp.net",
    exists: true,
    profilePictureUrl: "https://pps.whatsapp.net/profile.jpg",
    bio: "Available",
    bioUpdatedAt: "2026-08-03T10:00:00.000Z",
    business: {
      address: "1 Main Street",
      description: "Example business",
      websites: ["https://example.com"],
      email: "hello@example.com",
      category: "RETAIL",
      hours: { timezone: "Asia/Jerusalem", business_config: [] },
    },
  });
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
