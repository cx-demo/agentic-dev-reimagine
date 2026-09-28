// Workflow definitions — the data model the coordinator interprets.
//
// The pipeline used to be spread across six hardcoded sites (labels, intents,
// artifact acceptance, transitions, agent contracts, and the webview's stepper).
// This module makes it one document instead, so a user can author a different
// pipeline without touching code.
//
// The unit is a STEP, not a "stage". A step is one turn of the loop: produce an
// asset, validate it, then either open a human gate or move on. `stage` is the
// coarser label written to the issue, and several steps can share one — the
// legacy pipeline has three steps that all report `stage: "planning"`. Keeping
// them separate is what lets the definition round-trip today's behaviour exactly
// instead of approximating it.
//
// Definitions are DATA. They may reference primitives by name (see
// workflow-primitives.mjs) but can never carry executable code.

import { createHash } from "node:crypto";
import {
  FIELD_TYPE_NAMES, RULES, RULE_OPERANDS, CAPABILITY_NAMES,
  GATE_WIDGETS, GATE_WIDGET_NAMES, PRODUCERS, parseOutcome,
} from "./workflow-primitives.mjs";

export const DEFINITION_VERSION = 1;

// Values a contract may interpolate. Every one is derived by the coordinator
// from the issue and the work root — a definition can reference them but cannot
// compute them, which is what keeps agent-visible paths code-stamped.
export const CONTRACT_VARS = [
  "owner", "repo", "issue", "round", "branch", "base", "prTitle",
  "protoBase", "protoDir", "implDemoPath", "reviewerModel", "instanceId", "issueUrl",
];

// ─── normalization ───────────────────────────────────────────────────────────

function str(v, fallback = "") { return v === undefined || v === null ? fallback : String(v); }

function titleize(id) {
  return str(id).split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Step";
}

function normalizeField(f) {
  const out = { name: str(f && f.name), type: str(f && f.type, "text") };
  if (f && f.required === false) out.required = false; else out.required = true;
  if (f && f.of) out.of = str(f.of);
  if (f && Array.isArray(f.values)) out.values = f.values.map(String);
  return out;
}

function normalizeRule(r) {
  const out = { rule: str(r && r.rule) };
  for (const k of ["field", "value", "key", "template", "message"]) {
    if (r && r[k] !== undefined) out[k] = k === "value" ? r[k] : str(r[k]);
  }
  return out;
}

function normalizeWidget(w) {
  const out = { type: str(w && w.type) };
  for (const k of ["source", "id", "label", "placeholder"]) {
    if (w && w[k] !== undefined) out[k] = str(w[k]);
  }
  if (w && Array.isArray(w.items)) out.items = w.items.map(String);
  return out;
}

function normalizeAction(a) {
  const out = {
    id: str(a && a.id),
    label: str(a && a.label) || titleize(a && a.id),
    style: str(a && a.style, "secondary"),
    outcome: str(a && a.outcome, "advance"),
  };
  if (a && a.status) out.status = str(a.status);
  if (a && a.confirm) out.confirm = true;
  return out;
}

function normalizeGate(g) {
  if (!g) return null;
  return {
    id: str(g.id),
    title: str(g.title) || titleize(g.id),
    widgets: (Array.isArray(g.widgets) ? g.widgets : []).map(normalizeWidget),
    actions: (Array.isArray(g.actions) ? g.actions : []).map(normalizeAction),
  };
}

