import { createHash } from "node:crypto";
import {
  downloadMediaMessage,
  isJidStatusBroadcast,
  normalizeMessageContent,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { MAX_INLINE_DOCUMENT_BYTES } from "./actions";
import { createBaileysLogger } from "./baileys-logger";

/** How many received media messages each connection remembers for download_media. */
export const RECENT_MEDIA_LIMIT = 200;

const MEDIA_KINDS = ["image", "video", "audio", "document", "sticker"] as const;

export type InboundMediaKind = (typeof MEDIA_KINDS)[number];

/** What a received media message carries, without its bytes. */
export type InboundMedia = {
  kind: InboundMediaKind;
  mimetype: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  caption: string | null;
};

/** A received message as wait_for_message and onIncomingMessage return it. */
export type InboundMessage = {
  messageId: string;
  recipient: string;
  participant: string | null;
  timestamp: number | null;
  type: "text" | InboundMediaKind | "unknown";
  text: string | null;
  media: InboundMedia | null;
  replyTo: { recipient: string; messageId: string; participant?: string; quotedText: string } | null;
};

export function inboundMedia(message: WAMessage): InboundMedia | null {
  const content = normalizeMessageContent(message.message);
  for (const kind of MEDIA_KINDS) {
    const media = content?.[`${kind}Message`];
    if (!media) continue;
    return {
      kind,
      mimetype: media.mimetype ?? null,
      fileName: "fileName" in media ? media.fileName ?? null : null,
      // fileLength is a protobuf Long on the wire and a number once decoded to JSON.
      sizeBytes: media.fileLength == null ? null : Number(media.fileLength.toString()),
      caption: "caption" in media ? media.caption ?? null : null,
    };
  }
  return null;
}

function receivedContent(message: WAMessage): Pick<InboundMessage, "type" | "text" | "media"> {
  const content = normalizeMessageContent(message.message);
  if (content?.conversation) return { type: "text", text: content.conversation, media: null };
  if (content?.extendedTextMessage?.text) return { type: "text", text: content.extendedTextMessage.text, media: null };
  const media = inboundMedia(message);
  if (media) return { type: media.kind, text: media.caption, media };
  return { type: "unknown", text: null, media: null };
}

export function messageParticipants(message: WAMessage): string[] {
  return [message.key.participantAlt, message.key.participant, message.participant].filter((jid): jid is string => Boolean(jid));
}

export function toInboundMessage(
  message: WAMessage,
  recipient = message.key.remoteJid ?? "",
  participant = messageParticipants(message)[0] ?? null,
): InboundMessage {
  const messageId = message.key.id ?? "";
  const content = receivedContent(message);
  return {
    messageId,
    recipient,
    participant,
    timestamp: message.messageTimestamp == null ? null : Number(message.messageTimestamp),
    ...content,
    replyTo: content.type === "text" && content.text
      ? { recipient, messageId, ...(participant ? { participant } : {}), quotedText: content.text }
      : null,
  };
}

/** Sent by someone else to a chat, not a status update or the linked account's own message. */
export function isInbound(message: WAMessage): boolean {
  return Boolean(message.key.id) && !message.key.fromMe && !isJidStatusBroadcast(message.key.remoteJid ?? "");
}

const recentMedia = new WeakMap<WASocket, Map<string, WAMessage>>();

/**
 * Keeps the last RECENT_MEDIA_LIMIT media messages this socket receives, so download_media can
 * fetch them. Only messages that arrive while the socket is open are ever available.
 */
export function rememberInboundMedia(socket: WASocket): void {
  if (recentMedia.has(socket)) return;
  const cache = new Map<string, WAMessage>();
  recentMedia.set(socket, cache);
  socket.ev.on("messages.upsert", ({ messages }) => {
    for (const message of messages) {
      if (!isInbound(message) || !inboundMedia(message)) continue;
      cache.delete(message.key.id!);
      cache.set(message.key.id!, message);
      if (cache.size > RECENT_MEDIA_LIMIT) cache.delete(cache.keys().next().value!);
    }
  });
}

export function findInboundMedia(socket: WASocket, chat: string, messageId: string): WAMessage | undefined {
  const cache = recentMedia.get(socket);
  const message = cache?.get(messageId);
  if (!cache || !message || ![message.key.remoteJid, message.key.remoteJidAlt].includes(chat)) return undefined;
  cache.delete(messageId);
  cache.set(messageId, message);
  return message;
}

type MediaDownloader = (
  message: WAMessage,
  context: { reuploadRequest: WASocket["updateMediaMessage"]; logger: ReturnType<typeof createBaileysLogger> },
) => Promise<Buffer>;

const downloadBuffer: MediaDownloader = (message, context) => downloadMediaMessage(message, "buffer", {}, context);

function tooLarge(sizeBytes: number) {
  return new Error(`Media is ${sizeBytes} bytes, above the ${MAX_INLINE_DOCUMENT_BYTES}-byte (32 MiB) download_media limit.`);
}

/** Downloads a received file, asking the sender's phone to upload it again when WhatsApp has expired it. */
export async function downloadInboundMedia(socket: WASocket, message: WAMessage, download = downloadBuffer) {
  const media = inboundMedia(message);
  if (!media) throw new Error("The message has no image, video, audio, document, or sticker to download.");
  if (media.sizeBytes !== null && media.sizeBytes > MAX_INLINE_DOCUMENT_BYTES) throw tooLarge(media.sizeBytes);
  const data = await download(message, { reuploadRequest: socket.updateMediaMessage, logger: createBaileysLogger() });
  if (data.length > MAX_INLINE_DOCUMENT_BYTES) throw tooLarge(data.length);
  return {
    mimetype: media.mimetype,
    fileName: media.fileName,
    sizeBytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    data: data.toString("base64"),
  };
}

/**
 * Calls handler with every message others send to the linked account, including ones WhatsApp
 * delivers late after a reconnect. Returns a function that stops listening.
 */
export function onIncomingMessage(
  connection: { socket: WASocket },
  handler: (message: InboundMessage) => void,
): () => void {
  const { socket } = connection;
  rememberInboundMedia(socket);
  const listener = ({ messages }: BaileysEventMap["messages.upsert"]) => {
    for (const message of messages) {
      if (isInbound(message)) handler(toInboundMessage(message));
    }
  };
  socket.ev.on("messages.upsert", listener);
  return () => socket.ev.off("messages.upsert", listener);
}
