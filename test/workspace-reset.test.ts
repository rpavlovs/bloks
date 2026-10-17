// Start fresh, from the first-run screen.
//
// It moved the workspace folder aside and carried on, with the old agents
// still in memory, so the page reloaded into the same workspace and the
// next save wrote it into the new folder. It also took every key and
// engine connection with it, since those live in the same folder.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";

test("starting fresh archives the workspace, keeps the settings, and restarts", async () => {
  const h = await startHarness();
  try {
    await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Old Friend" }) });
    await h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ setupDone: true }) });
    await h.fetch("/api/providers/ollama/connect", {
      method: "POST",
      body: JSON.stringify({ url: "http://127.0.0.1:9/v1" }),
    });

    const res = await h.fetch("/api/workspace/reset", { method: "POST" });
    assert.equal(res.status, 200);
    const { archivedTo, restarting } = await res.json();
    assert.equal(restarting, true);

    // the process ends, so nothing it still holds can be written back
    const until = Date.now() + 5_000;
    let down = false;
    while (!down && Date.now() < until) {
      down = await fetch(`${h.url}/api/health`).then(() => false, () => true);
      if (!down) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(down, "the server kept running on the old workspace");

    const fresh = join(h.home, ".bloks");
    assert.ok(existsSync(archivedTo), "the old workspace is not where the answer said");
    assert.ok(readFileSync(join(archivedTo, "bots.json"), "utf8").includes("Old Friend"));
    // the fresh folder has the settings and nothing else of the old one
    assert.deepEqual(readdirSync(fresh), ["config.json"]);
    const kept = JSON.parse(readFileSync(join(fresh, "config.json"), "utf8"));
    assert.equal(kept.setupDoneAt, undefined, "setup would be skipped on the fresh workspace");
    assert.ok(JSON.stringify(kept).includes("127.0.0.1:9"), "the engine connection did not carry over");
  } finally {
    await h.stop();
  }
});