function normalizeStep(s, index) {
  const id = str(s && s.id);
  // Field names follow the product vocabulary: a workflow has STAGES, a stage has
  // STEPS. `stage` is that user-facing grouping.
  //
  // `issueLabel` is bookkeeping — the value stamped onto the issue as
  // `stage:<x>` — and is never surfaced in the UI. It defaults to the stage, so
  // an authored workflow never has to think about it; only the built-in default
  // sets it explicitly, to preserve the historical `planning` /
  // `planning-finalize` labels that issues already in flight carry.
  //
  // Legacy shape (pre-rename) used `group` for the stage and `stage` for the
  // label. The presence of `group` is the discriminator, and migrating here is
  // what keeps definitions already pinned to live issues resolvable.
  const legacy = !!(s && s.group !== undefined);
  const stage = (legacy ? str(s.group) : str(s && s.stage)) || id;
  const issueLabel = (legacy ? str(s.stage) : str(s && s.issueLabel)) || stage;
  const step = {
    id,
    stage,
    issueLabel,
    label: str(s && s.label) || titleize(id),
    icon: str(s && s.icon) || stage,
    description: str(s && s.description),
    order: index,
    produce: {
      by: str(s && s.produce && s.produce.by, "agent"),
      capability: str(s && s.produce && s.produce.capability, "markdown"),
      contract: str(s && s.produce && s.produce.contract),
      heading: str(s && s.produce && s.produce.heading),
    },
    artifact: { fields: (s && s.artifact && Array.isArray(s.artifact.fields) ? s.artifact.fields : []).map(normalizeField) },
    validate: (Array.isArray(s && s.validate) ? s.validate : []).map(normalizeRule),
    status: {
      working: str(s && s.status && s.status.working) || `${titleize(id)}…`,
      waiting: str(s && s.status && s.status.waiting) || "",
    },
    gate: normalizeGate(s && s.gate),
    next: s && s.next ? str(s.next) : null,
  };
  if (s && s.phase) step.phase = str(s.phase);
  // A repeatable step needs somewhere to keep its round counter. `counter` names
  // the field in the state's round map; the two legacy names stay meaningful so
  // existing labels and read models keep working.
  if (s && s.repeat) {
    step.repeat = { counter: str(s.repeat.counter) || id, label: str(s.repeat.label) || "" };
  }
  return step;
}

export function normalizeDefinition(def) {
  if (!def || typeof def !== "object") throw new Error("workflow definition must be an object");
  const steps = (Array.isArray(def.steps) ? def.steps : []).map(normalizeStep);
  return {
    version: DEFINITION_VERSION,
    id: str(def.id),
    name: str(def.name) || str(def.id) || "Workflow",
    description: str(def.description),
    rev: Number.isFinite(Number(def.rev)) ? Number(def.rev) : 1,
    updatedAt: str(def.updatedAt),
    entry: str(def.entry) || (steps[0] ? steps[0].id : ""),
    steps,
  };
}

