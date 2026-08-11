// extension.mjs is the one module that cannot be imported under test: it calls
// joinSession at module scope and needs the live host SDK. That gap let a real
// bug ship — `session.factories.run` (private field) instead of the public
// `session.factory.run` — which passed startup capability detection and then
// threw mid-plan, turning every review into an unreviewed draft.
//
// These are static contract checks over the source text plus, when the SDK is
// present on this machine, a check against its actual declared surface.
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "extension.mjs"), "utf8");

await test("the factory is run through the public singular accessor", () => {
  assert.ok(/session\.factory\.run\s*\(/.test(src), "extension.mjs calls session.factory.run");
});

// The exact bug. `factories` is private on the session, so this reads as
// undefined and fails only when a plan is actually submitted.
await test("the private plural accessor is never called at runtime", () => {
  assert.ok(!/session\.factories\s*\./.test(src), "no session.factories.<member> access");
});

// The plural IS correct as a joinSession config key. The asymmetry is the trap,
// so pin it: losing this line silently unregisters the factory.
await test("the factory is still registered under the plural config key", () => {
  assert.ok(/factories:\s*\[\s*planPanel\s*\]/.test(src), "joinSession receives factories: [planPanel]");
});

// Detection must prove the run path exists, not merely that a factory can be
// described. Checking defineFactory alone is what reported the panel as
// available on a host that could not run it.
await test("capability detection probes the run path, not just defineFactory", () => {
  const m = src.match(/const\s+panelAvailable\s*=\s*([^;]+);/);
  assert.ok(m, "panelAvailable is computed before being published");
  assert.ok(/factory\?\.\s*run|factory\.run/.test(m[1]), "the check includes session.factory.run");
  assert.ok(/planPanel/.test(m[1]), "the check still includes the factory handle");
});

await test("the published capability is the computed one", () => {
  assert.ok(/setCapabilities\(\s*\{\s*panelAvailable\s*\}\s*\)/.test(src),
    "setCapabilities publishes the computed panelAvailable");
  assert.ok(!/setCapabilities\(\s*\{\s*panelAvailable:\s*!!planPanel/.test(src),
    "it does not publish the defineFactory-only signal");
});

await test("a non-completed envelope is treated as a failure", () => {
  assert.ok(/envelope\.status\s*!==\s*"completed"/.test(src),
    "run envelopes resolve for error/halted/cancelled, so status is checked");
});

// A reached limit is reported as failure.kind. Throwing the bare status turned
// an exhausted credit budget into an unattributable "error", which is exactly
// how the null-review bug stayed hidden.
await test("a failed run reports why it failed, not just that it failed", () => {
  assert.ok(/failure\s*&&\s*envelope\.failure\.kind|failure\.kind/.test(src),
    "the envelope's failure kind is surfaced");
  assert.ok(!/plan panel run \$\{envelope \? envelope\.status/.test(src),
    "the bare-status message is gone");
});

// The failure this whole redesign is about: the SDK swallows a refused spawn
// (`prepareSubagent` throws, the error is discarded, `ctx.agent` resolves null),
// so a host-side refusal is indistinguishable from a bad review unless the
// consumed-subagent count is read back. The count is NOT on the run envelope —
// only on the run detail — so a check against the envelope would silently
// always be undefined.
await test("a failed run reads back how many subagents were actually admitted", () => {
  assert.ok(/getRunDetail\s*\(/.test(src), "the run detail is fetched, since the envelope has no count");
  assert.ok(/consumed\?\.\s*subagents|consumed\.subagents/.test(src), "the consumed subagent count is read");
  assert.ok(src.includes('typeof session?.factory?.getRunDetail !== "function"'),
    "getRunDetail is feature-detected - an older host must degrade, not throw");
});

await test("zero admitted subagents is attributed to the host, with a code", () => {
  assert.ok(/spawned\s*===\s*0/.test(src), "the zero-spawn case is distinguished");
  assert.ok(/the host admitted no subagent/.test(src), "and is stated in the human-facing message");
  assert.ok(/code\s*=\s*"review-not-started"/.test(src),
    "callers branch on a code, not on message text");
});

// Factory args are serialized, so a progress callback cannot ride along in them.
// The factory body runs in THIS process, so the reporter is resolved out of a
// side table keyed by opId - which leaks unless it is cleared unconditionally.
await test("the live progress reporter is registered per run and always cleared", () => {
  assert.ok(/progressByOp\.set\(/.test(src) && /progressByOp\.delete\(/.test(src),
    "the reporter is registered and removed");
  assert.ok(/finally\s*\{[^}]*progressByOp\.delete/.test(src),
    "removal is in a finally - a thrown run must not leak the callback");
  assert.ok(/resolveProgress/.test(src), "the factory definition is given a way to resolve it");
});

// Contract check against the real SDK when this machine has it. Skipped rather
// than failed elsewhere, since the SDK ships with the host app, not the repo.
const sdkPath = process.env.COPILOT_SDK_PATH || "/Applications/GitHub Copilot.app/Contents/Resources/copilot-sdk";
const sessionDts = join(sdkPath, "session.d.ts");

await test("the SDK declares `factory` public and `factories` private", () => {
  if (!existsSync(sessionDts)) { console.log("       (skipped - SDK not on this machine)"); return; }
  const dts = readFileSync(sessionDts, "utf8");
  assert.ok(/readonly\s+factory\s*:\s*SessionFactoryApi/.test(dts),
    "session.factory is the public run surface");
  assert.ok(/private\s+factories\s*;/.test(dts),
    "session.factories is private - reaching for it is the bug this guards");
});

// The extra RPC hop in spawnCount() only earns its keep if the count is genuinely
// absent from the run envelope and genuinely present on the detail. Verified live
// against run 719f1112 (2 subagents) and 5b991b20 (0 subagents, refused spawn);
// these pin the shape so an SDK change cannot silently return attribution to the
// "reviewer returned no review" behaviour this redesign exists to remove.
const rpcDts = join(sdkPath, "generated", "rpc.d.ts");
const factoryDts = join(sdkPath, "factory.d.ts");

await test("the SDK exposes getRunDetail with a consumed.subagents count", () => {
  if (!existsSync(rpcDts) || !existsSync(factoryDts)) { console.log("       (skipped - SDK not on this machine)"); return; }
  assert.ok(/getRunDetail\(runId: string\): Promise<FactoryRunDetail>/.test(readFileSync(factoryDts, "utf8")),
    "session.factory.getRunDetail is declared");
  const rpc = readFileSync(rpcDts, "utf8");
  const detail = rpc.match(/interface FactoryRunDetail \{[\s\S]*?\n\}/);
  assert.ok(detail, "FactoryRunDetail is declared");
  assert.ok(/consumed: FactoryRunConsumed;/.test(detail[0]), "the detail carries a consumed block");
  const consumed = rpc.match(/interface FactoryRunConsumed \{[\s\S]*?\n\}/);
  assert.ok(consumed && /subagents: number;/.test(consumed[0]),
    "consumed.subagents is the admitted-subagent count spawnCount reads");
});

// If the count ever appears here, the extra round trip should be deleted.
await test("the run envelope still carries no subagent count", () => {
  if (!existsSync(rpcDts)) { console.log("       (skipped - SDK not on this machine)"); return; }
  const rpc = readFileSync(rpcDts, "utf8");
  const envelope = rpc.match(/interface FactoryRunResult \{[\s\S]*?\n\}/);
  assert.ok(envelope, "FactoryRunResult is declared");
  assert.ok(!/subagent|consumed/i.test(envelope[0]),
    "the envelope has no count - which is why getRunDetail is called at all");
});

console.log(`\n${passed} extension assertions passed`);
