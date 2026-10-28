// CI-only proof: the built UI, a stand-in Codex that asks two questions
// without waiting, and its agent withdrawing them one at a time. Synthetic
// data only: a throwaway home, no account, no network past this server.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { startHarness } from "./server.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));
const { chromium } = createRequire(source + "package.json")("playwright-core");
const built = mkdtempSync(join(tmpdir(), "bloks-withdraw-ui-"));
before(async () => { await build({ root: source, build: { outDir: built, emptyOutDir: true }, logLevel: "error" }); });
after(() => rmSync(built, { recursive: true, force: true }));

const ENV = "Which environment should I inspect?";
const REGION = "Which region?";
const words = {
  en: {
    dock: "Questions waiting for your answer", below: "Waiting for your answer below", notAnswered: "Not answered",
    withdrew: "Kat withdrew this question. No answer is needed.",
    waitingAbove: "Kat is waiting for your answer above.", adding: "Add to what Kat is doing",
    waitingPreview: "Waiting for you…", working: "working",
    overview: "Overview", overviewOne: "Overview: 1 waiting on you",
    waiting: "Waiting for you", needsYou: "Needs you",
  },
  de: {
    dock: "Fragen, die auf deine Antwort warten", below: "Wartet unten auf deine Antwort", notAnswered: "Nicht beantwortet",
    withdrew: "Kat hat diese Frage zurückgezogen. Eine Antwort ist nicht nötig.",
    waitingAbove: "Kat wartet oben auf deine Antwort.", adding: "Zu dem hinzufügen, was Kat gerade tut",
    waitingPreview: "Wartet auf dich…", working: "arbeitet",
    overview: "Übersicht", overviewOne: "Übersicht: 1 wartet auf dich",
    waiting: "Wartet auf dich", needsYou: "Braucht dich",
  },
};

/** A Codex that, told ASYNC-TWO, asks two questions without waiting (each
 * said twice, as a replay) and keeps its turn open, noting the turn's
 * credential so the proof can act as its agent while it runs. */
