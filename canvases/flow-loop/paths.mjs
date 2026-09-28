// Shared filesystem locations for the Flow Loop canvas.
//
// Extracted into their own module so that both server.mjs and workflow-store.mjs
// can import them without server.mjs and workflow-store.mjs importing each other:
// workflow-store used to read DATA_ROOT from server.mjs while server.mjs imports
// the coordinator, and the pin store closes that loop. Constants have no
// behaviour, so they are the right thing to hoist out of the cycle.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, renameSync } from "node:fs";

export const DATA_ROOT = join(homedir(), ".flow-loop");
export const LEGACY_DATA_ROOT = join(homedir(), ".agent-loop");

// One-time move from the pre-rename location.
//
// Deliberately NOT run at import: this mutates the user's home directory, and an
// import-time side effect fires in any process that merely loads this module —
// including the test suite, which is how it first ran by accident. startServer is
// the one place that already owns creating these directories, so it owns this too.
//
// Safe because nothing durable points here: every path recorded on an issue is
// RELATIVE to the work root, so moving the root rewrites no history. The guard is
// one-way — it only fires when the new root is absent and the old one exists — so
// a user who later recreates the old path for something else never has it
// swallowed.
//
// Losing this move would be quiet but not harmless: the pins below are the local
// trust anchor, and without them an in-flight run on a custom workflow fails
// closed rather than falling back.
export function migrateLegacyDataRoot({ dataRoot = DATA_ROOT, legacyRoot = LEGACY_DATA_ROOT } = {}) {
  if (existsSync(dataRoot) || !existsSync(legacyRoot)) return { migrated: false };
  try {
    renameSync(legacyRoot, dataRoot);
    return { migrated: true, from: legacyRoot, to: dataRoot };
  } catch (e) {
    // A cross-device link or a permission problem must not stop the canvas from
    // starting; the run simply begins with an empty root.
    return { migrated: false, error: String((e && e.message) || e) };
  }
}

export const ACTIVE_FILE = join(DATA_ROOT, "active.json");
export const WORK_ROOT = join(DATA_ROOT, "work");
export const WORKFLOWS_DIR = join(DATA_ROOT, "workflows");

// Per-issue pins of the exact definition a run executes. This is the local trust
// anchor: the issue comment that references a definition is editable by anyone
// with write access, so the machine records what it actually started under here.
export const PINS_DIR = join(DATA_ROOT, "pins");
