import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub, makeLoop, stateOf, controlId, intent, order, writeProto, seedState } from "./loop.harness.mjs";
import { BUILTIN_DEFAULT, LEGACY_DEFAULT } from "../workflow-def.mjs";
import { reviewerFor, familyOf, runPanel, reviewMentionsOrchestration } from "../panel.mjs";
import { reviewPoints, encodeReview, decodeReview, encodePointReply } from "../review-points.mjs";
import { deriveState } from "../server.mjs";
import { clausesFromMarkdown, createCoordinator } from "../workflow.mjs";
import { createAgentLoopActions } from "../actions.mjs";

const workRoot = await mkdtemp(join(tmpdir(), "flow-review-"));
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok -", name); }
  catch (e) { process.exitCode = 1; console.error("FAIL -", name, e.stack || e); }
}

const draft = "## Gameplay\n\nAdd deterministic physics.\n\n## Controls\n\nUse W/S and arrow keys.";
const clauses = [
  { id: "c1", title: "Gameplay", text: "Add deterministic physics." },
  { id: "c2", title: "Controls", text: "Use W/S and arrow keys." },
];
const review = {
  reviewerId: "claude", verdict: "revise", strengths: [],
  risks: [{ severity: "medium", clauseId: "c1", evidence: "No pause rule.", recommendation: "Pause simulation." }],
  omissions: ["No keyboard focus."],
  suggestedChanges: [{ clauseId: "c2", change: "Name the active key handling." }],
};

await test("reviewer comes from a different model family", () => {
  assert.equal(familyOf(reviewerFor("gpt-6-sol").model), "anthropic");
  assert.equal(familyOf(reviewerFor("claude-sonnet-5").model), "openai");
  assert.throws(() => reviewerFor("auto"), /cannot determine/);
});

await test("review points round-trip and reject edited evidence", () => {
  const points = reviewPoints(review);
  assert.deepEqual(points.map((p) => p.id), ["p1", "p2", "p3"]);
  const encoded = encodeReview(review, points);
  assert.deepEqual(decodeReview(encoded.body, encoded.digest).points, points);
  assert.throws(() => decodeReview(encoded.body.replace("FL-REVIEW ", "FL-REVIEW x"), encoded.digest));
});

await test("plan markdown with clause anchors parses before any draft comment is posted", () => {
  const anchored = "<!-- alc:c1 -->\n### 1. Gameplay\n\nBuild physics.\n\n<!-- alc:c2 -->\n### 2. Controls\n\nUse keys.";
  assert.deepEqual(clausesFromMarkdown(anchored).map((c) => c.text), ["Build physics.", "Use keys."]);
  assert.throws(() => clausesFromMarkdown("<!-- alc:c1 -->\nMissing heading"), /missing its heading/);
});

await test("review-only, point reply, and decided synthesis are separate agent runs", async () => {
  const calls = [];
  const agent = async (call) => {
    calls.push(call);
    if (call.label.startsWith("review-point:")) return { reply: "Pause should freeze time.", recommendation: "Freeze both paddles and ball." };
    if (call.label.startsWith("plan-synthesis:")) return { clauses };
    return { ...review, reviewerId: undefined };
  };
  const r = await runPanel({ agent }, { clauses, opId: "a", mode: "review-only", reviewer: reviewerFor("gpt-6-sol") });
  assert.equal(calls.length, 1);
  assert.equal(r.clauses, undefined);
  assert.equal(r.reviews[0].risks.length, 1);
  const p = await runPanel({ agent }, { clauses, opId: "b", mode: "point-reply", reviewer: reviewerFor("gpt-6-sol"),
    point: reviewPoints(review)[0], message: "Can pause stop time?" });
  assert.equal(p.point.recommendation, "Freeze both paddles and ball.");
  const s = await runPanel({ agent }, { clauses, opId: "c", mode: "decided", reviews: r.reviews,
    reviewDecisions: [{ ...reviewPoints(review)[0], decision: "modify", instruction: "Freeze during pause." }],
    synthesisModel: "gpt-6-sol" });
  assert.equal(s.clauses.length, 2);
  assert.equal(calls[2].model, "gpt-6-sol");
  assert.match(calls[2].prompt, /Freeze during pause/);
  assert.deepEqual(calls.map((c) => c.label.split(":")[0]), ["plan-review", "review-point", "plan-synthesis"]);
});