// ─── validation ──────────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function validateDefinition(input) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });
  let def;
  try {
    def = normalizeDefinition(input);
  } catch (e) {
    return { ok: false, errors: [{ path: "", message: String(e.message || e) }] };
  }

  if (!ID_RE.test(def.id)) push("id", "id must be lowercase letters, digits and hyphens");
  if (!def.name.trim()) push("name", "name is required");
  if (!def.steps.length) push("steps", "a workflow needs at least one step");

  const byId = new Map();
  for (const [i, s] of def.steps.entries()) {
    const p = `steps[${i}]`;
    if (!ID_RE.test(s.id)) push(`${p}.id`, "step id must be lowercase letters, digits and hyphens");
    if (byId.has(s.id)) push(`${p}.id`, `duplicate step id ${s.id}`);
    byId.set(s.id, s);

    if (!PRODUCERS.includes(s.produce.by)) push(`${p}.produce.by`, `unknown producer ${s.produce.by}`);
    if (!CAPABILITY_NAMES.includes(s.produce.capability)) push(`${p}.produce.capability`, `unknown capability ${s.produce.capability}`);
    if (s.produce.by === "agent" && !s.produce.contract.trim()) push(`${p}.produce.contract`, "an agent step needs a contract");

    for (const [j, f] of s.artifact.fields.entries()) {
      if (!f.name) push(`${p}.artifact.fields[${j}].name`, "field name is required");
      if (!FIELD_TYPE_NAMES.includes(f.type)) push(`${p}.artifact.fields[${j}].type`, `unknown field type ${f.type}`);
    }

    for (const [j, r] of s.validate.entries()) {
      const rp = `${p}.validate[${j}]`;
      if (!RULES[r.rule]) { push(`${rp}.rule`, `unknown validation rule ${r.rule}`); continue; }
      for (const need of RULE_OPERANDS[r.rule]) {
        if (r[need] === undefined || r[need] === "") push(`${rp}.${need}`, `rule ${r.rule} requires ${need}`);
      }
    }

    if (s.gate) {
      const gp = `${p}.gate`;
      if (!ID_RE.test(s.gate.id)) push(`${gp}.id`, "gate id must be lowercase letters, digits and hyphens");
      if (!s.gate.actions.length) push(`${gp}.actions`, "a gate needs at least one action");
      const seenActions = new Set();
      for (const [j, w] of s.gate.widgets.entries()) {
        if (!GATE_WIDGETS[w.type]) { push(`${gp}.widgets[${j}].type`, `unknown gate widget ${w.type}`); continue; }
        for (const need of GATE_WIDGETS[w.type].needs) {
          if (w[need] === undefined || w[need] === "") push(`${gp}.widgets[${j}].${need}`, `widget ${w.type} requires ${need}`);
        }
      }
      for (const [j, a] of s.gate.actions.entries()) {
        const ap = `${gp}.actions[${j}]`;
        if (!ID_RE.test(a.id)) push(`${ap}.id`, "action id must be lowercase letters, digits and hyphens");
        if (seenActions.has(a.id)) push(`${ap}.id`, `duplicate action id ${a.id}`);
        seenActions.add(a.id);
        const outcome = parseOutcome(a.outcome);
        if (!outcome) push(`${ap}.outcome`, `unknown outcome ${a.outcome}`);
        else if (outcome.kind === "repeat" && !s.repeat) push(`${ap}.outcome`, "repeat needs the step to declare `repeat`");
      }
    }
  }

  if (def.entry && !byId.has(def.entry)) push("entry", `entry step ${def.entry} does not exist`);

  // Referential integrity. A dangling `next` or `goto` is the failure mode that
  // would otherwise strand a live build with no way forward, so it is rejected
  // at author time rather than discovered mid-run.
  for (const [i, s] of def.steps.entries()) {
    if (s.next && !byId.has(s.next)) push(`steps[${i}].next`, `next step ${s.next} does not exist`);
    for (const [j, a] of (s.gate ? s.gate.actions : []).entries()) {
      const outcome = parseOutcome(a.outcome);
      if (outcome && outcome.kind === "goto" && !byId.has(outcome.target)) {
        push(`steps[${i}].gate.actions[${j}].outcome`, `goto target ${outcome.target} does not exist`);
      }
      if (outcome && outcome.kind === "advance" && !s.next) {
        push(`steps[${i}].gate.actions[${j}].outcome`, "advance needs the step to declare `next`");
      }
    }
  }

  const terminals = def.steps.filter((s) => !s.next && (!s.gate || !s.gate.actions.length));
  if (!terminals.length) push("steps", "no terminal step: the workflow can never finish");

  // Unreachable steps are not fatal to a run, but they are always an authoring
  // mistake, and silently keeping them makes the stepper lie about the pipeline.
  const reachable = new Set();
  const walk = (id) => {
    if (!id || reachable.has(id) || !byId.has(id)) return;
    reachable.add(id);
    const s = byId.get(id);
    walk(s.next);
    for (const a of s.gate ? s.gate.actions : []) {
      const o = parseOutcome(a.outcome);
      if (o && o.kind === "goto") walk(o.target);
    }
  };
  walk(def.entry);
  for (const [i, s] of def.steps.entries()) {
    if (!reachable.has(s.id)) push(`steps[${i}].id`, `step ${s.id} is unreachable from ${def.entry}`);
  }

  return { ok: errors.length === 0, errors, definition: def };
}

export function assertValidDefinition(def) {
  const { ok, errors, definition } = validateDefinition(def);
  if (!ok) throw new Error(`invalid workflow definition: ${errors.map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ")}`);
  return definition;
}

