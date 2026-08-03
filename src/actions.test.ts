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

test("accepts a text reply with quoted message context", () => {
  assert.deepEqual(actionSchema.parse({
    action: "reply_text",
    recipient: "120363000000@g.us",
    messageId: "quoted-message-1",
    participant: "+15551234567",
    quotedText: "Original message",
    text: "Reply",
  }), {
    action: "reply_text",
    recipient: "120363000000@g.us",
    messageId: "quoted-message-1",
    participant: "+15551234567",
    quotedText: "Original message",
    text: "Reply",
  });
});

test("accepts media albums and bounded message waits", () => {
  assert.equal(actionSchema.safeParse({
    action: "send_album",
    to: "+15551234567",
    items: [
      { type: "image", url: "https://example.com/one.jpg", caption: "One" },
      { type: "video", url: "https://example.com/two.mp4" },
    ],
  }).success, true);
  assert.deepEqual(actionSchema.parse({
    action: "wait_for_message",
    from: "120363000000@g.us",
    participant: "+15551234567",
    timeoutSeconds: 30,
  }), {
    action: "wait_for_message",
    from: "120363000000@g.us",
    participant: "+15551234567",
    timeoutSeconds: 30,
  });
});

test("accepts a single-number profile lookup", () => {
  assert.deepEqual(actionSchema.parse({ action: "get_profile", number: "+15551234567" }), {
    action: "get_profile",
    number: "+15551234567",
  });
  assert.equal(actionSchema.safeParse({ action: "get_profile", number: "120363000000@g.us" }).success, false);
});

test("accepts bounded recent-account prefetching", () => {
  assert.deepEqual(actionSchema.parse({ action: "list_recent_accounts", limit: 25, prefetchSeconds: 8 }), {
    action: "list_recent_accounts",
    limit: 25,
    prefetchSeconds: 8,
  });
  assert.equal(actionSchema.safeParse({ action: "list_recent_accounts", prefetchSeconds: 31 }).success, false);
});

test("requires 2 to 10 album items and caps wait time", () => {
  assert.equal(actionSchema.safeParse({
    action: "send_album",
    to: "+15551234567",
    items: [{ type: "image", url: "https://example.com/one.jpg" }],
  }).success, false);
  assert.equal(actionSchema.safeParse({
    action: "wait_for_message",
    from: "+15551234567",
    timeoutSeconds: 301,
  }).success, false);
});

test("rejects unsupported actions and unsafe oversized text", () => {
  assert.equal(actionSchema.safeParse({ action: "run_code", code: "anything" }).success, false);
  assert.equal(actionSchema.safeParse({ action: "send_text", to: "1", text: "x".repeat(5001) }).success, false);
});

test("exports an LLM-compatible JSON schema", () => {
  assert.equal(llmTool.name, "whatsapp");
  assert.equal(llmTool.inputSchema.type, "object");
});
