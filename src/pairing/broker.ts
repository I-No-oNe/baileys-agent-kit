import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import QRCode from "qrcode";
import { requiredEnv } from "../env";
import { PAIRING_QR_TTL_MS } from "./constants";

const SESSION_TTL_SECONDS = 10 * 60;
const key = (id: string) => `baileys_agent:pairing:${id}`;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

type PairingSession = {
  tokenHash: string;
  status: "waiting" | "qr" | "code" | "connected" | "failed";
  qrDataUrl?: string;
  qrUpdatedAt?: number;
  qrExpiresAt?: number;
  refreshRequestedAt?: number;
  codeRequestedAt?: number;
  phoneNumber?: string;
  pairingCode?: string;
  message?: string;
  expiresAt: number;
};

function redis() {
  return new Redis({
    url: requiredEnv("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"),
    token: requiredEnv("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"),
  });
}

function tokenMatches(session: PairingSession, token: string): boolean {
  const expected = Buffer.from(session.tokenHash, "hex");
  const actual = Buffer.from(tokenHash(token), "hex");
  return timingSafeEqual(actual, expected);
}

async function savePairingSession(store: Redis, id: string, session: PairingSession) {
  const remainingSeconds = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
  await store.set(key(id), session, { ex: remainingSeconds });
}

export function brokerAuthorized(authorization: string | null): boolean {
  const expected = `Bearer ${requiredEnv("PAIRING_BROKER_SECRET")}`;
  const actual = authorization ?? "";
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export async function createPairingSession(origin: string) {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const session: PairingSession = {
    tokenHash: tokenHash(token),
    status: "waiting",
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  await redis().set(key(id), session, { ex: SESSION_TTL_SECONDS });
  const configuredOrigin = process.env.PAIRING_PUBLIC_URL?.replace(/\/$/, "");
  return { id, shareUrl: `${configuredOrigin ?? origin}/pair/${id}#token=${token}` };
}

export function renderPairingQrDataUrl(qr: string): Promise<string> {
  return QRCode.toDataURL(qr, { width: 640, margin: 4, errorCorrectionLevel: "M" });
}

export async function updatePairingSession(id: string, update: { qr?: string; pairingCode?: string; status?: PairingSession["status"]; message?: string }) {
  const store = redis();
  const session = await store.get<PairingSession>(key(id));
  if (!session) throw new Error("Pairing session expired or does not exist.");

  if (update.qr) {
    session.qrDataUrl = await renderPairingQrDataUrl(update.qr);
    session.qrUpdatedAt = Date.now();
    session.qrExpiresAt = session.qrUpdatedAt + PAIRING_QR_TTL_MS;
    session.status = "qr";
    delete session.refreshRequestedAt;
    delete session.message;
  }
  if (update.pairingCode) {
    session.pairingCode = update.pairingCode;
    session.status = "code";
    delete session.qrDataUrl;
    delete session.qrUpdatedAt;
    delete session.qrExpiresAt;
  }
  if (update.status) session.status = update.status;
  if (update.message) session.message = update.message;
  if (update.status === "connected") {
    delete session.qrDataUrl;
    delete session.qrUpdatedAt;
    delete session.qrExpiresAt;
    delete session.pairingCode;
    delete session.phoneNumber;
    delete session.codeRequestedAt;
  }

  await savePairingSession(store, id, session);
}

export async function viewPairingSession(id: string, token: string) {
  const session = await redis().get<PairingSession>(key(id));
  if (!session || session.expiresAt <= Date.now()) return null;
  if (!tokenMatches(session, token)) return null;
  const qrExpired = session.qrExpiresAt !== undefined && session.qrExpiresAt <= Date.now();
  return {
    status: qrExpired ? "qr_expired" : session.status,
    qrDataUrl: qrExpired ? undefined : session.qrDataUrl,
    qrUpdatedAt: qrExpired ? undefined : session.qrUpdatedAt,
    qrExpiresAt: qrExpired ? undefined : session.qrExpiresAt,
    pairingCode: session.pairingCode,
    message: session.message,
    expiresAt: session.expiresAt,
  };
}

export async function requestPairingRefresh(id: string, token: string): Promise<boolean> {
  const store = redis();
  const session = await store.get<PairingSession>(key(id));
  if (!session || session.expiresAt <= Date.now() || !tokenMatches(session, token)) return false;
  session.status = "waiting";
  session.refreshRequestedAt = Date.now();
  delete session.qrDataUrl;
  delete session.qrUpdatedAt;
  delete session.qrExpiresAt;
  delete session.message;
  delete session.pairingCode;
  delete session.phoneNumber;
  delete session.codeRequestedAt;
  await savePairingSession(store, id, session);
  return true;
}

export async function requestPairingCode(id: string, token: string, phoneNumber: string): Promise<boolean> {
  const store = redis();
  const session = await store.get<PairingSession>(key(id));
  if (!session || session.expiresAt <= Date.now() || !tokenMatches(session, token)) return false;
  session.status = "waiting";
  session.phoneNumber = phoneNumber;
  session.codeRequestedAt = Date.now();
  delete session.qrDataUrl;
  delete session.qrUpdatedAt;
  delete session.qrExpiresAt;
  delete session.pairingCode;
  delete session.message;
  await savePairingSession(store, id, session);
  return true;
}

export async function getPairingRefreshStatus(id: string) {
  const session = await redis().get<PairingSession>(key(id));
  if (!session || session.expiresAt <= Date.now()) return null;
  return {
    refreshRequestedAt: session.refreshRequestedAt,
    codeRequestedAt: session.codeRequestedAt,
    phoneNumber: session.phoneNumber,
  };
}
