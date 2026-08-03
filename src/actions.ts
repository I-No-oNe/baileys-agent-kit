import { z } from "zod";

const recipient = z.string().min(1).describe("Phone number with country code, contact JID, or group JID");
const profileNumber = z.string().min(1).refine(
  (value) => !value.includes("@") || value.endsWith("@s.whatsapp.net"),
  "Profile lookup requires a phone number or contact JID.",
).describe("Phone number with country code or contact JID ending in @s.whatsapp.net");
const group = z.string().endsWith("@g.us").describe("WhatsApp group JID ending in @g.us");
const messageId = z.string().min(1);
const participant = z.string().min(1).optional();
const messageKey = { recipient, messageId, participant };
const albumItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), url: z.url(), caption: z.string().max(5000).optional() }),
  z.object({ type: z.literal("video"), url: z.url(), caption: z.string().max(5000).optional() }),
]);

export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send_text"), to: recipient, text: z.string().min(1).max(5000) }),
  z.object({ action: z.literal("send_image"), to: recipient, url: z.url(), caption: z.string().max(5000).optional() }),
  z.object({ action: z.literal("send_document"), to: recipient, url: z.url(), fileName: z.string().min(1), mimeType: z.string().min(1), caption: z.string().max(5000).optional() }),
  z.object({ action: z.literal("send_location"), to: recipient, latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), name: z.string().optional(), address: z.string().optional() }),
  z.object({ action: z.literal("send_poll"), to: recipient, question: z.string().min(1), options: z.array(z.string().min(1)).min(2).max(12), selectableCount: z.number().int().min(1).optional() }),
  z.object({ action: z.literal("send_album"), to: recipient, items: z.array(albumItem).min(2).max(10) }),
  z.object({ action: z.literal("reply_text"), text: z.string().min(1).max(5000), quotedText: z.string().min(1).max(5000), fromMe: z.boolean().optional(), ...messageKey }),
  z.object({ action: z.literal("react"), emoji: z.string().max(16), ...messageKey }),
  z.object({ action: z.literal("edit_text"), text: z.string().min(1).max(5000), ...messageKey }),
  z.object({ action: z.literal("delete_message"), ...messageKey }),
  z.object({ action: z.literal("mark_read"), ...messageKey }),
  z.object({ action: z.literal("wait_for_message"), from: recipient, participant, timeoutSeconds: z.number().int().min(1).max(300).optional() }),
  z.object({ action: z.literal("get_profile"), number: profileNumber }),
  z.object({ action: z.literal("list_recent_accounts"), limit: z.number().int().min(1).max(100).optional(), prefetchSeconds: z.number().int().min(0).max(30).optional() }),
  z.object({ action: z.literal("list_groups") }),
  z.object({ action: z.literal("get_group"), group }),
  z.object({ action: z.literal("create_group"), subject: z.string().min(1).max(100), participants: z.array(recipient).min(1) }),
  z.object({ action: z.literal("update_group_subject"), group, subject: z.string().min(1).max(100) }),
  z.object({ action: z.literal("update_group_participants"), group, participants: z.array(recipient).min(1), operation: z.enum(["add", "remove", "promote", "demote"]) }),
]);

export type AgentAction = z.infer<typeof actionSchema>;

export const llmTool = {
  name: "whatsapp",
  description: "Send, receive, and manage WhatsApp messages and groups through a linked account.",
  inputSchema: { type: "object" as const, ...z.toJSONSchema(actionSchema) },
} as const;
