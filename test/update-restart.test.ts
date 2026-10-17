// "Relaunch to update" has to end in a restart (GitHub 267;
// electron/update-restart.mjs).
//
// Bloks was found still running on the old version, with the update
// downloaded, the installer waiting for it to quit, and the same button
// on the card. So: every step between the press and the
// exit has a time limit, one that fails or never finishes does not stop
// the next, the process ends once nobody can call it off, and a start on
// the version that was being left says the update did not install, once.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  markInstall,
  RESTART_LIMITS,
  restartIntoUpdate,
  takeInstallMark,
  within,
  type RestartSteps,
} from "../electron/update-restart.mjs";

const ORDER = ["look", "drain", "mark", "staged", "quit", "closeWindows", "teardown", "exit"] as const;
type Step = (typeof ORDER)[number];

/** Limits short enough to run out in a test. */
const SHORT = { look: 15, drain: 15, mark: 15, staged: 15, quit: 15, teardown: 15 };

/** A restart whose steps only write down that they ran, in a process
 * that is still there after the quit: the pauses pass at once. `how`
 * says which steps break or never finish. */
function restart(how: Partial<Record<Step, "breaks" | "hangs" | (() => unknown)>> = {}) {
  const did: Step[] = [];
  const lines: string[] = [];
  const waits: number[] = [];
  const steps = Object.fromEntries(
    ORDER.map((name) => [
      name,
      () => {
        did.push(name);
        const way = how[name];
        if (way === "breaks") throw new Error(`${name} broke`);
        if (way === "hangs") return new Promise(() => {});
        if (typeof way === "function") return way();
        return name === "closeWindows" ? 0 : undefined;
      },
    ]),
  ) as unknown as RestartSteps;
  return {
    did,
    lines,
    waits,
    run: (limits: Partial<typeof RESTART_LIMITS> = {}, wait?: (ms: number) => Promise<void>) =>
      restartIntoUpdate(steps, {
        limits,
        log: (line) => lines.push(line),
        wait:
          wait ??
          (async (ms) => {
            waits.push(ms);
          }),
        from: "2.5.34",
        to: "2.5.35",
      }),
  };
}

test("a restart takes its steps in order, and each one is in the log", async () => {
  const r = restart({ look: () => "nothing newer", drain: () => "done", closeWindows: () => 1 });
  assert.equal(await r.run(), "exited");
  assert.deepEqual(r.did, [...ORDER]);
  assert.deepEqual(r.waits, [RESTART_LIMITS.orderly, RESTART_LIMITS.forced]);
  assert.deepEqual(r.lines, [
    "restart: asked, on 2.5.34, to install 2.5.35",
    "restart: the look for a newer release: nothing newer",
    "restart: the wait for running turns: done",
    "restart: the note of the version being left: done",
    "restart: the wait for the installer to have the update: done",
    "restart: quitting to install",
    "restart: still running after 10s, closing the windows left open: 1 had stayed open",
    "restart: still running after another 10s, stopping the server: done",
    "restart: forced exit",
  ]);
});

test("the quit is given its time before anything is closed or ended for it", async () => {
  const r = restart();
  const gates: Array<() => void> = [];
  const running = r.run({}, () => new Promise<void>((resolve) => gates.push(resolve)));
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  // an orderly quit ends the process here, and nothing below ever runs
  await settle();
  assert.equal(r.did.at(-1), "quit");
  assert.equal(r.lines.at(-1), "restart: quitting to install", "the quit was not in the log before it was asked for");
  gates[0]();
  await settle();
  assert.equal(r.did.at(-1), "closeWindows", "the process was ended before the windows left open were closed");
  gates[1]();
  assert.equal(await running, "exited");
  assert.deepEqual(r.did.slice(-2), ["teardown", "exit"]);
});

test("a step that fails does not stop the restart, and the exit is still reached", async () => {
  for (const name of ORDER.slice(0, -1)) {
    const r = restart({ [name]: "breaks" });
    assert.equal(await r.run(), "exited", `${name} failing stopped the restart`);
    assert.deepEqual(r.did, [...ORDER], `${name} failing changed what ran`);
    assert.ok(
      r.lines.some((line) => line.includes("failed") && line.includes(`${name} broke`)),
      `${name} failing left no line in the log`,
    );
  }
  // and an exit that throws is not thrown at the button
  const r = restart({ exit: "breaks" });
  assert.equal(await r.run(), "exited");
  assert.equal(r.lines.at(-1), "restart: the exit failed: exit broke");
});

