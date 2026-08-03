import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { explainError } from "./explain-error";

test("explains invalid action input for an LLM", () => {
  const result = z.object({ text: z.string() }).safeParse({ text: 3 });
  assert.equal(result.success, false);
  if (result.success) return;
  const explanation = explainError(result.error);
  assert.equal(explanation.code, "INVALID_ACTION");
  assert.equal(explanation.retryable, false);
  assert.ok(explanation.issues?.length);
});

test("explains missing configuration with a concrete next step", () => {
  const explanation = explainError(new Error("Missing required environment variable: UPSTASH_REDIS_REST_URL"));
  assert.equal(explanation.code, "MISSING_CONFIGURATION");
  assert.match(explanation.nextSteps.join(" "), /doctor/);
});

test("distinguishes a read-only session token from an unavailable store", () => {
  const result = explainError(new Error("Upstash Redis session storage is read-only: ERR read only token"));
  assert.equal(result.code, "SESSION_STORAGE_READ_ONLY");
  assert.equal(result.retryable, false);
  assert.match(result.nextSteps[0], /read-write Upstash token/);
});

test("explains safety and transient failures without blind retries", () => {
  const blocked = explainError(new Error("Recipient 1@s.whatsapp.net is not in WA_ALLOWED_RECIPIENTS."));
  assert.equal(blocked.code, "SAFETY_POLICY_BLOCKED");
  assert.equal(blocked.retryable, false);

  const busy = explainError(new Error("Another WhatsApp action is running for account 'default'."));
  assert.equal(busy.code, "ACCOUNT_BUSY");
  assert.equal(busy.retryable, true);
});

test("explains message wait timeouts as safe to retry", () => {
  const result = explainError(new Error("Timed out waiting for a new matching WhatsApp message."));
  assert.equal(result.code, "MESSAGE_WAIT_TIMEOUT");
  assert.equal(result.retryable, true);
});

test("asks Israeli users for a phone number before code pairing", () => {
  const result = explainError(new Error("Israel was detected. A phone number with country code is required for one-time-code pairing."));
  assert.equal(result.code, "PAIRING_PHONE_NUMBER_REQUIRED");
  assert.equal(result.retryable, false);
  assert.match(result.likelyCause, /one-time-code/);
});

test("redacts credentials from technical details", () => {
  const explanation = explainError(new Error("request failed token=secret-value npm_abcdefghijklmnopqrstuvwxyz"));
  assert.doesNotMatch(explanation.details ?? "", /secret-value|npm_abcdefghijklmnopqrstuvwxyz/);
});
