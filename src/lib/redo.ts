// What Redo says before it is pressed (GitHub 258).
//
// Editing a message the agent has already read offers Redo: the agent
// stops if it is working, the conversation and the folder go back to
// before the message, and the new words are sent. There is no dialog.
// The button and the line under the box are the confirmation, so the
// line has to say what goes, in numbers the server counted (GET
// /api/threads/:thread/messages/:id/redo), and what cannot come back.
//
// Only the wording is here. Whether Redo is offered, and what it would
// take back, is the server's to say: it holds the turns and the files.

/** What the server says about redoing one message: what it would take
 * back, or that it is not offered, and why. */
export type RedoPreview =
  | { offered: false; why?: string }
  | {
      offered: true;
      /** Messages taken back, the edited one included. */
      messages: number;
      /** Files put back as the folder stands now. */
      files: number;
      /** The turns taken back sent something that stays sent. */
      sent: boolean;
      /** The agent is working. What the turn it is in has changed is
       * measured when it ends, so `files` cannot count it yet. */
      working: boolean;
      /** How many of the person's messages go again: more than one when
       * other words of theirs were part of the same turn. */
      resend: number;
    };

export type RedoOffer = Extract<RedoPreview, { offered: true }>;

const counted = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * The line under the editor: "Takes back 3 messages and puts back 2
 * files." While the agent works it says the stop and leaves the number
 * of files out, since nobody knows it yet. A message that was part of a
 * turn with others of the person's says they go again, and a turn that
 * sent something says what stays.
 */
export function redoLine(offer: RedoOffer, agent: string): string {
  const messages = counted(offer.messages, "message");
  const takes = offer.working
    ? `Stops ${agent}, takes back ${messages} and puts back any files it changed.`
    : offer.files > 0
      ? `Takes back ${messages} and puts back ${counted(offer.files, "file")}.`
      : `Takes back ${messages}.`;
  return [
    takes,
    offer.resend > 1 ? `Sends your ${offer.resend} messages from that turn again.` : "",
    offer.sent ? "Messages it sent and anything outside the folder stay." : "",
  ]
    .filter(Boolean)
    .join(" ");
}
