// Wiring for the links and controls that appear in a page header.
//
// Kept out of the individual page scripts because every one of them needs the same two things,
// and the last time they did not have them the answer to "how do I get to the trainer view" was
// a URL read out loud to somebody holding a phone.

import { signOutAndClear } from './boot.js';

/**
 * Wires every [data-signout] control on the page.
 *
 * Hidden entirely when there is no session, because sign out is meaningless on seeded local
 * data and a control that does nothing is worse than no control. Never asks for confirmation:
 * signing back in is one email, and the cost of an accidental tap is far lower than the cost of
 * a dialog people learn to dismiss without reading.
 */
export function wireNav({ storage, client, session }) {
  for (const control of document.querySelectorAll('[data-signout]')) {
    if (!session) {
      control.hidden = true;
      continue;
    }
    control.hidden = false;
    control.addEventListener('click', async (event) => {
      event.preventDefault();
      control.disabled = true;
      control.textContent = 'Signing out';
      await signOutAndClear(storage, client);
      location.replace('auth.html');
    });
  }
}
