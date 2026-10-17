import { carryOnText } from "../server/cut-off.ts";
import { commandForms, shellWrappers } from "./helpers/command-fixtures.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolCommand, legacyToolTitle } from "../server/tool-command.ts";

const keep = (text: string) => text;

test("command detail preserves multiline text, but rejects empty or malformed input", () => {
  for (const value of [undefined, null, 1, {}, [], "", " \n\t"]) assert.equal(toolCommand(value, keep), undefined);
  const command = "printf 'hello'\nprintf 'world'";
  assert.equal(toolCommand(command, keep), command);
  assert.equal(toolCommand("ls", keep), "ls");
});

test("commands hide Authorization headers and standalone Bearer values", () => {
  for (const command of [
    "curl -H 'Authorization: Bearer fixture_token' https://example.invalid",
    'curl --header="AUTHORIZATION: Basic fixture_token" https://example.invalid',
    'curl -H Authorization:"Bearer fixture_token" https://example.invalid',
    "AUTHORIZATION='Custom fixture_token with spaces' curl https://example.invalid",
    'http --headers \'{"Authorization": "Bearer fixture_token"}\'',
    "curl -H Authorization:Bearer fixture_token https://example.invalid",
    "curl -H Authorization: Custom fixture_token https://example.invalid",
    "tool --token Bearer fixture_token",
    "tool --token bEaReR 'fixture_token with spaces'",
    'curl -H "Authorization: Digest username=\\"demo\\", response=\\"fixture_token\\"" https://example.invalid',
    'tool Bearer "fixture_token with \\"escaped quotes\\""',
    'tool Bearer "fixture_token with an unfinished quote',
    'curl -H "Authorization: Custom fixture_token with an unfinished quote',
    "curl -H 'Authorization: Basic fixture_token with an unfinished quote",
  ]) {
    for (const input of commandForms(command)) {
      const shown = toolCommand(input, keep)!;
      assert.ok(!shown.includes("fixture_token"), shown);
      assert.match(shown, /\[redacted\]/);
    }
  }
  const both = toolCommand("curl -H 'Authorization: Basic first_token' -H 'Other: Bearer second_token'", keep)!;
  assert.ok(!both.includes("first_token") && !both.includes("second_token"));
});

test("a URL keeps its scheme, user and host, but no password", () => {
  for (const [input, expected] of [
    ["curl https://demo:fixture_password@example.invalid/path", "curl https://demo:[redacted]@example.invalid/path"],
    ["curl https://demo:pw:more%40encoded@example.invalid", "curl https://demo:[redacted]@example.invalid"],
    ["curl https://:fixture_password@example.invalid ftp://demo:second_password@example.invalid", "curl https://:[redacted]@example.invalid ftp://demo:[redacted]@example.invalid"],
    ["curl https://example.invalid/path", "curl https://example.invalid/path"],
  ]) {
    commandForms(input).forEach((command, i) => assert.equal(toolCommand(command, keep), commandForms(expected)[i]));
  }
});

test("redaction sees a whole credential crossing the display cut", () => {
  const secret = "stored_fixture_credential";
  commandForms("printf " + secret).forEach((command, i) => assert.equal(toolCommand(command, (text) => text.replaceAll(secret, "[redacted]")), commandForms("printf [redacted]")[i]));
  const before = "x".repeat(2000 - 11) + secret + " trailing";
  const shown = toolCommand(before, (text) => text.replaceAll(secret, "[redacted]"))!;
  assert.ok(!shown.includes("stored_fix"), "clipping before redaction left part of a stored credential");
  assert.match(shown, /\[redacted\]/);
  assert.ok(shown.length <= 2000);
});

test("the display bound is UTF-16, includes its ellipsis and never splits an emoji", () => {
  assert.equal(toolCommand("a".repeat(2000), keep), "a".repeat(2000));
  const shown = toolCommand("a".repeat(1998) + "😀" + "more", keep)!;
  assert.equal(shown, "a".repeat(1998) + "…");
  assert.ok(shown.length <= 2000);
  assert.equal(toolCommand("😀".repeat(2000), keep)!.length, 1999);
});

