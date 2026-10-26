// The skill library.
//
// A skill is a reusable instruction set, when to use it, what it needs,
// the sequence of work, how to validate the result, and what needs
// approval. Skills live as markdown files in ~/.bloks/skills, one per
// file, with YAML-ish frontmatter for the name and description. Agents
// attach them by id, and an attached skill's body is composed into that
// agent's system prompt.
//
// Security note: an installed skill is literally text injected into every
// turn, it is the highest-trust content in the app. So installation is
// explicit and reviewable, bodies are size-capped, ids are slugs that can
// never escape the skills directory, and nothing is ever fetched and
// installed on the app's own initiative.
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { SKILLS_DIR } from "./config.ts";
import { closeHeld, openInside, readHeld } from "./open-inside.ts";

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** The instructions themselves, and what reaches the model. */
  body: string;
  /** builtin skills ship with the app and cannot be edited or deleted. */
  source: "builtin" | "user";
  /** Set when this came from the catalog: which entry, which version, and
   * the hash of the body as it was installed. The last one is what makes
   * "you have edited this" answerable rather than guessed at. */
  registry?: string;
  version?: string;
  sha256?: string;
}

/** Hard caps: a skill lands in every prompt, so a runaway file would
 * quietly eat the context window (and the user's tokens). The length is
 * in characters, not bytes, so a skill written in Russian or Chinese gets
 * the same room as one written in English. */
export const MAX_SKILL_CHARS = 16_000;
export const MAX_USER_SKILLS = 200;

/** A file on disk can be this many bytes before it is not read at all.
 * Four bytes is the most one character takes in UTF-8, and the rest is
 * room for the frontmatter, so a skill at the limit in any script fits. */
const MAX_SKILL_FILE_BYTES = MAX_SKILL_CHARS * 4 + 4_000;

/** Characters as a person counts them. Code points rather than
 * `.length`, which would count an emoji or a rare CJK character twice. */
export function countChars(text: string): number {
  return [...text].length;
}

// ── what actually reaches the prompt ───────────────────────────────────
//
// Every attached skill used to be sent whole, every turn. That was fine
// while a library was something a person filled in by hand and stopped at
// half a dozen. It stops being fine once the library grows on its own,
// because the cost is paid on every turn forever and the skill that
// matters today is one of thirty.
//
// So above a size, a skill is sent as its name and what it is for, and
// the agent reads the rest when it decides it needs it. Two rules keep
// that from being a downgrade.
//
//   A short skill is still sent whole. A round trip to fetch two hundred
//   characters costs more than the two hundred characters, and most
//   skills are short. This is insurance against a library that grows,
//   not a saving to be extracted from one that has not.
//
//   Nothing is withheld from an agent that cannot go and get it. Only
//   some engines are given a credential, and holding a skill back from
//   one that has no way to read it would be losing the instruction
//   rather than deferring it.

/**
 * Under this many characters a skill is sent whole.
 *
 * Roughly two hundred tokens. Set so that the skills Bloks ships, all of
 * them a few hundred characters, are unaffected: what this is for is the
 * long procedure with steps and pitfalls, which is the kind that is worth
 * a round trip and the kind a library accumulates.
 */
export const INLINE_UNDER = 800;

export interface Disclosure {
  /** Sent whole, as before. */
  inline: Skill[];
  /** Sent as a name and a description, to be read on demand. */
  indexed: Skill[];
}

export function disclose(skills: Skill[], canFetch: boolean, under: number = INLINE_UNDER): Disclosure {
  if (!canFetch) return { inline: skills, indexed: [] };
  const inline: Skill[] = [];
  const indexed: Skill[] = [];
  for (const skill of skills) {
    // A skill with nothing to say about itself cannot be indexed: the
    // description is the whole basis for deciding to read it.
    const readable = skill.description.trim().length > 0;
    if (!readable || skill.body.length <= Math.max(0, under)) inline.push(skill);
    else indexed.push(skill);
  }
  return { inline, indexed };
}

/**
 * The skills section of a system prompt, or null when there is none.
 *
 * `howToRead` is passed in rather than known here, because how an agent
 * fetches a skill is a fact about the credential it was given and this
 * file has no business knowing about that.
 */
