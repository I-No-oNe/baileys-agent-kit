import type { WASocket, WAMessageKey } from "@whiskeysockets/baileys";
import { actionSchema, type AgentAction } from "./actions";
import { toJid } from "./jid";

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

export async function executeAction(socket: WASocket, input: unknown): Promise<unknown> {
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
