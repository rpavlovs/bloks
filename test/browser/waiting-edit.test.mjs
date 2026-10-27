// Run after `npm run build` with a local Chromium installed:
// BLOKS_TEST_CHROMIUM=/path/to/chromium node --test test/browser/waiting-edit.test.mjs
// This optional real-browser check is separate from the Node-only CI suite.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { codexCommands, waitFor } from "../helpers/codex-commands.ts";

const source = new URL("../../", import.meta.url).pathname;
const { chromium } = createRequire(source + "package.json")("playwright-core");

async function setup(t, viewport = { width: 1280, height: 900 }, other = false, editHoldMs = "4000") {
  const s = await codexCommands(t, { BLOKS_STATIC_DIR: join(source, "dist"), BLOKS_EDIT_HOLD_MS: editHoldMs });
  await s.h.json("/api/config", { method: "PATCH", body: JSON.stringify({ setupDone: true }) });
  const second = other ? await s.hire("Echo") : null;
  s.spec({ hold: true, holdSkills: true, holdSteerSkills: true, holdSteer: true });
  const browser = await chromium.launch({
    ...(process.env.BLOKS_TEST_CHROMIUM ? { executablePath: process.env.BLOKS_TEST_CHROMIUM } : {}),
    headless: true, env: { HOME: s.root, TMPDIR: s.root, PATH: "/nonexistent", LANG: "C.UTF-8" },
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: viewport.width < 640 ? { width: 1280, height: 900 } : viewport, serviceWorkers: "block" });
  const blocked = [], errors = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === s.h.url) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  await context.routeWebSocket("**/*", (ws) => ws.close());
  await context.addInitScript(() => { localStorage.setItem("bloks-setup-done", "done"); localStorage.setItem("bloks-intro-done", "1"); });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(s.h.url, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-sidebar-row="${s.bot.id}"]`).click();
  if (viewport.width < 640) await page.setViewportSize(viewport);
  const composer = page.getByRole("textbox", { name: "Message Rex" });
  await composer.fill("INITIAL $selected");
  await composer.press("Enter");
  await s.called("thread/start", 1);
  const pid = s.calls().find((call) => call.method === "thread/start").pid;
  await waitFor(() => s.calls().some((call) => call.method === "skills/list" && call.pid === pid));
  await composer.fill("ORIGINAL_IN_UI $selected");
  await composer.press("Enter");
  let row = page.locator("[data-waiting]").filter({ hasText: "ORIGINAL_IN_UI" });
  await row.getByText("Waiting for this turn to start", { exact: true }).waitFor();
  const id = await row.getAttribute("data-waiting");
  row = page.locator(`[data-waiting="${id}"]`);
  const path = `/api/threads/${s.bot.threadId}/messages/${id}`;
  const holds = [];
  await context.route(s.h.url + path + "/editing", async (route) => {
    holds.push(JSON.parse(route.request().postData() ?? "{}").editing);
    return route.continue();
  });
  return { s, second, browser, context, page, row, path, id, errors, blocked, holds };
}

async function beginEdit(f, text) {
  await f.row.getByRole("button", { name: "Edit" }).click();
  await f.page.getByRole("textbox", { name: "Edit the waiting message" }).fill(text);
}

function clean(f) {
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.blocked, []);
}

function nativeText(call) { return JSON.stringify(call.params.input); }

test("delayed 409 after the row leaves preserves replacement and feedback across conversations", async (t) => {
  const f = await setup(t, { width: 1280, height: 900 }, true);
  let patches = 0, release;
  const paused = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  await f.context.route(f.s.h.url + f.path, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches++;
    await paused;
    return route.continue();
  });
  await beginEdit(f, "REPLACEMENT_409");
  const response = f.page.waitForResponse((r) => r.url() === f.s.h.url + f.path && r.request().method() === "PATCH", { timeout: 90000 });
  await f.row.getByRole("button", { name: "Save" }).click();
  await waitFor(() => patches === 1, "the save did not begin");
  f.s.skillsGate();
  await f.s.called("skills/list", 2);
  f.s.steerSkillsGate();
  await f.s.called("turn/steer", 1);
  f.s.steerGate();
  await waitFor(async () => (await f.s.messages()).some((m) => m.id === f.id && m.preparation?.state === "joined"), "the original never joined");
  await f.row.waitFor({ state: "detached" });
  await f.page.getByText("Waiting for the edit's result.", { exact: true }).waitFor();
  assert.equal(await f.page.getByRole("textbox", { name: "Your replacement words" }).inputValue(), "REPLACEMENT_409");
  await f.page.locator(`[data-sidebar-row="${f.second.id}"]`).click();
  release();
  assert.equal((await response).status(), 409);
  assert.equal(await f.page.getByText("The edit was rejected.", { exact: false }).count(), 0);
  await f.page.locator(`[data-sidebar-row="${f.s.bot.id}"]`).click();
  await f.page.getByText("The edit was rejected.", { exact: false }).waitFor();
  const recovered = f.page.getByRole("textbox", { name: "Your replacement words" });
  assert.equal(await recovered.inputValue(), "REPLACEMENT_409");
  await recovered.click();
  await recovered.press("Control+A");
  assert.equal(await recovered.evaluate((element) => element.selectionEnd - element.selectionStart), "REPLACEMENT_409".length);
  assert.equal(patches, 1);
  assert.deepEqual(f.holds, [true]);
  const steers = f.s.calls().filter((call) => call.method === "turn/steer");
  assert.equal(steers.length, 1);
  assert.match(nativeText(steers[0]), /ORIGINAL_IN_UI/);
  assert.doesNotMatch(nativeText(steers[0]), /REPLACEMENT_409/);
  f.s.gate();
  await f.s.settled();
  clean(f);
});

test("lost save response is uncertain and never replays, even after the server applied it", async (t) => {
  const f = await setup(t, { width: 390, height: 844 });
  let patches = 0, applied;
  await f.context.route(f.s.h.url + f.path, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches++;
    applied = await route.fetch();
    await route.abort("failed");
  });
  await beginEdit(f, "REPLACEMENT_UNKNOWN $selected");
  await f.row.getByRole("button", { name: "Save" }).click();
  await f.page.getByText("Could not confirm whether the edit was saved.", { exact: false }).waitFor();
  assert.equal(applied.status(), 200);
  assert.equal((await f.s.messages()).find((m) => m.id === f.id).text, "REPLACEMENT_UNKNOWN $selected");
  assert.equal(await f.page.getByRole("textbox", { name: "Your replacement words" }).inputValue(), "REPLACEMENT_UNKNOWN $selected");
  assert.equal(await f.page.getByText("The edit was rejected.", { exact: false }).count(), 0);
  assert.equal(patches, 1);
  assert.deepEqual(f.holds, [true]);
  assert.equal(f.s.count("turn/start"), 0);
  assert.equal(f.s.count("turn/steer"), 0);
  f.s.skillsGate();
  await f.s.called("turn/start", 1);
  f.s.steerSkillsGate();
  await f.s.called("turn/steer", 1);
  const sent = nativeText(f.s.calls().find((call) => call.method === "turn/steer"));
  assert.equal(sent.includes("REPLACEMENT_UNKNOWN"), true);
  assert.equal(sent.includes("ORIGINAL_IN_UI"), false);
  f.s.steerGate();
  f.s.gate();
  await f.s.settled();
  assert.equal(f.s.count("turn/start"), 1);
  assert.equal(f.s.count("turn/steer"), 1);
  assert.equal(patches, 1);
  await f.page.getByText("Could not confirm whether the edit was saved.", { exact: false }).waitFor();
  clean(f);
});

test("a lost request leaves the edit hold and delivery state alone", async (t) => {
  const f = await setup(t, { width: 1280, height: 900 }, false, "30000");
  let patches = 0;
  await f.context.route(f.s.h.url + f.path, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches++;
    return route.abort("failed");
  });
  await beginEdit(f, "LOST_BEFORE_SERVER");
  await f.row.getByRole("button", { name: "Save" }).click();
  await f.page.getByText("Could not confirm whether the edit was saved.", { exact: false }).waitFor();
  assert.equal(await f.page.getByRole("textbox", { name: "Your replacement words" }).inputValue(), "LOST_BEFORE_SERVER");
  assert.deepEqual(f.holds, [true]);
  assert.equal(patches, 1);
  f.s.skillsGate();
  await f.s.called("turn/start", 1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pending = (await f.s.messages()).find((m) => m.id === f.id);
  assert.equal(pending.preparation.state, "pending");
  assert.equal(pending.text, "ORIGINAL_IN_UI $selected");
  assert.equal(f.s.count("turn/steer"), 0);
  assert.equal(nativeText(f.s.calls().find((call) => call.method === "turn/start")).includes("ORIGINAL_IN_UI"), false);
  // End the fixture's hold explicitly; the application did not do so on error.
  await f.s.h.json(f.path + "/editing", { method: "POST", body: JSON.stringify({ editing: false }) });
  f.s.steerSkillsGate();
  await f.s.called("turn/steer", 1);
  assert.equal(nativeText(f.s.calls().find((call) => call.method === "turn/steer")).includes("ORIGINAL_IN_UI"), true);
  f.s.steerGate();
  f.s.gate();
  await f.s.settled();
  assert.equal(patches, 1);
  assert.equal(f.s.count("turn/steer"), 1);
  clean(f);
});

test("successful pending edit is saved and delivered once without a recovery notice", async (t) => {
  const f = await setup(t);
  let patches = 0;
  await f.context.route(f.s.h.url + f.path, async (route) => {
    if (route.request().method() === "PATCH") patches++;
    return route.continue();
  });
  await beginEdit(f, "REPLACEMENT_SUCCESS $selected");
  const response = f.page.waitForResponse((r) => r.url() === f.s.h.url + f.path && r.request().method() === "PATCH");
  await f.row.getByRole("button", { name: "Save" }).click();
  assert.equal((await response).status(), 200);
  await waitFor(async () => (await f.s.messages()).some((m) => m.id === f.id && m.text === "REPLACEMENT_SUCCESS $selected"));
  await waitFor(async () => await f.page.getByRole("textbox", { name: "Your replacement words" }).count() === 0, "the successful save still shows recovery");
  assert.equal(patches, 1);
  f.s.skillsGate();
  await f.s.called("turn/start", 1);
  f.s.steerSkillsGate();
  await f.s.called("turn/steer", 1);
  const sent = nativeText(f.s.calls().find((item) => item.method === "turn/steer"));
  assert.equal(sent.includes("REPLACEMENT_SUCCESS"), true);
  assert.equal(sent.includes("ORIGINAL_IN_UI"), false);
  f.s.steerGate();
  f.s.gate();
  await f.s.settled();
  assert.equal(f.s.count("turn/start"), 1);
  assert.equal(f.s.count("turn/steer"), 1);
  clean(f);
});

test("a removed row retains changed unsaved words without saving them", async (t) => {
  const f = await setup(t);
  let patches = 0;
  await f.context.route(f.s.h.url + f.path, async (route) => {
    if (route.request().method() === "PATCH") patches++;
    return route.continue();
  });
  await beginEdit(f, "UNSAVED_REPLACEMENT");
  await f.s.h.json(f.path, { method: "DELETE" });
  await f.row.waitFor({ state: "detached" });
  await f.page.getByText("The edit was not saved.", { exact: false }).waitFor();
  assert.equal(await f.page.getByRole("textbox", { name: "Your replacement words" }).inputValue(), "UNSAVED_REPLACEMENT");
  assert.equal(patches, 0);
  f.s.skillsGate();
  await f.s.called("turn/start", 1);
  assert.doesNotMatch(nativeText(f.s.calls().find((call) => call.method === "turn/start")), /UNSAVED_REPLACEMENT/);
  f.s.gate();
  await f.s.settled();
  clean(f);
});
