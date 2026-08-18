// The service worker. It exists for one reason: so the app opens with no network.
//
// CLAUDE.md has said from the start that this must be fully usable offline, and it was not. Every
// write already lands in IndexedDB first and the logging screen never waits on the network, so the
// app was offline capable in every respect except the one that comes first: fetching the page. A
// client in a basement got a browser error, and none of the local first machinery behind it ever
// got the chance to run.
//
// What this is NOT: it does not sync in the background. The Background Sync API is not implemented
// in WebKit, so on the phones this app is actually used on there is no such thing as flushing the
// outbox while the app is closed. Anyone reading this file expecting that will not find it and
// should not add it here. Getting sets off the phone sooner is js/storage.js push() and the
// listeners in js/boot.js, which run in the page.
//
// Network first, cache as the fallback, and nothing precached. Three consequences, all wanted:
//
//   - A deploy is picked up on the next load, with no version to bump. This repo has no build
//     step, so a versioned precache would mean a human remembering to edit a constant, and the
//     failure when they forget is every client pinned to old code forever with nothing on screen
//     to say so. A stale cache that self heals beats a fresh one that depends on discipline.
//   - The module graph stays consistent. Offline, every request misses and is served from cache,
//     so a page gets one coherent set of files. Online, every request is served from the network,
//     likewise. Only losing the network partway through one page load mixes them, and a reload
//     fixes that. An unbundled ES module graph served half from each version is the failure mode
//     worth designing against: see .claude/serve.py for what that looks like from the outside.
//   - It is not a speed optimisation and is not meant to be. The network is still asked first
//     every time.
//
// A page has to have been loaded online once for it to be available offline, which is the whole of
// the cost of not precaching. Signing in and receiving a program both require a network, so by the
// time somebody is training the pages they train with have been fetched.

const CACHE = 'ptc-runtime';

// The one cross origin thing worth keeping. supabase-js is a dynamic import, and js/boot.js reads
// getSupabase() returning null as a device that may not be signed in. Offline without this cached,
// the app cannot tell an expired session from an unreachable CDN, which is why boot.js grew
// staysSignedIn to answer that from disk instead. Caching the library keeps that guard a backstop
// rather than the normal path: with the library present the session is read from local storage and
// the ordinary signed in route is taken, offline and all.
const LIBRARY_ORIGIN = 'https://cdn.jsdelivr.net';

self.addEventListener('install', (event) => {
  // Nothing to precache, so there is nothing to wait for. Taking over immediately is safe here in
  // a way it would not be for a versioned bundle: this worker pins no particular copy of anything.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Anything this worker did not write, including caches from an earlier shape of this file.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      // So the first visit is covered rather than the second. Without this the page that installed
      // the worker runs uncontrolled and a client who signs in and immediately walks into a gym
      // has cached nothing.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Reads only. A POST is a write to Supabase, and the outbox is what makes those survive being
  // offline, not this.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const mine = url.origin === self.location.origin;
  const library = url.origin === LIBRARY_ORIGIN;

  // Everything else is left entirely alone, and that emphatically includes Supabase itself. A
  // cached REST response would be somebody's training data served after it stopped being true, and
  // a cached auth response would be worse. Not intercepting is the only way to be sure.
  if (!mine && !library) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        // Only what actually arrived. Caching a 404 or a 500 would serve that error back offline
        // long after the file it was about had been deployed.
        if (response.ok) {
          const copy = response.clone();
          // Not awaited: the page gets its bytes now and the cache catches up. A failed write here
          // costs a future offline load, never this one.
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      } catch (offline) {
        // ignoreSearch, because a query string never changes what this server returns: every file
        // here is static. Matching on the full URL meant index.html?local=1 missed the index.html
        // sitting in the cache, and the same would go for auth.html?next=, for a link somebody
        // shared with a tracking parameter on it, and for any cache buster ever appended to a
        // module. Each of those would be a fresh miss and, offline, a browser error over a file
        // that is already on the device.
        const hit = await caches.match(request, { ignoreSearch: true });
        if (hit) return hit;
        // Nothing cached and nothing reachable. Rethrowing gives the browser's own error, which is
        // what would have happened with no worker installed at all: this file's job is to make
        // offline work where it can, not to invent a page saying that it could not.
        throw offline;
      }
    })(),
  );
});