// ─── hashing ─────────────────────────────────────────────────────────────────

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (k === "updatedAt") continue; // a re-save with no edits must not change the hash
      out[k] = canonical(value[k]);
    }
    return out;
  }
  return value;
}

export function canonicalize(def) {
  return JSON.stringify(canonical(normalizeDefinition(def)));
}

// The hash is what the issue's control block stores, so a snapshot comment that
// was edited by hand stops being trusted.
export function hashDefinition(def) {
  return "sha256:" + createHash("sha256").update(canonicalize(def)).digest("hex");
}

// ─── lookups used by the coordinator and the webview ─────────────────────────

export function stepById(def, id) {
  return (def.steps || []).find((s) => s.id === id) || null;
}

// Resolves the live control block's `stage` -- which is an issueLabel, not a
// stage -- back to the step that wrote it.
export function stepForIssueLabel(def, issueLabel, gate) {
  const steps = (def.steps || []).filter((s) => s.issueLabel === issueLabel);
  if (gate) {
    const gated = steps.find((s) => s.gate && s.gate.id === gate);
    if (gated) return gated;
  }
  return steps[0] || null;
}

// A stage is a run of steps, so the stepper shows stages: the three planning
// steps are one "Plan" node.
export function stagesOf(def) {
  const seen = new Map();
  for (const s of def.steps || []) {
    if (!seen.has(s.stage)) seen.set(s.stage, { key: s.stage, label: s.label, icon: s.icon, steps: [] });
    seen.get(s.stage).steps.push(s.id);
  }
  return [...seen.values()];
}

export function labelDefinitions(def) {
  // Declares the labels actually written to the issue, so it reads issueLabel.
  const stages = [...new Set((def.steps || []).map((s) => s.issueLabel))];
  const gates = [...new Set((def.steps || []).filter((s) => s.gate).map((s) => s.gate.id))];
  return [
    { name: "agent-loop", color: "5319e7", description: "Managed by the Agent Loop canvas" },
    ...stages.map((s) => ({ name: `stage:${s}`, color: "0e8a16", description: `Agent Loop stage ${s}` })),
    ...gates.map((g) => ({ name: `gate:${g}`, color: "fbca04", description: `Agent Loop human gate ${g}` })),
    // The default pipeline is the absence of this label, so it is never declared.
    ...(def.id && def.id !== "default"
      ? [{ name: `workflow:${def.id}`, color: "1d76db", description: `Agent Loop workflow ${def.name || def.id}` }]
      : []),
  ];
}

// ─── the built-in default ────────────────────────────────────────────────────

