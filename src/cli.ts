#!/usr/bin/env node

import "./load-local-env";
import { chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import { agentDescription } from "./agent-description";
import { diagnoseWhatsApp } from "./doctor";
import { explainError } from "./explain-error";
import { pairWhatsApp, pairingBrokerFromEnv } from "./pair";
import { runAgentAction } from "./runner";

const args = process.argv.slice(2);
const command = args.shift() ?? "help";
const hasFlag = (flag: string) => args.includes(flag);
const flagValue = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

async function stdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function run() {
  if (command === "describe") {
    console.log(JSON.stringify(agentDescription, null, 2));
    return;
  }
  if (command === "doctor") {
    const result = await diagnoseWhatsApp(flagValue("--account"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "run") {
    const actionArgument = flagValue("--action") ?? (args[0] && !args[0].startsWith("--") ? args[0] : undefined);
    const source = actionArgument ?? await stdin();
    if (!source) throw new Error("Provide action JSON with --action, a positional argument, or stdin.");
    const result = await runAgentAction(JSON.parse(source), flagValue("--account"));
    console.log(JSON.stringify({ ok: true, result }));
    return;
  }
  if (command === "recent-accounts") {
    const result = await runAgentAction({
      action: "list_recent_accounts",
      limit: Number(flagValue("--limit") ?? 20),
      prefetchSeconds: Number(flagValue("--prefetch-seconds") ?? 5),
    }, flagValue("--account"));
    console.log(JSON.stringify({ ok: true, result }));
    return;
  }
  if (command === "pair") {
    const accountId = flagValue("--account") ?? process.env.WA_ACCOUNT_ID ?? "default";
    const json = hasFlag("--json");
    const terminal = !json && (process.stdout.isTTY || hasFlag("--terminal"));
    const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const qrFile = resolve(flagValue("--qr-file") ?? `${tmpdir()}/baileys-agent-${safeAccountId}-qr.png`);
    const emit = (event: Record<string, unknown>) => {
      if (json) console.log(JSON.stringify(event));
    };

    try {
      await pairWhatsApp({
        accountId,
        phoneNumber: flagValue("--phone-number"),
        broker: pairingBrokerFromEnv(),
        onShareUrl: (url) => {
          emit({ type: "pairing_url", url });
          if (!json) console.log(`Private browser pairing link:\n${url}`);
        },
        onQr: async (qr) => {
          await QRCode.toFile(qrFile, qr, { width: 640, margin: 3 });
          await chmod(qrFile, 0o600);
          emit({ type: "qr", imagePath: qrFile, mimeType: "image/png" });
          if (!json) {
            console.log(`QR image for agent/app preview: ${qrFile}`);
            console.log(`Markdown preview: ![WhatsApp pairing QR](${qrFile})`);
            if (terminal) qrcodeTerminal.generate(qr, { small: true });
          }
        },
        onPairingCode: (code) => {
          emit({ type: "pairing_code", code });
          if (!json) console.log(`WhatsApp one-time pairing code: ${code}`);
        },
      });
      emit({ type: "connected", accountId });
      if (!json) console.log("WhatsApp linked. Session saved to Upstash.");
    } finally {
      await unlink(qrFile).catch(() => undefined);
    }
    return;
  }

  console.log(`Baileys Agent Kit CLI

Usage:
  baileys-agent describe
  baileys-agent doctor [--account ID]
  baileys-agent pair [--account ID] [--phone-number +15551234567] [--terminal] [--qr-file PATH] [--json]
  baileys-agent recent-accounts [--account ID] [--limit 20] [--prefetch-seconds 5]
  baileys-agent run [--account ID] --action '{"action":"list_groups"}'

Use 'baileys-agent describe' for the complete machine-readable action schema.`);
}

run().catch((error) => {
  console.error(JSON.stringify(explainError(error)));
  process.exit(1);
});
