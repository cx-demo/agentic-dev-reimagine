import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PHASED_DEFAULT, BUILTIN_DEFAULT, validateDefinition } from "../workflow-def.mjs";
import { createAgentLoopActions } from "../actions.mjs";
import { makeLoop, seedState, stateOf, intent, order, writeProto } from "./loop.harness.mjs";

const root = await mkdtemp(join(tmpdir(), "flow-phased-"));
try {
  assert.equal(validateDefinition(PHASED_DEFAULT).ok, true);
  assert.deepEqual([...new Set(PHASED_DEFAULT.steps.map((step) => step.phase))],
    ["Plan", "Build", "Review", "Audit", "Done"]);
  assert.deepEqual(PHASED_DEFAULT.steps.filter((step) => step.phase === "Plan")
    .map((step) => step.stage), ["research", "prototype", "draft", "draft", "synthesize"]);
  assert.deepEqual(PHASED_DEFAULT.steps.filter((step) => step.phase === "Review")
    .map((step) => step.stage), ["council", "feedback"]);
  assert.equal(BUILTIN_DEFAULT.steps.some((step) => step.id === "review"), true,
    "old workflow stays available for in-flight runs");

  const calls = { plans: [] };
  const { fake, prompts, coordinator } = makeLoop(root, {
    definition: PHASED_DEFAULT,
    currentModel: async () => "gpt-6-sol",
    runPanel: async (input) => {
      calls.plans.push(input);
      return {
        clauses: [{ id: "c1", title: "Build", text: "Build the app and test it." }],
        reviews: [{ reviewerId: input.reviewer.id, verdict: "revise",
          strengths: [], risks: [{ severity: "high", evidence: "No test",
            recommendation: "Add a test", clauseId: "c1" }], omissions: [], suggestedChanges: [] }],
        models: [{ ...input.reviewer, family: "anthropic" }],
        synthesisModel: input.synthesisModel, quotes: {}, disagreements: [],
      };
    },
  });
  const firstHead = "a".repeat(40);
  const fixedHead = "b".repeat(40);
  fake.pull.headRefOid = firstHead;
  fake.getPullFiles = async () => [{ filename: "src/app.js", status: "modified",
    patch: "@@ -1 +1 @@\n+validate(input)" }];
  await coordinator.kickoff({ reqId: "phased", idea: "Build a widget" });
  assert.equal(stateOf(fake).pipelineVersion, 3);
  const submit = async (artifact) => {
    const o = order(prompts);
    return coordinator.submitStage({ opId: o.opId, submissionToken: o.token, artifact });
  };
  const councilOrder = () => {
    const work = prompts.at(-1);
    assert.equal(work.kind, "council-session");
    const launch = JSON.parse(work.prompt.split("\n").find((line) => line.startsWith('{"repo_full_name":')));
    const data = JSON.parse(launch.kickoff.prompt.split("\n").find((line) => line.startsWith('{"owner":')));
    assert.equal(launch.repo_full_name, "o/r");
    assert.equal(launch.pr_number, 1);
    assert.equal(launch.kickoff.model, "claude-sonnet-5");
    assert.equal(launch.kickoff.mode, "autopilot");
    assert.equal(launch.notify_on_idle, "once");
    assert.match(launch.kickoff.prompt, /issue body and relevant discussion, PR description and review discussion/);
    assert.match(launch.kickoff.prompt, /repository code in this checkout/);
    return data;
  };
  const submitCouncil = (findings = []) => coordinator.submitCouncil({ ...councilOrder(), findings });
  await submit({ body: "Research promising approaches." });
  await writeProto(root, "o/r/7/round-1/a/index.html");
  await submit({ options: [{ id: "a", title: "Widget", pitch: "Useful widget",
    path: "o/r/7/round-1/a/index.html" }] });
  await coordinator.handleIntent(intent(fake, "approve", { optionId: "a" }));
  await submit({ body: "**q1.** (single) Scope?\n- Narrow\n- Broad" });
  await coordinator.handleIntent(intent(fake, "answers",
    { answers: [{ id: "q1", prompt: "Scope?", answer: "Narrow" }] }));
  await submit({ body: "## Build\n\nBuild the widget and test it." });
  assert.equal(calls.plans.length, 1, "plan review and synthesis run automatically");
  assert.equal(calls.plans[0].mode, "auto");
  assert.equal(calls.plans[0].reviewer.model, "claude-sonnet-5");
  assert.equal(stateOf(fake).gate, "plan-review");
  assert.equal(stateOf(fake).stage, "synthesis");
  await coordinator.handleIntent(intent(fake, "plan-ok"));
  assert.equal(stateOf(fake).pending.kind, "implement");
  await submit({ summary: "Built widget", preview: { kind: "none" } });
  assert.equal(stateOf(fake).pending.kind, "council-session", "Build dispatches a PR review session");
  assert.equal(councilOrder().headSha, firstHead);
  assert.equal(stateOf(fake).stage, "council");
  await assert.rejects(() => coordinator.submitCouncil({ ...councilOrder(),
    submissionToken: "wrong", findings: [] }), /invalid Council submission token/);
  await assert.rejects(() => coordinator.submitCouncil({ ...councilOrder(),
    headSha: fixedHead, findings: [] }), /pinned PR head/);
  await assert.rejects(() => coordinator.submitCouncil({ ...councilOrder(),
    issue: 8, findings: [] }), /bound issue/);
  fake.pull.headRefOid = fixedHead;
  await assert.rejects(() => submitCouncil([]), /PR head changed before Council review/);
  fake.pull.headRefOid = firstHead;
  const child = makeLoop(root, {
    definition: PHASED_DEFAULT,
    readActive: async () => ({ owner: "o", repo: "r", issue: 7 }),
    pins: { readPin: async () => { throw new Error("parent pin unavailable in child checkout"); } },
  });
  child.fake.pull.headRefOid = firstHead;
  child.fake.getPullFiles = fake.getPullFiles;
  await seedState(child.fake, { ...stateOf(fake),
    workflow: { id: "custom", rev: 1, hash: "sha256:separate", commentId: 999 } });
  const childActions = createAgentLoopActions({
    servers: new Map([["child", { coordinator: child.coordinator }]]),
    refreshAll: () => {},
  });
  await childActions.find((action) => action.name === "submit_council").handler({
    instanceId: "child", input: { ...councilOrder(), findings: [] },
  });
  assert.equal(stateOf(child.fake).stage, "feedback",
    "separate PR session action accepts findings without the creator's local workflow pin");
  await assert.rejects(() => coordinator.submitCouncil({ ...councilOrder(),
    findings: [{ category: "security", severity: "high", file: "src/unknown.js", line: 3,
      evidence: "Unvalidated input", impact: "Unauthorized access", remediation: "Validate input",
      confidence: "high" }] }), /unknown file/);
  assert.equal(stateOf(fake).stage, "council", "rejected review cannot unlock Feedback");
  await submitCouncil([{ category: "security", severity: "high", file: "src/app.js", line: 3,
    evidence: "Unvalidated input", impact: "Unauthorized access", remediation: "Validate input",
    confidence: "high", exploit: "Input may bypass access controls",
    snippet: "+validate(input)" }]);
  await assert.rejects(() => submitCouncil([]), /no longer pending/);
  assert.equal(stateOf(fake).stage, "feedback");
  assert.equal(stateOf(fake).council.findings[0].id, "f1");
  assert.equal(stateOf(fake).council.source, "pr-session");
  assert.match(stateOf(fake).council.summary.coverage.method, /PR session/);
  assert.equal(stateOf(fake).council.summary.severityCounts.high, 1);
  assert.equal(stateOf(fake).council.summary.checks.state, "absent");
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "council-decision",
    { findingId: "missing", status: "manual-fix", reason: "Needs independent fix.", owner: "Ada" })),
  /unknown Council finding/);
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "council-decision",
    { findingId: "f1", status: "manual-fix", reason: "Needs independent fix." })),
  /needs an owner/);
  await coordinator.handleIntent(intent(fake, "council-decision",
    { findingId: "f1", status: "manual-fix", reason: "Ada will patch this independently.", owner: "Ada" }));
  assert.equal(stateOf(fake).council.decisions.f1.owner, "Ada");
  assert.ok(stateOf(fake).council.decisions.f1.commentId);
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "ship", { reviewedHeadSha: firstHead })),
    /security blockers/);
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "ai-fix", { findingIds: ["other"] })),
    /unknown/);
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "waive-council", { reason: "short" })),
    /waiver reason/);
  await coordinator.handleIntent(intent(fake, "waive-council",
    { reason: "Reviewed and accepted this risk for a temporary internal build." }));
  assert.equal(stateOf(fake).council.waiver.headSha, firstHead);
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "ship", { reviewedHeadSha: firstHead })),
    /manual-fix findings/);
  await coordinator.handleIntent(intent(fake, "council-decision",
    { findingId: "f1", status: "accept-risk", reason: "Temporary internal build; risk reviewed." }));
  assert.equal(stateOf(fake).council.decisions.f1.status, "accept-risk");
  assert.equal(stateOf(fake).council.waiver.headSha, firstHead, "security waiver remains distinct");
  const archivedComment = stateOf(fake).council.commentId;
  await coordinator.handleIntent(intent(fake, "ai-fix", { findingIds: ["f1"] }));
  assert.equal(stateOf(fake).pending.kind, "implement");
  assert.equal(stateOf(fake).council, null, "previous review is invalidated on AI fix");
  assert.equal(stateOf(fake).councilHistory[0].commentId, archivedComment);
  assert.equal(stateOf(fake).councilHistory[0].decisions.f1.status, "accept-risk");
  assert.deepEqual(stateOf(fake).councilHistory[0].aiFix.findingIds, ["f1"]);
  assert.match(fake.comments.find((comment) =>
    comment.id === stateOf(fake).pending.inputCommentIds.at(-1)).body, /Validate input/);
  fake.pull.headRefOid = fixedHead;
  fake.getPullFiles = async () => [];
  await submit({ summary: "Fixed widget", preview: { kind: "none" } });
  await assert.rejects(() => submitCouncil([]), /complete nonempty PR file list/);
  assert.equal(stateOf(fake).stage, "council");
  await assert.rejects(() => coordinator.failCouncilSession({ ...councilOrder(),
    submissionToken: "wrong", reason: "Cannot read diff" }), /invalid Council submission token/);
  const creatorActions = createAgentLoopActions({
    servers: new Map([["creator", { coordinator }]]),
    refreshAll: () => {},
  });
  await creatorActions.find((action) => action.name === "council_session_failed").handler({
    instanceId: "creator", input: { ...councilOrder(), reason: "Review diff unavailable" },
  });
  assert.equal(stateOf(fake).gate, "council-retry", "incomplete diff cannot report a successful review");
  assert.match(stateOf(fake).council.failed, /Review diff unavailable/);
  fake.getPullFiles = async () => [{ filename: "src/app.js", status: "modified",
    patch: "@@ -1 +1 @@\n+validate(input)" }];
  await coordinator.handleIntent(intent(fake, "council-retry"));
  await submitCouncil();
  assert.equal(prompts.filter((work) => work.kind === "council-session").length, 3,
    "retry dispatches a new PR review session");
  assert.equal(stateOf(fake).council.headSha, fixedHead);
  assert.deepEqual(stateOf(fake).council.findings, []);
  assert.equal(stateOf(fake).councilHistory[0].headSha, firstHead);
  fake.getRequiredCheckContexts = async () => ({ state: "present", contexts: ["unit"] });
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "ship", { reviewedHeadSha: fixedHead })),
    /required checks are not passing/);
  fake.pull.statusCheckRollup = [{ name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }];
  await assert.rejects(() => coordinator.handleIntent(intent(fake, "council-refresh")),
    /changed open PR head/);
  const latestHead = "c".repeat(40);
  fake.pull.headRefOid = latestHead;
  await coordinator.handleIntent(intent(fake, "council-refresh"));
  await submitCouncil();
  assert.equal(stateOf(fake).council.headSha, latestHead);
  assert.equal(stateOf(fake).councilHistory.length, 2, "older review reports remain linked");
  assert.deepEqual(stateOf(fake).council.decisions, {}, "decisions do not leak across heads");
  await coordinator.handleIntent(intent(fake, "ship", { reviewedHeadSha: latestHead }));
  assert.equal(stateOf(fake).pending.kind, "finalize");
  console.log("phased workflow: automatic synthesis, Council, blocked Ship, AI fix, and re-review passed");

  const legacy = makeLoop(root, {
    definition: PHASED_DEFAULT,
    runCouncil: async (input) => ({
      headSha: input.headSha, reviewer: { model: "claude-sonnet-5" },
      findings: [], checks: input.checks,
    }),
  });
  legacy.fake.pull.headRefOid = latestHead;
  legacy.fake.getPullFiles = fake.getPullFiles;
  await seedState(legacy.fake, { ...stateOf(fake), stage: "council", gate: null, status: "working",
    pending: { opId: "iss7/council/t999", kind: "council-panel", phase: "panel",
      headSha: latestHead, implementerModel: "gpt-6-sol" }, council: null });
  await legacy.coordinator.resumePanel({ owner: "o", repo: "r", issue: 7 });
  assert.equal(stateOf(legacy.fake).stage, "feedback",
    "factory reviews already pending before the upgrade can still finish");
  const stalled = makeLoop(root, { definition: PHASED_DEFAULT });
  await seedState(stalled.fake, { ...stateOf(fake), stage: "council", gate: null, status: "working",
    pending: { opId: "iss7/council/t998", kind: "council-session", headSha: latestHead,
      implementerModel: "gpt-6-sol", attempt: 3 }, council: null });
  await stalled.coordinator.handleIntent(intent(stalled.fake, "resume"));
  assert.equal(stateOf(stalled.fake).gate, "council-retry",
    "an exhausted review session fails closed at the existing retry gate");
  assert.equal(stalled.prompts.length, 0, "exhaustion cannot launch another review");

  const historical = makeLoop(root, {
    definition: BUILTIN_DEFAULT,
    readActive: async () => ({ owner: "o", repo: "r", issue: 7 }),
  });
  const v2 = {
    owner: "o", repo: "r", issue: 7, pipelineVersion: 2, txn: 8,
    stage: "done", gate: null, status: "done", pending: null,
    artifacts: { impl: { prNumber: 1, headSha: firstHead }, finalized: { commentId: 42 } },
    review: { decisions: { p1: { decision: "accept" } } },
    migration: { from: 1, to: 2, at: "2026-01-01T00:00:00Z" },
  };
  await seedState(historical.fake, v2);
  await assert.rejects(() => historical.coordinator.migratePhaseHistory({
    owner: "o", repo: "r", issue: 7, expectedTxn: 7,
  }), /stale migration txn/);
  await seedState(historical.fake, { ...v2, stage: "implementing", status: "waiting" });
  await assert.rejects(() => historical.coordinator.migratePhaseHistory({
    owner: "o", repo: "r", issue: 7, expectedTxn: 8,
  }), /completed, unpinned v2 default/);
  await seedState(historical.fake, v2);
  const commentsBefore = historical.fake.comments.length;
  const migration = await historical.coordinator.migratePhaseHistory({
    owner: "o", repo: "r", issue: 7, expectedTxn: 8,
  });
  assert.equal(migration.state.pipelineVersion, 3);
  assert.equal(migration.state.phaseHistory.council, "not-run");
  assert.equal(migration.state.stage, "done");
  assert.equal(migration.state.txn, 9);
  assert.deepEqual(migration.state.review, v2.review);
  assert.deepEqual(migration.state.artifacts, v2.artifacts);
  assert.deepEqual(migration.state.migration, v2.migration);
  assert.equal(historical.prompts.length, 0, "history migration dispatches no agents");
  assert.equal(historical.fake.comments.length, commentsBefore,
    "history migration adds no synthetic review comments");
  assert.equal((await historical.coordinator.migratePhaseHistory({
    owner: "o", repo: "r", issue: 7, expectedTxn: 9,
  })).alreadyCurrent, true);
} finally {
  await rm(root, { recursive: true, force: true });
}
