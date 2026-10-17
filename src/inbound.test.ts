import assert from "node:assert/strict";
import test from "node:test";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { inboundMedia, onIncomingMessage, toInboundMessage } from "./inbound";

type Upsert = Parameters<Parameters<WASocket["ev"]["on"]>[1]>[0];

function fakeSocket() {
  const listeners = new Set<(event: Upsert) => void>();
  const socket = {
    ev: {
      on(event: string, next: (event: Upsert) => void) {
        if (event === "messages.upsert") listeners.add(next);
      },
      off(event: string, current: (event: Upsert) => void) {
        if (event === "messages.upsert") listeners.delete(current);
      },
    },
  } as unknown as WASocket;
  const emit = (messages: WAMessage[], type = "notify") => {
    for (const listener of [...listeners]) listener({ type, messages } as Upsert);
  };
  return { socket, listeners, emit };
}

const received = (id: string, message: WAMessage["message"]): WAMessage => ({
  key: { id, remoteJid: "15551234567@s.whatsapp.net", fromMe: false },
  messageTimestamp: 100,
  message,
});

test("maps each received media kind to metadata without bytes", () => {
  assert.deepEqual(inboundMedia(received("1", { imageMessage: { mimetype: "image/jpeg", fileLength: 2048, caption: "Receipt" } })), {
    kind: "image", mimetype: "image/jpeg", fileName: null, sizeBytes: 2048, caption: "Receipt",
  });
  assert.deepEqual(inboundMedia(received("2", { videoMessage: { mimetype: "video/mp4", fileLength: 9000 } })), {
    kind: "video", mimetype: "video/mp4", fileName: null, sizeBytes: 9000, caption: null,
  });
  assert.deepEqual(inboundMedia(received("3", { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } })), {
    kind: "audio", mimetype: "audio/ogg; codecs=opus", fileName: null, sizeBytes: null, caption: null,
  });
  assert.deepEqual(inboundMedia(received("4", {
    documentWithCaptionMessage: { message: { documentMessage: { mimetype: "application/pdf", fileName: "invoice.pdf", fileLength: 512, caption: "March" } } },
  })), { kind: "document", mimetype: "application/pdf", fileName: "invoice.pdf", sizeBytes: 512, caption: "March" });
  assert.deepEqual(inboundMedia(received("5", { stickerMessage: { mimetype: "image/webp", fileLength: 300 } })), {
    kind: "sticker", mimetype: "image/webp", fileName: null, sizeBytes: 300, caption: null,
  });
  assert.equal(inboundMedia(received("6", { conversation: "Hello" })), null);
});

test("normalizes a media message with its caption as text and no reply context", () => {
  assert.deepEqual(toInboundMessage(received("doc-1", { documentMessage: { mimetype: "application/pdf", fileName: "a.pdf", caption: "See attached" } })), {
    messageId: "doc-1",
    recipient: "15551234567@s.whatsapp.net",
    participant: null,
    timestamp: 100,
    type: "document",
    text: "See attached",
    media: { kind: "document", mimetype: "application/pdf", fileName: "a.pdf", sizeBytes: null, caption: "See attached" },
    replyTo: null,
  });
});

test("hands only messages from others to an incoming-message handler until unsubscribed", () => {
  const { socket, listeners, emit } = fakeSocket();
  const seen: string[] = [];
  const stop = onIncomingMessage({ socket }, (message) => seen.push(`${message.messageId}:${message.type}`));

  emit([
    received("in-1", { conversation: "Hi" }),
    { key: { id: "own-1", remoteJid: "15551234567@s.whatsapp.net", fromMe: true }, message: { conversation: "Mine" } },
    { key: { id: "status-1", remoteJid: "status@broadcast", fromMe: false }, message: { imageMessage: {} } },
  ]);
  emit([received("late-1", { imageMessage: { mimetype: "image/jpeg" } })], "append");
  stop();
  emit([received("in-2", { conversation: "After" })]);

  assert.deepEqual(seen, ["in-1:text", "late-1:image"]);
  assert.equal(listeners.size, 0);
});
