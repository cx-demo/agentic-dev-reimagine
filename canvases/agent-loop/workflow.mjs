import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { STATE_SENTINEL, parseControlBlock, hasSentinel, parseQuestionnaire } from "./github.mjs";
import { normalizeClauses, renderClauses, parseClauses, indexClauses, spliceSynthesis, planStats, CLAUSE_ID_RE } from "./clauses.mjs";
import { REVIEWER, SYNTHESIS_MODEL } from "./panel.mjs";

export const LABEL_DEFINITIONS = [
  { name: "agent-loop", color: "5319e7", description: "Managed by the Agent Loop canvas" },
  ...["research", "prototype", "planning", "planning-finalize", "implementing", "finalizing", "done"].map((s) => ({
    name: `stage:${s}`, color: "0e8a16", description: `Agent Loop stage ${s}`,
  })),
  ...["signoff", "questionnaire", "plan-review", "feedback"].map((g) => ({
    name: `gate:${g}`, color: "fbca04", description: `Agent Loop human gate ${g}`,
  })),
];

const VERSION = 2;
const MAX_ATTEMPT = 3;
const MAX_VERIFY_RECHECK = 3;
const WORKFLOW_FIELD_RE = /^(stage|gate|txn|labels|pending|status|statusText|artifacts|approved|round|implRound)$/;

function now() { return new Date().toISOString(); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function tokenHash(t) { return createHash("sha256").update(String(t)).digest("hex"); }
function opTxn(issue, stage, txn) { return `iss${issue}/${stage}/t${txn}`; }
function opRound(issue, stage, round) { return `iss${issue}/${stage}/r${round}`; }
function branchFor(issue) { return `agent-loop/issue-${issue}`; }
function prTitle(issue, title) { return `Agent Loop #${issue}: ${title || "implementation"}`; }
function shortTitle(idea) {
  const s = String(idea || "Agent Loop job").replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 77) + "…" : s || "Agent Loop job";
}
function issueUrl(owner, repo, issue) { return `https://github.com/${owner}/${repo}/issues/${issue}`; }

// A plan submitted as plain markdown is split into one clause per heading so the
// steer-pins gate has something to pin. Explicit clauses from the stage agent
// always win over this fallback.
export function clausesFromMarkdown(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { id: `c${out.length + 1}`, title: m[1].trim(), text: "" };
    } else if (cur) {
      cur.text += line + "\n";
    }
  }
  if (cur) out.push(cur);
  const cleaned = out
    .map((c) => ({ ...c, text: c.text.trim() }))
    .filter((c) => c.title && c.text);
  if (cleaned.length) return cleaned.map((c, i) => ({ ...c, id: `c${i + 1}` }));
  return [{ id: "c1", title: "Plan", text: String(md || "").trim() }];
}
function prUrl(owner, repo, number) { return `https://github.com/${owner}/${repo}/pull/${number}`; }

function renderControl(data) {
  return `${STATE_SENTINEL}
<details>
<summary>Agent Loop state (managed by the canvas)</summary>

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
</details>`;
}

// GitHub rejects comment bodies over 65536 characters. The control block is ONE
// comment holding the whole serialized state, so panel evidence must never be
// inlined here — it lives in its own comments and the state keeps only pointers.
export const CONTROL_BODY_LIMIT = 65536;
const CONTROL_BUDGET = 48000;

export function assertControlSize(data) {
  const size = renderControl(data).length;
  if (size > CONTROL_BUDGET) {
    throw new Error(`control block is too large (${size} > ${CONTROL_BUDGET} chars); store evidence in a separate comment`);
  }
  return size;
}

function marker(type, opId, payload) {
  const suffix = payload == null ? "" : " b64:" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `<!-- ${type} ${opId}${suffix} -->`;
}

function safeBody(body) {
  return String(body || "").trim().replace(/<!--\s*AL-/g, "<!-- AL\u200b-");
}

function renderIn({ heading, body, opId }) {
  return `## ${heading}\n\n${safeBody(body)}\n\n${marker("AL-IN", opId)}`;
}

function renderOut({ heading, body, opId, payload }) {
  return `## ${heading}\n\n${safeBody(body)}\n\n${marker("AL-OUT", opId, payload)}`;
}

function renderSys({ heading, body, opId, payload }) {
  return `## ${heading}\n\n${safeBody(body)}\n\n${marker("AL-SYS", opId, payload)}`;
}

export function findCanonicalControl(comments) {
  const found = [];
  for (const c of comments || []) {
    if (!hasSentinel(c.body)) continue;
    const data = parseControlBlock(c.body);
    if (data) found.push({ commentId: c.id, data, body: c.body });
  }
  if (!found.length) return null;
  found.sort((a, b) => (Number(b.data.txn || 0) - Number(a.data.txn || 0)) || (Number(a.commentId) - Number(b.commentId)));
  return found[0];
}

function desiredLabels(state) {
  const out = ["agent-loop"];
  if (state.stage) out.push(`stage:${state.stage}`);
  if (state.gate) out.push(`gate:${state.gate}`);
  if (state.round) out.push(`proto-round:${state.round}`);
  if (state.implRound) out.push(`impl-round:${state.implRound}`);
  return out;
}

function createQueue() {
  const chains = new Map();
  return function enqueue(key, fn) {
    const prior = chains.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(fn);
    const stored = next.catch(() => {}).finally(() => {
      if (chains.get(key) === stored) chains.delete(key);
    });
    chains.set(key, stored);
    return next;
  };
}

const enqueueIssueShared = createQueue();
const enqueueReqShared = createQueue();

function assertNoWorkflowFields(artifact) {
  for (const k of Object.keys(artifact || {})) {
    if (WORKFLOW_FIELD_RE.test(k)) throw new Error(`artifact may not set workflow field ${k}`);
  }
}

function sanitizePreview(preview) {
  const p = preview && typeof preview === "object" ? preview : { kind: "none" };
  const kind = ["web", "command", "none"].includes(p.kind) ? p.kind : "none";
  const out = { kind };
  if (Array.isArray(p.run)) out.run = p.run.map((x) => String(x)).slice(0, 10);
  if (p.notes) out.notes = String(p.notes).slice(0, 2000);
  return out;
}

function normalizeRel(p) {
  return String(p || "").replace(/[\\/]+/g, sep);
}

async function safeHashFile(workRoot, owner, repo, issue, relPath) {
  const rel = normalizeRel(relPath);
  if (!rel || rel.includes(".." + sep) || rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`invalid artifact path: ${relPath}`);
  }
  const scope = normalize(join(workRoot, owner, repo, String(issue)));
  const full = normalize(join(workRoot, rel));
  const within = (child, root) => child === root || child.startsWith(root + sep);
  if (!within(full, scope)) throw new Error(`artifact path escapes issue scope: ${relPath}`);
  const st = await stat(full).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`artifact file missing: ${relPath}`);
  const realScope = await realpath(scope).catch(() => scope);
  const realFull = await realpath(full).catch(() => null);
  if (!realFull || !within(realFull, realScope)) throw new Error(`artifact path escapes issue scope: ${relPath}`);
  const buf = await readFile(full);
  return createHash("sha256").update(buf).digest("hex");
}

function checkToken(pending, token) {
  if (!pending || !token) return false;
  const hash = tokenHash(token);
  return [pending.submissionTokenHash, ...(pending.priorSubmissionTokenHashes || [])]
    .filter(Boolean)
    .includes(hash);
}

