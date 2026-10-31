// Composition proof for the two unchanged-base candidates. Disposable data,
// scripted CLI and loopback relay only. This file is review evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { quietFixture, phoneRelay, settledIn } from "./helpers/quiet-finish.ts";

test("trusted service ingress can finish quietly, while ordinary message ingress cannot override person origin", async (t) => {
  const f = await quietFixture(t), phone = await phoneRelay(t, f.h);
  const bot = await f.hire("Worker"), frames = await f.stream();
  const wakeId = "b0000000-0000-4000-8000-000000000008";
  const admitted = await f.h.fetchRemote(`/api/bots/${bot.id}/wakes`, { host: "localhost", method: "POST", body: JSON.stringify({ taskId: bot.threadId, wakeId, text: "Inspect the example inventory" }) });
  assert.equal(admitted.status, 202, JSON.stringify(admitted));
  const worker = await f.turn(0);
  assert.equal((await f.quiet(worker, bot)).status, 200);
  f.text(worker, "Done."); f.end(worker, "Done.");
  assert.ok(await f.idle(bot));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(Boolean((await f.lane(bot)).unread), false);
  assert.deepEqual(settledIn(frames, bot.threadId), []);
  assert.deepEqual(phone.replies(), []);
  const state = await f.h.fetchRemote(`/api/bots/${bot.id}/wakes/${wakeId}?taskId=${bot.threadId}`, { host: "localhost" });
  assert.equal(state.body.status, "dispatched");
  const generic = await f.h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Inspect the example calendar", byYou: false, origin: "service", via: "service" }) });
  assert.ok(generic.ok);
  const person = await f.turn(1), refused = await f.quiet(person, bot);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, "person_in_turn");
  f.text(person, "The example calendar is clear."); f.end(person, "The example calendar is clear.");
  assert.ok(await f.idle(bot));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(settledIn(frames, bot.threadId).length, 1);
  assert.equal(phone.replies().length, 1);
});
