import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { WORKFLOWS_DIR as WORKFLOWS_DIR_DEFAULT, PINS_DIR } from "./paths.mjs";
import { hashDefinition } from "./workflow-def.mjs";

export const WORKFLOWS_DIR = WORKFLOWS_DIR_DEFAULT;

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

let workflowDefPromise = null;

async function workflowDefApi(opts = {}) {
  if (opts.workflowDef) return opts.workflowDef;
  if (!workflowDefPromise) {
    workflowDefPromise = import("./workflow-def.mjs").catch((e) => {
      workflowDefPromise = null;
      throw e;
    });
  }
  return workflowDefPromise;
}

function validateApi(api) {
  for (const key of ["normalizeDefinition", "validateDefinition"]) {
    if (typeof api[key] !== "function") throw new Error(`workflow-def.mjs must export ${key}()`);
  }
  return api;
}

function rootDir(opts = {}) {
  return opts.dir || WORKFLOWS_DIR;
}

function fileFor(dir, id) {
  if (!ID_RE.test(String(id || ""))) throw new Error(`invalid workflow id: ${id}`);
  return join(dir, `${id}.json`);
}

async function readDiskRev(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return Number.isInteger(parsed?.rev) ? parsed.rev : undefined;
  } catch (e) {
    if (e && e.code === "ENOENT") return undefined;
    return undefined;
  }
}

function validationError(errors) {
  const joined = (errors || []).map((e) => e?.path ? `${e.path}: ${e.message}` : String(e?.message || e)).join("; ");
  return new Error(`Invalid workflow definition: ${joined || "validation failed"}`);
}

