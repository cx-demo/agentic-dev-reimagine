// Webview renderer smoke tests.

import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { CANVAS_RELEASE, renderHtml } from "../webview.mjs";
import { BUILTIN_DEFAULT, PHASED_DEFAULT, stagesOf } from "../workflow-def.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("FAIL  -", name, "\n   ", e.stack || e.message); process.exitCode = 1; }
}

const source = await readFile(new URL("../webview.mjs", import.meta.url), "utf8");
const html = renderHtml("cap_123-XYZ", "https://127.0.0.1:8123/work-assets", "dark");

function capMeta(doc) {
  const m = doc.match(/<meta name="al-cap" content="([^"]*)"/);
  assert.ok(m, "capability token meta tag is present");
  return m[1];
}

function assetMeta(doc) {
  const m = doc.match(/<meta name="al-assets" content="([^"]*)"/);
  assert.ok(m, "asset base meta tag is present");
  return m[1];
}

function escFrom(doc) {
  const m = doc.match(/function esc\(s\) \{[\s\S]*?\n\}/);
  assert.ok(m, "generated document defines esc()");
  return Function('"use strict"; return (' + m[0] + ');')();
}

function fallbackNodeKeys(src) {
  const m = src.match(/const NODES = \[([\s\S]*?)\n\];/);
  assert.ok(m, "fallback NODES are still present for old states");
  return [...m[1].matchAll(/\{\s*key: "([^"]+)"/g)].map((x) => x[1]);
}

function rawInnerHtmlFieldFindings(src) {
  const lines = src.split(/\r?\n/);
  const findings = [];
  const rawField = /\+\s*\(?\s*(?:[A-Za-z_$][\w$]*(?:\[[^\]]+\])?\.)+(?:label|name|title|contract|pitch|id)\b[^+\n]*\+/g;
  for (let i = 0; i < lines.length; i++) {
    if (!/\.innerHTML\s*=/.test(lines[i])) continue;
    for (let j = i; j < lines.length && j < i + 80; j++) {
      rawField.lastIndex = 0;
      if (rawField.test(lines[j])) findings.push(`${j + 1}: ${lines[j].trim()}`);
      if (/;\s*(?:\/\/.*)?$/.test(lines[j])) break;
    }
  }
  return findings;
}

await test("renderHtml returns a complete substantial document", () => {
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /<html\b[^>]*>/);
  assert.ok(html.includes("<style>"), "styles are inlined");
  assert.match(html, /<\/html>\s*$/);
  assert.ok(html.length > 20000, "document should include the full app, not a shell");
  assert.ok(!html.includes("[object Object]"), "no object leaked through string concatenation");
  const withoutFeatureDetection = html.replace(/typeof\s+\w+\s*!==\s*"undefined"/g, "");
  assert.ok(!withoutFeatureDetection.includes("undefined"), "no undefined value leaked into markup");
});

await test("canvas info control identifies source version and fixed change time", () => {
  assert.match(CANVAS_RELEASE.version, /^\d+\.\d+\.\d+$/);
  assert.match(CANVAS_RELEASE.changedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/);
  assert.ok(Number.isFinite(Date.parse(CANVAS_RELEASE.changedAt)));
  for (const doc of [html, renderHtml()]) {
    assert.match(doc, /id="releaseInfoBtn"[^>]*aria-controls="releaseInfo" aria-expanded="false"/);
    assert.match(doc, /id="releaseInfo" role="note" aria-label="Canvas release information" hidden/);
    assert.ok(doc.includes(`Flow Loop v${CANVAS_RELEASE.version}`));
    assert.ok(doc.includes(`datetime="${CANVAS_RELEASE.changedAt}"`));
    assert.match(doc, /Changed <time id="releaseTime"/);
    assert.ok(doc.indexOf('id="releaseInfo"') < doc.indexOf("</header>"), "info lives in header");
    assert.ok(!doc.includes('class="release-footer"'), "footer version display is removed");
  }
  assert.ok(html.includes("releaseTime.textContent = new Intl.DateTimeFormat"), "time localizes in the webview");
  assert.equal(renderHtml(), renderHtml(), "reopening without a source change preserves release identity");
});

await test("token is embedded for client fetches and cannot break out", () => {
  assert.equal(capMeta(html), "cap_123-XYZ");
  assert.ok(html.includes('"x-al-cap": CAP'), "client sends the capability token header");
  assert.ok(html.includes("encodeURIComponent(CAP)"), "client encodes token when building URLs");

  const dangerous = renderHtml('a"><script>alert(1)</script>', "", "");
  assert.equal(capMeta(dangerous), "ascriptalert1script");
  assert.ok(!dangerous.includes('a"><script>alert(1)</script>'));
  assert.ok(!dangerous.includes("<script>alert(1)</script>"));
});

