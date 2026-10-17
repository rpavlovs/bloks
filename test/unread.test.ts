// The one number on the Dock icon.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { unreadCount } from "../src/lib/unread.ts";
import { openLaneUnread, pingedLane, readOpenLane } from "../src/state/reducer.ts";

describe("unreadCount", () => {
  test("counts unread agents and nothing else", () => {
    assert.equal(
      unreadCount([
        { unread: true },
        { unread: true },
        { unread: false },
        {},
      ]),
      2,
    );
  });

  test("archived agents cannot have news", () => {
    assert.equal(unreadCount([{ unread: true, archivedAt: 1724500000000 }, { unread: true }]), 1);
  });

  test("an empty roster is zero", () => {
    assert.equal(unreadCount([]), 0);
  });
});

describe("per-lane unread", () => {
  const lane = (id: string, unread: boolean, lastAt: number) => ({ id, unread, lastAt, createdAt: 0 });
  test("opening an agent goes to the lane that pinged, newest first", () => {
    const bot = { threadId: "a", activeTaskId: "a", tasks: [lane("a", false, 5), lane("b", true, 1), lane("c", true, 9)] };
    assert.equal(pingedLane(bot), "c");
    assert.equal(pingedLane({ ...bot, tasks: [lane("a", true, 5)] }), null, "the open lane is not somewhere to go");
  });
  test("a lane stopped on you comes before an unread one, read or not (#81)", () => {
    const bot = {
      threadId: "a",
      activeTaskId: "a",
      tasks: [lane("a", false, 5), lane("b", true, 9), { ...lane("c", false, 1), state: "needs-you" }],
    };
    assert.equal(pingedLane(bot), "c");
  });
  test("reading the open lane leaves the others, and the agent follows them", () => {
    const bot = { threadId: "a", activeTaskId: "a", unread: true, tasks: [lane("a", true, 5), lane("b", true, 1)] };
    const read = readOpenLane(bot);
    assert.equal(read.tasks[0].unread, false);
    assert.equal(read.unread, true, "b is still waiting");
    assert.equal(readOpenLane({ ...bot, tasks: [lane("a", true, 5)] }).unread, false);
    assert.equal(openLaneUnread(bot), true);
  });
  test("an agent flagged unread by a room turn, with no lane to show it, can still be read", () => {
    const bot = { threadId: "a", activeTaskId: "a", unread: true, tasks: [lane("a", false, 5)] };
    assert.equal(openLaneUnread(bot), true);
    assert.equal(readOpenLane(bot).unread, false);
  });
});
