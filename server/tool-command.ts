// Display detail is sanitized before the event log, store or subscribers.
// Keep source offsets while reading shell words, and read any wholly
// quoted word as a shell script of its own (a Codex POSIX shell's -lc
// argument, or one behind sudo, env, nice or timeout), so a credential is
// found however deep the quoting goes. Replace only the credential spans.
const COMMAND_LIMIT = 2000;
/** How many quoting layers are read through. Each one is a fresh scan. */
const MAX_DEPTH = 4;
/** A credential word anywhere in a name: GITHUB_TOKEN, --password. */
const SECRET_NAME = /token|password|passwd|secret|credential|api[_-]?key|private[_-]?key|access[_-]?key/i;
/** Short words that count only as a whole part of a name (STRIPE_KEY,
 * MYSQL_PWD, AUTH), so author, keyboard and monkey stay as they are. */
const SECRET_PART = /^(?:key|pwd|passwd|auth)$/;
/** A part that says the name holds where or what kind a secret is. */
const NOT_A_VALUE = /^(?:path|file|dir|name|id|type|method|mode|url|uri|host|server|provider|scheme|size|bits|length|len|format|ring|store|stdin)$/;
/** Commands whose -u carries user:password. */
const USER_PASS = /^(?:curl)$/;
/** Commands whose -pVALUE is the password itself. */
const MYSQL = /^(?:mysql|mariadb|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck)$/;
/** Commands whose `login -p VALUE` is a registry password. */
const REGISTRY = /^(?:docker|podman|nerdctl|buildah|skopeo|helm|oras)$/;
/** Words run before a command without being it. */
const PREFIX = /^(?:sudo|env|nice|timeout|nohup|time|command|exec|doas|stdbuf|ionice)$/;
/** Their options that take a value of their own. */
const PREFIX_ARG = /^(?:-u|-g|-n|-C|-s|-k|-p|-c|-D|-h|-U|--user|--group|--signal|--kill-after|--adjustment|--chdir)$/;
/** Flags that read a credential piped in from the command before. */
const FROM_STDIN = /^--(?:with-token|password-stdin|token-stdin)$/;

/** Whether a shell name, flag or key holds a credential. */
export function secretName(name: string): boolean {
  const bare = name.replace(/^[^A-Za-z0-9]+/, "");
  const parts = bare.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.at(-1) === "stdin" || FROM_STDIN.test(name)) return false;
  if (SECRET_NAME.test(bare)) return true;
  if (parts[0] === "no" || parts.some((part) => NOT_A_VALUE.test(part))) return false;
  return parts.some((part) => SECRET_PART.test(part));
}

interface Word {
  text: string;
  /** Where the word sits in the text it was read from. */
  start: number;
  end: number;
  /** For each character of `text`, its span in the whole command. */
  from: number[];
  to: number[];
  quoted: boolean;
  wholeQuoted: boolean;
}

/** A display-only shell reader, not an interpreter. Nothing is executed.
 * Read from inside `within`, each character maps back through it. */
function words(text: string, within?: Word): Word[] {
  const result: Word[] = [];
  let i = 0;
  while (i < text.length) {
    if (/[\s;&|<>]/.test(text[i])) { i++; continue; }
    const start = i;
    const chars: string[] = [], from: number[] = [], to: number[] = [];
    let quote = "", quoted = false;
    // $'...' is quoted too: an ANSI-C string, which Codex may send
    const wholeQuoted = text[i] === "'" || text[i] === '"' || (text[i] === "$" && text[i + 1] === "'");
    while (i < text.length) {
      const c = text[i];
      if (!quote && /[\s;&|<>]/.test(c)) break;
      if ((!quote && (c === "'" || c === '"')) || c === quote) {
        quote = quote ? "" : c;
        quoted = true;
        i++;
        continue;
      }
      const begin = i;
      if (c === "\\" && quote !== "'" && i + 1 < text.length &&
          (!quote || /[$\x60"\\\n]/.test(text[i + 1]))) {
        i++;
        if (text[i] === "\n") { i++; continue; }
      }
      chars.push(text[i]);
      from.push(within ? within.from[begin] : begin);
      to.push(within ? within.to[i] : i + 1);
      i++;
    }
    result.push({ text: chars.join(""), start, end: i, from, to, quoted, wholeQuoted });
  }
  return result;
}

/** End of a JSON/string value embedded inside a shell word. */
function valueEnd(text: string, start: number): [number, number] {
  const quote = text[start];
  if (quote !== "'" && quote !== '"') return [start, text.length];
  let end = start + 1;
  while (end < text.length) {
    if (text[end] === "\\") { end += 2; continue; }
    if (text[end] === quote) break;
    end++;
  }
  return [start + 1, Math.min(end, text.length)];
}

/** The command a simple command's words run, past its prefixes. Looked
 * for among the first few words only, which bounds a long run of them. */
function commandName(list: Word[]): string {
  for (let i = 0; i < Math.min(list.length, 16); i++) {
    const text = list[i].text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) || /^\d/.test(text)) continue;
    const base = text.slice(text.lastIndexOf("/") + 1);
    if (PREFIX.test(base)) continue;
    if (text.startsWith("-")) { if (PREFIX_ARG.test(text)) i++; continue; }
    return base;
  }
  return "";
}