await test("new flow gates review points before synthesis and final plan", async () => {
  const runs = [];
  let failSynthesis = true;
  const { fake, prompts, coordinator } = makeLoop(workRoot, {
    definition: BUILTIN_DEFAULT,
    currentModel: async () => "gpt-6-sol",
    runPanel: async (input) => {
      runs.push(input);
      if (input.mode === "review-only") return { mode: "review-only", reviews: [review],
        models: [{ id: "claude", model: "claude-sonnet-5", family: "anthropic" }] };
      if (input.mode === "decided") {
        if (failSynthesis) { failSynthesis = false; throw new Error("synthesis unavailable"); }
        return { mode: "decided", reviews: [review], clauses,
          models: [{ id: "claude", model: "claude-sonnet-5", family: "anthropic" }],
          synthesisModel: "gpt-6-sol", quotes: {}, disagreements: [] };
      }
      if (input.mode === "synthesis-only") return { mode: "synthesis-only", reviews: [review], clauses,
        models: [{ id: "claude", model: "claude-sonnet-5", family: "anthropic" }],
        synthesisModel: "gpt-6-sol", quotes: {}, disagreements: [] };
      throw new Error(`unexpected panel mode ${input.mode}`);
    },
  });
  await coordinator.kickoff({ reqId: "v2", idea: "Build Pong" });
  assert.equal(stateOf(fake).pipelineVersion, 2);
  let o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { body: "Research brief." } });
  await writeProto(workRoot, "o/r/7/round-1/a/index.html");
  o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: {
    options: [{ id: "a", title: "Arcade", pitch: "Pong", path: "o/r/7/round-1/a/index.html" }],
  } });
  await coordinator.handleIntent(intent(fake, "approve", { optionId: "a" }));
  o = order(prompts);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { body: "**q1.** (single) Mode?\n- Solo\n- Duo" } });
  await coordinator.handleIntent(intent(fake, "answers", { answers: [{ id: "q1", prompt: "Mode?", answer: "Solo" }] }));
  const planningInputs = stateOf(fake).pending.inputCommentIds;
  assert.ok(planningInputs.includes(stateOf(fake).artifacts.prototypeRounds[0].commentId));
  assert.ok(planningInputs.includes(stateOf(fake).artifacts.inputs.approve));
  o = order(prompts);
  assert.match(o.prompt, /Flow Loop canvas files and workflow mechanics are orchestration context/);
  await coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact: { body: draft } });
  assert.equal(stateOf(fake).stage, "review");
  assert.equal(stateOf(fake).gate, "review-points");
  assert.equal(runs.length, 1, "synthesis must not run before decisions");
  assert.match(runs[0].prototype, /Approved option from prototype comment/);
  assert.match(runs[0].prototype, /Approved prototype a/);
  assert.equal(runs[0].previewPath, "o/r/7/impl-round-1/demo/index.html");
  const view = deriveState({ owner: "o", repo: "r", issue: 7, iss: fake.issue, comments: fake.comments });
  assert.equal(view.review.points.length, 3);
  assert.equal(view.review.reviewer.model, "claude-sonnet-5");
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "review-continue")), /decide review point p1/);
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "review-chat", { pointId: "p1", message: "Question" })), /unknown intent kind/);
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "review-retry-chat")), /unknown intent kind/);
  const oldUser = await fake.createComment("o", "r", 7, "## 💬 p1 · user\n\nCan pause freeze both paddles?");
  const oldReply = await fake.createComment("o", "r", 7, "## 💬 p1 · reviewer\n\n" +
    encodePointReply({ reply: "Yes. Freeze physics.", recommendation: "Pause both paddles and ball." }));
  const current = stateOf(fake);
  await seedState(fake, { ...current, review: {
    ...current.review,
    threads: { p1: [{ userId: oldUser.id, agentId: oldReply.id }] },
    chatError: { message: "Previous reply failed", pointId: "p2", userId: oldUser.id },
  } });
  assert.equal(stateOf(fake).gate, "review-points");
  assert.equal(fake.comments.filter((c) => c.body.startsWith("## 💬 p1 · user")).length, 1);
  const refined = deriveState({ owner: "o", repo: "r", issue: 7, iss: fake.issue, comments: fake.comments });
  assert.equal(refined.review.points[0].messages.length, 2);
  assert.equal(refined.review.points[0].recommendation, "Pause both paddles and ball.");
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "review-decision", {
    pointId: "p1", decision: "modify",
  })), /modify requires/);
  await coordinator.handleIntent(intent(fake, "review-decision", { pointId: "p1", decision: "modify", instruction: "Freeze both." }));
  await coordinator.handleIntent(intent(fake, "review-decision", { pointId: "p2", decision: "ignore" }));
  await coordinator.handleIntent(intent(fake, "review-decision", { pointId: "p3", decision: "accept" }));
  await coordinator.handleIntent(intent(fake, "review-continue"));
  assert.equal(stateOf(fake).stage, "synthesis");
  assert.equal(stateOf(fake).pending.mode, "decided");
  await coordinator.resumePanel({ owner: "o", repo: "r", issue: 7 });
  assert.equal(stateOf(fake).gate, "review-points");
  assert.match(stateOf(fake).review.synthesisError, /synthesis unavailable/);
  await coordinator.handleIntent(intent(fake, "review-continue"));
  await coordinator.resumePanel({ owner: "o", repo: "r", issue: 7 });
  assert.equal(runs.length, 3);
  assert.deepEqual(runs[2].reviewDecisions.map((d) => d.decision), ["modify", "ignore", "accept"]);
  assert.equal(runs[2].reviewDecisions[0].recommendation, "Pause both paddles and ball.");
  assert.equal(stateOf(fake).gate, "plan-review");
  assert.equal(stateOf(fake).stage, "synthesis");
  assert.equal(stateOf(fake).review.synthesisError, null);
  assert.ok(stateOf(fake).artifacts.plan.commentId);
  await coordinator.handleIntent(intent(fake, "plan-steer", {
    decisions: [{ clauseId: "c1", action: "send-back", instruction: "Clarify pause timing." }],
  }));
  await coordinator.resumePanel({ owner: "o", repo: "r", issue: 7 });
  assert.equal(stateOf(fake).stage, "synthesis");
  assert.equal(stateOf(fake).gate, "plan-review");
  assert.deepEqual(runs.at(-1).reviewDecisions.map((d) => d.decision), ["modify", "ignore", "accept"]);
  await coordinator.handleIntent(intent(fake, "plan-ok"));
  assert.equal(stateOf(fake).stage, "implementing");
});

