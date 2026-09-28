// Primitive registry tests.
//
// The registries are the entire safety boundary for user-authored workflows: a
// definition can only name things that live here. The rules that re-read live
// state instead of trusting the artifact are the ones worth the most scrutiny.

import assert from "node:assert";
import { mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIELD_TYPES, FIELD_TYPE_NAMES, describeArtifact,
  RULES, RULE_NAMES, RULE_OPERANDS, runRules, safeHashFile,
  CAPABILITIES, CAPABILITY_NAMES, GATE_WIDGETS, GATE_WIDGET_NAMES,
  OUTCOME_KINDS, parseOutcome, PRODUCERS,
} from "../workflow-primitives.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

const here = dirname(fileURLToPath(import.meta.url));
const workRoot = join(here, "_prim-work");

// The context the coordinator supplies. Every derived value is code-stamped;
// a definition can read these but never compute them.
function ctx(overrides = {}) {
  return {
    owner: "o", repo: "r", issue: 7,
    expand: (tpl, extra = {}) => String(tpl)
      .replace(/\{\{protoBase\}\}/g, "o/r/7/round-1")
      .replace(/\{\{id\}\}/g, extra.id ?? ""),
    hashFile: (path) => safeHashFile(workRoot, "o", "r", 7, path),
    parseQuestionnaire: (body) => (String(body).match(/\*\*q\d+\.\*\*/g) || []),
    livePr: async () => ({ prNumber: 1 }),
    ...overrides,
  };
}

async function rejects(fn, re, message) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, message || "expected a rejection");
  if (re) assert.match(String(threw.message), re);
}

await rm(workRoot, { recursive: true, force: true });
await mkdir(join(workRoot, "o", "r", "7", "round-1", "a"), { recursive: true });
await writeFile(join(workRoot, "o", "r", "7", "round-1", "a", "index.html"), "<!doctype html><h1>a</h1>");

// ─── registries ──────────────────────────────────────────────────────────────

await test("every registry entry is addressable by its exported name list", () => {
  assert.deepEqual(FIELD_TYPE_NAMES, Object.keys(FIELD_TYPES));
  assert.deepEqual(RULE_NAMES, Object.keys(RULES));
  assert.deepEqual(CAPABILITY_NAMES, Object.keys(CAPABILITIES));
  assert.deepEqual(GATE_WIDGET_NAMES, Object.keys(GATE_WIDGETS));
  assert.ok(PRODUCERS.includes("agent") && PRODUCERS.includes("panel") && PRODUCERS.includes("none"));
});

await test("every rule declares its operands so the editor can render them", () => {
  for (const name of RULE_NAMES) {
    assert.ok(Array.isArray(RULE_OPERANDS[name]), `${name} operands`);
    assert.equal(typeof RULES[name].run, "function", `${name} run`);
  }
});

await test("every gate widget declares what it needs", () => {
  for (const name of GATE_WIDGET_NAMES) {
    assert.ok(Array.isArray(GATE_WIDGETS[name].needs), `${name} needs`);
    assert.ok(GATE_WIDGETS[name].label, `${name} label`);
  }
});

await test("describeArtifact renders the shorthand an agent is shown", () => {
  assert.equal(describeArtifact([{ name: "body", type: "markdown" }]), "{ body: markdown string }");
  assert.equal(describeArtifact([{ name: "notes", type: "text", required: false }]), "{ notes?: string }");
  assert.equal(describeArtifact([{ name: "mode", type: "enum", values: ["a", "b"] }]), "{ mode: one of a|b }");
  assert.equal(describeArtifact([]), "{ }");
});

// ─── generic rules ───────────────────────────────────────────────────────────

await test("required rejects absent, null and empty", async () => {
  const rule = [{ rule: "required", field: "body" }];
  await runRules(ctx(), rule, { body: "x" });
  for (const v of [undefined, null, ""]) await rejects(() => runRules(ctx(), rule, { body: v }), /body is required/);
});

await test("minLength trims before measuring", async () => {
  const rule = [{ rule: "minLength", field: "body", value: 10 }];
  await runRules(ctx(), rule, { body: "long enough body" });
  await rejects(() => runRules(ctx(), rule, { body: "   short   " }), /body is required/);
});

await test("rules read dotted field paths", async () => {
  await runRules(ctx(), [{ rule: "required", field: "preview.kind" }], { preview: { kind: "web" } });
  await rejects(() => runRules(ctx(), [{ rule: "required", field: "preview.kind" }], { preview: {} }));
});

await test("minItems requires an array of at least N", async () => {
  const rule = [{ rule: "minItems", field: "options", value: 1 }];
  await runRules(ctx(), rule, { options: [{ id: "a" }] });
  await rejects(() => runRules(ctx(), rule, { options: [] }), /at least 1/);
  await rejects(() => runRules(ctx(), rule, { options: "not an array" }), /at least 1/);
});

