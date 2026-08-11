// Clause-structured plans.
//
// The plan artifact is a list of clauses with stable ids. Markdown is RENDERED
// from those clauses and parsed back, so a clause the human pinned can be
// reproduced byte for byte across a re-synthesis.
//
// Anchors deliberately use the `alc:` prefix. `safeBody` in workflow.mjs
// neutralises the workflow marker prefix by injecting a zero-width space, so an
// anchor built on that prefix would be corrupted the moment it was rendered.

import { createHash } from "node:crypto";

export const CLAUSE_ID_RE = /^c[1-9]\d*$/;

const ANCHOR = /^<!--\s*alc:(c[1-9]\d*)\s*-->\s*$/;
const HEADING = /^###\s+(?:\d+\.\s+)?(.*)$/;

export function hashClause(text) {
  return "sha256:" + createHash("sha256").update(String(text == null ? "" : text), "utf8").digest("hex");
}

function assertId(id) {
  if (!CLAUSE_ID_RE.test(String(id || ""))) throw new Error(`invalid clause id ${JSON.stringify(id)}`);
}

// Normalise to exactly the shape that survives a render/parse round trip.
export function normalizeClauses(clauses) {
  if (!Array.isArray(clauses) || !clauses.length) throw new Error("clauses are required");
  const seen = new Set();
  return clauses.map((c) => {
    const id = String((c && c.id) || "");
    assertId(id);
    if (seen.has(id)) throw new Error(`duplicate clause id ${id}`);
    seen.add(id);
    const title = String((c && c.title) || "").trim();
    const text = String((c && c.text) || "").trim();
    if (!title) throw new Error(`clause ${id} is missing a title`);
    if (!text) throw new Error(`clause ${id} is missing text`);
    if (/\r/.test(title + text)) throw new Error(`clause ${id} must not contain carriage returns`);
    if (ANCHOR.test(title) || title.startsWith("###")) throw new Error(`clause ${id} title must be prose`);
    return { id, title, text };
  });
}

export function renderClauses(clauses) {
  const list = normalizeClauses(clauses);
  return list
    .map((c, i) => `<!-- alc:${c.id} -->\n### ${i + 1}. ${c.title}\n\n${c.text}`)
    .join("\n\n");
}

// Inverse of renderClauses. Content before the first anchor is ignored so a
// human-authored preamble in the plan comment can never be mistaken for a clause.
//
// Workflow markers are stripped: a clause parsed out of a REAL issue comment
// would otherwise absorb the trailing `AL-OUT` marker into the last clause's
// text, which then gets re-rendered and mangled by the workflow sanitizer.
const WORKFLOW_MARKER = /^\s*<!--\s*AL\u200b?-/;

export function parseClauses(body) {
  const lines = String(body == null ? "" : body).split("\n");
  const out = [];
  let cur = null;
  let buf = [];
  const flush = () => {
    if (!cur) return;
    let rest = buf;
    let title = cur.title;
    if (title == null) {
      let i = 0;
      while (i < rest.length && !rest[i].trim()) i += 1;
      const hm = i < rest.length ? rest[i].match(HEADING) : null;
      if (!hm) throw new Error(`clause ${cur.id} is missing its heading`);
      title = hm[1].trim();
      rest = rest.slice(i + 1);
    }
    out.push({ id: cur.id, title, text: rest.join("\n").trim() });
    cur = null;
    buf = [];
  };
  for (const line of lines) {
    const am = line.match(ANCHOR);
    if (am) { flush(); cur = { id: am[1], title: null }; buf = []; continue; }
    if (WORKFLOW_MARKER.test(line)) continue;
    if (cur) buf.push(line);
  }
  flush();
  // A body with no clause anchors is a legacy plain-markdown plan, not an error:
  // parsing is a read operation and readers must degrade, not throw.
  return out.length ? normalizeClauses(out) : [];
}

