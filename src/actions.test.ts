import assert from "node:assert/strict";
import test from "node:test";
import { actionSchema, llmTool } from "./actions";

test("accepts a valid text action", () => {
  assert.deepEqual(actionSchema.parse({ action: "send_text", to: "+15551234567", text: "Hello" }), {
    action: "send_text",
    to: "+15551234567",
    text: "Hello",
  });
});

test("rejects unsupported actions and unsafe oversized text", () => {
  assert.equal(actionSchema.safeParse({ action: "run_code", code: "anything" }).success, false);
  assert.equal(actionSchema.safeParse({ action: "send_text", to: "1", text: "x".repeat(5001) }).success, false);
});

test("exports an LLM-compatible JSON schema", () => {
  assert.equal(llmTool.name, "whatsapp");
  assert.equal(llmTool.inputSchema.type, "object");
});
