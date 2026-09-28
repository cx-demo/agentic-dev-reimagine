// Golden fixture suite — the contract the configurable-workflow refactor must
// not break.
//
// The stage machine is about to stop being hardcoded and start being an
// interpreter over a declarative definition. The only way to prove that
// translation is faithful is to freeze today's observable output first: every
// work order the coordinator emits, every control-block transition it commits,
// and every label set it reconciles, for a full pass through the pipeline.
//
// Refresh deliberately, never casually:  node golden.test.mjs --update
// A diff here means agent-visible or issue-visible behaviour changed.

import assert from "node:assert";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stateOf, controlId, order, intent, writeProto, makeLoop } from "./loop.harness.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

const here = dirname(fileURLToPath(import.meta.url));
const workRoot = join(here, "_golden-work");
const fixtureFile = join(here, "fixtures", "golden-pipeline.json");
const UPDATE = process.argv.includes("--update");

// Random tokens and wall-clock stamps are the only non-reproducible parts of a
// run. Scrub them by key so the genuinely deterministic 64-hex prototype digests
// keep their meaning -- those digests are exactly what a file-set validator
// regression would corrupt.
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "updatedAt") out[k] = "<ts>";
      else if (k === "submissionTokenHash") out[k] = "<token-hash>";
      else if (k === "priorSubmissionTokenHashes") out[k] = Array.isArray(v) ? v.map(() => "<token-hash>") : v;
      else out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

function scrubPrompt(prompt) {
  // The work root is an absolute path, so it encodes the checkout location. Left
  // raw it made the fixture machine-specific: renaming the source folder (or
  // cloning elsewhere) read as agent-visible drift when nothing had changed.
  return String(prompt)
    .replace(/("submissionToken":\s*")[0-9a-f]+(")/g, "$1<token>$2")
    .split(workRoot).join("<workRoot>");
}

function labelSets(fake) {
  return fake.calls.filter((c) => Array.isArray(c) && c[0] === "reconcileWorkflowLabels").map((c) => c[1]);
}

// One full pass: kickoff → research → prototype → sign-off → questionnaire →
// plan → plan review → implement → feedback revision → ship → finalize → done.
async function capture() {
  const { fake, prompts, coordinator } = makeLoop(workRoot);
  const trace = [];
  const step = (name) => trace.push({ step: name, state: scrub(stateOf(fake)), labels: labelSets(fake).at(-1) || null });

  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Build a copy button", reqId: "golden-1" } });
  step("kickoff");

  let o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { body: "Research brief with useful tradeoffs." } });
  step("submit:research");

  const protoPath = "o/r/7/round-1/a/index.html";
  await writeProto(workRoot, protoPath);
  o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { options: [{ id: "a", title: "Inline", pitch: "Quiet option", path: protoPath }] } });
  step("submit:prototype");

  await coordinator.handleIntent(intent(fake, "approve", { optionId: "a", notes: "Looks good" }));
  step("intent:approve");

  o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { body: "**q1.** (single) Framework?\n- Vanilla\n- React" } });
  step("submit:plan-questions");

  await coordinator.handleIntent(intent(fake, "answers", { answers: [{ id: "q1", prompt: "Framework?", answer: "Vanilla" }] }));
  step("intent:answers");

  o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { body: "## Plan\nImplement a small vanilla component with tests." } });
  step("submit:plan");

  await coordinator.handleIntent(intent(fake, "plan-ok", { notes: "" }));
  step("intent:plan-ok");

  o = order(prompts);
  fake.pull.headRefOid = "sha-impl-1";
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { summary: "Opened PR.", preview: { kind: "none", notes: "Diff only" } } });
  step("submit:implement");

  await coordinator.handleIntent(intent(fake, "revise", { feedback: "Add one more test" }));
  step("intent:revise");

  o = order(prompts);
  fake.pull.headRefOid = "sha-impl-2";
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { summary: "Updated PR.", preview: { kind: "none" } } });
  step("submit:implement-2");

  await coordinator.handleIntent(intent(fake, "ship", { prNumber: 1, reviewedHeadSha: "sha-impl-2" }));
  step("intent:ship");

  o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { body: "Final cleanup complete." } });
  step("submit:finalize");

  return {
    workOrders: prompts.map((p) => ({ kind: p.kind, prompt: scrubPrompt(p.prompt) })),
    labelSets: labelSets(fake),
    trace,
  };
}

await rm(workRoot, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true });

const actual = await capture();

if (UPDATE || !existsSync(fixtureFile)) {
  await mkdir(dirname(fixtureFile), { recursive: true });
  await writeFile(fixtureFile, JSON.stringify(actual, null, 2) + "\n");
  console.log(existsSync(fixtureFile) && !UPDATE ? "  seeded golden fixture" : "  updated golden fixture");
}

const expected = JSON.parse(await readFile(fixtureFile, "utf8"));

await test("work orders are byte-identical to the golden fixture", () => {
  assert.equal(actual.workOrders.length, expected.workOrders.length, "work order count changed");
  for (let i = 0; i < expected.workOrders.length; i++) {
    assert.equal(actual.workOrders[i].kind, expected.workOrders[i].kind, `work order ${i} kind`);
    assert.equal(actual.workOrders[i].prompt, expected.workOrders[i].prompt, `work order ${i} (${expected.workOrders[i].kind}) text drifted`);
  }
});

await test("every control-block transition matches the golden fixture", () => {
  assert.equal(actual.trace.length, expected.trace.length, "transition count changed");
  for (let i = 0; i < expected.trace.length; i++) {
    assert.equal(actual.trace[i].step, expected.trace[i].step, `step ${i} name`);
    assert.deepEqual(actual.trace[i].state, expected.trace[i].state, `state after ${expected.trace[i].step} drifted`);
  }
});

await test("every reconciled label set matches the golden fixture", () => {
  assert.deepEqual(actual.labelSets, expected.labelSets);
});

// A fixture that silently captured a degenerate run would pass forever while
// proving nothing. Assert the shape of the pass itself.
await test("the golden run actually traverses the whole pipeline", () => {
  const stages = expected.trace.map((t) => t.state.stage);
  for (const s of ["research", "prototype", "planning", "planning-finalize", "implementing", "finalizing", "done"]) {
    assert.ok(stages.includes(s), `golden run never reached stage ${s}`);
  }
  const gates = expected.trace.map((t) => t.state.gate).filter(Boolean);
  for (const g of ["signoff", "questionnaire", "plan-review", "feedback"]) {
    assert.ok(gates.includes(g), `golden run never opened gate ${g}`);
  }
  assert.equal(expected.trace.at(-1).state.status, "done");
});

await rm(workRoot, { recursive: true, force: true });
console.log(`\n${passed} golden assertions passed`);
