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
// Network first, cache as the fallback, and the whole app warmed on install. Three consequences,
// all wanted:
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
// This file used to precache nothing, and the note here called the gap that left a known one: a
// device only ever held the pages it had already been to, so a first sign in had auth.html on it
// and nothing else, and the hop straight after a code was verified had nothing to fall back to.
//
// It was worse than that in practice, because js/worker.js was not called from the sign in screen
// at all. So the FIRST load, on a phone that has never been here, ran with no worker and an empty
// cache, and GitHub answered it with its 503 unicorn page. A client trying to sign in got that
// instead of this app, and there was no version of these rules under which she would not have.
//
// Both halves are closed now: the worker installs from the sign in screen, and it warms the whole
// shell rather than one page. One successful load of any page in this app now leaves every page of
// it on the device. Nothing about the freshness argument above changes, because SHELL carries no
// versions and pins nothing: every request still goes to the network first and the warm copies are
// only ever a fallback, refreshed by every successful fetch.

const CACHE = 'ptc-runtime';

// The one cross origin thing worth keeping. supabase-js is a dynamic import, and js/boot.js reads
// getSupabase() returning null as a device that may not be signed in. Offline without this cached,
// the app cannot tell an expired session from an unreachable CDN, which is why boot.js grew
// staysSignedIn to answer that from disk instead. Caching the library keeps that guard a backstop
// rather than the normal path: with the library present the session is read from local storage and
// the ordinary signed in route is taken, offline and all.
const LIBRARY_ORIGIN = 'https://cdn.jsdelivr.net';

// Every file the five shipped pages reach for, which is what has to be on the device for any of
// them to open when the host will not answer. The dev pages are deliberately absent: test.html,
// dev.html, emom-test.html and local.html are ours, and a client's phone should not carry them.
//
// Written out by hand because there is no build step to generate it, and kept honest by a test
// rather than by discipline: test.js walks the same graph these pages actually import and fails
// when this list has fallen behind. A missing entry is not a broken app, since the runtime caching
// below stores whatever a page successfully fetched, but it is a file a first sign in would not
// have when the host answers with an error, which is the failure this list exists for.
const SHELL = [
  'index.html',
  'auth.html',
  'progress.html',
  'trainer.html',
  'builder.html',
  'app.js',
  'auth-page.js',
  'progress.js',
  'trainer.js',
  'builder.js',
  'config.js',
  'styles.css',
  'manifest.webmanifest',
  'apple-touch-icon.png',
  'js/auth.js',
  'js/boot.js',
  'js/charts.js',
  'js/consistency-view.js',
  'js/consistency.js',
  'js/dates.js',
  'js/emom-view.js',
  'js/emom.js',
  'js/feel.js',
  'js/history.js',
  'js/hold.js',
  'js/import-program.js',
  'js/import-ui.js',
  'js/lift-picker.js',
  'js/nav.js',
  'js/plan.js',
  'js/prefill.js',
  'js/program-view.js',
  'js/program.js',
  'js/progression.js',
  'js/remote.js',
  'js/schema.js',
  'js/seed.js',
  'js/session-readout.js',
  'js/session-view.js',
  'js/session-volume.js',
  'js/session.js',
  'js/snapshot.js',
  'js/split-palette.js',
  'js/storage-indexeddb.js',
  'js/storage.js',
  'js/supabase.js',
  'js/sync-status.js',
  'js/track.js',
  'js/units.js',
  'js/worker.js',
  'js/workout-view.js',
  'js/xlsx.js',
];

/**
 * Fills the cache with the shell, one file at a time and forgiving every failure.
 *
 * Not cache.addAll, which rejects the whole batch if a single entry 404s: one stale line in SHELL
 * would then mean a device with nothing cached at all, which is the state this is here to end.
 * Whatever arrives is stored and whatever does not is left to the runtime caching below.
 *
 * `cache: 'reload'` so these come from the network rather than from an HTTP cache that may be
 * holding the copies this deploy replaced. Wrapped, because a Request built with that option is
 * not supported everywhere and a warm cache is worth more than a perfectly fresh one.
 */
async function warm() {
  const cache = await caches.open(CACHE);
  await Promise.allSettled(
    SHELL.map(async (path) => {
      const url = new URL(path, self.location.href).href;
      let response;
      try {
        response = await fetch(url, { cache: 'reload' });
      } catch {
        response = await fetch(url);
      }
      if (response.ok) await cache.put(url, response);
    }),
  );
}

self.addEventListener('install', (event) => {
  // Taking over immediately is safe here in a way it would not be for a versioned bundle: this
  // worker pins no particular copy of anything, so a page half loaded from the network and half
  // from this cache is still one coherent deploy.
  //
  // The warm up is awaited so the worker stays alive until it finishes, and it is allowed to fail:
  // an install that threw would leave the device with no worker at all, which is strictly worse
  // than one with a partly filled cache.
  event.waitUntil(Promise.all([self.skipWaiting(), warm().catch(() => {})]));
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

/**
 * The copy on the device, if this page has ever been fetched successfully. Shared by the two
 * places that fall back to it, a server error and no network at all, so the rule below is stated
 * once.
 *
 * ignoreSearch, because a query string never changes what this server returns: every file here is
 * static. Matching on the full URL meant index.html?local=1 missed the index.html sitting in the
 * cache, and the same would go for auth.html?next=, for a link somebody shared with a tracking
 * parameter on it, and for any cache buster ever appended to a module. Each of those would be a
 * fresh miss and, offline, a browser error over a file that is already on the device.
 */
function cached(request) {
  return caches.match(request, { ignoreSearch: true });
}

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
          return response;
        }

        // A server error is not an answer about this file, so the copy on the device is still the
        // best one there is. A 5xx does not throw, so before this branch existed the catch below
        // never ran, the cache was never asked, and the error body was returned as though it were
        // the file: a client signing in got GitHub's own 500 page filling a standalone home screen
        // app, with no URL bar to reload from. Pages is fronted by a CDN, and one unhealthy edge
        // serves a few people an error while the status page stays green. From in here that is
        // indistinguishable from being offline, so it is answered the same way.
        //
        // 5xx only. A 404 still passes straight through, because that one IS an answer about the
        // file: it is not in the deploy any more, and serving a cached copy over it is how a
        // device stays pinned to a module that no longer exists.
        if (response.status >= 500) {
          const stale = await cached(request);
          if (stale) return stale;
        }
        return response;
      } catch (offline) {
        const hit = await cached(request);
        if (hit) return hit;
        // Nothing cached and nothing reachable. Rethrowing gives the browser's own error, which is
        // what would have happened with no worker installed at all: this file's job is to make
        // offline work where it can, not to invent a page saying that it could not.
        throw offline;
      }
    })(),
  );
});
