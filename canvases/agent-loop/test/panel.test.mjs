import assert from "node:assert";
import {
  familyOf, assertProviderDiversity, normalizeReviewers, buildPacket,
  validateReview, validateSynthesis, attributeQuotes, runPanel,
  planPanelFactoryDefinition, DEFAULT_REVIEWERS, DEFAULT_LIMITS, FACTORY_NAME,
} from "../panel.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

const clauses = [
  { id: "c1", title: "Register the factory", text: "Two reviewers and one synthesis agent." },
  { id: "c2", title: "Fail closed on drift", text: "A pinned clause must be byte-identical." },
];

function okReview(overrides = {}) {
  return {
    verdict: "revise",
    strengths: ["Scoped tightly"],
    risks: [{ severity: "high", clauseId: "c1", evidence: "No retry budget.", recommendation: "Raise maxTotalSubagents." }],
    omissions: ["No rollback"],
    suggestedChanges: [{ clauseId: "c2", change: "Name the hash algorithm." }],
    ...overrides,
  };
}

// A stub subagent runner. Records every dispatch so the tests can prove the two
// reviewers really were separate, model-pinned agents.
function fakeAgents(handlers = {}) {
  const calls = [];
  return {
    calls,
    agent: async ({ label, model, prompt, schema }) => {
      calls.push({ label, model, prompt, schema });
      const key = label.split(":")[0];
      const h = handlers[label] || handlers[key];
      if (typeof h === "function") return h({ label, model });
      if (label.startsWith("plan-synthesis")) return { clauses, disagreements: [{ topic: "Retries", positions: "a vs b", resolution: "Budget six." }] };
      return okReview();
    },
  };
}

await test("provider families are resolved from the model id", () => {
  assert.strictEqual(familyOf("claude-sonnet-5"), "anthropic");
  assert.strictEqual(familyOf("gpt-5.6-sol"), "openai");
  assert.strictEqual(familyOf("gemini-3.1-pro-preview"), "google");
  assert.strictEqual(familyOf(""), null);
});

await test("the shipped defaults are genuinely model diverse", () => {
  assert.strictEqual(assertProviderDiversity(DEFAULT_REVIEWERS), true);
  assert.deepStrictEqual(normalizeReviewers(null), DEFAULT_REVIEWERS);
});

await test("two reviewers from one family are refused before dispatch", () => {
  assert.throws(
    () => assertProviderDiversity([{ id: "a", model: "claude-sonnet-5" }, { id: "b", model: "claude-opus-5" }]),
    /same provider family/,
  );
  assert.throws(
    () => assertProviderDiversity([{ id: "a", model: "gpt-5.6-sol" }, { id: "b", model: "gpt-5.6-sol" }]),
    /both reviewers are pinned/,
  );
  assert.throws(() => assertProviderDiversity([{ id: "a", model: "gpt-5.6-sol" }]), /exactly two/);
  assert.throws(() => assertProviderDiversity([{ id: "a" }, { id: "b", model: "gpt-5.6-sol" }]), /missing a model/);
});

// The packet is the whole input to a fresh context. If the transcript leaked in,
// the panel would inherit exactly the context rot it exists to avoid.
await test("the evidence packet is bounded and carries no transcript", () => {
  const packet = buildPacket({
    owner: "cx-demo", repo: "agentic-dev-reimagine", issue: 3,
    request: "x".repeat(9000), research: "r", clauses,
    files: Array.from({ length: 90 }, (_, i) => `f${i}.mjs`),
    transcript: "SHOULD NOT APPEAR",
  });
  const json = JSON.stringify(packet);
  assert.ok(!json.includes("SHOULD NOT APPEAR"), "transcript must never reach the packet");
  assert.ok(packet.issue.request.length < 4200, "long input is clipped");
  assert.match(packet.issue.request, /truncated/);
  assert.strictEqual(packet.constraints.files.length, 60, "file lists are capped");
  assert.match(packet.draftPlan, /Register the factory/);
  assert.ok(!("feedback" in packet), "absent optional sections stay absent");
});

await test("both reviewers receive a byte-identical packet", async () => {
  const f = fakeAgents();
  await runPanel({ agent: f.agent }, { clauses, opId: "iss3/x" });
  const reviews = f.calls.filter((c) => c.label.startsWith("plan-review"));
  assert.strictEqual(reviews.length, 2);
  const strip = (p) => p.replace(/Reviewer id: \w+/, "");
  assert.strictEqual(strip(reviews[0].prompt), strip(reviews[1].prompt), "reviewers must see the same evidence");
});

