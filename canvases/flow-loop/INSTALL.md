# Installing / reinstalling Flow Loop

Flow Loop is a Copilot CLI **user-scope canvas extension**. This folder is a
portable package: entry point `extension.mjs`, all supporting `.mjs` modules,
`README.md`, and `test/`. It has no `node_modules` — the SDK
(`@github/copilot-sdk/extension`) is resolved automatically by the CLI.

## Fresh install (new machine / new account)

1. Share this folder as a gist (from a machine where it's already installed):
   `share_extension({ scope: "user", name: "flow-loop" })` → returns a gist URL.
2. On the target machine, install it:
   `install_extension({ url: "<gist URL>", scope: "user" })`
   — or install directly from a repo folder URL, e.g.
   `install_extension({ url: "https://github.com/cx-demo/agentic-dev-reimagine/tree/<ref>/canvases/flow-loop", scope: "user" })`,
   **but only once this folder has actually been committed and pushed to
   that `<ref>`.** As of this writing `canvases/flow-loop/` in this
   worktree is untracked/uncommitted (see `PACKAGE-INFO.md`), so the
   repo-folder URL form does not yet resolve anywhere — use the gist form,
   or a local archive, until a ref exists.
3. Reload extensions in every open session: `extensions_reload`.
4. Verify: `extensions_manage({ operation: "inspect", name: "flow-loop" })`
   should show `Source: user`, `Status: running`.

Manual alternative: copy this folder to
`~/.copilot/extensions/flow-loop/` (the user extensions directory), then
`extensions_reload`.

## Reinstalling over an existing installation

**Do not blindly overwrite `~/.copilot/extensions/flow-loop/`.** The running
installation may contain locally-patched files (this project has seen
`council.mjs` and `workflow.mjs` diverge from repo source with unreleased
fixes). Before replacing anything:

1. Diff each file: `diff <package>/<file> ~/.copilot/extensions/flow-loop/<file>`.
2. Back up any installed file that differs from the package and isn't yet
   reflected in the package source:
   `cp ~/.copilot/extensions/flow-loop/<file> ~/.copilot/extensions/flow-loop/<file>.bak-$(date +%s)`
3. Copy over only the files you've confirmed are safe to replace (identical,
   or an intentional forward upgrade). Never copy `test/` fixtures or user
   data.
4. `extensions_reload` in every session that has flow-loop open, then
   `extensions_manage({ operation: "inspect", name: "flow-loop" })` to confirm
   it relaunched cleanly (`Status: running`, no error in the log tail).
5. Sanity-check with a read-only canvas action, e.g. open the canvas and call
   `get_config` / `get_state` — these don't touch GitHub issue/workflow state.

## User data

Flow Loop keeps its own runtime state under `~/.flow-loop/` (separate from the
extension code). Installing or reinstalling the extension folder never
touches this directory — do not delete or copy over it.

## Version

Current packaged version: see `manifest.json` (`version`) and the in-app
"About Flow Loop version" panel, both sourced from `CANVAS_RELEASE.version`
in `webview.mjs`.
