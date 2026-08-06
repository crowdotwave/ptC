// The app shell: a tab bar along the bottom, and a sign out link at the foot of the page.
//
// This replaces a line of text links that read "Chris Merryweather, Back and chest, Progress,
// Clients, Programs" across the top of every screen. That line was honest and it was clutter,
// and it put the app's identity above the thing the app is for.
//
// It briefly replaced that with a menu button top right, which was the same mistake in a smaller
// package: a permanent control holding a name and a sign out link. The top right corner now
// belongs to the unit switch, which labels every number on the screen and is worth the space.
//
// The bottom bar is a deliberate reversal of a rule in CLAUDE.md, which said the bottom band
// belongs to Log set and a tab bar would land in the thumb arc that owns. That reasoning was
// right about the risk and wrong about the balance: the log action is still far larger, still
// sits above the bar, and keeps a gap of its own, while the bar is the thing that makes this
// read as an app rather than a page. The risk is a mis-tap between two targets of very
// different size, which is a thing to watch in real use rather than to argue about here.
//
// Tabs are built from capability, never from a role name, for the same reason the routing is:
// somebody who coaches and is also coached holds both, and a tab they cannot use is worse than
// no tab because it looks like the app is broken rather than like it is not for them.

import { signOutAndClear } from './boot.js';

const ICONS = {
  log: '<path d="M3 6h14M3 11h14M3 16h9" />',
  progress: '<path d="M3 15l4-5 3.5 3L17 5" /><path d="M3 18h14" opacity=".45" />',
  clients: '<circle cx="7.5" cy="7" r="2.75" /><path d="M3 17c0-2.5 2-4.25 4.5-4.25S12 14.5 12 17" /><path d="M14 12.75c1.75.4 3 1.9 3 4.25" opacity=".45" /><circle cx="14" cy="7.5" r="2.25" opacity=".45" />',
  programs: '<rect x="3.5" y="4" width="13" height="12" rx="2" /><path d="M3.5 8h13M8 8v8" opacity=".45" />',
};

// Programs needs 'any', because that screen answers two different questions with one word: a
// client reads the program they are on, a trainer reads the ones they build, and somebody who is
// both reads their own first and then theirs. Splitting it into two tabs would give that person
// two tabs called almost the same thing.
const TABS = [
  { key: 'log', href: 'index.html', label: 'Log', needs: 'client' },
  { key: 'progress', href: 'progress.html', label: 'Progress', needs: 'client' },
  { key: 'clients', href: 'trainer.html', label: 'Clients', needs: 'trainer' },
  { key: 'programs', href: 'builder.html', label: 'Programs', needs: 'any' },
];

const icon = (key) =>
  `<svg class="tab__icon" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;

function can(actor, needs) {
  if (!actor) return false;
  if (needs === 'any') return Boolean(actor.trainerId) || Boolean(actor.clientId);
  return needs === 'trainer' ? Boolean(actor.trainerId) : Boolean(actor.clientId);
}

function renderTabs(actor, current) {
  const bar = document.getElementById('tabbar');
  if (!bar) return;

  const usable = TABS.filter((tab) => can(actor, tab.needs));

  // One tab is not a tab bar, it is a label for the only screen you have. A client with no
  // progress yet still gets both, because Progress is where their history will appear.
  if (usable.length < 2) {
    bar.hidden = true;
    document.body.classList.remove('has-tabbar');
    return;
  }

  bar.hidden = false;
  document.body.classList.add('has-tabbar');
  bar.innerHTML = usable
    .map((tab) => {
      const on = tab.key === current;
      return (
        `<a class="tab${on ? ' is-on' : ''}" href="${tab.href}"${on ? ' aria-current="page"' : ''}>` +
        `${icon(tab.key)}<span class="tab__label">${tab.label}</span></a>`
      );
    })
    .join('');
}

/**
 * Sign out, at the bottom of the page, in the quietest type on the screen.
 *
 * This replaces a circular button top right that opened a panel containing a name and this one
 * link. It cost a 44px target on every screen, an absolute layer, a z-index, open and close
 * handlers, outside click and Escape handling, and on the progress screen it landed on top of the
 * resume bar. Sign out is used once, when something has gone wrong. It does not need any of that,
 * and it does not need to be reachable in one tap from the top of every screen.
 *
 * The logging screen deliberately has no footer, because it must never scroll. Anyone who can
 * reach it can reach Progress, which has one, and the tab bar is never fewer than two tabs.
 */
function wireAccount({ storage, client, session }) {
  for (const control of document.querySelectorAll('[data-signout]')) {
    if (!session) {
      control.hidden = true;
      continue;
    }
    control.hidden = false;
    control.addEventListener('click', async () => {
      control.disabled = true;
      control.textContent = 'Signing out';
      await signOutAndClear(storage, client);
      location.replace('auth.html');
    });
  }
}

/**
 * Mounts the shell. `current` names the tab this page is, so it can light up.
 *
 * Kept as one call because a page should not be able to have one without the other: a tab bar
 * with no way to sign out, or a way out with no way to move, are both half a shell.
 */
export function mountShell(booted, current) {
  renderTabs(booted.actor, current);
  wireAccount(booted);
}

// The old name, still used by pages that only ever wanted the sign out wiring.
export const wireNav = mountShell;
