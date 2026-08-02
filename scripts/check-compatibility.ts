import { DEFAULT_CONNECTION_CONFIG, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";

const latest = await fetchLatestBaileysVersion();
if (!latest.isLatest) throw new Error("Could not fetch the current WhatsApp Web version.", { cause: latest.error });

const bundled = DEFAULT_CONNECTION_CONFIG.version.join(".");
const current = latest.version.join(".");
if (bundled !== current) throw new Error(`Baileys protocol is outdated: bundled ${bundled}, current ${current}.`);
console.log(`WhatsApp compatibility current: ${current}`);
