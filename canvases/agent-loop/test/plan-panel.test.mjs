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
async function makePlanLoop({ runPanel, state, publishSequence } = {}) {
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
    publishSequence,
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
    ],
    quotes: { c1: [{ reviewerId: "claude", severity: "high", text: "No retry budget." }], c2: [] },
    disagreements: [{ topic: "Retries", positions: "reviewer asked for six", resolution: "Four is enough." }],
    models: [{ id: "claude", model: "claude-sonnet-5", family: "anthropic" }],
    synthesisModel: "claude-sonnet-5",
    ...extra,
  };
}

// The ISSUE QUEUE must be free while the panel runs, or the panel's own writes
// deadlock against the submission that started it. Note this is about the queue,
// not the call: submitStage does wait for the panel (see the test below).
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
  assert.ok(findCommentByHeading(fake.comments, "🧑‍⚖️ Review evidence"), "evidence comment posted");
  const plan = findCommentByHeading(fake.comments, "🗺 Plan", { newest: true });
  assert.ok(plan, "final plan comment posted");
  assert.match(findCommentByHeading(fake.comments, "🧑‍⚖️ Review evidence").body, /claude-sonnet-5/, "evidence names the reviewer");
  assert.equal(st.panel.disagreements, 1);
  assert.equal(st.artifacts.plan.commentId, plan.commentId);
  assert.equal(st.artifacts.plan.clauses.length, 2);
});

// An independent opinion is only useful if it lands on the specific clause it
// was about, so the human is not left diffing prose against prose.
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
  assert.equal(view.panel.models.length, 1);
  assert.equal(view.panelReviewer.model, "claude-sonnet-5", "the gate can name the reviewer before any run");
});

// A refused spawn and a bad review are different problems with different fixes,
// and the old code reported both as "the reviewer returned no review". The gate
// must carry the distinction, because it decides whether a retry is worth 19
// credits or is just going to fail the same way again.
await test("a review that never started is attributed to the host, not the model", async () => {
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async () => {
      const err = new Error("plan review run failed - the host admitted no subagent, so the review never started");
      err.code = "review-not-started";
      throw err;
    },
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const st = stateOf(fake);
  assert.equal(st.gate, "plan-review", "a failed review must not block the human");
  assert.equal(st.panel.failedCode, "review-not-started");
  assert.match(findCommentByHeading(fake.comments, "⚠️ Plan review failed").body, /never started/);
});

// Retrying must not redraft: the human never objected to the draft, only the
// review failed, and a redraft would re-bill the draft and move the clause ids.
await test("retrying the review re-runs step 2 against the same draft", async () => {
  let calls = 0;
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async (i) => {
      calls++;
      if (calls === 1) throw new Error("reviewer unavailable");
      return panelResultFrom(i.clauses);
    },
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const failedState = stateOf(fake);
  const draftId = failedState.artifacts.plan.commentId;

  await coordinator.handleIntent({
    kind: "plan-retry-review", owner: "o", repo: "r", issue: 7,
    controlCommentId: controlId(fake), expectedTxn: failedState.txn, data: {},
  });
  await coordinator.panelSettled();

  const st = stateOf(fake);
  assert.equal(calls, 2, "the review ran again");
  assert.equal(st.gate, "plan-review");
  assert.equal(st.panel.failed, null, "the stale failure is cleared");
  assert.equal(st.panel.rev, 2, "the retry is a new revision");
  assert.ok(findCommentByHeading(fake.comments, "🧑‍⚖️ Review evidence"), "the retry produced evidence");
  assert.notEqual(st.artifacts.plan.commentId, draftId, "the synthesized plan replaces the unreviewed draft");
});

