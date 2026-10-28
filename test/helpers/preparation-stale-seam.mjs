// Test-only adapter double. It changes only the adapter used by the real
// preparation drain, so the real admission, store and settlement stay in use.
import { registerHooks } from "node:module";

const directory = process.env.BLOKS_PREPARATION_SEAM;
if (directory) registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith("/server/index.ts")) return result;
    const source = Buffer.from(result.source).toString("utf8");
    const needle = "const adapter = laneInstance(bot, lane.id)?.adapter;\n      if (!lane.busy || !adapter?.steerPrepared)";
    if (source.split(needle).length !== 2) throw new Error("preparation adapter seam is not unique");
    const imageCapability = "claim.preparation.imageBytes = engine.adapter.capabilities.images === true;";
    if (source.split(imageCapability).length !== 2) throw new Error("preparation image capability seam is not unique");
    const replacement = "const adapter = __preparationFixtureAdapter(laneInstance(bot, lane.id)?.adapter, attempt, id);\n      if (!lane.busy || !adapter?.steerPrepared)";
    // This test double advertises byte images so the real dispatch code
    // makes a nonzero reservation, which the stale result must not alter.
    return { ...result, source: source.replace(needle, replacement).replace(imageCapability, "claim.preparation.imageBytes = true;") + `

// Injected only into the synthetic server, never into the shipped module.
const __preparationFixture = { old: null, current: null };
function __preparationFixtureAdapter(adapter, attempt, rowId) {
  if (!adapter?.steerPrepared) return adapter;
  return { ...adapter, steerPrepared: async (lane, turnId, words, options) => {
    const which = words.includes("OLD_SEAM_ROW") ? "old" : words.includes("CURRENT_SEAM_ROW") ? "current" : null;
    if (!which) return adapter.steerPrepared(lane, turnId, words, options);
    options.onDispatch();
    __preparationFixture[which] = { attempt, rowId, turnId, words, late: options.onAcceptedLate };
    writeFileSync(join(${JSON.stringify(directory)}, which + ".json"), JSON.stringify({ attempt: attempt.id, rowId, turnId, words, imageCount: attempt.imageCount }));
    if (which === "old") return "uncertain";
    await new Promise((resolve) => {
      const timer = setInterval(() => { if (existsSync(join(${JSON.stringify(directory)}, "release-current"))) { clearInterval(timer); resolve(); } }, 10);
    });
    return "accepted";
  } };
}
const __preparationFixtureTimer = setInterval(() => {
  const trigger = join(${JSON.stringify(directory)}, "trigger-old");
  const done = join(${JSON.stringify(directory)}, "triggered-old");
  if (!existsSync(trigger) || existsSync(done) || !__preparationFixture.old || !__preparationFixture.current) return;
  const outcome = readFileSync(trigger, "utf8").trim();
  const old = __preparationFixture.old, current = __preparationFixture.current;
  if (${JSON.stringify(process.env.BLOKS_PREPARATION_NEGATIVE === "1")}) {
    // Negative control: wrongly deliver the old result to the new row.
    settlePreparationInput(current.attempt, [current.rowId], "accepted");
  } else if (outcome === "accepted") old.late();
  else settlePreparationInput(old.attempt, [old.rowId], outcome);
  writeFileSync(done, JSON.stringify({ attempt: current.attempt.id, rowId: current.rowId, turnId: current.turnId, words: current.words, imageCount: current.attempt.imageCount }));
}, 10);
__preparationFixtureTimer.unref?.();
` };
  },
});
