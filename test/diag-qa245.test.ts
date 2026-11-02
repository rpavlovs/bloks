// CI-only diagnosis, never part of the change: the last two groups of
// test/summary-message-changes.test.ts, with every step logged to stderr,
// a time limit on each test, and the server's log printed if one stalls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { startHarness, type Harness } from "./helpers/server.ts";
import { idle, waitFor } from "./helpers/turns.ts";

const step = (label: string, s: string): void => void process.stderr.write(`[diag ${new Date().toISOString()} ${label}] ${s}\n`);

type Kind = "turn" | "fold" | "absorb" | "defrag";
interface Row { role: "user" | "bot"; text: string; kind?: "text" | "notice"; deleted?: boolean; unsent?: boolean }
interface Context { summary: string; through: number; at: number; microFrom?: number }
interface Setup { label: string; rows?: Row[]; context?: Context | null; micro?: boolean; hold?: Kind[] }

const SUMMARISED = "[Earlier in this conversation, summarised]";
const has = (text: string, word: string) => new RegExp(`${word}(?![\\w-])`).test(text);
const kindOf = (told: string): Kind =>
  /Summarise this part of a conversation|Produce one summary covering both/.test(told)
    ? "fold"
    : told.includes("This is a running summary of a conversation, written in pieces over time")
      ? "defrag"
      : /Here is a running summary of a conversation, and one more thing|Summarise this so it can be carried forward/.test(told)
        ? "absorb"
        : "turn";

function lane(): Row[] {
  return [
    { role: "user", text: "FACT-1 where it started." },
    { role: "bot", kind: "notice", text: "NOTICE-1 between them." },
    { role: "bot", text: "FACT-2 the agent's first answer." },
    { role: "user", text: "", deleted: true },
    { role: "user", text: "FACT-3 OLD-3 a plan in its first words." },
    { role: "user", text: "UNSENT-1 never sent.", unsent: true },
    { role: "bot", text: "FACT-4 the last answer the summary read." },
    { role: "user", text: "FACT-5 the first message after the summary." },
    { role: "bot", text: "FACT-6 an answer to it." },
    { role: "user", text: "FACT-7 one more." },
    { role: "bot", text: "FACT-8 the end so far." },
  ];
}
const covering: Context = { summary: "Notes: FACT-1 FACT-2 FACT-3 OLD-3 FACT-4 SUMMARY-ONLY", through: 4, at: 1234 };