test("every credential shape is fully hidden in direct commands and POSIX shell wrappers", () => {
  const cases = [
    ["cd /fixture && GITHUB_TOKEN=fixture_token tool", ["fixture_token"]],
    ["export API_KEY=fixture_key; tool", ["fixture_key"]],
    ["cd /fixture && tool --password=fixture_password", ["fixture_password"]],
    ["cd /fixture && tool --token fixture_flag", ["fixture_flag"]],
    ['curl -H "Authorization:" "Basic fixture_split_value"', ["fixture_split_value"]],
    ['curl -H "Authorization": "Basic fixture_split_value"', ["fixture_split_value"]],
    ['curl -H "X-Api-Key": "fixture_split_value"', ["fixture_split_value"]],
    ["curl -H 'Cookie': 'session=fixture_split_value'", ["fixture_split_value"]],
    ["curl -H 'Proxy-aUtHoRiZaTiOn: Digest username=\"fixture_user\", response=\"fixture_response\"' https://example.invalid", ["fixture_user", "fixture_response"]],
    ['curl -H "Authorization: Digest username=\\"fixture_user\\", response=\\"fixture_response\\"" https://example.invalid', ["fixture_user", "fixture_response"]],
    ["curl Authorization=Digest username=fixture_user,response=fixture_response", ["fixture_user", "fixture_response"]],
    ["curl prefixAuthorization: Digest username=fixture_user, response=fixture_response", ["fixture_user", "fixture_response"]],
    ['http \'{"Authorization": "Digest fixture_response", "other": "keep"}\'', ["fixture_response"]],
    ['http \'{"value": "Bearer fixture_bearer"}\'', ["fixture_bearer"]],
    ["VALUE='Bearer fixture_bearer' tool", ["fixture_bearer"]],
    ["curl https://demo:fixture_pw@tail@host.invalid/path", ["fixture_pw", "tail"]],
    ["db redis://:fixture_pw@host.invalid postgres://demo:fixture%40pw@host.invalid mongodb+srv://demo:fixture_pw@host.invalid", ["fixture_pw", "fixture%40pw"]],
    ["GITHUB_TOKEN=fixture_token export API_KEY='fixture key' PGPASSWORD=fixture_pw tool --password='fixture pass' --token fixture_flag", ["fixture_token", "fixture key", "fixture_pw", "fixture pass", "fixture_flag"]],
    ["tool --api-key fixture_key --auth-token=fixture_flag --private-key='fixture private'", ["fixture_key", "fixture_flag", "fixture private"]],
    ["curl -H 'X-Api-Key: fixture_key' -H 'X-Auth-Token: fixture_auth' -H 'PRIVATE-TOKEN=fixture_private' -H 'Cookie: session=fixture_cookie; other=fixture_other'", ["fixture_key", "fixture_auth", "fixture_private", "fixture_cookie", "fixture_other"]],
    ["cat <<'EOF'\nAuthorization: Digest username=fixture_user, response=fixture_response\nX-Api-Key: fixture_key\nEOF", ["fixture_user", "fixture_response", "fixture_key"]],
  ] as const;
  for (const [command, values] of cases) {
    for (const input of commandForms(command)) {
      const shown = toolCommand(input, keep)!;
      for (const value of values) assert.ok(!shown.includes(value), "credential survived: " + value + " in " + shown);
      assert.match(shown, /\[redacted\]/);
      const wrapper = shellWrappers.find((prefix) => input.startsWith(prefix + " "));
      if (wrapper) assert.ok(shown.startsWith(wrapper + " "), "shell wrapper changed: " + shown);
    }
  }
  // a bare URL user may be a name, so it stays; sort -u is not curl's
  const shown = "sort -u data.txt; curl -u demo:fixture_pass --user demo:fixture_pass https://fixture_token@host.invalid/?access_token=fixture_query";
  assert.equal(toolCommand(shown, keep), "sort -u data.txt; curl -u demo:[redacted] --user demo:[redacted] https://fixture_token@host.invalid/?access_token=[redacted]");
});

