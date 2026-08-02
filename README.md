# Baileys Agent Kit

An LLM-friendly TypeScript layer over Baileys that runs WhatsApp work in GitHub Actions. It includes typed actions, JSON Schema for tool calling, Upstash-backed multi-device auth, a private browser pairing screen, concurrency locking, and a daily protocol compatibility check.

> Baileys is an unofficial WhatsApp Web client. It can break when WhatsApp changes its protocol and may put an account at risk. Do not use a valuable business number without accepting that risk.

## Install and download

Requires Node.js 20 or newer. Install the library in a project:

```bash
npm install baileys-agent-kit
```

Run the CLI without installing it globally:

```bash
npx --yes --package baileys-agent-kit baileys-agent doctor
```

Or install the two CLI commands globally:

```bash
npm install --global baileys-agent-kit
baileys-agent doctor
baileys-agent-mcp
```

GitHub provides source archives on the [Releases page](https://github.com/I-No-oNe/baileys-agent-kit/releases). This TypeScript package does not ship standalone desktop executables.

## Runtime design

```text
LLM / application
      │ repository_dispatch or workflow_dispatch
      ▼
GitHub Actions ───── Baileys socket ───── WhatsApp
      │
      └──── TLS transport + auth state in your Upstash account

Pair action ── publishes expiring QR ── your Vercel pairing screen
```

Nothing requires an `I-No-oNe` deployment. The developer forks or copies this project, then connects their own GitHub, Vercel, and Upstash accounts.

## Included actions

- `send_text`, `send_image`, `send_document`, `send_location`, `send_poll`
- `react`, `edit_text`, `delete_message`, `mark_read`
- `list_groups`, `get_group`, `create_group`
- `update_group_subject`, `update_group_participants`

Import `llmTool` for a provider-neutral JSON Schema, or use `actionSchema` and `executeAction` directly.

```ts
import { connectWhatsApp, executeAction, llmTool } from "baileys-agent-kit";

console.log(llmTool);
const connection = await connectWhatsApp();
const result = await executeAction(connection.socket, {
  action: "send_text",
  to: "+972501234567",
  text: "Hello from an agent",
});
await connection.close();
```

## Agent CLI

The package installs `baileys-agent`, a stable JSON-oriented CLI:

```bash
baileys-agent describe
baileys-agent doctor
baileys-agent pair --terminal
echo '{"action":"list_groups"}' | baileys-agent run
```

`describe` emits the complete action schema. `pair` renders an ANSI QR in interactive terminals and also writes a mode-`0600` PNG to the system temporary directory. Its printed absolute path and Markdown preview can be opened by shell-based agent applications. Use `--json` for newline-delimited pairing events.

## MCP for Claude Code and other agent apps

The `baileys-agent-mcp` stdio server exposes five tools:

- `whatsapp_capabilities`
- `whatsapp_doctor`
- `whatsapp_pair_start`
- `whatsapp_pair_status`
- `whatsapp_execute`

Pairing tools return the QR as an MCP `image/png` content block, so compatible apps can display it directly. The MCP process remains alive while the phone scans the QR.

This repository includes a project-scoped [.mcp.json](.mcp.json). After publishing, a generic MCP client configuration is:

```json
{
  "mcpServers": {
    "baileys-agent-kit": {
      "command": "npx",
      "args": ["-y", "-p", "baileys-agent-kit", "baileys-agent-mcp"]
    }
  }
}
```

Pass the Upstash and safety environment variables through the agent app’s MCP configuration or launch environment. Never embed their values in a committed configuration file.

## Setup

1. Create an Upstash Redis database. It stores Baileys credentials and signal keys. Treat its REST token as an account credential.
2. Deploy this repository to a Vercel project owned by the developer or company.
3. In Vercel, set `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `PAIRING_BROKER_SECRET`, and `PAIRING_PUBLIC_URL`.
4. In the GitHub repository, add Actions secrets with the same Upstash values plus:
   - `PAIRING_BROKER_URL`: the Vercel deployment URL
   - `PAIRING_BROKER_SECRET`: the same long random secret used by Vercel
   - `WA_ALLOWED_RECIPIENTS`: optional comma-separated phone numbers/JIDs the agent may contact
5. Run **Pair WhatsApp** from the Actions tab. Open the private URL in its job summary, or send that URL to the person who controls the WhatsApp phone.
6. Scan the QR within 10 minutes. The QR is removed as soon as pairing succeeds.

Generate the broker secret locally with `openssl rand -base64 48`.

## Dispatch from code or an LLM

Manual CLI call:

```bash
gh workflow run whatsapp-action.yml \
  -f account_id=default \
  -f action_json='{"action":"send_text","to":"+972501234567","text":"Hello"}'
```

Repository dispatch call:

```bash
gh api repos/OWNER/REPO/dispatches --input - <<'JSON'
{
  "event_type": "whatsapp-action",
  "client_payload": {
    "account_id": "default",
    "action": { "action": "list_groups" }
  }
}
JSON
```

The workflow prints exactly one JSON result object after a successful action. A caller that needs synchronous results should poll the workflow run and read its logs. GitHub Actions is intentionally an on-demand executor, not a real-time bot host.

## Risk controls

These controls reduce accidental spam and repeated failing connections. They cannot make an unofficial client ban-proof.

- 50 successful or attempted sends per UTC day
- 10 sends per recipient per UTC day
- 20 unique recipients per UTC day
- At least 3.5 seconds between outbound sends
- Circuit breaker for 30 minutes after three failures in ten minutes
- Group administration disabled unless `WA_ENABLE_GROUP_ADMIN=true`
- Optional hard recipient allowlist through `WA_ALLOWED_RECIPIENTS`

The defaults can be changed with the matching repository variables listed in [.env.example](.env.example). Keep the limits conservative and use opt-in recipients. The library exports `RiskGuard` for callers outside the included Action runner.

## Updates and releases

- Dependabot checks Baileys and other npm dependencies daily and Actions weekly.
- CI runs tests, types, production build, and a live WhatsApp protocol comparison for every pull request.
- Non-major Dependabot updates request auto-merge. Enable repository auto-merge and require the `CI / validate` check on `main`; otherwise GitHub safely leaves the PR open.
- A failed scheduled protocol check opens or updates one GitHub issue instead of failing silently.
- Release Please maintains versions, changelog entries, tags, and GitHub Releases from conventional commits on `main`.
- Major TypeScript and Node type updates stay pinned until the repository deliberately changes its compiler or Node runtime.

Runtime package installation is deliberately forbidden. Updating only through lockfile-backed, tested pull requests prevents a compromised or broken registry release from silently replacing production code.

## Efficiency

- Baileys signal-key reads and writes are batched into one Upstash request per operation.
- Send-limit validation and reservation use two Upstash pipeline requests instead of many individual requests.
- Bursts of Baileys credential updates are coalesced while always flushing the latest state before shutdown.
- The pairing screen never overlaps polling requests, slows to 10 seconds in background tabs, and stops polling after a terminal result.

## Port selection

Local `npm run dev` and `npm start` prefer port `3417`. If occupied, the launcher scans the next 100 ports and selects the first available one. Set `PORT` to choose a different starting port. Vercel assigns its own runtime port.

## Local checks

```bash
npm install
npm test
npm run check
npm run build
```

## Security notes

- The pairing URL is a bearer secret. It uses a URL fragment so the viewer token is not sent in the initial browser request or ordinary Vercel access logs.
- Pairing state expires after 10 minutes. The QR is cleared after connection.
- GitHub and Vercel share only the pairing broker secret; the browser never receives it.
- The Action serializes work per `WA_ACCOUNT_ID` to avoid concurrent corruption and duplicate operations.
- Give any LLM a narrow allowlist of recipients and actions in the calling application. This kit validates shape and limits, but it cannot decide who the model is authorized to message.
