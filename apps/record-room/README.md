# Record Room

Record Room is a text-first music search and local playlist app based on the
approved Record Room prototype for issue #9. It collects track metadata; it does
not play audio, sign into a music service, or sync playlists across devices.

## Run

From the repository root, run `node apps/record-room/server.mjs`, then open
`http://127.0.0.1:4173/`. Node 20+ is required for built-in `fetch` and
`AbortSignal.timeout`. The server binds only to `127.0.0.1`; port 4173 is stable
so browser storage remains available across restarts at that address. If the
port is occupied, startup fails rather than changing the app's storage origin.

Search uses Apple's iTunes Search API for US song metadata with explicit
content excluded. Searches are spaced by at least 3.1 seconds and limited to
12 results; repeat queries can use a short in-memory cache. Provider availability
and catalog data may change. No artwork, song clips, credentials, or music files
are downloaded or stored. Store links open Apple Music in a separate tab.

Playlist name and ordered track metadata are saved to browser storage at the
app's origin. Export JSON for a portable backup, and import a valid JSON backup
to replace the current list. Data from another origin or browser does not sync.
If storage is unavailable, the list works only until the page closes; the app
reports this explicitly.

## Flow Loop preview

Run `node apps/record-room/build-preview.mjs` to write the demo to the
code-stamped issue/round preview path. Keep the local server running for search
within the preview: the preview calls its read-only catalog endpoint across
origins. The embedded preview is sandboxed, so storage, downloads, and outbound
store links may be blocked; open the preview in a separate tab to use those
features. The preview inlines the same app modules and stylesheet into one HTML
file so scripts can run in the sandbox's opaque origin. Only the API origin marker
differs from the committed entrypoint.

## Checks

Run `node --test apps/record-room/test/*.test.mjs`. Tests stub catalog requests;
they do not call Apple's live API.