await test("in-flight legacy workflow still uses its original definition", async () => {
  const { fake, coordinator } = makeLoop(workRoot, { definition: LEGACY_DEFAULT });
  await coordinator.kickoff({ reqId: "legacy-compat", idea: "Legacy build" });
  assert.equal(stateOf(fake).pipelineVersion, undefined);
  assert.equal(stateOf(fake).workflow, undefined);
});

await test("review failure remains a visible retry gate, never an unreviewed final plan", async () => {
  const { fake, coordinator } = makeLoop(workRoot, {
    definition: BUILTIN_DEFAULT,
    runPanel: async () => { throw new Error("reviewer unavailable"); },
  });
  await coordinator.kickoff({ reqId: "review-failure", idea: "Fail visibly" });
  const state = stateOf(fake);
  const draftComment = await fake.createComment("o", "r", 7, "## 📝 Draft plan\n\n<!-- alc:c1 -->\n### 1. Gameplay\n\nBuild a game.");
  const seeded = { ...state, stage: "review", gate: null, status: "working", txn: 4,
    review: { draftCommentId: draftComment.id, authorModel: "gpt-6-sol",
      reviewer: reviewerFor("gpt-6-sol"), synthesisModel: "gpt-6-sol", decisions: {}, threads: {} },
    pending: { opId: "iss7/review/t4", kind: "plan-panel", phase: "panel", mode: "review-only", draftCommentId: draftComment.id, rev: 1 },
  };
  await seedState(fake, seeded);
  await coordinator.resumePanel({ owner: "o", repo: "r", issue: 7 });
  assert.equal(stateOf(fake).stage, "review");
  assert.equal(stateOf(fake).gate, "review-points");
  assert.match(stateOf(fake).review.failed, /reviewer unavailable/);
  assert.equal(stateOf(fake).artifacts.plan?.commentId, undefined);
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "review-continue")), /not available/);
});

