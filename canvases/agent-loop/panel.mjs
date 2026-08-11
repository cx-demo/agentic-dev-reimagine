// The sequential plan review.
//
// Three steps run one after another: the draft arrives already written, ONE
// reviewer reads it in a FRESH subagent context, and a second fresh subagent
// synthesizes that review into the final clause set. The human is asked for
// nothing until the last step lands.
//
// This replaced a two-model panel. The quorum doubled cost and spawn surface to
// reconcile two reviews that usually agreed, and its partial-success path let a
// host-side spawn refusal masquerade as a degraded panel. One reviewer has no
// quorum to hide behind: it either reviewed the plan or it did not, and the
// difference is reported.
//
// This module is pure orchestration over injected dependencies so it can be
// tested without the SDK, the canvas server, or a network.

import { renderClauses } from "./clauses.mjs";

// Unchanged across the single-reviewer rewrite on purpose: a control block may
// already hold a run id for resume, and renaming the factory would orphan it.
export const FACTORY_NAME = "agent-loop-plan-panel";

export const REVIEWER = { id: "claude", model: "claude-sonnet-5" };

// Synthesis is named rather than inherited from the reviewer. Deriving it
// positionally (`reviewers[0].model`) silently coupled the cost of synthesis to
// whichever reviewer happened to be listed first.
export const SYNTHESIS_MODEL = "claude-sonnet-5";

// Two agents, each able to retry once in schema mode, is 4 spawns exactly.
//
// The credit budget is sized from measurement, not intuition: against the real
// ~20k-char packet a review costs ~19 credits and synthesis ~6, so a run lands
// near 25. The ceiling stays well above that. It is soft and post-paid, so
// headroom costs nothing unless the work is actually done, while setting it too
// low fails the whole run mid-flight — an asymmetry that argues for headroom.
export const DEFAULT_LIMITS = {
  maxConcurrentSubagents: 1,
  maxTotalSubagents: 4,
  timeoutSeconds: 900,
  maxAiCredits: 120,
};

const SEVERITIES = ["high", "medium", "low"];

// Provider family is still surfaced to the human as provenance, but it no longer
// gates dispatch: there is only one reviewer, so there is no pair to diversify.
export function familyOf(model) {
  const m = String(model || "").toLowerCase();
  if (!m) return null;
  if (m.includes("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.includes("openai") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.includes("gemini")) return "google";
  if (m.includes("grok")) return "xai";
  return "other:" + m.split(/[-.:/]/)[0];
}

export function normalizeReviewer(reviewer) {
  const r = reviewer && typeof reviewer === "object" ? reviewer : REVIEWER;
  const id = String(r.id || "").trim();
  const model = String(r.model || "").trim();
  if (!id) throw new Error("the reviewer needs an id");
  if (!model) throw new Error(`reviewer ${id} is missing a model id`);
  return { id, model };
}

// The bounded evidence packet.
//
// A fresh context only avoids context rot if the input is concise and explicit.
// The conversation transcript is deliberately excluded — carrying it would
// reintroduce exactly the rot the review exists to prevent. The reviewer and the
// synthesizer see the same packet, so a finding can always be traced back to it.
export function buildPacket(input = {}) {
  const clip = (v, n) => {
    const s = String(v == null ? "" : v).trim();
    return s.length > n ? s.slice(0, n) + "\n\n…[truncated]" : s;
  };
  const packet = {
    issue: {
      owner: String(input.owner || ""),
      repo: String(input.repo || ""),
      number: Number(input.issue || 0),
      request: clip(input.request, 4000),
    },
    research: clip(input.research, 8000),
    prototype: clip(input.prototype, 2000),
    answers: clip(input.answers, 6000),
    draftPlan: renderClauses(input.clauses),
    constraints: {
      baseBranch: String(input.baseBranch || "main"),
      branch: String(input.branch || ""),
      files: (Array.isArray(input.files) ? input.files : []).map(String).slice(0, 60),
      tests: (Array.isArray(input.tests) ? input.tests : []).map(String).slice(0, 30),
    },
  };
  const feedback = clip(input.feedback, 4000);
  if (feedback) packet.feedback = feedback;
  const decisions = (Array.isArray(input.decisions) ? input.decisions : [])
    .filter((d) => d && d.clauseId)
    .map((d) => ({ clauseId: String(d.clauseId), action: String(d.action || ""), instruction: clip(d.instruction, 1000) || null }));
  if (decisions.length) packet.decisions = decisions;
  return packet;
}

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "revise"] },
    strengths: { type: "array", items: { type: "string" } },
    risks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          clauseId: { type: "string" },
          evidence: { type: "string" },
          recommendation: { type: "string" },
        },
        required: ["severity", "evidence", "recommendation"],
      },
    },
    omissions: { type: "array", items: { type: "string" } },
    suggestedChanges: {
      type: "array",
      items: {
        type: "object",
        properties: { clauseId: { type: "string" }, change: { type: "string" } },
        required: ["change"],
      },
    },
  },
  required: ["verdict", "risks"],
};

