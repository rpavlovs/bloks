// Two Bloks on one ~/.bloks (the app beside a headless server) share the
// Cloud tokens on disk. When one activates Cloud again, the relay retires
// the old space, and the other kept dialling with the old token forever.
// A refused token now sends the link back to disk for newer ones.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";

test("a Mac whose space was replaced picks up the new tokens from disk", async (t) => {
  const dialled: string[] = [];
  const relay = createServer((req, res) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if ((req.url ?? "").startsWith("/space/agent/stream")) {
      dialled.push(token);
      if (token !== "new-agent-token") {
        res.writeHead(401, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "unknown token" }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      return void res.write(`data: ${JSON.stringify({ kind: "hello", spaceId: "space-new" })}\n\n`);
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const h = await startHarness({ BLOKS_RELAY_RETRY_MAX_MS: "500" });
  t.after(async () => {
    await h.stop();
    relay.closeAllConnections();
    relay.close();
  });

  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  await h.fetch("/api/relay", {
    method: "PUT",
    body: JSON.stringify({ url, agentToken: "old-agent-token", clientToken: "old-client", enabled: true }),
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    return check();
  };
  assert.ok(await until(() => dialled.includes("old-agent-token")), "the Mac never dialled");

  // the other Bloks on this folder activates again and saves new tokens
  const file = join(h.home, ".bloks", "config.json");
  const disk = JSON.parse(readFileSync(file, "utf8"));
  disk.relay = { ...disk.relay, agentToken: "new-agent-token", clientToken: "new-client" };
  writeFileSync(file, JSON.stringify(disk));

  // the next refusal reads them; no restart needed
  assert.ok(await until(() => dialled.includes("new-agent-token")), "the Mac kept dialling a retired space");
  assert.ok(await until(() => dialled.at(-1) === "new-agent-token"), "it went back to the old token");
});
