// The supabase-js client, loaded once per page.
//
// This is the only file that imports supabase-js, and the only one that reads config.js. Every
// other module takes a client as an argument, so nothing else in the app has an opinion about
// where the library comes from or whether it loaded at all.
//
// The import is dynamic rather than a top level import, because the app has to run with no
// network and a static import would make a failed CDN fetch a blank page instead of an offline
// session. Nothing here is on the path to logging a set.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

// A floating major version, which is a deliberate and uncomfortable trade. Pinning an exact
// version and adding a subresource integrity hash is the correct answer for a static site
// serving other people's training data, because a CDN that serves different bytes tomorrow
// gets to read every session token in localStorage. It is not done yet because a wrong pin is
// a dead app and this has not been verified against the deployed page. Do it before this is
// used by anyone other than us.
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let clientPromise = null;

/** True when config.js actually holds a project, so callers can stay local without guessing. */
export function hasConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_URL.startsWith('https://'));
}

/**
 * The shared client, or null when there is no config or the library could not be fetched.
 * Never throws: no remote is a supported state, not an error.
 */
export function getSupabase() {
  if (!hasConfig()) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import(/* @vite-ignore */ SUPABASE_CDN)
      .then(({ createClient }) =>
        createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: {
            // The session has to survive a reload, because a client opens this app on a gym
            // floor with one hand and will not sign in again between sets.
            persistSession: true,
            autoRefreshToken: true,
            // The magic link comes back as a fragment on whatever page the email opened.
            detectSessionInUrl: true,
            flowType: 'pkce',
          },
        }),
      )
      .catch(() => null);
  }
  return clientPromise;
}
