import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidStatusBroadcast,
  proto,
  type WASocket,
} from "@whiskeysockets/baileys";
import { createUpstashAuthState } from "./auth/upstash";
import { createCoalescedSaver } from "./coalesced-saver";

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class NonRetryableConnectionError extends Error {}

export async function connectWhatsApp(options: { attempts?: number; timeoutMs?: number } = {}): Promise<{
  socket: WASocket;
  close: () => Promise<void>;
}> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { state, saveCreds } = await createUpstashAuthState();
  if (!state.creds.registered && !state.creds.me) throw new Error("WhatsApp is not linked. Run npm run wa:pair.");

  const { version, isLatest } = await fetchLatestBaileysVersion();
  if (!isLatest) console.warn("Could not fetch the latest WhatsApp protocol version; using Baileys' bundled fallback.");
  const credentialSaver = createCoalescedSaver(saveCreds);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const socket = makeWASocket({
      auth: state,
      version,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: isJidStatusBroadcast,
      shouldSyncHistoryMessage: ({ syncType }) => syncType === proto.HistorySync.HistorySyncType.ON_DEMAND
        || syncType === proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
    });
    socket.ev.on("creds.update", () => {
      credentialSaver.schedule();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out connecting to WhatsApp.")), timeoutMs);
        socket.ev.on("connection.update", ({ connection, lastDisconnect }) => {
          if (connection === "open") {
            clearTimeout(timeout);
            resolve();
          } else if (connection === "close") {
            clearTimeout(timeout);
            const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
            if (status === DisconnectReason.loggedOut) {
              reject(new NonRetryableConnectionError("WhatsApp session logged out. Pair again."));
            } else if (status === 405) {
              reject(new NonRetryableConnectionError("WhatsApp rejected this protocol version (HTTP 405). Update Baileys and run the compatibility check."));
            } else {
              reject(lastDisconnect?.error ?? new Error("Connection closed."));
            }
          }
        });
      });
      return {
        socket,
        close: async () => {
          await credentialSaver.flush();
          await saveCreds();
          await socket.end(undefined);
        },
      };
    } catch (error) {
      await socket.end(undefined).catch(() => undefined);
      await credentialSaver.flush();
      if (error instanceof NonRetryableConnectionError || attempt === attempts) throw error;
      await delay(attempt * 5_000);
    }
  }

  throw new Error("Unable to connect to WhatsApp.");
}