test("credentials behind prefixes, short names, CLI conventions, JSON bodies and URLs are hidden", () => {
  const cases = [
    // shell wrappers past the first word, and with extra flags
    "bash -e -c 'curl --token fixture_v https://example.invalid'",
    "sudo sh -c 'export API_KEY=fixture_v; run'",
    "sudo -u root bash -lc 'tool --password fixture_v'",
    "env FOO=1 bash -lc 'tool --password fixture_v'",
    "nice -n 10 sh -c 'tool --token fixture_v'",
    "timeout 30 bash -e -o pipefail -c 'tool --api-key fixture_v'",
    "/bin/bash -lc $'curl --token fixture_v'",
    // short names as whole parts of a name
    "MYSQL_PWD=fixture_v mysql",
    "export AUTH=fixture_v",
    "heroku config:set STRIPE_KEY=fixture_v",
    "tool --key fixture_v",
    // assignments anywhere inside a quoted string
    "python -c \"import os; os.environ['API_TOKEN']='fixture_v'\"",
    "ssh host 'cd /srv && DB_PASSWORD=fixture_v ./run'",
    "printf 'token: fixture_v\\n' > example.yml",
    // command line conventions
    "mysql -uroot -pfixture_v",
    "mysqldump -h db -pfixture_v example",
    "docker login -u demo -p fixture_v registry.invalid",
    "docker login --password fixture_v registry.invalid",
    "aws configure set aws_secret_access_key fixture_v",
    "npm config set //registry.npmjs.org/:_authToken fixture_v",
    "npm config set //registry.npmjs.org/:_authToken=fixture_v",
    "git config user.password fixture_v",
    "echo fixture_v | gh auth login --with-token",
    // JSON bodies
    "curl -d '{\"password\":\"fixture_v\"}' https://example.invalid",
    "curl -d '{\"token\": \"fixture_v\", \"name\": \"keep\"}' https://example.invalid",
    "curl --data '{\"secret\":\"fixture_v\"}' https://example.invalid",
    "curl -d '{\"api_key\":\"fixture_v\"}' https://example.invalid",
    // user:password and query parameters
    "curl -u demo:fixture_v https://example.invalid",
    "curl -udemo:fixture_v https://example.invalid",
    "curl --user=demo:fixture_v https://example.invalid",
    "curl 'https://example.invalid/api?token=fixture_v'",
    "curl 'https://example.invalid/api?q=1&key=fixture_v#top'",
    "curl https://example.invalid/api?access_token=fixture_v",
  ];
  for (const command of cases) {
    for (const input of commandForms(command)) {
      const shown = toolCommand(input, keep)!;
      assert.ok(!shown.includes("fixture_v"), "credential survived in " + shown);
      assert.match(shown, /\[redacted\]/);
    }
  }
  // only the value goes: the shape of the command stays readable
  assert.equal(toolCommand("curl -d '{\"token\": \"fixture_v\", \"name\": \"keep\"}' https://example.invalid", keep),
    "curl -d '{\"token\": \"[redacted]\", \"name\": \"keep\"}' https://example.invalid");
  assert.equal(toolCommand("mysql -uroot -pfixture_v", keep), "mysql -uroot -p[redacted]");
  assert.equal(toolCommand("sudo sh -c 'export API_KEY=fixture_v; run'", keep), "sudo sh -c 'export API_KEY=[redacted]; run'");
});

test("ordinary words that only look like credential names stay as they are", () => {
  for (const command of [
    "git log --author fixture_name",
    "git log --author=fixture_name",
    "cat keyboard.txt",
    "export KEYBOARD=us",
    "tool --key-file ./example.pem --keyring example",
    "tool --no-auth example.txt",
    "AUTH_METHOD=basic tool",
    "redis-cli GET key:1",
    "curl http://example.invalid:8080/path",
    "mysql -p example_db",
    "docker run -p 8080:80 example",
    "sort -u data.txt",
    "set -e",
    "git config user.email example@example.invalid",
    "echo hello | gh auth status",
    "docker login --password-stdin -u demo registry.invalid",
  ]) {
    for (const input of commandForms(command)) assert.equal(toolCommand(input, keep), input, command);
  }
});

test("all masks see the complete input before the 2000-unit cut", () => {
  for (const tail of ["API_KEY=fixture_credential", "--token fixture_credential", "https://demo:fixture_credential@tail@host.invalid", "'Authorization: Digest fixture_credential with spaces'", "'X-Api-Key: fixture_credential'"]) {
    const input = "x".repeat(1980) + " " + tail;
    for (const command of commandForms(input)) {
      const shown = toolCommand(command, keep)!;
      assert.ok(!shown.includes("fixture_"), shown);
      assert.ok(shown.length <= 2000);
    }
  }
});

test("large repeated unfinished headers have a bounded processing time", () => {
  const input = "Authorization: ".repeat(Math.ceil(1024 * 1024 / 15));
  const began = performance.now();
  const shown = toolCommand(input, keep)!;
  assert.ok(performance.now() - began < 5000, "one MiB redaction exceeded five seconds");
  assert.ok(shown.length <= 2000);
});

test("legacy title consumers retain the sanitized Codex command and Claude Bash", () => {
  const safe = toolCommand('/bin/bash -lc "API_KEY=fixture_key printf ready"', keep)!;
  const codex = legacyToolTitle({ provider: "codex", title: "shell", command: safe });
  assert.equal(codex, safe.slice(0, 80));
  assert.match(codex, /\[redacted\]/);
  assert.ok(carryOnText("restart", { tool: codex }).includes("The step running when it stopped was: " + codex));
  assert.ok(carryOnText("restart", { tool: legacyToolTitle({ provider: "claudeAgent", title: "Bash", command: safe }) }).includes("The step running when it stopped was: Bash"));
  assert.equal(legacyToolTitle({ provider: "claudeAgent", title: "Bash", command: safe }), "Bash");
  assert.equal(legacyToolTitle({ provider: "codex", title: "browser" }), "browser");
  assert.equal(legacyToolTitle({ provider: "codex" }), "tool");
});
