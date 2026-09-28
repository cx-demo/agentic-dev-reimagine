import assert from "node:assert";
import {
  renderClauses, parseClauses, hashClause, indexClauses,
  nextClauseId, verifyPinned, spliceSynthesis, planStats, CLAUSE_ID_RE,
} from "../clauses.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

const sample = [
  { id: "c1", title: "Register a plan-review factory", text: "Two uniquely labeled reviewers and one synthesis agent." },
  { id: "c2", title: "Validate provider diversity", text: "Resolve both model ids.\n\nConfirm different families before dispatch." },
  { id: "c3", title: "Journal the run by operation id", text: "Key journal entries on the opId so a resume replays reviews." },
];

// The sanitizer in workflow.mjs neutralises the workflow marker prefix. This is
// the exact reason clause anchors use `alc:`.
const safeBody = (b) => String(b || "").trim().replace(/<!--\s*AL-/g, "<!-- AL\u200b-");

await test("render/parse round trips exactly", () => {
  assert.deepStrictEqual(parseClauses(renderClauses(sample)), sample);
});

await test("clause anchors survive safeBody; the workflow prefix would not", () => {
  const body = renderClauses(sample);
  assert.strictEqual(safeBody(body), body, "alc: anchors must pass through untouched");
  const bad = "<!-- AL-CLAUSE c1 -->";
  assert.notStrictEqual(safeBody(bad), bad, "the workflow prefix must be proven to corrupt");
  assert.match(safeBody(bad), /\u200b/);
});

await test("parse ignores any preamble before the first anchor", () => {
  const body = "Some intro prose.\n\n### Not a clause\n\n" + renderClauses(sample);
  assert.deepStrictEqual(parseClauses(body), sample);
});

