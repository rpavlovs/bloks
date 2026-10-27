import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

const preload = new URL("./helpers/telegram-fetch.mjs", import.meta.url).href;
const entry = new URL("../server/index.ts", import.meta.url);
const CHAT = 10101;

async function fixture(t: TestContext, options: { crashOn?: string; crashStage?: "joined" | "fail-dispatch" } = {}) {
  const updates: any[] = [], sends: any[] = [], edits: any[] = [];
  const polled = new Set<number>();
  const heldTranscriptions: Array<() => void> = [];
  const heldReceipts: Array<() => void> = [];
  let holdReceipt = false;
  let holdReceipts = false;
  let failReceipt = false;
  let next = 1;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/file/")) {
      res.writeHead(200, { "content-type": "audio/ogg" });
      return void res.end("OggS-fixture");
    }
    if (req.url === "/v1/audio/transcriptions") {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        heldTranscriptions.push(() => res.end(JSON.stringify({ text: "SLOW_VOICE" })));
      });
      return;
    }
    let raw = ""; req.on("data", (part) => raw += part);
    req.on("end", () => {
      const body = JSON.parse(raw || "{}"); res.setHeader("content-type", "application/json");
      const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (req.url?.endsWith("getMe")) return reply({ id: 12345, is_bot: true, username: "PlanningBot" });
      if (req.url?.endsWith("getFile")) return reply({ file_path: "voice/fixture.ogg", file_size: 12 });
      if (req.url?.endsWith("getUpdates")) return void setTimeout(() => {
        const ready = updates.filter((u) => u.update_id >= body.offset);
        for (const update of ready) polled.add(update.update_id);
        reply(ready);
      }, 30);
      if (req.url?.endsWith("sendMessage")) {
        sends.push(body);
        const id = sends.length;
        if (failReceipt && body.disable_notification && body.reply_parameters) {
          failReceipt = false;
          req.socket.destroy();
          return;
        }
        if ((holdReceipt || holdReceipts) && body.disable_notification && body.reply_parameters) {
          holdReceipt = false;
          heldReceipts.push(() => reply({ message_id: id }));
          return;
        }
        return reply({ message_id: id });
      }
      if (req.url?.endsWith("editMessageText")) edits.push(body);
      return reply(true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const env = { NODE_OPTIONS: `--import=${preload}`, BLOKS_TEST_TELEGRAM_URL: url, BLOKS_TEST_SPEECH_URL: url,
    ...(options.crashOn ? { BLOKS_TEST_CRASH_PREP: options.crashOn } : {}),
    ...(options.crashStage ? { BLOKS_TEST_CRASH_STAGE: options.crashStage } : {}) };
  const s = await codexCommands(t, env);
  const push = (text: string) => {
    const id = next++;
    updates.push({ update_id: id, message: { message_id: next, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "Sam" }, text } });
    return id;
  };
  const voice = () => {
    const id = next++;
    updates.push({ update_id: id, message: { message_id: next, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "Sam" }, voice: { file_id: "voice-slow", file_size: 12 } } });
    return id;
  };
  const duplicate = (updateId: number) => {
    const original = updates.find((update) => update.update_id === updateId);
    assert.ok(original);
    const id = next++;
    updates.push({ ...original, update_id: id });
    return id;
  };
  const paired = await s.post("/api/telegram", { token: "12345:TEST_ONLY", enabled: true, botId: s.bot.id, pair: true });
  assert.ok(paired.pairing); push(paired.pairing);
  await waitFor(() => sends.some((m) => m.text.startsWith("Paired.")));
  const answers = () => sends.filter((m) => !m.text.startsWith("Paired.") && !m.text.startsWith("Your message is saved."));
  return { ...s, get h() { return s.h; }, push, voice, duplicate, polled, sends, edits, answers, heldTranscriptions, heldReceipts,
    holdNextReceipt() { holdReceipt = true; },
    holdAllReceipts() { holdReceipts = true; },
    failNextReceipt() { failReceipt = true; },
    async queue(text: string) {
    const before = sends.length; push(text);
    await waitFor(() => sends.slice(before).some((m) => m.text.startsWith("Your message is saved.")));
  }, async stoppedBeforeRecovery() {
    await s.h.crash();
    const child = spawn(process.execPath, [fileURLToPath(entry)], { env: { ...process.env, ...env, HOME: s.root, USERPROFILE: s.root, BLOKS_PORT: "0", BLOKS_TEST_STOP_BEFORE_RECOVERY: "1", BLOKS_TEST_PARENT_PID: String(process.pid), OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "", XAI_API_KEY: "", GEMINI_API_KEY: "", COMPOSIO_KEY: "", BOX_TOKEN: "", BLOKS_LOOPBACK_ONLY: "", BLOKS_PRICES_URL: "http://127.0.0.1:9/api/v1/models", PATH: "/nonexistent", npm_config_prefix: "", PREFIX: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout?.on("data", (chunk) => output += chunk); child.stderr?.resume();
    t.after(() => child.kill("SIGKILL"));
    await waitFor(() => output.includes("bloks server on http://"));
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await gone;
  } };
}

test("the owner's Telegram skill words reach turn/start as a named item", async (t) => {
  const s = await fixture(t); s.push("PHONE $selected");
  await waitFor(() => s.answers().length === 1); await s.settled();
  const input = s.calls().find((c) => c.method === "turn/start").params.input;
  assert.deepEqual(input.filter((i: any) => i.type === "skill").map((i: any) => i.name), ["selected"]);
  assert.equal(s.answers()[0].chat_id, CHAT);
});

test("a Telegram follow-up ready while Codex is preparing reaches the first turn once", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  const followup = s.push("READY_FOLLOWUP");
  await waitFor(() => s.polled.has(followup), "the fake Telegram update was not polled");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_FOLLOWUP"), "the ready follow-up was not retained during preparation");
  s.skillsGate();
  await s.called("turn/start", 1);
  await waitFor(() => s.calls().some((c) =>
    (c.method === "turn/start" && JSON.stringify(c.params.input).includes("READY_FOLLOWUP")) ||
    (c.method === "turn/steer" && JSON.stringify(c.params.input).includes("READY_FOLLOWUP")),
  ), "the follow-up did not reach the starting turn");
  const effects = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("READY_FOLLOWUP"));
  assert.equal(effects.length, 1, "the follow-up was delivered more than once");
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1, "the follow-up also started a later turn");
});

