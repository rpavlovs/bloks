// Exercise stale results at the adapter boundary with the real server queue.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

type Outcome = "accepted" | "refused" | "uncertain";

async function exerciseStaleResult(t: TestContext, outcome: Outcome, negative = false) {
  const seam = mkdtempSync(join(tmpdir(), "bloks-preparation-stale-"));
  t.after(() => rmSync(seam, { recursive: true, force: true }));
  const preload = new URL("./helpers/preparation-stale-seam.mjs", import.meta.url).href;
  const s = await codexCommands(t, {
    NODE_OPTIONS: `--import=${preload}`,
    BLOKS_PREPARATION_SEAM: seam,
    BLOKS_PREPARATION_NEGATIVE: negative ? "1" : "",
  });
  const marker = (name: string) => join(seam, name);
  const readMarker = (name: string) => JSON.parse(readFileSync(marker(name), "utf8"));
  s.spec({ hold: true, holdSkills: true });
  await s.say("TURN_A $selected");
  await s.called("skills/list", 1);
  await s.say("OLD_SEAM_ROW");
  s.skillsGate();
  await waitFor(() => existsSync(marker("old.json")), "old dispatch was not captured");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "OLD_SEAM_ROW" && m.preparation?.state === "uncertain"));
  const old = (await s.messages()).find((m) => m.text === "OLD_SEAM_ROW")!;
  const oldDispatch = readMarker("old.json");
  assert.equal(old.id, oldDispatch.rowId);
  assert.equal((await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${old.id}/dismiss-preparation`, { method: "POST" })).status, 200);
  s.gate();
  await s.settled();
  rmSync(join(s.root, "gate"), { force: true });
  rmSync(join(s.root, "skill-gate"), { force: true });

  s.spec({ hold: true, holdSkills: true });
  const upload = await s.h.fetch("/api/attachments", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) });
  assert.equal(upload.status, 200);
  const imagePath = (await upload.json()).path;
  await s.say("TURN_B $selected");
  await s.called("skills/list", 2);
  await s.say(`CURRENT_SEAM_ROW\n<attached-image path="${imagePath}" />`);
  s.skillsGate();
  await waitFor(() => existsSync(marker("current.json")), "new dispatch was not captured");
  await s.say("PENDING_SEAM_ROW");
  const currentDispatch = readMarker("current.json");
  assert.match(currentDispatch.words, /CURRENT_SEAM_ROW/);
  assert.equal(currentDispatch.imageCount, 1);
  const before = await s.messages();
  const current = before.find((m) => m.id === currentDispatch.rowId)!;
  const pending = before.find((m) => m.text === "PENDING_SEAM_ROW")!;
  assert.notEqual(currentDispatch.attempt, oldDispatch.attempt);
  assert.notEqual(currentDispatch.turnId, oldDispatch.turnId);
  assert.equal(current.preparation?.state, "dispatching");
  assert.equal(pending.preparation?.state, "pending");
  assert.equal(current.preparation?.attempt, currentDispatch.attempt);
  assert.equal(pending.preparation?.attempt, currentDispatch.attempt);
  writeFileSync(marker("trigger-old"), outcome);
  await waitFor(() => existsSync(marker("triggered-old")), "old result was not delivered");
  assert.deepEqual(readMarker("triggered-old"), currentDispatch);
  const after = await s.messages();
  const oldAfter = after.find((m) => m.id === old.id)!;
  assert.equal(oldAfter.preparation?.dismissed, true);
  assert.equal(oldAfter.queued, false);
  assert.equal(oldAfter.preparation?.state, outcome === "accepted" ? "joined" : outcome === "refused" ? "not-sent" : "uncertain", "the old result must settle its own row");
  assert.deepEqual(after.find((m) => m.id === current.id), current);
  assert.deepEqual(after.find((m) => m.id === pending.id), pending);
  writeFileSync(marker("release-current"), "1");
  await waitFor(async () => (await s.messages()).some((m) => m.id === pending.id && m.preparation?.state === "joined"));
  s.gate();
  await s.settled();
  const nativeInputs = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method)).map((c) => JSON.stringify(c.params.input)).join("\n");
  assert.match(nativeInputs, /PENDING_SEAM_ROW/);
  assert.doesNotMatch(nativeInputs, /OLD_SEAM_ROW/);
}

for (const outcome of ["accepted", "refused", "uncertain"] as const) {
  test(`a stale ${outcome} result cannot change a newer preparation attempt`, (t) => exerciseStaleResult(t, outcome));
}

test("the stale-result assertion detects attribution to a newer attempt", async (t) => {
  await assert.rejects(exerciseStaleResult(t, "accepted", true), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.includes("the old result must settle its own row"));
});
