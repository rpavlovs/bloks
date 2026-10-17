// The bloks-app MCP connector (bin/bloks-mcp.mjs), from #81: a message
// that went to a lane other than the open one had its reply read from the
// open one, so the connector said "still working" while the answer sat
// elsewhere. Driven the way Claude Code drives it, over stdio, against a
// real harness and a stand-in engine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startHarness, type Harness } from "./helpers/server.ts";

let h: Harness;
const engine = createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "stand-in" }] }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const asked = JSON.parse(body).messages.at(-1).content as string;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const reply = `Answer to: ${asked.slice(-40)}. ${"Long detail. ".repeat(20)}`;
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`);
  });
});

before(async () => {
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
  h = await startHarness();
  await h.fetch("/api/providers/ollama/connect", {
    method: "POST",
    body: JSON.stringify({ url: `http://127.0.0.1:${(engine.address() as any).port}/v1` }),
  });
});

after(async () => {
  engine.close();
  await h?.stop();
});

function connector() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/bloks-mcp.mjs", import.meta.url))], {
    env: { ...process.env, BLOKS_URL: h.url },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map<number, (v: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  });
  let id = 0;
  const call = (name: string, args: object) =>
    new Promise<string>((resolve) => {
      const n = ++id;
      pending.set(n, (msg) => resolve(msg.result?.content?.[0]?.text ?? JSON.stringify(msg)));
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name, arguments: args } })}\n`);
    });
  return { call, stop: () => child.kill() };
}

test("a message sent to a lane that is not open is answered from that lane", { timeout: 60_000 }, async () => {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Laner" }) });
  await h.json(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "ollama", model: "stand-in" } }),
  });
  // a second lane, then the first one open again, so the lane asked for
  // is not the one the app has open
  const { bot: two } = await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Notion board" }) });
  const general = two.tasks.find((t: any) => t.title !== "Notion board");
  await h.fetch(`/api/bots/${bot.id}/tasks/${general.id}/activate`, { method: "POST" });

  const mcp = connector();
  try {
    const listed = await mcp.call("list_agents", {});
    assert.match(listed, /Laner/);
    assert.match(listed, /Notion board/, "lanes are not listed");

    const answer = await mcp.call("ask_agent", { agent: "Laner", message: "group the board please", lane: "notion" });
    assert.match(answer, /in "Notion board"/, answer);
    assert.match(answer, /Answer to: .*group the board please/, answer);

    // read_conversation remembers the lane ask_agent used
    const read = await mcp.call("read_conversation", { agent: "Laner" });
    assert.match(read, /Conversation "Notion board"/);
    assert.match(read, /group the board please/);

    // search gives an id, and read_message opens the whole of it
    const found = await mcp.call("search", { query: "Long detail" });
    const id = found.match(/\[id: ([\w-]+\/[\w-]+)\]/)?.[1];
    assert.ok(id, found);
    const whole = await mcp.call("read_message", { id });
    assert.equal((whole.match(/Long detail\./g) ?? []).length, 20, "the message came back cut");
  } finally {
    mcp.stop();
  }
});

test("a message says which lane it landed in", async () => {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Lander" }) });
  const res = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
  assert.equal(res.taskId, bot.tasks[0].id);
  assert.equal(res.lane, "General");
});
