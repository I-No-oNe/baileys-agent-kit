import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/mcp.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});
const client = new Client({ name: "baileys-agent-kit-check", version: "1.0.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "whatsapp_capabilities",
    "whatsapp_doctor",
    "whatsapp_execute",
    "whatsapp_pair_start",
    "whatsapp_pair_status",
  ]);

  const capabilities = await client.callTool({ name: "whatsapp_capabilities", arguments: {} });
  const content = (capabilities as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const text = content.find((item): item is { type: "text"; text: string } => (
    typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"
  ));
  assert.ok(text);
  assert.equal(JSON.parse(text.text).actionTool.name, "whatsapp");
  assert.match(text.text, /send_album/);
  assert.match(text.text, /wait_for_message/);
  assert.match(text.text, /get_profile/);

  const missingPairing = await client.callTool({
    name: "whatsapp_pair_status",
    arguments: { accountId: "mcp-contract-check" },
  });
  const failureContent = (missingPairing as { content?: unknown }).content;
  assert.ok(Array.isArray(failureContent));
  const failureText = failureContent.find((item): item is { type: "text"; text: string } => (
    typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"
  ));
  assert.ok(failureText);
  const failure = JSON.parse(failureText.text);
  assert.equal(failure.code, "PAIRING_NOT_STARTED");
  assert.equal(failure.retryable, false);
  assert.ok(Array.isArray(failure.nextSteps));
  console.log("MCP tools, capability discovery, and failure guidance valid.");
} finally {
  await client.close();
}