test("the initial snapshot and the first steer preserve ready order", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true, holdSkills: true, holdSteerSkills: true });
  s.push("FIRST $selected");
  await s.called("thread/start", 1);
  const first = s.push("READY_A $other-skill");
  await waitFor(() => s.polled.has(first));
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_A $other-skill"));
  s.threadGate();
  await s.called("skills/list", 1);
  const second = s.push("READY_B $selected");
  await waitFor(() => s.polled.has(second));
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_B $selected"));
  await waitFor(() => s.sends.some((m) => m.reply_parameters?.message_id === second + 1));
  const receiptId = s.sends.findIndex((m) => m.reply_parameters?.message_id === second + 1) + 1;
  s.skillsGate();
  await s.called("turn/start", 1);
  await s.called("skills/list", 2);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_B $selected" && m.delivery?.line === "Waiting to join this turn"));
  await waitFor(() => s.edits.some((m) => m.message_id === receiptId && m.text === "Waiting to join this turn."));
  s.steerSkillsGate();
  await s.called("turn/steer", 1);
  const effects = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method));
  assert.match(JSON.stringify(effects[0].params.input), /READY_A/);
  assert.doesNotMatch(JSON.stringify(effects[0].params.input), /READY_B/);
  assert.ok(effects[0].params.input.some((item: any) => item.type === "skill" && item.name === "other-skill"));
  assert.match(JSON.stringify(effects[1].params.input), /READY_B/);
  assert.equal(effects.filter((c) => JSON.stringify(c.params.input).includes("READY_A")).length, 1);
  assert.equal(effects.filter((c) => JSON.stringify(c.params.input).includes("READY_B")).length, 1);
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("an app edit during skill lookup is sent as saved and a taken-back addition is not sent", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true, holdSkills: true });
  await s.say("FIRST $selected");
  await s.called("thread/start", 1);
  await s.say("OLD_WORDS $selected");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "OLD_WORDS $selected"));
  const before = (await s.messages()).find((m) => m.text === "OLD_WORDS $selected")!;
  s.threadGate();
  await s.called("skills/list", 1);
  const edited = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${before.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "NEW_WORDS $other-skill" }),
  });
  assert.equal(edited.status, 200);
  await s.say("TAKE_BACK");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "TAKE_BACK"));
  const taken = (await s.messages()).find((m) => m.text === "TAKE_BACK")!;
  const removed = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${taken.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  s.skillsGate();
  await s.called("turn/start", 1);
  const start = s.calls().find((c) => c.method === "turn/start");
  assert.match(JSON.stringify(start.params.input), /NEW_WORDS/);
  assert.doesNotMatch(JSON.stringify(start.params.input), /OLD_WORDS|TAKE_BACK/);
  assert.ok(start.params.input.some((item: any) => item.type === "skill" && item.name === "other-skill"));
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("a deliberate later app message stays behind preparation additions", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("READY_A");
  await s.say("AFTER_TURN", { delivery: "wait" });
  await s.say("READY_B");
  s.skillsGate();
  await s.called("turn/steer", 2);
  const steering = s.calls().filter((c) => c.method === "turn/steer");
  assert.match(JSON.stringify(steering[0].params.input), /READY_A/);
  assert.match(JSON.stringify(steering[1].params.input), /READY_B/);
  assert.ok(steering.every((c) => !JSON.stringify(c.params.input).includes("AFTER_TURN")));
  s.gate();
  await s.called("turn/start", 2);
  await s.settled();
  const later = s.calls().filter((c) => c.method === "turn/start")[1];
  assert.match(JSON.stringify(later.params.input), /AFTER_TURN/);
});