// This is today's pipeline, expressed in the DSL. Every contract string, status
// text and transition is reproduced exactly; test/golden.test.mjs is what proves
// it, and it must stay that way — this definition is the compatibility contract
// for every build that already exists.
export const LEGACY_DEFAULT = normalizeDefinition({
  id: "default",
  name: "Default build loop",
  description: "Research, prototype, plan, implement, finalize — the loop the canvas shipped with.",
  rev: 1,
  entry: "research",
  steps: [
    {
      id: "research",
      stage: "research", issueLabel: "research", label: "Research", icon: "research",
      description: "Survey prior art and recommend a direction.",
      produce: {
        by: "agent", capability: "markdown", heading: "🔎 Research",
        contract: "Return artifact { body: markdown research brief }. Include prior art, tradeoffs, and recommended direction.",
      },
      artifact: { fields: [{ name: "body", type: "markdown" }] },
      validate: [{ rule: "minLength", field: "body", value: 10, message: "research artifact body is required" }],
      status: { working: "Researching prior art…" },
      next: "prototype",
    },
    {
      id: "prototype",
      stage: "prototype", issueLabel: "prototype", label: "Prototype", icon: "prototype",
      description: "Build two or three self-contained HTML directions to choose between.",
      produce: {
        by: "agent", capability: "prototype-files", heading: "🧪 Prototypes",
        contract: "Write 2-3 self-contained HTML prototypes. IDs must be unique. Exact paths are {{protoBase}}/<id>/index.html under {{protoDir}}. Return artifact { options:[{id,title,pitch,path}] } where each path equals the code-derived path.",
      },
      artifact: { fields: [{ name: "options", type: "file-set", of: "object" }] },
      validate: [
        { rule: "minItems", field: "options", value: 1, message: "prototype options are required" },
        { rule: "uniqueField", field: "options", key: "id", message: "prototype option ids must be unique" },
        { rule: "pathMatches", field: "options", template: "{{protoBase}}/{{id}}/index.html" },
        { rule: "fileExists", field: "options" },
      ],
      repeat: { counter: "round", label: "Prototype round" },
      status: { working: "Building prototype options…", waiting: "Waiting for your sign-off." },
      gate: {
        id: "signoff", title: "Choose a direction",
        widgets: [
          { type: "option-picker", source: "options" },
          { type: "textarea", id: "notes", label: "Notes", placeholder: "What do you want changed?" },
        ],
        actions: [
          { id: "approve", label: "Approve", style: "primary", outcome: "advance" },
          { id: "iterate", label: "Request another round", style: "secondary", outcome: "repeat" },
        ],
      },
      next: "plan-questions",
    },
    {
      id: "plan-questions",
      stage: "plan", issueLabel: "planning", label: "Plan", icon: "plan",
      description: "Ask the clarifying questions the plan depends on.",
      produce: {
        by: "agent", capability: "questionnaire", heading: "📋 Questionnaire",
        contract: "Return artifact { body } containing ## 📋 Questionnaire with **qN.** questions and optional single/multi choices.",
      },
      artifact: { fields: [{ name: "body", type: "markdown" }] },
      validate: [{ rule: "questionnaireParses", field: "body" }],
      status: { working: "Drafting clarifying questions…", waiting: "Waiting for your answers." },
      gate: {
        id: "questionnaire", title: "Answer the questions",
        widgets: [{ type: "question-form", source: "questionnaire" }],
        actions: [{ id: "answers", label: "Submit answers", style: "primary", outcome: "advance", status: "Drafting the plan…" }],
      },
      next: "plan",
    },
    {
      id: "plan",
      stage: "plan", issueLabel: "planning-finalize", label: "Plan", icon: "plan",
      description: "Draft the implementation plan as pinnable clauses.",
      produce: {
        by: "agent", capability: "plan-clauses", heading: "📝 Draft plan",
        contract: "Return artifact { body: markdown implementation plan }. Do not mutate workflow state.",
      },
      artifact: { fields: [{ name: "body", type: "markdown" }, { name: "clauses", type: "list", of: "object", required: false }] },
      validate: [{ rule: "minLength", field: "body", value: 10, message: "plan artifact body is required" }],
      status: { working: "Drafting the plan…" },
      next: "plan-panel",
    },
    {
      id: "plan-panel",
      stage: "plan", issueLabel: "planning", label: "Plan review", icon: "plan",
      description: "A second model reviews the draft before you approve it.",
      produce: {
        by: "panel", capability: "none",
        contract: "Do not write or edit the plan. Invoke the canvas action `resume_panel` with {\"owner\":\"{{owner}}\",\"repo\":\"{{repo}}\",\"issue\":{{issue}}} and let it finish; it runs the review and records the result itself.",
      },
      artifact: { fields: [] },
      validate: [],
      status: { working: "Reviewing the plan with {{reviewerModel}}…", waiting: "Waiting for your plan approval." },
      gate: {
        id: "plan-review", title: "Approve the plan",
        widgets: [{ type: "clause-pins", source: "plan" }, { type: "textarea", id: "notes", label: "Notes" }],
        actions: [
          { id: "plan-ok", label: "Approve plan", style: "primary", outcome: "advance", status: "Building the change…" },
          { id: "plan-steer", label: "Pin and re-synthesize", style: "secondary", outcome: "panel-retry" },
          { id: "plan-revise", label: "Send back for revision", style: "secondary", outcome: "goto:plan", status: "Revising the plan…" },
          { id: "plan-retry-review", label: "Retry review", style: "ghost", outcome: "panel-retry" },
        ],
      },
      next: "implement",
    },
    {
      id: "implement",
      stage: "implement", issueLabel: "implementing", label: "Implement", icon: "implement",
      description: "Open or update the pull request that delivers the plan.",
      produce: {
        by: "agent", capability: "implement-pr", heading: "🚀 Build ready",
        contract: "Use deterministic branch {{branch}} targeting base {{base}}. Create/update one open PR with title \"{{prTitle}}\". For web previews, write the demo to the exact code-stamped path {{implDemoPath}}; do not choose another path. Return artifact { summary, preview:{kind:'web'|'command'|'none', run?, notes?} }.",
      },
      artifact: {
        fields: [
          { name: "summary", type: "markdown" },
          { name: "preview", type: "object", required: false },
        ],
      },
      validate: [{ rule: "prOpen" }, { rule: "prBranchMatches" }],
      repeat: { counter: "implRound", label: "Implementation round" },
      status: { working: "Building the change…", waiting: "Waiting for your review of the PR." },
      gate: {
        id: "feedback", title: "Review the pull request",
        widgets: [{ type: "pr-review" }, { type: "textarea", id: "notes", label: "Notes" }],
        actions: [
          { id: "ship", label: "Ship it", style: "primary", outcome: "advance", status: "Finalizing the PR…" },
          { id: "revise", label: "Request changes", style: "secondary", outcome: "repeat" },
        ],
      },
      next: "finalize",
    },
    {
      id: "finalize",
      stage: "finalize", issueLabel: "finalizing", label: "Audit", icon: "finalize",
      description: "Final PR readiness check: mark it ready and confirm it can merge (not a formal compliance audit).",
      produce: {
        by: "agent", capability: "finalize-pr", heading: "✅ Finalized",
        contract: "Finalize the existing PR on branch {{branch}}; mark it ready if draft. Return artifact { body: markdown finalization summary }.",
      },
      artifact: { fields: [{ name: "body", type: "markdown", required: false }] },
      validate: [{ rule: "prOpen" }, { rule: "prBranchMatches" }, { rule: "prNotDraft" }],
      status: { working: "Finalizing the PR…" },
      next: "done",
    },
    {
      id: "done",
      stage: "done", issueLabel: "done", label: "Done", icon: "done",
      description: "The pull request is ready to merge.",
      produce: { by: "none", capability: "none", contract: "" },
      artifact: { fields: [] },
      validate: [],
      status: { working: "Done." },
      next: null,
    },
  ],
});

