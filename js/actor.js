// Who the app is acting as. This seam is permanent.
//
// Today it resolves to the seeded default, or to whatever the dev role switch selected. At
// step 4 the body of resolveActor becomes a Supabase auth lookup and every caller stays the
// same, because no page ever asks "which client am I" any other way.
//
// The dev switch is loaded dynamically from here and nowhere else. Removing it for good is
// deleting js/dev-role.js and the one block below marked as its only entry point. No page
// imports it, so no page has to be untangled.

import { getDefaultClientId } from './seed.js';

const DEV_PARAM = 'dev';
const DEV_ON_KEY = 'ptc.dev.on';

let override = null;

/**
 * Called by the dev switch. Nothing else should call it, and when the switch is gone this is
 * dead code that costs three lines.
 */
export function setActorOverride(actor) {
  override = actor;
}

/**
 * Off unless asked for. `?dev=1` turns it on for the rest of the browser session, `?dev=0`
 * turns it off, so the client app never shows it and it is still reachable on a deployed
 * build rather than only on a machine running a local server.
 */
export function devEnabled() {
  try {
    const param = new URLSearchParams(location.search).get(DEV_PARAM);
    if (param === '1') sessionStorage.setItem(DEV_ON_KEY, '1');
    if (param === '0') sessionStorage.removeItem(DEV_ON_KEY);
    return sessionStorage.getItem(DEV_ON_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Resolves the acting identity, mounting the dev switch first if it is turned on so its
 * choice is already in place before any page reads this.
 *
 * Returns { role, clientId, trainerId }.
 */
export async function initActor(storage) {
  // ---- the dev switch, and its only entry point anywhere in the app ----
  if (devEnabled()) {
    const module = await import('./dev-role.js');
    await module.mount(storage);
  }
  // ---- end dev switch ----

  return resolveActor(storage);
}

export async function resolveActor(storage) {
  if (override) return override;

  // No auth yet, so the client app opens as the seeded default. This is the part that becomes
  // a session lookup at step 4.
  const clientId = await getDefaultClientId(storage);
  const client = clientId ? await storage.get('clients', clientId) : null;
  return {
    role: 'client',
    clientId: client ? client.id : null,
    trainerId: client ? client.trainer_id : null,
  };
}
