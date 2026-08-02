#!/usr/bin/env node

import QRCode from "qrcode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionSchema } from "./actions";
import { agentDescription } from "./agent-description";
import { diagnoseWhatsApp } from "./doctor";
import { explainError, type ExplainedFailure } from "./explain-error";
import { pairWhatsApp, pairingBrokerFromEnv } from "./pair";
import { PAIRING_QR_TTL_MS } from "./pairing/constants";
import { runAgentAction } from "./runner";
import packageJson from "../package.json";

type PairingState = {
  status: "waiting" | "qr" | "connected" | "failed";
  qr?: string;
  qrExpiresAt?: number;
  shareUrl?: string;
  error?: string;
  failure?: ExplainedFailure;
  changed: Promise<void>;
  notify: () => void;
};

const pairingStates = new Map<string, PairingState>();

function newPairingState(): PairingState {
  let notify: () => void = () => undefined;
  const changed = new Promise<void>((resolve) => { notify = resolve; });
  return { status: "waiting", changed, notify };
}

async function startPairing(accountId: string) {
  const existing = pairingStates.get(accountId);
  if (existing && existing.status !== "failed") return existing;

  const state = newPairingState();
  pairingStates.set(accountId, state);
  try {
    const pairing = pairWhatsApp({
      accountId,
      broker: pairingBrokerFromEnv(),
      onShareUrl: (url) => {
        state.shareUrl = url;
        state.notify();
      },
      onQr: (qr) => {
        state.status = "qr";
        state.qr = qr;
        state.qrExpiresAt = Date.now() + PAIRING_QR_TTL_MS;
        state.notify();
      },
    });
    void pairing.then(() => {
      state.status = "connected";
      state.qr = undefined;
      state.qrExpiresAt = undefined;
      state.notify();
    }).catch((error) => {
      state.status = "failed";
      state.failure = explainError(error);
      state.error = state.failure.error;
      state.notify();
    });
  } catch (error) {
    state.status = "failed";
    state.failure = explainError(error);
    state.error = state.failure.error;
    state.notify();
  }

  await Promise.race([
    state.changed,
    new Promise<void>((resolve) => setTimeout(resolve, 45_000)),
  ]);
  return state;
}

async function pairingResult(accountId: string, state: PairingState | undefined): Promise<CallToolResult> {
  if (!state) {
    const failure = explainError(new Error(`No pairing session exists for account '${accountId}'.`));
    return { content: [{ type: "text", text: JSON.stringify(failure, null, 2) }], isError: true };
  }
  const qr = state.qr;
  const qrExpiresAt = state.qrExpiresAt;
  const qrCurrent = qr !== undefined && qrExpiresAt !== undefined && qrExpiresAt > Date.now();
  const summary = {
    accountId,
    status: state.status === "qr" && !qrCurrent ? "waiting" : state.status,
    qrExpiresAt: qrCurrent ? new Date(qrExpiresAt).toISOString() : undefined,
    shareUrl: state.shareUrl,
    error: state.error,
    failure: state.failure,
  };
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(summary, null, 2) }];
  if (qrCurrent) {
    const png = await QRCode.toBuffer(qr, { type: "png", width: 640, margin: 3 });
    content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }
  return { content, isError: state.status === "failed" };
}

const server = new McpServer({ name: "baileys-agent-kit", version: packageJson.version });

server.registerTool("whatsapp_capabilities", {
  description: "Return all supported WhatsApp actions, schemas, transports, and safety behavior.",
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => ({ content: [{ type: "text", text: JSON.stringify(agentDescription, null, 2) }] }));

server.registerTool("whatsapp_doctor", {
  description: "Check configuration, Redis connectivity, pairing state, and WhatsApp protocol compatibility before acting.",
  inputSchema: z.object({ accountId: z.string().min(1).optional() }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ accountId }) => {
  const result = await diagnoseWhatsApp(accountId);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: !result.ok };
});

server.registerTool("whatsapp_pair_start", {
  description: "Start or resume WhatsApp device pairing and return the QR as a previewable PNG image.",
  inputSchema: z.object({ accountId: z.string().min(1).optional() }),
  annotations: { readOnlyHint: false, openWorldHint: true },
}, async ({ accountId = "default" }) => pairingResult(accountId, await startPairing(accountId)));

server.registerTool("whatsapp_pair_status", {
  description: "Get the latest pairing QR image or connection result for an active pairing session.",
  inputSchema: z.object({ accountId: z.string().min(1).optional() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ accountId = "default" }) => pairingResult(accountId, pairingStates.get(accountId)));

server.registerTool("whatsapp_execute", {
  description: "Execute one validated WhatsApp action with locking, allowlists, rate limits, and circuit-breaker protection.",
  inputSchema: actionSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async (action) => {
  try {
    const result = await runAgentAction(action);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, result }, null, 2) }] };
  } catch (error) {
    const failure = explainError(error);
    return {
      content: [{ type: "text", text: JSON.stringify(failure, null, 2) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
