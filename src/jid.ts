export function toJid(value: string): string {
  const candidate = value.trim();
  if (candidate.endsWith("@s.whatsapp.net") || candidate.endsWith("@g.us")) return candidate;

  const phone = candidate.replace(/[^0-9]/g, "");
  if (!phone) throw new Error("Recipient must be a phone number or WhatsApp JID.");
  return `${phone}@s.whatsapp.net`;
}
