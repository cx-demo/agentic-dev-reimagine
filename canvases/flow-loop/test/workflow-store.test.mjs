import assert from "node:assert";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_DEFAULT, LEGACY_DEFAULT, PHASED_DEFAULT, hashDefinition } from "../workflow-def.mjs";
import {
  deleteWorkflow, duplicateWorkflow, listWorkflows, readWorkflow,
  seedDefaults, slugId, writeWorkflow,
} from "../workflow-store.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

const here = dirname(fileURLToPath(import.meta.url));
const workRoot = join(here, "_store-work");

// Exercised against the real definition model, not a stub: the store's whole
// job is to persist something workflow-def considers valid, and a stub with a
// different shape would let that contract drift unnoticed.
const opts = () => ({ dir: workRoot });

const sample = (overrides = {}) => ({
  id: "alpha",
  name: "Alpha",
  rev: 0,
  entry: "one",
  steps: [{
    id: "one", stage: "one", group: "one",
    produce: { by: "agent", capability: "markdown", contract: "Return artifact { body }." },
    artifact: { fields: [{ name: "body", type: "markdown" }] },
    next: null,
  }],
  ...overrides,
});

async function reset() {
  await rm(workRoot, { recursive: true, force: true });
}

await reset();

await test("list tolerates an empty or missing directory", async () => {
  assert.deepStrictEqual(await listWorkflows(opts()), []);
  await mkdir(workRoot, { recursive: true });
  assert.deepStrictEqual(await listWorkflows(opts()), []);
});

await test("write then read round trips a normalized workflow", async () => {
  await reset();
  const saved = await writeWorkflow(sample(), opts());
  assert.equal(saved.rev, 1);
  assert.ok(Date.parse(saved.updatedAt));
  assert.deepStrictEqual(await readWorkflow("alpha", opts()), saved);
  assert.deepStrictEqual(await listWorkflows(opts()), [{
    id: "alpha", name: "Alpha", rev: 1, stageCount: 1, updatedAt: saved.updatedAt,
  }]);
});

await test("successive writes bump rev from the on-disk revision", async () => {
  await reset();
  const one = await writeWorkflow(sample(), opts());
  const two = await writeWorkflow({ ...one, name: "Alpha v2" }, opts());
  assert.equal(two.rev, 2);
  assert.equal((await readWorkflow("alpha", opts())).name, "Alpha v2");
});

await test("expectedRev detects optimistic concurrency conflicts", async () => {
  await reset();
  const one = await writeWorkflow(sample(), opts());
  await assert.rejects(
    () => writeWorkflow({ ...one, name: "Stale" }, { ...opts(), expectedRev: 0 }),
    /changed on disk/i,
  );
  assert.equal((await writeWorkflow({ ...one, name: "Fresh" }, { ...opts(), expectedRev: 1 })).rev, 2);
});

await test("list skips corrupt JSON and invalid definitions", async () => {
  await reset();
  await writeWorkflow(sample(), opts());
  await writeFile(join(workRoot, "broken.json"), "{not json", "utf8");
  await writeFile(join(workRoot, "invalid.json"), JSON.stringify({ id: "bad", name: "", rev: 1, steps: [] }), "utf8");
  await writeFile(join(workRoot, "ignored.txt"), "{not json", "utf8");
  const list = await listWorkflows(opts());
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "alpha");
});

await test("delete reports missing files and refuses the default workflow", async () => {
  await reset();
  assert.equal(await deleteWorkflow("missing", opts()), false);
  await writeWorkflow(sample({ id: "default", name: "Default" }), opts());
  await assert.rejects(() => deleteWorkflow("default", opts()), /default workflow/i);
  assert.ok(await readWorkflow("default", opts()));
});

await test("duplicate creates a distinct unique workflow at rev 1", async () => {
  await reset();
  await writeWorkflow(sample(), opts());
  const copy = await duplicateWorkflow("alpha", opts());
  assert.equal(copy.id, "alpha-copy");
  assert.equal(copy.name, "Alpha (copy)");
  assert.equal(copy.rev, 1);
  const second = await duplicateWorkflow("alpha", { ...opts(), name: "Alpha (copy)" });
  assert.equal(second.id, "alpha-copy-2");
});

