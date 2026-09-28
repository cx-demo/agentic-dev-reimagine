// HTTP backend for the Flow Loop canvas, factored out of extension.mjs so it
// can be exercised by a standalone test harness (which injects a stub session).

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, normalize, extname, sep } from "node:path";
import { homedir } from "node:os";
import { renderHtml } from "./webview.mjs";
import * as GitHub from "./github.mjs";
import { getIssue, listComments, getComment, getPull, getPullHead, getPullFiles, getRequiredCheckContexts, findControlBlock, findCommentByHeading, findPrototypeComments, findQuestionnaireComment, findBuildReadyComment } from "./github.mjs";
import { parseClauses, indexClauses } from "./clauses.mjs";
import { REVIEWER, SYNTHESIS_MODEL } from "./panel.mjs";
import { buildSnapshot, summarizeChecks } from "./pr.mjs";
import { createCoordinator } from "./workflow.mjs";
import { validateDefinition, BUILTIN_DEFAULT, LEGACY_DEFAULT, PHASED_DEFAULT, hashDefinition } from "./workflow-def.mjs";
import { decodeReview, decodePointReply } from "./review-points.mjs";
import { FIELD_TYPE_NAMES, RULE_NAMES, RULE_OPERANDS, GATE_WIDGETS, GATE_WIDGET_NAMES, CAPABILITY_NAMES, OUTCOME_KINDS, PRODUCERS } from "./workflow-primitives.mjs";
import { DATA_ROOT, ACTIVE_FILE, WORK_ROOT, PINS_DIR, migrateLegacyDataRoot } from "./paths.mjs";

// Re-exported so existing importers (and tests) keep resolving these from
// server.mjs; the definitions now live in paths.mjs to break the import cycle.
export { DATA_ROOT, ACTIVE_FILE, WORK_ROOT } from "./paths.mjs";

// Per-user theme preference (not per-session/per-panel): persisted under the
// extension's own artifacts directory so it survives instance/session churn,
// per the canvas state-model guidance.
const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const THEME_FILE = join(COPILOT_HOME, "extensions", "agent-loop", "artifacts", "theme-pref.json");

