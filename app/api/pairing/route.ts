import { NextResponse } from "next/server";
import { z } from "zod";
import {
  brokerAuthorized,
  createPairingSession,
  updatePairingSession,
  viewPairingSession,
} from "../../../src/pairing/broker";

export const runtime = "nodejs";

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create") }),
  z.object({ operation: z.literal("update"), id: z.uuid(), qr: z.string().min(1).optional(), status: z.enum(["waiting", "qr", "connected", "failed"]).optional(), message: z.string().max(500).optional() }),
  z.object({ operation: z.literal("view"), id: z.uuid(), token: z.string().min(32) }),
]);

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid pairing request." }, { status: 400 });

  if (parsed.data.operation === "view") {
    const session = await viewPairingSession(parsed.data.id, parsed.data.token);
    return session
      ? NextResponse.json(session, { headers: { "Cache-Control": "no-store" } })
      : NextResponse.json({ error: "Invalid or expired pairing link." }, { status: 404 });
  }

  if (!brokerAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (parsed.data.operation === "create") {
    return NextResponse.json(await createPairingSession(new URL(request.url).origin));
  }

  await updatePairingSession(parsed.data.id, parsed.data);
  return NextResponse.json({ ok: true });
}
