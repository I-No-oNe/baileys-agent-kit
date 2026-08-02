import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { createUpstashAuthState } from "./auth/upstash";
import { createCoalescedSaver } from "./coalesced-saver";
import { PAIRING_QR_TTL_MS } from "./pairing/constants";

export type PairingBroker = { url: string; secret: string };
export type PairWhatsAppOptions = {
  accountId?: string;
  broker?: PairingBroker;
  timeoutMs?: number;
  onQr?: (qr: string) => void | Promise<void>;
  onShareUrl?: (url: string) => void | Promise<void>;
};

async function brokerRequest(broker: PairingBroker, body: unknown) {
  const response = await fetch(`${broker.url.replace(/\/$/, "")}/api/pairing`, {
    method: "POST",
    headers: { Authorization: `Bearer ${broker.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Pairing broker returned HTTP ${response.status}.`);
  return result as Record<string, unknown>;
}

export function pairingBrokerFromEnv(): PairingBroker | undefined {
  const url = process.env.PAIRING_BROKER_URL;
  const secret = process.env.PAIRING_BROKER_SECRET;
  if (!url && !secret) return undefined;
  if (!url || !secret) throw new Error("PAIRING_BROKER_URL and PAIRING_BROKER_SECRET must be configured together.");
  return { url, secret };
}

export async function pairWhatsApp(options: PairWhatsAppOptions = {}): Promise<void> {
  const { state, saveCreds } = await createUpstashAuthState(options.accountId);
  const { version } = await fetchLatestBaileysVersion();
  const credentialSaver = createCoalescedSaver(saveCreds);
  const brokerSession = options.broker
    ? await brokerRequest(options.broker, { operation: "create" })
    : undefined;
  const brokerId = brokerSession ? String(brokerSession.id) : undefined;
  if (brokerSession && options.onShareUrl) await options.onShareUrl(String(brokerSession.shareUrl));

  let finished = false;
  let socket: ReturnType<typeof makeWASocket> | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      timeout = setTimeout(() => finish(new Error("WhatsApp pairing timed out.")), options.timeoutMs ?? 10 * 60_000);

      const connect = () => {
        socket = makeWASocket({ auth: state, version, markOnlineOnConnect: false, syncFullHistory: false, qrTimeout: PAIRING_QR_TTL_MS });
        socket.ev.on("creds.update", credentialSaver.schedule);
        socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
          if (finished) return;
          try {
            if (qr) {
              await Promise.all([
                brokerId && options.broker
                  ? brokerRequest(options.broker, { operation: "update", id: brokerId, qr })
                  : undefined,
                options.onQr?.(qr),
              ]);
            }
            if (connection === "open") {
              await credentialSaver.flush();
              await saveCreds();
              if (brokerId && options.broker) {
                await brokerRequest(options.broker, { operation: "update", id: brokerId, status: "connected" });
              }
              finish();
            } else if (connection === "close") {
              const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
              if (status === DisconnectReason.loggedOut) {
                finish(new Error("WhatsApp rejected the session. Clear this account's auth keys and try again."));
              } else {
                connect();
              }
            }
          } catch (error) {
            finish(error);
          }
        });
      };
      connect();
    });
  } catch (error) {
    if (brokerId && options.broker) {
      await brokerRequest(options.broker, {
        operation: "update",
        id: brokerId,
        status: "failed",
        message: error instanceof Error ? error.message : "Pairing failed.",
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (socket) await socket.end(undefined).catch(() => undefined);
  }
}
