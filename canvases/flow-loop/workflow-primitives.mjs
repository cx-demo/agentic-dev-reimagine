// Workflow primitive registries.
//
// A workflow definition is data, never code: it can only reference primitives by
// name, and every name it can reference lives here. That is what makes a
// user-authored workflow safe to execute — the worst a bad definition can do is
// name a primitive that does not exist, which validation rejects up front.
//
// Three registries:
//   FIELD_TYPES  — what an artifact field may be
//   RULES        — how a submitted artifact is checked
//   GATE_WIDGETS — what a human gate may render
//
// RULES is the security-relevant one. `fileExists` and the `pr*` rules are the
// checks that used to be hardcoded per stage in workflow.mjs; they are ported
// verbatim rather than reimplemented, because they are what stop an agent from
// claiming work it did not do.

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

// ─── field types ─────────────────────────────────────────────────────────────

export const FIELD_TYPES = {
  markdown: { describe: () => "markdown string" },
  text: { describe: () => "string" },
  number: { describe: () => "number" },
  enum: { describe: (f) => `one of ${(f.values || []).join("|")}` },
  object: { describe: () => "object" },
  list: { describe: (f) => `array of ${f.of || "any"}` },
  "file-set": { describe: () => "array of { id, path } written under the work root" },
  "pr-ref": { describe: () => "pull request reference resolved from the deterministic branch" },
};

export const FIELD_TYPE_NAMES = Object.keys(FIELD_TYPES);

// Renders the `{ a, b }` shorthand the work order shows an agent. Generated from
// the declared fields so a custom stage's contract cannot drift from what the
// validator will actually accept.
export function describeArtifact(fields) {
  const parts = (fields || []).map((f) => {
    const opt = f.required === false ? "?" : "";
    return `${f.name}${opt}: ${FIELD_TYPES[f.type] ? FIELD_TYPES[f.type].describe(f) : "any"}`;
  });
  return parts.length ? `{ ${parts.join(", ")} }` : "{ }";
}

// ─── path safety (shared by fileExists and any future path rule) ─────────────

function normalizeRel(p) {
  return String(p || "").replace(/[\\/]+/g, sep);
}

// Ported unchanged from workflow.mjs. Every guard here exists because a path
// arrives from an agent: traversal, absolute Windows paths, and symlinks that
// point out of the issue's own directory are all rejected before the read.
export async function safeHashFile(workRoot, owner, repo, issue, relPath) {
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

// ─── rules ───────────────────────────────────────────────────────────────────

function at(artifact, field) {
  if (!field) return artifact;
  return String(field).split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), artifact);
}

function fail(rule, message) {
  throw new Error(rule.message ? String(rule.message) : message);
}

