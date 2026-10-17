// Replies that stream, against a stand-in engine.
//
// Two ways a stream went wrong: the last event arriving without its
// trailing newline was dropped, and a stream that stopped sending held
// the agent on "working" forever, because a chat turn's own abort signal
// replaced the only deadline there was.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

let h: Harness;
let mode: "whole" | "stall" = "whole";
const engine = createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "stand-in" }] }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`;
    if (mode === "whole") {
      res.write(`${delta("Hello ")}\n\n`);
      // the last event, and no newline after it
      res.end(delta("there"));
      return;
    }
    // one word, then nothing at all
    res.write(`${delta("Thinking")}\n\n`);
  });
});

before(async () => {
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
  h = await startHarness({ BLOKS_STREAM_IDLE_MS: "1500" });
  await h.fetch("/api/providers/ollama/connect", {
    method: "POST",
    body: JSON.stringify({ url: `http://127.0.0.1:${(engine.address() as any).port}/v1` }),
  });
});

after(async () => {
  engine.closeAllConnections?.();
  engine.close();
  await h?.stop();
});

async function turn(text: string) {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: `Streamer ${mode}` }) });
  const { instances } = await h.json("/api/instances");
  const ollama = instances.find((i: any) => i.instanceId === "ollama");
  assert.ok(ollama, "the stand-in engine never appeared");
  await h.json(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "ollama", model: "stand-in" } }),
  });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  const until = Date.now() + 15_000;
  for (;;) {
    const { bots } = await h.json("/api/bots");
    const now = bots.find((b: any) => b.id === bot.id);
    // done when the agent is idle again and the last word is its own
    const settled = !now.busy && now.messages.at(-1)?.role !== "user";
    if (settled || Date.now() > until) return now;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("the last event of a stream is kept even without its newline", async () => {
  mode = "whole";
  const bot = await turn("say hello");
  const reply = bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text").at(-1);
  assert.equal(reply?.text, "Hello there");
});

test("a stream that goes quiet ends the turn and says so", async () => {
  mode = "stall";
  const bot = await turn("think about it");
  assert.equal(Boolean(bot.busy), false, "the agent was left working on a dead stream");
  const notice = bot.messages.find((m: any) => m.kind === "notice");
  assert.match(notice?.text ?? "", /stopped sending/);
});
