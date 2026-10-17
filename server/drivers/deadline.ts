// A bound on the steps that should be quick.
//
// Starting a turn is a handshake before it is work: initialize, open or
// resume a session, hand over the prompt. Each of those answers in a
// second or two when things are well. When they are not (a CLI waiting on
// a login prompt nobody can see, an update check that hangs, a half-dead
// app server) the request simply never returns, and the agent sits on
// "working" with its composer locked until someone restarts the app.
//
// The work itself is never bounded this way: a turn can be quiet for a
// long time while a build runs. Only the handshake is.
export const HANDSHAKE_MS = 60_000;

export function within<T>(work: Promise<T>, what: string, engine: string, ms = HANDSHAKE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${engine} did not answer while ${what} for ${Math.round(ms / 1000)} seconds, so this turn was stopped. ` +
            `Send the message again; if it keeps happening, run the ${engine} CLI once in a terminal to see what it is waiting for.`,
        ),
      );
    }, ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
