# Baileys Agent Kit

An LLM-friendly TypeScript layer over Baileys for local CLI/MCP use and optional GitHub Actions automation. It includes typed actions, JSON Schema for tool calling, free local session storage, persistent safety controls, encrypted GitHub state sync, optional Upstash support, and protocol compatibility checks.

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
Local CLI / MCP ─── private file state ─── Baileys ─── WhatsApp

Optional GitHub Actions ─── AES-256-GCM ciphertext ─── state branch

Optional distributed mode ─── Upstash Redis
Optional hosted pairing ─── Vercel browser screen
```

Local use requires no hosted database, Vercel project, payment method, or GitHub repository. Upstash and the Vercel pairing screen remain opt-in for deployments that need distributed workers or remote browser pairing.

## Included actions

- `send_text`, `send_image`, `send_document`, `send_location`, `send_poll`, `send_album`
- `reply_text`, `react`, `edit_text`, `delete_message`, `mark_read`
- `wait_for_message`
- `get_profile`
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

Reply to a text message using its ID and original text. Include `participant` when replying in a group. Set `fromMe: true` when quoting a message sent by the linked account:

```ts
await executeAction(connection.socket, {
  action: "reply_text",
  recipient: "+972501234567",
  messageId: "3EB0...",
  quotedText: "Original message",
  text: "Reply from an agent",
});
```

Send two to ten images or videos as one grouped WhatsApp album:

```ts
await executeAction(connection.socket, {
  action: "send_album",
  to: "+972501234567",
  items: [
    { type: "image", url: "https://example.com/one.jpg", caption: "First" },
    { type: "video", url: "https://example.com/two.mp4", caption: "Second" },
  ],
});
```

Wait up to five minutes for a new message from a contact or group:

```ts
const incoming = await executeAction(connection.socket, {
  action: "wait_for_message",
  from: "+972501234567",
  timeoutSeconds: 120,
});
```

The result includes normalized text or caption, media type metadata, and a ready-to-use `replyTo` object for text messages. Add `participant` to filter one sender inside a group. The action ignores messages sent by the linked account and history-sync events. It does not download received media.

Fetch the profile fields WhatsApp exposes to the linked account for one number:

```ts
const profile = await executeAction(connection.socket, {
  action: "get_profile",
  number: "+972501234567",
});
```

The result can include registration status, temporary profile-picture URL, About/bio text, and business description, category, address, email, websites, and hours. Privacy-hidden or unavailable fields return `null`. WhatsApp does not reliably expose an arbitrary contact's display name. Profile lookup follows `WA_ALLOWED_RECIPIENTS` and does not support bulk number enumeration.

To discover recent chats without slowing every action, request an opt-in bounded prefetch:

```json
{
  "action": "list_recent_accounts",
  "limit": 20,
  "prefetchSeconds": 5
}
```

Only this action enables history synchronization and waits for metadata, for at most 30 seconds. It returns recent contact/group JIDs, available names, last-activity timestamps, and unread counts. The worker keeps at most 500 account metadata entries in memory and does not persist chat history.

## Agent CLI

The package installs `baileys-agent`, a stable JSON-oriented CLI:

```bash
baileys-agent describe
baileys-agent doctor
baileys-agent pair --terminal
baileys-agent pair --phone-number +15551234567
baileys-agent recent-accounts
baileys-agent github-state setup --repository OWNER/REPO
baileys-agent run --action '{"action":"list_groups"}'
```

`describe` emits the complete action schema. `pair` detects Israel locally from the OS timezone or locale and, in an interactive terminal, asks for the number and returns WhatsApp's one-time pairing code. The number is not saved. Other regions use a QR by default. Pass `--phone-number` (or `WA_PHONE_NUMBER` for non-interactive use) to select code pairing explicitly anywhere. QR mode writes a square mode-`0600` PNG to the system temporary directory and can render it in the terminal. Use `--json` for newline-delimited pairing events; because JSON mode cannot prompt, Israeli users must provide the number explicitly. Pair locally before enabling free encrypted GitHub Actions state.

## MCP for Claude Code and other agent apps

The `baileys-agent-mcp` stdio server exposes five tools:

- `whatsapp_capabilities`
- `whatsapp_doctor`
- `whatsapp_pair_start`
- `whatsapp_pair_status`
- `whatsapp_execute`

Pairing tools return the current QR as an MCP `image/png` content block, plus its expiry time. On an Israeli local runtime, `whatsapp_pair_start` without `phoneNumber` returns `PAIRING_PHONE_NUMBER_REQUIRED` so the agent can request `+972...` privately and retry for a one-time code. Other regions return a QR by default. Compatible apps can display the image or code and request status until connected. The MCP process remains alive while the phone completes pairing.

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

Pass optional storage and safety environment variables through the agent app’s MCP configuration or launch environment. Never embed secrets in a committed configuration file. With no storage variables, MCP uses the free local file backend.

## Agent-readable failures

CLI, GitHub Actions, and MCP failures use the same JSON contract:

```json
{
  "ok": false,
  "error": "WhatsApp is not connected to this account.",
  "code": "WHATSAPP_NOT_PAIRED",
  "likelyCause": "No usable linked-device session exists, or WhatsApp logged the session out.",
  "nextSteps": ["Run 'baileys-agent pair --terminal', use --phone-number, or call whatsapp_pair_start."],
  "retryable": false
}
```

Agents should explain `likelyCause` in plain language, follow `nextSteps` in order, and never retry automatically when `retryable` is `false`. Technical details are retained when useful, with common credential formats redacted. `baileys-agent doctor` and `whatsapp_doctor` return the same guidance for every detected configuration, session, storage, or protocol problem.

## Setup

### Free local CLI or MCP

No environment variables are required:

```bash
baileys-agent doctor
baileys-agent pair --terminal
baileys-agent doctor
baileys-agent recent-accounts
```

On an Israeli machine, `baileys-agent pair` prompts for `+972...` and shows a one-time code. WhatsApp: **Settings → Linked Devices → Link a Device → Link with phone number instead**, then enter the code. Outside Israel, the same command shows a QR unless `--phone-number` is supplied.

Before pairing, doctor should report writable `file` storage and `WHATSAPP_NOT_PAIRED`. Pair once, then the same account is available to CLI and MCP. State uses atomic writes, account-level heartbeat locking, directory mode `0700`, and file mode `0600`.

The default state location follows the operating system:

- Linux: `$XDG_STATE_HOME/baileys-agent-kit` or `~/.local/state/baileys-agent-kit`
- macOS: `~/Library/Application Support/baileys-agent-kit`
- Windows: `%LOCALAPPDATA%/baileys-agent-kit`

Set `WA_STATE_DIR` for an explicit location. Set `WA_ACCOUNT_ID` to keep multiple accounts separate.

### Free GitHub Actions integration

Pair locally first. With GitHub CLI authenticated to a repository where you can manage Actions secrets and contents, run:

```bash
baileys-agent github-state setup --repository OWNER/REPO
```

The command generates a 256-bit key without printing it, uploads the current local account as AES-256-GCM ciphertext to the orphan `baileys-agent-state` branch, and stores the key as the repository secret `WA_STATE_ENCRYPTION_KEY`. The included action workflow then restores state before each action, persists safety reservations before sending, and saves updated auth/failure state afterward.

The state branch contains ciphertext only. Do not expose `WA_STATE_ENCRYPTION_KEY` to pull-request, fork, or Dependabot workflows. A malicious default-branch workflow or repository administrator can still access repository secrets; encrypted branch storage does not protect against a compromised repository owner.

### Optional Upstash and hosted browser pairing

Existing installations remain compatible. Set both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; the library selects Upstash automatically. Or set `WA_STORAGE_BACKEND=upstash` explicitly. Doctor performs a write/delete probe and reports `SESSION_STORAGE_READ_ONLY` for a read-only token.

The Vercel browser pairing broker remains optional. It requires writable Upstash storage plus `PAIRING_BROKER_URL`, `PAIRING_PUBLIC_URL`, and matching `PAIRING_BROKER_SECRET` values. Local QR/MCP/phone-code pairing does not require that broker.

### Migrating from an earlier version

- Existing users with both Upstash variables continue using Upstash without migration.
- New users with no Upstash variables automatically use local files.
- `WA_STORAGE_BACKEND=file` explicitly ignores legacy Upstash variables.
- Switching backends does not silently copy authentication material. Pair again, or use the GitHub setup command from an already paired local file account.
- The hosted pairing workflow is optional; free GitHub state is bootstrapped from local pairing instead.

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

The workflow prints exactly one JSON result object after a successful action. A caller that needs synchronous results should poll the workflow run and read its logs. GitHub Actions is intentionally an on-demand executor, not a real-time bot host. `wait_for_message` receives only during its bounded action window; continuous inbound webhooks require a persistent worker.

## Risk controls

These controls reduce accidental spam and repeated failing connections. They cannot make an unofficial client ban-proof.

- 50 successful or attempted sends per UTC day
- 10 sends per recipient per UTC day
- 20 unique recipients per UTC day
- At least 3.5 seconds between outbound sends
- Circuit breaker for 30 minutes after three failures in ten minutes
- Group administration disabled unless `WA_ENABLE_GROUP_ADMIN=true`
- Optional hard recipient allowlist through `WA_ALLOWED_RECIPIENTS`

Each image or video in an album counts toward daily and per-recipient send limits. The album is still sent as one grouped user-visible message.

The defaults can be changed with the matching repository variables listed in [.env.example](.env.example). Keep the limits conservative and use opt-in recipients. The library exports `RiskGuard` for callers outside the included Action runner.

Leave a `WA_MAX_*` environment value empty or whitespace-only to disable that limit. An empty or whitespace-only `WA_MINIMUM_SEND_INTERVAL_MS` disables the send delay. Unset values continue to use the defaults above.

## Updates and releases

- Dependabot checks Baileys and other npm dependencies daily and Actions weekly.
- CI runs tests, types, production build, and a live WhatsApp protocol comparison for every pull request.
- Non-major Dependabot updates request auto-merge. Enable repository auto-merge and require the `CI / validate` check on `main`; otherwise GitHub safely leaves the PR open.
- A failed scheduled protocol check opens or updates one GitHub issue instead of failing silently.
- Release Please maintains versions, changelog entries, tags, and GitHub Releases from conventional commits on `main`.
- Major TypeScript and Node type updates stay pinned until the repository deliberately changes its compiler or Node runtime.

Runtime package installation is deliberately forbidden. Updating only through lockfile-backed, tested pull requests prevents a compromised or broken registry release from silently replacing production code.

## Efficiency

- Local auth and safety writes are serialized, fsynced, and atomically renamed.
- Optional Upstash signal-key reads/writes and safety reservations remain batched.
- Bursts of Baileys credential updates are coalesced while always flushing the latest state before shutdown.
- Recent-account metadata is prefetched only for `list_recent_accounts`, with a caller-bounded wait; ordinary actions do not pay this delay.
- GitHub Actions restores exact-lockfile `node_modules` caches and skips `npm ci` on cache hits.
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

- Local auth and Signal keys are account credentials. The library restricts filesystem permissions but cannot protect a compromised local user account or machine.
- GitHub state uses account-bound AES-256-GCM encryption with a random nonce. Git history retains older ciphertext; rotate the key and remove/recreate the state branch after key compromise or account logout.
- The free GitHub workflow never places WhatsApp auth in Actions caches or artifacts. GitHub documents caches as readable by pull-request authors and artifacts as retention-limited.
- The pairing URL is a bearer secret. It uses a URL fragment so the viewer token is not sent in the initial browser request or ordinary Vercel access logs.
- Pairing state expires after 10 minutes. The Actions browser keeps each QR for its 60-second validity window, then requires an explicit refresh request. QR and one-time-code data are cleared after connection.
- The Action serializes work per `WA_ACCOUNT_ID` to avoid concurrent corruption and duplicate operations.
- Give any LLM a narrow allowlist of recipients and actions in the calling application. This kit validates shape and limits, but it cannot decide who the model is authorized to message.