await test("render numbers clauses positionally but ids stay authoritative", () => {
  const body = renderClauses(sample);
  assert.match(body, /<!-- alc:c1 -->\n### 1\. Register a plan-review factory/);
  assert.match(body, /<!-- alc:c3 -->\n### 3\. Journal the run/);
  // Drop the middle clause: numbering shifts, ids do not.
  const after = parseClauses(renderClauses([sample[0], sample[2]]));
  assert.deepStrictEqual(after.map((c) => c.id), ["c1", "c3"]);
  assert.match(renderClauses(after), /### 2\. Journal the run/);
});

await test("malformed clauses are rejected", () => {
  assert.throws(() => renderClauses([]), /clauses are required/);
  assert.throws(() => renderClauses([{ id: "x1", title: "t", text: "b" }]), /invalid clause id/);
  assert.throws(() => renderClauses([{ id: "c0", title: "t", text: "b" }]), /invalid clause id/);
  assert.throws(() => renderClauses([{ id: "c1", title: "", text: "b" }]), /missing a title/);
  assert.throws(() => renderClauses([{ id: "c1", title: "t", text: "" }]), /missing text/);
  assert.throws(() => renderClauses([
    { id: "c1", title: "a", text: "b" }, { id: "c1", title: "c", text: "d" },
  ]), /duplicate clause id/);
  assert.throws(() => parseClauses("<!-- alc:c1 -->\nno heading here"), /missing its heading/);
});

await test("ids are minted monotonically and never recycled", () => {
  assert.strictEqual(nextClauseId([]), "c1");
  assert.strictEqual(nextClauseId(["c1", "c2"]), "c3");
  assert.strictEqual(nextClauseId(["c9", "c10"]), "c11");
  // A dropped id is still consumed, so a stale quote can never rebind.
  assert.strictEqual(nextClauseId(["c1", "c3"]), "c4");
  assert.ok(CLAUSE_ID_RE.test(nextClauseId(["c7"])));
});

await test("index records hashes and carries decisions forward", () => {
  const index = indexClauses(sample);
  assert.strictEqual(index.length, 3);
  assert.strictEqual(index[0].hash, hashClause(sample[0].text));
  assert.strictEqual(index[0].status, "open");
  const carried = indexClauses(sample, [{ id: "c2", status: "pinned", instruction: null, quotes: ["claude#r1"] }]);
  assert.strictEqual(carried[1].status, "pinned");
  assert.deepStrictEqual(carried[1].quotes, ["claude#r1"]);
});

await test("verifyPinned fails closed when a pinned clause drifted", () => {
  const index = indexClauses(sample, [{ id: "c1", status: "pinned" }]);
  assert.ok(verifyPinned(index, sample));
  const drifted = [{ ...sample[0], text: "tampered" }, sample[1], sample[2]];
  assert.throws(() => verifyPinned(index, drifted), /does not match its recorded hash/);
  assert.throws(() => verifyPinned(index, [sample[1], sample[2]]), /missing from the plan/);
});

// ---- The headline guarantee -------------------------------------------------

await test("a pinned clause is byte-identical even when synthesis rewrites it", () => {
  const index = indexClauses(sample, [{ id: "c1", status: "pinned" }]);
  const hostile = [
    { id: "c1", title: "REWRITTEN", text: "synthesis tried to replace the pinned clause" },
    { id: "c2", title: "Validate provider diversity", text: "Now with more detail about failure modes." },
    { id: "c3", title: "Journal the run by operation id", text: "Unchanged." },
  ];
  const out = spliceSynthesis({
    prev: sample, next: hostile, index,
    decisions: [{ clauseId: "c1", action: "pin" }, { clauseId: "c2", action: "send-back", instruction: "more detail" }],
  });
  const c1 = out.find((c) => c.id === "c1");
  assert.strictEqual(c1.title, sample[0].title);
  assert.strictEqual(c1.text, sample[0].text, "pinned text must be byte-identical");
  assert.strictEqual(hashClause(c1.text), hashClause(sample[0].text));
  // The sent-back clause is the only one that took the rewrite.
  assert.strictEqual(out.find((c) => c.id === "c2").text, "Now with more detail about failure modes.");
});

await test("dropped clauses are removed and untouched clauses survive a silent rewrite", () => {
  const out = spliceSynthesis({
    prev: sample,
    next: [{ id: "c3", title: "Journal the run by operation id", text: "sneaky rewrite" }],
    decisions: [{ clauseId: "c2", action: "drop" }],
  });
  assert.deepStrictEqual(out.map((c) => c.id), ["c1", "c3"]);
  // c3 was never sent back, but synthesis proposed new text for it. An untouched
  // clause is allowed to change; only pinning freezes text.
  assert.strictEqual(out.find((c) => c.id === "c3").text, "sneaky rewrite");
});

await test("synthesis cannot overwrite an existing clause by reusing a dropped id", () => {
  const out = spliceSynthesis({
    prev: sample,
    next: [{ id: "c1", title: "New idea", text: "invented by synthesis" }],
    decisions: [{ clauseId: "c1", action: "pin" }],
    index: indexClauses(sample, [{ id: "c1", status: "pinned" }]),
  });
  assert.strictEqual(out.find((c) => c.id === "c1").text, sample[0].text);
});

await test("clauses synthesis invents are appended with freshly minted ids", () => {
  const out = spliceSynthesis({
    prev: sample,
    // `c50` is not a clause on this plan, so the coordinator mints the id rather
    // than letting synthesis choose one and squat on a reserved or retired slot.
    next: [...sample, { id: "c50", title: "Add rollback", text: "Document the rollback path." }],
    usedIds: ["c1", "c2", "c3", "c7"],
  });
  const added = out[out.length - 1];
  assert.strictEqual(added.title, "Add rollback");
  assert.strictEqual(added.id, "c8", "must not collide with a retired id");
});

await test("splice rejects unknown or invalid decisions and empty results", () => {
  assert.throws(() => spliceSynthesis({ prev: sample, next: [], decisions: [{ clauseId: "c9", action: "pin" }] }),
    /unknown clause c9/);
  assert.throws(() => spliceSynthesis({ prev: sample, next: [], decisions: [{ clauseId: "c1", action: "nope" }] }),
    /invalid action/);
  assert.throws(() => spliceSynthesis({
    prev: sample, next: [],
    decisions: sample.map((c) => ({ clauseId: c.id, action: "drop" })),
  }), /at least one clause/);
});

await test("a pinned clause whose stored text drifted fails the splice closed", () => {
  const index = indexClauses(sample, [{ id: "c1", status: "pinned" }]);
  const drifted = [{ ...sample[0], text: "drifted in storage" }, sample[1], sample[2]];
  assert.throws(() => spliceSynthesis({
    prev: drifted, next: [], index, decisions: [{ clauseId: "c1", action: "pin" }],
  }), /does not match its recorded hash/);
});

await test("planStats counts the gate's decision state", () => {
  const index = indexClauses(sample, [
    { id: "c1", status: "pinned" }, { id: "c2", status: "sent-back" },
  ]);
  assert.deepStrictEqual(planStats(index), { total: 3, pinned: 1, sentBack: 1, open: 1 });
});


// A clause parsed out of a REAL posted comment must not absorb the workflow
// marker the coordinator appends, or the next render feeds it to the sanitizer.
await test("parsing strips workflow markers, including an already-mangled one", () => {
  const posted = "## 🗺 Plan\n\n" + renderClauses(sample) +
    "\n\n<!-- AL\u200b-OUT iss3/x b64:abc -->\n\n<!-- AL-OUT iss3/y -->";
  const back = parseClauses(posted);
  assert.deepStrictEqual(back, sample, "round trip survives a real comment body");
  const rerendered = renderClauses(back);
  assert.ok(!/AL\u200b-/.test(rerendered), "no mangled marker is carried forward");
  assert.ok(!/AL-OUT/.test(rerendered), "no workflow marker leaks into clause text");
});

console.log(`\n${passed} clause assertions passed`);
