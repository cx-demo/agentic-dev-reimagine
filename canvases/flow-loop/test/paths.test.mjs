// Data-root migration tests.
//
// The migration is invoked with explicit roots rather than derived from HOME, so
// these run entirely inside a scratch directory. That matters: an earlier version
// ran the move at import time and quietly migrated the real ~/.agent-loop the
// first time the suite was executed.

import assert from "node:assert";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { migrateLegacyDataRoot, DATA_ROOT, LEGACY_DATA_ROOT, PINS_DIR, WORKFLOWS_DIR, WORK_ROOT, ACTIVE_FILE } from "../paths.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = join(here, "_paths-work");
const roots = { dataRoot: join(sandbox, "new"), legacyRoot: join(sandbox, "old") };

async function reset() {
  await rm(sandbox, { recursive: true, force: true });
  await mkdir(sandbox, { recursive: true });
}

async function seedLegacy() {
  await mkdir(join(roots.legacyRoot, "pins"), { recursive: true });
  await mkdir(join(roots.legacyRoot, "workflows"), { recursive: true });
  await mkdir(join(roots.legacyRoot, "work", "o", "r", "7", "round-1", "a"), { recursive: true });
  await writeFile(join(roots.legacyRoot, "workflows", "default.json"), '{"id":"default"}');
  await writeFile(join(roots.legacyRoot, "pins", "o--r--7.json"), '{"id":"custom"}');
  await writeFile(join(roots.legacyRoot, "work", "o", "r", "7", "round-1", "a", "index.html"), "<h1>proto</h1>");
  await writeFile(join(roots.legacyRoot, "active.json"), '{"issue":7}');
}

await test("the derived locations all hang off ~/.flow-loop", () => {
  assert.equal(DATA_ROOT, join(homedir(), ".flow-loop"));
  assert.equal(LEGACY_DATA_ROOT, join(homedir(), ".agent-loop"));
  for (const [name, p] of [["pins", PINS_DIR], ["workflows", WORKFLOWS_DIR], ["work", WORK_ROOT], ["active.json", ACTIVE_FILE]]) {
    assert.equal(p, join(DATA_ROOT, name), `${name} lives under the data root`);
  }
});

await test("importing paths.mjs does not touch the filesystem", () => {
  // The regression this file exists for: no root may be created merely by import.
  assert.ok(!existsSync(roots.dataRoot) && !existsSync(roots.legacyRoot));
});

await test("a legacy root is moved across with its contents", async () => {
  await reset();
  await seedLegacy();
  const r = migrateLegacyDataRoot(roots);
  assert.equal(r.migrated, true, JSON.stringify(r));
  assert.ok(!existsSync(roots.legacyRoot), "the legacy root is moved, not copied");
  // The pin is the local trust anchor; losing it fails an in-flight custom run closed.
  assert.equal(await readFile(join(roots.dataRoot, "pins", "o--r--7.json"), "utf8"), '{"id":"custom"}');
  assert.equal(await readFile(join(roots.dataRoot, "workflows", "default.json"), "utf8"), '{"id":"default"}');
  assert.equal(await readFile(join(roots.dataRoot, "active.json"), "utf8"), '{"issue":7}');
  assert.equal(await readFile(join(roots.dataRoot, "work", "o", "r", "7", "round-1", "a", "index.html"), "utf8"), "<h1>proto</h1>",
    "work assets survive, so previews recorded on an issue still resolve");
});

await test("migration is a no-op when there is nothing to migrate", async () => {
  await reset();
  const r = migrateLegacyDataRoot(roots);
  assert.equal(r.migrated, false);
  assert.ok(!existsSync(roots.dataRoot), "no root is created just by asking");
});

await test("an existing new root is never overwritten by a legacy one", async () => {
  await reset();
  await seedLegacy();
  await mkdir(join(roots.dataRoot, "workflows"), { recursive: true });
  await writeFile(join(roots.dataRoot, "workflows", "default.json"), '{"id":"current"}');
  const r = migrateLegacyDataRoot(roots);
  assert.equal(r.migrated, false, "the guard is one-way");
  assert.equal(await readFile(join(roots.dataRoot, "workflows", "default.json"), "utf8"), '{"id":"current"}');
  assert.ok(existsSync(roots.legacyRoot), "the legacy root is left alone rather than merged or deleted");
});

await test("migration is idempotent", async () => {
  await reset();
  await seedLegacy();
  assert.equal(migrateLegacyDataRoot(roots).migrated, true);
  assert.equal(migrateLegacyDataRoot(roots).migrated, false, "a second call must not migrate again");
  assert.equal(await readFile(join(roots.dataRoot, "active.json"), "utf8"), '{"issue":7}');
});

await test("a failed move is reported, not thrown", async () => {
  await reset();
  await writeFile(join(sandbox, "not-a-dir"), "x");
  await mkdir(join(sandbox, "legacy-present"), { recursive: true });
  const r = migrateLegacyDataRoot({ dataRoot: join(sandbox, "not-a-dir", "child"), legacyRoot: join(sandbox, "legacy-present") });
  assert.equal(r.migrated, false, "the canvas must still start when the move cannot happen");
  assert.ok(r.error, "and the reason is reported rather than swallowed");
});

// startServer owns the call, so the wiring is part of the contract.
await test("startServer performs the migration, and import does not", async () => {
  assert.match(await readFile(join(here, "..", "server.mjs"), "utf8"), /migrateLegacyDataRoot\(\)/,
    "startServer invokes the migration");
  assert.ok(!/^export const LEGACY_MIGRATION/m.test(await readFile(join(here, "..", "paths.mjs"), "utf8")),
    "paths.mjs must not migrate at import time");
});

await rm(sandbox, { recursive: true, force: true });
console.log(`\n${passed} paths assertions passed`);
