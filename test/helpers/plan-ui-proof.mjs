// CI-only proof: a built renderer with a read-only synthetic loopback API.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { planNotices } from "../../server/plan-usage.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { chromium } = createRequire(join(root, "package.json"))("playwright-core");
const tmp = mkdtempSync(join(tmpdir(), "plan-ui-proof-"));
const dist = join(tmp, "dist");
const NOW = Date.UTC(2026, 9, 20, 23, 50);
const MINUTE = 60_000;
const bot = { id: "helper", name: "Helper", title: "Assistant", description: "Synthetic fixture", notifications: false, color: "blue", threadId: "active", activeTaskId: "active", createdAt: NOW, tasks: [{ id: "active", title: "General", state: "idle", createdAt: NOW }], messages: [], unread: false, usage: { input: 0, output: 0 }, state: "idle", modelSelection: { instanceId: "codex", model: "synthetic" } };
const engine = (instanceId, displayName, driverKind) => ({ instanceId, displayName, driverKind, snapshot: { state: "available", authenticated: true, version: "fixture" }, models: { default: "synthetic", options: [{ id: "synthetic", label: "Synthetic model" }] } });
const engines = [engine("claude", "Claude Code", "claudeAgent"), engine("codex", "Codex", "codex")];
const total = { turns: 0, input: 0, output: 0, cost: 0, unmeasured: 0 };
const windows = (...values) => planNotices("claude", { windows: values, plan: null, at: NOW }, NOW);
const short = { id: "five_hour", minutes: 300, used: 1, resetsAt: NOW + 134 * MINUTE };
const weekly = { id: "seven_day_opus", minutes: 10_080, used: 1, resetsAt: NOW + (2 * 24 + 3) * 60 * MINUTE };
let notices = windows(short);
let holdNotices = false;
let resolveHeld = null;
const heldNotices = [];
const requests = [], blocked = [], errors = [], streams = new Set();
const json = (res, data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/events") {
    streams.add(res); req.on("close", () => streams.delete(res));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("data: " + JSON.stringify({ kind: "hello", resumed: false, _seq: 0 }) + "\n\n"); return;
  }
  if (url.pathname.startsWith("/api/")) {
    requests.push({ path: url.pathname, query: url.search, method: req.method });
    if (req.method !== "GET") {
      console.log(`DENIED synthetic fixture request ${req.method} ${url.pathname}`);
      return json(res, { error: "Fixture forbids writes" }, 403);
    }
    if (url.pathname === "/api/bots") return json(res, { bots: [bot] });
    if (url.pathname === "/api/bloks") return json(res, { bloks: [] });
    if (url.pathname === "/api/config") return json(res, { setupDone: true });
    if (url.pathname === "/api/instances") return json(res, { instances: engines });
    if (url.pathname === "/api/providers") return json(res, { providers: [] });
    if (url.pathname === "/api/sidebar") return json(res, { sectionOrder: [], sectionOrderSaved: true });
    if (url.pathname === "/api/engines/updates") return json(res, { updates: {} });
    if (url.pathname === "/api/health") return json(res, { app: "bloks", version: "fixture", pid: 1 });
    if (url.pathname === "/api/usage-notices") {
      if (holdNotices) { heldNotices.push(res); resolveHeld?.(); resolveHeld = null; return; }
      return json(res, { notices });
    }
    if (url.pathname === "/api/usage/report") return json(res, { range: "7d", from: "2026-10-16", to: "2026-10-22", days: 7, daily: [], byAgent: [], byEngine: [], total, previous: total, priced: false, unpricedTurns: 0, bloksAiTurns: 0, agents: [], engines: [] });
    if (url.pathname === "/api/plan-usage") return json(res, { usage: {} });
    if (url.pathname === "/api/spend-limits") return json(res, { limits: [] });
    return json(res, { error: "Not provided by synthetic fixture" }, 404);
  }
  const file = url.pathname === "/" ? join(dist, "index.html") : join(dist, normalize(url.pathname).replace(/^\/+/, ""));
  try {
    const content = readFileSync(file);
    res.writeHead(200, { "content-type": ({ js: "text/javascript", css: "text/css", svg: "image/svg+xml", woff2: "font/woff2" }[extname(file).slice(1)] || "text/html") });
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});