function maskCredentials(text: string): string {
  // Difference marks merge overlapping masks in linear time, even for
  // a large command with thousands of adjacent credential-shaped values.
  const marks = new Int32Array(text.length + 1);
  function mask(word: Word, start = 0, end = word.text.length) {
    if (start >= end) return;
    marks[word.from[start]]++;
    marks[word.to[end - 1]]--;
  }
  function collect(input: string, list: Word[], depth: number) {
    let headerPending = false, valuePending = false, userPending = false, keyPending = false, previous = 0;
    // the simple command this word belongs to, and the one piped into it
    let command: Word[] = [], piped: Word[] = [], pipedIn = false;
    // kept as the command grows, so a long one is not rescanned per word
    let setting = false, login = false;
    for (const word of list) {
      const gap = input.slice(previous, word.start);
      if (/[\r\n;&|]/.test(gap)) {
        pipedIn = /^[^|]*\|[^|]*$/.test(gap.replace(/\s/g, "")) && !/[;&\r\n]/.test(gap);
        piped = command;
        command = [];
        setting = login = false;
      }
      if (headerPending && (/[\r\n;&|<>]/.test(gap) || word.text.startsWith("-"))) headerPending = false;
      if (headerPending || valuePending) {
        mask(word);
        valuePending = false;
        if (word.wholeQuoted) headerPending = false;
      }
      if (keyPending) {
        // the value after a `key:` that ended the last word, up to where a
        // JSON or YAML value ends
        let end = 0;
        while (end < word.text.length && !/[,;)}\]]/.test(word.text[end])) end++;
        mask(word, 0, end);
        keyPending = false;
      }
      if (userPending) {
        const colon = word.text.indexOf(":");
        if (colon >= 0) mask(word, colon + 1);
        userPending = false;
      }
      previous = word.end;
      const name = commandName(command);
      command.push(word);
      if (word.text === "set" || word.text === "config") setting = true;
      if (word.text === "login") login = true;
      // A wholly quoted word with words of its own is a script: it is read
      // as one below, and only its quoted values are taken from out here,
      // so a header in it does not hide the rest of the script.
      // A header's own value ("Authorization: Digest ...") is a value, not
      // a script, and is hidden whole from out here as it always was.
      const header = /^[\w-]*(?:authorization|x-api-key|x-auth-token|private-token|cookie)["']?\s*[:=]/i.test(word.text);
      const inner = word.wholeQuoted && !header && depth < MAX_DEPTH ? words(word.text, word) : [];
      const script = inner.length > 1;

      const assignment = /^([A-Za-z_][A-Za-z0-9_]*|--[A-Za-z0-9_-]+)=/.exec(word.text);
      if (!script && assignment && secretName(assignment[1])) mask(word, assignment[0].length);
      if (/^--[A-Za-z0-9_-]+$/.test(word.text) && secretName(word.text)) valuePending = true;

      // curl -u user:password, --user user:password, -uuser:password
      if (USER_PASS.test(name)) {
        if (word.text === "-u" || word.text === "--user") userPending = true;
        const joined = /^(?:-u|--user=)([^:]*:)/.exec(word.text);
        if (joined) mask(word, joined[0].length);
      }
      // mysql -pPASSWORD, where a bare -p asks for it instead
      if (MYSQL.test(name) && /^-p./.test(word.text)) mask(word, 2);
      // docker login -p PASSWORD
      if (REGISTRY.test(name) && word.text === "-p" && login) valuePending = true;
      // aws configure set aws_secret_access_key VALUE, npm config set
      // //host/:_authToken VALUE, git config user.password VALUE
      if (setting && command.length > 2 && !word.text.startsWith("-") && !word.text.includes("=") &&
          secretName(word.text.split(/[:/.]/).pop() ?? "")) valuePending = true;
      // echo VALUE | gh auth login --with-token
      if (FROM_STDIN.test(word.text) && pipedIn && /^(?:echo|printf)$/.test(commandName(piped))) {
        for (const said of piped.slice(1)) if (!said.text.startsWith("-")) mask(said);
      }

      // Header names also cover prefixes such as Proxy-Authorization. In
      // a script they are left to the reading of the script below, where
      // the words and quotes are the ones the shell will see.
      const headers = /(?:authorization|x-api-key|x-auth-token|private-token|cookie)["']?\s*[:=]\s*/gi;
      for (const hit of script ? [] : word.text.matchAll(headers)) {
        const start = hit.index! + hit[0].length;
        const [a, b] = valueEnd(word.text, start);
        mask(word, a, b);
        if (!word.quoted || start === word.text.length) headerPending = true;
      }
      const bearers = /\bbearer(?:\s+|$)/gi;
      for (const hit of script ? [] : word.text.matchAll(bearers)) {
        const start = hit.index! + hit[0].length;
        const [a, b] = valueEnd(word.text, start);
        mask(word, a, b);
        if (start === word.text.length) valuePending = true;
      }

      // A secret name given a value anywhere inside a word: an assignment
      // in a quoted script, a JSON or YAML key, a URL query parameter.
      // A colon counts only where a key ends (quoted, or followed by a
      // space or a quote), so redis key:1 and host:port stay.
      const named = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.-]*)(["'\]]*)\s*([=:])\s*/g;
      for (const hit of word.text.matchAll(named)) {
        if (!secretName(hit[1])) continue;
        const after = hit.index! + hit[0].length;
        const next = word.text[after] ?? "";
        if (hit[3] === ":" && !hit[2] && !/\s$/.test(hit[0]) && next !== '"' && next !== "'" && next !== "") continue;
        if (after >= word.text.length) {
          if (hit[3] === ":") keyPending = true;
          continue;
        }
        if (next === '"' || next === "'") {
          const [a, b] = valueEnd(word.text, after);
          mask(word, a, b);
          continue;
        }
        let end = after;
        while (end < word.text.length && !/[\s,;&|)}\]"'<>#]/.test(word.text[end])) end++;
        mask(word, after, end);
      }

      // Scan an authority once, and keep its last @. A password may
      // itself contain an unescaped @; a bare user has no password.
      let cursor = 0;
      for (;;) {
        const colon = word.text.indexOf("://", cursor);
        if (colon < 0) break;
        let scheme = colon - 1;
        while (scheme >= 0 && /[a-z0-9+.-]/i.test(word.text[scheme])) scheme--;
        if (!/^[a-z]/i.test(word.text.slice(scheme + 1, colon))) { cursor = colon + 3; continue; }
        const begin = colon + 3;
        let end = begin;
        while (end < word.text.length && !/[\s/?#"'<>]/.test(word.text[end])) end++;
        const authority = word.text.slice(begin, end);
        const at = authority.lastIndexOf("@"), password = authority.indexOf(":");
        if (password >= 0 && password < at) mask(word, begin + password + 1, begin + at);
        cursor = Math.max(end, begin);
      }

      if (script) collect(word.text, inner, depth + 1);
    }
  }
  collect(text, words(text), 0);
  // Masked spans, with ones only a space apart shown as one: a header's
  // scheme and value read as a single [redacted], as they always have.
  const spans: Array<[number, number]> = [];
  let depth = 0, open = 0;
  for (let i = 0; i <= text.length; i++) {
    const next = depth + marks[i];
    if (!depth && next) open = i;
    if (depth && !next) {
      const last = spans.at(-1);
      if (last && /^[ \t]*$/.test(text.slice(last[1], open))) last[1] = i;
      else spans.push([open, i]);
    }
    depth = next;
  }
  const chunks: string[] = [];
  let start = 0;
  for (const [a, b] of spans) { chunks.push(text.slice(start, a), "[redacted]"); start = b; }
  chunks.push(text.slice(start));
  return chunks.join("");
}

export function toolCommand(value: unknown, redact: (text: string) => string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  // Redact before cutting: a partial credential may evade its pattern.
  const text = maskCredentials(redact(value));
  if (text.length <= COMMAND_LIMIT) return text;
  let head = text.slice(0, COMMAND_LIMIT - 1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + "…";
}

/** Preserve the input used by existing server consumers of a tool title. */
export function legacyToolTitle(event: { provider: string; title?: string; command?: string }): string {
  return event.provider === "codex" && event.command ? event.command.slice(0, 80) : event.title ?? "tool";
}
