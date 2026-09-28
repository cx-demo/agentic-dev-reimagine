// A user-authored workflow, executed end to end.
//
// The golden suite proves the refactor did not change the built-in pipeline.
// This suite proves the point of the refactor: a definition nobody hardcoded
// runs, gates, repeats, branches and finishes on its own terms.

import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stateOf, controlId, order, intent, makeLoop } from "./loop.harness.mjs";
import { validateDefinition } from "../workflow-def.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

const here = dirname(fileURLToPath(import.meta.url));
const workRoot = join(here, "_custom-work");

// Nothing here exists in the built-in pipeline: different step ids, different
// stage names, a different gate, a different vocabulary of actions.
const CUSTOM = {
  id: "spike-review",
  name: "Spike and review",
  entry: "spike",
  steps: [
    {
      id: "spike",
      stage: "spiking", group: "spike", label: "Spike", icon: "research",
      produce: {
        by: "agent", capability: "markdown", heading: "🧷 Spike",
        contract: "Timebox a spike for {{owner}}/{{repo}}#{{issue}} on branch {{branch}}. Return artifact { findings: markdown }.",
      },
      artifact: { fields: [{ name: "findings", type: "markdown" }] },
      validate: [{ rule: "minLength", field: "findings", value: 10, message: "spike findings are required" }],
      repeat: { counter: "spikeRound" },
      status: { working: "Spiking…", waiting: "Waiting for your call on the spike." },
      gate: {
        id: "spike-review", title: "Review the spike",
        widgets: [{ type: "markdown-view", source: "spike" }, { type: "textarea", id: "notes" }],
        actions: [
          { id: "accept", label: "Accept spike", style: "primary", outcome: "advance", status: "Writing it up…" },
          { id: "respike", label: "Spike again", style: "secondary", outcome: "repeat" },
        ],
      },
      next: "writeup",
    },
    {
      id: "writeup",
      stage: "writing", group: "writeup", label: "Write-up",
      produce: {
        by: "agent", capability: "markdown", heading: "📄 Write-up",
        contract: "Write up the accepted spike. Return artifact { body: markdown }.",
      },
      artifact: { fields: [{ name: "body", type: "markdown" }] },
      validate: [{ rule: "minLength", field: "body", value: 10 }],
      status: { working: "Writing it up…", waiting: "Waiting for your sign-off on the write-up." },
      gate: {
        id: "writeup-ok", title: "Approve the write-up",
        widgets: [{ type: "markdown-view", source: "writeup" }],
        actions: [
          { id: "publish", label: "Publish", style: "primary", outcome: "advance" },
          { id: "back-to-spike", label: "Back to the spike", style: "ghost", outcome: "goto:spike" },
        ],
      },
      next: "published",
    },
    {
      id: "published",
      stage: "published", group: "published", label: "Published",
      produce: { by: "none", capability: "none" },
      status: { working: "Published." },
      next: null,
    },
  ],
};

function loop() {
  return makeLoop(workRoot, { definition: CUSTOM });
}

await rm(workRoot, { recursive: true, force: true });
await mkdir(workRoot, { recursive: true });

await test("the custom definition is valid", () => {
  const r = validateDefinition(CUSTOM);
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

await test("kickoff enters the definition's entry step, not `research`", async () => {
  const { fake, prompts, coordinator } = loop();
  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Try an idea", reqId: "custom-entry" } });
  const st = stateOf(fake);
  assert.equal(st.stage, "spiking");
  assert.equal(st.pending.kind, "spike");
  assert.equal(st.statusText, "Spiking…");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /Timebox a spike for o\/r#7 on branch agent-loop\/issue-7/);
  assert.match(prompts[0].prompt, /kind spike/);
});

await test("labels are reconciled from the custom vocabulary", async () => {
  const { fake, coordinator } = loop();
  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Labels", reqId: "custom-labels" } });
  const ensured = fake.calls.find((c) => Array.isArray(c) && c[0] === "ensureLabels")[1];
  assert.ok(ensured.includes("stage:spiking"), "custom stage label is ensured");
  assert.ok(ensured.includes("gate:spike-review"), "custom gate label is ensured");
  assert.ok(!ensured.includes("stage:implementing"), "built-in labels are not ensured for a custom workflow");
  const reconciled = fake.calls.filter((c) => Array.isArray(c) && c[0] === "reconcileWorkflowLabels").at(-1)[1];
  assert.ok(reconciled.includes("stage:spiking"));
});

await test("a submitted artifact is validated by the definition's own rules", async () => {
  const { prompts, coordinator } = loop();
  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Validate", reqId: "custom-validate" } });
  const o = order(prompts);
  await assert.rejects(
    () => coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { findings: "tiny" } }),
    /spike findings are required/,
  );
});