export const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    clauses: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, title: { type: "string" }, text: { type: "string" } },
        required: ["id", "title", "text"],
      },
    },
    disagreements: {
      type: "array",
      items: {
        type: "object",
        properties: { topic: { type: "string" }, positions: { type: "string" }, resolution: { type: "string" } },
        required: ["topic", "resolution"],
      },
    },
  },
  required: ["clauses"],
};

// The SDK's schema support is structural: `additionalProperties`, lengths and
// patterns are IGNORED, not enforced. Everything is therefore re-validated here,
// at the coordinator boundary, before it can reach issue state.
export function validateReview(raw, { reviewerId, clauseIds = [] } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`reviewer ${reviewerId} returned no review`);
  const verdict = String(raw.verdict || "").toLowerCase();
  if (!["approve", "revise"].includes(verdict)) throw new Error(`reviewer ${reviewerId} returned an invalid verdict`);
  const known = new Set(clauseIds);
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const list = (v) => (Array.isArray(v) ? v : []);
  const risks = list(raw.risks).slice(0, 40).map((r, i) => {
    const severity = String((r && r.severity) || "").toLowerCase();
    const evidence = str(r && r.evidence, 2000);
    const recommendation = str(r && r.recommendation, 2000);
    if (!SEVERITIES.includes(severity)) throw new Error(`reviewer ${reviewerId} risk ${i} has an invalid severity`);
    if (!evidence || !recommendation) throw new Error(`reviewer ${reviewerId} risk ${i} is incomplete`);
    const clauseId = str(r && r.clauseId, 16);
    // An unknown clause reference is dropped rather than fatal: a reviewer may
    // legitimately raise a whole-plan risk that belongs to no single clause.
    return { severity, evidence, recommendation, clauseId: known.has(clauseId) ? clauseId : null };
  });
  return {
    reviewerId: String(reviewerId || ""),
    verdict,
    strengths: list(raw.strengths).slice(0, 20).map((s) => str(s, 600)).filter(Boolean),
    risks,
    omissions: list(raw.omissions).slice(0, 20).map((s) => str(s, 600)).filter(Boolean),
    suggestedChanges: list(raw.suggestedChanges).slice(0, 40).map((s) => ({
      clauseId: known.has(str(s && s.clauseId, 16)) ? str(s && s.clauseId, 16) : null,
      change: str(s && s.change, 2000),
    })).filter((s) => s.change),
  };
}

export function validateSynthesis(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("synthesis returned nothing");
  const clauses = Array.isArray(raw.clauses) ? raw.clauses : [];
  if (!clauses.length) throw new Error("synthesis returned no clauses");
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  return {
    clauses: clauses.slice(0, 40).map((c) => ({
      id: str(c && c.id, 16),
      title: str(c && c.title, 200),
      text: str(c && c.text, 6000),
    })),
    disagreements: (Array.isArray(raw.disagreements) ? raw.disagreements : []).slice(0, 20).map((d) => ({
      topic: str(d && d.topic, 300),
      positions: str(d && d.positions, 1200),
      resolution: str(d && d.resolution, 1200),
    })).filter((d) => d.topic && d.resolution),
  };
}

