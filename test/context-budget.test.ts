// The person's compaction budget is what fills, while the model window
// stays visible. HTTP checks use the real server and a synthetic Codex.
import assert from "node:assert/strict";
import { test } from "node:test";
import { beforeTurnLine, laneFill, type Reading } from "../server/context.ts";
import { activityContext, contextCard, contextTitle, ringLabel } from "../src/lib/contextCard.ts";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

const selection = { instanceId: "codex", model: "gpt-6.1-sol" };
const reading: Reading = { used: 174_000, window: 1_000_000, ...selection, at: 1 };

test("174k measures against the actual 400k before-turn line, with the window preserved", () => {
  const settings = { ceiling: 400_000, at: 0.6 };
  const fill = laneFill(reading, selection, settings);
  assert.equal(fill.limit, beforeTurnLine({ window: reading.window, ...settings }));
  assert.equal(fill.used, 174_000);
  assert.equal(fill.modelLimit, 1_000_000);
  assert.equal(fill.fraction, 0.435);
  assert.equal(fill.window, "engine");
  const lane = { ...fill, summarised: false };
  assert.deepEqual(contextCard(lane), {
    share: "44% full", tokens: "174k of 400k tokens", summarised: null,
    compaction: "Compacts before the next turn at 400k; the model's window is 1M",
  });
  assert.equal(ringLabel(lane), "Before-turn compaction 44% full");
  assert.equal(contextTitle(lane), "44% of the before-turn compaction line");
  assert.equal(activityContext(fill), null, "Activity keeps its half-full threshold");
});

test("off keeps the window, and a larger ceiling still follows the saved share", () => {
  const off = laneFill(reading, selection, { ceiling: 0 });
  assert.equal(off.limit, 1_000_000);
  assert.equal(off.fraction, 0.174);
  assert.equal(off.modelLimit, undefined);
  assert.equal(contextCard({ ...off, summarised: false }).compaction, null);
  const above = laneFill(reading, selection, { ceiling: 2_000_000, at: 0.8 });
  assert.equal(above.limit, 800_000, "the share, not a ceiling above the window, is the actual line");
  assert.equal(above.fraction, 174_000 / 800_000);
  assert.equal(above.modelLimit, 1_000_000);
  assert.equal(laneFill(reading, selection, { ceiling: 800_000, at: 0.8 }).limit, 800_000);
  assert.equal(laneFill(reading, selection, { ceiling: 400_000, at: 0.2 }).limit, 200_000);
  assert.equal(laneFill(reading, selection, { ceiling: 2_000_000, at: 1 }).limit, 600_000);
});

test("past the line the card, chips and Activity keep the real share", () => {
  const fill = laneFill({ ...reading, used: 450_000 }, selection, { ceiling: 400_000 });
  assert.equal(fill.fraction, 1.125, "the display share was capped at one");
  const lane = { ...fill, summarised: true };
  assert.equal(contextCard(lane).share, "113% full");
  assert.equal(contextCard(lane).tokens, "450k of 400k tokens");
  assert.equal(contextCard(lane).compaction, "Compacts before the next turn at 400k; the model's window is 1M");
  assert.equal(contextTitle(lane), "113% of the before-turn compaction line, and the earlier part has been summarised");
  assert.equal(activityContext(fill), "113% of the before-turn compaction line");
  assert.equal(laneFill({ ...reading, used: 1_100_000 }, selection, { ceiling: 0 }).fraction, 1, "off keeps existing window display");
});

