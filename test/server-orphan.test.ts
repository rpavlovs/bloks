// A server left with nobody listening (server/index.ts, the stdio error
// listeners and BLOKS_TEST_PARENT_PID). Test servers from files the
// runner had killed were found days later, each on a full core, two of
// them deaf to SIGTERM: their log lines had nowhere to go, and every
// failed one raised another.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../server/index.ts", import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-orphan-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  // a server that keeps saying things, the way one in the middle of
  // Telegram turns does
  const chatty = join(home, "chatty.mjs");
  writeFileSync(chatty, `setInterval(() => console.error("[test] still here"), 20).unref();\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmpdir(),
    PATH: "/nonexistent",
    // like the harness, a high port at random: the startup line names it
    BLOKS_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
    BLOKS_LOOPBACK_ONLY: "1",
    BLOKS_TEST_PARENT_PID: String(process.pid),
  };
  return { home, chatty, env };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, within: number) {
  const until = Date.now() + within;
  while (alive(pid) && Date.now() < until) await pause(50);
  return !alive(pid);
}

test("a server whose log reader is gone keeps answering, and SIGTERM still stops it", async (t) => {
  const f = fixture(t);
  const child: ChildProcess = spawn(process.execPath, ["--import", f.chatty, ENTRY], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", () => {});
  const until = Date.now() + 60_000;
  while (!/bloks server on (http:\/\/\S+)/.test(out) && child.exitCode === null && Date.now() < until) await pause(50);
  const url = out.match(/bloks server on (http:\/\/\S+)/)?.[1];
  assert.ok(url, `the server did not start: ${out.slice(-400)}`);

  // the reader goes, the server goes on logging into the broken pipe
  child.stderr!.destroy();
  await pause(1_000);

  const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5_000) }).catch((e: Error) => e);
  assert.ok(!(health instanceof Error) && health.ok, `the server stopped answering: ${health}`);

  child.kill("SIGTERM");
  assert.ok(await gone(child.pid!, 10_000), "SIGTERM did not end the server");
});

/** Stands in for a test file: starts a server, telling it who started
 * it the way the harness does, and says the server's pid once it is up
 * (or, with `early`, as soon as it is spawned). */
function starter(f: ReturnType<typeof fixture>, early: boolean) {
  return `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["--import", ${JSON.stringify(f.chatty)}, ${JSON.stringify(ENTRY)}], {
      env: { ...process.env, BLOKS_TEST_PARENT_PID: String(process.pid) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    if (${early}) console.log("pid " + child.pid);
    else child.stdout.on("data", (c) => { out += c; if (out.includes("bloks server on")) console.log("pid " + child.pid); });
    child.stderr.on("data", () => {});
  `;
}

async function startedBy(t: TestContext, f: ReturnType<typeof fixture>, early: boolean) {
  const parent = spawn(process.execPath, ["-e", starter(f, early)], { env: f.env, stdio: ["ignore", "pipe", "inherit"] });
  let said = "";
  parent.stdout!.on("data", (c) => (said += c));
  t.after(() => parent.kill("SIGKILL"));
  const until = Date.now() + 60_000;
  while (!/pid \d+/.test(said) && parent.exitCode === null && Date.now() < until) await pause(20);
  const pid = Number(said.match(/pid (\d+)/)?.[1]);
  assert.ok(pid, "the server did not start");
  t.after(() => {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  return { parent, pid };
}

test("a test server stops when the process that started it is killed", async (t) => {
  const f = fixture(t);
  const { parent, pid } = await startedBy(t, f, false);
  parent.kill("SIGKILL");
  assert.ok(await gone(pid, 15_000), "the server outlived the process that started it");
});

test("a test server stops when the process that started it was killed before it finished loading", async (t) => {
  const f = fixture(t);
  const { parent, pid } = await startedBy(t, f, true);
  parent.kill("SIGKILL");
  assert.ok(await gone(pid, 60_000), "the server outlived the process that started it");
});
