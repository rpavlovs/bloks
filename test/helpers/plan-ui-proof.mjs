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
    if (req.method !== "GET") return json(res, { error: "Fixture forbids writes" }, 403);
    if (url.pathname === "/api/bots") return json(res, { bots: [bot] });
    if (url.pathname === "/api/bloks") return json(res, { bloks: [] });
    if (url.pathname === "/api/config") return json(res, { setupDone: true });
    if (url.pathname === "/api/instances") return json(res, { instances: engines });
    if (url.pathname === "/api/providers") return json(res, { providers: [] });
    if (url.pathname === "/api/sidebar") return json(res, { sectionOrder: [], sectionOrderSaved: true });
    if (url.pathname === "/api/engines/updates") return json(res, { updates: {} });
    if (url.pathname === "/api/health") return json(res, { app: "bloks", version: "fixture", pid: 1 });
    if (url.pathname === "/api/usage-notices") return json(res, { notices });
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
    const notice = () => page.locator("[role=status],[role=alert]").filter({ has: page.getByRole("button", { name: button, exact: true }) });
    const refresh = async () => {
      const response = page.waitForResponse((r) => r.url().includes("/api/usage-notices?"));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await response;
    };
    const text = async () => (await notice().innerText()).replace(/\s+/g, " ");
    const expectedShort = language === "en" ? /5-hour limit: Limit reached.*100% used.*2 h 14 min/ : /Límite de 5 horas: Límite alcanzado.*100 % usado.*2 h 14 min/;
    await area.waitFor(); await notice().waitFor();
    assert.match(await text(), expectedShort);
    assert.equal(await notice().getAttribute("role"), "alert");
    assert.equal(await notice().getAttribute("aria-atomic"), "true");
    await area.fill("Synthetic draft"); await area.focus();
    await page.clock.fastForward(MINUTE);
    await page.waitForFunction((name) => [...document.querySelectorAll('[role="alert"]')].some((el) => el.textContent?.includes("2 h 13 min") && el.textContent?.includes(name)), button);
    assert.equal(await area.inputValue(), "Synthetic draft");
    assert.ok(await area.evaluate((e) => e === document.activeElement));
    console.log(`PASS ${language} short across midnight and automatic minute tick: ${await text()}`);

    notices = windows(short, weekly); await refresh();
    assert.match(await text(), language === "en" ? /5-hour limit/ : /Límite de 5 horas/);
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await notice().evaluate((e) => ({ width: e.clientWidth, scroll: e.scrollWidth, left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right, bottom: e.getBoundingClientRect().bottom, viewport: innerWidth, height: innerHeight, page: document.documentElement.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 1 && bounds.left >= 0 && bounds.right <= bounds.viewport && bounds.bottom <= bounds.height && bounds.page <= bounds.viewport, JSON.stringify(bounds));
    assert.ok(await notice().getByRole("button", { name: button }).isVisible());
    await notice().getByRole("button", { name: dismiss }).click();
    assert.ok(await area.evaluate((e) => e === document.activeElement));
    await page.waitForFunction((name) => [...document.querySelectorAll('[role="alert"]')].some((el) => el.textContent?.includes("Opus") && el.textContent?.includes(name)), button);
    assert.match(await text(), language === "en" ? /Weekly limit, Opus.*about 2 d 2 h/ : /Límite semanal, Opus.*aproximadamente 2 d 2 h/);
    console.log(`PASS ${language} distinct simultaneous limits, dismissal and phone layout: ${await text()}`);

    const missing = { id: "unknown_model", minutes: null, used: 1, resetsAt: null };
    notices = windows(missing); await refresh();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some((el) => el.textContent?.includes("unknown_model")));
    assert.match(await text(), language === "en" ? /Reset time unknown/ : /Hora de restablecimiento desconocida/);
    console.log(`PASS ${language} unknown reset and reported window: ${await text()}`);

    notices = windows({ ...short, resetsAt: NOW + 2 * MINUTE }); await refresh();
    await page.clock.setSystemTime(NOW + MINUTE + 30_000);
    await refresh();
    await page.waitForFunction((phrase) => document.body.textContent?.includes(phrase), language === "en" ? "less than 1 min" : "menos de 1 min");
    assert.doesNotMatch(await text(), /0 min/);
    await page.clock.setSystemTime(NOW + 2 * MINUTE);
    // This deliberately retained synthetic response represents a cached old reading.
    await refresh();
    await page.waitForFunction((phrase) => document.body.textContent?.includes(phrase), language === "en" ? "status unknown" : "estado desconocido");
    assert.match(await text(), language === "en" ? /Last reported:.*Reset time passed; status unknown/ : /Último dato:.*Pasó la hora de restablecimiento; estado desconocido/);
    console.log(`PASS ${language} under one minute and past cached reset: ${await text()}`);

    await notice().getByRole("button", { name: button }).focus(); await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: language === "en" ? "Limits" : "Límites", exact: true }).waitFor();
    assert.ok(requests.some((r) => r.path === "/api/usage/report" && new URLSearchParams(r.query).get("bot") === "helper"));
    console.log(`PASS ${language} keyboard View usage opens Limits`);
    await context.close();
  }
  assert.deepEqual(blocked, []); assert.deepEqual(errors, []); assert.ok(requests.every((r) => r.method === "GET"));
  console.log("PASS no external requests, write requests or renderer errors");
} finally {
  await browser?.close();
  if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  rmSync(tmp, { recursive: true, force: true });
}