// Each rule receives the resolution context the coordinator builds for the
// submission: identifiers, the live state, and the code-derived values a
// definition is not allowed to compute for itself.
export const RULES = {
  required: {
    needs: ["field"],
    async run(ctx, rule, artifact) {
      const v = at(artifact, rule.field);
      if (v === undefined || v === null || v === "") fail(rule, `${rule.field} is required`);
    },
  },
  minLength: {
    needs: ["field", "value"],
    async run(ctx, rule, artifact) {
      const v = String(at(artifact, rule.field) ?? "").trim();
      if (v.length < Number(rule.value)) fail(rule, `${rule.field} is required`);
    },
  },
  minItems: {
    needs: ["field", "value"],
    async run(ctx, rule, artifact) {
      const v = at(artifact, rule.field);
      if (!Array.isArray(v) || v.length < Number(rule.value)) fail(rule, `${rule.field} requires at least ${rule.value} item(s)`);
    },
  },
  uniqueField: {
    needs: ["field", "key"],
    async run(ctx, rule, artifact) {
      const list = at(artifact, rule.field);
      if (!Array.isArray(list)) return;
      const seen = new Set();
      for (const item of list) {
        const k = String((item && item[rule.key]) ?? "");
        if (!k) fail(rule, `${rule.field} item ${rule.key} required`);
        if (seen.has(k)) fail(rule, `${rule.field} item ${rule.key}s must be unique`);
        seen.add(k);
      }
    },
  },
  // The path an agent reports must equal the path the coordinator derived. This
  // is the rule that stops an agent from pointing the preview at a file it chose.
  pathMatches: {
    needs: ["field", "template"],
    async run(ctx, rule, artifact) {
      const list = at(artifact, rule.field);
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const id = String((item && item.id) || "").replace(/[^A-Za-z0-9_-]/g, "");
        const path = String((item && item.path) || "");
        if (!id || !path) fail(rule, `${rule.field} item id/path required`);
        const expected = ctx.expand(rule.template, { id });
        if (path !== expected) fail(rule, `${rule.field.replace(/s$/, "")} path must be ${expected}`);
      }
    },
  },
  fileExists: {
    needs: ["field"],
    async run(ctx, rule, artifact) {
      const target = at(artifact, rule.field);
      const items = Array.isArray(target) ? target : target ? [target] : [];
      for (const item of items) {
        const path = typeof item === "string" ? item : String((item && item.path) || "");
        await ctx.hashFile(path);
      }
    },
  },
  questionnaireParses: {
    needs: ["field"],
    async run(ctx, rule, artifact) {
      const body = String(at(artifact, rule.field) ?? "");
      if (!ctx.parseQuestionnaire(body).length) fail(rule, "questionnaire artifact must contain parsable questions");
    },
  },
  // The PR rules do not read the artifact at all. They re-read the live pull
  // request, because the artifact is the agent's claim and the API is the truth.
  prOpen: { needs: [], async run(ctx) { await ctx.livePr(); } },
  prBranchMatches: { needs: [], async run(ctx) { await ctx.livePr({ branch: true }); } },
  prNotDraft: { needs: [], async run(ctx) { await ctx.livePr({ ready: true }); } },
};

export const RULE_NAMES = Object.keys(RULES);

// Operand metadata the editor UI renders as form fields, so a new rule shows up
// in the builder without the webview learning about it separately.
export const RULE_OPERANDS = Object.fromEntries(
  Object.entries(RULES).map(([name, r]) => [name, r.needs]),
);

export async function runRules(ctx, rules, artifact) {
  for (const rule of rules || []) {
    const impl = RULES[rule.rule];
    if (!impl) throw new Error(`unknown validation rule ${rule.rule}`);
    await impl.run(ctx, rule, artifact);
  }
}

// ─── capabilities ────────────────────────────────────────────────────────────

// How a step turns an accepted artifact into an issue comment. `markdown` is the
// generic one every custom stage uses; the rest carry the bespoke rendering the
// built-in pipeline has always done.
export const CAPABILITIES = {
  markdown: { produces: "comment" },
  "prototype-files": { produces: "comment" },
  questionnaire: { produces: "comment" },
  "plan-clauses": { produces: "comment" },
  "implement-pr": { produces: "comment" },
  "finalize-pr": { produces: "comment" },
  none: { produces: "nothing" },
};

export const CAPABILITY_NAMES = Object.keys(CAPABILITIES);

// ─── gate widgets and outcomes ───────────────────────────────────────────────

export const GATE_WIDGETS = {
  "markdown-view": { label: "Rendered markdown", needs: ["source"] },
  "option-picker": { label: "Prototype option picker", needs: ["source"] },
  "question-form": { label: "Questionnaire form", needs: ["source"] },
  "clause-pins": { label: "Plan clause pinning", needs: ["source"] },
  "pr-review": { label: "Pull request review", needs: [] },
  textarea: { label: "Free-text note", needs: ["id"] },
  checklist: { label: "Checklist", needs: ["id", "items"] },
};

export const GATE_WIDGET_NAMES = Object.keys(GATE_WIDGETS);

export const OUTCOME_KINDS = ["advance", "repeat", "goto", "panel-retry"];

export function parseOutcome(outcome) {
  const raw = String(outcome || "");
  if (raw.startsWith("goto:")) return { kind: "goto", target: raw.slice(5) };
  return OUTCOME_KINDS.includes(raw) ? { kind: raw, target: null } : null;
}

export const PRODUCERS = ["agent", "panel", "none"];
