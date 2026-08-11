// Coordinator-level tests for the two-model plan panel: the wiring between
// submit_stage, the out-of-band panel run, and the steer-pins gate.
import assert from "node:assert";
import { createHash } from "node:crypto";
import { createCoordinator, clausesFromMarkdown, assertControlSize, CONTROL_BODY_LIMIT } from "../workflow.mjs";
import { deriveState } from "../server.mjs";
import { findControlBlock, findCommentByOpMarker, findCommentByHeading } from "../github.mjs";
import { renderClauses } from "../clauses.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

class FakeGitHub {
  constructor() {
    this.issue = { number: 7, title: "Seed", body: "Do the thing", html_url: "https://github.com/o/r/issues/7", labels: [] };
    this.comments = [];
    this.nextComment = 100;
    this.findCommentByOpMarker = findCommentByOpMarker;
  }
  async detectRepo() { return { owner: "o", repo: "r", nameWithOwner: "o/r", defaultBranch: "main" }; }
  async ensureLabels() {}
  async getIssue() { return this.issue; }
  async listComments() { return this.comments.slice(); }
  async createComment(owner, repo, issue, body) {
    const c = { id: this.nextComment++, body };
    this.comments.push(c);
    return c;
  }
  async updateComment(owner, repo, id, body) {
    const c = this.comments.find((x) => String(x.id) === String(id));
    if (!c) throw new Error("comment not found");
    c.body = body;
    return c;
  }
  async reconcileWorkflowLabels(owner, repo, issue, desired) {
    this.issue.labels = desired.map((name) => ({ name }));
  }
}

const TOKEN = "test-submission-token";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

const stateOf = (fake) => findControlBlock(fake.comments).data;
const controlId = (fake) => findControlBlock(fake.comments).commentId;
const headingOf = (b) => (String(b).match(/^## (.*)$/m) || [])[1];

function planState(overrides = {}) {
  return {
    version: 2, txn: 5, owner: "o", repo: "r", issue: 7, title: "Seed", baseBranch: "main",
    stage: "planning-finalize", gate: null, round: 1, implRound: 0, status: "working",
    statusText: "Drafting the plan…", updatedAt: new Date().toISOString(),
    pending: { opId: "iss7/planning-finalize/t5", kind: "plan", inputCommentIds: [], mode: "finalize", attempt: 1, submissionTokenHash: TOKEN_HASH },
    artifacts: {},
    ...overrides,
  };
}

// Build a coordinator sitting on a pending `plan` submission, with a stub panel.
async function makePlanLoop({ runPanel, state } = {}) {
  const fake = new FakeGitHub();
  const prompts = [];
  const coordinator = createCoordinator({
    github: fake,
    workRoot: "/tmp/agent-loop-panel-test",
    assetBase: "http://127.0.0.1:9999",
    instanceId: "inst-1",
    sendPrompt: async (prompt, kind) => { prompts.push({ prompt, kind }); },
    setActive: async () => {},
    readActive: async () => ({ owner: "o", repo: "r", issue: 7 }),
    refresh: async () => {},
    runPanel,
  });
  const st = state || planState();
  await fake.createComment("o", "r", 7, `<!-- AGENT-LOOP-STATE v1 -->\n\`\`\`json\n${JSON.stringify(st, null, 2)}\n\`\`\``);
  return { fake, prompts, coordinator, state: st };
}

const draft = "## Register the factory\n\nTwo reviewers plus synthesis.\n\n## Fail closed\n\nA pinned clause must be byte-identical.";

function panelResultFrom(clauses, extra = {}) {
  return {
    mode: "full",
    clauses,
    reviews: [
      { reviewerId: "claude", verdict: "revise", strengths: [], risks: [{ severity: "high", clauseId: "c1", evidence: "No retry budget.", recommendation: "Raise it." }], omissions: [], suggestedChanges: [] },
      { reviewerId: "openai", verdict: "approve", strengths: ["Tight"], risks: [], omissions: [], suggestedChanges: [] },
    ],
    quotes: { c1: [{ reviewerId: "claude", severity: "high", text: "No retry budget." }], c2: [] },
    disagreements: [{ topic: "Retries", positions: "a vs b", resolution: "Budget six." }],
    models: [{ id: "claude", model: "claude-sonnet-5", family: "anthropic" }, { id: "openai", model: "gpt-5.6-sol", family: "openai" }],
    degraded: null,
    ...extra,
  };
}

// The submission must not block on two model calls; the queue has to be free
// while the panel runs, or nothing else on the issue can proceed.
await test("submitting a plan posts a draft and releases the queue before the panel runs", async () => {
  let started = false;
  let releasedWhileRunning = false;
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async (input) => {
      started = true;
      // If the queue were still held, this nested enqueue would deadlock.
      const probe = await Promise.race([
        coordinator.handleIntent({ kind: "resume", owner: "o", repo: "r", issue: 7 }).then(() => "free"),
        new Promise((r) => setTimeout(() => r("blocked"), 150)),
      ]);
      releasedWhileRunning = probe === "free";
      return panelResultFrom(input.clauses);
    },
  });
  const res = await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  assert.equal(res.state.pending.kind, "plan-panel");
  assert.equal(res.state.gate, null, "the gate must not open before the panel finishes");
  assert.equal(headingOf(fake.comments.find((c) => /📝 Draft plan/.test(c.body)).body), "📝 Draft plan");
  await coordinator.panelSettled();
  assert.ok(started, "the panel ran");
  assert.ok(releasedWhileRunning, "the issue queue was released while the panel ran");
  assert.equal(stateOf(fake).gate, "plan-review");
});

