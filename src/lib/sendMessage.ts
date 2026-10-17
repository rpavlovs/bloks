import type { Message } from "../state/reducer.js";

type Api = (path: string, init?: RequestInit) => Promise<any>;

export interface MessageSend {
  botId: string;
  text: string;
  replyTo?: Message["replyTo"];
  taskId?: string;
  stopFirst?: boolean;
}

/** Modifier-Enter stops before submitting, and never joins the dying turn.
 * Stop acknowledges the request, not necessarily the engine's exit, so the
 * follow-up waits in the normal queue until that turn has actually ended.
 * Capture its lane and words before waiting: the person may change either
 * on screen meanwhile. Errors go to the caller's normal draft recovery. */
/** Sends to a conversation still waiting on a stop-then-send, by agent
 * and lane. A plain Enter pressed meanwhile used to go at once, steering
 * into the turn being stopped, so it was lost the same way the follow-up
 * would have been and it overtook the follow-up too. Now it waits its
 * turn behind it, and so does a second stop-then-send. */
const pending = new Map<string, Promise<unknown>>();

export function sendMessage(api: Api, ref: MessageSend): Promise<any> {
  // the words and the lane as they were when the keys were pressed
  const words = { ...ref };
  const key = `${words.botId}\u0000${words.taskId ?? ""}`;
  const before = pending.get(key);
  if (!before && !words.stopFirst) return send(api, words);
  const run = before ? before.then(() => send(api, words)) : send(api, words);
  const settled = run.then(() => {}, () => {});
  pending.set(key, settled);
  void settled.then(() => {
    if (pending.get(key) === settled) pending.delete(key);
  });
  return run;
}

async function send(api: Api, ref: MessageSend): Promise<any> {
  const { botId, taskId, stopFirst } = ref;
  const lane = taskId ? { taskId } : {};
  const body = JSON.stringify({
    text: ref.text,
    replyTo: ref.replyTo,
    ...lane,
    ...(stopFirst ? { steer: false } : {}),
  });
  if (stopFirst) {
    await api(`/api/bots/${botId}/interrupt`, { method: "POST", body: JSON.stringify(lane) });
  }
  return api(`/api/bots/${botId}/messages`, { method: "POST", body });
}
