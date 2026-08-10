// One way in, for every page.
//
// Opens the database, works out who is looking, attaches the remote if there is a session, and
// hands back a storage adapter that is ready to use. Pages call boot() and read the mode. They
// do not ask about sessions, and they never import supabase.js or remote.js.
//
// Four modes, and each one is a real state rather than a failure:
//
//   connected   a session, and the database says which trainer or client it belongs to
//   local       no backend, seeded fake data, reached with ?local=1
//   signed-out  no session, so the page should send the person to auth.html
//   unbound     a session that resolves to neither a trainer nor a client

import { openStorage } from './storage.js';
import { getSupabase, hasConfig } from './supabase.js';
import { currentSession, signOut } from './auth.js';
import { createRemote } from './remote.js';
import { seed, isSeeded, getDefaultClientId } from './seed.js';
import { publishSync } from './sync-status.js';

// What the local database currently holds. Either 'local' for seeded fake data, or the auth
// user whose rows are mirrored here.
const IDENTITY_KEY = 'ptc.identity';

// The last answer whoami gave. Read when the network is gone, which on a gym floor is most of
// the time, so that a client who has signed in once can open the app in a basement.
const ACTOR_KEY = 'ptc.actor';

/**
 * A URL flag that sticks for the rest of the browser session.
 *
 * Sticky because it chooses which dataset the app is looking at, and that has to survive
 * following a link. A flag that only lived in the query string would drop you onto the sign in
 * screen the moment you went from the logging screen to Progress, which reads as the app
 * forgetting who you are. `?local=0` turns it back off.
 */
function stickyFlag(name) {
  const key = `ptc.flag.${name}`;
  try {
    const param = new URLSearchParams(location.search).get(name);
    if (param === '1') sessionStorage.setItem(key, '1');
    if (param === '0') sessionStorage.removeItem(key);
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * Wipes the local database when the person it belongs to changes.
 *
 * This is not tidiness. A browser that mirrored one client's training and then signs in as
 * somebody else would answer every local query with the previous person's rows, and RLS cannot
 * help with that because RLS is on the server and this read never leaves the device. Seeded
 * fake data counts as a different person for the same reason: it is somebody's history as far
 * as every chart is concerned.
 */
async function alignIdentity(storage, identity) {
  const stored = await storage.getMeta(IDENTITY_KEY);
  if (stored === identity) return false;
  if (stored !== null) await storage._clearAll();
  await storage.setMeta(IDENTITY_KEY, identity);
  return true;
}

// Where each role belongs when it turns up somewhere it does not. The client logging screen and
// the trainer view are different products sharing a deploy, not two tabs of one thing.
const HOME = { trainer: 'trainer.html', client: 'index.html' };

/**
 * Capability, not role. A person can hold both: somebody who coaches and is also coached has a
 * trainers row and a clients row bound to one auth user, and public.whoami() reports 'both'.
 *
 * Asking "do you have a client id" rather than "are you a client" is what keeps that person able
 * to reach their own training. Comparing a single role string would have picked one and silently
 * locked them out of the other half of the app.
 */
export function can(actor, role) {
  if (!actor) return false;
  return role === 'trainer' ? Boolean(actor.trainerId) : Boolean(actor.clientId);
}

/** Where to send somebody who cannot be here. Their own training first, if they have any. */
function homeFor(actor) {
  if (can(actor, 'client')) return HOME.client;
  if (can(actor, 'trainer')) return HOME.trainer;
  return null;
}

function misrouted(role, actor) {
  if (!role || !actor || can(actor, role)) return false;
  return Boolean(homeFor(actor));
}

export async function boot({ allowLocal = true, role = null } = {}) {
  const storage = await openStorage();
  const client = await getSupabase();
  const session = await currentSession(client);

  // No session. Either run on fake data because somebody asked for it, or say so and let the
  // page redirect. Never quietly show a seeded trainer to a person who expected their own data.
  if (!session) {
    const wantsLocal = stickyFlag('local') || !hasConfig() || !client;
    if (!wantsLocal || !allowLocal) {
      return { mode: 'signed-out', storage, client, session: null, actor: null, error: null };
    }
    await alignIdentity(storage, 'local');
    if (!(await isSeeded(storage))) await seed(storage);
    const clientId = await getDefaultClientId(storage);
    const row = clientId ? await storage.get('clients', clientId) : null;

    // Opens as the seeded client, which is the only account in this app with enough history to
    // draw a chart. Real accounts have a handful of sets between them, so this is what the
    // progress screens are still developed against.
    const localActor = {
      role: 'client',
      clientId: row?.id ?? null,
      trainerId: null,
      isStaff: false,
    };
    // Routed exactly like a real session, so this exercises the app people use rather than a
    // variant of it.
    const localMode = misrouted(role, localActor) ? 'wrong-role' : 'local';
    return { mode: localMode, storage, client, session: null, actor: localActor, error: null };
  }

  const wiped = await alignIdentity(storage, `auth:${session.user.id}`);
  const remote = createRemote({ client, storage });
  storage.setRemote(remote);

  let actor = null;
  let error = null;
  try {
    const who = await remote.whoami();
    if (who.role === 'none') {
      return { mode: 'unbound', storage, client, session, actor: null, error: null };
    }
    actor = {
      role: who.role,
      clientId: who.clientId,
      trainerId: who.trainerId,
      isStaff: who.isStaff,
    };
    await storage.setMeta(ACTOR_KEY, actor);
  } catch (whoamiError) {
    // Offline, or the server is down. A device that has signed in before knows the answer.
    actor = await storage.getMeta(ACTOR_KEY);
    error = actor ? null : whoamiError.message;
  }

  // A device with nothing on it has nothing to show, so the first sync is worth waiting for.
  // Every later one runs behind whatever is already on screen.
  const counts = await storage.counts();
  const empty = wiped || Object.values(counts).every((n) => n === 0);
  // Published either way. The result of the sync a page does not wait for is exactly the result
  // that used to vanish, and it is the one carrying the news that this device has stopped
  // talking to the server.
  const first = storage.sync().then((result) => {
    publishSync(result);
    return result;
  });
  if (empty) {
    const result = await first;
    if (result.error && !error) error = result.error;
  } else {
    first.catch(() => {});
  }

  // A trainer opening the client logging screen is a routing mistake, not a state to explain.
  // Telling somebody to "open the trainer view" with no way to open it is how you end up
  // reading URLs out loud to a person holding a phone.
  if (misrouted(role, actor)) {
    return { mode: 'wrong-role', storage, client, session, actor, error };
  }

  return { mode: 'connected', storage, client, session, actor, error };
}

/**
 * The routing every page does before it renders. Returns false when the page should stop, so a
 * caller reads as `if (!gate(result)) return;` and nothing after it runs against a null actor.
 */
export function gate(result) {
  if (result.mode === 'signed-out') {
    const here = location.pathname.split('/').pop() + location.search;
    location.replace(`auth.html?next=${encodeURIComponent(here)}`);
    return false;
  }
  if (result.mode === 'wrong-role') {
    location.replace(homeFor(result.actor));
    return false;
  }
  return true;
}

/**
 * Sign out, then wipe. The wipe is the part that matters: this app is opened on phones that get
 * handed to a training partner, and a mirror of somebody's training left behind after they
 * signed out is a privacy failure that no amount of row level security can reach.
 *
 * Anything still in the outbox is lost. That is the correct trade, because the alternative is
 * keeping a signed out person's unsynced sets on a device that now belongs to somebody else.
 */
export async function signOutAndClear(storage, client) {
  await signOut(client);
  await storage._clearAll();
}
