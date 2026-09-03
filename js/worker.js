// Registering the service worker, and nothing else.
//
// Its own file because of who has to call it. The sign in screen is the first page anybody in this
// app ever loads, and it is the one page that does not boot the app: auth-page.js imports the
// library and the auth helpers, not js/boot.js, so for as long as this lived in boot.js the worker
// was installed no earlier than the first load of index.html, which happens after a person has
// already signed in.
//
// That ordering is what put GitHub's own 503 page in front of a client trying to sign in. Pages is
// fronted by a CDN and one unhealthy edge serves an error while the status page stays green. There
// was nothing on her phone to fall back to, because the only thing that could have put something
// there had never been given the chance to run. Importing boot.js from the sign in screen to fix
// that would pull the storage adapter, the seed and the whole module graph onto the one screen that
// needs none of it.
//
// Failure is ignored on purpose. No worker means no offline loading, which is where this app was
// until recently, and there is nothing a person holding a phone could do about it anyway. file://
// has no service workers at all, and neither does a private window in some browsers.

/**
 * Installs the service worker, whose entire job is making the app open when the network or the
 * host will not answer.
 *
 * Resolved against this module rather than the page, so every page registers the same worker at
 * the same scope, and so a deploy under a subpath (which is what GitHub Pages is: /ptC/) works the
 * same as one at a domain root. Registering 'sw.js' relative to the page would work only while
 * every page sits in one directory.
 */
export function installWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!location.protocol.startsWith('http')) return;
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
}
