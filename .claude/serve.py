# The dev server for this app, which is `python -m http.server` plus exactly one header.
#
# This app has no build step, so a change to js/program.js is live the moment the file is saved
# and the page is reloaded. That is the whole point of the setup, and it is also what makes stale
# caching so expensive here: there is no bundler emitting a new filename to break the cache, so a
# module keeps its URL forever and the browser is free to reuse what it already has.
#
# SimpleHTTPRequestHandler sends Last-Modified and no Cache-Control at all, which leaves the
# browser on its heuristic and means an edited module can keep loading from cache across a
# reload. What that looks like from the outside is not a cache problem, which is why it is worth
# a file: an edit that appears to do nothing, or a page that hangs on "Running" because a fresh
# test.js imported a named export from a cached program.js that did not have it yet. Both of
# those were diagnosed as code faults first.
#
# no-store rather than no-cache, because no-cache still stores and revalidates, and there is
# nothing to gain from a conditional request against a local file.

import http.server


class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()


if __name__ == '__main__':
    # Serves the working directory, which is the repo root, exactly as `-m http.server` did.
    http.server.test(HandlerClass=NoStore, port=8123, bind='127.0.0.1')