await test("the panel posts evidence and a final plan, then opens the gate", async () => {
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async (input) => panelResultFrom(input.clauses),
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const st = stateOf(fake);
  assert.equal(st.gate, "plan-review");
  assert.equal(st.pending, null);
  assert.ok(findCommentByHeading(fake.comments, "🧑‍⚖️ Panel evidence"), "evidence comment posted");
  const plan = findCommentByHeading(fake.comments, "🗺 Plan", { newest: true });
  assert.ok(plan, "final plan comment posted");
  assert.match(findCommentByHeading(fake.comments, "🧑‍⚖️ Panel evidence").body, /claude-sonnet-5/, "evidence names the reviewers");
  assert.equal(st.panel.disagreements, 1);
  assert.equal(st.artifacts.plan.commentId, plan.commentId);
  assert.equal(st.artifacts.plan.clauses.length, 2);
});

// The whole point of two models: the second opinion must be visible per clause.
await test("per-clause quotes reach the gate through deriveState", async () => {
  const { fake, coordinator } = await makePlanLoop({ runPanel: async (i) => panelResultFrom(i.clauses) });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const view = deriveState({ owner: "o", repo: "r", issue: 7, iss: fake.issue, comments: fake.comments });
  assert.equal(view.gate, "plan-review");
  assert.equal(view.planClauses.length, 2);
  assert.equal(view.planClauses[0].title, "Register the factory");
  assert.ok(view.planClauses[0].text.length, "clause text survives the round trip");
  assert.equal(view.panel.quotes.c1[0].reviewerId, "claude");
  assert.equal(view.panel.models.length, 2);
});

await test("one reviewer down still opens the gate, labelled and never silent", async () => {
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async (i) => panelResultFrom(i.clauses, {
      degraded: { reason: "reviewer-unavailable", missing: [{ id: "openai", model: "gpt-5.6-sol", error: "timeout" }], survived: ["claude"] },
    }),
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const st = stateOf(fake);
  assert.equal(st.gate, "plan-review", "degradation must not block the human");
  assert.equal(st.panel.degraded.missing[0].id, "openai");
  assert.match(st.statusText, /one reviewer was unavailable/i);
  assert.match(findCommentByHeading(fake.comments, "🗺 Plan", { newest: true }).body, /single-reviewer/);
  assert.match(findCommentByHeading(fake.comments, "🧑‍⚖️ Panel evidence").body, /Degraded run/);
});

// Failing closed here would strand the run with no plan at all.
await test("a total panel failure promotes the unreviewed draft and says so", async () => {
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async () => { throw new Error("both reviewers unavailable"); },
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const st = stateOf(fake);
  assert.equal(st.gate, "plan-review");
  assert.match(st.panel.failed, /both reviewers unavailable/);
  assert.ok(findCommentByHeading(fake.comments, "⚠️ Plan panel failed"), "the failure is stated on the issue");
  assert.equal(st.artifacts.plan.commentId, st.artifacts.plan.draftCommentId, "the draft becomes the plan");
});

// q9: no feature flag, silent fallback — "silent" means non-blocking, not hidden.
await test("a host without factories falls back to the draft and records why", async () => {
  const { fake, coordinator } = await makePlanLoop({ runPanel: undefined });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const st = stateOf(fake);
  assert.equal(st.gate, "plan-review", "the loop still works without the panel");
  assert.equal(st.panel.skipped.reason, "factories-unavailable");
  assert.match(findCommentByHeading(fake.comments, "🧑‍⚖️ Panel evidence").body, /Panel skipped/);
});

