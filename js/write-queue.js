// The logging screen's writes, one at a time and in the order they were made.
//
// Serial so a set_log never reaches the adapter before the session row it points at. Nothing in
// the UI awaits this: a tap updates the screen and the write catches up.
//
// A write that STALLED is kept rather than dropped, and that is the reason this is its own file.
// The screen is optimistic, so by the time a write gives up the set is already drawn as logged and
// the cursor has moved on. The queue used to report the stall and forget the write, which left a
// set that was on screen and in the undo stack and nowhere else, and the only sign of it was a
// notice that the very next tap cleared, since logging a set clears the notice band. So a stalled
// write waits here and runs again ahead of the next one, and if it stalls again it is held again.
// Every task is a put by id, so running one twice writes the same row twice and nothing more.
//
// Held, the rest wait behind it. Order is the whole point of the queue: a set written while its
// session row is still stuck would be a row pointing at nothing.
//
// A write that was REFUSED is not held. That is an answer about the data, and the same write would
// be refused again.

import { isStorageStalled } from './storage.js';

/**
 * `onStall` hears each time the held writes stall, `onSaved` hears when held writes finally land,
 * and `onError` hears a refusal. A stall stops the drain, so a burst of taps behind a stuck
 * database says so once per attempt rather than once a set.
 */
export function createWriteQueue({
  onStall = () => {},
  onSaved = () => {},
  onError = () => {},
} = {}) {
  let tail = Promise.resolve();
  let held = [];

  async function drain(tasks) {
    const wasHolding = held.length > 0;
    held = [];
    for (let i = 0; i < tasks.length; i += 1) {
      try {
        await tasks[i]();
      } catch (error) {
        if (isStorageStalled(error)) {
          held = tasks.slice(i);
          onStall(error);
          return;
        }
        onError(error);
      }
    }
    if (wasHolding) onSaved();
  }

  function enqueue(fresh) {
    tail = tail.then(() => (held.length || fresh.length ? drain([...held, ...fresh]) : undefined));
    return tail;
  }

  return {
    /** Queues a write. Anything held from a stall runs first. */
    add(task) {
      return enqueue([task]);
    },

    /** Runs whatever is held, with nothing new behind it. A no op when nothing is. */
    retry() {
      return enqueue([]);
    },

    /** Queues something that is not a write, such as a flush, behind every write before it. */
    after(fn) {
      tail = tail.then(fn).catch(() => {});
      return tail;
    },

    /** How many writes are waiting on a stall. */
    get held() {
      return held.length;
    },
  };
}
