// What the last sync actually did, published once and read by the shell.
//
// This exists because of a specific failure. storage.sync() has always returned the reason a push
// was refused, and boot.js has always thrown that result away on any device that already had data,
// because the first sync is fire and forget once there is something on screen to look at. So an
// app that had stopped syncing looked exactly like an app with nothing new to show. One refused
// row went unnoticed for three days, across two people, while the client list sat there looking
// perfectly healthy.
//
// A module rather than a field on the boot result, because the timing is the problem: that first
// sync finishes well after the page has rendered, so there is nothing to read at the moment a page
// would read it. Whoever is listening gets told when it lands.
//
// Deliberately not a toast, a banner, or anything that moves. A sync that is behind is not an
// emergency and interrupting somebody mid set over it would be worse than the silence this
// replaces. See nav.js for where it surfaces and how quietly.

let last = null;
const listeners = new Set();

/** Called by boot.js with every sync result, including the good ones. */
export function publishSync(result) {
  last = result;
  for (const fn of listeners) fn(result);
}

/**
 * Subscribe. Fires immediately with the last result when there already is one, so a page that
 * mounts after the sync finished is not left waiting for a second one that may never come.
 */
export function onSync(fn) {
  listeners.add(fn);
  if (last) fn(last);
  return () => listeners.delete(fn);
}

/**
 * What to put on screen, or null when there is nothing worth saying.
 *
 * Nothing is said about a sync that worked, and nothing is said about a queue that is merely
 * busy on a device that is offline, because both of those are the normal state of a local first
 * app on a gym floor. What earns a line is a write the server actively refused, which is the
 * case that does not clear itself and that nobody can discover by waiting.
 */
export function syncMessage(result) {
  if (!result) return null;
  if (result.error) {
    const n = result.pending;
    return `${n} change${n === 1 ? '' : 's'} not saved to the server. ${result.error}`;
  }

  // A parked write is the queue's other bad ending, and it is the quieter of the two. Everything
  // else went, the depth is zero, and by every measure this screen had until now the sync worked.
  // What actually happened is that a row was set aside because the server will never take it, and
  // saying nothing would mean a set somebody performed exists on one phone and nowhere else, with
  // no way for anyone to find out. It stays said on every later sync, because parking is permanent
  // until a person does something about it.
  const parked = result.parked ?? [];
  if (parked.length) {
    const n = parked.length;
    return `${n} change${n === 1 ? '' : 's'} the server will not accept, kept on this device. ${parked[0].last_error}`;
  }

  return null;
}
