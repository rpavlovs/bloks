// Engines that are out of date (server/engine-updates.ts).
//
// A model that is missing from the list is usually a CLI from before the
// model shipped. What matters: versions compare as numbers, an update
// lands in the folder the engine already lives in (anywhere else is a
// second copy the first one shadows), and nothing from the network may
// start one.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { ENGINE_PACKAGES, isNewer, versionOf } from "../server/engine-updates.ts";
import { runSetupScript } from "../server/engine-setup.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

test("versions are read out of what a CLI prints, and compared as numbers", () => {
  assert.equal(versionOf("2.1.252 (Claude Code)"), "2.1.252");
  assert.equal(versionOf("codex-cli 0.48.0"), "0.48.0");
  assert.equal(versionOf("nothing here"), null);
  assert.equal(isNewer("2.1.300", "2.1.252"), true);
  assert.equal(isNewer("2.10.0", "2.9.9"), true, "compared as text, 2.10 would lose to 2.9");
  assert.equal(isNewer("2.1.252", "2.1.252"), false);
  assert.equal(isNewer("1.9.0", "2.0.0"), false);
});

test("an update installs into the prefix the engine already lives in", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bloks-update-"));
  const prefix = join(root, "prefix");
  const tools = join(root, "tools");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(tools);
  // the installed engine, and an npm that writes down what it was asked
  writeFileSync(join(prefix, "bin", "codex"), "#!/bin/sh\necho codex-cli 0.1.0\n");
  writeFileSync(join(tools, "npm"), `#!/bin/sh\necho "$@" > "${join(root, "npm-args")}"\n`);
  chmodSync(join(prefix, "bin", "codex"), 0o755);
  chmodSync(join(tools, "npm"), 0o755);
  const script = `export PATH="${join(prefix, "bin")}:${tools}:$PATH"\n${ENGINE_PACKAGES.codex.update}`;
  const result = await runSetupScript(script);
  assert.equal(result.ok, true, result.log);
  const args = readFileSync(join(root, "npm-args"), "utf8");
  assert.match(args, new RegExp(`--prefix ${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(args, /@openai\/codex@latest/);
});

describe("the routes", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h?.stop();
  });

  test("no engines here means nothing to update", async () => {
    const { updates } = await h.json("/api/engines/updates");
    assert.deepEqual(updates, {});
  });

  test("nothing from the network may start an update", async () => {
    const remote = await h.fetchRemote("/api/engines/codex/update", { method: "POST", body: "{}" });
    assert.ok(remote.status === 401 || remote.status === 403, `answered ${remote.status}`);
    const unknown = await h.fetch("/api/engines/nonsense/update", { method: "POST", body: "{}" });
    assert.equal(unknown.status, 404);
  });
});
