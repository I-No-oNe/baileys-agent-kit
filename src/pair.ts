import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { createUpstashAuthState } from "./auth/upstash";
import { createCoalescedSaver } from "./coalesced-saver";
import { PAIRING_QR_TTL_MS } from "./pairing/constants";

export type PairingBroker = { url: string; secret: string };
export type BrokerPairingSession = { id: string; shareUrl: string };
export type PairWhatsAppOptions = {
  accountId?: string;
  broker?: PairingBroker;
  brokerSessionId?: string;
  manualQrRefresh?: boolean;
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

export async function createBrokerPairingSession(broker: PairingBroker): Promise<BrokerPairingSession> {
  const session = await brokerRequest(broker, { operation: "create" });
  return { id: String(session.id), shareUrl: String(session.shareUrl) };
}

export async function pairWhatsApp(options: PairWhatsAppOptions = {}): Promise<void> {
  if (options.manualQrRefresh && (!options.broker || !options.brokerSessionId)) {
    throw new Error("Manual QR refresh requires a pre-created pairing broker session.");
  }
  const { state, saveCreds } = await createUpstashAuthState(options.accountId);
  const { version } = await fetchLatestBaileysVersion();
  const credentialSaver = createCoalescedSaver(saveCreds);
  const pairingTimeoutMs = options.timeoutMs ?? 10 * 60_000;
  const brokerSession = options.broker && !options.brokerSessionId
    ? await createBrokerPairingSession(options.broker)
    : undefined;
  const brokerId = options.brokerSessionId ?? brokerSession?.id;
  if (brokerSession && options.onShareUrl) await options.onShareUrl(brokerSession.shareUrl);

  let finished = false;
  let socket: ReturnType<typeof makeWASocket> | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      let refreshTimer: ReturnType<typeof setInterval> | undefined;
      let socketGeneration = 0;
      let refreshCheckRunning = false;
      let lastRefreshRequestedAt = 0;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (refreshTimer) clearInterval(refreshTimer);
        if (error) reject(error);
        else resolve();
      };
      timeout = setTimeout(() => finish(new Error("WhatsApp pairing timed out.")), pairingTimeoutMs);

      const connect = () => {
        const generation = ++socketGeneration;
        const nextSocket = makeWASocket({
          auth: state,
          version,
          markOnlineOnConnect: false,
          syncFullHistory: false,
          qrTimeout: options.manualQrRefresh ? pairingTimeoutMs + 60_000 : PAIRING_QR_TTL_MS,
        });
        socket = nextSocket;
        nextSocket.ev.on("creds.update", credentialSaver.schedule);
        nextSocket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
          if (finished || generation !== socketGeneration) return;
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

      const restartForFreshQr = async () => {
        const previousSocket = socket;
        socketGeneration += 1;
        socket = undefined;
        if (previousSocket) await previousSocket.end(undefined).catch(() => undefined);
        if (!finished) connect();
      };

      const checkForRefreshRequest = async () => {
        if (refreshCheckRunning || !options.manualQrRefresh || !brokerId || !options.broker) return;
        refreshCheckRunning = true;
        try {
          const status = await brokerRequest(options.broker, { operation: "status", id: brokerId });
          const requestedAt = Number(status.refreshRequestedAt ?? 0);
          if (requestedAt > lastRefreshRequestedAt) {
            lastRefreshRequestedAt = requestedAt;
            await restartForFreshQr();
          }
        } catch {
          // A transient broker read should not terminate an otherwise usable pairing session.
        } finally {
          refreshCheckRunning = false;
        }
      };

      if (options.manualQrRefresh) {
        refreshTimer = setInterval(() => void checkForRefreshRequest(), 2_000);
      }
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
