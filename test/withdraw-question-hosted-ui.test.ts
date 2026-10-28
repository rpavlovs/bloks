// CI-only proof: build the real UI and exercise it with synthetic inputs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("built UI lets a withdrawn question go from everywhere it waited", { timeout: 290_000 }, () => {
  const proof = fileURLToPath(new URL("./helpers/withdraw-question-hosted-ui-proof.mjs", import.meta.url));
  // a runner of its own: one that thinks it is inside this file's runner skips its files
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-timeout=120000", proof], {
    encoding: "utf8", timeout: 275_000, maxBuffer: 8 * 1024 * 1024, env,
  });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /# pass 2\b/, output);
  console.log(output);
});
