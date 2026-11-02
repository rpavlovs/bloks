// Diagnosis only: what a later request is told after the person deletes a
// message that was already folded into the lane's saved summary. The real
// harness over real HTTP, a throwaway home, and a local fake
// OpenAI-compatible engine. Each assertion records current behaviour.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { startHarness, type Harness } from "./helpers/server.ts";

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h?.stop();
});

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 20_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

const FOLD = /Summarise this part of a conversation|Produce one summary covering both/;
const WORD = /\b(?:USER|REPLY|CONTROL|NEXT)-\d+\b|\bFIT-X\b/g;

test("a deleted message folded into the saved summary, and the next request", async (t) => {
  let refuse = false;
  let replies = 0;
  const sent: string[] = [];
  const folds: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = (status: number, payload: object) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url?.endsWith("/models")) return reply(200, { data: [{ id: "grok-4" }] });
      const told = ((JSON.parse(body || "{}").messages ?? []) as any[]).map((m) => String(m.content ?? "")).join("\n");
      if (FOLD.test(told)) {
        folds.push(told);
        // a summariser that keeps every fact it was given
        const facts = [...new Set(told.match(WORD) ?? [])];
        return reply(200, { choices: [{ message: { role: "assistant", content: `Notes: ${facts.join(" ")}` }, finish_reason: "stop" }] });
      }
      sent.push(told);
      if (refuse) {
        refuse = false;
        return reply(400, { error: { message: "This model's maximum context length is 131072 tokens, however you requested 140000" } });
      }
      replies += 1;
      return reply(200, { choices: [{ message: { role: "assistant", content: `ok REPLY-${replies}` }, finish_reason: "stop" }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  await h.fetch("/api/providers/grok/connect", {
    method: "POST",
    body: JSON.stringify({ key: "xai-test-000000000000", url: `http://127.0.0.1:${(server.address() as any).port}` }),
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Deletion fixture" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  const current = async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
  // settled once the agent has answered this message and is idle again
  const say = async (text: string) => {
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    const done = await waitFor(async () => {
      const b = await current();
      if (!b || b.busy) return null;
      const at = (b.messages as any[]).findIndex((m) => m.text === text);
      return at >= 0 && (b.messages as any[]).slice(at + 1).some((m) => m.kind === "text" && m.role !== "user") ? b : null;
    });
    assert.ok(done, `the turn did not settle: ${h.logs()}`);
  };
  let lane = "";
  const rows = async () => (await h.json(`/api/bots/${bot.id}/messages?limit=200&thread=${lane}`)).messages as any[];
  const settled = async () => (await rows()).filter((m) => m.kind === "text" && m.text && !m.deleted && !m.queued && !m.unsent);
  const summary = async () => (await h.json(`/api/bots/${bot.id}/tasks/${lane}/summary`)).summary as { text: string; covers: number } | null;
  const lastTold = (word: string) => [...sent].reverse().find((s) => s.includes(word)) ?? "";

  for (let i = 0; i < 8; i++) await say(`message number ${i} USER-${i}, with enough words in it to be worth summarising later on`);
  lane = (await current()).activeTaskId;
  assert.ok(lane, "the agent has no conversation");
  refuse = true;
  await say("the one that will not fit FIT-X");
  const saved = await waitFor(summary);
  assert.ok(saved, `no summary was saved: ${h.logs()}`);
  assert.ok(folds.length >= 1, "no summary request was made");

  await say("control turn CONTROL-1");
  const listed = await settled();
  const target = listed.find((m) => m.text.includes("USER-0"));
  assert.ok(target, "the first message is not in the transcript");
  const at = listed.indexOf(target);
  assert.ok(at < saved!.covers, `USER-0 is at ${at}, past the ${saved!.covers} the summary covers`);
  assert.ok(saved!.text.includes("USER-0"), `the saved summary does not carry USER-0: ${saved!.text}`);
  const first = listed[saved!.covers];
  const firstWord = first?.text.match(WORD)?.[0];
  assert.ok(firstWord, `the first message after the summary has no unique word: ${JSON.stringify(first)}`);

  // Control: before the deletion, the next request is told the summary and,
  // whole, the first message after it.
  await say("control turn CONTROL-2");
  const control = lastTold("CONTROL-2");
  assert.ok(control.includes("[Earlier in this conversation, summarised]"), "the summary was not told");
  assert.ok(control.includes(firstWord!), `${firstWord} was not told before the deletion`);

  const deleted = await h.fetch(`/api/threads/${lane}/messages/${target.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  const row = (await rows()).find((m) => m.id === target.id);
  assert.equal(row.deleted, true);
  assert.equal(row.text, "");

  await say("after the deletion NEXT-1");
  const next = lastTold("NEXT-1");
  const kept = await summary();
  // Observed on 3.2.1: the summary is kept as it was, so the deleted words
  // are told again in the next request.
  assert.equal(kept?.text, saved!.text);
  assert.equal(kept?.covers, saved!.covers);
  assert.ok(next.includes("[Earlier in this conversation, summarised]"));
  assert.ok(next.includes("USER-0"), "the deleted words were not told");
  // Observed on 3.2.1: the summary's count now starts one message late, so
  // the first message after the summary is in neither the summary nor the
  // request.
  assert.equal(next.includes(firstWord!), false, `${firstWord} was still told`);
  assert.equal(kept!.text.includes(firstWord!), false, `${firstWord} is in the summary`);
});
