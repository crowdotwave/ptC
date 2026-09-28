// What a page says when storage on this device has stopped answering.
//
// A stall used to say nothing at all. A read or write that never settles is a promise that never
// settles, so the screen waiting on it simply stops. The Create button on the import screen did
// nothing, and the next page drew an empty client list whose Add button had never been wired,
// because wiring happens after the list loads. Nothing was wrong on screen except that nothing
// worked, and the fix, closing the app, was not a thing anybody would guess from an empty list.
//
// The driver now gives up on a stuck operation, reconnects, and tries once more. What reaches here
// is the second failure, which means the storage underneath is stuck rather than one connection, and
// the only cure seen so far is closing the app completely. So this says that, once, in words.
//
// Caught as an unhandled rejection rather than at each call site, because the pages that stall are
// the ones whose startup never finished, and there is no call site on them left to catch it. A
// screen that already handles a failed write in its own place (the notice band on the logging
// screen, the error line on the import screen) keeps doing so and never reaches this.

import { isStorageStalled } from './storage.js';

let watching = false;
let shown = false;

/** Puts the message at the top of the page. Once per page: a second copy says nothing new. */
export function showStorageStalled(message) {
  if (shown) return;
  shown = true;
  const node = document.createElement('p');
  node.className = 'stalled';
  node.setAttribute('role', 'alert');
  node.textContent = message;
  document.body.prepend(node);
}

/** Listens for a stall nobody caught. Safe to call from every page's startup. */
export function watchStorage() {
  if (watching) return;
  watching = true;
  window.addEventListener('unhandledrejection', (event) => {
    if (!isStorageStalled(event.reason)) return;
    event.preventDefault();
    showStorageStalled(event.reason.message);
  });
}