await test("seedDefaults is idempotent and never clobbers an edited default", async () => {
  await reset();
  assert.deepStrictEqual(await seedDefaults(opts()), { seeded: true });
  const edited = { ...BUILTIN_DEFAULT, name: "Edited default", rev: 5 };
  await writeFile(join(workRoot, "default.json"), JSON.stringify(edited, null, 2), "utf8");
  assert.deepStrictEqual(await seedDefaults(opts()), { seeded: false });
  assert.equal(JSON.parse(await readFile(join(workRoot, "default.json"), "utf8")).name, "Edited default");
});

await test("the seeded default is the built-in definition", async () => {
  await reset();
  await seedDefaults(opts());
  const seeded = await readWorkflow("default", opts());
  assert.equal(seeded.id, PHASED_DEFAULT.id);
  assert.deepStrictEqual(seeded.steps.map((s) => s.id), PHASED_DEFAULT.steps.map((s) => s.id));
  assert.equal(hashDefinition({ ...seeded, rev: PHASED_DEFAULT.rev }), hashDefinition(PHASED_DEFAULT));
});

await test("unmodified legacy default is promoted without rewriting custom defaults", async () => {
  await reset();
  await seedDefaults(opts());
  await writeFile(join(workRoot, "default.json"), JSON.stringify(LEGACY_DEFAULT), "utf8");
  assert.deepStrictEqual(await seedDefaults(opts()), { seeded: false, migrated: true });
  const promoted = await readWorkflow("default", opts());
  assert.deepStrictEqual(promoted.steps.map((s) => s.id), PHASED_DEFAULT.steps.map((s) => s.id));
  assert.equal(promoted.rev, LEGACY_DEFAULT.rev + 1);
  assert.deepStrictEqual(await seedDefaults(opts()), { seeded: false });
});

await test("unmodified review default is promoted while edited copies remain pinned", async () => {
  await reset();
  await seedDefaults(opts());
  await writeFile(join(workRoot, "default.json"), JSON.stringify(BUILTIN_DEFAULT), "utf8");
  assert.deepStrictEqual(await seedDefaults(opts()), { seeded: false, migrated: true });
  assert.deepStrictEqual((await readWorkflow("default", opts())).steps.map((s) => s.id),
    PHASED_DEFAULT.steps.map((s) => s.id));
});

await test("unmodified pre-audit phased default migrates despite a higher saved revision", async () => {
  await reset();
  await seedDefaults(opts());
  const prior = {
    ...PHASED_DEFAULT,
    rev: 4,
    description: "Plan (research, prototype, draft, synthesize), Build, Review (council, feedback), Finalize, Done.",
    steps: PHASED_DEFAULT.steps.map((step) => step.id === "finalize" ? {
      ...step, phase: "Finalize", label: "Finalize",
      description: "Mark the PR ready and confirm it can merge.",
    } : step),
  };
  await writeFile(join(workRoot, "default.json"), JSON.stringify(prior), "utf8");
  assert.deepEqual(await seedDefaults(opts()), { seeded: false, migrated: true });
  const saved = await readWorkflow("default", opts());
  assert.equal(saved.rev, 5);
  assert.equal(saved.steps.find((step) => step.id === "finalize").phase, "Audit");
  assert.equal(saved.steps.find((step) => step.id === "finalize").issueLabel, "finalizing");
  assert.deepEqual(await seedDefaults(opts()), { seeded: false });
  const edited = { ...prior, name: "Custom workflow" };
  await writeFile(join(workRoot, "default.json"), JSON.stringify(edited), "utf8");
  assert.deepEqual(await seedDefaults(opts()), { seeded: false });
  assert.equal((await readWorkflow("default", opts())).name, "Custom workflow");
});

await test("slugId normalizes names and appends collision suffixes", () => {
  assert.equal(slugId(" My Workflow!! ", []), "my-workflow");
  assert.equal(slugId("My Workflow", ["my-workflow", "my-workflow-2"]), "my-workflow-3");
  assert.equal(slugId("", ["workflow"]), "workflow-2");
  assert.equal(slugId("../evil", []), "evil");
  assert.equal(slugId("a/b", []), "a-b");
});

await test("workflow ids used as filenames reject traversal", async () => {
  await reset();
  await assert.rejects(() => readWorkflow("../evil", opts()), /invalid workflow id/i);
  await assert.rejects(() => readWorkflow("a/b", opts()), /invalid workflow id/i);
  await assert.rejects(() => writeWorkflow(sample({ id: "a/b" }), opts()), /invalid/i);
});

await reset();

console.log(`\n${passed} workflow-store assertions passed`);
