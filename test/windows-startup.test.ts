// Two ways the packaged app failed to start, found in #82, kept from
// coming back.
//
// On Windows an app opened from a shortcut has no console. A child
// process forked with one stdio slot inherited next to one piped gets
// the inherited slot filled with a NULL handle, and Chromium's launch
// check kills the app before its window exists. And the compiled server
// is ES modules in plain .js files, so without its own package.json a
// "type": "commonjs" one above the install folder stops it loading.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("no process is forked with an inherited stdio slot next to a piped one", () => {
  for (const file of ["electron/main.mjs", "electron/speech.mjs", "electron/cua.mjs"]) {
    for (const [array] of read(file).matchAll(/stdio:\s*\[[^\]]*\]/g)) {
      const mixed = array.includes('"inherit"') && array.includes('"pipe"');
      assert.equal(mixed, false, `${file}: ${array} crashes a Windows app opened without a console`);
    }
  }
});

test("the server build marks the compiled server as ES modules", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  assert.match(scripts["build:server"], /mark-server-esm\.mjs/);
  assert.match(read("scripts/mark-server-esm.mjs"), /type: "module"/);
});