async function readThemePref() {
  try {
    const raw = await readFile(THEME_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && (parsed.mode === "dark" || parsed.mode === "light") ? parsed.mode : null;
  } catch {
    return null;
  }
}

async function writeThemePref(mode) {
  const dir = join(COPILOT_HOME, "extensions", "agent-loop", "artifacts");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(THEME_FILE, JSON.stringify({ mode }), "utf8");
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

let workflowStorePromise = null;
async function workflowStore() {
  if (!workflowStorePromise) {
    workflowStorePromise = import("./workflow-store.mjs").catch((e) => {
      workflowStorePromise = null;
      throw e;
    });
  }
  return workflowStorePromise;
}

function workflowPrimitives() {
  return {
    fieldTypeNames: FIELD_TYPE_NAMES,
    ruleNames: RULE_NAMES,
    ruleOperands: RULE_OPERANDS,
    gateWidgetNames: GATE_WIDGET_NAMES,
    gateWidgets: Object.fromEntries(GATE_WIDGET_NAMES.map((name) => {
      const w = GATE_WIDGETS[name] || {};
      return [name, { needs: w.needs || [], label: w.label || name }];
    })),
    capabilityNames: CAPABILITY_NAMES,
    producerNames: PRODUCERS,
    outcomeKinds: OUTCOME_KINDS,
  };
}

function pathId(path, prefix, suffix = "") {
  if (!path.startsWith(prefix)) return null;
  if (suffix && !path.endsWith(suffix)) return null;
  const raw = path.slice(prefix.length, suffix ? -suffix.length : undefined);
  if (!raw || raw.includes("/")) return null;
  return decodeURIComponent(raw);
}

function isInvalidWorkflowId(e) {
  return /invalid workflow id/i.test(String(e && e.message || e));
}

function isWorkflowConflict(e) {
  return /changed on disk/i.test(String(e && e.message || e));
}

function validationFailure(def) {
  const result = validateDefinition(def);
  return result.ok ? null : { error: "Invalid workflow definition", errors: result.errors };
}

// Only allow opening GitHub pages or the local preview server in the system
// browser — never arbitrary URLs handed to a shell.
function isSafeOpenUrl(u) {
  try {
    const p = new URL(u);
    if (p.protocol === "https:") {
      const h = p.hostname.toLowerCase();
      return h === "github.com" || h.endsWith(".github.com");
    }
    if (p.protocol === "http:") {
      const h = p.hostname.toLowerCase();
      return h === "127.0.0.1" || h === "localhost";
    }
    return false;
  } catch { return false; }
}

function openInSystemBrowser(u) {
  const plat = process.platform;
  let child;
  if (plat === "win32") {
    // Never route the URL through `cmd /c start`: shell metacharacters that
    // survive URL parsing (e.g. `&`) would be interpreted by cmd. rundll32's
    // FileProtocolHandler opens the default browser without a shell, and Node
    // quotes the argv entries safely (no windowsVerbatimArguments).
    const root = process.env.SystemRoot || "C:\\Windows";
    child = spawn(join(root, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", u], { detached: true, stdio: "ignore" });
  }
  else if (plat === "darwin") child = spawn("open", [u], { detached: true, stdio: "ignore" });
  else child = spawn("xdg-open", [u], { detached: true, stdio: "ignore" });
  child.unref();
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

export async function readActive() {
  try {
    const raw = await readFile(ACTIVE_FILE, "utf8");
    const j = JSON.parse(raw);
    if (j && j.owner && j.repo && j.issue) return j;
  } catch {}
  return null;
}

function labelNames(issue) {
  return (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
}

// Build the issue-authoritative read model consumed by the webview. The optional
// `resolveDefinition` resolves a pinned workflow from LOCAL state; it is injected
// (not imported) so this module stays free of the store and buildState stays
// callable with fixtures.
export async function buildState(target = null, { resolveDefinition = null } = {}) {
  const active = target || await readActive();
  if (!active) return { active: false };
  const { owner, repo, issue } = active;
  try {
    const [iss, comments] = await Promise.all([
      getIssue(owner, repo, issue),
      listComments(owner, repo, issue),
    ]);
    // Resolve the pinned definition (if any) from local state before deriving, so
    // deriveState can stay synchronous and side-effect free.
    let resolved = null;
    const control = findControlBlock(comments);
    const ref = control && control.data && control.data.workflow;
    if (ref && ref.commentId && typeof resolveDefinition === "function") {
      resolved = await resolveDefinition({ owner, repo, issue }, ref);
    }
    return deriveState({ owner, repo, issue, iss, comments, capabilities: capabilities(), resolved });
  } catch (e) {
    return {
      active: true, owner, repo, issue, error: String(e.message || e), status: "working",
      statusText: "Reading issue state…", stage: "research", gate: null, round: 1, implRound: 0,
      txn: null, pending: null, prototypeRounds: [], prototypeComments: [],
      research: null, questionnaire: null, answers: null, plan: null, impl: null, finalized: null,
      planClauses: [], panel: null, review: null, council: null, panelAvailable: capabilities().panelAvailable !== false,
      panelReviewer: REVIEWER,
      synthesisModel: SYNTHESIS_MODEL,
      approved: null,
    };
  }
}

// Runtime capabilities are injected by the extension host, which is the only
// place that knows whether agent factories can actually run.
let capabilityState = {};
export function setCapabilities(next) { capabilityState = { ...capabilityState, ...(next || {}) }; }
function capabilities() { return capabilityState; }

// Pure derivation of the read model from a fetched issue + its comments. Kept
// side-effect-free so it can be exercised directly with fixtures.
export function deriveState({ owner, repo, issue, iss, comments, capabilities = {}, resolved = null }) {
  {
    const labels = labelNames(iss);
    const control = findControlBlock(comments);
    const d = (control && control.data) || {};

    // The definition this build is pinned to. Resolution is anchored in LOCAL
    // state, never the issue's own snapshot comment (which any collaborator can
    // edit). buildState performs the async lookup and passes the result in via
    // `resolved`; a failure is reported through definitionError rather than
    // thrown, so the read model still renders and the panel can explain it.
    const workflowRef = d.workflow || null;
    let resolvedDefinition = d.pipelineVersion === 3 ? PHASED_DEFAULT
      : d.pipelineVersion === 2 ? BUILTIN_DEFAULT : LEGACY_DEFAULT;
    let definitionError = null;
    if (workflowRef && workflowRef.commentId) {
      if (resolved) {
        resolvedDefinition = resolved.definition || BUILTIN_DEFAULT;
        definitionError = resolved.error || null;
      } else {
        // No resolver ran (e.g. deriveState exercised directly): the issue cannot
        // be trusted to supply the definition, so report it as unavailable.
        definitionError = `workflow ${workflowRef.id || "(unknown)"} for this build is not available locally`;
      }
    }

    const stageLabel = labels.find((l) => l.startsWith("stage:"));
    const gateLabel = labels.find((l) => l.startsWith("gate:"));
    // Accept both the current `proto-round:N` label and the legacy `round:N`.
    const roundLabel = labels.find((l) => l.startsWith("proto-round:") || l.startsWith("round:"));
    const implRoundLabel = labels.find((l) => l.startsWith("impl-round:"));

    const gate = d.gate !== undefined ? d.gate : (gateLabel ? gateLabel.slice(5) : null);
    // Gate → stage fallback covers every human gate in the full pipeline, used
    // only when the control block lacks an explicit stage.
    const stage = d.stage || (stageLabel ? stageLabel.slice(6)
      : gate === "signoff" ? "prototype"
      : gate === "questionnaire" ? "planning"
      : gate === "plan-review" ? "planning"
      : gate === "review-points" ? "review"
      : gate === "council-retry" ? "council"
      : gate === "feedback" && d.pipelineVersion === 3 ? "feedback"
      : gate === "feedback" ? "implementing"
      : "research");
    const artifacts = d.artifacts || {};
    // Prototype rounds parsed from the conversation are the authoritative round
    // count at sign-off; the round label is often left stale by the loop.
    const prototypeComments = findPrototypeComments(comments);
    const round = d.round
      || (prototypeComments[0] && prototypeComments[0].round)
      || (roundLabel ? Number(roundLabel.slice(roundLabel.indexOf(":") + 1)) : 1);
    const implRound = d.implRound != null ? d.implRound
      : (implRoundLabel ? Number(implRoundLabel.slice(11)) : 0);

    let status = d.status;
    if (!status) status = gate ? "waiting" : (stage === "done" ? "done" : "working");
    let statusText = d.statusText;
    if (!statusText) {
      statusText = gate === "signoff" ? "Waiting for your sign-off."
        : gate === "questionnaire" ? "Waiting for your answers."
        : gate === "plan-review" ? "Waiting for your plan approval."
        : gate === "review-points" ? "Decide each review point."
        : gate === "council-retry" ? "Retry independent code review."
        : gate === "feedback" ? "Waiting for your review of the PR."
        : stage === "research" ? "Researching prior art and approaches…"
        : stage === "prototype" ? "Building prototype options…"
        : stage === "planning" ? "Drafting clarifying questions…"
        : stage === "planning-finalize" ? "Drafting the implementation plan…"
        : stage === "review" ? "Reviewing the draft independently…"
        : stage === "synthesis" ? "Synthesizing the final plan…"
        : stage === "council" ? "Independently reviewing the code…"
        : stage === "implementing" ? "Building the change…"
        : stage === "finalizing" ? "Finalizing the PR…"
        : stage === "done" ? "Done — PR ready to merge."
        : "Working…";
    }

    // Prefer control-block artifacts, but fall back to reading them straight
    // from the issue conversation so past stages stay reviewable without a
    // maintained control block.
    let research = artifacts.research || null;
    if (!research) {
      const rc = findCommentByHeading(comments, "🔎 Research");
      if (rc) research = { commentId: rc.commentId };
    }
    let prototypeRounds = artifacts.prototypeRounds || [];

    // Fall back to reading later-stage artifacts straight from the conversation
    // so every stage stays reviewable even without a maintained control block.
    let questionnaire = artifacts.questionnaire || null;
    if (!questionnaire || !Array.isArray(questionnaire.questions) || !questionnaire.questions.length) {
      const parsed = findQuestionnaireComment(comments, questionnaire && questionnaire.commentId);
      if (parsed) {
        questionnaire = {
          ...(questionnaire || {}),
          commentId: (questionnaire && questionnaire.commentId) || parsed.commentId,
          questions: parsed.questions,
        };
      }
    }
    let answers = artifacts.answers || null;
    if (!answers) {
      const ac = findCommentByHeading(comments, "💬 Answers", { newest: true });
      if (ac) answers = { commentId: ac.commentId };
    }
    let plan = artifacts.plan || null;
    if (!plan) {
      const pc = findCommentByHeading(comments, "🗺 Plan", { newest: true });
      if (pc) plan = { commentId: pc.commentId, approved: null };
    }
    // The gate needs the clause list even when the control block is missing or
    // was shed for size: the plan comment itself is the durable source.
    const planComment = plan ? (comments || []).find((c) => String(c.id) === String(plan.commentId)) : null;
    const parsedClauses = planComment ? parseClauses(String(planComment.body || "")) : [];
    if (plan && !Array.isArray(plan.clauses) && parsedClauses.length) {
      plan = { ...plan, clauses: indexClauses(parsedClauses) };
    }
    // Index entries carry status/instruction/quotes; the body carries title/text.
    // The gate needs both, so they are merged here rather than in the webview.
    const clauseMeta = new Map((Array.isArray(plan && plan.clauses) ? plan.clauses : []).map((c) => [c.id, c]));
    const planClauses = parsedClauses.map((c) => {
      const meta = clauseMeta.get(c.id) || {};
      return {
        id: c.id, title: c.title, text: c.text,
        status: meta.status || "open",
        instruction: meta.instruction || null,
        quotes: Array.isArray(meta.quotes) ? meta.quotes : [],
      };
    });

    let panel = d.panel || null;
    if (!panel) {
      const ec = findCommentByHeading(comments, "🧑‍⚖️ Panel evidence", { newest: true });
      if (ec) panel = { evidenceCommentId: ec.commentId };
    }
    let review = null;
    let reviewError = null;
    if (d.review?.commentId) {
      try {
        const commentById = (id) => (comments || []).find((c) => String(c.id) === String(id));
        const data = decodeReview(commentById(d.review.commentId)?.body, d.review.digest);
        const points = data.points.map((point) => {
          const messages = (d.review.threads?.[point.id] || []).flatMap(({ userId, agentId }) => {
            const user = commentById(userId)?.body;
            if (!user) throw new Error(`missing review chat message ${userId}`);
            const text = user.replace(/^## [^\n]*\n\n/, "").replace(/\n\n<!-- AL-IN [^\n]* -->\s*$/, "");
            const reply = agentId ? decodePointReply(commentById(agentId)?.body) : null;
            return reply ? [{ role: "user", text }, { role: "reviewer", text: reply.reply }] : [{ role: "user", text }];
          });
          const last = (d.review.threads?.[point.id] || []).at(-1)?.agentId;
          const refinement = last ? decodePointReply(commentById(last)?.body).recommendation : null;
          return { ...point, recommendation: refinement || point.recommendation, messages,
            ...(d.review.decisions?.[point.id] || {}) };
        });
        review = { ...d.review, points, verdict: data.review.verdict, strengths: data.review.strengths || [] };
      } catch (e) {
        review = { ...d.review, points: [] };
        reviewError = String(e.message || e);
      }
    } else if (d.review) {
      review = { ...d.review, points: [] };
    }
    let impl = artifacts.impl || null;
    if (!impl || impl.prNumber == null) {
      const bc = findBuildReadyComment(comments, impl && impl.commentId);
      if (bc) {
        impl = {
          ...(impl || {}),
          commentId: (impl && impl.commentId) || bc.commentId,
          prNumber: bc.prNumber,
          prUrl: bc.prUrl,
        };
      }
    }
    let finalized = artifacts.finalized || null;
    if (!finalized) {
      const fc = findCommentByHeading(comments, "✅ Finalized", { newest: true });
      if (fc) finalized = { commentId: fc.commentId };
    }

    return {
      active: true, owner, repo, issue,
      issueUrl: iss.html_url,
      title: d.title || iss.title,
      stage, gate, round, implRound, status, statusText,
      pipelineVersion: d.pipelineVersion || 1,
      phaseHistory: d.phaseHistory || null,
      txn: d.txn || null,
      pending: d.pending || null,
      updatedAt: d.updatedAt || null,
      labels,
      research,
      prototypeRounds,
      prototypeComments,
      questionnaire,
      answers,
      plan,
      planClauses,
      panel,
      review,
      reviewError,
      council: d.council || null,
      councilHistory: d.councilHistory || [],
      panelAvailable: capabilities.panelAvailable !== false,
      panelReviewer: REVIEWER,
      synthesisModel: SYNTHESIS_MODEL,
      impl,
      finalized,
      approved: d.approved || null,
      controlCommentId: control ? control.commentId : null,
      workflow: workflowRef,
      definition: resolvedDefinition,
      definitionError,
    };
  }
}

// Assemble the head-pinned PR review snapshot for the feedback gate. This is a
// SEPARATE endpoint (never folded into /state) precisely because check/diff data
// is volatile: putting it in the 4s poll would thrash the gate panel and wipe
// in-progress feedback text. The PR is resolved from the ACTIVE issue's derived
// state — the client never supplies owner/repo/number.
export async function buildPrSnapshot(target = null) {
  const state = await buildState(target);
  if (!state || !state.active) return { available: false, reason: "no-active-issue" };
  const { owner, repo, issue } = state;
  const impl = state.impl || null;
  const prNumber = impl && impl.prNumber;
  if (prNumber == null || !/^[1-9]\d*$/.test(String(prNumber))) {
    return { available: false, reason: "no-pr", owner, repo, issue };
  }
  const reviewedHead = (impl && impl.headSha) || null;
  try {
    const metaA = await getPull(owner, repo, prNumber);
    const files = await getPullFiles(owner, repo, prNumber);
    const metaB = await getPullHead(owner, repo, prNumber); // re-read to catch a mid-read head move
    const snap = buildSnapshot({ metaA, metaB, files, reviewedHead });
    let requiredChecks = null;
    if (state.pipelineVersion === 3) {
      const required = await getRequiredCheckContexts(owner, repo, metaA.baseRefName || "main");
      if (required.state === "present") {
        const rollup = metaA.statusCheckRollup || [];
        const matching = rollup.filter((check) =>
          required.contexts.includes(check.name || check.context || check.workflowName));
        const summary = summarizeChecks(matching);
        const missing = required.contexts.some((name) =>
          !matching.some((check) => (check.name || check.context || check.workflowName) === name));
        requiredChecks = {
          state: required.contexts.length === 0 ? "passed"
            : missing ? "pending"
            : summary.state,
          names: required.contexts,
        };
      } else {
        requiredChecks = { state: required.state, names: [] };
      }
    }
    // Stamp the job identity so the client can prove this snapshot belongs to the
    // issue/PR its panel is bound to (the global active pointer can move under a
    // multi-instance canvas — number alone is not unique across repos).
    return { ...snap, owner, repo, issue, ...(requiredChecks ? { requiredChecks } : {}) };
  } catch (e) {
    return { available: false, reason: "error", error: String(e.message || e), owner, repo, issue };
  }
}


async function serveWork(urlPath, res, scopeRoot) {
  let rel = decodeURIComponent(urlPath.replace(/^\/work\//, ""));
  rel = rel.split("?")[0].split("#")[0];
  let full = normalize(join(WORK_ROOT, rel));
  // Containment is enforced AFTER normalization against the (optionally scoped)
  // root. Checking a decoded string prefix BEFORE normalize is bypassable via
  // encoded traversal (e.g. `%2e%2e%2f` → `../`), so we resolve first and then
  // require `full` to live beneath the scoped root — never a string compare on
  // the raw path.
  const within = (child, root) => child === root || child.startsWith(root + sep);
  const lexRoot = scopeRoot ? normalize(scopeRoot) : WORK_ROOT;
  // Lexical: the scoped root must itself sit under WORK_ROOT, and the target
  // under the scoped root.
  if (!within(lexRoot, WORK_ROOT) || !within(full, lexRoot)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    let s = await stat(full).catch(() => null);
    if (s && s.isDirectory()) { full = join(full, "index.html"); s = await stat(full).catch(() => null); }
    if (!s) { res.writeHead(404); res.end("Not found"); return; }
    // Two-level realpath anchor. Lexical `..` is handled above, but a symlink/
    // junction can still point outside the tree. We require BOTH: (1) the scoped
    // root resolves beneath the GLOBAL work root — so a symlinked owner/repo/issue
    // dir pointing outside WORK_ROOT can't quietly move the anchor with it — and
    // (2) the target resolves beneath that scoped root.
    const realWorkRoot = await realpath(WORK_ROOT).catch(() => WORK_ROOT);
    const realScopeRoot = await realpath(lexRoot).catch(() => null);
    const realFull = await realpath(full).catch(() => null);
    if (!realScopeRoot || !within(realScopeRoot, realWorkRoot) ||
        !realFull || !within(realFull, realScopeRoot)) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    const buf = await readFile(full);
    res.writeHead(200, {
      "Content-Type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}

// Start a loopback HTTP server. POST /intent sends structured human intent to
// the deterministic workflow coordinator; arbitrary UI-authored prompts are not
// accepted.
export async function startServer(deps = {}) {
  // Before anything reads or writes: adopt the pre-rename data root if it is
  // still there. Doing it here rather than at import keeps the side effect out of
  // every process that merely loads paths.mjs.
  migrateLegacyDataRoot();
  if (!existsSync(DATA_ROOT)) await mkdir(DATA_ROOT, { recursive: true });
  if (!existsSync(WORK_ROOT)) await mkdir(WORK_ROOT, { recursive: true });
  const clients = new Set();
  // New canvas instances always start at the launcher. A caller may explicitly
  // bind an issue, but the process-wide compatibility pointer is never adopted
  // implicitly.
  let active = Object.hasOwn(deps, "active") ? deps.active : null;
  const readBoundActive = async () => active;
  const setBoundActive = async (owner, repo, issue) => {
    active = { owner, repo, issue };
    await setActive(owner, repo, issue);
  };
  // Detach this canvas from its issue and return it to the launcher. Deliberately
  // does NOT touch the issue: the build keeps its state, its pending work order
  // and its place in the loop — this only stops this window pointing at it. The
  // process-wide pointer in ACTIVE_FILE is left alone because new canvases never
  // adopt it implicitly anyway.
  const clearBoundActive = async () => { active = null; };
  // Live plan-sequence status, held in memory only. It is merged into /state on
  // read rather than persisted, because it describes a run that is happening
  // right now: after the run ends the durable outcome is on the issue and this
  // would only be a stale copy. Keyed by issue so two canvas instances bound to
  // different issues cannot show each other's progress.
  const sequences = new Map();
  const publishSequence = (key, value) => {
    if (value) sequences.set(key, value); else sequences.delete(key);
    if (serverEntry) broadcastRefresh(serverEntry);
  };
  const buildBoundState = async () => {
    if (!active) return { active: false };
    const st = await (deps.buildState || buildState)(active, { resolveDefinition: resolveDefinitionLocally });
    const seq = sequences.get(`${active.owner}/${active.repo}/${active.issue}`);
    // Only while the run it describes is still the pending one — a sequence left
    // behind by a crashed run must not look live.
    if (seq && st && st.pending && st.pending.opId === seq.opId) st.sequence = seq;
    return st;
  };
  const buildBoundPrSnapshot = async () => active
    ? (deps.buildPrSnapshot || buildPrSnapshot)(active)
    : { available: false, reason: "no-active-issue" };
  // Tests inject this so workflow routes never touch the real per-user store.
  const workflowOpts = () => deps.workflowsDir ? { dir: deps.workflowsDir } : {};
  // Pin operations share the store dir override and add a pins-dir override so a
  // test never writes definition pins under the real ~/.agent-loop.
  const pinOpts = () => ({ ...workflowOpts(), ...(deps.pinsDir ? { pinsDir: deps.pinsDir } : {}) });

  // The local definition trust anchor handed to the coordinator. Every function
  // resolves the store lazily so construction stays synchronous. Because these
  // are the ONLY sources definitionFor trusts, a build's pipeline is always
  // decided by this machine, never by an editable issue comment.
  const pins = deps.pins || {
    readPin: async (target) => (await workflowStore()).readPin(target, pinOpts()),
    writePin: async (target, def) => (await workflowStore()).writePin(target, def, pinOpts()),
    findLocalByHash: async (hash) => (await workflowStore()).findLocalByHash(hash, workflowOpts()),
  };
  // Resolve a build's definition from local state for the read model. Mirrors the
  // coordinator's definitionFor but never throws out of the read path: a failure
  // becomes definitionError so the panel can explain it instead of rendering blank.
  const resolveDefinitionLocally = async ({ owner, repo, issue }, ref) => {
    const hash = typeof ref?.hash === "string" ? ref.hash.trim() : "";
    if (!hash) return { definition: BUILTIN_DEFAULT, error: "workflow reference for this build has no hash" };
    try {
      const pin = await pins.readPin({ owner, repo, issue });
      if (pin && hashDefinition(pin) === hash) return { definition: pin, error: null };
      const local = await pins.findLocalByHash(hash);
      if (local && hashDefinition(local) === hash) return { definition: local, error: null };
    } catch (e) {
      return { definition: BUILTIN_DEFAULT, error: String(e.message || e) };
    }
    return { definition: BUILTIN_DEFAULT, error: `workflow ${ref.id || "(unknown)"} for this build is not available locally` };
  };

  // Per-server capability token. Embedded only in the top-level document, so a
  // sandboxed prototype iframe (opaque origin) can't read it and therefore can't
  // mint privileged requests to the loopback server. `/` is the only tokenless
  // route on THIS origin; prototype assets live on a separate asset origin below.
  const token = randomBytes(24).toString("hex");
  const authed = (req, url) => {
    const h = req.headers["x-al-cap"];
    if (typeof h === "string" && h === token) return true;
    const q = url.searchParams.get("t");
    return typeof q === "string" && q === token;
  };

  // Anti-DNS-rebinding: only accept requests whose Host header is the exact
  // loopback host:port we bound. A rebinding attacker's page carries its own
  // hostname in Host (even after the name resolves to 127.0.0.1), so this rejects
  // it before the tokenless `/` can hand out the capability token.
  let mainPort = 0;
  const hostAllowed = (req, expectedPort) => {
    const host = String(req.headers.host || "").toLowerCase();
    const m = host.match(/^([^:]+|\[[^\]]+\]):(\d+)$/);
    if (!m) return false;
    const hn = m[1];
    return (hn === "127.0.0.1" || hn === "localhost" || hn === "[::1]") && Number(m[2]) === expectedPort;
  };

  // Prototype assets are served from a SEPARATE token-less loopback origin. A
  // popped-out prototype opens as a real (non-sandboxed) browser tab; keeping it
  // cross-origin from the control server means its JS cannot read the capability
  // token from `/` (blocked by the same-origin policy) nor POST /intent (403
  // cross-origin). This origin serves ONLY /work/* for the ACTIVE issue — it has
  // no token document and no privileged routes to reach.
  let assetPort = 0;
  const assetServer = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req, assetPort)) { res.writeHead(403); res.end("Forbidden host"); return; }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname.startsWith("/work/")) {
        // Scope every asset read to this canvas instance's owner/repo/issue
        // subtree so a
        // popped-out prototype can't fetch sibling issues' work dirs and exfil
        // them.
        const active = await readBoundActive();
        if (!active) { res.writeHead(404); res.end("Not found"); return; }
        const scopeRoot = join(WORK_ROOT, String(active.owner), String(active.repo), String(active.issue));
        await serveWork(url.pathname, res, scopeRoot);
        return;
      }
      res.writeHead(404); res.end("Not found");
    } catch { try { res.writeHead(500); res.end("error"); } catch {} }
  });
  await new Promise((resolve) => assetServer.listen(0, "127.0.0.1", resolve));
  const aAddr = assetServer.address();
  assetPort = typeof aAddr === "object" && aAddr ? aAddr.port : 0;
  const assetBase = `http://127.0.0.1:${assetPort}`;
  let serverEntry = null;
  const github = deps.github || {
    ...GitHub,
    detectRepo: () => GitHub.detectRepo(deps.workingDirectory),
  };
  const coordinator = deps.coordinator || createCoordinator({
    github,
    sendPrompt: deps.sendPrompt || deps.onPrompt || (async () => {}),
    setActive: setBoundActive,
    readActive: readBoundActive,
    workRoot: WORK_ROOT,
    assetBase,
    instanceId: deps.instanceId || "agent-loop",
    openPrSession: deps.openPrSession,
    runPanel: deps.runPanel,
    runCouncil: deps.runCouncil,
    publishSequence,
    currentModel: deps.currentModel,
    pins,
    refresh: async () => { if (serverEntry) broadcastRefresh(serverEntry); },
  });

  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req, mainPort)) { res.writeHead(403); res.end("Forbidden host"); return; }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && (path === "/" || path === "")) {
        const savedMode = await readThemePref();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderHtml(token, assetBase, savedMode || ""));
        return;
      }
      // Everything below this line is privileged: reads that could expose issue/PR
      // content cross-origin, or side-effecting POSTs. The one exception is the
      // retired /prototype route (410) handled further down.
      const tokenless = path === "/prototype";
      if (!tokenless && !authed(req, url)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      if (req.method === "GET" && path === "/state") {
        sendJson(res, 200, await buildBoundState());
        return;
      }
      if (req.method === "GET" && path === "/issues") {
        try {
          const repoInfo = await github.detectRepo();
          const issues = (await github.listAgentLoopIssues(repoInfo.owner, repoInfo.repo, { limit: 5 })).slice(0, 5);
          sendJson(res, 200, { owner: repoInfo.owner, repo: repoInfo.repo, issues });
        } catch (e) {
          sendJson(res, 502, { error: String(e.message || e) });
        }
        return;
      }
      if (req.method === "GET" && path === "/workflows") {
        try {
          const store = await workflowStore();
          await store.seedDefaults(workflowOpts());
          sendJson(res, 200, { workflows: await store.listWorkflows(workflowOpts()), primitives: workflowPrimitives() });
        } catch (e) {
          sendJson(res, 502, { error: String(e.message || e) });
        }
        return;
      }
      if (req.method === "POST" && path === "/workflows/validate") {
        const result = validateDefinition(await readBody(req));
        sendJson(res, 200, { ok: result.ok, errors: result.errors });
        return;
      }
      if (req.method === "POST" && path === "/workflows") {
        const body = await readBody(req);
        try {
          const store = await workflowStore();
          const draft = { ...body };
          if (!draft.id) {
            const existingIds = (await store.listWorkflows(workflowOpts())).map((w) => w.id);
            draft.id = store.slugId(draft.name, existingIds);
          }
          const failure = validationFailure(draft);
          if (failure) { sendJson(res, 400, failure); return; }
          sendJson(res, 200, await store.writeWorkflow(draft, { ...workflowOpts(), expectedRev: 0 }));
        } catch (e) {
          if (isWorkflowConflict(e)) sendJson(res, 409, { error: String(e.message || e) });
          else if (isInvalidWorkflowId(e)) sendJson(res, 400, { error: String(e.message || e) });
          else sendJson(res, 502, { error: String(e.message || e) });
        }
        return;
      }
      if (req.method === "POST" && path.startsWith("/workflows/") && path.endsWith("/duplicate")) {
        let id;
        try { id = pathId(path, "/workflows/", "/duplicate"); }
        catch (e) { sendJson(res, 400, { error: String(e.message || e) }); return; }
        if (!id) { res.writeHead(404); res.end("Not found"); return; }
        const body = await readBody(req);
        try {
          const store = await workflowStore();
          sendJson(res, 200, await store.duplicateWorkflow(id, { ...workflowOpts(), name: body.name }));
        } catch (e) {
          const msg = String(e.message || e);
          if (isInvalidWorkflowId(e)) sendJson(res, 400, { error: msg });
          else if (/does not exist/i.test(msg)) sendJson(res, 404, { error: msg });
          else sendJson(res, 502, { error: msg });
        }
        return;
      }
      if (path.startsWith("/workflows/")) {
        let id;
        try { id = pathId(path, "/workflows/"); }
        catch (e) { sendJson(res, 400, { error: String(e.message || e) }); return; }
        if (!id) { res.writeHead(404); res.end("Not found"); return; }
        if (req.method === "GET") {
          try {
            const store = await workflowStore();
            const def = await store.readWorkflow(id, workflowOpts());
            if (!def) { sendJson(res, 404, { error: `Workflow ${id} does not exist.` }); return; }
            sendJson(res, 200, def);
          } catch (e) {
            if (isInvalidWorkflowId(e)) sendJson(res, 400, { error: String(e.message || e) });
            else sendJson(res, 502, { error: String(e.message || e) });
          }
          return;
        }
        if (req.method === "PUT") {
          const body = await readBody(req);
          try {
            const { expectedRev, ...rest } = body || {};
            const opts = workflowOpts();
            if (Object.hasOwn(body || {}, "expectedRev")) {
              if (!Number.isInteger(expectedRev)) { sendJson(res, 400, { error: "expectedRev must be an integer" }); return; }
              opts.expectedRev = expectedRev;
            }
            const draft = { ...rest, id };
            const failure = validationFailure(draft);
            if (failure) { sendJson(res, 400, failure); return; }
            const store = await workflowStore();
            sendJson(res, 200, await store.writeWorkflow(draft, opts));
          } catch (e) {
            if (isWorkflowConflict(e)) sendJson(res, 409, { error: String(e.message || e) });
            else if (isInvalidWorkflowId(e)) sendJson(res, 400, { error: String(e.message || e) });
            else sendJson(res, 502, { error: String(e.message || e) });
          }
          return;
        }
        if (req.method === "DELETE") {
          try {
            const store = await workflowStore();
            sendJson(res, 200, { ok: true, deleted: await store.deleteWorkflow(id, workflowOpts()) });
          } catch (e) {
            const msg = String(e.message || e);
            if (isInvalidWorkflowId(e) || /default workflow/i.test(msg)) sendJson(res, 400, { error: msg });
            else sendJson(res, 502, { error: msg });
          }
          return;
        }
      }
      if (req.method === "GET" && path === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
        res.write("event: refresh\ndata: {}\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "GET" && path.startsWith("/comment/")) {
        const id = path.slice("/comment/".length);
        if (!/^\d+$/.test(id)) { sendJson(res, 400, { error: "invalid comment id" }); return; }
        const active = await readBoundActive();
        if (!active) { sendJson(res, 404, { error: "no active issue" }); return; }
        try {
          const c = await getComment(active.owner, active.repo, id, active.issue);
          // Never hand back a comment that belongs to a different issue/repo. The
          // GraphQL fallback (used only on REST degradation) is already scoped to
          // the active issue and carries no issue_url, so absence is acceptable;
          // a present issue_url must match.
          if (c.issue_url) {
            const want = `/repos/${active.owner}/${active.repo}/issues/${active.issue}`.toLowerCase();
            if (!String(c.issue_url).toLowerCase().endsWith(want)) {
              sendJson(res, 403, { error: "comment does not belong to the active issue" });
              return;
            }
          }
          sendJson(res, 200, { id: c.id, body: c.body });
        } catch (e) { sendJson(res, 502, { error: String(e.message || e) }); }
        return;
      }
      if (req.method === "GET" && path === "/pr") {
        sendJson(res, 200, await buildBoundPrSnapshot());
        return;
      }
      if (req.method === "GET" && path === "/prototype") {
        // Removed: this proxied arbitrary loopback HTTP responses (SSRF) and
        // injected script. Prototype previews are now served directly from
        // WORK_ROOT via /work/<path>; the canvas builds those URLs itself.
        res.writeHead(410); res.end("Gone");
        return;
      }
      if (req.method === "POST" && path === "/open") {
        const body = await readBody(req);
        const target = typeof body.url === "string" ? body.url : "";
        if (!isSafeOpenUrl(target)) { sendJson(res, 400, { ok: false, error: "blocked url" }); return; }
        try { openInSystemBrowser(target); sendJson(res, 200, { ok: true }); }
        catch (e) { sendJson(res, 502, { ok: false, error: String(e.message || e) }); }
        return;
      }
      if (req.method === "GET" && path === "/theme") {
        const mode = await readThemePref();
        sendJson(res, 200, { mode: mode || null });
        return;
      }
      if (req.method === "POST" && path === "/theme") {
        const body = await readBody(req);
        const mode = body && body.mode;
        if (mode !== "dark" && mode !== "light") { sendJson(res, 400, { ok: false, error: "mode must be 'dark' or 'light'" }); return; }
        try {
          await writeThemePref(mode);
          sendJson(res, 200, { ok: true, mode });
        } catch (e) {
          sendJson(res, 502, { ok: false, error: String(e.message || e) });
        }
        return;
      }
      if (req.method === "POST" && path === "/unbind") {
        await clearBoundActive();
        broadcastRefresh(serverEntry);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && path === "/intent") {
        const body = await readBody(req);
        if (!body || typeof body.kind !== "string") { sendJson(res, 400, { ok: false, error: "intent kind is required" }); return; }
        try {
          // A kickoff names a workflow by id; the definition itself is resolved
          // here from the local store and handed to the coordinator. The browser
          // never gets to supply the steps a build will run, so any `definition`
          // it sends is dropped unconditionally before resolution.
          const intent = { ...body };
          if (intent.kind === "kickoff") {
            const data = { ...(intent.data || {}) };
            delete data.definition;
            const workflowId = data.workflowId;
            if (workflowId && workflowId !== "default") {
              const store = await workflowStore();
              const def = await store.readWorkflow(String(workflowId), workflowOpts());
              if (!def) { sendJson(res, 400, { ok: false, error: `workflow ${workflowId} does not exist` }); return; }
              data.definition = def;
            }
            intent.data = data;
          }
          const out = await coordinator.handleIntent(intent);
          sendJson(res, 200, { ok: true, result: out });
        } catch (e) {
          sendJson(res, 502, { ok: false, error: String(e.message || e) });
        }
        return;
      }
      res.writeHead(404); res.end("Not found");
    } catch (e) {
      try { sendJson(res, 500, { error: String(e.message || e) }); } catch {}
    }
  });

  await new Promise((resolve) => server.listen(deps.port || 0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  mainPort = port;
  serverEntry = {
    server, assetServer, clients, url: `http://127.0.0.1:${port}/`, assetBase,
    token, coordinator, readActive: readBoundActive, setActive: setBoundActive,
    buildState: buildBoundState, buildPrSnapshot: buildBoundPrSnapshot,
    publishSequence,
  };
  return serverEntry;
}

export function broadcastRefresh(entry) {
  if (!entry) return;
  const payload = "event: refresh\ndata: {}\n\n";
  for (const client of entry.clients) { try { client.write(payload); } catch {} }
}

export async function setActive(owner, repo, issue) {
  if (!existsSync(DATA_ROOT)) await mkdir(DATA_ROOT, { recursive: true });
  await writeFile(ACTIVE_FILE, JSON.stringify({ owner, repo, issue }, null, 2));
}