let browser;
try {
  await build({ root, build: { outDir: dist, emptyOutDir: true }, logLevel: "error" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true, env: { HOME: tmp, TMPDIR: tmp, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  for (const language of ["en", "es"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      blocked.push(route.request().url()); return route.abort();
    });
    await context.routeWebSocket("**/*", (ws) => ws.close());
    await context.addInitScript((lang) => { localStorage.setItem("bloks-setup-done", "1"); localStorage.setItem("bloks-intro-done", "1"); localStorage.setItem("bloks-language", lang); }, language);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: NOW });
    notices = windows(short);
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const area = page.locator("main textarea");
    const button = language === "en" ? "View usage" : "Ver uso";
    const dismiss = language === "en" ? "Dismiss usage notice" : "Descartar aviso de uso";
    const notice = () => page.getByRole("button", { name: button, exact: true }).locator("..");
    const refresh = async () => {
      const response = page.waitForResponse((r) => r.url().includes("/api/usage-notices?"));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await response;
    };
    const text = async () => (await notice().innerText()).replace(/\s+/g, " ");
    const expectedShort = language === "en" ? /5-hour limit: Limit reached.*100% used.*2 h 14 min/ : /Límite de 5 horas: Límite alcanzado.*100 % usado.*2 h 14 min/;
    await area.waitFor(); await notice().waitFor();
    assert.match(await text(), expectedShort);
    assert.equal((await text()).split(language === "en" ? "5-hour limit" : "Límite de 5 horas").length - 1, 1, "new client must not repeat the server label");
    const liveTitle = notice().locator('[role="alert"]');
    assert.equal(await liveTitle.getAttribute("aria-atomic"), "true");
    assert.doesNotMatch(await liveTitle.innerText(), /2 h 14 min/, "the changing clock is outside the live title");
    await liveTitle.evaluate((el) => {
      window.__titleMutations = 0;
      new MutationObserver(() => window.__titleMutations++).observe(el, { subtree: true, characterData: true, childList: true });
    });
    await area.fill("Synthetic draft"); await area.focus();
    await area.evaluate((e) => e.setSelectionRange(2, 8, "backward"));
    await page.clock.fastForward(MINUTE);
    await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("2 h 13 min"));
    assert.equal(await area.inputValue(), "Synthetic draft");
    assert.ok(await area.evaluate((e) => e === document.activeElement));
    assert.deepEqual(await area.evaluate((e) => [e.selectionStart, e.selectionEnd, e.selectionDirection]), [2, 8, "backward"]);
    assert.equal(await page.evaluate(() => window.__titleMutations), 0, "minute tick did not mutate the live alert");
    await page.clock.setSystemTime(NOW + 10 * MINUTE);
    await refresh();
    await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("2 h 4 min"));
    assert.deepEqual(await area.evaluate((e) => [e.selectionStart, e.selectionEnd, e.selectionDirection]), [2, 8, "backward"]);
    console.log(`PASS ${language} short across midnight and automatic minute tick: ${await text()}`);

    notices = windows(short, weekly); await refresh();
    assert.match(await text(), language === "en" ? /5-hour limit/ : /Límite de 5 horas/);
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await notice().evaluate((e) => ({ width: e.clientWidth, scroll: e.scrollWidth, left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right, bottom: e.getBoundingClientRect().bottom, viewport: innerWidth, height: innerHeight, page: document.documentElement.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 1 && bounds.left >= 0 && bounds.right <= bounds.viewport && bounds.bottom <= bounds.height && bounds.page <= bounds.viewport, JSON.stringify(bounds));
    assert.ok(await notice().getByRole("button", { name: button }).isVisible());
    await notice().getByRole("button", { name: dismiss }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("Opus"));
    assert.equal(await area.inputValue(), "Synthetic draft");
    assert.deepEqual(await area.evaluate((e) => [e.selectionStart, e.selectionEnd, e.selectionDirection]), [2, 8, "backward"]);
    assert.match(await text(), language === "en" ? /Weekly limit, Opus.*about 2 d 3 h/ : /Límite semanal, Opus.*aproximadamente 2 d 3 h/);
    const weeklyBounds = await notice().evaluate((e) => ({ width: e.clientWidth, scroll: e.scrollWidth, right: e.getBoundingClientRect().right, bottom: e.getBoundingClientRect().bottom, viewport: innerWidth, height: innerHeight, page: document.documentElement.scrollWidth }));
    assert.ok(weeklyBounds.scroll <= weeklyBounds.width + 1 && weeklyBounds.right <= weeklyBounds.viewport && weeklyBounds.bottom <= weeklyBounds.height && weeklyBounds.page <= weeklyBounds.viewport, JSON.stringify(weeklyBounds));
    // The dismissed first window keeps the same ID while its label and time change.
    notices = windows(short, weekly).map((n) => n.id.includes("five_hour")
      ? { ...n, title: "5-hour limit (primary): Limit reached", planWindow: { id: "primary", minutes: 300 } }
      : n);
    await refresh();
    assert.match(await text(), /Opus/);
    await page.clock.fastForward(MINUTE);
    assert.match(await text(), /Opus/);
    // A later reset is a new notice ID and can be shown again.
    notices = windows({ ...short, resetsAt: short.resetsAt + MINUTE }, weekly); await refresh();
    await page.waitForFunction((phrase) => document.querySelector("main")?.textContent?.includes(phrase), language === "en" ? "5-hour limit" : "Límite de 5 horas");
    assert.match(await text(), language === "en" ? /5-hour limit/ : /Límite de 5 horas/);
    await area.focus();
    await notice().getByRole("button", { name: dismiss }).click();
    assert.ok(await area.evaluate((e) => e === document.activeElement));
    assert.deepEqual(await area.evaluate((e) => [e.selectionStart, e.selectionEnd, e.selectionDirection]), [2, 8, "backward"]);
    console.log(`PASS ${language} distinct simultaneous limits, dismissal and phone layout: ${await text()}`);

    notices = [{ id: "legacy:stop", source: "claude", level: "stop", title: "Limit reached", usedPercent: 100, resetsAt: short.resetsAt }];
    await refresh();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some((el) => el.textContent?.includes("Limit reached") && !el.textContent?.includes("Opus")));
    assert.match(await text(), /Limit reached/);
    assert.doesNotMatch(await text(), /5-hour limit|Límite de 5 horas/);
    console.log(`PASS ${language} new client with a legacy notice: ${await text()}`);

    const longName = "unknown_model<window>" + "x".repeat(140);
    const missing = { id: longName, minutes: null, used: 1, resetsAt: null };
    notices = windows(missing); await refresh();
    await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("unknown_model<window>"));
    assert.match(await text(), language === "en" ? /Reset time unknown/ : /Hora de restablecimiento desconocida/);
    assert.ok((await text()).includes(longName.slice(0, 80)));
    assert.ok(!(await text()).includes(longName.slice(0, 81)));
    assert.equal(await notice().locator("window").count(), 0, "untrusted label is text, not markup");
    const longBounds = await notice().evaluate((e) => ({ width: e.clientWidth, scroll: e.scrollWidth, right: e.getBoundingClientRect().right, bottom: e.getBoundingClientRect().bottom, viewport: innerWidth, height: innerHeight, page: document.documentElement.scrollWidth }));
    assert.ok(longBounds.scroll <= longBounds.width + 1 && longBounds.right <= longBounds.viewport && longBounds.bottom <= longBounds.height && longBounds.page <= longBounds.viewport, JSON.stringify(longBounds));
    console.log(`PASS ${language} unknown reset and reported window: ${await text()}`);

    notices = windows({ ...short, resetsAt: NOW + 2 * MINUTE }); await refresh();
    await page.clock.setSystemTime(NOW + MINUTE + 30_000);
    await refresh();
    await page.waitForFunction((phrase) => document.body.textContent?.includes(phrase), language === "en" ? "less than 1 min" : "menos de 1 min");
    assert.doesNotMatch(await text(), /0 min/);
    // Hold the ordinary refresh while the cached reading crosses its reset.
    holdNotices = true;
    await page.clock.setSystemTime(NOW + 2 * MINUTE);
    const heldRequest = new Promise((resolve) => { resolveHeld = resolve; });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await heldRequest;
    await page.waitForFunction((phrase) => document.body.textContent?.includes(phrase), language === "en" ? "status unknown" : "estado desconocido");
    assert.match(await text(), language === "en" ? /Last reported:.*Reset time passed; status unknown/ : /Último dato:.*Pasó la hora de restablecimiento; estado desconocido/);
    notices = planNotices("claude", { windows: [{ ...short, resetsAt: NOW + 2 * MINUTE }], plan: null, at: NOW }, NOW + 2 * MINUTE);
    assert.deepEqual(notices, [], "the unchanged server filter omits an expired reading");
    holdNotices = false;
    for (const res of heldNotices.splice(0)) if (!res.destroyed) json(res, { notices });
    await page.waitForFunction((name) => ![...document.querySelectorAll("button")].some((el) => el.textContent?.trim() === name), button);
    assert.ok(await area.isEnabled());
    assert.doesNotMatch(await page.locator("main").innerText(), /capacity restored|access restored|capacidad restablecida|acceso restablecido/i);
    assert.doesNotMatch((await page.locator('[role="alert"],[role="status"]').allTextContents()).join(" "), /restored|available|restablecido|disponible/i);
    console.log(`PASS ${language} under one minute and past cached reset; filtered refresh removed it without a restoration claim`);
    notices = windows(weekly); await refresh();
    await notice().waitFor();
    await notice().getByRole("button", { name: button }).focus(); await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: language === "en" ? "Limits" : "Límites", exact: true }).waitFor();
    assert.ok(requests.some((r) => r.path === "/api/usage/report" && new URLSearchParams(r.query).get("bot") === "helper"));
    console.log(`PASS ${language} keyboard View usage opens Limits`);
    await context.close();
  }
  assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
  const denied = requests.filter((r) => r.method !== "GET");
  // ChatView's normal viewing heartbeat is denied by this read-only fixture.
  // Anything else remains a failure, and no write is accepted by the server.
  assert.ok(denied.every((r) => r.method === "POST" && r.path === "/api/viewing"), JSON.stringify(denied));
  console.log(`PASS no external requests, accepted writes or renderer errors; denied viewing reports: ${denied.length}`);
} finally {
  await browser?.close();
  if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  rmSync(tmp, { recursive: true, force: true });
}
