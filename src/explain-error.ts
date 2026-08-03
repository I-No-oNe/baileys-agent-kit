import { ZodError } from "zod";

export type ExplainedFailure = {
  ok: false;
  error: string;
  code: string;
  likelyCause: string;
  nextSteps: string[];
  retryable: boolean;
  details?: string;
  issues?: ZodError["issues"];
};

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/npm_[a-zA-Z0-9]+/g, "[redacted npm token]")
    .replace(/(token|secret|password)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
}

function failure(
  code: string,
  error: string,
  likelyCause: string,
  nextSteps: string[],
  retryable: boolean,
  details?: string,
): ExplainedFailure {
  return { ok: false, error, code, likelyCause, nextSteps, retryable, ...(details && details !== error ? { details } : {}) };
}

export function explainError(error: unknown): ExplainedFailure {
  if (error instanceof ZodError) {
    return {
      ...failure(
        "INVALID_ACTION",
        "The WhatsApp action does not match the required schema.",
        "A required field is missing, has the wrong type, or the action name is unsupported.",
        ["Call whatsapp_capabilities or run 'baileys-agent describe'.", "Correct the reported fields, then submit the action again."],
        false,
      ),
      issues: error.issues,
    };
  }

  const details = safeMessage(error);

  if (/Provide action JSON|Recipient must be a phone number or WhatsApp JID/i.test(details)) {
    return failure(
      "INVALID_ACTION",
      "The requested action is incomplete or invalid.",
      "The agent omitted the action JSON or supplied an invalid WhatsApp recipient.",
      ["Call whatsapp_capabilities or run 'baileys-agent describe'.", "Correct the action and submit it again."],
      false,
      details,
    );
  }
  if (error instanceof SyntaxError || /Unexpected token|JSON/.test(details)) {
    return failure(
      "INVALID_JSON",
      "The action is not valid JSON.",
      "The CLI could not parse the supplied action before contacting WhatsApp.",
      ["Validate the JSON syntax and quote shell arguments correctly.", "Run 'baileys-agent describe' to inspect the expected action schema."],
      false,
      details,
    );
  }
  if (/^WA_[A-Z_]+ must be an integer/.test(details)) {
    return failure(
      "INVALID_CONFIGURATION",
      "A WhatsApp safety setting has an invalid value.",
      "A WA_* limit is outside its supported range or is not a whole number.",
      ["Correct the environment variable shown in details.", "Run 'baileys-agent doctor' before retrying."],
      false,
      details,
    );
  }
  if (/Missing required environment variable|environment variables are missing/.test(details)) {
    return failure(
      "MISSING_CONFIGURATION",
      "Required configuration is missing.",
      "The process cannot access the Upstash or WhatsApp settings needed for this operation.",
      ["Set the environment variable named in details in the same runtime that launches the CLI or MCP server.", "Run 'baileys-agent doctor' before retrying."],
      false,
      details,
    );
  }
  if (/not linked|not paired|logged out|Pair again/i.test(details)) {
    return failure(
      "WHATSAPP_NOT_PAIRED",
      "WhatsApp is not connected to this account.",
      "No usable linked-device session exists, or WhatsApp logged the session out.",
      ["Run 'baileys-agent pair --terminal', use --phone-number, or call whatsapp_pair_start.", "Complete QR or one-time-code pairing, wait for connected status, then retry the action."],
      false,
      details,
    );
  }
  if (/Upstash Redis session storage is read-only/i.test(details)) {
    return failure(
      "SESSION_STORAGE_READ_ONLY",
      "The WhatsApp session store cannot save changes.",
      "The configured Upstash token permits reads but not writes, so pairing and credential updates cannot persist.",
      ["Replace the read-only token with a read-write Upstash token in this runtime.", "Run 'baileys-agent doctor' and continue only after Redis reports ok."],
      false,
      details,
    );
  }
  if (/No pairing session exists/i.test(details)) {
    return failure(
      "PAIRING_NOT_STARTED",
      "No active WhatsApp pairing session exists for this account.",
      "Pairing status was requested before a pairing process was started, or the previous process ended.",
      ["Call whatsapp_pair_start first, then poll whatsapp_pair_status until it reports connected."],
      false,
      details,
    );
  }
  if (/protocol.*outdated|protocol version|HTTP 405/i.test(details)) {
    return failure(
      "WHATSAPP_PROTOCOL_MISMATCH",
      "WhatsApp rejected or outgrew the current protocol implementation.",
      "WhatsApp changed its web protocol or the installed Baileys version is stale.",
      ["Update baileys-agent-kit and its locked Baileys dependency.", "Run 'baileys-agent doctor' and the compatibility check before retrying."],
      false,
      details,
    );
  }
  if (/Another WhatsApp action is running/i.test(details)) {
    return failure(
      "ACCOUNT_BUSY",
      "Another action already owns this WhatsApp account lock.",
      "Concurrent actions are blocked to prevent corrupted credentials and duplicate sends.",
      ["Wait for the active action to finish, then retry once."],
      true,
      details,
    );
  }
  if (/circuit is open/i.test(details)) {
    return failure(
      "SAFETY_CIRCUIT_OPEN",
      "Sending is temporarily paused after repeated failures.",
      "The safety circuit breaker opened to prevent a failing agent from retrying continuously.",
      ["Stop automatic retries and wait for the configured cooldown.", "Run 'baileys-agent doctor' and resolve the underlying connection problem first."],
      true,
      details,
    );
  }
  if (/Timed out waiting for a new matching WhatsApp message/i.test(details)) {
    return failure(
      "MESSAGE_WAIT_TIMEOUT",
      "No matching WhatsApp message arrived before the wait ended.",
      "The selected sender did not deliver a new message during the requested listening window.",
      ["Start another wait only if the user is still expected to reply.", "Increase timeoutSeconds up to 300 if a longer bounded wait is appropriate."],
      true,
      details,
    );
  }
  if (/limit reached|not in WA_ALLOWED_RECIPIENTS|Group administration is disabled/i.test(details)) {
    return failure(
      "SAFETY_POLICY_BLOCKED",
      "The action was blocked by the configured safety policy.",
      "A recipient allowlist, send limit, or group-administration restriction rejected the request before sending.",
      ["Do not bypass the policy automatically.", "Ask the account owner to approve the recipient or change the relevant WA_* setting, or wait for a daily limit to reset."],
      false,
      details,
    );
  }
  if (/Upstash|Redis/i.test(details)) {
    return failure(
      "SESSION_STORAGE_ERROR",
      "The WhatsApp session store is unavailable.",
      "The Upstash credentials may be wrong, expired, or unreachable from this runtime.",
      ["Verify the Upstash URL and token in this runtime.", "Run 'baileys-agent doctor' and retry only after Redis reports ok."],
      true,
      details,
    );
  }
  if (/pairing broker|PAIRING_BROKER/i.test(details)) {
    return failure(
      "PAIRING_BROKER_ERROR",
      "The private browser pairing service is not configured or reachable.",
      "The broker URL and secret are incomplete, mismatched, or the deployment rejected the request.",
      ["Set PAIRING_BROKER_URL and PAIRING_BROKER_SECRET together.", "Use terminal QR pairing if a browser link is not required."],
      true,
      details,
    );
  }
  if (/Timed out|Connection closed|Unable to connect|Connection Failure|fetch failed/i.test(details)) {
    return failure(
      "WHATSAPP_CONNECTION_FAILED",
      "The connection to WhatsApp did not become ready.",
      "The network, WhatsApp service, or saved session may be temporarily unavailable.",
      ["Run 'baileys-agent doctor' to separate configuration, session, and protocol problems.", "Retry once after connectivity is restored; pair again if doctor reports no session."],
      true,
      details,
    );
  }

  return failure(
    "OPERATION_FAILED",
    "The requested WhatsApp operation failed.",
    "The underlying library returned an error that has no more specific classification.",
    ["Inspect details without exposing credentials.", "Run 'baileys-agent doctor', correct the reported problem, and retry only if the action is safe to repeat."],
    false,
    details,
  );
}