// Failing closed here would strand the run with no plan at all.
await test("a total review failure promotes the unreviewed draft and says so", async () => {
  const { fake, coordinator } = await makePlanLoop({
    runPanel: async () => { throw new Error("reviewer unavailable"); },
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  const st = stateOf(fake);
  assert.equal(st.gate, "plan-review");
  assert.match(st.panel.failed, /reviewer unavailable/);
  assert.equal(st.panel.failedCode, "review-failed", "a reviewer that ran and failed is not a spawn refusal");
  assert.ok(findCommentByHeading(fake.comments, "⚠️ Plan review failed"), "the failure is stated on the issue");
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
  assert.match(findCommentByHeading(fake.comments, "🧑‍⚖️ Review evidence").body, /Review skipped/);
});

// Live step status is the only thing standing between a stalled run and an
// unattributed spinner. It is deliberately ephemeral — published to the canvas
// server's memory, never to the issue — so the test also pins the teardown: a
// tracker left behind after the run would misreport a finished run as live.
await test("step progress is published while the run is live and cleared after", async () => {
  const published = [];
  const { coordinator } = await makePlanLoop({
    publishSequence: (key, value) => published.push([key, value && JSON.parse(JSON.stringify(value))]),
    runPanel: async (i, onProgress) => {
      onProgress({ step: "review", state: "running", model: "claude-sonnet-5" });
      onProgress({ step: "review", state: "done", detail: "3 findings" });
      onProgress({ step: "synthesis", state: "running", model: "claude-sonnet-5" });
      return panelResultFrom(i.clauses);
    },
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();

  assert.ok(published.length >= 4, "each step transition is published");
  assert.deepEqual(published[0][0], "o/r/7", "progress is keyed by issue, not shared globally");
  assert.equal(published[0][1].steps.draft.state, "done", "the draft is already done when the review starts");
  assert.equal(published[0][1].steps.review.state, "waiting");
  const running = published.find(([, v]) => v && v.steps.review.state === "running");
  assert.equal(running[1].steps.review.model, "claude-sonnet-5", "the running step names its model");
  assert.ok(running[1].steps.review.startedAt, "a running step is timestamped so elapsed time is real");
  const doneReview = published.find(([, v]) => v && v.steps.review.state === "done");
  assert.equal(doneReview[1].steps.review.detail, "3 findings");
  assert.ok(doneReview[1].steps.review.endedAt);
  assert.equal(published.at(-1)[1], null, "the tracker is torn down once the outcome is durable");
});

// q4: a clause send-back re-runs synthesis only and reuses the stored review.
await test("send-back re-runs synthesis only and reuses the stored review", async () => {
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
  assert.equal(calls[1].reviews.length, 1, "the stored review is reused, not re-billed");
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

// The reviewer used to be configurable through a `panel-config` intent that no
// UI could reach, so the only thing the setting could actually do was put the
// review into an invalid state by hand-editing the control block. It is a
// constant now, and a stale control block must not resurrect the old value.
await test("the reviewer is a constant and ignores stale control-block config", async () => {
  let seen = null;
  const st = planState({ panel: { config: { reviewers: [{ id: "a", model: "gpt-5.6-sol" }, { id: "b", model: "claude-sonnet-5" }] } } });
  const { coordinator } = await makePlanLoop({ state: st, runPanel: async (i) => { seen = i.reviewer; return panelResultFrom(i.clauses); } });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  assert.deepEqual(seen, { id: "claude", model: "claude-sonnet-5" });
});

await test("panel-config is no longer a reachable intent", async () => {
  const { fake, coordinator } = await makePlanLoop({ runPanel: async (i) => panelResultFrom(i.clauses) });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  await coordinator.panelSettled();
  await assert.rejects(
    () => coordinator.handleIntent({
      kind: "panel-config", owner: "o", repo: "r", issue: 7,
      controlCommentId: controlId(fake), expectedTxn: stateOf(fake).txn,
      data: { reviewers: [{ id: "a", model: "gpt-5.6-sol" }, { id: "b", model: "claude-sonnet-5" }] },
    }),
    /unknown intent kind/,
  );
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
  assert.match(findCommentByHeading(fake.comments, "🧑‍⚖️ Review evidence").body, /x{500}/, "the full text survives in the comment");
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

// The bug this guards: the panel used to be pure fire-and-forget, so submitStage
// returned, the host turn ended, and the factory run was stopped before it could
// spawn a single reviewer. Every ctx.agent call then came back null, which the
// panel could only report as "reviewer returned no review" -- at zero credits and
// zero subagents, which is what made it look like a model fault for so long.
// Factory subagents only live as long as the turn that started them.
await test("submitStage does not resolve until the panel it started has finished", async () => {
  let panelDone = false;
  const { coordinator } = await makePlanLoop({
    runPanel: async (input) => {
      await new Promise((r) => setTimeout(r, 20));
      panelDone = true;
      return panelResultFrom(input.clauses);
    },
  });
  await coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  assert.equal(panelDone, true, "submitStage returned while the panel was still running");
});

// A call made while a panel is in flight must not wait on it. Waiting would hang
// an unrelated click for the length of a review, and deadlock a call made from
// inside the panel itself.
await test("an unrelated intent does not block on a panel it did not start", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { coordinator } = await makePlanLoop({
    runPanel: async (input) => { await gate; return panelResultFrom(input.clauses); },
  });
  const submission = coordinator.submitStage({ opId: "iss7/planning-finalize/t5", submissionToken: TOKEN, artifact: { body: draft } });
  const probe = await Promise.race([
    coordinator.handleIntent({ kind: "resume", owner: "o", repo: "r", issue: 7 }).then(() => "free"),
    new Promise((r) => setTimeout(() => r("blocked"), 150)),
  ]);
  assert.equal(probe, "free", "an intent that started no panel must not wait for one");
  release();
  await submission;
});

console.log(`\n${passed} plan-panel assertions passed`);