// New runs use separate review and synthesis stages. Runs created before this
// revision retain LEGACY_DEFAULT via their absent pipelineVersion field.
const newSteps = LEGACY_DEFAULT.steps.map((step) => {
  if (step.id === "plan") return { ...step, next: "review" };
  if (step.id === "plan-panel") return null;
  return step;
}).filter(Boolean);
const reviewIndex = newSteps.findIndex((step) => step.id === "implement");
newSteps.splice(reviewIndex, 0,
  {
    id: "review", stage: "review", issueLabel: "review", label: "Review", icon: "plan",
    description: "Independent alternate-family review, followed by point-by-point decisions.",
    produce: { by: "panel", capability: "none", contract: "Review the draft plan independently." },
    artifact: { fields: [] }, validate: [],
    status: { working: "Reviewing the draft independently…", waiting: "Decide each review point." },
    gate: {
      id: "review-points", title: "Review recommendations",
      widgets: [{ type: "markdown-view", source: "review" }],
      actions: [{ id: "review-continue", label: "Synthesize decisions", style: "primary", outcome: "advance" }],
    },
    next: "synthesis",
  },
  {
    id: "synthesis", stage: "synthesis", issueLabel: "synthesis", label: "Synthesis", icon: "plan",
    description: "Apply decided review points and show the final plan.",
    produce: { by: "panel", capability: "none", contract: "Apply accepted and modified review points to the draft." },
    artifact: { fields: [] }, validate: [],
    status: { working: "Synthesizing the final plan…", waiting: "Approve the final plan." },
    gate: {
      id: "plan-review", title: "Approve final plan",
      widgets: [{ type: "clause-pins", source: "plan" }],
      actions: [
        { id: "plan-ok", label: "Approve plan", style: "primary", outcome: "advance" },
        { id: "plan-steer", label: "Re-synthesize clauses", style: "secondary", outcome: "panel-retry" },
        { id: "plan-revise", label: "Request changes", style: "secondary", outcome: "goto:plan" },
      ],
    },
    next: "implement",
  },
);
export const BUILTIN_DEFAULT = normalizeDefinition({
  ...LEGACY_DEFAULT,
  rev: 2,
  description: "Research, prototype, plan, independent review, point decisions, synthesis, implement, finalize.",
  steps: newSteps,
});