await test("tampered review evidence is visible and can be re-reviewed", async () => {
  const { fake, coordinator } = makeLoop(workRoot, {
    definition: BUILTIN_DEFAULT,
    runPanel: async () => ({ mode: "review-only", reviews: [review],
      models: [{ id: "claude", model: "claude-sonnet-5", family: "anthropic" }] }),
  });
  await coordinator.kickoff({ reqId: "review-tamper", idea: "Review evidence" });
  const draftComment = await fake.createComment("o", "r", 7, "## 📝 Draft plan\n\n<!-- alc:c1 -->\n### 1. Gameplay\n\nBuild a game.");
  const payload = encodeReview(review, reviewPoints(review));
  const evidence = await fake.createComment("o", "r", 7, payload.body);
  const old = stateOf(fake);
  await seedState(fake, {
    ...old, stage: "review", gate: "review-points", status: "waiting", pending: null,
    review: { draftCommentId: draftComment.id, authorModel: "gpt-6-sol", reviewer: reviewerFor("gpt-6-sol"),
      synthesisModel: "gpt-6-sol", rev: 1, commentId: evidence.id,
      digest: payload.digest, decisions: {}, threads: {} },
  });
  evidence.body = evidence.body.replace("FL-REVIEW ", "FL-REVIEW x");
  const view = deriveState({ owner: "o", repo: "r", issue: 7, iss: fake.issue, comments: fake.comments });
  assert.match(view.reviewError, /payload changed/);
  await coordinator.handleIntent(intent(fake, "review-retry"));
  await coordinator.resumePanel({ owner: "o", repo: "r", issue: 7 });
  assert.equal(stateOf(fake).gate, "review-points");
  assert.notEqual(stateOf(fake).review.commentId, evidence.id);
});

await test("an undecided review can request a product-only redraft without losing source evidence", async () => {
  const fake = new FakeGitHub();
  fake.issue = {
    number: 7, title: "Music app", body: "Build a music app", html_url: "https://github.com/o/r/issues/7",
    labels: ["agent-loop", "stage:review", "gate:review-points"].map((name) => ({ name })),
  };
  const research = await fake.createComment("o", "r", 7, "## Research\nFind songs.");
  const prototype = await fake.createComment("o", "r", 7, "## Prototypes\nRecord Room.");
  const approval = await fake.createComment("o", "r", 7, "## Approved\nApproved prototype record-room.");
  const answers = await fake.createComment("o", "r", 7, "## Answers\nLocal playlist.");
  const draftComment = await fake.createComment("o", "r", 7, "## Draft plan\nBuild music app.");
  await seedState(fake, {
    version: 2, pipelineVersion: 2, txn: 9, owner: "o", repo: "r", issue: 7,
    title: "Music app", baseBranch: "main", stage: "review", gate: "review-points",
    round: 1, implRound: 0, status: "waiting", pending: null,
    artifacts: {
      research: { commentId: research.id },
      prototypeRounds: [{ round: 1, commentId: prototype.id, options: [{ id: "record-room" }] }],
      inputs: { approve: approval.id }, answers: { commentId: answers.id },
      plan: { draftCommentId: draftComment.id },
    },
    approved: "record-room",
    review: { draftCommentId: draftComment.id, decisions: {}, threads: {} },
  });
  const prompts = [];
  const coordinator = createCoordinator({
    github: fake, workRoot, readActive: async () => ({ owner: "o", repo: "r", issue: 7 }),
    sendPrompt: async (prompt) => { prompts.push(prompt); }, refresh: async () => {},
  });
  const entry = { coordinator, buildState: async () => ({ active: true, owner: "o", repo: "r", issue: 7 }) };
  const action = createAgentLoopActions({
    servers: new Map([["inst-1", entry]]), refreshAll: () => {},
  }).find((candidate) => candidate.name === "review_redraft");
  const input = { owner: "o", repo: "r", issue: 7, controlCommentId: controlId(fake),
    expectedTxn: 9, feedback: "Focus only on the music app." };
  await assert.rejects(() => action.handler({ instanceId: "inst-1", input: { ...input, expectedTxn: 8 } }), /stale intent txn/);
  await seedState(fake, {
    ...stateOf(fake), review: { draftCommentId: draftComment.id, decisions: { p1: { decision: "accept" } }, threads: {} },
  });
  await assert.rejects(() => action.handler({ instanceId: "inst-1", input }), /cannot discard/);
  await seedState(fake, {
    ...stateOf(fake), review: { draftCommentId: draftComment.id, decisions: {}, threads: {} },
  });
  const out = await action.handler({ instanceId: "inst-1", input });
  assert.equal(out.state.stage, "planning-finalize");
  assert.equal(out.state.pending.kind, "plan");
  for (const id of [research.id, prototype.id, approval.id, answers.id, draftComment.id]) {
    assert.ok(out.state.pending.inputCommentIds.includes(id), `missing source comment ${id}`);
  }
  assert.equal(out.state.review, null);
  assert.equal(out.state.artifacts.plan.approved, null);
  assert.match(prompts[0], /Flow Loop canvas files and workflow mechanics are orchestration context/);
  assert.ok(fake.comments.some((comment) => comment.body.includes("Focus only on the music app.")));
});

