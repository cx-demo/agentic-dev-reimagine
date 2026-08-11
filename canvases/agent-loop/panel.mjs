// The two-model plan panel.
//
// Two reviewers run in parallel in FRESH subagent contexts, each pinned to an
// explicit model from a different provider family, then a third fresh subagent
// synthesizes their reviews into the final clause set.
//
// This module is pure orchestration over injected dependencies so it can be
// tested without the SDK, the canvas server, or a network.

import { renderClauses } from "./clauses.mjs";

export const FACTORY_NAME = "agent-loop-plan-panel";

export const DEFAULT_REVIEWERS = [
  { id: "claude", model: "claude-sonnet-5" },
  { id: "openai", model: "gpt-5.6-sol" },
];

// Three agents, each able to retry once in schema mode.
export const DEFAULT_LIMITS = {
  maxConcurrentSubagents: 2,
  maxTotalSubagents: 6,
  timeoutSeconds: 900,
  maxAiCredits: 12,
};

const SEVERITIES = ["high", "medium", "low"];

export function familyOf(model) {
  const m = String(model || "").toLowerCase();
  if (!m) return null;
  if (m.includes("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.includes("openai") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.includes("gemini")) return "google";
  if (m.includes("grok")) return "xai";
  return "other:" + m.split(/[-.:/]/)[0];
}

// Provider diversity is the whole point of the panel: two agents from the same
// family read as diverse and are not. Refuse to dispatch instead.
export function assertProviderDiversity(reviewers) {
  const list = Array.isArray(reviewers) ? reviewers : [];
  if (list.length !== 2) throw new Error("the panel needs exactly two reviewers");
  const seenIds = new Set();
  for (const r of list) {
    const id = String((r && r.id) || "").trim();
    const model = String((r && r.model) || "").trim();
    if (!id) throw new Error("each reviewer needs an id");
    if (!model) throw new Error(`reviewer ${id} is missing a model id`);
    if (seenIds.has(id)) throw new Error(`duplicate reviewer id ${id}`);
    seenIds.add(id);
  }
  const [a, b] = list;
  if (a.model === b.model) throw new Error(`both reviewers are pinned to ${a.model}`);
  const fa = familyOf(a.model);
  const fb = familyOf(b.model);
  if (fa === fb) throw new Error(`both reviewers resolve to the same provider family (${fa})`);
  return true;
}

export function normalizeReviewers(reviewers) {
  const list = (Array.isArray(reviewers) && reviewers.length ? reviewers : DEFAULT_REVIEWERS)
    .map((r) => ({ id: String(r.id || "").trim(), model: String(r.model || "").trim() }));
  assertProviderDiversity(list);
  return list;
}

// The bounded evidence packet.
//
// A fresh context only avoids context rot if the input is concise, explicit and
// IDENTICAL for both reviewers. The conversation transcript is deliberately
// excluded — carrying it would reintroduce exactly the rot the panel exists to
// prevent.
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
// human exactly what each model said about the clause in front of them.
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
    "You are an independent reviewer on a two-model plan panel.",
    "A second reviewer, from a different provider family, is reviewing the same plan in a separate context. You cannot see them and must not speculate about them.",
    "Review the draft implementation plan strictly against the evidence below. Do not invent scope.",
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
    "You are synthesizing one final implementation plan from independent reviews.",
    mode === "synthesis-only"
      ? "These reviews were produced for an earlier revision of this plan and are being reused. Apply the human's per-clause instructions; do not re-litigate settled clauses."
      : "Resolve every disagreement between the reviewers explicitly and record it.",
    "Preserve requirements supported by repository evidence. Do not invent scope.",
    "Keep each clause's existing `id` when you carry it forward; only use a new id for a genuinely new clause.",
    "A clause the human pinned must be returned unchanged.",
    "",
    "```json",
    JSON.stringify({ ...packet, reviews }, null, 2),
    "```",
  ].join("\n");
}