// q4: a clause send-back re-runs synthesis only and reuses the stored reviews.
await test("send-back re-runs synthesis only and reuses the stored reviews", async () => {
  const calls = [];
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async (i) => { calls.push(i); return panelResultFrom(i.clauses); },
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();

  const st = stateOf(fake);
  await coordinator.handleIntent({
    kind: "plan-steer", owner: "o", repo: "r", issue: 7, controlCommentId: controlId(fake), expectedTxn: st.txn,
    data: { decisions: [{ clauseId: "c1", action: "pin" }, { clauseId: "c2", action: "send-back", instruction: "Name the hash." }] },
  });
  await coordinator.panelSettled();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].mode, "synthesis-only");
  assert.equal(calls[1].reviews.length, 2, "the stored reviews are reused, not re-billed");
  assert.equal(calls[1].rev, 2);
  assert.deepEqual(calls[1].decisions.map((d) => d.action), ["pin", "send-back"]);
  assert.equal(stateOf(fake).gate, "plan-review");
});

// The headline guarantee, end to end through the coordinator.
await test("a pinned clause survives a hostile re-synthesis byte for byte", async () => {
  let round = 0;
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async (i) => {
      round += 1;
      if (round === 1) return panelResultFrom(i.clauses);
      // Synthesis tries to rewrite the pinned clause.
      return panelResultFrom(i.clauses.map((c) => c.id === "c1" ? { ...c, text: "Rewritten against the human's wishes." } : c), { mode: "synthesis-only" });
    },
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const before = findCommentByHeading(fake.comments, "🗺 Plan", { newest: true }).body;

  const st = stateOf(fake);
  await coordinator.handleIntent({
    kind: "plan-steer", owner: "o", repo: "r", issue: 7, controlCommentId: controlId(fake), expectedTxn: st.txn,
    data: { decisions: [{ clauseId: "c1", action: "pin" }, { clauseId: "c2", action: "send-back", instruction: "Tighten." }] },
  });
  await coordinator.panelSettled();

  const after = findCommentByHeading(fake.comments, "🗺 Plan", { newest: true }).body;
  assert.ok(!after.includes("Rewritten against the human's wishes"), "the pinned clause was not rewritten");
  assert.ok(after.includes("Two reviewers plus synthesis."), "the pinned text is byte-identical");
  assert.notEqual(before, after, "a new plan revision was still posted");
});

await test("plan-steer rejects unknown clauses and no-op submissions", async () => {
  const { fake, coordinator } = await makePlanLoop({ runPanel: async (i) => panelResultFrom(i.clauses) });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const ctx = { kind: "plan-steer", owner: "o", repo: "r", issue: 7, controlCommentId: controlId(fake), expectedTxn: stateOf(fake).txn };
  await assert.rejects(() => coordinator.handleIntent({ ...ctx, data: { decisions: [{ clauseId: "c99", action: "drop" }] } }), /unknown clause c99/);
  await assert.rejects(() => coordinator.handleIntent({ ...ctx, data: { decisions: [{ clauseId: "c1", action: "delete" }] } }), /unknown clause action/);
  await assert.rejects(() => coordinator.handleIntent({ ...ctx, data: { decisions: [{ clauseId: "c1", action: "pin" }] } }), /nothing to re-run/);
});

// q1: model ids are a canvas setting persisted in the control block.
await test("panel-config persists reviewers and refuses a same-family pair", async () => {
  const { fake, coordinator } = await makePlanLoop({ runPanel: async (i) => panelResultFrom(i.clauses) });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const ctx = { kind: "panel-config", owner: "o", repo: "r", issue: 7, controlCommentId: controlId(fake), expectedTxn: stateOf(fake).txn };
  await assert.rejects(
    () => coordinator.handleIntent({ ...ctx, data: { reviewers: [{ id: "a", model: "claude-sonnet-5" }, { id: "b", model: "claude-opus-5" }] } }),
    /same provider family/,
  );
  await coordinator.handleIntent({ ...ctx, data: { reviewers: [{ id: "a", model: "gpt-5.6-sol" }, { id: "b", model: "gemini-3.1-pro-preview" }] } });
  assert.equal(stateOf(fake).panel.config.reviewers[1].model, "gemini-3.1-pro-preview");
});

