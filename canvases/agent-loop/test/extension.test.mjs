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

console.log(`\n${passed} extension assertions passed`);