// Quotes are attributed per clause so the gate's Evidence expander can show the
// human exactly what the reviewer said about the clause in front of them.
export function attributeQuotes(clauseIds, reviews) {
  const out = {};
  for (const id of clauseIds) out[id] = [];
  for (const review of reviews || []) {
    for (const risk of review.risks || []) {
      if (risk.clauseId && out[risk.clauseId]) {
        out[risk.clauseId].push({ reviewerId: review.reviewerId, severity: risk.severity, text: risk.evidence });
      }
    }
    for (const change of review.suggestedChanges || []) {
      if (change.clauseId && out[change.clauseId]) {
        out[change.clauseId].push({ reviewerId: review.reviewerId, severity: null, text: change.change });
      }
    }
  }
  return out;
}

function reviewPrompt(packet, reviewerId) {
  return [
    "You are the independent reviewer of a draft implementation plan.",
    "You are the ONLY reviewer. Nothing downstream will catch what you miss, so read for what is wrong, missing or unsupported rather than for what is agreeable.",
    "Review the draft strictly against the evidence below. Do not invent scope.",
    "Attach `clauseId` to every risk and suggested change that targets a specific clause.",
    "",
    `Reviewer id: ${reviewerId}`,
    "",
    "```json",
    JSON.stringify(packet, null, 2),
    "```",
  ].join("\n");
}

function synthesisPrompt(packet, reviews, mode) {
  return [
    "You are producing the final implementation plan from a draft and its independent review.",
    mode === "synthesis-only"
      ? "This review was produced for an earlier revision of this plan and is being reused. Apply the human's per-clause instructions; do not re-litigate settled clauses."
      : "Apply every review finding you accept, and record any finding you reject as a disagreement with the reason you rejected it.",
    "Preserve requirements supported by repository evidence. Do not invent scope.",
    "Keep each clause's existing `id` when you carry it forward; only use a new id for a genuinely new clause.",
    "A clause the human pinned must be returned unchanged.",
    "",
    "```json",
    JSON.stringify({ ...packet, reviews }, null, 2),
    "```",
  ].join("\n");
}

// A null result from a subagent call is NOT a bad review — it is the absence of
// one. The SDK resolves `null` for every ordinary failure, including a host that
// refused to start the subagent at all, so this is the last point where the two
// can still be told apart from a bad review body. Tag it, and let the caller
// attach the spawn count that says which it was.
export function reviewNeverRan(model) {
  const err = new Error(`the review did not run: no result came back from ${model}`);
  err.code = "review-not-started";
  return err;
}