test("a table window stays approximate and unknown or stale readings stay unmeasured", () => {
  const guessed = laneFill({ ...reading, window: null }, selection, { ceiling: 400_000 });
  assert.equal(guessed.limit, 163_200);
  assert.equal(guessed.modelLimit, 272_000);
  assert.equal(guessed.window, "table");
  assert.match(contextCard({ ...guessed, summarised: false }).compaction!, /at about 163k; the model's window is about 272k$/);
  for (const own of [undefined, { ...reading, used: NaN }, { ...reading, instanceId: "other" }, { ...reading, model: "other" }]) {
    const fill = laneFill(own, selection, { ceiling: 400_000 });
    assert.equal(fill.measured, false);
    assert.equal(fill.modelLimit, undefined);
    assert.equal(fill.limit, 0);
  }
  const unknown = { ...selection, model: "something-new" };
  assert.equal(laneFill({ ...reading, ...unknown, window: null }, unknown, { ceiling: 400_000 }).measured, false);
  const tiny = laneFill({ ...reading, used: 1, window: 1 }, selection, { ceiling: 400_000 });
  assert.equal(tiny.limit, 1, "a zero-token rounded line must not divide by zero");
  assert.ok(Number.isFinite(tiny.fraction));
});

test("saved settings refresh an existing busy reading and its event, without another model request", async t => {
  const f = await codexCommands(t);
  const save = async (beforeTurn: number, beforeTurnAt = 0.6) => {
    const response = await f.h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { beforeTurn, beforeTurnAt } }) });
    assert.equal(response.status, 200);
  };
  const lane = async () => (await f.current()).tasks.find((task: any) => task.id === f.bot.threadId);
  const running = async () => (await f.h.json("/api/activity")).running.find((row: any) => row.threadId === f.bot.threadId);
  await save(400_000);
  f.spec({ used: 174_000, window: 1_000_000, hold: true });
  await f.say("HOLD a long synthetic turn");
  await waitFor(async () => (await lane())?.context?.used === 174_000 && (await lane()).state === "working");
  assert.equal((await lane()).context.limit, 400_000, "bot serialization ignored the setting");
  assert.equal((await running()).context.limit, 400_000, "Activity serialization ignored the setting");
  assert.equal((await running()).context.modelLimit, 1_000_000);
  assert.equal((await running()).context.fraction, (await lane()).context.fraction);
  const saved = f.stored().tasks.find((task: any) => task.id === f.bot.threadId).reading;
  const calls = f.calls().filter(call => call.method === "turn/start" || call.method === "thread/compact/start").length;

  const controller = new AbortController();
  const stream = await f.h.fetch("/api/events", { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const frames: any[] = [];
  const pump = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").find(line => line.startsWith("data: "));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  try {
    await save(200_000);
    assert.equal((await lane()).context.limit, 200_000);
    assert.equal((await running()).context.limit, 200_000);
    await assert.doesNotReject(() => waitFor(() => frames.some(frame => frame.kind === "bot" && frame.bot?.id === f.bot.id && frame.bot.tasks.some((task: any) => task.id === f.bot.threadId && task.context.limit === 200_000))), "settings changed but no bot event refreshed the saved reading");
    await save(0);
    assert.equal((await lane()).context.limit, 1_000_000);
    assert.equal((await lane()).context.modelLimit, undefined);
    assert.equal((await running()).context.modelLimit, undefined);
    await save(2_000_000, 0.8);
    assert.equal((await lane()).context.limit, 800_000);
    assert.equal((await running()).context.limit, 800_000);
    await assert.doesNotReject(() => waitFor(() => frames.some(frame => frame.kind === "bot" && frame.bot?.id === f.bot.id && frame.bot.tasks.some((task: any) => task.id === f.bot.threadId && task.context.limit === 800_000))));
    const beforeShareEdit = frames.length;
    await save(2_000_000, 0.2);
    assert.equal((await lane()).context.limit, 200_000);
    await assert.doesNotReject(() => waitFor(() => frames.slice(beforeShareEdit).some(frame => frame.kind === "bot" && frame.bot?.id === f.bot.id && frame.bot.tasks.some((task: any) => task.id === f.bot.threadId && task.context.limit === 200_000))), "a share-only setting edit did not refresh the saved reading");
    assert.deepEqual(f.stored().tasks.find((task: any) => task.id === f.bot.threadId).reading, saved, "a display setting overwrote the engine reading");
    assert.equal(f.calls().filter(call => call.method === "turn/start" || call.method === "thread/compact/start").length, calls, "a settings refresh ran an engine operation");
  } finally {
    controller.abort();
    await pump;
  }
});

test("a request past the compaction line inside a running turn remains 113% on every surface", async t => {
  const f = await codexCommands(t);
  await f.h.json("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { beforeTurn: 400_000 } }) });
  f.spec({ used: 450_000, window: 1_000_000, hold: true });
  await f.say("HOLD past the before-turn line");
  await waitFor(async () => (await f.current()).tasks.find((task: any) => task.id === f.bot.threadId)?.context?.used === 450_000);
  const lane = (await f.current()).tasks.find((task: any) => task.id === f.bot.threadId);
  assert.equal(lane.state, "working");
  assert.equal(lane.context.fraction, 1.125);
  assert.equal(lane.context.limit, 400_000);
  const row = (await f.h.json("/api/activity")).running.find((item: any) => item.threadId === f.bot.threadId);
  assert.equal(row.context.fraction, 1.125);
  assert.equal(row.context.modelLimit, 1_000_000);
  assert.equal(f.calls().some(call => call.method === "thread/compact/start"), false, "displaying a full ring compacted during the turn");
});
