# Agent guide

Use the `baileys-agent-kit` MCP server when available. It exposes capability discovery, diagnostics, QR or one-time-code pairing, bounded recent-account prefetching, and validated WhatsApp execution.

1. Call `whatsapp_capabilities` once to learn the current action schema.
2. Call `whatsapp_doctor` before pairing or executing if account state is unknown.
3. If unpaired, call `whatsapp_pair_start`. By default, show its PNG image content to the user. If the intended account owner asks for phone-number pairing, pass their international `phoneNumber` and privately show the returned one-time code. Call `whatsapp_pair_status` if the QR/code or connection state is unclear.
4. Call `whatsapp_execute` only for actions the user explicitly authorized. Sending messages and changing groups are external side effects.
5. Preserve recipient allowlists, rate limits, group-admin opt-in, and circuit-breaker errors. Never retry around these protections.
6. Use `list_recent_accounts` only when recent-chat discovery is needed. Set the smallest useful `prefetchSeconds` value (0–30); other actions deliberately skip history prefetch for speed.

Never print Redis tokens, broker secrets, raw authentication state, raw QR payload text, or pairing codes in public logs. A QR image, one-time code, or private broker URL is temporary authentication material; show it only to the intended account owner.

Shell-only agents can use `baileys-agent describe`, `doctor`, `pair`, and `run`. QR pairing writes a mode-`0600` PNG in the system temporary directory and prints its absolute path so the agent application can preview it. Phone-number pairing uses `baileys-agent pair --phone-number +15551234567`.
