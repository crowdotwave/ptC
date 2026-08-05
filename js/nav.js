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
export function wireNav({ storage, client, session, actor }) {
  // Links declare what they need with data-needs. Somebody who both coaches and is coached sees
  // every link, a plain client sees only theirs, and neither case needs a page to know which is
  // which. Absent rather than disabled: a link to a screen that will bounce you is worse than no
  // link, because it looks like the app is broken rather than like it is not for you.
  for (const link of document.querySelectorAll('[data-needs]')) {
    const needs = link.dataset.needs;
    const has = needs === 'trainer' ? Boolean(actor?.trainerId) : Boolean(actor?.clientId);
    link.hidden = !has;
  }

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
