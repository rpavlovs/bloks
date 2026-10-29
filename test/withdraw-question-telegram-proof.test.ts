// CI-only proof: a Telegram answer that wins stays the real answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentCli, cardIn, fixture, waitFor } from "./helpers/telegram-native.ts";

test("an accepted Telegram answer cannot be overwritten by withdrawal", async (t) => {
  const f = await fixture(t);
  f.tg.say("ASYNC_ASK which colour");
  const copy = await cardIn(f, "Your agent has a question");
  await waitFor(() => f.tg.calls("sendMessage").some((c) => c.body.text === "Carried on."), "the asking turn never ended");
  const asked = (await f.messages()).find((m) => m.kind === "options" && m.card?.requestId);
  f.tg.press(copy.id, copy.body.reply_markup.inline_keyboard[1][0].callback_data);
  const press = await waitFor(() => f.tg.calls("answerCallbackQuery")[0], "the answer was not acknowledged");
  assert.equal(press.body.text, "Answered: Blue");
  await waitFor(async () => (await f.messages()).some((m) => m.role === "user" && m.text === "Blue"), "the real answer was not delivered");
  const result = await agentCli(f, ["unask", asked.id]);
  assert.equal(result.status, 1);
  assert.match(result.answer.error, /^No open question of yours has that id/);
  const after = await f.messages();
  const saved = after.find((m) => m.id === asked.id).card;
  assert.equal(saved.answered, "answer");
  assert.equal(saved.withdrawn, undefined);
  assert.equal(after.filter((m) => m.role === "user" && m.text === "Blue").length, 1);
  const edit = await waitFor(() => f.tg.calls("editMessageText").find((c) => c.body.message_id === copy.id), "the copy was not settled");
  assert.equal(edit.body.text, "Your agent has a question\nWhich colour?\n\nAnswered: Blue");
});
