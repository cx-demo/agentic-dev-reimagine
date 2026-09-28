// Workflow definition model tests.
//
// The built-in definition is the compatibility contract for every build that
// already exists, so the assertions that matter most here are the ones tying it
// back to the hardcoded vocabulary it replaces.

import assert from "node:assert";
import {
  BUILTIN_DEFAULT, LEGACY_DEFAULT, DEFINITION_VERSION, normalizeDefinition, validateDefinition,
  assertValidDefinition, hashDefinition, canonicalize, stepById, stepForIssueLabel,
  stagesOf, labelDefinitions,
} from "../workflow-def.mjs";
import { RULES, GATE_WIDGETS, CAPABILITY_NAMES, FIELD_TYPE_NAMES, parseOutcome } from "../workflow-primitives.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

// A minimal definition every negative test can perturb one field at a time.
function base(overrides = {}) {
  return {
    id: "sample", name: "Sample", entry: "one",
    steps: [
      {
        id: "one", stage: "one", group: "one",
        produce: { by: "agent", capability: "markdown", contract: "Return artifact { body }." },
        artifact: { fields: [{ name: "body", type: "markdown" }] },
        validate: [{ rule: "minLength", field: "body", value: 5 }],
        next: "two",
      },
      { id: "two", stage: "two", group: "two", produce: { by: "none", capability: "none" }, next: null },
    ],
    ...overrides,
  };
}

await test("normalize fills defaults without inventing structure", () => {
  const d = normalizeDefinition({ id: "x", steps: [{ id: "only-step" }] });
  assert.equal(d.version, DEFINITION_VERSION);
  assert.equal(d.name, "x");
  assert.equal(d.rev, 1);
  assert.equal(d.entry, "only-step", "entry defaults to the first step");
  assert.equal(d.steps[0].label, "Only Step");
  assert.equal(d.steps[0].stage, "only-step");
  assert.equal(d.steps[0].produce.by, "agent");
  assert.equal(d.steps[0].gate, null);
  assert.equal(d.steps[0].order, 0);
});

await test("normalize rejects a non-object", () => {
  assert.throws(() => normalizeDefinition(null), /must be an object/);
  assert.throws(() => normalizeDefinition("nope"), /must be an object/);
});

await test("a well-formed definition validates", () => {
  const r = validateDefinition(base());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

const bad = [
  ["id", { id: "Not Valid" }, /id must be lowercase/],
  ["empty steps", { steps: [] }, /at least one step/],
  ["missing entry", { entry: "nope" }, /entry step nope does not exist/],
];
for (const [what, patch, re] of bad) {
  await test(`validation rejects a bad ${what}`, () => {
    const r = validateDefinition(base(patch));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => re.test(e.message)), JSON.stringify(r.errors));
  });
}

await test("validation rejects duplicate step ids", () => {
  const d = base();
  d.steps.push({ id: "one", stage: "one", produce: { by: "none", capability: "none" } });
  const r = validateDefinition(d);
  assert.ok(r.errors.some((e) => /duplicate step id one/.test(e.message)));
});

await test("validation rejects unknown primitives by name", () => {
  const d = base();
  d.steps[0].produce.capability = "teleport";
  d.steps[0].validate = [{ rule: "sudo", field: "body" }];
  d.steps[0].artifact.fields = [{ name: "body", type: "wormhole" }];
  const r = validateDefinition(d);
  const msgs = r.errors.map((e) => e.message).join("|");
  assert.match(msgs, /unknown capability teleport/);
  assert.match(msgs, /unknown validation rule sudo/);
  assert.match(msgs, /unknown field type wormhole/);
});

await test("validation rejects a rule that is missing an operand", () => {
  const d = base();
  d.steps[0].validate = [{ rule: "minLength", field: "body" }];
  const r = validateDefinition(d);
  assert.ok(r.errors.some((e) => /requires value/.test(e.message)), JSON.stringify(r.errors));
});

await test("validation rejects a dangling next", () => {
  const d = base();
  d.steps[0].next = "nowhere";
  const r = validateDefinition(d);
  assert.ok(r.errors.some((e) => /next step nowhere does not exist/.test(e.message)));
});

await test("validation rejects a dangling goto target", () => {
  const d = base();
  d.steps[0].gate = { id: "g", actions: [{ id: "back", outcome: "goto:missing" }] };
  const r = validateDefinition(d);
  assert.ok(r.errors.some((e) => /goto target missing does not exist/.test(e.message)));
});