await test("out-of-scope replacement review fails closed; clean rerun preserves issue history", async () => {
  const fake = new FakeGitHub();
  fake.issue = {
    number: 7, title: "Music app", body: "Build a music app", html_url: "https://github.com/o/r/issues/7",
    labels: ["agent-loop", "stage:review", "gate:review-points"].map((name) => ({ name })),
  };
  const draftComment = await fake.createComment("o", "r", 7,
    "## 📝 Draft plan\n\n<!-- alc:c1 -->\n### 1. Search songs\n\nCurate metadata.");
  const oldReview = encodeReview(review, reviewPoints(review));
  const oldComment = await fake.createComment("o", "r", 7, oldReview.body);
  const oldUser = await fake.createComment("o", "r", 7, "## Earlier question\nIs a proxy needed?");
  const oldReply = await fake.createComment("o", "r", 7,
    "## Earlier reply\n" + encodePointReply({ reply: "Maybe.", recommendation: "Check provider CORS." }));
  await seedState(fake, {
    version: 2, pipelineVersion: 2, txn: 9, owner: "o", repo: "r", issue: 7,
    title: "Music app", baseBranch: "main", stage: "review", gate: "review-points",
    round: 1, implRound: 0, status: "waiting", pending: null,
    artifacts: { plan: { draftCommentId: draftComment.id } },
    review: { draftCommentId: draftComment.id, authorModel: "gpt-6-sol",
      reviewer: reviewerFor("gpt-6-sol"), synthesisModel: "gpt-6-sol", rev: 1,
      commentId: oldComment.id, digest: oldReview.digest, decisions: {},
      threads: { p1: [{ userId: oldUser.id, agentId: oldReply.id }] } },
  });
  let calls = 0;
  const coordinator = createCoordinator({
    github: fake, workRoot, readActive: async () => ({ owner: "o", repo: "r", issue: 7 }),
    sendPrompt: async () => {}, refresh: async () => {},
    runPanel: async () => {
      calls++;
      return { mode: "review-only", reviews: [calls === 1
        ? { ...review, risks: [{ ...review.risks[0], evidence: "Flow Loop preview server" }] }
        : review], models: [{ id: "claude", model: "claude-sonnet-5", family: "anthropic" }] };
    },
  });
  const entry = { coordinator, buildState: async () => ({ active: true, owner: "o", repo: "r", issue: 7 }) };
  const action = createAgentLoopActions({
    servers: new Map([["inst-1", entry]]), refreshAll: () => {},
  }).find((candidate) => candidate.name === "rerun_review");
  const route = { owner: "o", repo: "r", issue: 7, controlCommentId: controlId(fake),
    expectedTxn: 9, reason: "Keep findings focused on the music app." };
  await assert.rejects(() => action.handler({ instanceId: "inst-1", input: {
    ...route, expectedTxn: 8,
  } }), /stale intent txn/);
  await action.handler({ instanceId: "inst-1", input: route });
  await coordinator.resumePanel({ owner: "o", repo: "r", issue: 7 });
  assert.match(stateOf(fake).review.failed, /out-of-scope Flow Loop orchestration/);
  assert.equal(stateOf(fake).review.commentId, oldComment.id, "bad review cannot replace active evidence");
  await action.handler({ instanceId: "inst-1", input: {
    ...route, expectedTxn: stateOf(fake).txn,
  } });
  await coordinator.resumePanel({ owner: "o", repo: "r", issue: 7 });
  const next = stateOf(fake);
  assert.notEqual(next.review.commentId, oldComment.id);
  assert.equal(next.review.threads.p1, undefined, "prior exchange is not carried into a new review");
  assert.ok(fake.comments.some((comment) => comment.id === oldComment.id));
  assert.ok(fake.comments.some((comment) => comment.id === oldReply.id));
  const currentReview = decodeReview(fake.comments.find((comment) => comment.id === next.review.commentId).body, next.review.digest);
  assert.equal(reviewMentionsOrchestration(currentReview.review), false);
});