await test("an accepted artifact opens the step's own gate", async () => {
  const { fake, prompts, coordinator } = loop();
  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Gate", reqId: "custom-gate" } });
  const o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { findings: "The spike found a workable seam." } });
  const st = stateOf(fake);
  assert.equal(st.gate, "spike-review");
  assert.equal(st.status, "waiting");
  assert.equal(st.statusText, "Waiting for your call on the spike.");
  assert.equal(st.pending, null);
  assert.ok(st.artifacts.spike.commentId, "the asset comment is recorded under the step id");
  assert.ok(fake.comments.some((c) => /## 🧷 Spike/.test(c.body)), "the step's heading is used");
});

await test("a `repeat` action re-runs the step and bumps its own counter", async () => {
  const { fake, prompts, coordinator } = loop();
  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Repeat", reqId: "custom-repeat" } });
  let o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { findings: "First spike, inconclusive." } });
  await coordinator.handleIntent(intent(fake, "respike", { notes: "Try the other approach" }));
  const st = stateOf(fake);
  assert.equal(st.stage, "spiking");
  assert.equal(st.gate, null);
  assert.equal(st.pending.kind, "spike");
  assert.equal(st.rounds.spikeRound, 1, "the custom counter is tracked in the round map");
  assert.equal(prompts.length, 2, "a repeat dispatches a fresh work order");
  assert.ok(fake.comments.some((c) => /Try the other approach/.test(c.body)), "the human note is written to the issue");
});

await test("an `advance` action follows the step's declared next", async () => {
  const { fake, prompts, coordinator } = loop();
  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Advance", reqId: "custom-advance" } });
  let o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { findings: "The spike found a workable seam." } });
  await coordinator.handleIntent(intent(fake, "accept", { notes: "Good enough" }));
  const st = stateOf(fake);
  assert.equal(st.stage, "writing");
  assert.equal(st.pending.kind, "writeup");
  assert.equal(st.statusText, "Writing it up…", "the action's status text wins over the step default");
  assert.match(order(prompts).prompt, /Write up the accepted spike/);
});

await test("a `goto` action jumps backwards to the named step", async () => {
  const { fake, prompts, coordinator } = loop();
  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Goto", reqId: "custom-goto" } });
  let o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { findings: "The spike found a workable seam." } });
  await coordinator.handleIntent(intent(fake, "accept", {}));
  o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { body: "Here is the write-up of the spike." } });
  assert.equal(stateOf(fake).gate, "writeup-ok");
  await coordinator.handleIntent(intent(fake, "back-to-spike", { notes: "Needs another look" }));
  const st = stateOf(fake);
  assert.equal(st.stage, "spiking");
  assert.equal(st.pending.kind, "spike");
});

await test("a producerless terminal step finishes the run", async () => {
  const { fake, prompts, coordinator } = loop();
  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Finish", reqId: "custom-finish" } });
  let o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { findings: "The spike found a workable seam." } });
  await coordinator.handleIntent(intent(fake, "accept", {}));
  o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { body: "Here is the write-up of the spike." } });
  await coordinator.handleIntent(intent(fake, "publish", {}));
  const st = stateOf(fake);
  assert.equal(st.stage, "published");
  assert.equal(st.status, "done");
  assert.equal(st.pending, null, "a terminal step never waits on an agent");
  assert.equal(prompts.length, 2, "no work order is sent for a producerless step");
});

await test("an intent the definition does not declare is refused", async () => {
  const { fake, prompts, coordinator } = loop();
  await coordinator.handleIntent({ kind: "kickoff", data: { idea: "Refuse", reqId: "custom-refuse" } });
  const o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { findings: "The spike found a workable seam." } });
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "not-a-real-action", {})), /unknown intent kind/);
  // A built-in action name must not work either just because the code knows it.
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "approve", { optionId: "a" })), /not valid for gate|unknown intent/);
});

await rm(workRoot, { recursive: true, force: true });
console.log(`\n${passed} custom-workflow assertions passed`);