await test("validation rejects repeat without a round counter", () => {
  const d = base();
  d.steps[0].gate = { id: "g", actions: [{ id: "again", outcome: "repeat" }] };
  const r = validateDefinition(d);
  assert.ok(r.errors.some((e) => /repeat needs the step to declare/.test(e.message)));
  d.steps[0].repeat = { counter: "round" };
  assert.equal(validateDefinition(d).ok, true);
});

await test("validation rejects duplicate gate action ids", () => {
  const d = base();
  d.steps[0].gate = { id: "g", actions: [{ id: "go", outcome: "advance" }, { id: "go", outcome: "advance" }] };
  const r = validateDefinition(d);
  assert.ok(r.errors.some((e) => /duplicate action id go/.test(e.message)));
});

await test("validation rejects an unreachable step", () => {
  const d = base();
  d.steps.push({ id: "orphan", stage: "orphan", produce: { by: "none", capability: "none" } });
  const r = validateDefinition(d);
  assert.ok(r.errors.some((e) => /step orphan is unreachable/.test(e.message)));
});

await test("validation rejects a workflow that can never finish", () => {
  const d = base();
  d.steps[1].next = "one";
  const r = validateDefinition(d);
  assert.ok(r.errors.some((e) => /can never finish/.test(e.message)), JSON.stringify(r.errors));
});

await test("assertValidDefinition throws a readable joined message", () => {
  assert.throws(() => assertValidDefinition(base({ id: "BAD" })), /invalid workflow definition: id: /);
});

await test("the hash is stable, key-order independent, and ignores updatedAt", () => {
  const a = hashDefinition(BUILTIN_DEFAULT);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a, hashDefinition(JSON.parse(JSON.stringify(BUILTIN_DEFAULT))));
  assert.equal(a, hashDefinition({ ...BUILTIN_DEFAULT, updatedAt: new Date().toISOString() }));
  const reordered = {};
  for (const k of Object.keys(BUILTIN_DEFAULT).reverse()) reordered[k] = BUILTIN_DEFAULT[k];
  assert.equal(a, hashDefinition(reordered), "canonicalization must not depend on key order");
});

await test("a real edit changes the hash", () => {
  const edited = JSON.parse(JSON.stringify(BUILTIN_DEFAULT));
  edited.steps[0].produce.contract += " Also mention licensing.";
  assert.notEqual(hashDefinition(BUILTIN_DEFAULT), hashDefinition(edited));
});

await test("canonicalize is deterministic JSON", () => {
  assert.equal(canonicalize(BUILTIN_DEFAULT), canonicalize(BUILTIN_DEFAULT));
  assert.equal(JSON.parse(canonicalize(BUILTIN_DEFAULT)).id, "default");
});

