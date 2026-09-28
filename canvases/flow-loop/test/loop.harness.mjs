// Shared fake-GitHub loop harness.
//
// Extracted so the behavioural suite and the golden-fixture suite drive the
// coordinator through the exact same seams. The golden suite is what guards the
// configurable-workflow refactor, so it must not exercise a second, subtly
// different fake.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCoordinator } from "../workflow.mjs";
import { LEGACY_DEFAULT } from "../workflow-def.mjs";
import { findControlBlock, findCommentByOpMarker } from "../github.mjs";
import { readPin, writePin, findLocalByHash } from "../workflow-store.mjs";

export class FakeGitHub {
  constructor() {
    this.issue = null;
    this.comments = [];
    this.nextComment = 100;
    this.calls = [];
    this.pull = { number: 1, url: "https://github.com/o/r/pull/1", headRefName: "agent-loop/issue-7", headRefOid: "sha1", baseRefName: "main", state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", statusCheckRollup: [] };
    this.findCommentByOpMarker = findCommentByOpMarker;
  }
  async detectRepo() { this.calls.push("detectRepo"); return { owner: "o", repo: "r", nameWithOwner: "o/r", defaultBranch: "main" }; }
  async ensureLabels(owner, repo, defs) { this.calls.push(["ensureLabels", defs.map((d) => d.name)]); }
  async findIssueByReqId(owner, repo, reqId) {
    this.calls.push(["findIssueByReqId", reqId]);
    if (this.issue && String(this.issue.body).includes(`AL-REQ ${reqId}`)) return this.issue;
    return null;
  }
  async createIssue(owner, repo, { title, body, labels }) {
    this.calls.push(["createIssue", title, labels]);
    this.issue = { number: 7, title, body, html_url: "https://github.com/o/r/issues/7", labels: labels.map((name) => ({ name })) };
    return this.issue;
  }
  async getIssue(owner, repo, issue) { return this.issue; }
  async listComments(owner, repo, issue) { return this.comments.slice(); }
  async createComment(owner, repo, issue, body) {
    const c = { id: this.nextComment++, body };
    this.calls.push(["createComment", body.match(/^## .*/m)?.[0] || "control"]);
    this.comments.push(c);
    return c;
  }
  async updateComment(owner, repo, id, body) {
    this.calls.push(["updateComment", id]);
    const c = this.comments.find((x) => String(x.id) === String(id));
    if (!c) throw new Error("comment not found");
    c.body = body;
    return c;
  }
  async reconcileWorkflowLabels(owner, repo, issue, desired) {
    this.calls.push(["reconcileWorkflowLabels", desired]);
    const non = (this.issue.labels || []).map((l) => typeof l === "string" ? l : l.name).filter((l) => !/^(agent-loop|stage:|gate:|proto-round:|impl-round:)/.test(l));
    this.issue.labels = [...non, ...desired].map((name) => ({ name }));
  }
  async findPullForBranch(owner, repo, branch) { this.calls.push(["findPullForBranch", branch]); return { ...this.pull }; }
  async getPullValidation(owner, repo, number) { this.calls.push(["getPullValidation", number]); return { ...this.pull, number }; }
  async getRequiredCheckContexts() { this.calls.push("getRequiredCheckContexts"); return { state: "absent", contexts: [] }; }
}

export function stateOf(fake) { return findControlBlock(fake.comments).data; }
export function controlId(fake) { return findControlBlock(fake.comments).commentId; }

// The last work order the coordinator emitted, with the capability fields the
// caller needs to answer it.
export function order(prompts, n = prompts.length - 1) {
  const prompt = prompts[n].prompt;
  return {
    prompt,
    opId: (prompt.match(/"opId":\s*"([^"]+)"/) || [])[1],
    token: (prompt.match(/"submissionToken":\s*"([^"]+)"/) || [])[1],
  };
}

// The definition trust anchor for a given work root, backed by the REAL store so
// tests exercise the same pin/lookup logic production runs. Kept under the test's
// own work root so nothing ever touches the user's ~/.agent-loop.
export function pinPaths(workRoot) {
  return { pinsDir: join(workRoot, "_pins"), storeDir: join(workRoot, "_workflows") };
}

export function makePins(workRoot) {
  const { pinsDir, storeDir } = pinPaths(workRoot);
  return {
    readPin: (target) => readPin(target, { pinsDir, dir: storeDir }),
    writePin: (target, def) => writePin(target, def, { pinsDir, dir: storeDir }),
    findLocalByHash: (hash) => findLocalByHash(hash, { dir: storeDir }),
  };
}

export function intent(fake, kind, data = {}) {
  const s = stateOf(fake);
  return { kind, expectedTxn: s.txn, owner: "o", repo: "r", issue: 7, controlCommentId: controlId(fake), data };
}

export async function writeProto(workRoot, rel) {
  const full = join(workRoot, ...rel.split("/"));
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, "<!doctype html><h1>prototype</h1>");
}

export function makeLoop(workRoot, extraDeps = {}) {
  const fake = new FakeGitHub();
  const prompts = [];
  let active = null;
  const coordinator = createCoordinator({
    github: fake,
    workRoot,
    assetBase: "http://127.0.0.1:9999",
    instanceId: "inst-1",
    definition: LEGACY_DEFAULT,
    pins: makePins(workRoot),
    sendPrompt: async (prompt, kind) => { prompts.push({ prompt, kind }); },
    setActive: async (owner, repo, issue) => { active = { owner, repo, issue }; },
    readActive: async () => active,
    refresh: async () => {},
    ...extraDeps,
  });
  return { fake, prompts, coordinator, active: () => active };
}

export function makeCoordinator(fake, prompts, activeRef, workRoot, extraDeps = {}) {
  return createCoordinator({
    github: fake,
    workRoot,
    assetBase: "http://127.0.0.1:9999",
    instanceId: "inst-1",
    definition: LEGACY_DEFAULT,
    pins: makePins(workRoot),
    sendPrompt: async (prompt, kind) => { prompts.push({ prompt, kind }); },
    setActive: async (owner, repo, issue) => { activeRef.value = { owner, repo, issue }; },
    readActive: async () => activeRef.value,
    refresh: async () => {},
    ...extraDeps,
  });
}

export async function seedState(fake, state) {
  if (!fake.issue) fake.issue = { number: 7, title: "Seed", body: "Seed", html_url: "https://github.com/o/r/issues/7", labels: [] };
  const existing = findControlBlock(fake.comments);
  const body = `<!-- AGENT-LOOP-STATE v1 -->\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``;
  if (existing) fake.comments.find((c) => c.id === existing.commentId).body = body;
  else await fake.createComment("o", "r", 7, body);
}