// Run the panel. `deps.agent({ label, model, prompt, schema })` resolves the
// subagent's structured result, or null on an ordinary failure.
export async function runPanel(deps, input = {}) {
  const { agent, parallel, step, log } = deps || {};
  if (typeof agent !== "function") throw new Error("panel requires an agent runner");
  const runAll = typeof parallel === "function" ? parallel : (jobs) => Promise.all(jobs.map((j) => j()));
  const journal = typeof step === "function" ? step : (_key, fn) => fn();
  const note = typeof log === "function" ? log : () => {};

  const reviewers = normalizeReviewers(input.reviewers);
  const packet = buildPacket(input);
  const clauseIds = (input.clauses || []).map((c) => c.id);
  const opId = String(input.opId || "");
  const mode = input.mode === "synthesis-only" ? "synthesis-only" : "full";

  let reviews = [];
  let degraded = null;

  if (mode === "synthesis-only") {
    reviews = Array.isArray(input.reviews) ? input.reviews : [];
    if (!reviews.length) throw new Error("synthesis-only run has no stored reviews to reuse");
  } else {
    const settled = await runAll(reviewers.map((r) => async () => {
      // A unique label is load-bearing: identical prompt+options memoize into a
      // SINGLE subagent, which would silently collapse the panel to one reviewer.
      const label = `plan-review:${r.id}`;
      try {
        const raw = await journal(`${opId}/review/${r.id}`, () => agent({
          label, model: r.model, prompt: reviewPrompt(packet, r.id), schema: REVIEW_SCHEMA,
        }));
        return { ok: true, review: validateReview(raw, { reviewerId: r.id, clauseIds }), reviewer: r };
      } catch (err) {
        return { ok: false, reviewer: r, error: err && err.message ? err.message : String(err) };
      }
    }));

    const good = settled.filter((s) => s.ok);
    const bad = settled.filter((s) => !s.ok);

    // Zero reviews is not a panel. One review is a degraded panel, which the
    // approved plan explicitly allows, provided it is recorded and shown.
    if (!good.length) {
      throw new Error(`plan panel failed: ${bad.map((b) => `${b.reviewer.id} (${b.error})`).join("; ") || "no reviews"}`);
    }
    reviews = good.map((g) => g.review);
    if (bad.length) {
      degraded = {
        reason: "reviewer-unavailable",
        missing: bad.map((b) => ({ id: b.reviewer.id, model: b.reviewer.model, error: b.error })),
        survived: good.map((g) => g.reviewer.id),
      };
      note(`plan panel degraded: ${degraded.missing.map((m) => m.id).join(", ")} unavailable`);
    }
  }

  const synthRaw = await journal(`${opId}/synthesis/${input.rev || 1}`, () => agent({
    label: `plan-synthesis:rev${input.rev || 1}`,
    model: input.synthesisModel || reviewers[0].model,
    prompt: synthesisPrompt(packet, reviews, mode),
    schema: SYNTHESIS_SCHEMA,
  }));
  const synthesis = validateSynthesis(synthRaw);

  return {
    mode,
    reviews,
    degraded,
    clauses: synthesis.clauses,
    disagreements: synthesis.disagreements,
    quotes: attributeQuotes(clauseIds, reviews),
    models: reviewers.map((r) => ({ id: r.id, model: r.model, family: familyOf(r.model) })),
    freshContexts: true,
  };
}

// Registered through joinSession when the host SDK supports factories. Kept in
// one place so capability detection in extension.mjs stays a single guarded call.
export function planPanelFactoryDefinition(limits = DEFAULT_LIMITS) {
  return {
    meta: {
      name: FACTORY_NAME,
      description: "Two model-diverse plan reviewers in fresh contexts, plus a fresh synthesis agent.",
      limits: { ...DEFAULT_LIMITS, ...(limits || {}) },
      phases: [
        { title: "Reviewing", detail: "Two independent reviewers read the draft plan." },
        { title: "Synthesizing", detail: "One fresh agent reconciles both reviews." },
      ],
    },
    run: async (ctx) => runPanel({
      agent: ({ label, model, prompt, schema }) => ctx.agent(prompt, { label, model, schema }),
      parallel: typeof ctx.parallel === "function" ? (jobs) => ctx.parallel(jobs) : null,
      step: typeof ctx.step === "function" ? (key, fn) => ctx.step(key, fn) : null,
      log: typeof ctx.log === "function" ? (m) => ctx.log(m) : null,
    }, (ctx && ctx.args) || {}),
  };
}