await test("explicit migration upgrades only bound idle legacy sign-off", async () => {
  const fake = new FakeGitHub();
  fake.issue = {
    number: 9, title: "Playlist", body: "Playlist idea", html_url: "https://github.com/o/r/issues/9",
    labels: ["agent-loop", "stage:prototype", "gate:signoff", "proto-round:1"].map((name) => ({ name })),
  };
  const prototypeRounds = [{ round: 1, commentId: 20, options: [{ id: "a", path: "o/r/9/round-1/a/index.html" }] }];
  await seedState(fake, {
    version: 2, txn: 3, owner: "o", repo: "r", issue: 9, title: "Playlist", baseBranch: "main",
    stage: "prototype", gate: "signoff", status: "waiting", round: 1, implRound: 0,
    pending: null, artifacts: { research: { commentId: 12 }, prototypeRounds },
  });
  const coordinator = createCoordinator({
    github: fake, workRoot, readActive: async () => ({ owner: "o", repo: "r", issue: 9 }),
    refresh: async () => {},
  });
  const action = createAgentLoopActions({
    servers: new Map([["inst-1", { coordinator }]]), refreshAll: () => {},
  }).find((entry) => entry.name === "migrate_default");
  const route = { owner: "o", repo: "r", issue: 9, expectedTxn: 3 };
  await assert.rejects(() => coordinator.migrateDefault({ ...route, issue: 7 }), /not bound/);
  await assert.rejects(() => coordinator.migrateDefault({ ...route, expectedTxn: 2 }), /stale migration/);
  const out = await action.handler({ instanceId: "inst-1", input: route });
  assert.equal(out.ok, true);
  assert.equal(stateOf(fake).pipelineVersion, 2);
  assert.equal(stateOf(fake).txn, 4);
  assert.equal(stateOf(fake).stage, "prototype");
  assert.equal(stateOf(fake).gate, "signoff");
  assert.deepEqual(stateOf(fake).artifacts.prototypeRounds, prototypeRounds);
  assert.deepEqual(fake.issue.labels.map((label) => label.name),
    ["agent-loop", "stage:prototype", "gate:signoff", "proto-round:1"]);
  const readModel = deriveState({ owner: "o", repo: "r", issue: 9, iss: fake.issue, comments: fake.comments });
  assert.equal(readModel.definition.steps.find((step) => step.id === "plan").next, "review");
  assert.equal((await coordinator.migrateDefault({ ...route, expectedTxn: 4 })).alreadyCurrent, true);
  await seedState(fake, { ...stateOf(fake), pipelineVersion: undefined, txn: 5, stage: "planning", gate: "questionnaire" });
  await assert.rejects(() => coordinator.migrateDefault({ ...route, expectedTxn: 5 }), /idle prototype sign-off/);
});

await rm(workRoot, { recursive: true, force: true });
console.log(`\n${passed} review-stage assertions passed`);