await test("asset base and initial mode are reflected and optional", () => {
  assert.match(html, /<html lang="en" data-mode="dark">/);
  assert.equal(assetMeta(html), "https://127.0.0.1:8123/work-assets");
  assert.match(renderHtml("tok", "https://assets.example/a_b-c.d", "light"), /<html lang="en" data-mode="light">/);
  assert.doesNotThrow(() => renderHtml());
  assert.match(renderHtml(), /<!doctype html>[\s\S]*<\/html>\s*$/);
});

await test("workflow configuration contracts are wired into the client", () => {
  for (const needle of [
    "Workflows",
    "/workflows",
    "/workflows/validate",
    "expectedRev",
    "workflowId",
    "definitionError",
    "Workflow definition problem:",
    "Definition is valid.",
    "Default build loop",
  ]) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
  assert.match(html, /sendIntent\("kickoff", \{[^}]*workflowId/s);
  assert.match(html, /gfetch\("\/workflows\/validate"[\s\S]*body: JSON\.stringify\(snapshot\)/);
});

await test("esc helper escapes the HTML metacharacters it owns", () => {
  const esc = escFrom(html);
  assert.equal(esc('&<>"'), "&amp;&lt;&gt;&quot;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

await test("innerHTML concatenations escape obvious workflow fields", () => {
  // Heuristic guard, not a proof: catches direct `+ step.label +`-style inserts
  // into innerHTML while allowing escaped helpers and prebuilt safe fragments.
  const findings = rawInnerHtmlFieldFindings(source);
  assert.deepEqual(findings, [], "raw user-authored fields in innerHTML:\n" + findings.join("\n"));
});

await test("definition-derived stages, not only fallback nodes, drive the stepper", () => {
  assert.deepEqual(fallbackNodeKeys(source), stagesOf(BUILTIN_DEFAULT).map((g) => g.key));
  assert.match(html, /function activeNodes\(s\) \{[\s\S]*const def = s && s\.definition[\s\S]*def\.steps\.forEach[\s\S]*st\.stage/);
  assert.match(html, /function currentKey\(s\) \{[\s\S]*const def = s\.definition[\s\S]*stepForIssueLabelClient\(def, s\.stage \|\| def\.entry, s\.gate\)[\s\S]*return step\.stage/);
});

await test("phased UI tabs show ordered stages, support keyboard access and label missing historic Council", () => {
  assert.match(html, /class="phase-tabs" role="tablist" aria-label="Workflow phases"/);
  assert.match(html, /role="tab" class="phase-tab/);
  assert.match(html, /aria-selected="' \+ \(phaseIndex === selectedPhaseIndex\)/);
  assert.match(html, /role="tabpanel" aria-labelledby="phase-tab-/);
  assert.match(html, /const uiKey = \[s\.owner, s\.repo, s\.issue, currentPhaseIndex\]/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /ArrowLeft/);
  assert.match(html, /\.phase-tab \{[^}]*border-radius: 0;/);
  assert.match(html, /\.phase-stage \{[^}]*border-radius: 0;/);
  assert.match(html, /grid-template-columns: repeat\(var\(--stage-count\), minmax\(125px, 1fr\)\)/);
  assert.match(html, /data-index="' \+ String\(phaseIndex \+ 1\)\.padStart\(2, "0"\)/);
  assert.match(html, /phase-tab:focus-visible, \.phase-stage:focus-visible/);
  assert.match(html, /Council not run/);
  assert.match(html, /View earlier plan-review recommendations/);
  assert.match(html, /No code-review findings are claimed/);
});

await test("completed flow tabs expose stages in sequence and preserve read-only selection", () => {
  const start = html.indexOf("function renderStrip(s) {");
  const end = html.indexOf("\n\nfunction panelHead", start);
  assert.ok(start > 0 && end > start);
  const nodes = stagesOf(PHASED_DEFAULT).map((stage) => {
    const first = PHASED_DEFAULT.steps.find((step) => step.stage === stage.key);
    return { key: stage.key, label: first.label, phase: first.phase };
  });
  const strip = {
    classList: { add() {}, remove() {} },
    set innerHTML(value) {
      this.html = value;
      const buttons = [...value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, content]) => ({
        disabled: /\bdisabled\b/.test(attrs),
        label: content.replace(/<[^>]*>/g, ""),
        getAttribute: (name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null,
        focus() { strip.focused = this; },
      }));
      this.tabs = buttons.filter((button) => button.getAttribute("data-phase") !== null);
      this.stages = buttons.filter((button) => button.getAttribute("data-nav") !== null);
    },
    querySelectorAll(selector) {
      if (selector === ".phase-tab") return this.tabs;
      if (selector === ".phase-stage:not(:disabled)") return this.stages.filter((button) => !button.disabled);
      if (selector === ".phase-stage") return this.stages;
      return [];
    },
  };
  const runtime = new Function("activeNodes", "currentKey", "canNavigate", "$", "esc",
    `let phaseUIKey = null, selectedPhaseIndex = -1, viewKey = null, lastState = null;
     function render(s) { renderStrip(s); }
     ${html.slice(start, end)}
     return { renderState(s) { lastState = s; renderStrip(s); }, selected() { return selectedPhaseIndex; },
       viewing() { return viewKey; } };`)(
    () => nodes, () => "done", (_s, index, current) => index <= current,
    (id) => id === "strip" ? strip : { focus() {} },
    (value) => String(value),
  );
  runtime.renderState({ active: true, owner: "o", repo: "r", issue: 9, status: "done",
    phaseHistory: { council: "not-run" } });
  assert.deepEqual(strip.tabs.map((tab) => tab.label),
    ["PlanCompleted", "BuildCompleted", "ReviewCouncil not run", "AuditCompleted", "DoneDone"]);
  assert.equal(runtime.selected(), 4);
  assert.equal(strip.tabs[4].getAttribute("aria-current"), "step");
  assert.deepEqual(strip.tabs.map((tab) => tab.getAttribute("data-index")), ["01", "02", "03", "04", "05"]);
  strip.tabs[0].onclick();
  assert.deepEqual(strip.stages.map((stage) => stage.label),
    ["Research", "Prototype", "Draft", "Synthesize"]);
  assert.match(strip.html, /style="--stage-count:4"/);
  assert.deepEqual(strip.stages.map((stage) => stage.getAttribute("data-index")), ["01", "02", "03", "04"]);
  assert.doesNotMatch(strip.html, /class="phase-arrow"/);
  assert.equal(runtime.viewing(), "synthesize");
  assert.equal(strip.tabs[4].getAttribute("aria-current"), "step");
  const plan = strip.tabs[0];
  plan.onkeydown({ key: "ArrowRight", preventDefault() {} });
  assert.equal(runtime.selected(), 1);
  assert.equal(runtime.viewing(), "build");
  strip.tabs[2].onclick();
  assert.deepEqual(strip.stages.map((stage) => stage.label), ["Council · Not run", "Feedback"]);
  assert.match(strip.html, /phase-stage skipped/);
});

await test("review points offer only decisions while preserving prior exchanges", () => {
  assert.match(html, /function renderIndependentReview\(s, readOnly\)/);
  assert.match(html, /\.review-point \.point-edit:not\(\[hidden\]\) \{ display: grid;/,
    "hidden modification panels must not inherit grid display");
  assert.match(html, /id="modifyBox_' \+ id \+ '"' \+ \(choice === "modify" \? "" : " hidden"\)/,
    "only a persisted Modify decision may open its editor on render");
  for (const text of ["Accept", "Ignore", "Modify", "Synthesize final plan"]) {
    assert.ok(html.includes(text), `missing review control ${text}`);
  }
  for (const intent of ["review-decision", "review-redraft", "review-continue"]) {
    assert.ok(html.includes('sendIntent("' + intent + '"'), `missing review intent ${intent}`);
  }
  assert.ok(!html.includes("Discuss this point with reviewer"));
  assert.ok(!html.includes('sendIntent("review-chat"'));
  assert.ok(!html.includes('sendIntent("review-retry-chat"'));
  assert.match(html, /Earlier reviewer exchange/);
  assert.match(html, /Redraft plan and review/);
  assert.match(html, /view\.gate === "review-points"[\s\S]*renderIndependentReview/);
  assert.match(html, /key === "synthesis"[\s\S]*renderPlanReview\(s, true\)/);
  assert.match(html, /esc\(point\.evidence\)/);
  assert.match(html, /esc\(point\.recommendation\)/);
  const browserScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(browserScript, "embedded browser script exists");
  assert.doesNotThrow(() => new Function(browserScript));
});

console.log(`\n${passed} webview assertions passed`);