test("a preparation burst beyond the input limit is kept as not sent", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true });
  await s.say("FIRST");
  await s.called("thread/start", 1);
  for (let i = 0; i < 20; i++) await s.say(`BURST_${i}`);
  const overflow = await s.say("BURST_OVERFLOW");
  assert.equal(overflow.ok, false);
  assert.equal(overflow.delivery.route, "not-sent");
  const row = (await s.messages()).find((m) => m.text === "BURST_OVERFLOW");
  assert.equal(row?.unsent, true);
  s.threadGate();
  await s.called("turn/start", 1);
  const input = JSON.stringify(s.calls().find((c) => c.method === "turn/start").params.input);
  for (let i = 0; i < 20; i++) assert.ok(input.includes(`BURST_${i}`));
  assert.doesNotMatch(input, /BURST_OVERFLOW/);
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("a Telegram burst bounds receipt work and marks excess input not sent", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true });
  s.push("FIRST");
  await s.called("thread/start", 1);
  s.holdAllReceipts();
  for (let i = 0; i < 21; i++) s.push(`TELEGRAM_BURST_${i}`);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "TELEGRAM_BURST_20" && m.preparation?.state === "not-sent"));
  await waitFor(() => s.heldReceipts.length === 20);
  assert.equal(s.sends.filter((m) => m.disable_notification && m.reply_parameters).length, 20);
  s.heldReceipts.shift()!();
  await waitFor(() => s.sends.filter((m) => m.disable_notification && m.reply_parameters).length === 21);
  s.heldReceipts.splice(0).forEach((release) => release());
  s.threadGate();
  await s.called("turn/start", 1);
  const input = JSON.stringify(s.calls().find((c) => c.method === "turn/start").params.input);
  assert.doesNotMatch(input, /TELEGRAM_BURST_20/);
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("an edit during steering setup sends the saved version once", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteerSkills: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("OLD_DURING_STEER $selected");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "OLD_DURING_STEER $selected"));
  const waiting = (await s.messages()).find((m) => m.text === "OLD_DURING_STEER $selected")!;
  s.skillsGate();
  await s.called("skills/list", 2);
  const edited = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${waiting.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "NEW_DURING_STEER $other-skill" }),
  });
  assert.equal(edited.status, 200);
  s.steerSkillsGate();
  await s.called("turn/steer", 1);
  const sent = s.calls().filter((c) => c.method === "turn/steer");
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].params.input), /NEW_DURING_STEER/);
  assert.doesNotMatch(JSON.stringify(sent[0].params.input), /OLD_DURING_STEER/);
  assert.ok(sent[0].params.input.some((item: any) => item.type === "skill" && item.name === "other-skill"));
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("a ready text does not wait for an unfinished voice transcription", async (t) => {
  const s = await fixture(t);
  await s.h.json("/api/config", { method: "PATCH", body: JSON.stringify({ speech: { openaiKey: "fixture-only" } }) });
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.voice();
  await waitFor(() => s.heldTranscriptions.length === 1, "voice did not reach the synthetic transcriber");
  s.push("READY_TEXT");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_TEXT"), "ready text waited for voice");
  s.heldTranscriptions[0]();
  await waitFor(async () => (await s.messages()).some((m) => m.text?.includes("SLOW_VOICE")), "completed voice was not retained");
  s.skillsGate();
  await s.called("turn/steer", 2);
  const steers = s.calls().filter((c) => c.method === "turn/steer");
  assert.match(JSON.stringify(steers[0].params.input), /READY_TEXT/);
  assert.match(JSON.stringify(steers[1].params.input), /SLOW_VOICE/);
  s.gate();
  await s.settled();
});

