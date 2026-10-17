// What the update card says, and one more look before an update installs.
//
// A downloaded update waits for the person to restart into it, sometimes
// for days, and another release can come out meanwhile. Installing the
// old one then means a second restart straight after the first, so the
// app keeps looking past it, and looks once more when the person asks to
// restart: a newer release downloads and is the one that installs, and
// the same release again comes straight from the cache, or before a
// restart is not fetched at all (GitHub 247).
// What those looks must not do is take the restart off the card while
// they run, or when one fails because the computer is offline.
// Kept apart from main.mjs so the rules can be tested without Electron.
import { within as inTime } from "./update-restart.mjs";

/** The state frame an updater event leaves, given the one before, or
 * null when the card should go on saying what it says. While an update
 * waits to be installed, a look, a look that finds nothing new or the
 * same version, and a look that fails all leave it waiting. */
export function updateFrame(current, event, detail = {}) {
  const waiting = current.state === "ready";
  switch (event) {
    case "checking":
      return waiting ? null : { state: "checking" };
    case "available":
      return waiting && detail.version === current.version ? null : { state: "downloading", version: detail.version };
    case "not-available":
      return waiting ? null : { state: "current" };
    case "progress":
      return waiting ? null : { state: "downloading", version: current.version, percent: detail.percent };
    case "downloaded":
      return { state: "ready", version: detail.version };
    case "error":
      return waiting ? null : { state: "error", reason: detail.reason };
    default:
      return null;
  }
}

/** Whether the look every few hours goes ahead: not while one is
 * already looking or downloading. One waiting to be installed is looked
 * past, since a release since then is the one to install. */
export function mayLookAgain(current) {
  return current.state !== "checking" && current.state !== "downloading";
}

/** One more look before a downloaded update installs, waiting for a
 * newer release to download when it finds one (the card shows the
 * download meanwhile). A look that has not answered within `within` ms
 * is not waited for, and a look or a download that fails leaves what
 * had already downloaded to install: the updater's error event has
 * logged why.
 *
 * It is a look and no more when it finds the release already `waiting`.
 * The updater would fetch that again from its cache, and on macOS every
 * fetch is handed to the native installer, which unpacks it afresh, and
 * a restart that begins meanwhile races that. So the updater's own
 * downloading is off for the look, and only a different release is
 * asked for. That one is waited for while it keeps arriving, and given
 * up on, and stopped, after `quiet` ms with nothing more of it: nothing
 * else ends a download that has stalled, and the restart would wait on
 * it for good (GitHub 267). Answers what it found, for the log. */
export async function newestBeforeInstall(updater, { within = 20_000, quiet = 60_000, waiting } = {}) {
  const downloads = updater.autoDownload;
  updater.autoDownload = false;
  const look = Promise.resolve().then(() => updater.checkForUpdates());
  // put back when the look ends, not when the wait for it does: an answer
  // that comes late must not start a download behind the restart
  const restore = () => {
    updater.autoDownload = downloads;
  };
  look.then(restore, restore);
  const looked = await inTime(() => look, within);
  if (looked.outcome === "late") return "no answer in time";
  if (looked.outcome === "failed") return "the look failed";
  const found = looked.value;
  const version = found?.updateInfo?.version;
  if (!found?.isUpdateAvailable || version === waiting) return "nothing newer";

  const newer = version ?? "a newer release";
  let timer;
  let giveUp;
  const stalled = new Promise((resolve) => {
    giveUp = () => resolve("stalled");
  });
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(giveUp, quiet);
  };
  updater.on?.("download-progress", heard);
  heard();
  try {
    const how = await Promise.race([
      Promise.resolve()
        .then(() => updater.downloadUpdate(found.cancellationToken))
        .then(() => "downloaded"),
      stalled,
    ]);
    if (how === "downloaded") return `${newer} downloaded`;
    found.cancellationToken?.cancel?.();
    return `${newer} stopped arriving`;
  } catch {
    return `${newer} failed to download`;
  } finally {
    clearTimeout(timer);
    updater.removeListener?.("download-progress", heard);
  }
}