await test("the configured reviewers are the ones actually dispatched", async () => {
  let seen = null;
  const st = planState({ panel: { config: { reviewers: [{ id: "a", model: "gpt-5.6-sol" }, { id: "b", model: "claude-sonnet-5" }] } } });
  const { coordinator } = await makePlanLoop({ state: st, runPanel: async (i) => { seen = i.reviewers; return panelResultFrom(i.clauses); } });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  assert.deepEqual(seen.map((r) => r.model), ["gpt-5.6-sol", "claude-sonnet-5"]);
});

// The panel packet must be built from durable issue state, not a transcript.
await test("the panel receives issue evidence and the deterministic branch", async () => {
  let seen = null;
  const { coordinator } = await makePlanLoop({ runPanel: async (i) => { seen = i; return panelResultFrom(i.clauses); } });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  assert.equal(seen.request, "Do the thing");
  assert.equal(seen.branch, "agent-loop/issue-7");
  assert.equal(seen.baseBranch, "main");
  assert.equal(seen.clauses.length, 2);
  assert.equal(seen.mode, "full");
});

await test("an explicit clause artifact wins over the markdown fallback", async () => {
  let seen = null;
  const { coordinator } = await makePlanLoop({ runPanel: async (i) => { seen = i; return panelResultFrom(i.clauses); } });
  await coordinator.submitStage({
    opId: "iss7/planning-finalize/t5", submissionToken: TOKEN,
    artifact: { body: draft, clauses: [{ id: "c1", title: "Only clause", text: "Exactly as authored." }] },
  });
  await coordinator.panelSettled();
  assert.equal(seen.clauses.length, 1);
  assert.equal(seen.clauses[0].title, "Only clause");
});

await test("markdown without headings still yields one steerable clause", () => {
  const out = clausesFromMarkdown("Just a paragraph with no headings at all.");
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "c1");
  assert.match(out[0].text, /Just a paragraph/);
  const many = clausesFromMarkdown("## A\n\ntext a\n\n## B\n\ntext b");
  assert.deepEqual(many.map((c) => c.id), ["c1", "c2"]);
});

// The control block is ONE comment and GitHub caps it; evidence must never inline.
await test("the control block refuses to exceed its budget", () => {
  assert.ok(CONTROL_BODY_LIMIT === 65536);
  const small = { stage: "planning", artifacts: {} };
  assert.ok(assertControlSize(small) < 1000);
  assert.throws(() => assertControlSize({ blob: "x".repeat(60000) }), /control block is too large/);
});

await test("oversized reviews are shed from the control block, not lost", async () => {
  const big = "x".repeat(30000);
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async (i) => panelResultFrom(i.clauses, {
      reviews: [{ reviewerId: "claude", verdict: "revise", strengths: [big], risks: [], omissions: [], suggestedChanges: [] },
                { reviewerId: "openai", verdict: "revise", strengths: [big], risks: [], omissions: [], suggestedChanges: [] }],
    }),
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const st = stateOf(fake);
  assert.equal(st.gate, "plan-review", "a large review must not break the gate");
  assert.deepEqual(st.panel.reviews, [], "reviews were shed from the control block");
  assert.ok(st.panel.reviewsCommentId, "and a pointer to them is kept");
  assert.match(findCommentByHeading(fake.comments, "🧑‍⚖️ Panel evidence").body, /x{500}/, "the full text survives in the comment");
});

// Clause anchors must survive the workflow sanitizer that mangles `AL-`.
await test("clause anchors survive the round trip through real issue comments", async () => {
  const { fake, coordinator } = await makePlanLoop({ runPanel: async (i) => panelResultFrom(i.clauses) });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const plan = findCommentByHeading(fake.comments, "🗺 Plan", { newest: true });
  assert.ok(!/\u200b/.test(plan.body), "no zero-width space was injected into the plan");
  const view = deriveState({ owner: "o", repo: "r", issue: 7, iss: fake.issue, comments: fake.comments });
  assert.equal(view.planClauses.length, 2, "clauses are still parseable after the sanitizer");
});

// A resumed or duplicated run must not bill a second pair of model calls.
await test("a replayed panel job is a no-op once the gate is open", async () => {
  let runs = 0;
  const { fake, coordinator } = await makePlanLoop({ runPanel: async (i) => { runs += 1; return panelResultFrom(i.clauses); } });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  assert.equal(runs, 1);
  // The same submission arriving again must not re-run the panel.
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  assert.equal(runs, 1, "the panel is not re-run for a duplicate submission");
  assert.equal(stateOf(fake).gate, "plan-review");
});

console.log(`\n${passed} plan-panel assertions passed`);
