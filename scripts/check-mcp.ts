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
  console.log("MCP tools and capability discovery valid.");
} finally {
  await client.close();
}