await test("the built-in default validates", () => {
  const r = validateDefinition(BUILTIN_DEFAULT);
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

// These four assertions are the compatibility contract. If any of them change,
// existing issues stop being readable by the code that manages them.
// The labels written to GitHub are the compatibility contract: issues already in
// flight carry these exact values.
await test("the built-in default preserves the historical issue labels", () => {
  assert.deepEqual(
    [...new Set(LEGACY_DEFAULT.steps.map((s) => s.issueLabel))],
    ["research", "prototype", "planning", "planning-finalize", "implementing", "finalizing", "done"],
  );
});

await test("the legacy default reads as six stages", () => {
  assert.deepEqual(
    [...new Set(LEGACY_DEFAULT.steps.map((s) => s.stage))],
    ["research", "prototype", "plan", "implement", "finalize", "done"],
  );
});

await test("the built-in default reproduces the hardcoded gate vocabulary", () => {
  assert.deepEqual(
    LEGACY_DEFAULT.steps.filter((s) => s.gate).map((s) => s.gate.id),
    ["signoff", "questionnaire", "plan-review", "feedback"],
  );
});

await test("the built-in default reproduces the hardcoded label definitions", () => {
  assert.deepEqual(labelDefinitions(LEGACY_DEFAULT).map((l) => l.name), [
    "agent-loop",
    "stage:research", "stage:prototype", "stage:planning", "stage:planning-finalize",
    "stage:implementing", "stage:finalizing", "stage:done",
    "gate:signoff", "gate:questionnaire", "gate:plan-review", "gate:feedback",
  ]);
});

await test("the built-in default reproduces the webview stepper nodes", () => {
  assert.deepEqual(stagesOf(LEGACY_DEFAULT).map((g) => g.key), [
    "research", "prototype", "plan", "implement", "finalize", "done",
  ]);
});

await test("every primitive the built-in default names actually exists", () => {
  for (const s of BUILTIN_DEFAULT.steps) {
    assert.ok(CAPABILITY_NAMES.includes(s.produce.capability), `capability ${s.produce.capability}`);
    for (const f of s.artifact.fields) assert.ok(FIELD_TYPE_NAMES.includes(f.type), `field type ${f.type}`);
    for (const r of s.validate) assert.ok(RULES[r.rule], `rule ${r.rule}`);
    for (const w of (s.gate ? s.gate.widgets : [])) assert.ok(GATE_WIDGETS[w.type], `widget ${w.type}`);
    for (const a of (s.gate ? s.gate.actions : [])) assert.ok(parseOutcome(a.outcome), `outcome ${a.outcome}`);
  }
});

await test("the old plan stage stays readable with all three steps", () => {
  const plan = LEGACY_DEFAULT.steps.filter((s) => s.stage === "plan");
  assert.deepEqual(plan.map((s) => s.id), ["plan-questions", "plan", "plan-panel"]);
  // One stage, but two different issue labels underneath it — which is exactly
  // why the label cannot be the thing the user edits.
  assert.deepEqual([...new Set(plan.map((s) => s.issueLabel))], ["planning", "planning-finalize"]);
});

await test("stagesOf reports each stage with its steps", () => {
  const stages = stagesOf(LEGACY_DEFAULT);
  assert.deepEqual(stages.map((g) => [g.key, g.steps.length]), [
    ["research", 1], ["prototype", 1], ["plan", 3], ["implement", 1], ["finalize", 1], ["done", 1],
  ]);
});

// Definitions pinned to in-flight issues predate the rename, so migration is not
// optional: without it those runs stop resolving.
await test("legacy group/stage field names are migrated on load", () => {
  const legacy = normalizeDefinition({
    id: "legacy", name: "Legacy", entry: "a",
    steps: [{ id: "a", group: "plan", stage: "planning", label: "Ask", next: null }],
  });
  assert.equal(legacy.steps[0].stage, "plan", "the old group becomes the stage");
  assert.equal(legacy.steps[0].issueLabel, "planning", "the old stage becomes the issue label");
});

await test("issueLabel defaults to the stage so an authored workflow never sets it", () => {
  const fresh = normalizeDefinition({
    id: "fresh", name: "Fresh", entry: "a",
    steps: [{ id: "a", stage: "review", label: "Review", next: null }],
  });
  assert.equal(fresh.steps[0].stage, "review");
  assert.equal(fresh.steps[0].issueLabel, "review");
});

await test("stepForIssueLabel disambiguates by gate", () => {
  assert.equal(stepForIssueLabel(LEGACY_DEFAULT, "planning", "plan-review").id, "plan-panel");
  assert.equal(stepForIssueLabel(BUILTIN_DEFAULT, "planning", "questionnaire").id, "plan-questions");
  assert.equal(stepForIssueLabel(BUILTIN_DEFAULT, "planning", null).id, "plan-questions");
  assert.equal(stepForIssueLabel(BUILTIN_DEFAULT, "nope", null), null);
});

await test("new runs expose review and synthesis as separate stages", () => {
  assert.deepEqual(stagesOf(BUILTIN_DEFAULT).map((s) => s.key),
    ["research", "prototype", "plan", "review", "synthesis", "implement", "finalize", "done"]);
  assert.equal(stepById(BUILTIN_DEFAULT, "plan").next, "review");
  assert.equal(stepById(BUILTIN_DEFAULT, "review").gate.id, "review-points");
  assert.equal(stepById(BUILTIN_DEFAULT, "review").next, "synthesis");
  assert.equal(stepById(BUILTIN_DEFAULT, "synthesis").gate.id, "plan-review");
  assert.equal(stepForIssueLabel(BUILTIN_DEFAULT, "synthesis", "plan-review").id, "synthesis");
  assert.notEqual(hashDefinition(BUILTIN_DEFAULT), hashDefinition(LEGACY_DEFAULT));
});

await test("outcomes parse into a kind and an optional target", () => {
  assert.deepEqual(parseOutcome("advance"), { kind: "advance", target: null });
  assert.deepEqual(parseOutcome("goto:plan"), { kind: "goto", target: "plan" });
  assert.equal(parseOutcome("rm -rf"), null);
});

console.log(`\n${passed} workflow-def assertions passed`);
