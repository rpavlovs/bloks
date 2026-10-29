// CI-only proof of the built app using synthetic, read-only loopback data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("built plan notices identify windows and update their countdown", { timeout: 290_000 }, () => {
  const proof = fileURLToPath(new URL("./helpers/plan-ui-proof.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [proof], { encoding: "utf8", timeout: 275_000, maxBuffer: 8 * 1024 * 1024, env });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  for (const language of ["en", "es"]) {
    for (const caseName of ["short across midnight", "distinct simultaneous limits", "new client with a legacy notice", "unknown reset", "under one minute", "keyboard View usage", "unchanged notices keep the whole status live"]) {
      assert.ok(output.includes(`PASS ${language} ${caseName}`), output);
    }
  }
  assert.match(output, /PASS no external requests, accepted writes or renderer errors/);
  console.log(output);
});