test("a mismatched Codex receipt stays unresolved across restart without replay", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, wrongSteerId: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  const source = s.push("UNCERTAIN_FOLLOWUP");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "UNCERTAIN_FOLLOWUP"));
  s.push("BEHIND_UNCERTAIN");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "BEHIND_UNCERTAIN"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "UNCERTAIN_FOLLOWUP" && m.delivery?.route === "uncertain"));
  await waitFor(async () => (await s.messages()).some((m) => m.text === "BEHIND_UNCERTAIN" && m.preparation?.state === "not-sent"));
  const receipt = s.sends.find((m) => m.reply_parameters?.message_id === source + 1);
  assert.equal(receipt?.disable_notification, true);
  await waitFor(() => s.edits.some((m) => m.text.includes("could not be confirmed")));
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
  assert.equal(s.count("turn/steer"), 1);
  await s.reboot();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(s.count("turn/start"), 1);
  assert.equal(s.count("turn/steer"), 1);
  assert.ok(s.calls().every((c) => !JSON.stringify(c.params).includes("BEHIND_UNCERTAIN")));
  assert.ok((await s.messages()).some((m) => m.text === "UNCERTAIN_FOLLOWUP" && m.delivery?.route === "uncertain"));
});

for (const missing of [true, false]) test(`a ${missing ? "missing" : "mismatched"} Codex start identity does not confirm additions`, async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true, holdSkills: true, startedBeforeReply: true, duplicateStarted: true,
    ...(missing ? { missingStartId: true } : { wrongStartId: true }) });
  s.push("FIRST $selected");
  await s.called("thread/start", 1);
  s.push("INITIAL_UNCONFIRMED");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "INITIAL_UNCONFIRMED"));
  s.threadGate();
  await s.called("skills/list", 1);
  s.push("LATER_UNCONFIRMED");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "LATER_UNCONFIRMED"));
  s.skillsGate();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "INITIAL_UNCONFIRMED" && m.preparation?.state === "uncertain"));
  await waitFor(async () => (await s.messages()).some((m) => m.text === "LATER_UNCONFIRMED" && m.preparation?.state === "not-sent"));
  assert.equal(s.count("turn/steer"), 0);
  s.gate();
  await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("INITIAL_UNCONFIRMED")).length, 1);
  assert.ok(s.calls().every((c) => !JSON.stringify(c.params).includes("LATER_UNCONFIRMED")));
});

for (const mismatched of [false, true]) test(`an addition arriving during a ${mismatched ? "unconfirmed" : "confirmed"} preparation steer stays in order`, async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true, wrongSteerId: mismatched });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("STEER_FIRST");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_FIRST"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  s.push("STEER_SECOND");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_SECOND" && m.preparation?.state === "pending"));
  assert.equal((await s.messages()).find((m) => m.text === "STEER_SECOND")?.delivery?.line, "Waiting for an earlier input's receipt");
  s.steerGate();
  if (mismatched) {
    await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_FIRST" && m.preparation?.state === "uncertain"));
    await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_SECOND" && m.preparation?.state === "not-sent"));
    assert.equal(s.count("turn/steer"), 1);
  } else {
    await s.called("turn/steer", 2);
    await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_SECOND" && m.preparation?.state === "joined"));
    const calls = s.calls().filter((c) => c.method === "turn/steer");
    assert.match(JSON.stringify(calls[0].params.input), /STEER_FIRST/);
    assert.match(JSON.stringify(calls[1].params.input), /STEER_SECOND/);
  }
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("a completed turn's delayed steer continuation cannot alter the next attempt", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true, completeWithSteer: true });
  await s.say("TURN_A $selected");
  await s.called("skills/list", 1);
  await s.say("PREP_A");
  s.skillsGate();
  await s.called("turn/steer", 1);
  await s.say("TURN_B", { delivery: "wait" });
  s.spec({ hold: true, holdThread: true });
  s.steerGate();
  await waitFor(() => s.calls().filter((c) => ["thread/start", "thread/resume"].includes(c.method)).length >= 2, "the next conversation did not open");
  await s.say("PREP_B");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "PREP_B" && m.preparation?.state === "pending"));
  s.threadGate();
  await s.called("turn/start", 2);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "PREP_B" && m.preparation?.state === "joined"));
  const rows = await s.messages();
  const a = rows.find((m) => m.text === "PREP_A");
  const b = rows.find((m) => m.text === "PREP_B");
  assert.equal(a?.preparation?.state, "joined");
  assert.notEqual(a?.preparation?.attempt, b?.preparation?.attempt);
  assert.equal(s.calls().filter((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("PREP_A")).length, 1);
  assert.equal(s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("PREP_B")).length, 1);
  s.gate();
  await s.settled();
});

