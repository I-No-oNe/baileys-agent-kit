# Agent guide

Use the `baileys-agent-kit` MCP server when available. It exposes capability discovery, diagnostics, pairing with an image response, and validated WhatsApp execution.

1. Call `whatsapp_capabilities` once to learn the current action schema.
2. Call `whatsapp_doctor` before pairing or executing if account state is unknown.
3. If unpaired, call `whatsapp_pair_start`. Show its PNG image content to the user. Call `whatsapp_pair_status` if the QR expires or the connection state is unclear.
4. Call `whatsapp_execute` only for actions the user explicitly authorized. Sending messages and changing groups are external side effects.
5. Preserve recipient allowlists, rate limits, group-admin opt-in, and circuit-breaker errors. Never retry around these protections.

Never print Redis tokens, broker secrets, raw authentication state, or raw QR payload text. A QR image or private broker URL is itself temporary authentication material; show it only to the intended account owner.

Shell-only agents can use `baileys-agent describe`, `doctor`, `pair`, and `run`. Pairing writes a mode-`0600` PNG in the system temporary directory and prints its absolute path so the agent application can preview it.
