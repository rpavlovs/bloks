// Restarting into an update, so that it ends in a restart.
//
// "Relaunch to update" starts a chain: one more look for a newer release,
// a wait for running turns, then a quit that hands over to the installer.
// Every link used to be trusted to finish. One that never does (a
// download that stalls, a window that will not close, a helper that
// never answers the quit) leaves Bloks running on the old version with
// the update still waiting and the same button on the card, and nothing
// anywhere said which link it was (GitHub 267). On macOS the installer
// only swaps the app once the running one has gone, so an app that does
// not exit is an update that never installs.
//
// So each link has a time limit, and one that fails or runs out of time
// does not stop the next. Once the person can no longer call it off the
// process ends: by the orderly quit when that works, by closing what is
// still open when it does not, and by a plain exit after that. Each step
// is written to the updater's log. And a note is left on disk before the
// quit, naming the version being left, so a start that finds itself
// still on that version can say the update did not install, once,
// instead of offering the same button as if nothing had happened.
//
// Kept apart from main.mjs so the order and the limits can be tested
// without Electron.
import fs from "node:fs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long each step gets, in ms. */
export const RESTART_LIMITS = {
  /** The look has limits of its own: twenty seconds for an answer, and a
   * newer release is waited for while it keeps arriving
   * (electron/update-check.mjs). This is for a look that outlives both. */
  look: 30 * 60_000,
  /** The drain ends at its deadline, twenty minutes unless asked
   * otherwise (server/drain.ts). This is for a wait that outlives it. */
  drain: 25 * 60_000,
  mark: 2_000,
  /** The native installer unpacking and checking what it was handed. */
  staged: 60_000,
  quit: 5_000,
  /** From the quit until a window that is still open is closed for it:
   * the windows closing, the installer being told, and the server and
   * the computer use helper stopping, which is seconds when it works. */
  orderly: 10_000,
  /** From there until the process is ended outright. */
  forced: 10_000,
  teardown: 5_000,
};

/** Runs `work` and says how it went within `ms`: done with its value,
 * failed with its error, or late when it had not finished in time. Never
 * rejects. Work that is late is left running, only not waited for. */
export async function within(work, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "late" }), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .then(
          (value) => ({ outcome: "done", value }),
          (error) => ({ outcome: "failed", error }),
        ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error as one short line for the log. */
function words(error) {
  return String(error?.message ?? error)
    .split("\n")[0]
    .slice(0, 200);
}

const seconds = (ms) => `${Math.round(ms / 1000)}s`;

/**
 * The restart, start to finish. `steps` are the main process's own:
 *
 *   look()          one more look for a newer release
 *   drain()         waits for running turns; "cancel" calls the restart off
 *   mark()          leaves the note of the version being left
 *   staged()        waits for the native installer to have the update
 *   quit()          the orderly quit that hands over to the installer
 *   closeWindows()  closes whatever is still open, and answers how many
 *   teardown()      stops the server, for an exit that skips the quit
 *   exit()          ends the process
 *
 * Answers "cancelled" when the drain was called off. Otherwise the quit
 * ends the process and nothing is answered; the rest runs only in a
 * process that is still there, and ends in exit().
 */
export async function restartIntoUpdate(steps, { limits = {}, log = () => {}, wait = pause, from, to } = {}) {
  const limit = { ...RESTART_LIMITS, ...limits };
  /** The line for a step that did not go well, or null for one that did. */
  const trouble = (name, went, ms) =>
    went.outcome === "failed"
      ? `restart: ${name} failed: ${words(went.error)}`
      : went.outcome === "late"
        ? `restart: ${name} was not done after ${seconds(ms)}, going on without it`
        : null;
  // one line in the log for each step, however it went
  const step = async (name, work, ms, said = (value) => (typeof value === "string" ? value : "done")) => {
    const went = await within(work, ms);
    log(trouble(name, went, ms) ?? `restart: ${name}: ${said(went.value)}`);
    return went;
  };

  log(`restart: asked${from ? `, on ${from}` : ""}${to ? `, to install ${to}` : ""}`);
  await step("the look for a newer release", steps.look, limit.look);
  const drained = await step("the wait for running turns", steps.drain, limit.drain);
  if (drained.outcome === "done" && drained.value === "cancel") {
    log("restart: called off");
    return "cancelled";
  }

  // From here nobody can call it off, so from here the process ends.
  await step("the note of the version being left", steps.mark, limit.mark);
  await step("the wait for the installer to have the update", steps.staged, limit.staged);
  // said before it is asked for: a quit that works leaves no time to say so
  log("restart: quitting to install");
  const quit = await within(steps.quit, limit.quit);
  const wrong = trouble("the quit", quit, limit.quit);
  if (wrong) log(wrong);

  // Still here, so the quit has not gone through. The installer is told
  // only once every window has closed, and one that would not close is
  // the usual reason it never was.
  await wait(limit.orderly);
  await step(
    `still running after ${seconds(limit.orderly)}, closing the windows left open`,
    steps.closeWindows,
    limit.quit,
    (open) => `${open ?? 0} had stayed open`,
  );

  await wait(limit.forced);
  await step(`still running after another ${seconds(limit.forced)}, stopping the server`, steps.teardown, limit.teardown);
  log("restart: forced exit");
  try {
    steps.exit();
  } catch (error) {
    log(`restart: the exit failed: ${words(error)}`);
  }
  return "exited";
}

/** Leaves the note before the quit: the version being left, and the one
 * meant to replace it when that is known. */
export function markInstall(file, { from, to }) {
  fs.writeFileSync(file, JSON.stringify({ from, to: to ?? null, at: Date.now() }));
}

/** Reads the note at start and removes it, whatever it says, so an update
 * that did not install is said once. Answers the version this still is
 * and the one it was meant to become, or null: no note, one that cannot
 * be read, or a version that has changed since, which is the update
 * having installed. */
export function takeInstallMark(file, current) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // said again at the next start, at worst
  }
  try {
    const mark = JSON.parse(raw);
    if (typeof mark?.from !== "string" || mark.from !== current) return null;
    return { from: mark.from, to: typeof mark.to === "string" ? mark.to : null };
  } catch {
    return null;
  }
}