test("preparation additions wait for an existing agent steer and keep their order", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, captureCredential: true });
  await s.say("SENDER_HOLD");
  await s.called("turn/start", 1);
  const credentials = join(s.root, "credentials.jsonl");
  await waitFor(() => existsSync(credentials));
  const token = JSON.parse(readFileSync(credentials, "utf8").trim().split("\n")[0]).token;
  const hired = await s.h.json("/api/bots", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Fixture target" }) });
  const target = hired.bot;
  assert.ok(target?.id);
  await s.h.json(`/api/bots/${target.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
  s.spec({ hold: true, holdStartReply: true, holdSteer: true });
  await s.post(`/api/bots/${target.id}/messages`, { text: "TARGET_FIRST" });
  await waitFor(() => s.calls().some((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("TARGET_FIRST")));
  const agent = s.h.fetch(`/api/bots/${target.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: "AGENT_FIRST", now: true }) });
  await waitFor(() => s.calls().some((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("AGENT_FIRST")));
  await s.post(`/api/bots/${target.id}/messages`, { text: "PERSON_A" });
  await s.post(`/api/bots/${target.id}/messages`, { text: "PERSON_B" });
  await waitFor(async () => (await s.h.json(`/api/bots/${target.id}/messages?thread=${target.threadId}&limit=500`)).messages.filter((m: any) => ["PERSON_A", "PERSON_B"].includes(m.text) && m.preparation?.state === "pending").length === 2);
  s.startReplyGate();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(s.calls().filter((c) => c.method === "turn/steer").length, 1);
  s.steerGate();
  assert.equal((await agent).status, 202);
  await waitFor(() => s.calls().filter((c) => c.method === "turn/steer").length === 3);
  const calls = s.calls().filter((c) => c.method === "turn/steer");
  assert.match(JSON.stringify(calls[0].params.input), /AGENT_FIRST/);
  assert.match(JSON.stringify(calls[1].params.input), /PERSON_A/);
  assert.match(JSON.stringify(calls[2].params.input), /PERSON_B/);
  s.gate();
  await s.settled();
});

test("a refusal arriving with turn completion starts the fallback once", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true, completeWithSteer: true, refuseSteer: true });
  await s.say("TURN_A $selected");
  await s.called("skills/list", 1);
  await s.say("LATE_REFUSAL");
  s.skillsGate();
  await s.called("turn/steer", 1);
  s.spec({ hold: false });
  s.steerGate();
  await s.called("turn/start", 2);
  await s.settled();
  const starts = s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("LATE_REFUSAL"));
  assert.equal(starts.length, 1);
  assert.equal(s.calls().filter((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("LATE_REFUSAL")).length, 1);
});

test("a late pending receipt cannot overwrite the joined status", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.holdNextReceipt();
  s.push("JOINED_FOLLOWUP");
  await waitFor(() => s.heldReceipts.length === 1);
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "JOINED_FOLLOWUP" && m.delivery?.route === "steered"));
  s.heldReceipts[0]();
  await waitFor(() => s.edits.some((m) => m.text === "Joined this turn."));
  assert.equal(s.edits.at(-1).text, "Joined this turn.");
  assert.equal(s.count("turn/steer"), 1);
  s.gate();
  await s.settled();
});

