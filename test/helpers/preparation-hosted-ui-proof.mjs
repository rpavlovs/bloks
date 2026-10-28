import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { codexCommands, waitFor } from "./codex-commands.ts";
import { build } from "vite";

const source = fileURLToPath(new URL("../../", import.meta.url));
const { chromium } = createRequire(source + "package.json")("playwright-core");
const built = mkdtempSync(join(tmpdir(), "bloks-preparation-ui-"));
before(async () => { await build({ root: source, build: { outDir: built, emptyOutDir: true }, logLevel: "error" }); });
after(() => rmSync(built, { recursive: true, force: true }));

async function setup(t, language = "en", noRandomUUID = false) {
  const s = await codexCommands(t, { BLOKS_STATIC_DIR: built, BLOKS_EDIT_HOLD_MS: "4000" });
  await s.h.json("/api/config", { method: "PATCH", body: JSON.stringify({ setupDone: true }) });
  s.spec({ hold: true, holdSkills: true, holdSteerSkills: true, holdSteer: true, wrongSteerId: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, env: { HOME: s.root, TMPDIR: s.root, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const blocked = [], errors = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === s.h.url) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  await context.routeWebSocket("**/*", (ws) => ws.close());
  if (noRandomUUID) await context.addInitScript(() => { Object.defineProperty(crypto, "randomUUID", { value: undefined }); });
  await context.addInitScript((lang) => { localStorage.setItem("bloks-setup-done", "done"); localStorage.setItem("bloks-intro-done", "1"); localStorage.setItem("bloks-language", lang); }, language);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(s.h.url, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-sidebar-row="${s.bot.id}"]`).click();
  const composer = page.getByRole("textbox", { name: /Rex/ });
  await composer.fill("FIRST $selected"); await composer.press("Enter");
  await s.called("thread/start", 1);
  const pid = s.calls().find((call) => call.method === "thread/start").pid;
  await waitFor(() => s.calls().some((call) => call.method === "skills/list" && call.pid === pid));
  await composer.fill("UI_FOLLOWUP $selected"); await composer.press("Enter");
  const waiting = page.locator("[data-waiting]").filter({ hasText: "UI_FOLLOWUP" });
  await waiting.waitFor();
  const id = await waiting.getAttribute("data-waiting");
  const row = page.locator(`[data-waiting="${id}"]`);
  return { s, context, page, row, id, errors, blocked };
}

for (const language of ["en", "es"]) test(`built app dismisses uncertain input and keeps the localized history (${language})`, async (t) => {
  const f = await setup(t, language);
  f.s.skillsGate();
  await f.s.called("skills/list", 2);
  f.s.steerSkillsGate();
  await f.s.called("turn/steer", 1);
  f.s.steerGate();
  const status = language === "en" ? "Delivery could not be confirmed. It will not be sent again automatically." : "No se pudo confirmar la entrega. No se enviará de nuevo automáticamente.";
  await f.row.getByText(status, { exact: true }).waitFor();
  await f.page.setViewportSize({ width: 390, height: 844 });
  await f.row.getByText(status, { exact: true }).waitFor();
  const dismiss = language === "en" ? "Dismiss" : "Descartar";
  await f.row.getByRole("button", { name: dismiss }).click();
  await f.row.waitFor({ state: "detached" });
  await f.page.getByText(status, { exact: true }).waitFor();
  assert.equal((await f.s.messages()).find((m) => m.id === f.id).preparation.dismissed, true);
  await f.page.reload({ waitUntil: "domcontentloaded" });
  await f.page.getByText(status, { exact: true }).waitFor();
  assert.equal(f.s.count("turn/steer"), 1);
  f.s.gate(); await f.s.settled();
  assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
});

for (const outcome of ["rejected", "unknown", "opening-unknown"]) test(`built app ${outcome} edit ${outcome === "rejected" ? "releases" : "keeps"} its hold`, async (t) => {
  const f = await setup(t, "en", outcome === "rejected");
  const path = `/api/threads/${f.s.bot.threadId}/messages/${f.id}`;
  let released = 0, patches = 0;
  await f.context.route(f.s.h.url + path + "/editing", async (route) => {
    if (outcome === "opening-unknown" && route.request().postDataJSON()?.editing === true) return route.abort("failed");
    if (route.request().postDataJSON()?.editing === false) released++;
    return route.continue();
  });
  await f.context.route(f.s.h.url + path, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patches++;
    if (outcome === "rejected") return route.fulfill({ status: 409, contentType: "application/json", body: '{"error":"rejected"}' });
    return route.abort("failed");
  });
  await f.row.getByRole("button", { name: "Edit" }).click();
  await f.page.getByRole("textbox", { name: "Edit the waiting message" }).fill("REPLACEMENT_WORDS");
  await f.row.getByRole("button", { name: "Save" }).click();
  await f.page.getByText(outcome === "rejected" ? "The edit was rejected." : "Could not confirm whether the edit was saved.", { exact: false }).waitFor();
  assert.equal(await f.page.getByRole("textbox", { name: "Your replacement words" }).inputValue(), "REPLACEMENT_WORDS");
  if (outcome === "opening-unknown") assert.equal(patches, 0, "an unconfirmed hold must not permit a save");
  if (outcome === "rejected") await waitFor(() => released === 1, "definite rejection did not release the hold");
  else { await new Promise((r) => setTimeout(r, 250)); assert.equal(released, 0); }
  f.s.skillsGate(); f.s.steerSkillsGate(); f.s.steerGate(); f.s.gate();
  await f.s.settled();
  assert.deepEqual(f.errors, []); assert.deepEqual(f.blocked, []);
});