await test("uniqueField rejects duplicate and missing keys", async () => {
  const rule = [{ rule: "uniqueField", field: "options", key: "id" }];
  await runRules(ctx(), rule, { options: [{ id: "a" }, { id: "b" }] });
  await rejects(() => runRules(ctx(), rule, { options: [{ id: "a" }, { id: "a" }] }), /must be unique/);
  await rejects(() => runRules(ctx(), rule, { options: [{ id: "" }] }), /required/);
});

await test("a rule message override is used verbatim", async () => {
  await rejects(
    () => runRules(ctx(), [{ rule: "minLength", field: "body", value: 10, message: "research artifact body is required" }], { body: "" }),
    /^research artifact body is required$/,
  );
});

await test("an unknown rule name is refused at run time as well as author time", async () => {
  await rejects(() => runRules(ctx(), [{ rule: "sudo" }], {}), /unknown validation rule sudo/);
});

// ─── path rules: the agent-facing security boundary ──────────────────────────

await test("pathMatches compares against the code-derived path, not the claim", async () => {
  const rule = [{ rule: "pathMatches", field: "options", template: "{{protoBase}}/{{id}}/index.html" }];
  await runRules(ctx(), rule, { options: [{ id: "a", path: "o/r/7/round-1/a/index.html" }] });
  await rejects(
    () => runRules(ctx(), rule, { options: [{ id: "a", path: "o/r/7/round-1/somewhere-else.html" }] }),
    /path must be o\/r\/7\/round-1\/a\/index\.html/,
  );
});

await test("fileExists hashes a real file inside the issue scope", async () => {
  await runRules(ctx(), [{ rule: "fileExists", field: "options" }], { options: [{ path: "o/r/7/round-1/a/index.html" }] });
  const sha = await safeHashFile(workRoot, "o", "r", 7, "o/r/7/round-1/a/index.html");
  assert.match(sha, /^[0-9a-f]{64}$/);
});

await test("fileExists refuses a missing file", async () => {
  await rejects(
    () => runRules(ctx(), [{ rule: "fileExists", field: "options" }], { options: [{ path: "o/r/7/round-1/ghost/index.html" }] }),
    /artifact file missing/,
  );
});

for (const [what, path, re] of [
  ["traversal", "o/r/7/../../../etc/passwd", /escapes issue scope|invalid artifact path/],
  ["a leading ..", "../outside.html", /invalid artifact path/],
  ["another issue's scope", "o/r/8/round-1/a/index.html", /escapes issue scope/],
  ["an empty path", "", /invalid artifact path/],
]) {
  await test(`safeHashFile refuses ${what}`, async () => {
    await rejects(() => safeHashFile(workRoot, "o", "r", 7, path), re);
  });
}

await test("safeHashFile refuses a symlink that escapes the issue scope", async () => {
  const outside = join(workRoot, "outside.html");
  await writeFile(outside, "<!doctype html>escaped");
  const link = join(workRoot, "o", "r", "7", "round-1", "sneaky.html");
  await symlink(outside, link).catch(() => null);
  await rejects(() => safeHashFile(workRoot, "o", "r", 7, "o/r/7/round-1/sneaky.html"), /escapes issue scope/);
});

// ─── live-state rules ────────────────────────────────────────────────────────

await test("questionnaireParses uses the real parser, not a shape guess", async () => {
  const rule = [{ rule: "questionnaireParses", field: "body" }];
  await runRules(ctx(), rule, { body: "**q1.** (single) Framework?" });
  await rejects(() => runRules(ctx(), rule, { body: "no questions here" }), /parsable questions/);
});

await test("the pr rules ignore the artifact and re-read the live pull request", async () => {
  const seen = [];
  const c = ctx({ livePr: async (opts) => { seen.push(opts); return { prNumber: 1 }; } });
  await runRules(c, [{ rule: "prOpen" }, { rule: "prBranchMatches" }, { rule: "prNotDraft" }], { prNumber: 999 });
  assert.deepEqual(seen, [undefined, { branch: true }, { ready: true }]);
});

await test("a failing live pr read fails the rule", async () => {
  const c = ctx({ livePr: async () => { throw new Error("no open PR on branch agent-loop/issue-7"); } });
  await rejects(() => runRules(c, [{ rule: "prOpen" }], {}), /no open PR/);
});

// ─── outcomes ────────────────────────────────────────────────────────────────

await test("parseOutcome accepts only known kinds", () => {
  for (const kind of OUTCOME_KINDS) {
    if (kind === "goto") continue;
    assert.deepEqual(parseOutcome(kind), { kind, target: null });
  }
  assert.deepEqual(parseOutcome("goto:plan"), { kind: "goto", target: "plan" });
  for (const bad of ["", null, undefined, "eval", "goto", "advance()"]) {
    if (bad === "goto") { assert.deepEqual(parseOutcome(bad), { kind: "goto", target: null } ); continue; }
    assert.equal(parseOutcome(bad), null, `${String(bad)} must not parse`);
  }
});

await rm(workRoot, { recursive: true, force: true });
console.log(`\n${passed} primitive assertions passed`);