// Identical prompt+options memoize into ONE subagent in the SDK, which would
// silently collapse the panel to a single reviewer wearing two names.
await test("each reviewer gets a distinct label and a distinct model", async () => {
  const f = fakeAgents();
  await runPanel({ agent: f.agent }, { clauses, opId: "iss3/x" });
  const reviews = f.calls.filter((c) => c.label.startsWith("plan-review"));
  assert.deepStrictEqual(reviews.map((c) => c.label).sort(), ["plan-review:claude", "plan-review:openai"]);
  assert.notStrictEqual(reviews[0].model, reviews[1].model);
  assert.strictEqual(new Set(f.calls.map((c) => c.label)).size, f.calls.length, "no two agents share a label");
});

await test("the synthesis agent is a third fresh agent", async () => {
  const f = fakeAgents();
  const out = await runPanel({ agent: f.agent }, { clauses, opId: "iss3/x", rev: 2 });
  const synth = f.calls.filter((c) => c.label.startsWith("plan-synthesis"));
  assert.strictEqual(synth.length, 1);
  assert.strictEqual(synth[0].label, "plan-synthesis:rev2");
  assert.strictEqual(out.freshContexts, true);
  assert.strictEqual(out.reviews.length, 2);
  assert.strictEqual(out.disagreements.length, 1);
});

await test("one reviewer failing degrades the run but does not block it", async () => {
  const f = fakeAgents({ "plan-review:openai": () => { throw new Error("model unavailable"); } });
  const logs = [];
  const out = await runPanel({ agent: f.agent, log: (m) => logs.push(m) }, { clauses, opId: "iss3/x" });
  assert.strictEqual(out.reviews.length, 1);
  assert.ok(out.degraded, "degradation must be recorded, never hidden");
  assert.strictEqual(out.degraded.missing[0].id, "openai");
  assert.match(out.degraded.missing[0].error, /model unavailable/);
  assert.deepStrictEqual(out.degraded.survived, ["claude"]);
  assert.ok(logs.some((l) => /degraded/.test(l)), "degradation is logged");
  assert.ok(out.clauses.length, "the plan is still produced");
});

// Degrading to zero reviewers is not a panel, so it fails closed.
await test("both reviewers failing fails the run closed", async () => {
  const f = fakeAgents({ "plan-review": () => { throw new Error("boom"); } });
  await assert.rejects(() => runPanel({ agent: f.agent }, { clauses, opId: "iss3/x" }), /plan panel failed/);
});

// The SDK resolves ordinary subagent failures as null rather than throwing.
await test("a null result from a reviewer counts as a failure, not an empty review", async () => {
  const f = fakeAgents({ "plan-review:claude": () => null });
  const out = await runPanel({ agent: f.agent }, { clauses, opId: "iss3/x" });
  assert.strictEqual(out.reviews.length, 1);
  assert.strictEqual(out.degraded.missing[0].id, "claude");
});

// The SDK ignores additionalProperties/pattern/length, so nothing schema-shaped
// can be trusted; every field is re-validated at this boundary.
await test("malformed reviewer output is rejected at the boundary", () => {
  assert.throws(() => validateReview(null, { reviewerId: "a" }), /returned no review/);
  assert.throws(() => validateReview(okReview({ verdict: "lgtm" }), { reviewerId: "a" }), /invalid verdict/);
  assert.throws(
    () => validateReview(okReview({ risks: [{ severity: "critical", evidence: "e", recommendation: "r" }] }), { reviewerId: "a" }),
    /invalid severity/,
  );
  assert.throws(
    () => validateReview(okReview({ risks: [{ severity: "high", evidence: "", recommendation: "r" }] }), { reviewerId: "a" }),
    /incomplete/,
  );
});

await test("reviewer output is clamped and unknown clause refs are dropped", () => {
  const review = validateReview(
    okReview({
      strengths: Array.from({ length: 50 }, () => "s"),
      risks: [{ severity: "HIGH", clauseId: "c404", evidence: "e".repeat(9000), recommendation: "r" }],
    }),
    { reviewerId: "claude", clauseIds: ["c1", "c2"] },
  );
  assert.strictEqual(review.strengths.length, 20);
  assert.strictEqual(review.risks[0].severity, "high", "severity is case-normalized");
  assert.strictEqual(review.risks[0].clauseId, null, "a dangling clause ref is dropped, not fatal");
  assert.strictEqual(review.risks[0].evidence.length, 2000);
});

await test("synthesis returning no clauses is rejected", () => {
  assert.throws(() => validateSynthesis({ clauses: [] }), /no clauses/);
  assert.throws(() => validateSynthesis(null), /returned nothing/);
  const ok = validateSynthesis({ clauses, disagreements: [{ topic: "t", resolution: "r" }, { topic: "", resolution: "r" }] });
  assert.strictEqual(ok.disagreements.length, 1, "incomplete disagreements are dropped");
});

