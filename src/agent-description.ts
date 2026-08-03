import { llmTool } from "./actions";
import packageJson from "../package.json";

export const agentDescription = {
  name: "baileys-agent-kit",
  version: packageJson.version,
  purpose: "Send, receive, and manage a linked WhatsApp account through validated Baileys actions.",
  transport: ["CLI", "MCP stdio", "GitHub Actions"],
  commands: {
    describe: "Print this machine-readable description and the complete action schema.",
    doctor: "Check local or Upstash storage, pairing, and WhatsApp protocol status.",
    pair: "Link WhatsApp with a one-time phone code, terminal QR, protected PNG, or private browser link.",
    recentAccounts: "Discover recent accounts without writing action JSON.",
    githubState: "Set up, pull, or push free encrypted GitHub Actions state.",
    run: "Execute one validated action from a JSON argument or stdin.",
    mcp: "Expose describe, doctor, QR or one-time-code pairing, and execution as MCP tools.",
  },
  safety: {
    note: "Baileys is unofficial and cannot be made ban-proof.",
    destructiveGroupActionsRequireOptIn: true,
    riskControlsAppliedByRun: true,
  },
  failureContract: {
    fields: ["ok", "error", "code", "likelyCause", "nextSteps", "retryable", "details"],
    instruction: "Explain likelyCause to the user, follow nextSteps in order, and never retry automatically when retryable is false.",
  },
  actionTool: llmTool,
} as const;
