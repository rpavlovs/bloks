// Which messages can be redone, where a redo goes back to, and what the
// line under the editor says about it (GitHub 258). The route that does
// it is in test/redo.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { redoCounts, redoPlan, takenBack } from "../server/redo.ts";
import type { Message } from "../server/store.ts";
import { redoLine, type RedoOffer } from "../src/lib/redo.ts";

let clock = 1_000;
const said = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text: `words of ${id}`, at: clock++, ...extra });
const reply = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: `reply ${id}`, at: clock++, ...extra });
const ids = (messages: readonly Message[]) => messages.map((m) => m.id);
/** The plan, for a message that has one. */
const plan = (messages: Message[], id: string) => {
  const found = redoPlan(messages, id);
  assert.ok(found && typeof found !== "string", `no plan for ${id}: ${String(found)}`);
  return { start: messages[found.start].id, resend: ids(found.resend) };
};

describe("whether a message can be redone", () => {
  test("a message that started its own turn goes back to itself", () => {
    const messages = [said("a"), reply("a1"), said("b"), reply("b1"), said("c"), reply("c1")];
    assert.deepEqual(plan(messages, "b"), { start: "b", resend: ["b"] });
    assert.deepEqual(plan(messages, "c"), { start: "c", resend: ["c"] });
  });

  test("one still waiting for its turn, or never sent, is not redone: nothing of it was read", () => {
    const messages = [said("a"), reply("a1"), said("q", { queued: true, queuedAt: 5 }), said("u", { unsent: true })];
    assert.equal(redoPlan(messages, "q"), "waiting");
    assert.equal(redoPlan(messages, "u"), "waiting");
  });

  test("one that waited and then went has been read, and is redone like any other", () => {
    const messages = [said("a"), reply("a1"), said("q", { queuedAt: 5, deliveredAt: 50 }), reply("q1")];
    assert.deepEqual(plan(messages, "q"), { start: "q", resend: ["q"] });
  });

  test("words that came another way are not the person's to redo from here", () => {
    const messages = [
      said("agent", { agent: { dir: "in", peerId: "kat", peerName: "Kat" } }),
      said("routine", { via: "routine", routine: { name: "Daily", manual: false } }),
      said("watcher", { via: "watcher" }),
      said("mail", { via: "email" }),
      said("hook", { via: "webhook" }),
      said("goal", { via: "goal" }),
      said("phone", { fromTelegram: true }),
      said("phone-waited", { telegramReply: { chatId: 7, state: "bound" } as Message["telegramReply"], deliveredAt: 9 }),
    ];
    for (const m of messages) assert.equal(redoPlan(messages, m.id), "not-yours", m.id);
  });

  test("an agent's message, one taken back, and one that is not there have no redo", () => {
    const messages = [said("a"), reply("a1"), said("gone", { deleted: true, text: "" }), said("old", { deleted: true, rewound: 9 })];
    assert.equal(redoPlan(messages, "a1"), null);
    assert.equal(redoPlan(messages, "gone"), null);
    assert.equal(redoPlan(messages, "old"), null);
    assert.equal(redoPlan(messages, "nowhere"), null);
  });
});

describe("the turn a redo goes back to", () => {
  test("a message that joined a running turn goes back to that turn's start, and the person's words from it go again in order", () => {
    const messages = [
      said("before"),
      reply("before1"),
      said("open"),
      reply("progress"),
      said("joined", { midTurn: true }),
      reply("more"),
      said("joined-too", { midTurn: true }),
      reply("end"),
      said("next"),
      reply("next1"),
    ];
    assert.deepEqual(plan(messages, "joined"), { start: "open", resend: ["open", "joined", "joined-too"] });
    assert.deepEqual(plan(messages, "joined-too"), { start: "open", resend: ["open", "joined", "joined-too"] });
    // the one that started it takes what joined it along too: the turn
    // is one piece, and its files come back together
    assert.deepEqual(plan(messages, "open"), { start: "open", resend: ["open", "joined", "joined-too"] });
    // and the turns around it are their own
    assert.deepEqual(plan(messages, "before"), { start: "before", resend: ["before"] });
    assert.deepEqual(plan(messages, "next"), { start: "next", resend: ["next"] });
  });

  test("a burst that waited and went together started one turn, so it comes back whole", () => {
    const messages = [
      said("a"),
      reply("a1"),
      said("one", { queuedAt: 10, deliveredAt: 77 }),
      said("two", { queuedAt: 11, deliveredAt: 77 }),
      reply("both"),
      said("late", { midTurn: true }),
      reply("end"),
      said("after", { queuedAt: 80, deliveredAt: 99 }),
    ];
    for (const id of ["one", "two", "late"]) {
      assert.deepEqual(plan(messages, id), { start: "one", resend: ["one", "two", "late"] }, id);
    }
    // a later burst is another turn
    assert.deepEqual(plan(messages, "after"), { start: "after", resend: ["after"] });
  });

  test("a turn somebody else started cannot be redone from the person's box", () => {
    const started: Array<Partial<Message>> = [
      { agent: { dir: "in", peerId: "kat", peerName: "Kat" } },
      { via: "routine", routine: { name: "Daily", manual: true } },
      { via: "watcher" },
      { via: "webhook" },
      { via: "goal" },
    ];
    for (const theirs of started) {
      const messages = [said("mine-before"), reply("r"), said("theirs", theirs), reply("working"), said("mine", { midTurn: true }), reply("end")];
      assert.equal(redoPlan(messages, "mine"), "others-turn", JSON.stringify(theirs));
      // the person's own turn before it is untouched by that
      assert.deepEqual(plan(messages, "mine-before"), { start: "mine-before", resend: ["mine-before"] });
    }
  });

  test("a burst that somebody else's words were part of is theirs too", () => {
    const messages = [
      said("mine", { queuedAt: 1, deliveredAt: 50 }),
      said("theirs", { queuedAt: 2, deliveredAt: 50, agent: { dir: "in", peerId: "kat", peerName: "Kat" } }),
      reply("both"),
    ];
    assert.equal(redoPlan(messages, "mine"), "others-turn");
  });

  test("another agent's words that joined the person's turn are taken back with it, and not sent again", () => {
    const messages = [said("open"), reply("p"), said("kat", { midTurn: true, agent: { dir: "in", peerId: "kat", peerName: "Kat" } }), said("mine", { midTurn: true }), reply("end")];
    assert.deepEqual(plan(messages, "mine"), { start: "open", resend: ["open", "mine"] });
    assert.equal(redoPlan(messages, "kat"), "not-yours");
  });

  test("the message that started the turn was taken back: the turn still starts there, and only what has words goes again", () => {
    const messages = [said("a"), reply("a1"), said("open", { deleted: true, text: "" }), reply("p"), said("mine", { midTurn: true }), reply("end")];
    assert.deepEqual(plan(messages, "mine"), { start: "open", resend: ["mine"] });
  });

  test("what waits above the composer is in no turn", () => {
    const messages = [said("open"), reply("p"), said("waits", { queued: true, queuedAt: 3 }), said("mine", { midTurn: true }), reply("end")];
    assert.deepEqual(plan(messages, "mine"), { start: "open", resend: ["open", "mine"] });
  });

  test("an earlier rewind is as far back as a turn can reach", () => {
    const messages = [said("old", { deleted: true, rewound: 5 }), reply("old1", { deleted: true, rewound: 5 }), said("mine", { midTurn: true }), reply("end")];
    assert.deepEqual(plan(messages, "mine"), { start: "mine", resend: ["mine"] });
  });
});