export function skillsPrompt(disclosure: Disclosure, howToRead: string): string | null {
  const parts: string[] = [];
  if (disclosure.inline.length) {
    parts.push(
      // "whenever a request calls for it" is doing real work here: a
      // skill that fires on everything adjacent to its subject is worse
      // than no skill, because it turns a one-line answer into a
      // procedure. Each body carries its own "Not for:" line for the
      // same reason.
      `You have these skills installed. Follow the matching one whenever a request calls for it, and only then. Each says what it is not for; when that applies, answer directly instead:\n\n${disclosure.inline
        .map((s) => `## ${s.name}\n${s.body}`)
        .join("\n\n")}`,
    );
  }
  if (disclosure.indexed.length) {
    parts.push(
      [
        "You also have these skills, kept out of this prompt because they are long. Each one says what it is for. When a request calls for one, read it before starting, and follow it:",
        "",
        disclosure.indexed.map((s) => `- ${s.id}: ${s.name}. ${s.description}`).join("\n"),
        "",
        howToRead,
      ].join("\n"),
    );
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** Lowercase, dash-separated, no path separators or dots, a slug can
 * never traverse out of the skills directory. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "skill";
}

/** Frontmatter parse: `---\nname: X\ndescription: Y\n---\n<body>`. */
export function parseMarkdown(markdown: string): {
  name?: string;
  description?: string;
  body: string;
  registry?: string;
  version?: string;
  sha256?: string;
} {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: markdown.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return {
    name: meta.name,
    description: meta.description,
    body: match[2].trim(),
    registry: meta.registry,
    version: meta.version,
    sha256: meta.sha256,
  };
}

function serialize(
  skill: Pick<Skill, "name" | "description" | "body"> & Partial<Pick<Skill, "registry" | "version" | "sha256">>,
): string {
  const escape = (v: string) => v.replace(/\r?\n/g, " ").trim();
  return [
    "---",
    `name: ${escape(skill.name)}`,
    `description: ${escape(skill.description)}`,
    // only present when it came from the catalog, so a hand-written skill
    // stays a plain file with nothing in it to explain
    ...(skill.registry ? [`registry: ${escape(skill.registry)}`] : []),
    ...(skill.version ? [`version: ${escape(skill.version)}`] : []),
    ...(skill.sha256 ? [`sha256: ${escape(skill.sha256)}`] : []),
    "---",
    "",
    skill.body.trim(),
    "",
  ].join("\n");
}

/** Falls back to the first heading, then the filename, for a name. */
function nameFrom(body: string, fallback: string): string {
  const heading = body.match(/^#{1,3}\s+(.+)$/m);
  return (heading?.[1] ?? fallback).trim().slice(0, 80);
}

// ── the bundled pack ──────────────────────────────────────────────────
// Starter skills every install gets. Read-only: editing one produces a
// user copy rather than mutating the original.
const BUILTIN: Array<Omit<Skill, "source">> = [
  {
    id: "daily-brief",
    name: "Daily brief",
    description: "One short plan for the day, leading with what needs a decision",
    body: `Use this when asked for a brief, a plan for the day, or "what's on".

1. Gather: today's calendar, open tasks, and threads awaiting a reply.
2. Group into: needs a decision from me, happening today, and waiting on someone else.
3. Lead with the decisions. Never open with a greeting or a summary of what you're about to say.
4. If something slipped since yesterday, say so and why.

Not for: a single lookup. If they asked what one meeting is, answer that and stop.
Return: a concise brief suited to what needs attention.
Approval: none needed, this is read-only.`,
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Sort new mail into needs-me, routine, and noise",
    body: `Use this when processing an inbox.

1. Read only what arrived since the last run.
2. Classify each message: needs-me, routine (safe to draft), or noise.
3. Draft a reply only when the task calls for one; use the user's voice.
4. Escalate immediately, without waiting for the batch: anything financial, legal, security-related, time-sensitive, or from a named VIP.

Not for: one named message. Read and answer that one rather than sorting the whole inbox.
Return: the classifications and escalations, and any requested drafts.
Approval: required before sending anything. Never send on your own.`,
  },
  {
    id: "research-brief",
    name: "Research brief",
    description: "Investigate a topic and return a short sourced brief",
    body: `Use this for any research request.

1. Start with primary sources (the actual documentation, filing, or repository) before commentary about them.
2. Check load-bearing claims against sources appropriate to the question and stakes.
3. Separate clearly: established fact, contested, and your own inference.
4. Say plainly when the evidence is thin. A short honest brief beats a long confident one.

Not for: a fact you already hold, or one lookup that a single source settles. Answer it plainly instead.
Return: the answer, supporting detail and relevant sources as links.
Approval: none needed unless the research requires paid access or account creation.`,
  },
  {
    id: "code-review",
    name: "Code review",
    description: "Review a diff for correctness bugs and needless complexity",
    body: `Use this when reviewing code or a pull request.

1. Read the surrounding code first. Conventions here beat conventions in general.
2. Hunt correctness bugs before style: wrong logic, unhandled errors, race conditions, off-by-ones, missing awaits.
3. Then note genuine simplifications. Do not invent nitpicks to fill space.
4. For each finding give: the file and line, what breaks, and the concrete input that would break it.

Not for: a question about how code works, or a change you were asked to make. Explain or write it instead.
Return: findings ordered most-severe first. If the diff is clean, say so in one line.
A review is read-only unless changes are authorized. Push only when authorized; existing authorization need not be requested again.`,
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    description: "Assemble context and an agenda before a meeting",
    body: `Use this ahead of any scheduled meeting.

1. Identify attendees and what each cares about.
2. Pull the history: last conversation, open commitments on both sides, anything promised and not delivered.
3. Surface what changed since you last spoke.
4. Propose an agenda with the single most important item first.

Not for: a meeting already under way, or one with no attendees and no history worth assembling.
Return: who, what changed, what to decide, and a useful agenda.
Approval: none needed, this is read-only.`,
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    description: "What shipped, what slipped, and the biggest risk ahead",
    body: `Use this at the end of a working week.

1. List what actually shipped, not what was worked on.
2. List what slipped, each with the real reason, not "ran out of time".
3. Name the material risks to next week and what would defuse them.
4. Note anything that has now slipped two weeks running; that is a pattern, not a delay.

Not for: a question about one project. Answer that project rather than reviewing the week.
Return: what shipped, what slipped, and the relevant risks.
Approval: none needed, this is read-only.`,
  },
  {
    id: "outreach-draft",
    name: "Outreach draft",
    description: "Write outreach that references something specific and true",
    body: `Use this when drafting cold email or messages to a prospect.

1. Research the account first. If you cannot find something specific and true about them, say so and skip them rather than writing filler.
2. Open with that specific thing, not with who you are.
3. Make the ask clear.
4. Match the user's voice from their previous messages. Never use "I hope this finds you well", "circling back", or "just following up".

Not for: a reply in an existing thread. Match that thread rather than opening cold.
Return: a subject line and body appropriate to the recipient.
Approval: always required before sending. Never send outreach on your own.`,
  },
  {
    id: "expense-coding",
    name: "Expense coding",
    description: "Categorize transactions consistently and flag anomalies",
    body: `Use this when processing transactions or receipts.

1. Categorize using the categories already present in the user's history. Do not invent new ones.
2. Resolve ambiguity from available evidence. Ask when a material uncertainty remains.
3. Flag: duplicate charges, subscriptions with no recent use, and material departures from its historical pattern.
4. Note any charge missing a receipt so the user can find it while they still remember it.

Not for: one receipt somebody asked you to read. Read it and say what it is.
Return: counts by category, the flags, and the list of missing receipts.
Approval: required before categorizing anything as personal or writing to an accounting system.`,
  },
  {
    id: "page-design",
    name: "Page design",
    description: "Read before making a page, report, dashboard or deck someone will open as a file. How to make it clear at a glance and finished on a phone and a Mac, light and dark",
    body: `Use this before you make a file a person will look at: a web page, a report, a comparison, a dashboard, a one pager, a slide deck. It opens in Bloks on a Mac and on an iPhone, so it has to read at 390 pixels wide and in dark mode, and it is judged in the first two seconds.

Not for: a reply in the chat. A short answer, or one with some structure, belongs in the chat, drawn as interface when you can.

## First, does this need a file at all
Most answers do not. Answer in chat unless making a file is requested or otherwise authorized. Analysis or a comparison alone does not authorize a file.

## How much to put in
Depth follows the stakes, not a template. Ask what a careful person would want to know before they act, and give exactly that.
- A cheap choice that is easy to undo: the pick, one line of why, nothing more.
- A purchase or a commitment that costs real money or is hard to undo (a console, a laptop, a plan, a contract): the pick first, then everything that would change it. The real total cost (what is included, what you have to buy as well, the subscription), how each option fits the person's own situation, the trade offs in practice rather than in specs, timing (sales, new models), the risks (warranty, returns, what goes wrong), and where the facts came from. Leaving one of those out makes the person go and look it up, and then the page has failed.
- A report or an analysis: the finding first, then the evidence for it in order of weight, then what is uncertain.
More detail never means more words per fact. It means more facts, each said once, short, and grouped by the question it answers, with the answer always on the first screen.

## How people read a page
They do not read it. They scan it, and decide in about two seconds whether it answers them.
- The eye lands on the biggest thing first, then runs down the left edge, stopping at numbers, bold words and the first two or three words of each line. Put the meaning exactly there.
- Attention is spent, not given. Every extra word, box, color and icon costs some of it, and what is left goes to the answer. Clean is not a style here; it is how the answer gets through.
- Group related facts so the reader can compare them easily.
- A number with its meaning beside it ("$100 less", "2.5 times the graphics power") is read in a glance. A number alone makes the reader do the math, and most will not.
- Sameness is what lets someone compare. Two options described in two different shapes cannot be compared without reading both in full.

## Write it before you style it
1. The headline is the answer, not the topic. "The Series S, unless you want 4K" beats "PS5 vs Xbox Series S: a complete comparison". A subtitle under it says the scope and the date the facts are from.
2. Do the math for them. Differences, totals, per month, per use, the gap between the two: work them out and show the result, with the raw figures beside it in smaller type.
3. Cut. Every sentence that would not change their decision goes; every fact that would change it stays. Keep labels and paragraphs easy to scan. No intro, no "in this comparison we will", no closing summary of what they just read.
4. Say each fact once, in the place it does the most work. If the price is in the verdict, the table does not need a sentence about the price as well.
5. Replace pros and cons with decision rules: "Choose the PS5 if you want 4K or PlayStation exclusives. Choose the Series S if you want Game Pass and the lower price." People decide on their own situation, not on a list of features.
6. Plain words. No hype, no marketing adjectives ("ultimate", "comprehensive", "powerhouse"), no exclamation marks, no emoji.

## The shape
- Choose the form from the content. A comparison is a table with the better value marked in each row. Numbers over time are one chart. A choice uses comparable cards with the same rows in the same order, with a recommendation when appropriate. Steps are a numbered list. Not everything needs a chart, and nothing needs all of them.
- The order: headline and scope, the verdict (the pick and the rule for when the other wins), the key numbers, the detail, what would change the answer (a price drop, a date, a missing fact), sources.
- The first screen of a phone holds the headline, the verdict and the key numbers. Someone who reads nothing else has the answer.
- Group by the question each part answers ("What does it really cost", "Which fits how you play"), not by where you found the facts.
- Reference detail someone may want but few will read (full spec lists, method notes) goes in a details element they can open. Nothing that would change the decision is hidden.

## The look: quiet, so the content is loud
- Hierarchy by size and weight, not by boxes and colors. Make the headline, labels and supporting detail easy to distinguish.
- Space is the separator. Use space before a line, a line before a box, and a box only when the content inside is one unit.
- Background plain: #ffffff or #fafafa in light, #0b0b0c or #111113 in dark. Never a gradient behind the page, never a photo behind text.
- Cards, when you need them: one step off the background (#f4f4f5 light, #1a1a1d dark), a hairline border (the text color at 8 to 12 percent), radius 12 to 16px, at most a 0 1px 2px shadow. Cards never sit inside cards.
- One accent color, for the one thing that matters on each screen: the pick, the key number, links. If the subject has no color of its own, a calm blue (#2563eb light, #60a5fa dark), or an indigo (#4f46e5 light, #818cf8 dark) when a brand on the page is already blue. Brand colors appear only as small marks: a dot, a thin bar, a label. Never whole cards, headings or the page.
- Type: font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif. Body 16px, line-height 1.5. A short scale: 13, 15, 17, 22, 28, 40. Headings 600 to 700 with letter-spacing -0.01em, -0.02em from 28px up. Key numbers large and tabular: font-variant-numeric: tabular-nums.
- One left edge. Text, numbers and headings line up on it, and repeated items keep their parts in the same place so the eye can run down a column.
- Running text at most about 68 characters wide (max-width: 680px). Spacing on a 4px grid: 8, 12, 16, 24, 32, 48, generous between sections and tight within them.
- Contrast: body text at least 4.5 to 1, muted text included. Muted text #5f6672 in light (it holds on white and on a card), #a1a1aa in dark.
- Leave out: text-shadow, emoji as icons or bullets, all caps sentences, centered paragraphs, borders on every side of everything, decorative images, a second accent. When an icon carries meaning, a small inline SVG with a 1.5 to 2px stroke in currentColor.

## Light and dark
Every color is a CSS variable on :root, redefined inside @media (prefers-color-scheme: dark). Set background and color on body explicitly. Borders, charts and badges use the variables too, so nothing is left white on white or black on black.

## Tables
- First column names the row, one column per option, the same order everywhere on the page.
- Mark the better value in each row (weight 600 or a small accent dot), not every cell. A row where they are equal says so once ("Same") rather than repeating the value.
- Numbers right aligned and tabular. Units in the row label, not in every cell. Split long tables by theme when that helps comparison.
- Hairline row borders, no zebra stripes, no heavy header fill.
- On a phone a wide table scrolls sideways inside its own wrapper (overflow-x: auto) with the first column sticky. The page itself never scrolls sideways.

## Charts
- Only when the shape of the numbers is the point. Axes labeled with units. Label series clearly.
- Inline SVG, or a library from a pinned version (for example https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js). The key numbers are in the text too, so the page reads if the script never loads.
- Series colors from the variables, distinct in both themes, and never color alone telling two series apart.

## Interaction, only where it helps
- A toggle between views, a sort on a table header, a filter. Controls look like controls, show a pointer cursor and a focus ring, and are at least 44px tall.
- Nothing only on hover: a phone has no hover.
- One file: CSS in a style element, script in a script element. No CSS frameworks, no hotlinked images. It opens in a sandbox and may be read offline.

## The file
- <!doctype html>, <meta charset="utf-8">, <meta name="viewport" content="width=device-width, initial-scale=1">, and a descriptive <title>.
- Named for what it is: ps5-vs-xbox-series-s.html, not comparison.html or output.html.
- Images only when they carry information.

## Decks and printed reports
- A deck: one idea per slide, its title a full sentence that states the point, content sized for readability, the same palette and type as above. The HTML version shows one slide per screen and moves with the arrow keys and a swipe.
- A report for print: @media print with black on white, no card fills, a page break before each section.

## Check before you hand it over
- The five second test: someone who sees only the first screen on a phone can say the answer.
- The squint test: the visual hierarchy makes the most important content clear.
- Read it as the person: every line either helps them decide or goes.
- Nothing overflows at 390px. Dark mode is readable everywhere. Every number has its unit and its date. The sources are there, small, at the bottom.

## In the chat
The file speaks for itself. Briefly say what you made and its headline, for example "The Series S is the better buy at $499 unless you want 4K; the full comparison is in the card." Do not repeat the page in the chat as a list.

Return: one self contained file in your artifacts folder, with a brief reply.
Create and deliver a file only within the user's authorized scope.`,
  },
];

/** The design skill every agent that makes files has, attached or not:
 * a page an agent makes is the person's first look at its work, and the
 * defaults a model reaches for on its own (a gradient, white cards, a
 * wall of bullet points) look like nobody made them. */
export const PAGE_DESIGN = "page-design";

/** The same in a few lines, for an engine that cannot read the whole of
 * it on demand and would otherwise be sent all of it every turn. */
export const PAGE_DESIGN_SHORT = "Make it look finished: the answer first, a plain background (never a gradient), one accent color, system fonts, readable at phone width and in dark mode, everything in one file.";

/** An agent's attached skills, with the design skill added when it is not
 * among them. Read through the library, so a skill of the person's own
 * under the same id is the one that counts. */
export function withPageDesign(attached: Skill[]): Skill[] {
  if (attached.some((s) => s.id === PAGE_DESIGN)) return attached;
  const design = getSkills([PAGE_DESIGN]);
  return [...attached, ...design];
}

// ── reading ───────────────────────────────────────────────────────────

// Files already warned about, so a long skill is reported once rather
// than on every turn that lists the library.
const warnedLong = new Set<string>();

type ObservedSkill = Pick<Skill, "id" | "source"> & {
  name: string | null; description: string | null; version: string | null;
  body: boolean; registry: boolean; sha256: boolean;
  omitted: string[];
};
type SkillReadStatus = "complete" | "partial" | "unavailable";
let skillRead: SkillReadStatus = "unavailable";
let skillObservation: { observedAt: number; invalidatedAt: number | null; omittedItems: number; items: ObservedSkill[] } | null = null;
let skillReadAttempt: { at: number; status: SkillReadStatus } | null = null;

/** Metadata from this owner's natural reads only. Does not load a library,
 * read a file or claim that a hand-edited file is current. */
export function observedSkillLibrary() {
  return structuredClone({ lastObserved: skillObservation, lastAttempt: skillReadAttempt });
}

function readUserSkills(): Skill[] {
  skillRead = "complete";
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR);
  } catch (error) {
    skillRead = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "complete" : "unavailable";
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = join(SKILLS_DIR, entry);
    try {
      // Opened once, as a regular file inside the folder: a skill is read
      // into every turn and shown to every device, so a link put here
      // that leads out of the folder is never followed, and the size
      // checked is the size of the bytes read.
      const held = openInside(SKILLS_DIR, [entry]);
      if (!held) throw new Error("not a file in the skills folder");
      if (held.stat.size > MAX_SKILL_FILE_BYTES) {
        closeHeld(held);
        skillRead = "partial";
        if (!warnedLong.has(file)) {
          warnedLong.add(file);
          console.warn(`[bloks] skipped skill ${entry}: the file is too large to read`);
        }
        continue;
      }
      const bytes = readHeld(held, MAX_SKILL_FILE_BYTES);
      if (!bytes) throw new Error("unreadable");
      const raw = bytes.toString("utf8");
      const parsed = parseMarkdown(raw);
      if (!parsed.body.trim()) continue;
      // Edited by hand past the limit. Still loaded, cut at the limit, but
      // said out loud so the missing tail is not a mystery.
      const length = countChars(parsed.body);
      let body = parsed.body;
      if (length > MAX_SKILL_CHARS) {
        body = [...body].slice(0, MAX_SKILL_CHARS).join("");
        if (!warnedLong.has(file)) {
          warnedLong.add(file);
          console.warn(
            `[bloks] skill ${entry} is ${length.toLocaleString("en-US")} characters; using the first ${MAX_SKILL_CHARS.toLocaleString("en-US")}`,
          );
        }
      }
      const id = slugify(entry.replace(/\.md$/, ""));
      skills.push({
        id,
        name: parsed.name?.trim() || nameFrom(parsed.body, id.replace(/-/g, " ")),
        description: parsed.description?.trim() || "",
        body,
        source: "user",
        ...(parsed.registry ? { registry: parsed.registry } : {}),
        ...(parsed.version ? { version: parsed.version } : {}),
        ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
      });
    } catch {
      skillRead = "partial";
      /* unreadable file, skip rather than fail the whole list */
    }
  }
  return skills;
}

