// The agents' turn limit, as the settings page and notifications need it.
//
// The server owns the rule (server/agent-chain.ts); the desktop keeps its
// own copy of the few numbers and words it shows, rather than reaching
// into the server's code. test/turn-limit-shared.test.ts holds the two
// to the same values.

/** The same default as MAX_AGENT_CHAIN in server/agent-chain.ts. */
export const DEFAULT_TURN_LIMIT = 12;
/** The same bounds as MIN_AGENT_CHAIN_LIMIT and MAX_AGENT_CHAIN_LIMIT. */
export const MIN_TURN_LIMIT = 1;
export const MAX_TURN_LIMIT = 50;
/** The same title as CHAIN_LIMIT_TITLE, for the desktop's own alert. */
export const CHAIN_LIMIT_TITLE = "Agents stopped at the limit";