function codexHome() {
  const home = mkdtempSync(join(tmpdir(), "bloks-withdraw-ui-home-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli: join(home, "fake-codex.mjs") } } } }));
  writeFileSync(join(home, "fake-codex.mjs"), `#!${process.execPath}
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("codex-cli 0.164.0"); process.exit(0); }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
process.stdin.on("end", () => process.exit(0));
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let thread, turn;
const say = (id, item) => out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id, phase: "final_answer", ...item } } });
const ask = (id, questions) => {
  const item = { text: questions.map((q) => [q.title, ...(q.options ?? []).map((o) => "- " + o)].join("\\n")).join("\\n"), delivery: "async", questions };
  say(id, item);
  say(id, item);
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!m.method) return;
  const reply = (result = {}) => out({ id: m.id, result });
  if (m.method === "initialize") return reply();
  if (m.method === "initialized") return;
  if (m.method === "model/list") return reply({ data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true, hidden: false }] });
  if (m.method === "skills/list") return reply({ data: [{ cwd: m.params.cwds[0], skills: [], errors: [] }] });
  if (m.method === "thread/start" || m.method === "thread/resume") { thread = m.params.threadId ?? "native-" + process.pid; return reply({ thread: { id: thread }, model: "gpt-6.1-sol" }); }
  if (m.method === "turn/steer") { reply({ turnId: turn }); return say("told-" + Date.now(), { text: "TOLD " + JSON.stringify(m.params.input[0].text) }); }
  if (m.method !== "turn/start") return reply();
  turn = "work-" + Date.now(); reply({ turn: { id: turn } });
  out({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
  const text = m.params.input.filter((i) => i.type === "text").map((i) => i.text).join("");
  appendFileSync(${JSON.stringify(join(home, "turns.jsonl"))}, JSON.stringify({ text, token: process.env.BLOKS_TOKEN }) + "\\n");
  if (text.includes("ASYNC-TWO")) {
    ask("q-env", [{ title: ${JSON.stringify(ENV)}, options: ["Local", "Staging"] }]);
    return ask("q-region", [{ title: ${JSON.stringify(REGION)}, options: ["eu", "us"] }]);
  }
  say("answer-" + Date.now(), { text: "Done." });
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed" } } });
});
`, { mode: 0o755 });
  return home;
}

async function until(check, why, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(why);
    await new Promise((r) => setTimeout(r, 100));
  }
}

for (const language of ["en", "de"]) test(`built app lets a withdrawn question go from everywhere it waited, and keeps the other (${language})`, async (t) => {
  const w = words[language];
  const home = codexHome();
  const h = await startHarness({ HOME: home, BLOKS_STATIC_DIR: built });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  // as the page itself asks: this server serves the page, so its own origin
  const api = async (path, init = {}) => {
    const res = await h.fetchAs(h.url, path, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  await api("/api/config", { method: "PATCH", body: JSON.stringify({ setupDone: true }) });
  const { body: { bot } } = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "Kat" }) });
  await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
  const messages = async () => (await api(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=100`)).body.messages;

  const browser = await chromium.launch({ channel: "chrome", headless: true, env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const blocked = [], errors = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === h.url) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  await context.routeWebSocket("**/*", (ws) => ws.close());
  await context.addInitScript((lang) => { localStorage.setItem("bloks-setup-done", "done"); localStorage.setItem("bloks-intro-done", "1"); localStorage.setItem("bloks-language", lang); }, language);
  const open = async (path = "") => {
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(h.url + path, { waitUntil: "domcontentloaded" });
    return page;
  };

  // the conversation: Kat asks two questions and carries on working
  const page = await open();
  const row = page.locator(`[data-sidebar-row="${bot.id}"]`);
  await row.click();
  const composer = page.getByRole("textbox", { name: /Kat/ });
  await composer.fill("ASYNC-TWO on the outage"); await composer.press("Enter");
  const cards = await until(async () => {
    const asked = (await messages()).filter((m) => m.kind === "options" && m.card?.requestId);
    return asked.length === 2 ? asked : null;
  }, "the two questions never opened");
  const env = cards.find((m) => m.card.subtitle === ENV), region = cards.find((m) => m.card.subtitle === REGION);
  assert.ok(env && region, "the cards are not the two questions asked");
  const dock = page.getByRole("region", { name: w.dock });
  const docked = (m) => dock.locator(`[data-question-dock="${m.id}"]`);
  const asked = (m) => page.locator(`[data-message-id="${m.id}"]`).first();
  const busy = row.getByLabel(w.working, { exact: true });
  /** An attribute, once it settles on what is expected. */
  const reads = (locator, name, value) => until(async () => (await locator.getAttribute(name)) === value, `${name} never read ${value}`);
  /** A settled question's line, opened to say why it closed. */
  const withdrawn = async (m) => {
    const summary = asked(m).getByText(w.notAnswered, { exact: true });
    const why = asked(m).getByText(w.withdrew, { exact: true });
    await summary.waitFor();
    if (!(await why.isVisible())) await summary.click();
    await why.waitFor();
  };
  await docked(env).waitFor(); await docked(region).waitFor();
  for (const m of [env, region]) await asked(m).getByText(w.below, { exact: true }).waitFor();
  await reads(row, "data-sidebar-waiting", "true");
  await row.getByText(w.waitingPreview, { exact: true }).waitFor();
  assert.equal(await busy.count(), 0);
  await reads(composer, "placeholder", w.waitingAbove);
  // the conversation counts once, and Activity shows its latest question
  await page.getByRole("button", { name: w.overviewOne, exact: true }).waitFor();

  // the other places it waits: Overview's Activity, and the notch
  const overview = await open();
  await overview.getByRole("button", { name: new RegExp(`^${w.overview}`) }).click();
  await overview.getByText(w.waiting, { exact: true }).waitFor();
  await overview.getByText(REGION, { exact: true }).waitFor();
  const notch = await open("/?notch");
  await notch.getByText(w.needsYou, { exact: true }).waitFor();

  // the agent withdraws the later one, while its turn runs, as `bloks unask` does
  const credential = await until(() => {
    const turns = join(home, "turns.jsonl");
    return existsSync(turns) && readFileSync(turns, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((turn) => turn.text.includes("ASYNC-TWO"))?.token;
  }, "the turn's credential was never noted");
  const unask = async (m) => {
    const res = await fetch(`${h.url}/api/bots/${bot.id}/questions/${m.id}`, { method: "DELETE", headers: { authorization: `Bearer ${credential}` } });
    assert.deepEqual({ status: res.status, body: await res.json() }, { status: 200, body: { ok: true, withdrawn: m.id } });
  };
  await unask(region);
  await page.bringToFront();
  await docked(region).waitFor({ state: "detached" });
  await withdrawn(region);
  // the earlier question is still the person's, everywhere, and Activity shows it now
  await docked(env).waitFor();
  await asked(env).getByText(w.below, { exact: true }).waitFor();
  await reads(row, "data-sidebar-waiting", "true");
  await reads(composer, "placeholder", w.waitingAbove);
  await page.getByRole("button", { name: w.overviewOne, exact: true }).waitFor();
  await overview.bringToFront();
  await overview.getByText(REGION, { exact: true }).waitFor({ state: "detached" });
  await overview.getByText(ENV, { exact: true }).waitFor();
  await notch.bringToFront();
  await notch.getByText(w.needsYou, { exact: true }).waitFor();

  // and then that one: nothing waits on the person, and Kat is still at work
  await unask(env);
  await page.bringToFront();
  await dock.waitFor({ state: "detached" });
  await withdrawn(env);
  await reads(row, "data-sidebar-waiting", "false");
  await busy.waitFor();
  await reads(composer, "placeholder", w.adding);
  await page.getByRole("button", { name: w.overview, exact: true }).waitFor();
  await overview.bringToFront();
  await overview.getByText(w.waiting, { exact: true }).waitFor({ state: "detached" });
  await overview.getByText(ENV, { exact: true }).waitFor({ state: "detached" });
  await notch.bringToFront();
  await notch.getByText(w.needsYou, { exact: true }).waitFor({ state: "detached" });
  await notch.locator(".notch-shoulder").first().waitFor();

  // a phone's width, and then the page loaded again: still withdrawn, nothing waiting
  await page.bringToFront();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const m of [env, region]) await withdrawn(m);
  assert.equal(await dock.count(), 0);
  await page.reload({ waitUntil: "domcontentloaded" });
  for (const m of [env, region]) await withdrawn(m);
  assert.equal(await dock.count(), 0);
  assert.equal(await page.getByText(w.below, { exact: true }).count(), 0);
  await reads(composer, "placeholder", w.adding);

  // what the server kept: both withdrawn, neither answered, and nothing said for the person
  const kept = await messages();
  for (const m of [env, region]) {
    const card = kept.find((k) => k.id === m.id).card;
    assert.equal(card.withdrawn, true);
    assert.equal(card.answered, "Closed without an answer");
  }
  assert.deepEqual(kept.filter((k) => k.role === "user").map((k) => k.text), ["ASYNC-TWO on the outage"]);
  assert.ok(!kept.some((k) => k.role === "bot" && k.kind === "text" && /^TOLD /.test(k.text ?? "")), "the withdrawal was said to the agent");
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
});
