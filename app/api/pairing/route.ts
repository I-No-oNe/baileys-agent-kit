import { NextResponse } from "next/server";
import { z } from "zod";
import { explainError } from "../../../src/explain-error";
import {
  brokerAuthorized,
  createPairingSession,
  getPairingRefreshStatus,
  requestPairingCode,
  requestPairingRefresh,
  updatePairingSession,
  viewPairingSession,
} from "../../../src/pairing/broker";

export const runtime = "nodejs";

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create") }),
  z.object({ operation: z.literal("update"), id: z.uuid(), qr: z.string().min(1).optional(), pairingCode: z.string().min(1).max(20).optional(), status: z.enum(["waiting", "qr", "code", "connected", "failed"]).optional(), message: z.string().max(500).optional() }),
  z.object({ operation: z.literal("view"), id: z.uuid(), token: z.string().min(32) }),
  z.object({ operation: z.literal("refresh"), id: z.uuid(), token: z.string().min(32) }),
  z.object({ operation: z.literal("code"), id: z.uuid(), token: z.string().min(32), phoneNumber: z.string().regex(/^[1-9]\d{7,14}$/) }),
  z.object({ operation: z.literal("status"), id: z.uuid() }),
]);

export async function POST(request: Request) {
  try {
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid pairing request." }, { status: 400 });

    if (parsed.data.operation === "view") {
      const session = await viewPairingSession(parsed.data.id, parsed.data.token);
      return session
        ? NextResponse.json(session, { headers: { "Cache-Control": "no-store" } })
        : NextResponse.json({ error: "Invalid or expired pairing link." }, { status: 404 });
    }

    if (parsed.data.operation === "refresh") {
      return await requestPairingRefresh(parsed.data.id, parsed.data.token)
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: "Invalid or expired pairing link." }, { status: 404 });
    }
    if (parsed.data.operation === "code") {
      const requested = await requestPairingCode(parsed.data.id, parsed.data.token, parsed.data.phoneNumber);
      return requested
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: "Invalid or expired pairing link." }, { status: 404 });
    }

    if (!brokerAuthorized(request.headers.get("authorization"))) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    if (parsed.data.operation === "create") {
      return NextResponse.json(await createPairingSession(new URL(request.url).origin));
    }

    if (parsed.data.operation === "status") {
      const status = await getPairingRefreshStatus(parsed.data.id);
      return status
        ? NextResponse.json(status)
        : NextResponse.json({ error: "Pairing session expired or does not exist." }, { status: 404 });
    }

    await updatePairingSession(parsed.data.id, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(explainError(error), { status: 500 });
  }
}