await test("quotes are attributed to the clause and the model that raised them", () => {
  const reviews = [
    validateReview(okReview(), { reviewerId: "claude", clauseIds: ["c1", "c2"] }),
    validateReview(okReview({ risks: [{ severity: "low", clauseId: "c1", evidence: "Minor.", recommendation: "Note it." }], suggestedChanges: [] }), { reviewerId: "openai", clauseIds: ["c1", "c2"] }),
  ];
  const quotes = attributeQuotes(["c1", "c2"], reviews);
  assert.deepStrictEqual(quotes.c1.map((q) => q.reviewerId), ["claude", "openai"]);
  assert.strictEqual(quotes.c1[0].severity, "high");
  assert.strictEqual(quotes.c2[0].text, "Name the hash algorithm.");
});

// A clause send-back reuses stored reviews rather than re-running the panel.
await test("synthesis-only reuses stored reviews and runs no reviewers", async () => {
  const f = fakeAgents();
  const stored = [validateReview(okReview(), { reviewerId: "claude", clauseIds: ["c1"] })];
  const out = await runPanel({ agent: f.agent }, {
    clauses, opId: "iss3/x", mode: "synthesis-only", reviews: stored,
    decisions: [{ clauseId: "c1", action: "send-back", instruction: "Tighten it." }],
  });
  assert.strictEqual(f.calls.filter((c) => c.label.startsWith("plan-review")).length, 0, "no reviewer is re-run");
  assert.strictEqual(out.mode, "synthesis-only");
  assert.deepStrictEqual(out.reviews, stored);
  assert.match(f.calls[0].prompt, /Tighten it\./, "the human's instruction reaches synthesis");
  assert.match(f.calls[0].prompt, /reused/);
});

await test("synthesis-only without stored reviews is refused", async () => {
  const f = fakeAgents();
  await assert.rejects(
    () => runPanel({ agent: f.agent }, { clauses, opId: "iss3/x", mode: "synthesis-only", reviews: [] }),
    /no stored reviews/,
  );
});

// Journal keys are what make a resumed run replay instead of re-billing.
await test("every agent call is journaled under the operation id", async () => {
  const f = fakeAgents();
  const keys = [];
  await runPanel({ agent: f.agent, step: (k, fn) => { keys.push(k); return fn(); } }, { clauses, opId: "iss3/planning/t9", rev: 3 });
  assert.deepStrictEqual(keys.sort(), [
    "iss3/planning/t9/review/claude",
    "iss3/planning/t9/review/openai",
    "iss3/planning/t9/synthesis/3",
  ]);
});

await test("the factory definition declares a bounded budget", () => {
  const def = planPanelFactoryDefinition();
  assert.strictEqual(def.meta.name, FACTORY_NAME);
  assert.strictEqual(typeof def.run, "function");
  assert.strictEqual(def.meta.limits.maxConcurrentSubagents, 2);
  // Three agents, each able to retry once in schema mode.
  assert.ok(def.meta.limits.maxTotalSubagents >= 6, "retry budget must cover schema-mode retries");
  assert.ok(def.meta.limits.timeoutSeconds > 0 && def.meta.limits.maxAiCredits > 0);
  assert.strictEqual(def.meta.phases.length, 2);
});

await test("a panel without an agent runner refuses to start", async () => {
  await assert.rejects(() => runPanel({}, { clauses }), /requires an agent runner/);
});

// The budget is the bug that made every review come back empty. Measured cost:
// the reviewer pair on a real ~20k packet burns ~32 credits, and synthesis is a
// third call of the same order. The old ceiling of 12 stopped the subagents
// mid-flight, and a stopped subagent resolves `null` rather than throwing, so
// the panel could only report "reviewer returned no review".
await test("the credit budget covers a measured full panel", () => {
  const measuredReviewerPair = 32;
  const synthesisEstimate = measuredReviewerPair / 2;
  const oneSchemaRetry = measuredReviewerPair / 2;
  const worstCase = measuredReviewerPair + synthesisEstimate + oneSchemaRetry;
  assert.ok(DEFAULT_LIMITS.maxAiCredits >= worstCase,
    `maxAiCredits ${DEFAULT_LIMITS.maxAiCredits} must cover the ~${worstCase} credit worst case`);
});

// Two reviewers and one synthesis agent, each allowed one schema retry, is 6
// spawns exactly. The old cap of 6 was sufficient but sat precisely on the
// worst case; 8 is set so adding a reviewer does not silently start truncating.
await test("the subagent cap covers every retried spawn", () => {
  const agents = DEFAULT_REVIEWERS.length + 1;
  const withRetries = agents * 2;
  assert.ok(DEFAULT_LIMITS.maxTotalSubagents >= withRetries,
    `maxTotalSubagents ${DEFAULT_LIMITS.maxTotalSubagents} must cover ${withRetries} retried spawns`);
  assert.ok(DEFAULT_LIMITS.maxConcurrentSubagents >= DEFAULT_REVIEWERS.length,
    "reviewers are meant to run in parallel");
});

console.log(`\n${passed} panel assertions passed`);