export function listSkills(): Skill[] {
  const user = readUserSkills();
  const userIds = new Set(user.map((s) => s.id));
  // a user file with a builtin's id shadows it, so a bundled skill can be
  // customized without losing the original on disk
  const builtin = BUILTIN.filter((b) => !userIds.has(b.id)).map(
    (b): Skill => ({ ...b, source: "builtin" }),
  );
  const skills = [...builtin, ...user].sort((a, b) => a.name.localeCompare(b.name));
  const attempt = { at: Date.now(), status: skillRead };
  skillReadAttempt = attempt;
  if (skillRead === "complete") {
    const cap = MAX_USER_SKILLS + BUILTIN.length;
    skillObservation = {
      observedAt: attempt.at, invalidatedAt: null, omittedItems: Math.max(0, skills.length - cap),
      items: skills.slice(0, cap).map((s) => {
        const omitted: string[] = [];
        const text = (key: "name" | "description" | "version") => {
          const value = s[key];
          if (value === undefined) return null;
          if ([...value].length > 256) { omitted.push(key); return null; }
          return value;
        };
        return {
          id: s.id, name: text("name"), description: text("description"), version: text("version"), source: s.source,
          body: Boolean(s.body), registry: Boolean(s.registry), sha256: Boolean(s.sha256), omitted,
        };
      }),
    };
  }
  return skills;
}

