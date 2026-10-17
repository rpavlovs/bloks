import { MAX_CHAIN_NAME_CHARS, MAX_CHAIN_EXCERPT_CHARS } from "./limits.ts";

/** Workspace limit for turns agents start through one another, by
 * default. The whole chain is counted, not each pair in it: that is what
 * makes the limit a bound on cost (GitHub 248). Mirrored for the desktop
 * in src/lib/turn-limit.ts. */
export const MAX_AGENT_CHAIN = 12;
/** The bounds a person may set it within. There is no Off: without a
 * bound, two agents can keep each other going until the usage runs out. */
export const MIN_AGENT_CHAIN_LIMIT = 1;
export const MAX_AGENT_CHAIN_LIMIT = 50;
export const CHAIN_LIMIT_TITLE = "Agents stopped at the limit";

/** Whether a value is one the settings API accepts. */
export function validTurnLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_AGENT_CHAIN_LIMIT && value <= MAX_AGENT_CHAIN_LIMIT;
}

/** The limit a stored value means. Hand-edited or older config never
 * switches the guard off: anything malformed is the default, and a number
 * past the bound is the bound. */
export function agentTurnLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_AGENT_CHAIN_LIMIT) return MAX_AGENT_CHAIN;
  return Math.min(value, MAX_AGENT_CHAIN_LIMIT);
}

export function pastAgentLimit(depth: number, limit: number): boolean {
  return depth > limit;
}

/** Keep both names in the first clause, including the phone's short preview. */
export function chainName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_CHAIN_NAME_CHARS);
}

/** Redact before shortening: a cut key must not escape its recognisable shape. */
export function chainExcerpt(words: string, redact: (text: string) => string): string {
  return redact(words).replace(/\s+/g, " ").trim().slice(0, MAX_CHAIN_EXCERPT_CHARS);
}

/** For the person: the notice, the room's word and scheduled-work records. */
export function chainLimitText(what: string, depth: number, limit: number, excerpt?: string): string {
  return `${what} Nothing is held for delivery. Agents had started ${depth - 1} turns in a row; this turn would exceed the workspace limit of ${limit}. Every turn costs usage, and the limit stops agents keeping each other going without you. A message from the person in that conversation starts the count over, as does an independent routine, watcher or webhook turn. The limit is in Settings > General > Working with agents.${excerpt ? ` Excerpt: "${excerpt}"` : ""}`;
}

/** For the agent whose message was refused. It is told to wrap up, never
 * where the limit is set: asking the person to lift it is not its call. */
export function chainAgentRefusal(recipient: string, depth: number): string {
  return `${recipient} did not get this. Agents have started ${depth - 1} turns in a row without the person, which is as many as Bloks lets run before they have a say. Finish this turn and say where things stand; the person carries it on from there.`;
}
