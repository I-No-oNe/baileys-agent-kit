import {
  normalizeMessageContent,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import { actionSchema, type AgentAction } from "./actions";
import { toJid } from "./jid";
import type { RecentAccount } from "./recent-accounts";

export class MessageWaitTimeoutError extends Error {}

function key(action: { recipient: string; messageId: string; participant?: string }): WAMessageKey {
  const remoteJid = toJid(action.recipient);
  return {
    remoteJid,
    id: action.messageId,
    fromMe: true,
    participant: action.participant ? toJid(action.participant) : undefined,
  };
}

function messageResult(message: Awaited<ReturnType<WASocket["sendMessage"]>>) {
  return { messageId: message?.key.id ?? null, recipient: message?.key.remoteJid ?? null };
}

function receivedContent(message: WAMessage) {
  const content = normalizeMessageContent(message.message);
  if (content?.conversation) return { type: "text", text: content.conversation, media: null };
  if (content?.extendedTextMessage?.text) return { type: "text", text: content.extendedTextMessage.text, media: null };
  if (content?.imageMessage) return {
    type: "image",
    text: content.imageMessage.caption ?? null,
    media: { mimetype: content.imageMessage.mimetype ?? null, fileName: null },
  };
  if (content?.videoMessage) return {
    type: "video",
    text: content.videoMessage.caption ?? null,
    media: { mimetype: content.videoMessage.mimetype ?? null, fileName: null },
  };
  if (content?.audioMessage) return {
    type: "audio",
    text: null,
    media: { mimetype: content.audioMessage.mimetype ?? null, fileName: null },
  };
  if (content?.documentMessage) return {
    type: "document",
    text: content.documentMessage.caption ?? null,
    media: { mimetype: content.documentMessage.mimetype ?? null, fileName: content.documentMessage.fileName ?? null },
  };
  if (content?.stickerMessage) return {
    type: "sticker",
    text: null,
    media: { mimetype: content.stickerMessage.mimetype ?? null, fileName: null },
  };
  return { type: "unknown", text: null, media: null };
}

function waitForMessage(
  socket: WASocket,
  action: Extract<AgentAction, { action: "wait_for_message" }>,
): Promise<unknown> {
  const recipient = toJid(action.from);
  const expectedParticipant = action.participant ? toJid(action.participant) : undefined;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.ev.off("messages.upsert", listener);
    };
    const listener = (event: BaileysEventMap["messages.upsert"]) => {
      if (event.type !== "notify") return;
      for (const message of event.messages) {
        if (message.key.fromMe || !message.key.id) continue;
        const chats = [message.key.remoteJid, message.key.remoteJidAlt].filter(Boolean);
        if (!chats.includes(recipient)) continue;
        const participants = [message.key.participantAlt, message.key.participant, message.participant].filter(Boolean);
        if (expectedParticipant && !participants.includes(expectedParticipant)) continue;

        const participant = expectedParticipant ?? participants[0] ?? null;
        const content = receivedContent(message);
        cleanup();
        resolve({
          messageId: message.key.id,
          recipient,
          participant,
          timestamp: message.messageTimestamp == null ? null : Number(message.messageTimestamp),
          ...content,
          replyTo: content.type === "text" && content.text
            ? {
                recipient,
                messageId: message.key.id,
                ...(participant ? { participant } : {}),
                quotedText: content.text,
              }
            : null,
        });
        return;
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new MessageWaitTimeoutError("Timed out waiting for a new matching WhatsApp message."));
    }, (action.timeoutSeconds ?? 120) * 1_000);
    socket.ev.on("messages.upsert", listener);
  });
}

