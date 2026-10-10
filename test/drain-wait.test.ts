// The stored reason, not a guess by the app, explains an update queue.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const post = (text: string, extra: Record<string, unknown> = {}): RequestInit => ({
  method: "POST", body: JSON.stringify({ text, ...extra }),
});

test("a person's drain reason survives edits and restart, then clears on delivery", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-drain-wait-"));
  const fake = await fakeProvider(t);
  let h: Harness | undefined;
  t.after(async () => {
    await h?.stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  h = await startHarness({ HOME: home });
  const bot = await agentOn(h, fake.port, "Ivy");
  await h.json("/api/maintenance/drain", { method: "POST" });
  const response = await h.json(`/api/bots/${bot.id}/messages`, post("BEFORE-EDIT", { waitsFor: "invented" }));
  assert.equal(response.queued, true);
  assert.match(response.note, /finishing what is running/);
  const queued = (await messagesOf(h, bot)).find((m) => m.text === "BEFORE-EDIT");
  assert.equal(queued.waitsFor, "restart", "the server did not store the drain reason");
  assert.equal(fake.sent("BEFORE-EDIT"), 0);
  const edited = await h.fetch(`/api/threads/${bot.threadId}/messages/${queued.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "AFTER-EDIT", waitsFor: "invented" }),
  });
  assert.equal(edited.status, 200);
  const saved = JSON.parse(readFileSync(join(home, ".bloks", `messages-${bot.threadId}.json`), "utf8"));
  assert.equal(saved.find((m: any) => m.id === queued.id).waitsFor, "restart", "editing changed the server's reason");
  assert.equal(saved.find((m: any) => m.id === queued.id).queuedAt, queued.queuedAt);
  await h.stop();
  h = undefined;

  fake.state.answerAtOnce = true;
  h = await startHarness({ HOME: home });
  assert.ok(await waitFor(() => fake.sent("AFTER-EDIT") === 1), "the reloaded queue was not delivered");
  assert.ok(await idle(h, bot));
  const delivered = (await messagesOf(h, bot)).find((m) => m.id === queued.id);
  assert.equal(delivered.text, "AFTER-EDIT");
  assert.equal(delivered.queued, false);
  assert.equal(delivered.waitsFor, undefined, "the restart reason stayed on a delivered message");
  assert.equal(delivered.queuedAt, queued.queuedAt);
  assert.equal(delivered.at, delivered.deliveredAt);
  assert.equal(fake.sent("BEFORE-EDIT"), 0, "the original text was delivered instead of the edit");
  assert.equal(fake.sent("AFTER-EDIT"), 1);
});

test("a message queued during a drain keeps its reason when the busy turn ends, and clears it on cancellation", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Ivy");
  await h.json(`/api/bots/${bot.id}/messages`, post("RUNNING"));
  assert.ok(await waitFor(() => fake.state.held.length === 1));
  await h.json("/api/maintenance/drain", { method: "POST" });
  await h.json(`/api/bots/${bot.id}/messages`, post("WAITS-FOR-RESTART"));
  const queued = (await messagesOf(h, bot)).find((m) => m.text === "WAITS-FOR-RESTART");
  assert.equal(queued.waitsFor, "restart", "a busy drain queue lost its reason");
  fake.state.held.shift()!();
  assert.ok(await idle(h, bot));
  const waiting = (await messagesOf(h, bot)).find((m) => m.id === queued.id);
  assert.equal(waiting.queued, true);
  assert.equal(waiting.waitsFor, "restart");
  assert.equal(fake.sent("WAITS-FOR-RESTART"), 0);
  fake.state.answerAtOnce = true;
  await h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(() => fake.sent("WAITS-FOR-RESTART") === 1));
  assert.ok(await idle(h, bot));
  const delivered = (await messagesOf(h, bot)).find((m) => m.id === queued.id);
  assert.equal(delivered.queued, false);
  assert.equal(delivered.waitsFor, undefined, "calling the drain off left a stale reason");
});

test("ordinary queues ignore client reasons on create and edit, and a webhook queue stays unmarked", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, fake.port, "Ivy");
  await h.json(`/api/bots/${bot.id}/messages`, post("RUNNING"));
  assert.ok(await waitFor(() => fake.state.held.length === 1));
  await h.json(`/api/bots/${bot.id}/messages`, post("ORDINARY-QUEUE", { waitsFor: "restart" }));
  const ordinary = (await messagesOf(h, bot)).find((m) => m.text === "ORDINARY-QUEUE");
  assert.equal(ordinary.queued, true);
  assert.equal(ordinary.waitsFor, undefined, "the client invented a restart reason");
  assert.equal((await h.fetch(`/api/threads/${bot.threadId}/messages/${ordinary.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "ORDINARY-EDIT", waitsFor: "restart" }),
  })).status, 200);
  assert.equal((await messagesOf(h, bot)).find((m) => m.id === ordinary.id).waitsFor, undefined);

  const { webhook } = await h.json("/api/webhooks", {
    method: "POST", body: JSON.stringify({ name: "Build events", botId: bot.id, thread: "General" }),
  });
  await h.json("/api/maintenance/drain", { method: "POST" });
  assert.equal((await h.fetch(`/hook/${webhook.token}`, post("BACKGROUND-EVENT", { waitsFor: "restart" }))).status, 202);
  const background = (await messagesOf(h, bot)).find((m) => m.via === "webhook");
  assert.ok(background?.queued);
  assert.equal(background.waitsFor, undefined, "a background event gained the person's restart reason");
  fake.state.answerAtOnce = true;
  fake.state.held.shift()!();
  await h.json("/api/maintenance/drain", { method: "DELETE" });
  assert.ok(await waitFor(async () => (await messagesOf(h, bot)).filter((m) => m.queued).length === 0));
  assert.ok(await idle(h, bot));
});