test("a step that never finishes runs out of time, and the exit is still reached", async () => {
  for (const name of ORDER.slice(0, -1)) {
    const r = restart({ [name]: "hangs" });
    const started = Date.now();
    assert.equal(await r.run(SHORT), "exited", `${name} never finishing held the restart`);
    assert.ok(Date.now() - started < 2_000, `${name} never finishing held the restart`);
    assert.deepEqual(r.did, [...ORDER], `${name} never finishing changed what ran`);
    assert.ok(
      r.lines.some((line) => line.includes("was not done after")),
      `${name} running out of time left no line in the log`,
    );
  }
});

test("every step failing at once still ends the process", async () => {
  const r = restart(Object.fromEntries(ORDER.slice(0, -1).map((name) => [name, "breaks"])));
  assert.equal(await r.run(), "exited");
  assert.equal(r.did.at(-1), "exit");
  const hung = restart(Object.fromEntries(ORDER.slice(0, -1).map((name) => [name, "hangs"])));
  assert.equal(await hung.run(SHORT), "exited");
  assert.equal(hung.did.at(-1), "exit");
});

test("calling the wait for running turns off stops the restart before it leaves a mark", async () => {
  const r = restart({ drain: () => "cancel" });
  assert.equal(await r.run(), "cancelled");
  assert.deepEqual(r.did, ["look", "drain"]);
  assert.equal(r.lines.at(-1), "restart: called off");
  // restart now is not a cancel
  const now = restart({ drain: () => "now" });
  assert.equal(await now.run(), "exited");
  assert.deepEqual(now.did, [...ORDER]);
});

test("work is waited for only as long as it is given", async () => {
  assert.deepEqual(await within(() => 7, 50), { outcome: "done", value: 7 });
  assert.deepEqual(await within(async () => "ok", 50), { outcome: "done", value: "ok" });
  const thrown = await within(() => {
    throw new Error("no");
  }, 50);
  assert.equal(thrown.outcome, "failed");
  assert.equal((await within(() => Promise.reject(new Error("no")), 50)).outcome, "failed");
  // a helper that never answers the quit: the quit goes on without it
  const started = Date.now();
  assert.deepEqual(await within(() => new Promise(() => {}), 30), { outcome: "late" });
  assert.ok(Date.now() - started < 2_000);
});

test("a start on the version that was being left says the update did not install, once", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-update-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "update-restart.json");

  assert.equal(takeInstallMark(file, "2.5.34"), null, "no restart was asked for");

  markInstall(file, { from: "2.5.34", to: "2.5.35" });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort(), ["at", "from", "to"], "the note holds more than it needs");
  assert.deepEqual(takeInstallMark(file, "2.5.34"), { from: "2.5.34", to: "2.5.35" });
  assert.equal(existsSync(file), false, "the note was left to be said again");
  assert.equal(takeInstallMark(file, "2.5.34"), null, "said twice");
});

test("a start on another version means the update installed, and the note goes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-update-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "update-restart.json");

  markInstall(file, { from: "2.5.34", to: "2.5.35" });
  assert.equal(takeInstallMark(file, "2.5.35"), null);
  assert.equal(existsSync(file), false);

  // a newer release than the one it left for, or an older one put back by hand
  markInstall(file, { from: "2.5.34", to: "2.5.35" });
  assert.equal(takeInstallMark(file, "2.6.0"), null);
  markInstall(file, { from: "2.5.34", to: "2.5.35" });
  assert.equal(takeInstallMark(file, "2.5.33"), null);
  assert.equal(existsSync(file), false);

  // the version it was meant to become is not always known
  markInstall(file, { from: "2.5.34" });
  assert.deepEqual(takeInstallMark(file, "2.5.34"), { from: "2.5.34", to: null });
});

test("a note that cannot be read is cleared and says nothing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-update-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "update-restart.json");

  for (const junk of ["", "not json", "null", "[]", '{"to":"2.5.35"}', '{"from":7}']) {
    writeFileSync(file, junk);
    assert.equal(takeInstallMark(file, "2.5.34"), null, `"${junk}" was read as an update that did not install`);
    assert.equal(existsSync(file), false, `"${junk}" was left behind`);
  }
});