// Run the plan review. `deps.agent({ label, model, prompt, schema })` resolves
// the subagent's structured result, or null on an ordinary failure.
//
// The three steps are sequential by construction: the draft is already written
// when this is called, the review must finish before synthesis can read it, and
// synthesis produces what the human is shown. `deps.progress` reports each
// transition so the canvas can name the step that is running — or the one that
// stalled — instead of showing an opaque spinner.
export async function runPanel(deps, input = {}) {
  const { agent, step, log, progress } = deps || {};
  if (typeof agent !== "function") throw new Error("the plan review requires an agent runner");
  const journal = typeof step === "function" ? step : (_key, fn) => fn();
  const note = typeof log === "function" ? log : () => {};
  const report = typeof progress === "function" ? progress : () => {};

  const reviewer = normalizeReviewer(input.reviewer);
  const packet = buildPacket(input);
  const clauseIds = (input.clauses || []).map((c) => c.id);
  const opId = String(input.opId || "");
  const mode = input.mode === "synthesis-only" ? "synthesis-only" : "full";

  let reviews = [];

  if (mode === "synthesis-only") {
    reviews = Array.isArray(input.reviews) ? input.reviews : [];
    if (!reviews.length) throw new Error("synthesis-only run has no stored review to reuse");
    report({ step: "review", state: "reused", model: reviewer.model, detail: "Reusing the review from the previous revision." });
  } else {
    report({ step: "review", state: "running", model: reviewer.model });
    let raw;
    try {
      raw = await journal(`${opId}/review/${reviewer.id}`, () => agent({
        label: `plan-review:${reviewer.id}`,
        model: reviewer.model,
        prompt: reviewPrompt(packet, reviewer.id),
        schema: REVIEW_SCHEMA,
      }));
    } catch (err) {
      report({ step: "review", state: "failed", model: reviewer.model, detail: err && err.message ? err.message : String(err) });
      throw err;
    }
    if (raw == null) {
      const err = reviewNeverRan(reviewer.model);
      report({ step: "review", state: "failed", model: reviewer.model, code: err.code, detail: err.message });
      throw err;
    }
    // One reviewer means no quorum to fall back on: an unusable review fails the
    // run rather than degrading it, so an unreviewed plan can never reach the
    // human wearing a reviewed plan's provenance.
    let review;
    try {
      review = validateReview(raw, { reviewerId: reviewer.id, clauseIds });
    } catch (err) {
      report({ step: "review", state: "failed", model: reviewer.model, detail: err && err.message ? err.message : String(err) });
      throw err;
    }
    reviews = [review];
    const risks = review.risks.length;
    note(`plan review: ${review.verdict}, ${risks} risk${risks === 1 ? "" : "s"}`);
    report({
      step: "review", state: "done", model: reviewer.model,
      detail: `${risks} finding${risks === 1 ? "" : "s"} · verdict ${review.verdict}`,
    });
  }

  report({ step: "synthesis", state: "running", model: SYNTHESIS_MODEL });
  const synthRaw = await journal(`${opId}/synthesis/${input.rev || 1}`, () => agent({
    label: `plan-synthesis:rev${input.rev || 1}`,
    model: SYNTHESIS_MODEL,
    prompt: synthesisPrompt(packet, reviews, mode),
    schema: SYNTHESIS_SCHEMA,
  }));
  const synthesis = validateSynthesis(synthRaw);
  report({
    step: "synthesis", state: "done", model: SYNTHESIS_MODEL,
    detail: `${synthesis.clauses.length} clause${synthesis.clauses.length === 1 ? "" : "s"}`,
  });

  return {
    mode,
    reviews,
    clauses: synthesis.clauses,
    disagreements: synthesis.disagreements,
    quotes: attributeQuotes(clauseIds, reviews),
    models: [{ id: reviewer.id, model: reviewer.model, family: familyOf(reviewer.model) }],
    synthesisModel: SYNTHESIS_MODEL,
    freshContexts: true,
  };
}

// Registered through joinSession when the host SDK supports factories. Kept in
// one place so capability detection in extension.mjs stays a single guarded call.
//
// `resolveProgress` exists because `args` cross a serialization boundary — a
// callback cannot be passed in them. The factory body runs in the extension
// process, so the reporter is looked up by opId at run time instead.
export function planPanelFactoryDefinition(limits = DEFAULT_LIMITS, { resolveProgress } = {}) {
  return {
    meta: {
      name: FACTORY_NAME,
      description: "One independent plan reviewer in a fresh context, then a fresh synthesis agent.",
      limits: { ...DEFAULT_LIMITS, ...(limits || {}) },
      phases: [
        { title: "Reviewing", detail: "One independent reviewer reads the draft plan." },
        { title: "Synthesizing", detail: "One fresh agent applies the review to the draft." },
      ],
    },
    run: async (ctx) => runPanel({
      agent: ({ label, model, prompt, schema }) => ctx.agent(prompt, { label, model, schema }),
      step: typeof ctx.step === "function" ? (key, fn) => ctx.step(key, fn) : null,
      log: typeof ctx.log === "function" ? (m) => ctx.log(m) : null,
      progress: typeof resolveProgress === "function"
        ? resolveProgress(String((ctx && ctx.args && ctx.args.opId) || ""))
        : null,
    }, (ctx && ctx.args) || {}),
  };
}