async function fixture(t: TestContext, setup: Setup) {
  const label = setup.label;
  const rows = setup.rows ?? lane();
  const context = setup.context === undefined ? covering : setup.context;
  const home = mkdtempSync(join(tmpdir(), "bloks-summary-diag-"));
  const data = join(home, ".bloks");
  mkdirSync(data);
  const id = randomUUID(), threadId = randomUUID();
  const bot = {
    id, threadId, activeTaskId: threadId, name: "Changes fixture", title: "", description: "",
    color: "blue", shape: "circle", createdAt: 1, unread: false, notifications: false, resumeCursors: {},
    modelSelection: { instanceId: "grok", model: "grok-4" },
    tasks: [{ id: threadId, title: "General", createdAt: 1, lastInstanceId: "grok", resumeCursors: {}, ...(context ? { context } : {}) }],
  };
  writeFileSync(join(data, "bots.json"), JSON.stringify([bot]));
  const ids = rows.map(() => randomUUID());
  writeFileSync(join(data, `messages-${threadId}.json`), JSON.stringify(rows.map((m, i) => ({ id: ids[i], at: i + 1, kind: "text", ...m }))));
  writeFileSync(join(data, "config.json"), JSON.stringify({ compaction: { micro: Boolean(setup.micro), beforeTurn: 0 } }));

  const requests: Array<{ kind: Kind; told: string }> = [];
  const held: Array<() => Promise<void>> = [];
  let answers = 0;
  const engine = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const n = requests.length;
      res.on("close", () => step(label, `engine: response ${n} closed (finished ${res.writableFinished})`));
      const send = (payload: object) =>
        new Promise<void>((resolve) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload), () => resolve());
        });
      if (req.url?.endsWith("/models")) return void send({ data: [{ id: "grok-4" }] });
      const told = ((JSON.parse(body || "{}").messages ?? []) as any[])
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
        .join("\n");
      const kind = kindOf(told);
      requests.push({ kind, told });
      step(label, `engine: request ${n} ${req.method} ${req.url} ${kind}, ${told.length} chars${setup.hold?.includes(kind) ? ", held" : ""}`);
      const content = kind === "turn" ? `ok ANSWER-${++answers}` : `Notes: ${[...new Set(told.match(/\b[A-Z]+-[A-Z0-9]+\b/g) ?? [])].join(" ")}`;
      const answer = () => {
        step(label, `engine: answering request ${n}`);
        return send({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }).then(() => step(label, `engine: request ${n} answered`));
      };
      if (setup.hold?.includes(kind)) held.push(answer);
      else void answer();
    });
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(engine.address() as { port: number }).port}`;

  let h: Harness | undefined;
  const dog = setTimeout(() => step(label, `STALLED; server log tail:\n${h?.logs().slice(-6000) ?? "(no server yet)"}`), 75_000);
  dog.unref();
  step(label, "starting the server");
  h = await startHarness({ HOME: home, USERPROFILE: home });
  step(label, `server up at ${h.url}`);
  const frames: any[] = [];
  const controller = new AbortController();
  let pump: Promise<void> | undefined;
  t.after(async () => {
    step(label, `after: answering ${held.length} held`);
    while (held.length) await held.shift()!();
    step(label, "after: stopping the event stream");
    controller.abort();
    await pump;
    step(label, "after: stopping the server");
    await h!.stop();
    step(label, "after: closing the engine");
    engine.closeAllConnections();
    engine.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    clearTimeout(dog);
    step(label, "after: done");
  });
  assert.ok((await h.fetch("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "xai-test-000000000000", url }) })).ok, h.logs());
  assert.ok((await h.fetch(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) })).ok, h.logs());
  step(label, "connected");

  const stream = await h.fetch("/api/events", { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  pump = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) frames.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        step(label, `event stream failed: ${String(error)}`);
        throw error;
      }
    }
  })();

  const messages = async () => (await h!.json(`/api/bots/${id}/messages?limit=200&thread=${threadId}`)).messages as any[];
  const f = {
    get h() {
      return h!;
    },
    id, threadId, ids, data, requests, frames, messages,
    stored: () =>
      (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[]).find((b) => b.id === id)?.tasks.find((l: any) => l.id === threadId)?.context as Context | undefined,
    onDisk: (n: number) => (JSON.parse(readFileSync(join(data, `messages-${threadId}.json`), "utf8")) as any[]).find((m) => m.id === ids[n]),
    summary: async () => (await h!.json(`/api/bots/${id}/tasks/${threadId}/summary`)).summary as { text: string; covers: number; at: string } | null,
    row: async (n: number) => (await messages()).find((m) => m.id === ids[n]),
    remove: async (n: number) => {
      step(label, `DELETE row ${n}`);
      const res = await h!.fetch(`/api/threads/${threadId}/messages/${ids[n]}`, { method: "DELETE" });
      step(label, `DELETE row ${n}: ${res.status}`);
      return res;
    },
    edit: async (n: number, text: string) => {
      step(label, `PATCH row ${n}`);
      const res = await h!.fetch(`/api/threads/${threadId}/messages/${ids[n]}`, { method: "PATCH", body: JSON.stringify({ text }) });
      step(label, `PATCH row ${n}: ${res.status}`);
      return res;
    },
    pid: async () => (await h!.json("/api/health")).pid as number,
    told: (word: string) => waitFor(() => requests.find((r) => r.kind === "turn" && has(r.told, word))?.told),
    say: async (text: string) => {
      step(label, `say ${text.split(" ")[0]}`);
      assert.equal((await h!.fetch(`/api/bots/${id}/messages`, { method: "POST", body: JSON.stringify({ text, taskId: threadId }) })).status, 202);
      const told = await f.told(text.split(" ")[0]);
      step(label, `say: turn asked ${Boolean(told)}`);
      assert.ok(told, `the turn was not asked: ${h!.logs()}`);
      assert.ok(
        await waitFor(async () => {
          const all = await messages();
          const at = all.findIndex((m) => m.text === text);
          return at >= 0 && all.slice(at + 1).some((m) => m.role === "bot" && m.kind === "text");
        }),
        `the turn did not answer: ${h!.logs()}`,
      );
      step(label, "say: answered");
      assert.ok(await idle(h!, { id }), h!.logs());
      step(label, "say: idle");
      return told!;
    },
    release: async () => {
      step(label, `release ${held.length}`);
      while (held.length) await held.shift()!();
      step(label, "released");
    },
    held: () => held.length,
    barrier: async (title: string) => {
      step(label, `barrier ${title}`);
      assert.ok((await h!.fetch(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify({ title }) })).ok);
      assert.ok(await waitFor(() => frames.some((fr) => fr.kind === "bot" && fr.bot?.id === id && fr.bot.title === title)));
      step(label, "barrier: seen");
      return frames.findIndex((fr) => fr.kind === "bot" && fr.bot?.id === id && fr.bot.title === title);
    },
    said: (from: number, to = frames.length) => ({
      bots: frames.slice(from, to).filter((fr) => fr.kind === "bot" && fr.bot?.id === id),
      patches: frames.slice(from, to).filter((fr) => fr.kind === "message.patch" && fr.threadId === threadId),
    }),
    summarised: (frame: any) => frame.bot.tasks.find((l: any) => l.id === threadId)?.context?.summarised,
    restart: async () => {
      step(label, "restart: stopping");
      controller.abort();
      await pump;
      await h!.stop();
      step(label, "restart: starting");
      h = await startHarness({ HOME: home, USERPROFILE: home });
      step(label, "restart: up");
    },
  };
  assert.deepEqual(await f.summary(), context ? { text: context.summary, covers: context.through, at: new Date(context.at).toISOString() } : null);
  step(label, "fixture ready");
  return f;
}

describe("a turn that summarises first while a message changes", () => {
  test("a message the summary read, deleted meanwhile", { timeout: 100_000 }, async (t) => {
    const label = "big";
    const rows: Row[] = [
      { role: "user", text: "FACT-0 OLD-0 where it started." },
      ...Array.from({ length: 64 }, (_, k): Row => ({ role: k % 2 ? "bot" : "user", text: `FACT-${k + 1} ${"x".repeat(8_000)}` })),
    ];
    const context: Context = { summary: "Notes: FACT-0 OLD-0 SUMMARY-ONLY", through: 1, at: 1234 };
    const f = await fixture(t, { label, rows, context, hold: ["fold"] });
    step(label, "POST the turn's message");
    const sent = await f.h.fetch(`/api/bots/${f.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FACT-NEXT the turn that summarises first.", taskId: f.threadId }) });
    step(label, `POST: ${sent.status}`);
    assert.equal(sent.status, 202);
    assert.ok(await waitFor(() => f.held() > 0), f.h.logs());
    step(label, "a request is held");
    assert.ok(f.requests.find((r) => r.kind === "fold")!.told.includes("SUMMARY-ONLY"), "the summary request did not carry the saved summary");
    assert.equal((await f.remove(0)).status, 200);
    assert.equal(await f.summary(), null);
    await f.release();
    const told = await f.told("FACT-NEXT");
    step(label, `turn told: ${Boolean(told)}`);
    assert.ok(told, f.h.logs());
    const asked = f.requests.findIndex((r) => r.told === told);
    assert.equal(f.requests.slice(0, asked).filter((r) => r.kind === "fold").length, 1, "a request went out after the summary was dropped");
    assert.equal(f.stored(), undefined);
    assert.equal(told!.includes(SUMMARISED), false, "the turn was told the dropped summary");
    assert.equal(has(told!, "OLD-0"), false, "the turn was told the deleted words");
    assert.ok(has(told!, "FACT-64"), "the newest messages were not told");
    step(label, "waiting for idle");
    assert.ok(await idle(f.h, { id: f.id }), f.h.logs());
    step(label, "test body done");
  });
});