test("a duplicate Telegram source has one row, receipt and engine input", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  const source = s.push("DUPLICATE_SOURCE");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "DUPLICATE_SOURCE"));
  const repeated = s.duplicate(source);
  await waitFor(() => s.polled.has(repeated));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "DUPLICATE_SOURCE" && m.preparation?.state === "joined"));
  assert.equal((await s.messages()).filter((m) => m.text === "DUPLICATE_SOURCE").length, 1);
  assert.equal(s.sends.filter((m) => m.reply_parameters?.message_id === source + 1).length, 1);
  assert.equal(s.calls().filter((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("DUPLICATE_SOURCE")).length, 1);
  s.gate();
  await s.settled();
});

test("an unconfirmed quiet receipt never repeats engine delivery", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.failNextReceipt();
  const source = s.push("RECEIPT_FAILURE");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "RECEIPT_FAILURE" && m.preparation?.receiptState === "unconfirmed"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "RECEIPT_FAILURE" && m.preparation?.state === "joined"));
  assert.equal(s.sends.filter((m) => m.reply_parameters?.message_id === source + 1).length, 1);
  assert.equal(s.calls().filter((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("RECEIPT_FAILURE")).length, 1);
  s.gate();
  await s.settled();
});

test("a definite steering refusal runs and answers the next turn once", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, refuseSteer: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("NEXT_FOLLOWUP");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "NEXT_FOLLOWUP"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "NEXT_FOLLOWUP" && m.preparation?.state === "next"));
  s.gate();
  await s.called("turn/start", 2);
  await waitFor(() => s.sends.filter((m) => m.text === "ANSWER").length === 2, "both turns should return their own answer");
  await s.settled();
  const starts = s.calls().filter((c) => c.method === "turn/start");
  assert.doesNotMatch(JSON.stringify(starts[0].params.input), /NEXT_FOLLOWUP/);
  assert.match(JSON.stringify(starts[1].params.input), /NEXT_FOLLOWUP/);
  assert.equal(s.count("turn/start"), 2);
  assert.equal(s.count("turn/steer"), 1);
});

test("a Codex internal error after dispatch stays uncertain", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, steerInternalError: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("INTERNAL_ERROR_FOLLOWUP");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "INTERNAL_ERROR_FOLLOWUP"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "INTERNAL_ERROR_FOLLOWUP" && m.preparation?.state === "uncertain"));
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
  assert.equal(s.count("turn/steer"), 1);
});

test("restart after a steer write retains uncertainty without replay", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("CRASH_FOLLOWUP");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "CRASH_FOLLOWUP"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "CRASH_FOLLOWUP" && m.preparation?.state === "dispatching"));
  const message = (await s.messages()).find((m) => m.text === "CRASH_FOLLOWUP")!;
  const path = `/api/threads/${s.bot.threadId}/messages/${message.id}`;
  assert.equal((await s.h.fetch(path, { method: "PATCH", body: JSON.stringify({ text: "CHANGED_AFTER_WRITE" }) })).status, 409);
  assert.equal((await s.h.fetch(path, { method: "DELETE" })).status, 409);
  assert.equal((await s.h.json(`${path}/editing`, { method: "POST", body: JSON.stringify({ editing: true }) })).holding, false);
  await s.h.crash();
  s.gate();
  s.spec({ hold: false });
  await s.reboot();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "CRASH_FOLLOWUP" && m.preparation?.state === "uncertain"));
  assert.equal((await s.h.fetch(path, { method: "DELETE" })).status, 409);
  const other = await s.hire("Other lane");
  await s.post(`/api/bots/${other.id}/messages`, { text: "OTHER_LANE" });
  await waitFor(() => s.calls().some((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("OTHER_LANE")));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const copies = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("CRASH_FOLLOWUP"));
  assert.equal(copies.length, 1);
});

test("restart after the durable marker but before native dispatch never replays it", async (t) => {
  const s = await fixture(t, { crashOn: "BEFORE_WRITE" });
  s.spec({ hold: true, holdThread: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("thread/start", 1);
  s.push("BEFORE_WRITE");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "BEFORE_WRITE"));
  s.threadGate();
  await s.called("skills/list", 1);
  s.skillsGate();
  await waitFor(() => existsSync(join(s.root, "prep-crash")), "the synthetic crash point did not fire");
  await s.reboot();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "BEFORE_WRITE" && m.preparation?.state === "uncertain"));
  const copies = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("BEFORE_WRITE"));
  assert.equal(copies.length, 0);
});

