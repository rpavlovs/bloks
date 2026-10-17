// The backup engine picker: other models on the agent's own engine are
// offered, the exact engine and model it runs on is not, and a backup on
// the same engine is flagged, since it cannot cover that engine being out.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { backupOptions, isOwnRun, offersBackup, sameEngineBackup } from "../src/lib/backupChoice.ts";

const claude = {
  instanceId: "claude",
  models: { default: "opus", options: [{ id: "opus" }, { id: "sonnet" }, { id: "haiku" }] },
};
const codex = { instanceId: "codex", models: { default: "gpt", options: [{ id: "gpt" }] } };

describe("what the backup picker offers", () => {
  test("other models on the agent's own engine, never the one it runs", () => {
    const own = { instanceId: "claude", model: "sonnet" };
    assert.deepEqual(backupOptions(claude, own).map((o) => o.id), ["opus", "haiku"]);
    assert.deepEqual(backupOptions(codex, own).map((o) => o.id), ["gpt"], "another engine offers everything");
  });

  test("an agent on the engine's default runs that default, so it is not offered", () => {
    const own = { instanceId: "claude", model: "" };
    assert.deepEqual(backupOptions(claude, own).map((o) => o.id), ["sonnet", "haiku"]);
    assert.equal(isOwnRun(claude, "", { instanceId: "claude", model: "opus" }), true);
  });

  test("an engine with nothing else to offer leaves the rail, unless any id can be typed", () => {
    const own = { instanceId: "codex", model: "gpt" };
    assert.equal(offersBackup(codex, own), false);
    assert.equal(offersBackup(claude, own), true);
    assert.equal(offersBackup({ ...codex, models: { ...codex.models, acceptsAnyId: true } }, own), true);
    assert.equal(offersBackup(codex, undefined), true, "with nothing excluded, everything is offered");
  });
});

describe("the note beside a same-engine backup", () => {
  const own = { instanceId: "claude", model: "opus" };
  test("shows for another model on the same engine", () => {
    assert.equal(sameEngineBackup(own, { instanceId: "claude", model: "sonnet" }), true);
  });
  test("not for another engine, or no backup", () => {
    assert.equal(sameEngineBackup(own, { instanceId: "codex", model: "gpt" }), false);
    assert.equal(sameEngineBackup(own, null), false);
    assert.equal(sameEngineBackup(own, undefined), false);
  });
});