describe("a change that cannot be saved", { concurrency: 4 }, () => {
  test("when the summary cannot be dropped", { timeout: 100_000 }, async (t) => {
    const label = "bots";
    const f = await fixture(t, { label });
    const saved = await f.summary();
    const blocked = join(f.data, `bots.json.${await f.pid()}.tmp`);
    mkdirSync(blocked);
    step(label, `blocked ${blocked}`);
    const from = f.frames.length;
    assert.equal((await f.remove(0)).status, 500);
    assert.equal((await f.edit(4, "FACT-3 NEW-3 the plan in other words.")).status, 500);
    assert.deepEqual(await f.summary(), saved);
    assert.deepEqual(f.stored(), covering);
    assert.equal((await f.row(0)).text, "FACT-1 where it started.");
    assert.equal((await f.row(0)).deleted, undefined);
    assert.equal((await f.row(4)).text, "FACT-3 OLD-3 a plan in its first words.");
    assert.equal(f.onDisk(0).text, "FACT-1 where it started.");
    assert.equal(f.onDisk(4).text, "FACT-3 OLD-3 a plan in its first words.");
    rmSync(blocked, { recursive: true });
    step(label, "unblocked");
    const to = await f.barrier("Fixture after the refused changes");
    assert.deepEqual(f.said(from, to), { bots: [], patches: [] });

    await f.restart();
    assert.deepEqual(await f.summary(), saved);
    assert.equal((await f.row(0)).text, "FACT-1 where it started.");
    assert.equal((await f.row(4)).text, "FACT-3 OLD-3 a plan in its first words.");
    assert.equal((await f.remove(0)).status, 200);
    assert.equal(await f.summary(), null);
    step(label, "test body done");
  });

  for (const change of ["deleted", "edited"] as const) {
    test(`when the summary is dropped but the message, ${change}, cannot be saved`, { timeout: 100_000 }, async (t) => {
      const label = change;
      const f = await fixture(t, { label });
      const blocked = join(f.data, `messages-${f.threadId}.json.${await f.pid()}.tmp`);
      mkdirSync(blocked);
      step(label, `blocked ${blocked}`);
      const from = f.frames.length;
      const n = change === "deleted" ? 0 : 4;
      const was = change === "deleted" ? "FACT-1 where it started." : "FACT-3 OLD-3 a plan in its first words.";
      const res = change === "deleted" ? await f.remove(n) : await f.edit(n, "FACT-3 NEW-3 the plan in other words.");
      assert.equal(res.status, 500);
      assert.equal(await f.summary(), null);
      assert.equal(f.stored(), undefined);
      assert.equal((await f.row(n)).text, was);
      assert.equal((await f.row(n)).deleted, undefined);
      assert.equal(f.onDisk(n).text, was);
      rmSync(blocked, { recursive: true });
      step(label, "unblocked");
      const to = await f.barrier("Fixture after the failed change");
      const said = f.said(from, to);
      assert.equal(said.bots.length, 1);
      assert.equal(f.summarised(said.bots[0]), false);
      assert.deepEqual(said.patches, []);

      const next = await f.say("FACT-NEXT after the failed change.");
      assert.equal(next.includes(SUMMARISED), false);
      assert.ok(next.includes(was));
      assert.ok(has(next, "FACT-5"));

      await f.restart();
      assert.equal(await f.summary(), null);
      assert.equal((await f.row(n)).text, was);
      step(label, "test body done");
    });
  }
});
