// Our own connection to a registered MCP server (server/mcp-client.ts).
//
// The handshake ends with `notifications/initialized`, which is a
// notification: a server that follows the spec never answers it. Sent as
// a request, with an id, the client waited for that answer forever and
// every call to such a server hung. This server answers requests and
// stays silent on notifications, as the spec says it should.
import assert from "node:assert/strict";
import { test } from "node:test";

import { McpClient } from "../server/mcp-client.ts";

const SERVER = [
  'const rl = require("node:readline").createInterface({ input: process.stdin });',
  "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
  "rl.on('line', (line) => {",
  "  const msg = JSON.parse(line);",
  "  if (msg.method.startsWith('notifications/')) return;",
  "  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'quiet', version: '1' } });",
  "  if (msg.method === 'tools/list') return reply(msg.id, { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });",
  "});",
].join("\n");

test("a server that stays silent on notifications still answers", { timeout: 15_000 }, async () => {
  const client = new McpClient();
  try {
    const config = { id: "quiet", name: "Quiet", transport: "stdio" as const, command: process.execPath, args: ["-e", SERVER] };
    const started = Date.now();
    const tools = await client.tools(config);
    assert.deepEqual(tools.map((t) => t.name), ["echo"]);
    assert.ok(Date.now() - started < 5_000, "the handshake waited on a notification");
  } finally {
    client.closeAll();
  }
});
