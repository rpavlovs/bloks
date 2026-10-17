// What the agent's command line says when it cannot reach the workspace
// (GitHub 251). A sandbox with no network access refuses even this
// computer's own address, and "fetch failed" read as Bloks being down:
// an agent retried a command that only needed permission to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BLOKS = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
const TOKEN = "turn-token-that-must-not-print";

function run(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; raw: string; out: any }>((resolve) => {
    execFile(process.execPath, [BLOKS, ...args], { env: { ...process.env, BLOKS_TOKEN: TOKEN, ...env } }, (error, stdout) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, raw: stdout, out: JSON.parse(stdout) });
    });
  });
}

/** A port nothing listens on: taken, then given back. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

test("a sandbox that refuses the network is named, with the way out", async (t) => {
  // fetch fails the way it does under a sandbox: "fetch failed", with the
  // refusal in its cause
  const dir = mkdtempSync(join(tmpdir(), "bloks-cli-sandbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "refuse.mjs");
  writeFileSync(
    preload,
    `globalThis.fetch = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect EPERM 127.0.0.1:8799"), { code: "EPERM" }) }); };\n`,
  );
  const { code, raw, out } = await run(["whoami"], {
    BLOKS_URL: "http://127.0.0.1:8799",
    NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
  });
  assert.equal(code, 1);
  assert.match(out.error, /^network access required/);
  assert.match(out.error, /again with network access allowed/);
  assert.match(out.error, /http:\/\/127\.0\.0\.1:8799/);
  assert.doesNotMatch(out.error, /fetch failed/);
  assert.ok(!raw.includes(TOKEN), "the credential was printed");
});

test("a workspace that is not running is told apart from a sandbox", async () => {
  const port = await closedPort();
  const { code, raw, out } = await run(["agents"], { BLOKS_URL: `http://127.0.0.1:${port}` });
  assert.equal(code, 1);
  assert.match(out.error, /^nothing is answering at http:\/\/127\.0\.0\.1:\d+/);
  assert.doesNotMatch(out.error, /network access required|fetch failed/);
  assert.ok(!raw.includes(TOKEN), "the credential was printed");
});

test("any other failure still points at the sandbox as the likely cause", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-cli-other-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "fail.mjs");
  writeFileSync(preload, `globalThis.fetch = async () => { throw new TypeError("fetch failed"); };\n`);
  const { out } = await run(["rooms"], {
    BLOKS_URL: "http://127.0.0.1:8799",
    NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
  });
  assert.match(out.error, /^could not reach the Bloks workspace at http:\/\/127\.0\.0\.1:8799\./);
  assert.match(out.error, /run the same command again with network access allowed/);
});

test("help says the commands need this computer's network", async () => {
  const { code, out } = await run(["help"], {});
  assert.equal(code, 0);
  assert.match(out.network, /network access required/);
});