// New runs group existing steps under phases. Earlier definitions remain
// unchanged so their issue labels, hashes, and in-flight gates stay intact.
const phasedSteps = LEGACY_DEFAULT.steps
  .filter((step) => !["plan-panel", "done"].includes(step.id))
  .map((step) => {
    const phase = ["research", "prototype", "plan-questions", "plan"].includes(step.id) ? "Plan"
      : step.id === "implement" ? "Build" : "Audit";
    const stage = step.id === "plan-questions" || step.id === "plan" ? "draft"
      : step.id === "implement" ? "build" : step.id;
    return { ...step, phase, stage, label: stage === "draft" ? "Draft" : step.label,
      ...(step.id === "plan" ? { next: "synthesis" }
        : step.id === "implement" ? { next: "council", gate: null } : {}) };
  });
const synthesis = {
  ...newSteps.find((step) => step.id === "synthesis"),
  phase: "Plan", stage: "synthesize", label: "Synthesize",
  description: "Independent alternate-family review and automatic synthesis, then human approval.",
};
const council = {
  id: "council", phase: "Review", stage: "council", issueLabel: "council",
  label: "Council", icon: "plan",
  description: "Independent code quality, security, coverage, and lint review of the PR head.",
  produce: { by: "panel", capability: "none", contract: "Review the exact implementation PR head." },
  artifact: { fields: [] }, validate: [],
  status: { working: "Reviewing the implementation…", waiting: "Code review failed; retry required." },
  next: "feedback",
};
const feedback = {
  id: "feedback", phase: "Review", stage: "feedback", issueLabel: "feedback",
  label: "Feedback", icon: "implement",
  description: "Review Council findings, select AI fixes, or approve the PR.",
  produce: { by: "none", capability: "none", contract: "" },
  artifact: { fields: [] }, validate: [],
  status: { working: "Checking Council findings…", waiting: "Review findings and choose fixes." },
  gate: { ...LEGACY_DEFAULT.steps.find((step) => step.id === "implement").gate,
    actions: [
      { id: "ship", label: "Ship it", style: "primary", outcome: "advance" },
      { id: "ai-fix", label: "AI fix selected", style: "secondary", outcome: "goto:implement" },
      { id: "revise", label: "Request changes", style: "secondary", outcome: "goto:implement" },
    ] },
  next: "finalize",
};
phasedSteps.splice(phasedSteps.findIndex((step) => step.id === "implement"), 0, synthesis);
phasedSteps.splice(phasedSteps.findIndex((step) => step.id === "finalize"), 0, council, feedback);
phasedSteps.push({ ...LEGACY_DEFAULT.steps.find((step) => step.id === "done"), phase: "Done" });
export const PHASED_DEFAULT = normalizeDefinition({
  ...LEGACY_DEFAULT, rev: 3,
  description: "Plan (research, prototype, draft, synthesize), Build, Review (council, feedback), Audit (PR readiness check), Done.",
  steps: phasedSteps,
});