export function getSkills(ids: string[]): Skill[] {
  if (!ids.length) return [];
  const wanted = new Set(ids);
  return listSkills().filter((s) => wanted.has(s.id));
}

// ── writing ───────────────────────────────────────────────────────────

export interface InstallInput {
  /** A whole markdown document, frontmatter optional. */
  markdown?: string;
  /** Where it came from, when that is the catalog. */
  registry?: string;
  version?: string;
  sha256?: string;
  /** Or the pieces directly. */
  name?: string;
  description?: string;
  body?: string;
  /** Suggested id (e.g. the dropped filename); slugified regardless. */
  id?: string;
}

export function installSkill(input: InstallInput): Skill {
  const fromDoc = input.markdown ? parseMarkdown(input.markdown) : null;
  const body = (input.body ?? fromDoc?.body ?? "").trim();
  if (!body) throw Object.assign(new Error("a skill needs instructions"), { status: 400 });
  const length = countChars(body);
  if (length > MAX_SKILL_CHARS) {
    throw Object.assign(
      new Error(
        `this skill is ${length.toLocaleString("en-US")} characters; skills are limited to ${MAX_SKILL_CHARS.toLocaleString("en-US")}`,
      ),
      { status: 413 },
    );
  }

  const name = (input.name ?? fromDoc?.name ?? nameFrom(body, input.id ?? "skill")).trim();
  const description = (input.description ?? fromDoc?.description ?? "").trim().slice(0, 200);
  const id = slugify(input.id ?? name);

  const existing = readUserSkills();
  if (existing.length >= MAX_USER_SKILLS && !existing.some((s) => s.id === id)) {
    throw Object.assign(new Error("skill library is full"), { status: 507 });
  }

  // Editing a skill that came from the catalog keeps where it came from.
  // Losing that would make an edited skill indistinguishable from one
  // somebody wrote themselves, and the catalog would then offer to
  // "replace what you wrote" rather than say plainly that this is its
  // own skill with your changes on top.
  const before = existing.find((s) => s.id === id);
  const from = {
    registry: input.registry ?? before?.registry,
    version: input.version ?? before?.version,
    sha256: input.sha256 ?? before?.sha256,
  };

  mkdirSync(SKILLS_DIR, { recursive: true, mode: 0o700 });
  const file = join(SKILLS_DIR, `${id}.md`);
  writeFileSync(
    file,
    serialize({ name, description, body, ...from }),
    { mode: 0o600 },
  );
  try {
    chmodSync(file, 0o600);
  } catch {
    /* non-POSIX filesystem */
  }
  if (skillObservation) skillObservation.invalidatedAt = Date.now();
  return {
    id,
    name,
    description,
    body,
    source: "user",
    ...(from.registry ? { registry: from.registry } : {}),
    ...(from.version ? { version: from.version } : {}),
    ...(from.sha256 ? { sha256: from.sha256 } : {}),
  };
}

export function deleteSkill(id: string): boolean {
  const slug = slugify(id);
  try {
    unlinkSync(join(SKILLS_DIR, `${slug}.md`));
    if (skillObservation) skillObservation.invalidatedAt = Date.now();
    return true;
  } catch {
    return false;
  }
}
