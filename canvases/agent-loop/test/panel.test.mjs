import assert from "node:assert";
import {
  familyOf, normalizeReviewer, buildPacket,
  validateReview, validateSynthesis, attributeQuotes, runPanel,
  planPanelFactoryDefinition, REVIEWER, SYNTHESIS_MODEL, DEFAULT_LIMITS, FACTORY_NAME,
  resolveModelId, FALLBACK_MODEL,
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

// A stub subagent runner. Records every dispatch so the tests can prove the
// review and the synthesis really were separate, model-pinned agents.
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

await test("the reviewer defaults to the shipped constant", () => {
  assert.deepStrictEqual(normalizeReviewer(null), REVIEWER);
  assert.throws(() => normalizeReviewer({ id: "x" }), /missing a model/,
    "a half-specified reviewer is a config error, not something to guess at");
  assert.deepStrictEqual(normalizeReviewer({ id: "x", model: "gpt-5.6-sol" }), { id: "x", model: "gpt-5.6-sol" });
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

// The review runs BEFORE the synthesis, not beside it. Ordering is the whole
// point of the redesign: synthesis reads a review that already exists.
await test("the review runs first, then synthesis, each as its own agent", async () => {
  const f = fakeAgents();
  const out = await runPanel({ agent: f.agent }, { clauses, opId: "iss3/x", rev: 2 });
  assert.deepStrictEqual(f.calls.map((c) => c.label), ["plan-review:claude", "plan-synthesis:rev2"]);
  assert.strictEqual(f.calls[0].model, REVIEWER.model);
  assert.strictEqual(f.calls[1].model, SYNTHESIS_MODEL);
  assert.strictEqual(out.freshContexts, true);
  assert.strictEqual(out.reviews.length, 1);
  assert.strictEqual(out.synthesisModel, SYNTHESIS_MODEL);
  assert.deepStrictEqual(out.models, [{ id: "claude", model: REVIEWER.model, family: "anthropic" }]);
});

// The synthesis model used to be `reviewers[0].model` by position, so swapping
// the reviewer silently re-priced synthesis too. It is named now.
await test("the synthesis model is named, not inherited from the reviewer", async () => {
  const f = fakeAgents();
  await runPanel({ agent: f.agent }, { clauses, opId: "iss3/x", reviewer: { id: "r", model: "gpt-5.6-sol" } });
  assert.strictEqual(f.calls[0].model, "gpt-5.6-sol");
  assert.strictEqual(f.calls[1].model, SYNTHESIS_MODEL, "synthesis must not follow the reviewer");
});

// A preferred model that the session is not entitled to would fail the run with
// `unknown-model` before any subagent runs. The resolver downgrades it to the
// universal `auto` floor instead of failing closed.
await test("resolveModelId falls back to auto only when the preferred model is unentitled", () => {
  // Unknown entitlement (null): never second-guess the preference.
  assert.strictEqual(resolveModelId("claude-sonnet-5", null), "claude-sonnet-5");
  // Entitled: keep the preference.
  assert.strictEqual(resolveModelId("claude-sonnet-5", ["claude-sonnet-5", "auto"]), "claude-sonnet-5");
  // Unentitled but auto present: fall back.
  assert.strictEqual(resolveModelId("claude-sonnet-5", ["claude-sonnet-4.6", "auto"]), FALLBACK_MODEL);
  // Unentitled and no fallback present: return the preference so the run fails
  // loudly with the original intent rather than a silent substitute.
  assert.strictEqual(resolveModelId("claude-sonnet-5", ["gpt-5.5"]), "claude-sonnet-5");
});

// End to end through runPanel: an entitled list without sonnet-5 spawns both the
// reviewer and the synthesizer under `auto`, and the provenance reports it.
await test("runPanel spawns under the fallback when sonnet-5 is not entitled", async () => {
  const f = fakeAgents();
  const logs = [];
  const out = await runPanel(
    { agent: f.agent, log: (m) => logs.push(m), listModels: async () => ["claude-sonnet-4.6", "auto", "gpt-5.5"] },
    { clauses, opId: "iss3/x", rev: 2 },
  );
  assert.strictEqual(f.calls[0].model, FALLBACK_MODEL, "review spawns under auto");
  assert.strictEqual(f.calls[1].model, FALLBACK_MODEL, "synthesis spawns under auto");
  assert.strictEqual(out.synthesisModel, FALLBACK_MODEL);
  assert.deepStrictEqual(out.models, [{ id: "claude", model: FALLBACK_MODEL, family: familyOf(FALLBACK_MODEL) }]);
  assert.ok(logs.some((m) => /falling back to auto/.test(m)), "the downgrade is logged");
});

// When the session IS entitled to the preferred model, nothing changes: no
// fallback, no downgrade log.
await test("runPanel keeps the preferred model when it is entitled", async () => {
  const f = fakeAgents();
  const logs = [];
  await runPanel(
    { agent: f.agent, log: (m) => logs.push(m), listModels: async () => ["claude-sonnet-5", "auto"] },
    { clauses, opId: "iss3/x" },
  );
  assert.strictEqual(f.calls[0].model, REVIEWER.model);
  assert.strictEqual(f.calls[1].model, SYNTHESIS_MODEL);
  assert.ok(!logs.some((m) => /falling back/.test(m)), "no downgrade when entitled");
});

// A listModels that throws must not take the run down: entitlement is simply
// treated as unknown and the preferred model is used unchanged.
await test("runPanel ignores a failing listModels and keeps the preferred model", async () => {
  const f = fakeAgents();
  await runPanel(
    { agent: f.agent, listModels: async () => { throw new Error("registry down"); } },
    { clauses, opId: "iss3/x" },
  );
  assert.strictEqual(f.calls[0].model, REVIEWER.model);
  assert.strictEqual(f.calls[1].model, SYNTHESIS_MODEL);
});

// With one reviewer there is no quorum to degrade into: an unusable review is a
// hard failure, so an unreviewed plan can never wear a reviewed plan's badge.
await test("a failing reviewer fails the run closed", async () => {
  const f = fakeAgents({ "plan-review": () => { throw new Error("boom"); } });
  await assert.rejects(() => runPanel({ agent: f.agent }, { clauses, opId: "iss3/x" }), /boom/);
  assert.strictEqual(f.calls.filter((c) => c.label.startsWith("plan-synthesis")).length, 0,
    "synthesis must not run without a review");
});

// The SDK resolves a refused spawn as null rather than throwing, which is how a
// host-side refusal used to be reported as the model's fault.
await test("a null result is reported as a review that never started", async () => {
  const f = fakeAgents({ "plan-review:claude": () => null });
  await assert.rejects(
    () => runPanel({ agent: f.agent }, { clauses, opId: "iss3/x" }),
    (err) => err.code === "review-not-started" && /did not run/.test(err.message),
  );
});

await test("every step reports its state, and a failed step says so", async () => {
  const ok = [];
  await runPanel({ agent: fakeAgents().agent, progress: (e) => ok.push(e) }, { clauses, opId: "iss3/x" });
  assert.deepStrictEqual(ok.map((e) => `${e.step}:${e.state}`),
    ["review:running", "review:done", "synthesis:running", "synthesis:done"]);
  assert.strictEqual(ok[0].model, REVIEWER.model);

  const bad = [];
  const f = fakeAgents({ "plan-review:claude": () => null });
  await assert.rejects(() => runPanel({ agent: f.agent, progress: (e) => bad.push(e) }, { clauses, opId: "iss3/x" }));
  assert.deepStrictEqual(bad.map((e) => `${e.step}:${e.state}`), ["review:running", "review:failed"]);
  assert.strictEqual(bad[1].code, "review-not-started");
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
  const reviews = [validateReview(okReview(), { reviewerId: "claude", clauseIds: ["c1", "c2"] })];
  const quotes = attributeQuotes(["c1", "c2"], reviews);
  assert.deepStrictEqual(quotes.c1.map((q) => q.reviewerId), ["claude"]);
  assert.strictEqual(quotes.c1[0].severity, "high");
  assert.strictEqual(quotes.c2[0].text, "Name the hash algorithm.");
});

// A clause send-back reuses the stored review rather than re-running step 2.
await test("synthesis-only reuses the stored review and runs no reviewer", async () => {
  const f = fakeAgents();
  const stored = [validateReview(okReview(), { reviewerId: "claude", clauseIds: ["c1"] })];
  const out = await runPanel({ agent: f.agent }, {
    clauses, opId: "iss3/x", mode: "synthesis-only", reviews: stored,
    decisions: [{ clauseId: "c1", action: "send-back", instruction: "Tighten it." }],
  });
  assert.strictEqual(f.calls.filter((c) => c.label.startsWith("plan-review")).length, 0, "the reviewer is not re-run");
  assert.strictEqual(out.mode, "synthesis-only");
  assert.deepStrictEqual(out.reviews, stored);
  assert.match(f.calls[0].prompt, /Tighten it\./, "the human's instruction reaches synthesis");
  assert.match(f.calls[0].prompt, /reused/);
});

await test("synthesis-only without a stored review is refused", async () => {
  const f = fakeAgents();
  await assert.rejects(
    () => runPanel({ agent: f.agent }, { clauses, opId: "iss3/x", mode: "synthesis-only", reviews: [] }),
    /no stored review/,
  );
});

// Journal keys are what make a resumed run replay instead of re-billing.
await test("every agent call is journaled under the operation id", async () => {
  const f = fakeAgents();
  const keys = [];
  await runPanel({ agent: f.agent, step: (k, fn) => { keys.push(k); return fn(); } }, { clauses, opId: "iss3/planning/t9", rev: 3 });
  assert.deepStrictEqual(keys, [
    "iss3/planning/t9/review/claude",
    "iss3/planning/t9/synthesis/3",
  ]);
});

await test("the factory definition declares a bounded budget", () => {
  const def = planPanelFactoryDefinition();
  assert.strictEqual(def.meta.name, FACTORY_NAME);
  assert.strictEqual(typeof def.run, "function");
  assert.strictEqual(def.meta.limits.maxConcurrentSubagents, 1, "the steps are sequential");
  // Two agents, each able to retry once in schema mode.
  assert.ok(def.meta.limits.maxTotalSubagents >= 4, "retry budget must cover schema-mode retries");
  assert.ok(def.meta.limits.timeoutSeconds > 0 && def.meta.limits.maxAiCredits > 0);
  assert.strictEqual(def.meta.phases.length, 2);
});

await test("a review without an agent runner refuses to start", async () => {
  await assert.rejects(() => runPanel({}, { clauses }), /requires an agent runner/);
});

// A budget that runs out is the failure mode this whole redesign exists to make
// visible: an exhausted ceiling stops the subagent mid-flight, and a stopped
// subagent resolves `null` rather than throwing. Measured on a real ~20k packet:
// review 19.1 AIU, synthesis 5.6 AIU.
await test("the credit budget covers a measured run with a retry to spare", () => {
  const measuredReview = 19.1;
  const measuredSynthesis = 5.6;
  const worstCase = (measuredReview + measuredSynthesis) * 2; // one schema retry each
  assert.ok(DEFAULT_LIMITS.maxAiCredits >= worstCase,
    `maxAiCredits ${DEFAULT_LIMITS.maxAiCredits} must cover the ~${worstCase} credit worst case`);
});

// One reviewer and one synthesis agent, each allowed a single schema retry, is 4
// spawns exactly — and concurrency of 1 is what makes the run sequential rather
// than merely described as sequential.
await test("the subagent cap covers every retried spawn", () => {
  const agents = 2;
  const withRetries = agents * 2;
  assert.ok(DEFAULT_LIMITS.maxTotalSubagents >= withRetries,
    `maxTotalSubagents ${DEFAULT_LIMITS.maxTotalSubagents} must cover ${withRetries} retried spawns`);
  assert.strictEqual(DEFAULT_LIMITS.maxConcurrentSubagents, 1,
    "the review must finish before synthesis starts");
});

console.log(`\n${passed} panel assertions passed`);