test("restart after acceptance but before saving it does not replay the input", async (t) => {
  const s = await fixture(t, { crashOn: "AFTER_ACCEPT", crashStage: "joined" });
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("AFTER_ACCEPT");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "AFTER_ACCEPT"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(() => existsSync(join(s.root, "prep-crash")), "the post-acceptance crash point did not fire");
  s.gate();
  await s.reboot();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "AFTER_ACCEPT" && m.preparation?.state === "uncertain"));
  const copies = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("AFTER_ACCEPT"));
  assert.equal(copies.length, 1);
});

test("a failed durable marker prevents the native steer", async (t) => {
  const s = await fixture(t, { crashOn: "FAIL_BEFORE_STEER", crashStage: "fail-dispatch" });
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("FAIL_BEFORE_STEER");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "FAIL_BEFORE_STEER"));
  s.skillsGate();
  await waitFor(() => existsSync(join(s.root, "prep-write-failed")), "the synthetic write failure did not fire");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "FAIL_BEFORE_STEER" && m.preparation?.state === "next"));
  assert.equal(s.calls().filter((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("FAIL_BEFORE_STEER")).length, 0);
  s.gate();
  await s.called("turn/start", 2);
  await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("FAIL_BEFORE_STEER")).length, 1);
});

test("a held startup does not block another lane and stopped input falls back", async (t) => {
  const s = await fixture(t);
  s.spec({ holdThread: true });
  await s.say("HELD_START");
  await s.called("thread/start", 1);
  await s.say("HELD_ADDITION");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "HELD_ADDITION" && m.preparation?.state === "pending"));
  s.spec({ hold: false });
  const other = await s.hire("Independent fixture");
  await s.post(`/api/bots/${other.id}/messages`, { text: "INDEPENDENT" });
  await waitFor(() => s.calls().some((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("INDEPENDENT")));
  assert.ok((await s.post(`/api/bots/${s.bot.id}/interrupt`, { taskId: s.bot.threadId })).ok);
  s.threadGate();
  await waitFor(() => s.calls().some((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("HELD_ADDITION")));
  await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("HELD_ADDITION")).length, 1);
});

test("drain holds words and compact through restart with one return each", async (t) => {
  const s = await fixture(t); await s.turn("warm session");
  await s.post("/api/maintenance/drain", { seconds: 60 });
  await s.queue("DRAIN $selected"); await s.queue("/compact");
  await s.reboot(); await waitFor(() => s.answers().length === 2); await s.settled();
  const turns = s.calls().filter((c) => c.method === "turn/start");
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].params.input.filter((i: any) => i.type === "skill").map((i: any) => i.name), ["selected"]);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.ok(s.answers().every((m) => m.chat_id === CHAT));
  await s.reboot(); await s.settled();
  assert.equal(s.answers().length, 2);
});

test("a second startup before dispatch retains the native command return", { skip: process.platform === "win32" }, async (t) => {
  const s = await fixture(t); await s.turn("warm session");
  await s.post("/api/maintenance/drain", { seconds: 60 }); await s.queue("/compact");
  await s.stoppedBeforeRecovery(); assert.equal(s.answers().length, 0);
  await s.reboot(); await waitFor(() => s.answers().length === 1); await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.equal(s.calls().filter((c) => c.method === "turn/start").length, 1);
});

test("a cut-off pickup takes only its ordinary Telegram segment before compact's own return", async (t) => {
  const s = await fixture(t); await s.turn("warm session");
  await s.say("HOLD"); await waitFor(() => s.calls().filter((c) => c.method === "turn/start").length === 2);
  await s.post("/api/maintenance/drain", { seconds: 60 });
  await s.queue("PICKUP $selected"); await s.queue("/compact");
  await s.reboot(); await waitFor(() => s.answers().length === 2); await s.settled();
  const turns = s.calls().filter((c) => c.method === "turn/start");
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[2].params.input.filter((i: any) => i.type === "skill").map((i: any) => i.name), ["selected"]);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.equal((await s.messages()).filter((m) => m.telegramReply?.state === "sent").length, 2);
});