async function normalizeAndValidate(def, opts) {
  const { normalizeDefinition, validateDefinition } = validateApi(await workflowDefApi(opts));
  const normalized = normalizeDefinition(def);
  const result = validateDefinition(normalized);
  if (!result || result.ok !== true) throw validationError(result?.errors);
  return normalized;
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${randomBytes(8).toString("hex")}`;
  // The temp+rename sequence prevents readers from observing a half-written JSON file.
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export function slugId(name, existingIds = []) {
  const existing = new Set(existingIds);
  const base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "workflow";
  let id = base;
  for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) throw new Error(`invalid workflow id: ${id}`);
  return id;
}

export async function listWorkflows(opts = {}) {
  const dir = rootDir(opts);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  entries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  if (entries.length === 0) return [];
  const api = validateApi(await workflowDefApi(opts));
  const summaries = [];
  for (const entry of entries) {
    try {
      const raw = await readFile(join(dir, entry.name), "utf8");
      const def = api.normalizeDefinition(JSON.parse(raw));
      const result = api.validateDefinition(def);
      if (!result || result.ok !== true) continue;
      summaries.push({
        id: def.id,
        name: def.name,
        rev: def.rev,
        stageCount: (def.steps || []).length,
        updatedAt: def.updatedAt ?? null,
      });
    } catch {
      // One corrupt user-authored workflow must not make the picker unusable.
    }
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function readWorkflow(id, opts = {}) {
  const dir = rootDir(opts);
  const file = fileFor(dir, id);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
  return normalizeAndValidate(JSON.parse(raw), opts);
}

export async function writeWorkflow(def, opts = {}) {
  const dir = rootDir(opts);
  const { normalizeDefinition } = validateApi(await workflowDefApi(opts));
  const draft = normalizeDefinition({ ...def, rev: Number.isInteger(def?.rev) ? def.rev : 0 });
  const file = fileFor(dir, draft.id);
  const onDiskRev = await readDiskRev(file);
  if (Object.hasOwn(opts, "expectedRev") && opts.expectedRev !== (onDiskRev ?? 0)) {
    throw new Error("Workflow definition changed on disk; reload before saving.");
  }
  const saved = await normalizeAndValidate({
    ...draft,
    rev: (onDiskRev ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  }, opts);
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(file, saved);
  return saved;
}

export async function deleteWorkflow(id, opts = {}) {
  // The default workflow is the fallback for every kickoff, so it must always exist.
  if (id === "default") throw new Error("Cannot delete the default workflow definition.");
  const file = fileFor(rootDir(opts), id);
  try {
    await rm(file);
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
}

// Every id on disk, including definitions that fail validation. Slugging against
// only the *valid* ones would happily hand out an id whose file already exists
// and then overwrite it.
async function existingIds(opts = {}) {
  try {
    const entries = await readdir(rootDir(opts), { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name.slice(0, -5));
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
}

export async function duplicateWorkflow(id, opts = {}) {
  const source = await readWorkflow(id, opts);
  if (!source) throw new Error(`Workflow ${id} does not exist.`);
  const name = opts.name || `${source.name} (copy)`;
  const copy = await writeWorkflow({ ...source, id: slugId(name, await existingIds(opts)), name, rev: 0 }, opts);
  return copy;
}

export async function seedDefaults(opts = {}) {
  const dir = rootDir(opts);
  const file = fileFor(dir, "default");
  const api = validateApi(await workflowDefApi(opts));
  if (!api.PHASED_DEFAULT) throw new Error("workflow-def.mjs must export PHASED_DEFAULT");
  const saved = await normalizeAndValidate(api.PHASED_DEFAULT, opts);
  await mkdir(dir, { recursive: true });
  try {
    // Exclusive create. Seeding must never clobber a default the user has edited,
    // and `wx` makes that a single atomic decision rather than a check-then-write
    // race between two canvases starting at once.
    await writeFile(file, JSON.stringify(saved, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return { seeded: true };
  } catch (e) {
    if (e && e.code === "EEXIST") {
      const existing = JSON.parse(await readFile(file, "utf8"));
      const priorPhased = api.normalizeDefinition({
        ...api.PHASED_DEFAULT,
        description: "Plan (research, prototype, draft, synthesize), Build, Review (council, feedback), Finalize, Done.",
        steps: api.PHASED_DEFAULT.steps.map((step) => step.id === "finalize" ? {
          ...step, phase: "Finalize", label: "Finalize",
          description: "Mark the PR ready and confirm it can merge.",
        } : step),
      });
      if ([api.LEGACY_DEFAULT, api.BUILTIN_DEFAULT, priorPhased].some((def) =>
        def && hashDefinition(existing) === hashDefinition({ ...def, rev: existing.rev }))) {
        const promoted = await normalizeAndValidate({
          ...saved, rev: existing.rev + 1, updatedAt: new Date().toISOString(),
        }, opts);
        await writeJsonAtomic(file, promoted);
        return { seeded: false, migrated: true };
      }
      return { seeded: false };
    }
    throw e;
  }
}

// ─── local definition pins ───────────────────────────────────────────────────
//
// A run's definition is trusted from LOCAL state, never from the issue: the
// issue comment that carries the reference is editable by any collaborator, so
// it is a transport, not an authority. At kickoff the machine writes the exact
// normalized definition it started under to a pin file keyed by owner/repo/issue,
// and resolution reads it back and checks its hash against the reference.

function pinsRoot(opts = {}) {
  return opts.pinsDir || PINS_DIR;
}

// Every path segment that reaches the filesystem is validated against a strict
// allowlist. owner/repo/issue arrive from GitHub, but a compromised or crafted
// reference must not be able to walk out of the pins directory: reject anything
// that is not a plain name (no separators, no "." or ".." segments).
const PIN_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
function pinSegment(value, label) {
  const s = String(value ?? "");
  if (!s || s === "." || s === ".." || !PIN_SEGMENT_RE.test(s)) {
    throw new Error(`invalid ${label} for pin path: ${JSON.stringify(value)}`);
  }
  return s;
}

function pinFile(root, { owner, repo, issue }) {
  return join(root, pinSegment(owner, "owner"), pinSegment(repo, "repo"), `${pinSegment(String(issue), "issue")}.json`);
}

export async function writePin(target, definition, opts = {}) {
  // Store the exact definition the run executes. hashDefinition normalizes before
  // hashing, so a verbatim round-trip keeps the recorded hash stable.
  const normalized = await normalizeAndValidate(definition, opts);
  const file = pinFile(pinsRoot(opts), target);
  await mkdir(dirname(file), { recursive: true });
  await writeJsonAtomic(file, normalized);
  return normalized;
}

export async function readPin(target, opts = {}) {
  const file = pinFile(pinsRoot(opts), target);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    return null;
  }
  try {
    return await normalizeAndValidate(JSON.parse(raw), opts);
  } catch {
    // A corrupt pin is treated as absent: resolution then falls through to the
    // store-by-hash lookup or fails closed, never to the issue's own copy.
    return null;
  }
}

// A definition held in the local workflow store whose hash matches. This is what
// lets a build started on another machine resolve here: the operator has the
// same definition saved, so its steps are known-good local state.
export async function findLocalByHash(hash, opts = {}) {
  if (!hash) return null;
  const dir = rootDir(opts);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
  const api = validateApi(await workflowDefApi(opts));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const def = api.normalizeDefinition(JSON.parse(await readFile(join(dir, entry.name), "utf8")));
      const result = api.validateDefinition(def);
      if (!result || result.ok !== true) continue;
      if (hashDefinition(def) === hash) return def;
    } catch {
      // Skip corrupt or invalid definitions; one bad file must not hide a good match.
    }
  }
  return null;
}