function parseCheckPhase(c) {
  const status = String((c && c.status) || "").toUpperCase();
  const concl = String((c && c.conclusion) || "").toUpperCase();
  const state = String((c && c.state) || "").toUpperCase();
  const name = c && (c.name || c.context || c.workflowName || c.__typename || "check");
  if (state) {
    if (state === "SUCCESS") return { name, phase: "passed" };
    if (state === "FAILURE" || state === "ERROR") return { name, phase: "failed" };
    return { name, phase: "pending" };
  }
  if (status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(concl)) return { name, phase: "passed" };
  if (status === "COMPLETED" && ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"].includes(concl)) return { name, phase: "failed" };
  return { name, phase: "pending" };
}

export function createCoordinator(deps) {
  const github = deps.github;
  const enqueueIssue = deps.enqueueIssue || enqueueIssueShared;
  const enqueueReq = deps.enqueueReq || enqueueReqShared;
  const workRoot = deps.workRoot;
  const assetBase = (deps.assetBase || "").replace(/\/$/, "");
  const instanceId = deps.instanceId || "agent-loop";

  async function refresh() { try { await deps.refresh?.(); } catch {} }
  async function read(owner, repo, issue) {
    const [iss, comments] = await Promise.all([github.getIssue(owner, repo, issue), github.listComments(owner, repo, issue)]);
    const control = findCanonicalControl(comments);
    return { iss, comments, control, state: control ? control.data : null, controlCommentId: control ? control.commentId : null };
  }
  async function commit(owner, repo, issue, controlCommentId, next, expectedTxn = null) {
    if (controlCommentId) {
      const live = findCanonicalControl(await github.listComments(owner, repo, issue));
      if (!live || String(live.commentId) !== String(controlCommentId)) throw new Error("canonical control comment changed");
      if (expectedTxn != null && Number(live.data.txn) !== Number(expectedTxn)) throw new Error("control txn changed before update");
    }
    assertControlSize(next);
    const body = renderControl(next);
    if (controlCommentId) await github.updateComment(owner, repo, controlCommentId, body);
    else {
      const c = await github.createComment(owner, repo, issue, body);
      controlCommentId = c.id;
    }
    await github.reconcileWorkflowLabels(owner, repo, issue, desiredLabels(next));
    return { controlCommentId, state: next };
  }
  function activeState(owner, repo, issue, data) {
    return {
      version: VERSION, txn: 1, reqId: data.reqId, owner, repo, issue,
      title: data.title, baseBranch: data.baseBranch || "main", stage: "research", gate: null, round: 1, implRound: 0,
      status: "working", statusText: "Researching prior art…", updatedAt: now(),
      pending: { opId: opTxn(issue, "research", 1), kind: "research", inputCommentIds: [], attempt: 1 },
      artifacts: {},
    };
  }
  async function ensureControl(owner, repo, issue, reqId, title) {
    const cur = await read(owner, repo, issue);
    if (cur.control) return cur;
    const state = activeState(owner, repo, issue, { reqId, title, baseBranch: deps.baseBranch || "main" });
    const c = await github.createComment(owner, repo, issue, renderControl(state));
    await github.reconcileWorkflowLabels(owner, repo, issue, desiredLabels(state));
    return { ...cur, control: { commentId: c.id, data: state }, controlCommentId: c.id, state };
  }
  async function dispatch(owner, repo, issue, state, controlCommentId) {
    const pending = state.pending;
    if (!pending || pending.kind === "verify-pr") return { ok: true, state };
    const token = randomBytes(24).toString("hex");
    const priorSubmissionTokenHashes = [
      ...(pending.priorSubmissionTokenHashes || []),
      pending.submissionTokenHash,
    ].filter(Boolean).slice(-(MAX_ATTEMPT - 1));
    const next = {
      ...clone(state),
      pending: {
        ...clone(pending),
        submissionTokenHash: tokenHash(token),
        ...(priorSubmissionTokenHashes.length ? { priorSubmissionTokenHashes } : {}),
      },
      updatedAt: now(),
    };
    await commit(owner, repo, issue, controlCommentId, next, state.txn);
    const prompt = buildWorkOrder({ owner, repo, issue, state: next, pending: next.pending, submissionToken: token });
    await deps.sendPrompt(prompt, pending.kind);
    await refresh();
    return { ok: true, state: next, workOrder: prompt };
  }
  async function reloadAndDispatch(owner, repo, issue) {
    const cur = await read(owner, repo, issue);
    if (!cur.state) throw new Error("missing control block");
    return dispatch(owner, repo, issue, cur.state, cur.controlCommentId);
  }

  async function kickoff(input) {
    const reqId = String(input.reqId || "");
    if (!reqId) throw new Error("reqId is required");
    return enqueueReq(reqId, async () => {
      const repoInfo = await github.detectRepo();
      const owner = repoInfo.owner;
      const repo = repoInfo.repo;
      deps.baseBranch = repoInfo.defaultBranch || "main";
      await github.ensureLabels(owner, repo, LABEL_DEFINITIONS);
      let iss = await github.findIssueByReqId(owner, repo, reqId);
      const adopted = !!iss;
      if (!iss) {
        const idea = String(input.idea || "").trim();
        if (!idea) throw new Error("idea is required");
        iss = await github.createIssue(owner, repo, {
          title: shortTitle(idea),
          body: `${idea}\n\n<!-- AL-REQ ${reqId} -->`,
          labels: ["agent-loop", "stage:research", "proto-round:1"],
        });
      }
      await deps.setActive?.(owner, repo, iss.number);
      const cur = await ensureControl(owner, repo, iss.number, reqId, iss.title || shortTitle(input.idea));
      await refresh();
      if (adopted && cur.state?.pending?.submissionTokenHash) return { ok: true, state: cur.state };
      return dispatch(owner, repo, iss.number, cur.state, cur.controlCommentId);
    });
  }

  function validateIntent(cur, intent, gate) {
    const st = cur.state;
    if (!st) throw new Error("missing control block");
    if (String(intent.owner) !== String(st.owner) || String(intent.repo) !== String(st.repo) ||
        String(intent.issue) !== String(st.issue) || String(intent.controlCommentId) !== String(cur.controlCommentId)) {
      throw new Error("intent route does not match live issue");
    }
    if (Number(intent.expectedTxn) !== Number(st.txn)) throw new Error("stale intent txn");
    if (gate && st.gate !== gate) throw new Error(`intent is not valid for gate ${st.gate || "none"}`);
    if (st.pending) throw new Error("another operation is pending");
  }

  function validateRoute(cur, intent, gate) {
    const st = cur.state;
    if (!st) throw new Error("missing control block");
    if (String(intent.owner) !== String(st.owner) || String(intent.repo) !== String(st.repo) ||
        String(intent.issue) !== String(st.issue) || String(intent.controlCommentId) !== String(cur.controlCommentId)) {
      throw new Error("intent route does not match live issue");
    }
    if (gate && st.gate !== gate) throw new Error(`intent is not valid for gate ${st.gate || "none"}`);
  }

  function duplicateIntent(cur, intent) {
    const n = Number(intent.expectedTxn || 0) + 1;
    const i = Number(intent.issue);
    const candidates = [];
    if (intent.kind === "approve") candidates.push(opTxn(i, "planning", n));
    if (intent.kind === "answers" || intent.kind === "plan-revise") candidates.push(opTxn(i, "planning-finalize", n));
    if (intent.kind === "ship") candidates.push(opTxn(i, "finalizing", n), opTxn(i, "ship-confirm", n));
    if (intent.kind === "plan-ok") candidates.push(opRound(i, "implementing", 1));
    for (const opId of candidates) {
      if (github.findCommentByOpMarker?.(cur.comments, "AL-IN", opId)) return true;
    }
    return false;
  }

  async function postInputOnce(owner, repo, issue, comments, opId, heading, body) {
    const existing = github.findCommentByOpMarker?.(comments, "AL-IN", opId);
    if (existing) return existing.commentId;
    const c = await github.createComment(owner, repo, issue, renderIn({ heading, body, opId }));
    return c.id;
  }

  async function handleIntent(intent) {
    if (intent.kind === "kickoff") return kickoff(intent.data || intent);
    const owner = intent.owner, repo = intent.repo, issue = Number(intent.issue);
    if (!owner || !repo || !Number.isInteger(issue) || issue < 1) throw new Error("valid owner, repo and issue are required");
    if (intent.kind === "open-existing") {
      const detected = await github.detectRepo();
      if (detected.owner !== owner || detected.repo !== repo) throw new Error("selected issue is outside the current workspace repository");
    }
    const issueKey = `${owner}/${repo}/${issue}`;
    return awaitingPanel(issueKey, () => enqueueIssue(issueKey, async () => {
      const cur = await read(owner, repo, issue);
      const st = cur.state;
      const data = intent.data || {};
      if (intent.kind === "open-existing") {
        const labels = (cur.iss.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean);
        if (!labels.includes("agent-loop")) throw new Error("selected issue is not managed by Agent Loop");
        if (!cur.control || !st) throw new Error("selected issue has no valid Agent Loop control block");
        if (String(st.owner) !== String(owner) || String(st.repo) !== String(repo) || Number(st.issue) !== issue) {
          throw new Error("selected issue control block has mismatched routing");
        }
        await deps.setActive?.(owner, repo, issue);
        await refresh();
        return { ok: true, state: st };
      }
      if (intent.kind === "resume") return recover(owner, repo, issue, cur);
      if (intent.kind === "review-local") {
        validateRoute(cur, intent, "feedback");
        const prNumber = st.artifacts?.impl?.prNumber;
        if (!prNumber) throw new Error("no PR is available for review-local");
        const prompt = [
          "AGENT LOOP REVIEW-LOCAL WORK ORDER",
          `Canvas instance: ${instanceId}. Do not open or mutate any Agent Loop workflow state.`,
          `Call open_pr_session for exactly ${owner}/${repo} PR #${prNumber}.`,
          `Use branch ${branchFor(issue)} for display/context only.`,
          "Do not post issue comments, update labels, update the control block, run stages, or call submit_stage.",
        ].join("\n");
        await deps.sendPrompt(prompt, "review-local");
        await refresh();
        return { ok: true, state: st, workOrder: prompt };
      }
      if (Number(intent.expectedTxn) !== Number(st?.txn) && duplicateIntent(cur, intent)) {
        validateRoute(cur, intent);
        return { ok: true, state: st, duplicate: true };
      }
      if (intent.kind === "approve") return approve(owner, repo, issue, cur, data, intent);
      if (intent.kind === "iterate") return iterate(owner, repo, issue, cur, data, intent);
      if (intent.kind === "answers") return answers(owner, repo, issue, cur, data, intent);
      if (intent.kind === "plan-ok") return planOk(owner, repo, issue, cur, data, intent);
      if (intent.kind === "plan-revise") return planRevise(owner, repo, issue, cur, data, intent);
      if (intent.kind === "plan-steer") return planSteer(owner, repo, issue, cur, data, intent);
      if (intent.kind === "plan-retry-review") return planRetryReview(owner, repo, issue, cur, data, intent);
      if (intent.kind === "revise") return revise(owner, repo, issue, cur, data, intent);
      if (intent.kind === "ship") return ship(owner, repo, issue, cur, data, intent);
      throw new Error(`unknown intent kind ${intent.kind}`);
    }));
  }

  async function approve(owner, repo, issue, cur, data, intent) {
    validateIntent(cur, intent, "signoff");
    const st = cur.state;
    const optionId = String(data.optionId || "");
    const round = st.round || 1;
    const latest = (st.artifacts?.prototypeRounds || []).find((r) => Number(r.round) === Number(round));
    const opt = latest && (latest.options || []).find((o) => o.id === optionId);
    if (!opt) throw new Error("selected prototype option is not in the current round");
    try {
      const sha = await safeHashFile(workRoot, owner, repo, issue, opt.path);
      if (sha !== opt.sha) throw new Error("prototype hash mismatch");
    } catch (e) {
      return regeneratePrototype(owner, repo, issue, cur, `Prototype option ${optionId} could not be verified: ${e.message}`);
    }
    const newTxn = Number(st.txn || 0) + 1;
    const opId = opTxn(issue, "planning", newTxn);
    const body = `Approved prototype ${optionId} from round ${round}.${data.notes ? "\n\n" + data.notes : ""}`;
    const inId = await postInputOnce(owner, repo, issue, cur.comments, opId, "✅ Approved", body);
    const pending = {
      opId,
      kind: "plan-questions",
      inputCommentIds: [st.artifacts?.research?.commentId, latest.commentId, inId].filter(Boolean),
      mode: "questions",
      attempt: 1,
    };
    const next = { ...clone(st), approved: optionId, stage: "planning", gate: null, status: "working", statusText: "Drafting clarifying questions…", pending, txn: newTxn, updatedAt: now() };
    next.artifacts = { ...(next.artifacts || {}), inputs: { ...(next.artifacts?.inputs || {}), approve: inId } };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    return dispatch(owner, repo, issue, next, cur.controlCommentId);
  }

  async function iterate(owner, repo, issue, cur, data, intent) {
    validateIntent(cur, intent, "signoff");
    if (!String(data.feedback || "").trim()) throw new Error("feedback is required");
    const st = cur.state;
    const round = Number(st.round || 1) + 1;
    const opId = opRound(issue, "prototype", round);
    const inId = await postInputOnce(owner, repo, issue, cur.comments, opId, "✏️ Refine", data.feedback);
    const pending = { opId, kind: "prototype", inputCommentIds: [st.artifacts?.research?.commentId, inId].filter(Boolean), round, attempt: 1 };
    const next = { ...clone(st), stage: "prototype", gate: null, round, status: "working", statusText: `Refining — round ${round}…`, pending, txn: Number(st.txn || 0) + 1, updatedAt: now() };
    next.artifacts = { ...(next.artifacts || {}), inputs: { ...(next.artifacts?.inputs || {}), refineIds: [...(next.artifacts?.inputs?.refineIds || []), inId] } };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    return dispatch(owner, repo, issue, next, cur.controlCommentId);
  }

  async function regeneratePrototype(owner, repo, issue, cur, why) {
    const st = cur.state;
    const round = Number(st.round || 1) + 1;
    const newTxn = Number(st.txn || 0) + 1;
    const opId = opRound(issue, "prototype", round);
    await github.createComment(owner, repo, issue, renderSys({ heading: "⚠️ Prototype re-generated", body: why, opId: opTxn(issue, "proto-invalidate", newTxn), payload: { round } }));
    const pending = { opId, kind: "prototype", inputCommentIds: [st.artifacts?.research?.commentId].filter(Boolean), round, attempt: 1 };
    const next = { ...clone(st), stage: "prototype", gate: null, round, status: "working", statusText: `Regenerating prototypes — round ${round}…`, pending, txn: newTxn, updatedAt: now() };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    return dispatch(owner, repo, issue, next, cur.controlCommentId);
  }

  async function answers(owner, repo, issue, cur, data, intent) {
    validateIntent(cur, intent, "questionnaire");
    const st = cur.state;
    const newTxn = Number(st.txn || 0) + 1;
    const opId = opTxn(issue, "planning-finalize", newTxn);
    const body = Array.isArray(data.answers)
      ? data.answers.map((a) => `${a.id}. ${a.prompt}\n> ${a.answer || "(no answer)"}`).join("\n\n")
      : String(data.body || "");
    const inId = await postInputOnce(owner, repo, issue, cur.comments, opId, "💬 Answers", body);
    const pending = { opId, kind: "plan", inputCommentIds: [st.artifacts?.research?.commentId, st.artifacts?.questionnaire?.commentId, inId].filter(Boolean), mode: "finalize", attempt: 1 };
    const next = { ...clone(st), stage: "planning-finalize", gate: null, status: "working", statusText: "Drafting the plan…", pending, txn: newTxn, updatedAt: now() };
    next.artifacts = { ...(next.artifacts || {}), answers: { commentId: inId } };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    return dispatch(owner, repo, issue, next, cur.controlCommentId);
  }

  async function planOk(owner, repo, issue, cur, data, intent) {
    validateIntent(cur, intent, "plan-review");
    const st = cur.state;
    const opId = opRound(issue, "implementing", 1);
    const inId = await postInputOnce(owner, repo, issue, cur.comments, opId, "✅ Plan approved", data.notes || "Plan approved.");
    const pending = { opId, kind: "implement", inputCommentIds: [st.artifacts?.plan?.commentId, inId].filter(Boolean), round: 1, attempt: 1 };
    const next = { ...clone(st), stage: "implementing", gate: null, implRound: 1, status: "working", statusText: "Building the change…", pending, txn: Number(st.txn || 0) + 1, updatedAt: now() };
    next.artifacts = { ...(next.artifacts || {}), plan: { ...(next.artifacts?.plan || {}), approved: true } };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    return dispatch(owner, repo, issue, next, cur.controlCommentId);
  }

  async function planRevise(owner, repo, issue, cur, data, intent) {
    validateIntent(cur, intent, "plan-review");
    if (!String(data.feedback || "").trim()) throw new Error("feedback is required");
    const st = cur.state;
    const newTxn = Number(st.txn || 0) + 1;
    const opId = opTxn(issue, "planning-finalize", newTxn);
    const inId = await postInputOnce(owner, repo, issue, cur.comments, opId, "✏️ Plan changes", data.feedback);
    const pending = { opId, kind: "plan", inputCommentIds: [st.artifacts?.plan?.commentId, inId].filter(Boolean), mode: "finalize", attempt: 1 };
    const next = { ...clone(st), stage: "planning-finalize", gate: null, status: "working", statusText: "Revising the plan…", pending, txn: newTxn, updatedAt: now() };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    return dispatch(owner, repo, issue, next, cur.controlCommentId);
  }

  async function revise(owner, repo, issue, cur, data, intent) {
    validateIntent(cur, intent, "feedback");
    if (!String(data.feedback || "").trim()) throw new Error("feedback is required");
    const st = cur.state;
    const round = Number(st.implRound || st.artifacts?.impl?.round || 1) + 1;
    const opId = opRound(issue, "implementing", round);
    const inId = await postInputOnce(owner, repo, issue, cur.comments, opId, "✏️ Request changes", data.feedback);
    const pending = { opId, kind: "implement", inputCommentIds: [st.artifacts?.plan?.commentId, inId].filter(Boolean), round, attempt: 1 };
    const next = { ...clone(st), stage: "implementing", gate: null, implRound: round, status: "working", statusText: `Revising PR #${st.artifacts?.impl?.prNumber || "?"}…`, pending, txn: Number(st.txn || 0) + 1, updatedAt: now() };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    return dispatch(owner, repo, issue, next, cur.controlCommentId);
  }

  async function ship(owner, repo, issue, cur, data, intent) {
    validateIntent(cur, intent, "feedback");
    const st = cur.state;
    const impl = st.artifacts?.impl || {};
    const reviewed = data.reviewedHeadSha || impl.headSha;
    if (!impl.prNumber || !reviewed) throw new Error("ship requires a pinned PR head");
    const live = await github.getPullValidation(owner, repo, impl.prNumber);
    if (live.headRefOid && live.headRefOid !== reviewed) {
      const newTxn = Number(st.txn || 0) + 1;
      const opId = opTxn(issue, "ship-confirm", newTxn);
      await github.createComment(owner, repo, issue, renderSys({ heading: "🔁 Head moved", body: `PR #${impl.prNumber} moved to ${live.headRefOid}. Please review and ship again.`, opId, payload: { headSha: live.headRefOid, prNumber: impl.prNumber } }));
      const next = clone(st);
      next.artifacts.impl.headSha = live.headRefOid;
      next.stage = "implementing"; next.gate = "feedback"; next.status = "waiting"; next.statusText = "The PR changed — review the new head before shipping."; next.pending = null; next.txn = newTxn; next.updatedAt = now();
      await commit(owner, repo, issue, cur.controlCommentId, next);
      await refresh();
      return { ok: true, state: next };
    }
    const cand = st.artifacts?.finalizedCandidate;
    if (cand && cand.headSha === reviewed && !String(data.notes || "").trim()) {
      const newTxn = Number(st.txn || 0) + 1;
      const inId = await postInputOnce(owner, repo, issue, cur.comments, opTxn(issue, "ship-confirm", newTxn), "✅ Finalized revision confirmed", "Confirmed finalized revision.");
      return verifyPr(owner, repo, issue, cur.controlCommentId, { ...st, txn: newTxn, artifacts: { ...st.artifacts, finalized: { commentId: cand.commentId }, inputs: { ...(st.artifacts.inputs || {}), shipConfirm: inId } } }, {
        prNumber: impl.prNumber, expectedHeadSha: cand.headSha, base: impl.base, finalizedCommentId: cand.commentId,
      });
    }
    const newTxn = Number(st.txn || 0) + 1;
    const opId = opTxn(issue, "finalizing", newTxn);
    const inId = await postInputOnce(owner, repo, issue, cur.comments, opId, "✅ Ship", data.notes || "Ship approved.");
    const pending = { opId, kind: "finalize", inputCommentIds: [st.artifacts?.plan?.commentId, inId].filter(Boolean), attempt: 1, reviewedHeadSha: reviewed };
    const next = { ...clone(st), stage: "finalizing", gate: null, status: "working", statusText: "Finalizing the PR…", pending, txn: newTxn, updatedAt: now() };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    return dispatch(owner, repo, issue, next, cur.controlCommentId);
  }

  async function submitStage(input) {
    const opId = String(input.opId || "");
    const binding = parseOpBinding(opId);
    if (!binding) throw new Error("invalid opId");
    const active = await deps.readActive?.();
    if (input.issue != null && Number(input.issue) !== binding.issue) throw new Error("submit_stage issue does not match opId");
    const owner = input.owner || active?.owner;
    const repo = input.repo || active?.repo;
    const issue = binding.issue;
    if (!owner || !repo || !issue) throw new Error("unable to resolve issue for submission");
    const issueKey = `${owner}/${repo}/${issue}`;
    // Hold the caller's turn open until any panel this submission scheduled has
    // finished. Returning first lets the turn end underneath the factory, which
    // stops it before it can spawn a single reviewer.
    return awaitingPanel(issueKey, () => enqueueIssue(issueKey, async () => {
      const cur = await read(owner, repo, issue);
      const st = cur.state;
      if (!st || !st.pending) return { ok: true, state: st };
      if (String(st.owner) !== String(owner) || String(st.repo) !== String(repo) || Number(st.issue) !== Number(issue)) {
        throw new Error("submission route does not match control block");
      }
      if (st.pending.opId !== opId) {
        if (github.findCommentByOpMarker?.(cur.comments, "AL-OUT", opId)) return { ok: true, state: st };
        throw new Error("wrong opId");
      }
      if (!checkToken(st.pending, input.submissionToken)) throw new Error("invalid submission token");
      const artifact = input.artifact || {};
      assertNoWorkflowFields(artifact);
      const existing = github.findCommentByOpMarker?.(cur.comments, "AL-OUT", opId);
      if (existing) return continueStage(owner, repo, issue, cur, existing.commentId, existing.payload, existing.body);
      return acceptArtifact(owner, repo, issue, cur, artifact);
    }));
  }

  function parseOpBinding(opId) {
    const m = String(opId).match(/^iss(\d+)\//);
    return m ? { issue: Number(m[1]) } : null;
  }

  async function acceptArtifact(owner, repo, issue, cur, artifact) {
    const st = cur.state;
    const pending = st.pending;
    const kind = pending.kind;
    if (kind === "research") {
      const body = String(artifact.body || "").trim();
      if (body.length < 10) throw new Error("research artifact body is required");
      const c = await github.createComment(owner, repo, issue, renderOut({ heading: "🔎 Research", body, opId: pending.opId, payload: { kind: "research" } }));
      return continueStage(owner, repo, issue, cur, c.id, { kind: "research" }, body);
    }
    if (kind === "prototype") {
      const opts = Array.isArray(artifact.options) ? artifact.options : [];
      if (!opts.length) throw new Error("prototype options are required");
      const options = [];
      const seenIds = new Set();
      const round = pending.round || st.round || 1;
      for (const raw of opts) {
        const id = String(raw.id || "").replace(/[^A-Za-z0-9_-]/g, "");
        const path = String(raw.path || "");
        if (!id || !path) throw new Error("prototype option id/path required");
        if (seenIds.has(id)) throw new Error("prototype option ids must be unique");
        seenIds.add(id);
        const expectedPath = `${owner}/${repo}/${issue}/round-${round}/${id}/index.html`;
        if (path !== expectedPath) throw new Error(`prototype path must be ${expectedPath}`);
        options.push({ id, title: String(raw.title || id), pitch: String(raw.pitch || ""), path, repoPath: path, sha: await safeHashFile(workRoot, owner, repo, issue, path) });
      }
      const lines = options.map((o) => `- **Variant ${o.id} — ${o.title}:** ${o.pitch} [Local preview](${assetBase}/work/${o.path}) · Repo path: \`${o.path}\``).join("\n");
      const payload = { round, options };
      const c = await github.createComment(owner, repo, issue, renderOut({ heading: `🧪 Prototypes — round ${round}`, body: lines, opId: pending.opId, payload }));
      return continueStage(owner, repo, issue, cur, c.id, payload, lines);
    }
    if (kind === "plan-questions") {
      const body = artifact.body ? String(artifact.body) : renderQuestions(artifact.questions);
      if (!parseQuestionnaire(body).length) throw new Error("questionnaire artifact must contain parsable questions");
      const c = await github.createComment(owner, repo, issue, renderOut({ heading: "📋 Questionnaire", body, opId: pending.opId, payload: { kind: "questionnaire" } }));
      return continueStage(owner, repo, issue, cur, c.id, { kind: "questionnaire" }, body);
    }
    if (kind === "plan") {
      const body = String(artifact.body || "").trim();
      if (body.length < 10) throw new Error("plan artifact body is required");
      // The stage agent drafts; the panel reviews. Clauses are optional on the
      // wire — a plain markdown body is split into one clause per section so an
      // older stage agent keeps working.
      const clauses = normalizeClauses(
        Array.isArray(artifact.clauses) && artifact.clauses.length ? artifact.clauses : clausesFromMarkdown(body),
      );
      const payload = { kind: "draft-plan", rev: 1 };
      const c = await github.createComment(owner, repo, issue, renderOut({
        heading: "📝 Draft plan", body: renderClauses(clauses), opId: pending.opId, payload,
      }));
      return continueStage(owner, repo, issue, cur, c.id, payload, renderClauses(clauses));
    }
    if (kind === "implement") {
      const live = await validateImplementationPr(owner, repo, issue, st, artifact);
      const preview = sanitizePreview(artifact.preview);
      if (preview.kind === "web") {
        const demoPath = `${owner}/${repo}/${issue}/impl-round-${pending.round || st.implRound || 1}/demo/index.html`;
        await safeHashFile(workRoot, owner, repo, issue, demoPath);
        preview.path = demoPath;
        preview.headSha = live.headSha;
      }
      const payload = { prNumber: live.prNumber, branch: live.branch, base: live.base, headSha: live.headSha, round: pending.round || st.implRound || 1, preview };
      const body = `${String(artifact.summary || "Build is ready.").trim()}\n\nPR: [#${live.prNumber}](${live.prUrl})\n\nBranch: \`${live.branch}\``;
      const c = await github.createComment(owner, repo, issue, renderOut({ heading: "🚀 Build ready", body, opId: pending.opId, payload }));
      return continueStage(owner, repo, issue, cur, c.id, payload, body);
    }
    if (kind === "finalize") {
      const live = await validateFinalizePr(owner, repo, issue, st);
      const movedHead = live.headSha !== st.pending.reviewedHeadSha;
      const payload = { prNumber: live.prNumber, headSha: live.headSha, movedHead };
      const body = String(artifact.body || "Finalized the PR.").trim();
      const c = await github.createComment(owner, repo, issue, renderOut({ heading: "✅ Finalized", body, opId: pending.opId, payload }));
      return continueStage(owner, repo, issue, cur, c.id, payload, body);
    }
    throw new Error(`unsupported pending kind ${kind}`);
  }

  // ---- the two-model plan panel -------------------------------------------

  const panelJobs = new Set();
  const panelJobsByIssue = new Map();
  // Lets callers and tests await the out-of-band panel run without polling.
  // With a key, waits only on that issue so an unrelated panel cannot block it.
  async function panelSettled(key) {
    const pick = () => (key ? panelJobsByIssue.get(key) : panelJobs) || new Set();
    while (pick().size) await Promise.all([...pick()]);
  }

  // The queued section returns as soon as the panel is *scheduled*. Awaiting it
  // here -- outside the queue, so the panel's own writes can still acquire it --
  // keeps the caller's turn alive for as long as the reviewers need.
  //
  // Only jobs this call started are awaited. Waiting on any in-flight panel
  // would make an unrelated click hang for the length of a review, and would
  // deadlock outright for a call made from inside a running panel.
  async function awaitingPanel(key, work) {
    const before = new Set(panelJobsByIssue.get(key) || []);
    const out = await work();
    const current = panelJobsByIssue.get(key);
    if (!current) return out;
    const mine = [...current].filter((job) => !before.has(job));
    if (mine.length) await Promise.all(mine);
    return out;
  }

  function bodyOf(comments, id) {
    if (!id) return "";
    const c = (comments || []).find((x) => String(x.id ?? x.commentId) === String(id));
    return c ? String(c.body || "") : "";
  }

  // The reviewer is a constant, not a setting. It was configurable through a
  // `panel-config` intent that nothing could reach — no webview control and no
  // canvas action ever emitted it — so the option existed only as a way to put
  // the review into an invalid state by hand-editing the control block.
  function panelReviewer() {
    return { id: String(REVIEWER.id), model: String(REVIEWER.model) };
  }

  // Runs outside the issue queue on purpose: the panel writes back through the
  // same queue, so awaiting it from inside a queued section would deadlock.
  // Failures are surfaced onto the issue rather than thrown into a caller that
  // has already returned.
  //
  // Scheduling is only half the contract. Factory subagents can only be spawned
  // while the calling turn is still alive -- a run that begins after the turn
  // ends is stopped before it spawns anything, and every agent call comes back
  // null, which the panel can only report as "reviewer returned no review". So
  // the public entry points await the job below via panelSettled(key) once
  // their queued section has finished.
  function schedulePanel(owner, repo, issue, opId) {
    const key = `${owner}/${repo}/${issue}`;
    let resolveJob;
    const job = new Promise((r) => { resolveJob = r; });
    panelJobs.add(job);
    if (!panelJobsByIssue.has(key)) panelJobsByIssue.set(key, new Set());
    panelJobsByIssue.get(key).add(job);
    const forget = () => {
      panelJobs.delete(job);
      const forIssue = panelJobsByIssue.get(key);
      if (forIssue) { forIssue.delete(job); if (!forIssue.size) panelJobsByIssue.delete(key); }
    };
    const run = () => runPanelJob(owner, repo, issue, opId)
      .catch(async (err) => { try { await panelFailed(owner, repo, issue, opId, err); } catch {} })
      .finally(() => { forget(); resolveJob(); });
    if (deps.schedule) deps.schedule(run); else setTimeout(run, 0);
    return job;
  }

  async function runPanelJob(owner, repo, issue, opId) {
    const cur = await read(owner, repo, issue);
    const st = cur.state;
    const pending = st?.pending;
    // Another worker may have finished this exact run already.
    if (!pending || pending.kind !== "plan-panel" || pending.opId !== opId || pending.phase !== "panel") return { ok: true, state: st };

    const clauses = parseClauses(bodyOf(cur.comments, pending.draftCommentId));
    const stored = st.panel?.reviews || [];
    const mode = pending.mode === "synthesis-only" ? "synthesis-only" : "full";
    const key = `${owner}/${repo}/${issue}`;
    const reviewer = panelReviewer();

    // q9: on by default, no flag, and a silent fallback when the host cannot run
    // subagents. "Silent" means it does not interrupt — it is still recorded.
    if (typeof deps.runPanel !== "function") {
      return finishPanel(owner, repo, issue, opId, {
        clauses, reviews: stored, quotes: {}, disagreements: [], models: [],
        skipped: { reason: "factories-unavailable" },
      });
    }

    // Live step status. Ephemeral by design: it is pushed into the canvas
    // server's in-memory state, never onto the issue. A GitHub write per step
    // would cost a round trip each time and burn rate limit to publish
    // information that is worthless the moment the run ends.
    const sequence = {
      opId, mode, rev: Number(pending.rev || 1), startedAt: now(),
      steps: {
        draft: { state: "done", detail: `${clauses.length} clause${clauses.length === 1 ? "" : "s"} drafted` },
        review: mode === "synthesis-only"
          ? { state: "reused", model: reviewer.model, detail: "Reusing the review from the previous revision." }
          : { state: "waiting", model: reviewer.model },
        synthesis: { state: "waiting", model: SYNTHESIS_MODEL },
      },
    };
    const publish = () => { try { deps.publishSequence?.(key, sequence); } catch {} };
    const onProgress = (ev) => {
      const stepName = ev && ev.step;
      const slot = stepName && sequence.steps[stepName];
      if (!slot) return;
      if (ev.state === "running" && !slot.startedAt) slot.startedAt = now();
      if (ev.state === "done" || ev.state === "failed") slot.endedAt = now();
      slot.state = ev.state || slot.state;
      if (ev.model) slot.model = ev.model;
      if (ev.detail) slot.detail = ev.detail;
      if (ev.code) slot.code = ev.code;
      publish();
    };
    publish();

    try {
      const result = await deps.runPanel({
        owner, repo, issue, opId, mode, rev: Number(pending.rev || 1),
        reviewer,
        reviews: stored,
        clauses,
        decisions: pending.decisions || [],
        request: String(cur.iss?.body || ""),
        research: bodyOf(cur.comments, st.artifacts?.research?.commentId),
        answers: bodyOf(cur.comments, st.artifacts?.answers?.commentId),
        feedback: pending.feedback || "",
        baseBranch: st.baseBranch || "main",
        branch: branchFor(issue),
      }, onProgress);
      return await finishPanel(owner, repo, issue, opId, result);
    } finally {
      // The durable outcome is on the issue by now; the live tracker would only
      // go stale.
      try { deps.publishSequence?.(key, null); } catch {}
    }
  }

  function renderEvidence(result, reviewer) {
    const lines = [];
    const models = (result.models || (reviewer ? [reviewer] : [])).map((m) => `\`${m.model}\`${m.family ? ` (${m.family})` : ""}`);
    lines.push(`Reviewed by ${models.join(" and ") || "the reviewer"}, in a fresh context with no prior conversation history.`);
    if (result.synthesisModel) lines.push(`Synthesized by \`${result.synthesisModel}\`, also in a fresh context.`);
    if (result.skipped) lines.push(`\n> Review skipped — ${result.skipped.reason}. The draft plan is shown unreviewed.`);
    for (const review of result.reviews || []) {
      lines.push(`\n### ${review.reviewerId} — ${review.verdict}`);
      if (review.strengths?.length) lines.push(`**Strengths**\n${review.strengths.map((s) => `- ${s}`).join("\n")}`);
      if (review.risks?.length) {
        lines.push(`**Risks**\n${review.risks.map((r) => `- \`${r.severity}\`${r.clauseId ? ` [${r.clauseId}]` : ""} ${r.evidence} → ${r.recommendation}`).join("\n")}`);
      }
      if (review.omissions?.length) lines.push(`**Omissions**\n${review.omissions.map((s) => `- ${s}`).join("\n")}`);
    }
    if (result.disagreements?.length) {
      lines.push(`\n### Findings the synthesis rejected`);
      lines.push(result.disagreements.map((d) => `- **${d.topic}** — ${d.positions || "position"} → _${d.resolution}_`).join("\n"));
    }
    return lines.join("\n");
  }

  async function finishPanel(owner, repo, issue, opId, result) {
    return enqueueIssue(`${owner}/${repo}/${issue}`, async () => {
      const cur = await read(owner, repo, issue);
      const st = cur.state;
      const pending = st?.pending;
      if (!pending || pending.kind !== "plan-panel" || pending.opId !== opId) return { ok: true, state: st };

      const prev = parseClauses(bodyOf(cur.comments, pending.draftCommentId));
      const index = st.artifacts?.plan?.clauses || indexClauses(prev);
      const usedIds = Array.from(new Set([
        ...(st.panel?.usedIds || []),
        ...prev.map((c) => c.id),
      ]));
      // Pinned clauses are re-inserted verbatim here; a hash mismatch fails the
      // whole splice rather than quietly shipping edited text as "pinned".
      const finalClauses = spliceSynthesis({
        prev, next: result.clauses, decisions: pending.decisions || [], index, usedIds,
      });

      const rev = Number(pending.rev || 1);
      const evidenceBody = renderEvidence(result, panelReviewer());
      const evId = (await github.createComment(owner, repo, issue, renderSys({
        heading: `🧑‍⚖️ Review evidence — rev ${rev}`, body: evidenceBody,
        opId: `${opId}/evidence/${rev}`, payload: { rev, skipped: !!result.skipped },
      }))).id;

      const planBody = renderClauses(finalClauses);
      const planId = (await github.createComment(owner, repo, issue, renderOut({
        heading: "🗺 Plan", body: planBody,
        opId: `${opId}/plan/${rev}`, payload: { kind: "plan", rev },
      }))).id;

      const next = {
        ...clone(st),
        stage: "planning",
        gate: "plan-review",
        status: "waiting",
        statusText: "Waiting for your plan approval.",
        pending: null,
        txn: Number(st.txn || 0) + 1,
        updatedAt: now(),
      };
      next.artifacts = {
        ...(next.artifacts || {}),
        plan: { ...(next.artifacts?.plan || {}), commentId: planId, approved: null, rev, clauses: indexClauses(finalClauses) },
      };
      // Only pointers and a compact index live in the control block; the reviews
      // themselves stay in the evidence comment.
      next.panel = {
        ...(st.panel || {}),
        rev,
        evidenceCommentId: evId,
        models: result.models || [],
        synthesisModel: result.synthesisModel || null,
        failed: null,
        failedCode: null,
        skipped: result.skipped || null,
        disagreements: (result.disagreements || []).length,
        quotes: result.quotes || {},
        reviews: result.reviews || [],
        usedIds: Array.from(new Set([...usedIds, ...finalClauses.map((c) => c.id)])),
      };
      // Reviews are the largest field and the only one safe to shed: they remain
      // fully readable in the evidence comment.
      try { assertControlSize(next); }
      catch { next.panel.reviews = []; next.panel.quotes = {}; next.panel.reviewsCommentId = evId; }

      await commit(owner, repo, issue, cur.controlCommentId, next);
      await refresh();
      return { ok: true, state: next };
    });
  }

  async function panelFailed(owner, repo, issue, opId, err) {
    return enqueueIssue(`${owner}/${repo}/${issue}`, async () => {
      const cur = await read(owner, repo, issue);
      const st = cur.state;
      if (!st?.pending || st.pending.kind !== "plan-panel" || st.pending.opId !== opId) return { ok: true, state: st };
      const why = err && err.message ? err.message : String(err);
      // Attribution matters more than the message. "review-not-started" means the
      // host refused to admit the subagent — retrying is worth a try. Anything
      // else means the reviewer ran and produced something unusable, where a
      // retry mostly buys another 19 credits of the same answer.
      const code = err && err.code === "review-not-started" ? "review-not-started" : "review-failed";
      const cause = code === "review-not-started"
        ? "The reviewer was never started — the host did not admit a subagent for it."
        : `The review could not complete: ${why}`;
      await github.createComment(owner, repo, issue, renderSys({
        heading: "⚠️ Plan review failed", body: `${cause}\n\nDetail: \`${why}\`\n\nThe draft plan is shown unreviewed so you can still steer it.`,
        opId: `${opId}/panel-failed`, payload: { error: why, code },
      }));
      // Failing closed here would strand the run with no plan to act on, so the
      // unreviewed draft is promoted and the failure is stated plainly.
      const draft = parseClauses(bodyOf(cur.comments, st.pending.draftCommentId));
      const next = {
        ...clone(st), stage: "planning", gate: "plan-review", status: "waiting",
        statusText: "Waiting for your approval — the plan was not reviewed.",
        pending: null, txn: Number(st.txn || 0) + 1, updatedAt: now(),
      };
      next.artifacts = { ...(next.artifacts || {}), plan: { ...(next.artifacts?.plan || {}), commentId: st.pending.draftCommentId, approved: null, clauses: indexClauses(draft) } };
      next.panel = { ...(st.panel || {}), failed: why, failedCode: code, rev: Number(st.pending.rev || 1) };
      await commit(owner, repo, issue, cur.controlCommentId, next);
      await refresh();
      return { ok: true, state: next };
    });
  }

  // The gate's per-clause controls. Pin/drop/send-back are applied by re-running
  // synthesis only, reusing the stored reviews (q4).
  async function planSteer(owner, repo, issue, cur, data, intent) {
    validateIntent(cur, intent, "plan-review");
    const st = cur.state;
    const known = new Set((Array.isArray(st.artifacts?.plan?.clauses) ? st.artifacts.plan.clauses : []).map((c) => c.id));
    const decisions = (Array.isArray(data.decisions) ? data.decisions : []).map((d) => {
      const clauseId = String(d.clauseId || "");
      const action = String(d.action || "");
      if (!CLAUSE_ID_RE.test(clauseId) || !known.has(clauseId)) throw new Error(`unknown clause ${clauseId}`);
      if (!["pin", "send-back", "drop", "keep"].includes(action)) throw new Error(`unknown clause action ${action}`);
      return { clauseId, action, instruction: String(d.instruction || "").slice(0, 2000) };
    });
    if (!decisions.some((d) => d.action === "send-back" || d.action === "drop")) {
      throw new Error("nothing to re-run: send back or drop at least one clause");
    }
    const newTxn = Number(st.txn || 0) + 1;
    const opId = opTxn(issue, "plan-steer", newTxn);
    const summary = decisions.filter((d) => d.action !== "keep")
      .map((d) => `- \`${d.clauseId}\` **${d.action}**${d.instruction ? ` — ${d.instruction}` : ""}`).join("\n");
    const inId = await postInputOnce(owner, repo, issue, cur.comments, opId, "🎯 Steer plan", summary);
    const rev = Number(st.panel?.rev || 1) + 1;
    const pending = {
      opId, kind: "plan-panel", phase: "panel", mode: "synthesis-only", rev,
      draftCommentId: st.artifacts?.plan?.commentId || st.artifacts?.plan?.draftCommentId,
      decisions, inputCommentIds: [inId], attempt: 1,
    };
    const next = {
      ...clone(st), stage: "planning", gate: null, status: "working",
      statusText: `Re-synthesizing with your instructions (review from rev ${st.panel?.rev || 1})…`,
      pending, txn: newTxn, updatedAt: now(),
    };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    await refresh();
    schedulePanel(owner, repo, issue, opId);
    return { ok: true, state: next };
  }

  // Retry the review against the EXISTING draft. A failed review used to leave
  // "Request changes" as the only way forward, which redrafts the plan and pays
  // for a draft the human never objected to. This re-runs step 2 only.
  async function planRetryReview(owner, repo, issue, cur, data, intent) {
    validateIntent(cur, intent, "plan-review");
    const st = cur.state;
    const draftCommentId = st.artifacts?.plan?.commentId || st.artifacts?.plan?.draftCommentId;
    if (!draftCommentId) throw new Error("no draft plan to review");
    const newTxn = Number(st.txn || 0) + 1;
    const opId = opTxn(issue, "plan-retry-review", newTxn);
    const rev = Number(st.panel?.rev || 1) + 1;
    const pending = {
      opId, kind: "plan-panel", phase: "panel", mode: "full", rev,
      draftCommentId, decisions: [], inputCommentIds: [], attempt: 1,
    };
    const next = {
      ...clone(st), stage: "planning", gate: null, status: "working",
      statusText: `Reviewing the plan with ${REVIEWER.model}…`,
      // The previous reviews are dropped: they are the ones that failed.
      panel: { ...(st.panel || {}), failed: null, failedCode: null, reviews: [] },
      pending, txn: newTxn, updatedAt: now(),
    };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    await refresh();
    schedulePanel(owner, repo, issue, opId);
    return { ok: true, state: next };
  }

  function renderQuestions(questions) {
    const qs = Array.isArray(questions) ? questions : [];
    return qs.map((q, i) => {
      const id = q.id || `q${i + 1}`;
      const tag = q.select === "multi" ? "(multi) " : q.select === "single" ? "(single) " : "";
      const opts = Array.isArray(q.choices) && q.choices.length ? "\n" + q.choices.map((c) => `- ${c}`).join("\n") : "";
      return `**${id}.** ${tag}${q.prompt || q.text || ""}${opts}`;
    }).join("\n\n");
  }

  async function continueStage(owner, repo, issue, cur, commentId, payload, body) {
    const st = cur.state;
    const pending = st.pending;
    if (!pending) return { ok: true, state: st };
    if (pending.kind === "research") {
      const nextPending = { opId: opRound(issue, "prototype", 1), kind: "prototype", inputCommentIds: [commentId], round: 1, attempt: 1 };
      const next = { ...clone(st), artifacts: { ...(st.artifacts || {}), research: { commentId } }, stage: "prototype", gate: null, status: "working", statusText: "Building prototype options…", pending: nextPending, txn: Number(st.txn || 0) + 1, updatedAt: now() };
      await commit(owner, repo, issue, cur.controlCommentId, next);
      return dispatch(owner, repo, issue, next, cur.controlCommentId);
    }
    if (pending.kind === "prototype") {
      const rounds = [...(st.artifacts?.prototypeRounds || []).filter((r) => Number(r.round) !== Number(payload.round)), { round: payload.round, commentId, options: payload.options || [] }];
      const next = { ...clone(st), artifacts: { ...(st.artifacts || {}), prototypeRounds: rounds }, stage: "prototype", gate: "signoff", round: payload.round || st.round, status: "waiting", statusText: "Waiting for your sign-off.", pending: null, txn: Number(st.txn || 0) + 1, updatedAt: now() };
      await commit(owner, repo, issue, cur.controlCommentId, next);
      await refresh();
      return { ok: true, state: next };
    }
    if (pending.kind === "plan-questions") {
      const next = { ...clone(st), artifacts: { ...(st.artifacts || {}), questionnaire: { commentId } }, stage: "planning", gate: "questionnaire", status: "waiting", statusText: "Waiting for your answers.", pending: null, txn: Number(st.txn || 0) + 1, updatedAt: now() };
      await commit(owner, repo, issue, cur.controlCommentId, next); await refresh(); return { ok: true, state: next };
    }
    if (pending.kind === "plan") {
      // The draft is committed and the queue is released BEFORE the panel runs.
      // Two model calls take minutes; holding the issue lock that long would
      // stall every other transition on this issue.
      const rev = Number(payload?.rev || 1);
      const next = {
        ...clone(st),
        artifacts: {
          ...(st.artifacts || {}),
          plan: { ...(st.artifacts?.plan || {}), draftCommentId: commentId, approved: null, clauses: indexClauses(parseClauses(String(body || ""))) },
        },
        stage: "planning",
        gate: null,
        status: "working",
        statusText: `Reviewing the plan with ${REVIEWER.model}…`,
        pending: { opId: pending.opId, kind: "plan-panel", phase: "panel", mode: "full", rev, draftCommentId: commentId, attempt: 1 },
        txn: Number(st.txn || 0) + 1,
        updatedAt: now(),
      };
      await commit(owner, repo, issue, cur.controlCommentId, next);
      await refresh();
      schedulePanel(owner, repo, issue, pending.opId);
      return { ok: true, state: next };
    }
    if (pending.kind === "implement") {
      const impl = { commentId, prNumber: payload.prNumber, prUrl: prUrl(owner, repo, payload.prNumber), branch: payload.branch, base: payload.base, headSha: payload.headSha, round: payload.round, preview: payload.preview };
      const next = { ...clone(st), artifacts: { ...(st.artifacts || {}), impl }, stage: "implementing", gate: "feedback", implRound: payload.round || st.implRound || 1, status: "waiting", statusText: "Waiting for your review of the PR.", pending: null, txn: Number(st.txn || 0) + 1, updatedAt: now() };
      await commit(owner, repo, issue, cur.controlCommentId, next); await refresh(); return { ok: true, state: next };
    }
    if (pending.kind === "finalize") {
      const impl = st.artifacts?.impl || {};
      const nextBase = clone(st);
      nextBase.artifacts = { ...(nextBase.artifacts || {}), finalized: { commentId } };
      if (payload.movedHead) {
        const newTxn = Number(st.txn || 0) + 1;
        nextBase.artifacts.impl = { ...impl, headSha: payload.headSha };
        nextBase.artifacts.finalizedCandidate = { headSha: payload.headSha, commentId };
        await github.createComment(owner, repo, issue, renderSys({ heading: "🔁 Finalize moved the head", body: `Finalize moved PR #${payload.prNumber} to ${payload.headSha}; please review and ship again.`, opId: opTxn(issue, "ship-confirm", newTxn), payload: { headSha: payload.headSha, prNumber: payload.prNumber } }));
        Object.assign(nextBase, { stage: "implementing", gate: "feedback", status: "waiting", statusText: "Finalize changed the PR — review the new head before shipping.", pending: null, txn: newTxn, updatedAt: now() });
        await commit(owner, repo, issue, cur.controlCommentId, nextBase); await refresh(); return { ok: true, state: nextBase };
      }
      return verifyPr(owner, repo, issue, cur.controlCommentId, nextBase, {
        prNumber: payload.prNumber, expectedHeadSha: payload.headSha, base: impl.base, finalizedCommentId: commentId,
      });
    }
    return { ok: true, state: st };
  }

  async function validateImplementationPr(owner, repo, issue, st, artifact) {
    const branch = branchFor(issue);
    const pull = artifact.prNumber
      ? await github.getPullValidation(owner, repo, artifact.prNumber)
      : await github.findPullForBranch(owner, repo, branch);
    if (!pull) throw new Error(`No PR found for ${branch}`);
    if (String(pull.state).toUpperCase() !== "OPEN") throw new Error("implementation PR is not open");
    if (pull.headRefName !== branch) throw new Error("implementation PR uses the wrong branch");
    if (pull.baseRefName !== (st.baseBranch || "main")) throw new Error(`implementation PR must target base ${(st.baseBranch || "main")}`);
    if (st.artifacts?.impl?.prNumber && Number(st.artifacts.impl.prNumber) !== Number(pull.number)) throw new Error("implementation returned a different PR");
    return { prNumber: pull.number, prUrl: pull.url || prUrl(owner, repo, pull.number), branch: pull.headRefName, base: pull.baseRefName || artifact.base || "main", headSha: pull.headRefOid };
  }

  async function validateFinalizePr(owner, repo, issue, st) {
    const impl = st.artifacts?.impl || {};
    const pull = await github.getPullValidation(owner, repo, impl.prNumber);
    if (String(pull.state).toUpperCase() !== "OPEN") throw new Error("PR is not open");
    if (pull.isDraft) throw new Error("PR is still draft after finalize");
    if (pull.headRefName !== branchFor(issue)) throw new Error("PR head branch changed");
    if (pull.baseRefName !== (st.baseBranch || impl.base || "main")) throw new Error("PR base branch changed");
    return { prNumber: pull.number || impl.prNumber, headSha: pull.headRefOid, base: pull.baseRefName || impl.base };
  }

  async function verifyPr(owner, repo, issue, controlCommentId, st, target) {
    const pull = await github.getPullValidation(owner, repo, target.prNumber);
    const branch = branchFor(issue);
    const makeVerifyPending = (status, statusText, txn) => ({
      ...clone(st), stage: "finalizing", gate: null, status, statusText,
      pending: { opId: opTxn(issue, "verify", txn), kind: "verify-pr", prNumber: target.prNumber, expectedHeadSha: target.expectedHeadSha, base: target.base, finalizedCommentId: target.finalizedCommentId, inputCommentIds: [], attempt: (st.pending?.kind === "verify-pr" ? Number(st.pending.attempt || 1) + 1 : 1) },
      txn, updatedAt: now(),
    });
    const structural = [];
    if (String(pull.state).toUpperCase() !== "OPEN") structural.push("reopen the PR");
    if (pull.isDraft) structural.push("mark the PR ready for review");
    if (pull.headRefName !== branch) structural.push(`restore head branch ${branch}`);
    if (pull.baseRefName !== target.base) structural.push(`retarget base ${target.base}`);
    if (structural.length) {
      const txn = Number(st.txn || 0) + 1;
      const next = makeVerifyPending("error", `PR repair required: ${structural.join(", ")}.`, txn);
      await commit(owner, repo, issue, controlCommentId, next); await refresh(); return { ok: true, state: next };
    }
    if (pull.headRefOid !== target.expectedHeadSha) {
      const txn = Number(st.txn || 0) + 1;
      await github.createComment(owner, repo, issue, renderSys({ heading: "⚠️ Head moved since sign-off", body: `PR #${target.prNumber} moved to ${pull.headRefOid}. Please review and ship again.`, opId: opTxn(issue, "ship-confirm", txn), payload: { headSha: pull.headRefOid, prNumber: target.prNumber } }));
      const next = clone(st);
      next.artifacts.impl = { ...(next.artifacts.impl || {}), headSha: pull.headRefOid };
      Object.assign(next, { stage: "implementing", gate: "feedback", status: "waiting", statusText: "The PR changed — review the new head before shipping.", pending: null, txn, updatedAt: now() });
      await commit(owner, repo, issue, controlCommentId, next); await refresh(); return { ok: true, state: next };
    }
    const merge = String(pull.mergeStateStatus || "").toUpperCase();
    if (merge === "DIRTY" || merge === "BEHIND") {
      const txn = Number(st.txn || 0) + 1;
      await github.createComment(owner, repo, issue, renderSys({ heading: "⚠️ Branch needs update", body: `PR #${target.prNumber} is ${merge}; request a revision to update the branch.`, opId: opTxn(issue, "checks", txn), payload: { mergeStateStatus: merge } }));
      const next = { ...clone(st), stage: "implementing", gate: "feedback", status: "waiting", statusText: "The branch needs an update before it can ship.", pending: null, txn, updatedAt: now() };
      await commit(owner, repo, issue, controlCommentId, next); await refresh(); return { ok: true, state: next };
    }
    const protection = await github.getRequiredCheckContexts(owner, repo, target.base);
    if (protection.state === "unknown" && st.pending?.kind === "verify-pr" && Number(st.pending.attempt || 1) >= MAX_VERIFY_RECHECK) {
      const txn = Number(st.txn || 0) + 1;
      const next = makeVerifyPending("error", "Unable to determine required PR checks after repeated rechecks.", txn);
      await commit(owner, repo, issue, controlCommentId, next); await refresh(); return { ok: true, state: next };
    }
    const checks = (pull.statusCheckRollup || []).map(parseCheckPhase);
    const required = protection.state === "present" && protection.contexts.length ? new Set(protection.contexts) : null;
    const gating = required ? checks.filter((c) => required.has(c.name)) : checks;
    const missing = required ? [...required].filter((name) => !gating.some((c) => c.name === name)) : [];
    const anyFail = gating.some((c) => c.phase === "failed");
    const anyPending = gating.some((c) => c.phase === "pending") || missing.length > 0;
    if (anyFail) {
      const txn = Number(st.txn || 0) + 1;
      const failed = gating.filter((c) => c.phase === "failed").map((c) => c.name).join(", ");
      await github.createComment(owner, repo, issue, renderSys({ heading: "⚠️ Checks failed", body: `Required checks failed: ${failed || "unknown"}.`, opId: opTxn(issue, "checks", txn), payload: { failed } }));
      const next = { ...clone(st), stage: "implementing", gate: "feedback", status: "waiting", statusText: "Checks failed — request changes to fix the PR.", pending: null, txn, updatedAt: now() };
      await commit(owner, repo, issue, controlCommentId, next); await refresh(); return { ok: true, state: next };
    }
    const noChecksReady = protection.state === "absent" && checks.length === 0 && ["CLEAN", "HAS_HOOKS"].includes(merge);
    const mergeReady = ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(merge) && merge !== "BLOCKED";
    if (noChecksReady || (mergeReady && protection.state !== "unknown" && !anyPending)) {
      const next = { ...clone(st), artifacts: { ...(st.artifacts || {}), finalized: { commentId: target.finalizedCommentId } }, stage: "done", gate: null, status: "done", statusText: `Done — PR #${target.prNumber} is ready to merge.`, pending: null, txn: Number(st.txn || 0) + 1, updatedAt: now() };
      await commit(owner, repo, issue, controlCommentId, next); await refresh(); return { ok: true, state: next };
    }
    const txn = Number(st.txn || 0) + 1;
    const next = makeVerifyPending("working", "Waiting for PR checks…", txn);
    await commit(owner, repo, issue, controlCommentId, next); await refresh(); return { ok: true, state: next };
  }

  async function recover(owner, repo, issue, cur) {
    const st = cur.state;
    if (!st || !st.pending) { await refresh(); return { ok: true, state: st }; }
    if (st.pending.kind === "verify-pr") {
      return verifyPr(owner, repo, issue, cur.controlCommentId, st, {
        prNumber: st.pending.prNumber, expectedHeadSha: st.pending.expectedHeadSha, base: st.pending.base, finalizedCommentId: st.pending.finalizedCommentId,
      });
    }
    const out = github.findCommentByOpMarker?.(cur.comments, "AL-OUT", st.pending.opId);
    if (out) return continueStage(owner, repo, issue, cur, out.commentId, out.payload || {});
    if (st.status !== "error" && Number(st.pending.attempt || 1) >= MAX_ATTEMPT) {
      const next = { ...clone(st), status: "error", statusText: `Stage ${st.pending.kind} exhausted retry attempts.`, updatedAt: now() };
      await commit(owner, repo, issue, cur.controlCommentId, next, st.txn);
      await refresh();
      return { ok: true, state: next };
    }
    const next = { ...clone(st), pending: { ...clone(st.pending), attempt: st.status === "error" ? 1 : Number(st.pending.attempt || 1) + 1 }, status: "working", statusText: st.statusText || "Resuming…", updatedAt: now() };
    await commit(owner, repo, issue, cur.controlCommentId, next);
    return dispatch(owner, repo, issue, next, cur.controlCommentId);
  }

  function buildWorkOrder({ owner, repo, issue, state, pending, submissionToken }) {
    const branch = branchFor(issue);
    const base = state.baseBranch || "main";
    const inputCommands = (pending.inputCommentIds || []).map((id, i) =>
      `${i + 4}. Read input comment ${id}: gh api repos/${owner}/${repo}/issues/comments/${id} --jq .body`);
    const common = [
      "AGENT LOOP STAGE WORK ORDER",
      `1. Use existing canvas instance ${instanceId}; never open another canvas.`,
      `2. Target exactly ${owner}/${repo} issue #${issue}; opId ${pending.opId}; kind ${pending.kind}; round ${pending.round ?? state.round ?? state.implRound ?? 1}.`,
      `3. Read the issue body: gh api repos/${owner}/${repo}/issues/${issue} --jq .body`,
      ...inputCommands,
      `${4 + inputCommands.length}. Inspect the repository from the current workspace. Check existing files/tests relevant to this stage before producing the asset.`,
      `${5 + inputCommands.length}. Do not create/update Agent Loop issue comments, labels, control blocks, transitions, or workflow state.`,
      `${6 + inputCommands.length}. Deterministic branch: ${branch}; base branch: ${base}; PR title template: ${prTitle(issue, state.title)}; PR body must reference ${issueUrl(owner, repo, issue)} and opId ${pending.opId}.`,
      `${7 + inputCommands.length}. Produce only the requested asset. Do not choose next states.`,
      `${8 + inputCommands.length}. Final action: call submit_stage on canvas instance ${instanceId} with exactly this input (replace only artifact):`,
      JSON.stringify({ owner, repo, issue, opId: pending.opId, submissionToken, artifact: "<stage-specific artifact>" }, null, 2),
    ];
    const schema = stageSchema(owner, repo, issue, pending, branch, state);
    return `${common.join("\n")}\n\nSTAGE CONTRACT\n${schema}`;
  }

  function stageSchema(owner, repo, issue, pending, branch, state) {
    if (pending.kind === "research") return "Return artifact { body: markdown research brief }. Include prior art, tradeoffs, and recommended direction.";
    if (pending.kind === "prototype") {
      const base = `${owner}/${repo}/${issue}/round-${pending.round || 1}`;
      return `Write 2-3 self-contained HTML prototypes. IDs must be unique. Exact paths are ${base}/<id>/index.html under ${join(workRoot, normalizeRel(base))}. Return artifact { options:[{id,title,pitch,path}] } where each path equals the code-derived path.`;
    }
    if (pending.kind === "plan-questions") return "Return artifact { body } containing ## 📋 Questionnaire with **qN.** questions and optional single/multi choices.";
    if (pending.kind === "plan") return "Return artifact { body: markdown implementation plan }. Do not mutate workflow state.";
    if (pending.kind === "implement") return `Use deterministic branch ${branch} targeting base ${(state.baseBranch || "main")}. Create/update one open PR with title "${prTitle(issue, state.title)}". For web previews, write the demo to the exact code-stamped path ${owner}/${repo}/${issue}/impl-round-${pending.round || 1}/demo/index.html; do not choose another path. Return artifact { summary, preview:{kind:'web'|'command'|'none', run?, notes?} }.`;
    if (pending.kind === "finalize") return `Finalize the existing PR on branch ${branch}; mark it ready if draft. Return artifact { body: markdown finalization summary }.`;
    return "Return the requested asset only.";
  }

  return { kickoff, handleIntent, submitStage, resume: (x) => handleIntent({ ...x, kind: "resume" }), buildWorkOrder, panelSettled };
}
