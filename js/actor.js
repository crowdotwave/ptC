// Who the app is acting as, and the one door to the dev role switch.
//
// Resolving an identity now lives in boot.js, because the answer comes from the database
// (public.whoami) rather than from anything this file can see. What stays here is the part that
// was always local: the deletable dev switch, and the override it sets.
//
// The dev switch is loaded dynamically from here and nowhere else. Removing it for good is
// deleting js/dev-role.js and the one block below marked as its only entry point. No page
// imports it, so no page has to be untangled.

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

export function actorOverride() {
  return override;
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

/** Mounts the switch if it is turned on, so its choice is in place before any page reads it. */
export async function mountDevSwitch(storage) {
  // ---- the dev switch, and its only entry point anywhere in the app ----
  if (!devEnabled()) return false;
  const module = await import('./dev-role.js');
  await module.mount(storage);
  return true;
  // ---- end dev switch ----
}
