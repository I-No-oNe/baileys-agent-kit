import "../src/load-local-env";
import { appendFile } from "node:fs/promises";
import { explainError } from "../src/explain-error";
import { pairWhatsApp, pairingBrokerFromEnv } from "../src/pair";

async function main() {
  const broker = pairingBrokerFromEnv();
  const brokerSessionId = process.env.PAIRING_SESSION_ID;
  await pairWhatsApp({
    broker,
    brokerSessionId,
    manualQrRefresh: Boolean(brokerSessionId),
    onShareUrl: async (shareUrl) => {
      console.log(`Private pairing link (expires in 10 minutes):\n${shareUrl}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `## WhatsApp pairing\n\n[Open the private pairing screen](${shareUrl})\n\nThis bearer link expires in 10 minutes. Share it only with the person linking the account.\n`);
      }
    },
  });
  console.log("WhatsApp linked. Session saved to Upstash.");
}

main().catch(async (error) => {
  console.error(JSON.stringify(explainError(error)));
  process.exitCode = 1;
});