export function indexClauses(clauses, prev = []) {
  const before = new Map(prev.map((c) => [c.id, c]));
  const list = Array.isArray(clauses) && clauses.length ? normalizeClauses(clauses) : [];
  return list.map((c) => {
    const was = before.get(c.id);
    return {
      id: c.id,
      hash: hashClause(c.text),
      status: (was && was.status) || "open",
      instruction: (was && was.instruction) || null,
      quotes: (was && Array.isArray(was.quotes) ? was.quotes : []),
    };
  });
}

// Mint an id that has never been used on this issue. Ids are never recycled, so
// a quote or decision recorded against `c3` can never silently rebind to a
// different clause after a drop.
export function nextClauseId(usedIds) {
  let max = 0;
  for (const id of usedIds || []) {
    const m = String(id).match(/^c([1-9]\d*)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "c" + (max + 1);
}

// Fail closed when the stored plan drifted from the index it was recorded with.
export function verifyPinned(index, clauses) {
  const byId = new Map(normalizeClauses(clauses).map((c) => [c.id, c]));
  for (const entry of index || []) {
    if (entry.status !== "pinned") continue;
    const live = byId.get(entry.id);
    if (!live) throw new Error(`pinned clause ${entry.id} is missing from the plan`);
    if (entry.hash && hashClause(live.text) !== entry.hash) {
      throw new Error(`pinned clause ${entry.id} does not match its recorded hash`);
    }
  }
  return true;
}

// The pinning guarantee.
//
// Whatever synthesis returns, a pinned clause is replaced by its verbatim prior
// text. Only sent-back and untouched clauses may change; dropped clauses are
// removed. Clauses synthesis invents are appended with freshly minted ids so it
// can never overwrite an existing one by reusing its id.
export function spliceSynthesis({ prev, next, decisions = [], index = [], usedIds = [] }) {
  const before = normalizeClauses(prev);
  // An empty proposal is legitimate: synthesis may have nothing to change when
  // every clause is pinned. Only a malformed non-empty proposal is an error.
  const proposedList = Array.isArray(next) && next.length ? normalizeClauses(next) : [];
  const proposed = new Map(proposedList.map((c) => [c.id, c]));
  const byId = new Map(before.map((c) => [c.id, c]));
  const hashes = new Map((index || []).map((e) => [e.id, e.hash]));

  const action = new Map();
  const instruction = new Map();
  for (const d of decisions || []) {
    const id = String((d && d.clauseId) || "");
    if (!byId.has(id)) throw new Error(`decision references unknown clause ${id}`);
    const a = String((d && d.action) || "");
    if (!["pin", "send-back", "drop"].includes(a)) throw new Error(`invalid action ${a} for clause ${id}`);
    action.set(id, a);
    if (a === "send-back") instruction.set(id, String((d && d.instruction) || "").trim());
  }

  const out = [];
  for (const clause of before) {
    const a = action.get(clause.id) || "open";
    if (a === "drop") continue;
    if (a === "pin") {
      const recorded = hashes.get(clause.id);
      if (recorded && hashClause(clause.text) !== recorded) {
        throw new Error(`pinned clause ${clause.id} does not match its recorded hash`);
      }
      out.push({ ...clause });
      continue;
    }
    const fresh = proposed.get(clause.id);
    out.push(fresh ? { id: clause.id, title: fresh.title, text: fresh.text } : { ...clause });
  }

  const used = new Set([...usedIds, ...before.map((c) => c.id)]);
  for (const [id, clause] of proposed) {
    if (byId.has(id)) continue;
    const minted = nextClauseId(used);
    used.add(minted);
    out.push({ id: minted, title: clause.title, text: clause.text });
  }

  if (!out.length) throw new Error("a plan must keep at least one clause");
  return normalizeClauses(out);
}

export function planStats(index) {
  const list = Array.isArray(index) ? index : [];
  return {
    total: list.length,
    pinned: list.filter((c) => c.status === "pinned").length,
    sentBack: list.filter((c) => c.status === "sent-back").length,
    open: list.filter((c) => !c.status || c.status === "open").length,
  };
}
