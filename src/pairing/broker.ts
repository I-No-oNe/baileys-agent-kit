import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Redis } from "@upstash/redis";
import QRCode from "qrcode";
import { requiredEnv } from "../env";

const SESSION_TTL_SECONDS = 10 * 60;
const key = (id: string) => `baileys_agent:pairing:${id}`;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

type PairingSession = {
  tokenHash: string;
  status: "waiting" | "qr" | "connected" | "failed";
  qrDataUrl?: string;
  message?: string;
  expiresAt: number;
};

function redis() {
  return new Redis({
    url: requiredEnv("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"),
    token: requiredEnv("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"),
  });
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

export async function updatePairingSession(id: string, update: { qr?: string; status?: PairingSession["status"]; message?: string }) {
  const store = redis();
  const session = await store.get<PairingSession>(key(id));
  if (!session) throw new Error("Pairing session expired or does not exist.");

  if (update.qr) {
    session.qrDataUrl = await QRCode.toDataURL(update.qr, { width: 640, margin: 3 });
    session.status = "qr";
  }
  if (update.status) session.status = update.status;
  if (update.message) session.message = update.message;
  if (update.status === "connected") delete session.qrDataUrl;

  const remainingSeconds = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
  await store.set(key(id), session, { ex: remainingSeconds });
}

export async function viewPairingSession(id: string, token: string) {
  const session = await redis().get<PairingSession>(key(id));
  if (!session || session.expiresAt <= Date.now()) return null;
  const expected = Buffer.from(session.tokenHash, "hex");
  const actual = Buffer.from(tokenHash(token), "hex");
  if (!timingSafeEqual(actual, expected)) return null;
  return {
    status: session.status,
    qrDataUrl: session.qrDataUrl,
    message: session.message,
    expiresAt: session.expiresAt,
  };
}
