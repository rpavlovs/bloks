// The desktop's copy of the turn limit's numbers and title, held to the
// server's (src/lib/turn-limit.ts keeps its own so it never imports
// server code).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN_LIMIT_TITLE, MAX_AGENT_CHAIN, MAX_AGENT_CHAIN_LIMIT, MIN_AGENT_CHAIN_LIMIT } from "../server/agent-chain.ts";
import * as desktop from "../src/lib/turn-limit.ts";

test("the desktop's turn limit agrees with the server's", () => {
  assert.equal(desktop.DEFAULT_TURN_LIMIT, MAX_AGENT_CHAIN);
  assert.equal(desktop.MIN_TURN_LIMIT, MIN_AGENT_CHAIN_LIMIT);
  assert.equal(desktop.MAX_TURN_LIMIT, MAX_AGENT_CHAIN_LIMIT);
  assert.equal(desktop.CHAIN_LIMIT_TITLE, CHAIN_LIMIT_TITLE);
});
