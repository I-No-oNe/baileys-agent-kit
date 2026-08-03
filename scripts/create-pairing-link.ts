import { appendFile } from "node:fs/promises";
import { createBrokerPairingSession, pairingBrokerFromEnv } from "../src/pair";
import { explainError } from "../src/explain-error";

async function main() {
  const broker = pairingBrokerFromEnv();
  if (!broker) throw new Error("GitHub Actions pairing requires PAIRING_BROKER_URL and PAIRING_BROKER_SECRET.");
  const session = await createBrokerPairingSession(broker);
  if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, `PAIRING_SESSION_ID=${session.id}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `# Connect WhatsApp\n\n## [Open the private pairing page →](${session.shareUrl})\n\nOpen this link now, then scan the square QR or choose **Use phone number instead**. The bearer link expires in 10 minutes.\n`,
    );
  }
  const noticeUrl = session.shareUrl.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::notice title=Open WhatsApp pairing page::${noticeUrl}`);
  console.log(`Private pairing link (expires in 10 minutes):\n${session.shareUrl}`);
}

main().catch((error) => {
  console.error(JSON.stringify(explainError(error)));
  process.exitCode = 1;
});