export async function executeAction(socket: WASocket, input: unknown, context: { recentAccounts?: RecentAccount[] } = {}): Promise<unknown> {
  const action: AgentAction = actionSchema.parse(input);

  switch (action.action) {
    case "send_text":
      return messageResult(await socket.sendMessage(toJid(action.to), { text: action.text }));
    case "send_image":
      return messageResult(await socket.sendMessage(toJid(action.to), { image: { url: action.url }, caption: action.caption }));
    case "send_document":
      return messageResult(await socket.sendMessage(toJid(action.to), { document: { url: action.url }, fileName: action.fileName, mimetype: action.mimeType, caption: action.caption }));
    case "send_location":
      return messageResult(await socket.sendMessage(toJid(action.to), { location: { degreesLatitude: action.latitude, degreesLongitude: action.longitude, name: action.name, address: action.address } }));
    case "send_poll":
      return messageResult(await socket.sendMessage(toJid(action.to), { poll: { name: action.question, values: action.options, selectableCount: action.selectableCount ?? 1 } }));
    case "send_album": {
      const recipient = toJid(action.to);
      const expectedImageCount = action.items.filter((item) => item.type === "image").length;
      const expectedVideoCount = action.items.filter((item) => item.type === "video").length;
      const parent = await socket.sendMessage(recipient, {
        album: {
          ...(expectedImageCount ? { expectedImageCount } : {}),
          ...(expectedVideoCount ? { expectedVideoCount } : {}),
        },
      });
      if (!parent) throw new Error("WhatsApp did not create the album parent message.");
      const messages = [];
      for (const item of action.items) {
        const content = item.type === "image"
          ? { image: { url: item.url }, caption: item.caption, albumParentKey: parent.key }
          : { video: { url: item.url }, caption: item.caption, albumParentKey: parent.key };
        messages.push(messageResult(await socket.sendMessage(recipient, content)));
      }
      return {
        albumMessageId: parent.key.id ?? null,
        recipient: parent.key.remoteJid ?? null,
        messages,
      };
    }
    case "reply_text":
      return messageResult(await socket.sendMessage(
        toJid(action.recipient),
        { text: action.text },
        {
          quoted: {
            key: { ...key(action), fromMe: action.fromMe ?? false },
            message: { conversation: action.quotedText },
          },
        },
      ));
    case "react":
      return messageResult(await socket.sendMessage(toJid(action.recipient), { react: { text: action.emoji, key: key(action) } }));
    case "edit_text":
      return messageResult(await socket.sendMessage(toJid(action.recipient), { text: action.text, edit: key(action) }));
    case "delete_message":
      return messageResult(await socket.sendMessage(toJid(action.recipient), { delete: key(action) }));
    case "mark_read":
      await socket.readMessages([key(action)]);
      return { ok: true };
    case "wait_for_message":
      return waitForMessage(socket, action);
    case "get_profile": {
      const requestedJid = toJid(action.number);
      const registration = await socket.onWhatsApp(requestedJid).catch(() => undefined);
      const registeredAccount = registration?.[0];
      const exists = registration ? registeredAccount?.exists ?? false : null;
      const jid = registeredAccount?.jid ?? requestedJid;
      if (exists === false) {
        return { jid, exists, profilePictureUrl: null, bio: null, bioUpdatedAt: null, business: null };
      }

      const [pictureResult, statusResult, businessResult] = await Promise.allSettled([
        socket.profilePictureUrl(jid, "image"),
        socket.fetchStatus(jid),
        socket.getBusinessProfile(jid),
      ]);
      const profilePictureUrl = pictureResult.status === "fulfilled" ? pictureResult.value ?? null : null;
      const statusEntry = statusResult.status === "fulfilled" ? statusResult.value?.[0] : undefined;
      const status = statusEntry?.status as { status?: unknown; setAt?: unknown } | undefined;
      const business = businessResult.status === "fulfilled" ? businessResult.value : undefined;
      return {
        jid,
        exists,
        profilePictureUrl,
        bio: typeof status?.status === "string" && status.status ? status.status : null,
        bioUpdatedAt: status?.setAt instanceof Date ? status.setAt.toISOString() : null,
        business: business
          ? {
              address: business.address ?? null,
              description: business.description || null,
              websites: business.website ?? [],
              email: business.email ?? null,
              category: business.category ?? null,
              hours: business.business_hours ?? null,
            }
          : null,
      };
    }
    case "list_recent_accounts":
      return (context.recentAccounts ?? []).slice(0, action.limit ?? 20);
    case "list_groups": {
      const groups = await socket.groupFetchAllParticipating();
      return Object.values(groups).map(({ id, subject, owner, size }) => ({ id, subject, owner, size }));
    }
    case "get_group": {
      const group = await socket.groupMetadata(toJid(action.group));
      return { id: group.id, subject: group.subject, owner: group.owner, size: group.size, participants: group.participants };
    }
    case "create_group": {
      const group = await socket.groupCreate(action.subject, action.participants.map(toJid));
      return { id: group.id, subject: group.subject };
    }
    case "update_group_subject":
      await socket.groupUpdateSubject(toJid(action.group), action.subject);
      return { ok: true };
    case "update_group_participants":
      return socket.groupParticipantsUpdate(toJid(action.group), action.participants.map(toJid), action.operation);
  }
}