describe("what a redo takes back", () => {
  const messages = [
    said("a"),
    reply("a1"),
    said("b"),
    { id: "tool", role: "bot", kind: "activity", tool: { name: "edit", ok: true }, at: 1 } as Message,
    reply("b1"),
    { id: "card", role: "bot", kind: "changes", at: 2 } as Message,
    said("gone", { deleted: true, text: "" }),
    said("waits", { queued: true, queuedAt: 3 }),
    said("never", { unsent: true }),
  ];

  test("everything from the message on that is still standing", () => {
    assert.deepEqual(ids(takenBack(messages, 2)), ["b", "tool", "b1", "card", "waits", "never"]);
  });

  test("a redo leaves what is waiting above the composer where it is", () => {
    assert.deepEqual(ids(takenBack(messages, 2, true)), ["b", "tool", "b1", "card"]);
  });

  test("messages are counted as the chat counts a rewind: what was said, not the rows around it", () => {
    assert.deepEqual(redoCounts(takenBack(messages, 2, true)), { messages: 2, sent: false });
    assert.deepEqual(redoCounts(takenBack(messages, 0, true)), { messages: 4, sent: false });
  });

  test("a turn that messaged another agent sent something that stays", () => {
    const out = (status: "sent" | "queued" | "failed"): Message => ({
      id: `out-${status}`,
      role: "bot",
      kind: "activity",
      text: "over to you",
      tool: { name: "messaged Kat", ok: status !== "failed" },
      agent: { dir: "out", peerId: "kat", peerName: "Kat", status },
      at: 4,
    });
    assert.equal(redoCounts([said("x"), out("sent")]).sent, true);
    assert.equal(redoCounts([said("x"), out("queued")]).sent, true);
    // one that was refused never left
    assert.equal(redoCounts([said("x"), out("failed")]).sent, false);
    // a message that arrived is not one that was sent
    assert.equal(redoCounts([said("x", { agent: { dir: "in", peerId: "kat", peerName: "Kat" } })]).sent, false);
  });
});

describe("the line under the editor", () => {
  const offer = (over: Partial<RedoOffer> = {}): RedoOffer => ({ offered: true, messages: 3, files: 2, sent: false, working: false, resend: 1, ...over });

  test("says what it takes back and puts back", () => {
    assert.equal(redoLine(offer(), "Kat"), "Takes back 3 messages and puts back 2 files.");
    assert.equal(redoLine(offer({ messages: 1, files: 1 }), "Kat"), "Takes back 1 message and puts back 1 file.");
  });

  test("leaves the files out when there are none to put back", () => {
    assert.equal(redoLine(offer({ files: 0 }), "Kat"), "Takes back 3 messages.");
  });

  test("adds what stays when the turn sent something", () => {
    assert.equal(
      redoLine(offer({ sent: true }), "Kat"),
      "Takes back 3 messages and puts back 2 files. Messages it sent and anything outside the folder stay.",
    );
  });

  test("while the agent works, says the stop and claims no number of files nobody has counted", () => {
    assert.equal(redoLine(offer({ working: true, files: 0 }), "Kat"), "Stops Kat, takes back 3 messages and puts back any files it changed.");
    assert.equal(redoLine(offer({ working: true, files: 5 }), "Kat"), "Stops Kat, takes back 3 messages and puts back any files it changed.");
  });

  test("says when more of the person's messages go again", () => {
    assert.equal(
      redoLine(offer({ messages: 4, resend: 2, sent: true }), "Kat"),
      "Takes back 4 messages and puts back 2 files. Sends your 2 messages from that turn again. Messages it sent and anything outside the folder stay.",
    );
  });
});
