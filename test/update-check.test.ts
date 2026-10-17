// An update that downloaded days ago is not the last word (GitHub 247):
// the app looks past it every few hours and once more on restart, and
// those looks never take the restart off the card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { mayLookAgain, newestBeforeInstall, updateFrame, type UpdateState } from "../electron/update-check.mjs";

const waiting: UpdateState = { state: "ready", version: "2.5.35" };

test("a look past a waiting update keeps the restart on the card until it finds a newer release", () => {
  assert.equal(updateFrame(waiting, "checking"), null);
  assert.equal(updateFrame(waiting, "available", { version: "2.5.35" }), null, "the same release from the cache is not news");
  assert.equal(updateFrame(waiting, "not-available"), null);
  assert.equal(updateFrame(waiting, "error", { reason: "offline" }), null, "an offline look took away an update that is ready");
  assert.deepEqual(updateFrame(waiting, "available", { version: "2.6.0" }), { state: "downloading", version: "2.6.0" });
  assert.deepEqual(updateFrame({ state: "downloading", version: "2.6.0" }, "progress", { percent: 40 }), {
    state: "downloading",
    version: "2.6.0",
    percent: 40,
  });
  assert.deepEqual(updateFrame({ state: "downloading", version: "2.6.0" }, "downloaded", { version: "2.6.0" }), {
    state: "ready",
    version: "2.6.0",
  });
});

test("with nothing waiting, every event says what it always said", () => {
  const idle: UpdateState = { state: "current" };
  assert.deepEqual(updateFrame(idle, "checking"), { state: "checking" });
  assert.deepEqual(updateFrame(idle, "not-available"), { state: "current" });
  assert.deepEqual(updateFrame(idle, "error", { reason: "offline" }), { state: "error", reason: "offline" });
});

test("the look every few hours goes past a waiting update, never over a running one", () => {
  assert.equal(mayLookAgain(waiting), true);
  assert.equal(mayLookAgain({ state: "current" }), true);
  assert.equal(mayLookAgain({ state: "error" }), true);
  assert.equal(mayLookAgain({ state: "checking" }), false);
  assert.equal(mayLookAgain({ state: "downloading" }), false);
});

/** A stand-in for electron-updater: what a look finds, how the download
 * of it goes, and what was asked of it. */
function updater(found: string | null, download: () => Promise<unknown> = async () => {}) {
  const asked = { downloads: 0, cancelled: 0, lookedWithDownloadsOn: null as boolean | null };
  const u = Object.assign(new EventEmitter(), {
    autoDownload: true,
    asked,
    checkForUpdates: async () => {
      asked.lookedWithDownloadsOn = u.autoDownload;
      if (!found) return { isUpdateAvailable: false, updateInfo: { version: "2.5.34" } };
      return {
        isUpdateAvailable: true,
        updateInfo: { version: found },
        cancellationToken: { cancel: () => void asked.cancelled++ },
      };
    },
    downloadUpdate: () => {
      asked.downloads++;
      return download();
    },
  });
  return u;
}

test("a restart waits for a newer release to download first", async () => {
  let downloaded = false;
  const u = updater("2.6.0", () => new Promise<void>((resolve) => setTimeout(() => {
    downloaded = true;
    resolve();
  }, 20)));
  assert.equal(await newestBeforeInstall(u, { waiting: "2.5.35" }), "2.6.0 downloaded");
  assert.ok(downloaded, "the restart went ahead before the newer release had downloaded");
  assert.equal(u.autoDownload, true, "the updater was left not downloading on its own");
});

test("the release already waiting is looked at and not fetched again before a restart", async () => {
  // fetched again, macOS hands it to the native installer again, and the
  // restart begins while that is unpacking it (GitHub 267)
  const u = updater("2.5.35");
  assert.equal(await newestBeforeInstall(u, { waiting: "2.5.35" }), "nothing newer");
  assert.equal(u.asked.downloads, 0, "the release already waiting was fetched again");
  assert.equal(u.asked.lookedWithDownloadsOn, false, "the look was left free to download what it found");
  assert.equal(u.autoDownload, true);
  const none = updater(null);
  assert.equal(await newestBeforeInstall(none, { waiting: "2.5.35" }), "nothing newer");
  assert.equal(none.asked.downloads, 0);
});

test("a restart is not held by a look that fails or never answers", async () => {
  const offline = Object.assign(updater(null), { checkForUpdates: () => Promise.reject(new Error("offline")) });
  assert.equal(await newestBeforeInstall(offline, { waiting: "2.5.35" }), "the look failed");
  assert.equal(offline.autoDownload, true);
  assert.equal(
    await newestBeforeInstall(updater("2.6.0", () => Promise.reject(new Error("download failed"))), { waiting: "2.5.35" }),
    "2.6.0 failed to download",
  );
  assert.equal(await newestBeforeInstall(Object.assign(updater(null), { checkForUpdates: async () => null })), "nothing newer");
  const started = Date.now();
  const silent = Object.assign(updater(null), { checkForUpdates: () => new Promise<null>(() => {}) });
  assert.equal(await newestBeforeInstall(silent, { within: 50 }), "no answer in time");
  assert.ok(Date.now() - started < 2_000, "a look that never answered held the restart");
});

test("a look that answers late does not start a download behind the restart", async () => {
  const u = updater("2.6.0");
  const answer = u.checkForUpdates;
  let answered = false;
  u.checkForUpdates = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    answered = true;
    return answer();
  };
  assert.equal(await newestBeforeInstall(u, { within: 10, waiting: "2.5.35" }), "no answer in time");
  assert.equal(u.autoDownload, false, "downloads were back on while the look was still out");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(answered);
  assert.equal(u.asked.lookedWithDownloadsOn, false);
  assert.equal(u.asked.downloads, 0);
  assert.equal(u.autoDownload, true, "the updater was left not downloading on its own");
});

test("a newer release is waited for while it keeps arriving, and given up on when it stops", async () => {
  // still arriving after longer than the quiet it is allowed
  const slow = updater("2.6.0", () => new Promise<void>((resolve) => {
    const tick = setInterval(() => slow.emit("download-progress"), 10);
    setTimeout(() => {
      clearInterval(tick);
      resolve();
    }, 150);
  }));
  assert.equal(await newestBeforeInstall(slow, { quiet: 60, waiting: "2.5.35" }), "2.6.0 downloaded");
  assert.equal(slow.asked.cancelled, 0);
  assert.equal(slow.listenerCount("download-progress"), 0);

  // stalled: nothing else ends it, and the restart was waiting on it
  const stalled = updater("2.6.0", () => new Promise(() => {}));
  const started = Date.now();
  assert.equal(await newestBeforeInstall(stalled, { quiet: 40, waiting: "2.5.35" }), "2.6.0 stopped arriving");
  assert.ok(Date.now() - started < 2_000, "a download that stalled held the restart");
  assert.equal(stalled.asked.cancelled, 1, "the stalled download was left running behind the restart");
  assert.equal(stalled.listenerCount("download-progress"), 0);
});
