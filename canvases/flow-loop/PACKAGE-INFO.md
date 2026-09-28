# Package provenance

- **Entry**: `extension.mjs`
- **Canvas ID**: `flow-loop` (registered under extension id `user:flow-loop`)
- **In-app version**: `0.1.5` (see `CANVAS_RELEASE.version` in `webview.mjs`)
- **copilot-extension.json**: `{ "name": "flow-loop", "version": 1 }` — the
  standard install manifest read by gist/repo-folder install flows.

## Provenance (be exact — do not overstate)

This folder is a **verbatim copy of the live, currently-running user
installation** at `~/.copilot/extensions/flow-loop/` on this machine, taken
2026-09-24. It is **not** copied from `canvases/flow-loop/` in the parent
session's dirty checkout (`agent-loop/issue-9`) or from any committed ref on
`cx-demo/agentic-dev-reimagine`.

Reason: at copy time, the installed `council.mjs` and `workflow.mjs` contained
locally-patched, unreleased fixes (Council report / AI-fix changes) that were
**not yet present** in either the repo's `main` branch or the parent
session's working tree. Copying from the installation was the only way to
capture those fixes. All other files were byte-identical across install vs.
parent checkout at copy time.

This package currently lives only in this worktree
(`cx-demo-flow-loop-extension-package` branch) and is **not committed,
pushed, or published to any git ref**. It is untracked working tree content.

## What this means for install methods

- **repo-folder URL install** (`install_extension` with a
  `github.com/.../tree/<ref>/canvases/flow-loop` URL) will **not** work yet —
  it requires the folder to exist at a resolvable, published git ref. This
  package is neither committed nor pushed, so no such ref exists.
- **gist install** (`share_extension` + `install_extension` with a gist URL)
  would work once run, but was intentionally **not performed** for this task
  (no network sharing requested/authorized).
- Until this package is committed to a branch/ref (or shared as a gist), the
  only durable, verifiable copy is the local archive described in the
  session's report (see the assistant's outcome message), plus this working
  directory itself.

## Applied fix (2026-09-25)

`submit_council` was rejecting valid submissions with "patch exceeds 16000
characters" whenever the reviewed PR had any single changed file with a diff
over 16000 chars — independent of finding count/size. Root cause:
`buildCouncilPacket` (council.mjs) enforces a per-file `MAX_PATCH` cap meant
to bound the reviewer LLM's kickoff prompt, but `submitCouncil` (workflow.mjs)
reused the same throwing builder purely to re-check findings against the real
diff (known-file / snippet-in-patch checks) — no LLM involved at that point.

Fix: `buildCouncilPacket(input, { enforcePatchLimits })` — defaults to `true`
(unchanged behavior at kickoff, still bounds the reviewer prompt).
`submitCouncil`'s re-validation call now passes `enforcePatchLimits: false`,
so a PR that was reviewable at kickoff stays submittable regardless of
individual diff size. No security/correctness check was removed — only the
prompt-budget guard, and only on the submission path. Backed up originals as
`council.mjs.bak-<timestamp>` / `workflow.mjs.bak-<timestamp>` in the
installation before editing. All 18 test suites pass (added a regression
case in `test/council.test.mjs`). Bumped in-app version `0.1.4` → `0.1.5`
(`CANVAS_RELEASE` in `webview.mjs`).

## Do not

- Do not overwrite `~/.copilot/extensions/flow-loop/` from this package
  without diffing every file first (see `INSTALL.md`).
- Do not delete or copy over `~/.flow-loop/` (runtime user data).
