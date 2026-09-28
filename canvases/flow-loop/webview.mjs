// Webview renderer for the Flow Loop canvas.
// Vanilla JS single-page app. Reads durable state from /state (issue-authoritative)
// on a poll + SSE nudge; sends structured human intent via POST /intent.
//
// Styled with the vendored Postrboard design system (inlined for offline/private
// repos). Quiet, code-native surfaces; one accent per state; light + dark modes.

import { POSTRBOARD_CSS } from "./postrboard-css.mjs";

export const CANVAS_RELEASE = Object.freeze({
  version: "0.1.5",
  changedAt: "2026-09-25T04:33:00+08:00",
});

export function renderHtml(token = "", assetBase = "", initialMode = "") {
  const cap = String(token).replace(/[^A-Za-z0-9_-]/g, "");
  const assets = String(assetBase).replace(/[^A-Za-z0-9:/._-]/g, "");
  const mode = initialMode === "dark" || initialMode === "light" ? initialMode : "";
  return `<!doctype html>
<html lang="en"${mode ? ` data-mode="${mode}"` : ""}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="al-cap" content="${cap}" />
<meta name="al-assets" content="${assets}" />
<title>Flow Loop</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>${POSTRBOARD_CSS}</style>
<style>
  /* Canvas-specific composition — tokens only, no new color systems. */
  body { font-size: 14px; }

  .appbar { position: sticky; top: 0; z-index: var(--z-sticky);
    background: var(--nav-bg); -webkit-backdrop-filter: var(--nav-blur); backdrop-filter: var(--nav-blur);
    border-bottom: 1px solid var(--border); }
  .appbar-inner { max-width: 940px; margin-inline: auto; padding: 12px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .brand .mark { width: 32px; height: 32px; border-radius: var(--radius-compact); flex-shrink: 0;
    display: grid; place-items: center; background: var(--coral-surface); color: var(--on-accent);
    box-shadow: 0 4px 12px var(--shadow-coral-surface); }
  .brand .mark .icon { width: 18px; height: 18px; }
  .brand .who { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .brand .name { font-weight: 800; letter-spacing: -0.02em; font-size: 15px; line-height: 1.15; }
  .brand .meta { font-family: var(--mono); font-size: 11px; color: var(--text-meta);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .appbar .tools { position: relative; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .icon-button.sm { width: 34px; height: 34px; }
  .icon-button .icon { width: 17px; height: 17px; }

  .shell { max-width: 940px; margin-inline: auto; padding: 22px 24px 80px; }
  .release-popover { position: absolute; top: calc(100% + 14px); right: 0;
    width: min(300px, calc(100vw - 32px)); padding: 16px;
    border: 1px solid var(--border); border-radius: var(--radius-compact);
    background: var(--surface); color: var(--text); box-shadow: var(--shadow-medium);
    font-size: 12px; line-height: 1.5; }
  .release-popover[hidden] { display: none; }
  .release-popover strong { display: block; font-size: 14px; font-weight: 600; }
  .release-popover p { margin-top: 8px; color: var(--text-muted); }
  .release-popover time { font-variant-numeric: tabular-nums; }

  /* Pipeline strip (Postrboard stepper) */
  .strip-wrap { padding: 16px 20px; margin-bottom: 24px; }
  .stepper { justify-content: space-between; }
  .step { cursor: default; gap: 7px; }
  .step .step-circle .icon { width: 15px; height: 15px; }
  .step-line { margin: 0 8px 24px; }
  .step-label { font-size: 11px; font-weight: 700; letter-spacing: 0.01em; color: var(--text-meta); }
  .step.done .step-label, .step.active .step-label { color: var(--text); }
  .step.nav { cursor: pointer; }
  .step.nav:hover .step-circle { border-color: var(--coral-surface); color: var(--text); }
  .step.viewing .step-circle { box-shadow: var(--focus-ring); border-color: var(--coral-surface); }
  .step.gate.active .step-circle { background: var(--warning); border-color: var(--warning); color: #1c1206; }
  .stepper.phased { display: block; }
  .phase-tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 8px; }
  .phase-tab { flex: 1 0 118px; min-height: 74px; border: 1px solid var(--border);
    border-radius: 0; padding: 10px 12px; background: var(--surface); color: var(--text-muted);
    font: inherit; font-size: 14px; font-weight: 600; text-align: left; cursor: pointer; }
  .phase-tab::before { content: attr(data-index); display: block; margin-bottom: 2px;
    color: var(--text-muted); font: 11px var(--mono); }
  .phase-tab-status { display: block; margin-top: 3px; font-size: 11px; font-weight: 400; }
  .phase-tab.selected { border-color: var(--coral); background: var(--coral-tint); color: var(--text); }
  .phase-tab.current:not(.selected) { border-color: var(--sage); }
  .phase-tab:hover:not(.selected):not(:disabled) { background: var(--code-bg); }
  .phase-tab:disabled { opacity: var(--opacity-dim); cursor: default; }
  .phase-tab:focus-visible, .phase-stage:focus-visible { outline: 2px solid var(--azure-text); outline-offset: 3px; }
  .phase-stages { display: grid; grid-template-columns: repeat(var(--stage-count), minmax(125px, 1fr));
    overflow-x: auto; margin-top: 18px; }
  .phase-stage { min-height: 60px; border: 1px solid var(--border); border-right: 0;
    border-radius: 0; padding: 8px 12px; background: var(--surface); color: var(--text-muted);
    font: inherit; font-size: 13px; font-weight: 600; text-align: left; cursor: pointer; }
  .phase-stage:last-child { border-right: 1px solid var(--border); }
  .phase-stage::before { content: attr(data-index); display: block; margin-bottom: 3px;
    color: var(--text-muted); font: 11px var(--mono); }
  .phase-stage.active, .phase-stage.viewing { color: var(--text); box-shadow: inset 0 -3px var(--coral); }
  .phase-stage.done { color: var(--text); }
  .phase-stage.skipped { border-bottom-style: dashed; }
  .phase-stage:disabled { opacity: var(--opacity-dim); }
  .phase-stage:not(:disabled):hover { background: var(--code-bg); }
  @media (max-width: 600px) {
    .phase-tab { flex-basis: 100px; min-height: 68px; }
  }

  /* Panel scaffolding */
  .eyebrow { font-family: var(--mono); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.14em; color: var(--text-meta); display: inline-flex; align-items: center; gap: 7px; }
  .eyebrow .icon { width: 14px; height: 14px; }
  .panel-title { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; margin: 10px 0 0; }
  .sub { color: var(--text-muted); font-size: 13px; margin: 8px 0 0; }
  .sub .issue-link { margin-left: 2px; }
  .issue-link { color: var(--azure-text); text-decoration: none; font-weight: 600;
    display: inline-flex; align-items: center; gap: 4px; }
  .issue-link:hover { text-decoration: underline; }
  .issue-link .icon { width: 13px; height: 13px; }
  .meta-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }

  textarea, .textarea { min-height: 100px; resize: vertical; line-height: 1.55; }
  .btn .icon { width: 16px; height: 16px; }
  .btn.has-icon { gap: 8px; }
  .btn:disabled { opacity: 0.5; cursor: default; box-shadow: none; transform: none; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
  label.field { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin: 0 0 8px; }

  /* Idle launcher */
  .idle-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 18px -24px 0; padding: 0 24px; }
  .idle-tab { border: 0; background: transparent; color: var(--text-muted); padding: 11px 12px;
    border-bottom: 2px solid transparent; font: inherit; font-weight: 700; cursor: pointer; }
  .idle-tab.active { color: var(--text); border-color: var(--coral-surface); }
  .idle-pane { padding-top: 18px; }
  .idle-pane[hidden] { display: none; }
  .build-search { width: 100%; margin-bottom: 10px; }
  .build-list { display: flex; flex-direction: column; }
  .build-item { width: 100%; display: grid; grid-template-columns: 38px minmax(0, 1fr) auto;
    align-items: center; gap: 12px; padding: 13px 2px; border: 0; border-top: 1px solid var(--border);
    background: transparent; color: var(--text); text-align: left; cursor: pointer; }
  .build-item:hover .build-title { color: var(--azure-text); }
  .build-item:disabled { opacity: 0.55; cursor: wait; }
  .build-number { width: 34px; height: 34px; border: 1px solid var(--border); border-radius: var(--radius-compact);
    display: grid; place-items: center; color: var(--text-meta); font: 11px var(--mono); }
  /* Stacked, not inline: these are spans, so title/workflow/meta ran together on
     one line and the title's ellipsis never applied. */
  .build-copy { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
  .build-title { display: block; max-width: 100%; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .build-wf { display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
    font-size: 11px; color: var(--text-meta); }
  .build-wf .icon { width: 12px; height: 12px; opacity: 0.7; flex: none; }
  .build-wf .build-wf-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .build-meta { color: var(--text-meta); font-size: 11.5px; }
  .build-state { display: flex; align-items: center; gap: 8px; }
  .build-empty { color: var(--text-muted); text-align: center; padding: 24px 8px 8px; font-size: 12.5px; }

  /* Working / status */
  .status-line { display: flex; align-items: center; gap: 14px; font-size: 15px; font-weight: 600; margin-top: 16px; }
  .status-line .spinner { width: 22px; height: 22px; border-width: 2px; }

  .brief { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border);
    font-size: 13.5px; color: var(--text); line-height: 1.7; }
  .brief h3 { font-size: 14px; margin: 18px 0 6px; letter-spacing: -0.01em; font-weight: 700; }
  .brief h3:first-child { margin-top: 0; }
  .brief p { margin: 8px 0; }
  .brief ul { margin: 8px 0 8px 20px; }
  .brief li { margin: 3px 0; }
  .brief strong { color: var(--text); font-weight: 700; }
  .brief a { color: var(--azure-text); text-decoration: none; }
  .brief a:hover { text-decoration: underline; }
  .brief code { font-family: var(--mono); font-size: 12px; background: var(--code-bg);
    padding: 1px 6px; border-radius: var(--radius-sharp); }
  .brief ol { margin: 8px 0 8px 20px; }
  .brief pre { margin: 10px 0; padding: 12px 14px; background: var(--code-bg);
    border: 1px solid var(--border); border-radius: var(--radius-sharp);
    overflow-x: auto; max-height: 420px; overflow-y: auto; }
  .brief pre code { display: block; background: none; padding: 0; font-size: 12px;
    line-height: 1.5; white-space: pre; }

  /* Plan-review gate: clause-level steering (pin / send back / drop) */
  .prov { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
    margin-top: 16px; padding: 10px 14px; border: 1px solid var(--border);
    border-radius: var(--radius-compact); background: var(--code-bg); font-size: 12px; }
  .prov-models { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .prov code { font-family: var(--mono); font-size: 11.5px; }
  .prov .sep { color: var(--text-muted); }
  .prov-warn { width: 100%; color: var(--warning-text); font-weight: 600; }
  .prov-fresh { color: var(--text-muted); }

  /* Plan sequence tracker: draft → review → synthesis. The three steps are shown
     even before they run, so a stall is visibly a stall at a named step rather
     than an unattributed spinner. */
  .seq { display: flex; flex-direction: column; gap: 0; margin: 16px 0 2px;
    border: 1px solid var(--border); border-radius: var(--radius-compact); padding: 0 14px; }
  .seq-step { display: grid; grid-template-columns: 26px 1fr auto; gap: 12px;
    align-items: start; padding: 12px 0; }
  .seq-step + .seq-step { border-top: 1px solid var(--border); }
  .seq-dot { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
    border: 1px solid var(--border); background: var(--surface); color: var(--text-muted);
    font-size: 11px; font-weight: 700; font-family: var(--mono); flex-shrink: 0; }
  /* --sage is a single lime for both modes while --sage-text/-tint are remapped
     to mint per mode, so the border tracks the text token rather than the raw
     hue, or the ring reads as a different green from its own fill. */
  .seq-step[data-state="done"] .seq-dot,
  .seq-step[data-state="reused"] .seq-dot { border-color: var(--sage-text); color: var(--sage-text); background: var(--sage-tint); }
  .seq-step[data-state="running"] .seq-dot { border-color: var(--coral); color: var(--coral-text); background: var(--coral-tint); }
  .seq-step[data-state="failed"] .seq-dot { border-color: var(--warning-text); color: var(--warning-text); }
  .seq-step[data-state="waiting"] { opacity: .5; }
  .seq-main { min-width: 0; }
  .seq-title { font-size: 13.5px; font-weight: 700; color: var(--text); }
  .seq-sub { font-size: 12px; color: var(--text-muted); margin-top: 3px; line-height: 1.55; }
  .seq-side { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .seq-model { font-family: var(--mono); font-size: 11px; padding: 2px 7px;
    border: 1px solid var(--border); border-radius: var(--radius-pill);
    color: var(--text-muted); white-space: nowrap; }
  .seq-step[data-state="running"] .seq-model { border-color: var(--coral); color: var(--coral-text); }
  .seq-time { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .seq-bar { height: 3px; border-radius: 3px; background: var(--border); overflow: hidden; margin-top: 8px; }
  .seq-bar > i { display: block; height: 100%; width: 38%; background: var(--coral);
    animation: seqslide 1.5s ease-in-out infinite; }
  @keyframes seqslide { 0% { margin-left: -38%; } 100% { margin-left: 100%; } }
  @media (prefers-reduced-motion: reduce) { .seq-bar > i { animation: none; width: 100%; opacity: .5; } }

  .clauses { margin-top: 18px; display: flex; flex-direction: column; gap: 10px; }
  .clause { border: 1px solid var(--border); border-radius: var(--radius-compact);
    padding: 12px 14px; background: var(--surface); transition: border-color var(--ease); }
  .clause[data-act="pin"] { border-color: var(--sage); background: var(--sage-tint); }
  .clause[data-act="send-back"] { border-color: var(--warning); background: var(--warning-tint); }
  .clause[data-act="drop"] { opacity: 0.55; }
  .clause[data-act="drop"] .clause-text { text-decoration: line-through; }
  .clause-top { display: flex; align-items: baseline; gap: 8px; }
  .clause-num { font-family: var(--mono); font-size: 11px; color: var(--text-muted); }
  .clause-title { font-weight: 700; font-size: 13.5px; flex: 1; }
  .clause-text { margin-top: 6px; font-size: 13px; line-height: 1.6; color: var(--text); white-space: pre-wrap; }
  .clause-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chip { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-pill);
    padding: 3px 11px; font-size: 11.5px; font-weight: 600; cursor: pointer; color: var(--text);
    font-family: inherit; transition: all var(--ease); }
  .chip:hover:not(:disabled) { border-color: var(--text-muted); }
  .chip[aria-pressed="true"] { background: var(--text); color: var(--surface); border-color: var(--text); }
  .chip:disabled { cursor: not-allowed; opacity: var(--opacity-dim); }
  .chip.evi { margin-left: auto; }
  .clause-instruct { margin-top: 8px; }
  .clause-evidence { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border);
    font-size: 12px; display: flex; flex-direction: column; gap: 7px; }
  .quote { display: flex; gap: 8px; align-items: flex-start; line-height: 1.55; }
  .quote-who { font-family: var(--mono); font-size: 10.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 1px 6px; border-radius: var(--radius-sharp);
    background: var(--coral-tint); color: var(--coral-text); white-space: nowrap; }
  .quote-who.sev-high { background: var(--danger-tint); color: var(--danger-text); }
  .quote-who.sev-medium { background: var(--warning-tint); color: var(--warning-text); }
  .clause-counts { margin-top: 14px; font-size: 12px; color: var(--text-muted); }
  .review-points { display: grid; gap: 12px; margin-top: 18px; }
  .review-point { border: 1px solid var(--border); border-radius: var(--radius-compact); padding: 14px; background: var(--surface); }
  .review-point[data-decision="accept"] { border-color: var(--sage); }
  .review-point[data-decision="ignore"] { opacity: .72; }
  .review-point[data-decision="modify"] { border-color: var(--warning); }
  .review-point .recommendation { margin: 10px 0; padding: 10px; border-left: 3px solid var(--sage); background: var(--sage-tint); white-space: pre-wrap; }
  .review-point .point-evidence { white-space: pre-wrap; line-height: 1.5; }
  .review-point .point-thread { display: grid; gap: 8px; margin: 12px 0; }
  .review-point .point-message { padding: 9px 12px; border-radius: var(--radius-compact); background: var(--background-color-default); white-space: pre-wrap; }
  .review-point .point-message[data-role="reviewer"] { border-left: 3px solid var(--coral-surface); }
  .review-point .point-edit:not([hidden]) { display: grid; gap: 8px; margin-top: 12px; }
  .council-overview { margin: 22px 0 26px; padding: 16px 0 18px;
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .council-totals { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin: 0;
    font-size: 13px; }
  .council-totals code { font-size: 12px; color: var(--text-muted); }
  .council-scope { color: var(--text-muted); font-size: 12.5px; line-height: 1.5; margin: 8px 0 0; }
  .council-counts { display: flex; flex-wrap: wrap; gap: 6px 20px; margin-top: 14px;
    font-size: 12px; color: var(--text-muted); }
  .council-overview details { margin-top: 14px; font-size: 12px; }
  .council-overview details p { margin: 8px 0; overflow-wrap: anywhere; }
  .council-findings { display: grid; gap: 16px; margin: 24px 0; }
  .council-finding { border: 1px solid var(--border); border-radius: var(--radius-compact); padding: 18px; }
  .council-finding p { margin: 10px 0; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .finding-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
    gap: 6px 16px; margin-bottom: 14px; }
  .finding-location { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
  .finding-context, .finding-decision { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
  .finding-context summary, .finding-decision summary, .council-overview summary {
    cursor: pointer; color: var(--azure-text); font-weight: 600; }
  .finding-actions { display: flex; align-items: start; flex-wrap: wrap; gap: 12px 18px; margin-top: 16px; }
  .finding-actions .finding-decision { flex: 1 1 240px; margin: 0; padding: 8px 0 0; }
  .finding-decision-fields { display: grid; gap: 8px; margin-top: 14px; }
  .finding-decision-fields .btn { justify-self: start; margin-top: 4px; }
  #councilRefreshBtn[hidden] { display: none; }
  .review-redraft { margin-top: 16px; border: 1px solid var(--border); border-radius: var(--radius-compact); padding: 12px 14px; }
  .review-redraft summary { cursor: pointer; font-weight: 700; }
  .review-redraft textarea { width: 100%; margin: 10px 0; }

  /* Feedback-gate PR review: changed files + inline diff + CI */
  .pr-review { margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border); }
  .pr-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .badge.badge-rust { background: var(--rust-tint, #f8e0da); color: var(--rust-text, #8a2f1a); }
  .badge.badge-amber { background: var(--amber-tint, #fbeecb); color: var(--amber-text, #7a5600); }
  .files { display: flex; flex-direction: column; gap: 6px; }
  details.file { border: 1px solid var(--border); border-radius: var(--radius-sharp); overflow: hidden; }
  details.file > summary { cursor: pointer; padding: 8px 12px; font-size: 12px;
    list-style: none; background: var(--code-bg); user-select: none; }
  details.file > summary::-webkit-details-marker { display: none; }
  details.file > summary code { font-family: var(--mono); }
  details.file[open] > summary { border-bottom: 1px solid var(--border); }
  details.file > p { margin: 10px 12px; }
  pre.diff { margin: 0; padding: 10px 0; overflow-x: auto; max-height: 460px; overflow-y: auto;
    font-family: var(--mono); font-size: 12px; line-height: 1.45; background: transparent; }
  pre.diff .dl { display: block; padding: 0 12px; white-space: pre; }
  pre.diff .diff-add { background: var(--sage-tint); }
  pre.diff .diff-del { background: var(--rust-tint, #f8e0da); }
  pre.diff .diff-hunk { color: var(--muted); background: var(--code-bg); }

  /* Prototype options */
  .gate-banner { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700;
    color: var(--warning-text); background: var(--warning-tint); padding: 6px 12px;
    border-radius: var(--radius-pill); margin-bottom: 14px; }
  .gate-banner .icon { width: 15px; height: 15px; }
  .opts { display: flex; flex-direction: column; gap: 18px; margin-top: 20px; }
  .opt { border: var(--border-normal) solid var(--border); border-radius: var(--radius-soft);
    overflow: hidden; background: var(--surface); transition: border-color var(--ease), box-shadow var(--ease); }
  .opt.sel { border-color: var(--coral-surface); box-shadow: 0 0 0 1px var(--coral-surface); }
  .opt .preview { background: var(--code-bg); border-bottom: 1px solid var(--border); }
  .preview-frame { width: 100%; height: 300px; border: 0; display: block; background: #fff; }
  .tryit { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border); }
  .tryit .t { font-weight: 700; font-size: 14px; letter-spacing: -0.01em; margin-bottom: 10px; }
  .tryit .preview { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .tryit .demo-frame { width: 100%; height: 380px; border: 0; display: block; background: #fff; }
  .tryit .run-steps { margin-top: 12px; }
  .tryit .run-steps ol { margin: 6px 0 0; padding-left: 20px; }
  .tryit .run-steps li { margin: 4px 0; }
  .tryit .run-steps code, .tryit .branch code { font-size: 12.5px; background: var(--code-bg);
    border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; }
  .tryit .branch { margin-top: 12px; font-size: 13px; color: var(--muted); }
  .opt .meta { padding: 16px 18px; }
  .opt .t { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
  .opt .t .pick { margin-left: auto; flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%;
    border: 2px solid var(--border); display: grid; place-items: center; color: transparent; transition: all var(--ease); }
  .opt .t .pick .icon { width: 13px; height: 13px; }
  .opt.sel .t .pick { background: var(--coral-surface); border-color: var(--coral-surface); color: var(--on-accent); }
  .opt .p { color: var(--text-muted); font-size: 13px; margin-top: 7px; line-height: 1.55; }
  .opt .links { margin-top: 12px; font-size: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .opt .links a { color: var(--azure-text); text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
  .opt .links a:hover { text-decoration: underline; }
  .opt .links a .icon { width: 13px; height: 13px; }
  .opt .links code { font-family: var(--mono); color: var(--text-meta); }
  .opt .select-direction { margin-top: 16px; }

  /* Sticky decision bar */
  .decision { position: sticky; bottom: 0; margin-top: 22px; z-index: var(--z-dropdown);
    border: var(--border-normal) solid var(--border); border-radius: var(--radius-soft);
    background: var(--surface); box-shadow: var(--shadow-medium); padding: 18px; }
  .decision .sel-name { font-size: 13px; color: var(--text-muted); margin-bottom: 14px;
    display: flex; align-items: center; gap: 8px; }
  .decision .sel-name .icon { width: 15px; height: 15px; color: var(--coral-surface); }
  .decision .sel-name strong { color: var(--text); }
  .decision .hint { margin: 12px 0 0; font-size: 11.5px; color: var(--text-meta); }

  /* Review + done */
  .reviewbar { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .done-icon { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
    background: var(--sage-tint); color: var(--sage-text); margin-bottom: 14px; }
  .done-icon .icon { width: 24px; height: 24px; }

  .muted { color: var(--text-muted); }

  /* Questionnaire — stepper + choices */
  .qprogress { margin: 18px 0 20px; }
  .qprogress-meta { display: flex; align-items: center; justify-content: space-between;
    font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; }
  .qbar { height: 6px; border-radius: var(--radius-pill); background: var(--border); overflow: hidden; }
  .qbar > span { display: block; height: 100%; background: var(--coral-surface);
    border-radius: var(--radius-pill); transition: width var(--ease); }
  .qstep-prompt { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.4;
    display: flex; align-items: baseline; gap: 9px; margin-bottom: 16px; }
  .choices { display: flex; flex-direction: column; gap: 8px; }
  .choice { display: flex; align-items: center; gap: 11px; cursor: pointer; position: relative;
    border: var(--border-normal) solid var(--border); border-radius: var(--radius-soft);
    padding: 12px 14px; background: var(--surface); transition: border-color var(--ease), background var(--ease); }
  .choice:hover { border-color: var(--coral-surface); }
  .choice.on { border-color: var(--coral-surface); background: var(--coral-tint); }
  .choice .choice-input { position: absolute; opacity: 0; width: 0; height: 0; }
  .choice-mark { flex-shrink: 0; width: 20px; height: 20px; border: 2px solid var(--border);
    display: grid; place-items: center; color: transparent; transition: all var(--ease); }
  .choice-mark.dot { border-radius: 50%; }
  .choice-mark.box { border-radius: var(--radius-sharp); }
  .choice-mark.on { background: var(--coral-surface); border-color: var(--coral-surface); color: var(--on-accent); }
  .choice-mark .icon { width: 12px; height: 12px; }
  .choice-text { font-size: 14px; font-weight: 500; color: var(--text); }
  .choice.on .choice-text { font-weight: 600; }
  .qnav { justify-content: space-between; margin-top: 22px; }
  .qnav .btn-secondary.has-icon, .qnav .btn.has-icon { gap: 6px; }
  /* Read-only questionnaire list */
  .qitem { padding: 14px 0; border-top: 1px solid var(--border); }
  .qitem:first-child { border-top: 0; padding-top: 4px; }
  .qprompt { font-size: 14px; font-weight: 600; color: var(--text); display: flex; align-items: baseline; gap: 8px; }
  .qchoices-ro { margin: 8px 0 0 22px; padding: 0; color: var(--text-muted); font-size: 13px; }
  .qchoices-ro li { margin: 3px 0; }

  /* Toast */
  .app-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(10px);
    background: var(--surface); border: 1px solid var(--border); color: var(--text);
    border-radius: var(--radius-pill); padding: 10px 18px; font-size: 13px; font-weight: 600;
    box-shadow: var(--shadow-high); opacity: 0; pointer-events: none; z-index: var(--z-toast);
    transition: opacity var(--ease), transform var(--ease); }
  .app-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
<header class="appbar">
  <div class="appbar-inner">
    <div class="brand">
      <span class="mark" id="brandMark"></span>
      <span class="who">
        <span class="name">Flow Loop</span>
        <span class="meta" id="repoMeta">no active job</span>
      </span>
    </div>
    <div class="tools">
      <button class="icon-button sm" id="launcherBtn" type="button" aria-label="Back to flow launcher" title="Back to flow launcher" hidden></button>
      <button class="icon-button sm" id="workflowsToggle" type="button" aria-label="Open the flow builder" title="Flow builder"></button>
      <button class="icon-button sm" id="themeToggle" type="button" aria-label="Toggle color mode"></button>
      <button class="icon-button sm" id="releaseInfoBtn" type="button" aria-label="About Flow Loop version" aria-controls="releaseInfo" aria-expanded="false" title="About Flow Loop version"></button>
      <div class="release-popover" id="releaseInfo" role="note" aria-label="Canvas release information" hidden>
        <strong>Flow Loop v${CANVAS_RELEASE.version}</strong>
        <p>Canvas release · Changed <time id="releaseTime" datetime="${CANVAS_RELEASE.changedAt}">${new Intl.DateTimeFormat("en-GB", {
          day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
          timeZone: "UTC", timeZoneName: "short",
        }).format(new Date(CANVAS_RELEASE.changedAt))}</time></p>
      </div>
    </div>
  </div>
</header>

<main class="shell">
  <div class="card strip-wrap" id="stripWrap"><div class="stepper" id="strip" role="group" aria-label="Pipeline stages"></div></div>
  <div id="connbar" role="status" aria-live="polite" hidden></div>
  <div id="defbar" role="alert" hidden></div>
  <div id="panel"></div>
</main>
<div class="app-toast" id="toast"></div>

<script>
// ---- Inline icon set (Lucide-style, no emoji) --------------------------------
const ICON = {
  loop: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
  research: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  prototype: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  plan: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3"/><path d="M8 12h8"/><path d="M8 16h6"/>',
  implement: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  finalize: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  done: '<path d="M20 6 9 17l-5-5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  gate: '<path d="m21.7 16.5-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 19.5h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v6"/><path d="M12 7h.01"/>',
};
function svg(name, cls) {
  return '<svg class="icon ' + (cls || "icon-sm") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[name] || "") + '</svg>';
}

// Fallback pipeline nodes — used when state.definition is absent (e.g. mid-poll
// or an old build). When a definition is present the strip is derived from its
// distinct step 'group' values in order (see activeNodes).
const NODES = [
  { key: "research", label: "Research", icon: "research" },
  { key: "prototype", label: "Prototype", icon: "prototype" },
  { key: "plan", label: "Plan", icon: "plan" },
  { key: "review", label: "Review", icon: "plan" },
  { key: "synthesis", label: "Synthesis", icon: "plan" },
  { key: "implement", label: "Implement", icon: "implement" },
  { key: "finalize", label: "Audit", icon: "finalize" },
  { key: "done", label: "Done", icon: "done" },
];
const $ = (id) => document.getElementById(id);
const releaseTime = $("releaseTime");
if (releaseTime?.dateTime) {
  releaseTime.textContent = new Intl.DateTimeFormat([], {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(releaseTime.dateTime));
}
// Capability token: embedded in the top-level document only. A sandboxed
// prototype iframe (allow-scripts, no allow-same-origin => opaque origin) cannot
// read this document cross-origin, so it cannot mint privileged requests. All
// side-effecting/reads on the loopback server carry it; /work assets stay open.
let CAP = "";
try { const _m = document.querySelector && document.querySelector('meta[name="al-cap"]'); if (_m) CAP = _m.getAttribute("content") || _m.content || ""; } catch (e) {}
// Origin that serves prototype assets (/work/*). A SEPARATE, token-less loopback
// origin: prototype pages (embedded sandboxed OR popped out to a real tab) are
// cross-origin from this control document, so they can't read CAP or POST /intent.
let ASSET_BASE = "";
try { const _a = document.querySelector && document.querySelector('meta[name="al-assets"]'); if (_a) ASSET_BASE = _a.getAttribute("content") || _a.content || ""; } catch (e) {}
const CAPH = CAP ? { "x-al-cap": CAP } : {};
function gfetch(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers, CAPH);
  return fetch(path, opts);
}
function capUrl(path) { return CAP ? path + (path.indexOf("?") >= 0 ? "&" : "?") + "t=" + encodeURIComponent(CAP) : path; }
let last = null;
let sending = false;
let lastState = null;   // most recent /state object (for strip nav)
let lastGoodState = null; // most recent state WITHOUT a read error (survives outages)
let viewKey = null;     // when set, panel shows a read-only review of that stage
let phaseUIKey = null;
let selectedPhaseIndex = -1;
// id -> display name for workflows in the local store, so a build's workflow:
// label can be shown as a name. Populated by the launcher's /workflows fetch.
let workflowNames = {};
let selectedPrototype = null;
let shipReviewable = false; // did the last /pr snapshot report reviewable? Gates the Ship re-enable.
let lastReviewedHeadSha = null; // exact head SHA from the PR snapshot that enabled Ship.
let prReviewGen = 0;        // generation counter so a stale /pr response can't clobber a newer render.
let idleBuildGen = 0;       // prevents a late issue-list response from repainting an active job.
let idleBuildData = null;

// Workflows configuration surface. 'workflowsOpen' is checked at the very top of
// render() so the /state poll (every 4s) and SSE nudges can't clobber the editor
// the user is typing into: once mounted, render() returns without touching the
// panel, and the page repaints itself only on its own structural interactions.
let workflowsOpen = false;
const WF = {
  mounted: false, view: "list", prims: null, list: [],
  def: null, rev: 0, sel: 0, errors: [], saving: false,
  vtimer: null, conflict: false, renameId: null, renameVal: "", listError: null,
};
// Contract interpolation variables (display hint only — not a served registry).
const CONTRACT_VARS = ["owner", "repo", "issue", "round", "branch", "base", "prTitle",
  "protoBase", "protoDir", "implDemoPath", "reviewerModel", "issueUrl", "instanceId"];

// ---- Color mode --------------------------------------------------------------
function currentMode() {
  return document.documentElement.getAttribute("data-mode") ||
    (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function applyMode(mode, opts = {}) {
  document.documentElement.setAttribute("data-mode", mode);
  try { localStorage.setItem("agentloop-mode", mode); } catch (e) {}
  const btn = $("themeToggle");
  if (btn) btn.innerHTML = svg(mode === "dark" ? "sun" : "moon", "icon-sm");
  // Persist per-user (not per-session/per-panel) so the choice survives a
  // fresh instanceId or session restart, per the canvas state-model guidance.
  // localStorage above remains a same-origin fast-path fallback only.
  if (!opts.skipPersist) {
    post("/theme", { mode }).catch(() => {});
  }
}
(function initMode() {
  // Server may have inlined the saved per-user mode into <html data-mode="...">
  // before this script ran (see renderHtml's initialMode param) — prefer that
  // over localStorage, which is only a same-page fallback.
  const inline = document.documentElement.getAttribute("data-mode");
  if (inline === "dark" || inline === "light") { applyMode(inline, { skipPersist: true }); return; }
  let saved = null;
  try { saved = localStorage.getItem("agentloop-mode"); } catch (e) {}
  applyMode(saved || currentMode(), { skipPersist: true });
})();

// ---- External links (open in system browser; _blank is inert in the webview) -
function openExternal(url) {
  if (!url) return;
  post("/open", { url }).catch(() => {});
  toast("Opening in your browser…");
}
function setReleaseInfo(open, returnFocus = false) {
  const panel = $("releaseInfo");
  const button = $("releaseInfoBtn");
  if (!panel || !button) return;
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (!open && returnFocus) button.focus();
}
document.addEventListener("click", (e) => {
  const info = $("releaseInfoBtn");
  const release = $("releaseInfo");
  if (info && (e.target === info || info.contains(e.target))) {
    setReleaseInfo(release.hidden);
    return;
  }
  if (release && !release.hidden && !release.contains(e.target)) setReleaseInfo(false);
  const t = $("themeToggle");
  if (t && (e.target === t || t.contains(e.target))) { applyMode(currentMode() === "dark" ? "light" : "dark"); return; }
  const w = $("workflowsToggle");
  if (w && (e.target === w || w.contains(e.target))) { toggleWorkflows(); return; }
  const a = e.target.closest("[data-ext]");
  if (a) { e.preventDefault(); openExternal(a.getAttribute("data-ext")); }
});
document.addEventListener("keydown", (e) => {
  const release = $("releaseInfo");
  if (e.key === "Escape" && release && !release.hidden) setReleaseInfo(false, true);
});
// Gear glyph lives outside the render loop (the appbar is static markup).
(function initTools() {
  const g = $("workflowsToggle"); if (g) g.innerHTML = svg("gear", "icon-sm");
  const i = $("releaseInfoBtn"); if (i) i.innerHTML = svg("info", "icon-sm");
  setReleaseInfo(false);
  const b = $("launcherBtn");
  if (b) { b.innerHTML = svg("back", "icon-sm"); b.onclick = backToLauncher; }
})();

// Any pipeline node already reached (backwards or current) is navigable for
// read-only review, even while a later stage runs. Forward, unreached steps lock.
function canNavigate(s, idx, curIdx) {
  return !!(s && s.active && idx <= curIdx);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// Very small markdown-ish renderer for issue prose. Block-stateful: headings,
// ordered + unordered lists, and fenced code blocks. Inline emphasis/links/code
// spans are applied per line and NEVER inside a fenced block, so code samples
// render verbatim (already HTML-escaped) instead of being mangled by the inline
// transforms. Raw HTML stays disabled (everything is escaped first).
function mdLite(s) {
  // Strip Flow Loop correlation markers (e.g. <!-- AL-OP ... -->) before
  // rendering — they're machine metadata, not human-facing prose. Scoped to the
  // AL- prefix so legitimate HTML comments in code samples survive.
  s = String(s).replace(/<!--\\s*AL-[\\s\\S]*?-->/g, "");
  const inline = (t) => t
    .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="#" data-ext="$2">$1</a>')
    .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\`(.+?)\`/g, "<code>$1</code>");
  const lines = esc(s).split("\\n");
  let out = "", listType = null, inCode = false, code = [];
  const closeList = () => { if (listType) { out += listType === "ol" ? "</ol>" : "</ul>"; listType = null; } };
  const flushCode = () => { out += "<pre><code>" + code.join("\\n") + "</code></pre>"; code = []; inCode = false; };
  for (let line of lines) {
    if (/^\\s*\`\`\`/.test(line)) {
      if (inCode) flushCode();
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    if (/^#{1,6}\\s+/.test(line)) {
      closeList();
      out += "<h3>" + inline(line.replace(/^#{1,6}\\s+/, "")) + "</h3>";
    } else if (/^\\s*[-*]\\s+/.test(line)) {
      if (listType !== "ul") { closeList(); out += "<ul>"; listType = "ul"; }
      out += "<li>" + inline(line.replace(/^\\s*[-*]\\s+/, "")) + "</li>";
    } else if (/^\\s*\\d+\\.\\s+/.test(line)) {
      if (listType !== "ol") { closeList(); out += "<ol>"; listType = "ol"; }
      out += "<li>" + inline(line.replace(/^\\s*\\d+\\.\\s+/, "")) + "</li>";
    } else {
      closeList();
      out += line.trim() ? "<p>" + inline(line) + "</p>" : "";
    }
  }
  if (inCode) flushCode(); // deterministic EOF handling for an unclosed fence
  closeList();
  return out;
}

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._to); t._to = setTimeout(() => t.classList.remove("show"), 2600);
}

async function post(path, body, method) {
  const r = await fetch(path, { method: method || "POST", headers: Object.assign({ "Content-Type": "application/json" }, CAPH), body: JSON.stringify(body || {}) });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  if (!r.ok || (data && data.ok === false)) {
    const msg = (data && (data.error || data.message)) || ("HTTP " + r.status);
    throw new Error(msg);
  }
  return data || {};
}

// ---- Structured intents ------------------------------------------------------
// The webview never authors orchestration prose. Buttons post a small intent
// object; the extension validates the live control block and owns all transitions.
let kickoffReqId = null;
function newReqId() {
  const rnd = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return "kf-" + Date.now().toString(36) + "-" + rnd;
}
function ctxFor(s, extra) {
  const base = { owner: s ? s.owner : null, repo: s ? s.repo : null,
    issue: s ? s.issue : null, controlCommentId: s ? s.controlCommentId : null,
    expectedTxn: s && s.txn != null ? s.txn : null };
  return Object.assign(base, extra || {});
}

// Single choke-point for gate submissions: guards against double-fire and reports
// failure so callers can re-enable their buttons.
let submitting = false;
async function sendIntent(kind, data, ctx) {
  if (submitting) return false;
  submitting = true;
  try {
    const payload = kind === "kickoff"
      ? { kind: "kickoff", data: data || {} }
      : Object.assign({ kind, data: data || {} }, ctx || {});
    await post("/intent", payload);
    return true;
  } catch (e) {
    toast(e && e.message ? e.message : "Flow Loop request failed.");
    return false;
  } finally {
    // Re-enable after a beat; the next /state poll will re-render the panel.
    setTimeout(() => { submitting = false; }, 1200);
  }
}

// Distinct step 'group' values in order become the stepper nodes; each node
// borrows its first step's label + icon. Falls back to the built-in six so the
// strip never blanks mid-poll before a definition has loaded.
function activeNodes(s) {
  const def = s && s.definition;
  if (def && Array.isArray(def.steps) && def.steps.length) {
    const seen = {};
    const nodes = [];
    def.steps.forEach((st) => {
      if (!seen[st.stage]) { seen[st.stage] = 1; nodes.push({ key: st.stage, label: st.label || st.stage, icon: st.icon || st.stage, phase: st.phase }); }
    });
    if (nodes.length) return nodes;
  }
  return NODES;
}

// Mirror of the coordinator's stepForIssueLabel. The live state's stage field is
// an issue label, not a stage, so it is matched against issueLabel and then
// mapped onto the step's actual stage.
function stepForIssueLabelClient(def, issueLabel, gate) {
  if (!def || !Array.isArray(def.steps)) return null;
  const steps = def.steps.filter((st) => st.issueLabel === issueLabel);
  if (gate) { const g = steps.find((st) => st.gate && st.gate.id === gate); if (g) return g; }
  return steps[0] || null;
}

// Map issue state onto a pipeline node. When a definition is present the node is
// its matching step's stage; otherwise the built-in mapping is used (gates are
// NOT separate nodes — a sign-off gate lives inside Prototype, etc.).
function currentKey(s) {
  if (!s.active) return "research";
  const def = s.definition;
  if (def && Array.isArray(def.steps) && def.steps.length) {
    const step = stepForIssueLabelClient(def, s.stage || def.entry, s.gate);
    if (step) return step.stage;
  }
  if (s.gate === "signoff") return "prototype";
  if (s.gate === "questionnaire") return "plan";
  if (s.gate === "plan-review") return "plan";
  if (s.gate === "review-points") return "review";
  if (s.gate === "feedback") return "implement";
  const st = s.stage || "research";
  if (st.indexOf("planning") === 0) return "plan";
  if (st === "implementing") return "implement";
  if (st === "finalizing") return "finalize";
  if (st === "done") return "done";
  return st; // research | prototype
}

function updateAppbar(s) {
  $("brandMark").innerHTML = svg("loop", "icon-sm");
  const meta = $("repoMeta");
  const back = $("launcherBtn");
  if (s && s.active && s.owner) {
    meta.textContent = s.owner + "/" + s.repo + " #" + s.issue;
    if (back) back.hidden = false;
  } else {
    meta.textContent = "no active job";
    if (back) back.hidden = true;
  }
}

// Detach this canvas from its build. The build is untouched on the issue — it
// keeps its stage, its pending work order and its place in the loop — so this is
// a navigation action, not a destructive one, and the same build can be reopened
// from the launcher's existing-builds list.
async function backToLauncher() {
  const btn = $("launcherBtn");
  if (btn) btn.disabled = true;
  try {
    await gfetch("/unbind", { method: "POST" });
    viewKey = null;
    if (workflowsOpen) { workflowsOpen = false; WF.mounted = false; const sw = $("stripWrap"); if (sw) sw.hidden = false; }
    lastState = null; last = null;
    await refresh();
  } catch (e) {
    toast("Could not return to the launcher.");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderStrip(s) {
  const nodes = activeNodes(s);
  const cur = currentKey(s);
  const curIdx = nodes.findIndex((n) => n.key === cur);
  if (nodes.some((node) => node.phase)) {
    const phases = [];
    nodes.forEach((node, index) => {
      const phase = node.phase || node.label;
      if (phases.at(-1)?.name !== phase) phases.push({ name: phase, nodes: [] });
      phases.at(-1).nodes.push({ ...node, index });
    });
    const currentPhaseIndex = phases.findIndex((phase) => phase.nodes.some((node) => node.index === curIdx));
    const uiKey = [s.owner, s.repo, s.issue, currentPhaseIndex].join("/");
    if (phaseUIKey !== uiKey) {
      phaseUIKey = uiKey;
      selectedPhaseIndex = Math.max(0, currentPhaseIndex);
    }
    $("strip").classList.add("phased");
    const selected = phases[selectedPhaseIndex] || phases[0];
    $("strip").innerHTML = '<div class="phase-tabs" role="tablist" aria-label="Workflow phases">' +
      phases.map((phase, phaseIndex) => {
        const notRun = s.phaseHistory?.council === "not-run" && phase.name === "Review";
        const status = notRun ? "Council not run" : phaseIndex < currentPhaseIndex ? "Completed"
          : phaseIndex === currentPhaseIndex ? (s.status === "done" ? "Done" : "Active") : "Upcoming";
        return '<button type="button" role="tab" class="phase-tab' +
          (phaseIndex === selectedPhaseIndex ? " selected" : "") +
          (phaseIndex === currentPhaseIndex ? " current" : "") +
          '" id="phase-tab-' + phaseIndex + '" data-phase="' + phaseIndex +
          '" data-index="' + String(phaseIndex + 1).padStart(2, "0") +
          '" aria-selected="' + (phaseIndex === selectedPhaseIndex) +
          '" aria-controls="phase-panel" tabindex="' + (phaseIndex === selectedPhaseIndex ? "0" : "-1") +
          '"' + (phaseIndex === currentPhaseIndex ? ' aria-current="step"' : "") +
          (phase.nodes[0].index > curIdx ? " disabled" : "") + '>' +
          esc(phase.name) + '<span class="phase-tab-status">' + esc(status) + '</span></button>';
      }).join("") + '</div>' +
      '<nav class="phase-stages" id="phase-panel" role="tabpanel" aria-labelledby="phase-tab-' +
      selectedPhaseIndex + '" aria-label="' + esc(selected.name) + ' stages" style="--stage-count:' +
      selected.nodes.length + '">' +
      selected.nodes.map((node, index) =>
        '<button type="button" class="phase-stage' +
        (node.key === "council" && s.phaseHistory?.council === "not-run" ? " skipped" : node.index < curIdx ? " done" : "") +
        (node.index === curIdx ? " active" : "") + (viewKey === node.key ? " viewing" : "") +
        '" data-nav="' + esc(node.key) + '" data-index="' + String(index + 1).padStart(2, "0") + '"' +
        (canNavigate(s, node.index, curIdx) ? "" : " disabled") +
        (node.index === curIdx ? ' aria-current="step"' : "") + '>' +
        esc(node.label) + (node.key === "council" && s.phaseHistory?.council === "not-run" ? " · Not run" : "") +
        '</button>'
      ).join("") + '</nav>';
    const tabs = Array.from($("strip").querySelectorAll(".phase-tab"));
    const choosePhase = (index) => {
      selectedPhaseIndex = index;
      viewKey = index === currentPhaseIndex ? null : phases[index].nodes.at(-1).key;
      render(lastState);
      Array.from($("strip").querySelectorAll(".phase-tab"))[index]?.focus();
    };
    tabs.forEach((el) => {
      el.onclick = () => {
        const index = Number(el.getAttribute("data-phase"));
        choosePhase(index);
      };
      el.onkeydown = (event) => {
        const enabled = tabs.filter((tab) => !tab.disabled);
        const position = enabled.indexOf(el);
        const next = event.key === "Home" ? enabled[0]
          : event.key === "End" ? enabled.at(-1)
          : event.key === "ArrowRight" ? enabled[(position + 1) % enabled.length]
          : event.key === "ArrowLeft" ? enabled[(position - 1 + enabled.length) % enabled.length]
          : null;
        if (next) {
          event.preventDefault();
          choosePhase(Number(next.getAttribute("data-phase")));
        }
      };
    });
    $("strip").querySelectorAll(".phase-stage:not(:disabled)").forEach((el) => {
      el.onclick = () => {
        const key = el.getAttribute("data-nav");
        viewKey = key === currentKey(lastState) ? null : key;
        render(lastState);
        if (viewKey) $("backBtn")?.focus();
        else Array.from($("strip").querySelectorAll(".phase-stage")).find(
          (button) => button.getAttribute("data-nav") === key)?.focus();
      };
    });
    return;
  }
  $("strip").classList.remove("phased");
  const parts = [];
  nodes.forEach((n, i) => {
    let cls = "step";
    const reached = s.active && i < curIdx;
    const isCurrent = s.active && i === curIdx;
    if (reached) cls += " done";
    if (isCurrent) { cls += " active"; if (s.gate) cls += " gate"; }
    if (s.status === "done" && n.key === "done") cls += " active";
    const canNav = canNavigate(s, i, curIdx);
    if (canNav) cls += " nav";
    if (viewKey === n.key) cls += " viewing";
    const glyph = reached ? svg("check") : svg(n.icon);
    parts.push('<div class="' + cls + '"' + (canNav ? ' data-nav="' + esc(n.key) + '"' : '') +
      '><span class="step-circle">' + glyph + '</span><span class="step-label">' + esc(n.label) + '</span></div>');
    if (i < nodes.length - 1) parts.push('<span class="step-line"></span>');
  });
  $("strip").innerHTML = parts.join("");
  $("strip").querySelectorAll(".step[data-nav]").forEach((el) => {
    el.onclick = () => {
      const k = el.getAttribute("data-nav");
      viewKey = (k === currentKey(lastState)) ? null : k;
      render(lastState);
    };
  });
}

function panelHead(eyebrowIcon, eyebrowText, title) {
  return '<div class="eyebrow">' + svg(eyebrowIcon, "icon-sm") + esc(eyebrowText) + '</div>' +
    '<h1 class="panel-title">' + esc(title) + '</h1>';
}

function buildStage(issue) {
  const labels = issue && Array.isArray(issue.labels) ? issue.labels : [];
  const gate = labels.find((label) => String(label).startsWith("gate:"));
  const stage = labels.find((label) => String(label).startsWith("stage:"));
  if (gate) return String(gate).slice(5).replace(/-/g, " ");
  if (stage) return String(stage).slice(6).replace(/-/g, " ");
  return "open";
}

// Which workflow a build runs, read from its workflow:<id> label. The label is
// absent for the built-in pipeline, exactly like the control block's reference.
function buildWorkflow(issue) {
  const labels = issue && Array.isArray(issue.labels) ? issue.labels : [];
  const wf = labels.find((label) => String(label).startsWith("workflow:"));
  const id = wf ? String(wf).slice(9) : "default";
  return { id, name: workflowNames[id] || (id === "default" ? "Default build loop" : id) };
}

function relativeUpdated(value) {
  const stamp = Date.parse(value || "");
  if (!Number.isFinite(stamp)) return "Updated recently";
  const minutes = Math.max(0, Math.floor((Date.now() - stamp) / 60000));
  if (minutes < 1) return "Updated now";
  if (minutes < 60) return "Updated " + minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return "Updated " + hours + "h ago";
  const days = Math.floor(hours / 24);
  return "Updated " + days + "d ago";
}

function renderExistingBuilds(query) {
  const list = $("buildList");
  if (!list || !idleBuildData) return;
  const q = String(query || "").trim().toLowerCase();
  const issues = (idleBuildData.issues || []).filter((issue) =>
    !q || String(issue.title || "").toLowerCase().includes(q) || String(issue.number).includes(q));
  if (!issues.length) {
    list.innerHTML = '<div class="build-empty">' + (q ? "No matching flows." : "No open flows yet.") + '</div>';
    return;
  }
  list.innerHTML = issues.map((issue) => {
    const stage = buildStage(issue);
    const wf = buildWorkflow(issue);
    return '<button class="build-item" id="buildIssue_' + esc(issue.number) + '" type="button">' +
      '<span class="build-number">#' + esc(issue.number) + '</span>' +
      '<span class="build-copy"><span class="build-title">' + esc(issue.title) + '</span>' +
      '<span class="build-wf" title="Workflow">' + svg("loop") + '<span class="build-wf-name">' + esc(wf.name) + '</span></span>' +
      '<span class="build-meta">' + esc(relativeUpdated(issue.updatedAt)) + '</span></span>' +
      '<span class="build-state"><span class="badge badge-neutral">' + esc(stage) + '</span>' +
      svg("chevron-right") + '</span></button>';
  }).join("");
  issues.forEach((issue) => {
    const button = $("buildIssue_" + issue.number);
    if (!button) return;
    button.onclick = async () => {
      button.disabled = true;
      const ok = await sendIntent("open-existing", {}, {
        owner: idleBuildData.owner, repo: idleBuildData.repo, issue: issue.number,
      });
      if (!ok) button.disabled = false;
    };
  });
}

async function loadExistingBuilds(gen) {
  const status = $("buildStatus");
  try {
    const response = await fetch("/issues", { cache: "no-store", headers: CAPH });
    let data = null;
    try { data = await response.json(); } catch (e) {}
    if (!response.ok) throw new Error((data && data.error) || ("HTTP " + response.status));
    if (gen !== idleBuildGen || (lastState && lastState.active)) return;
    idleBuildData = data || { issues: [] };
    if (status) status.textContent = "";
    renderExistingBuilds("");
    // With nothing to continue, the launcher's only useful surface is the one
    // behind the other tab. Landing on an empty list hides both the idea box and
    // the workflow choice behind a click nobody knows to make.
    if (!(idleBuildData.issues || []).length && $("newTab")) $("newTab").click();
  } catch (e) {
    if (gen !== idleBuildGen || (lastState && lastState.active)) return;
    if (status) status.innerHTML = '<div class="build-empty">Could not load existing flows. Starting a new flow is still available.</div>';
  }
}

function renderIdle() {
  const gen = ++idleBuildGen;
  idleBuildData = null;
  $("panel").innerHTML =
    '<div class="card">' +
    panelHead("loop", "Flow launcher", "Continue where you left off") +
    '<p class="sub">Open workflow state already stored in this repository, or start something new.</p>' +
    '<div class="idle-tabs" role="tablist">' +
    '<button class="idle-tab active" id="existingTab" type="button" role="tab">Existing flows</button>' +
    '<button class="idle-tab" id="newTab" type="button" role="tab">New flow</button></div>' +
    '<div class="idle-pane" id="existingPane" role="tabpanel">' +
    '<label class="field" for="buildSearch">Search open flows</label>' +
    '<input class="input build-search" id="buildSearch" placeholder="Filter by title or issue number" />' +
    '<div id="buildStatus"><div class="build-empty">Loading existing flows…</div></div>' +
    '<div class="build-list" id="buildList"></div></div>' +
    '<div class="idle-pane" id="newPane" role="tabpanel" hidden>' +
    '<p class="sub">Describe an idea. The loop researches prior art, prototypes a few real approaches, ' +
    'and brings the options back here for your sign-off. Nothing touches the code repo until the final PR.</p>' +
    '<div style="margin-top:18px"><div class="wf-pick-head">' +
    '<label class="field" for="workflowPick">Workflow</label>' +
    '<button class="btn btn-ghost sm" id="manageWfBtn" type="button">Open flow builder…</button></div>' +
    '<select class="select" id="workflowPick"><option value="default">Default build loop</option></select>' +
    '<div class="wf-pick-steps" id="workflowPreview"></div></div>' +
    '<div style="margin-top:16px"><label class="field" for="idea">Your idea</label>' +
    '<textarea class="textarea" id="idea" placeholder="e.g. A lightweight date range picker for our dashboard filters"></textarea></div>' +
    '<div class="row"><button class="btn btn-primary has-icon" id="startBtn">' + svg("send") + 'Start the flow</button>' +
    '<span class="muted" id="startHint"></span></div></div>' +
    '</div>';
  const selectTab = (name) => {
    const existing = name === "existing";
    $("existingPane").hidden = !existing;
    $("newPane").hidden = existing;
    $("existingTab").classList[existing ? "add" : "remove"]("active");
    $("newTab").classList[existing ? "remove" : "add"]("active");
  };
  $("existingTab").onclick = () => selectTab("existing");
  $("newTab").onclick = () => selectTab("new");
  $("buildSearch").oninput = () => renderExistingBuilds($("buildSearch").value);
  $("manageWfBtn").onclick = () => mountWorkflows();
  // Populate the workflow picker from the store; failure just leaves the default.
  gfetch("/workflows").then((r) => r.json()).then((d) => {
    const sel = $("workflowPick");
    if (!d || !Array.isArray(d.workflows) || !d.workflows.length) return;
    d.workflows.forEach((w) => { workflowNames[w.id] = w.name; });
    // The list may already be painted; renaming its entries needs a repaint.
    if ($("buildList") && idleBuildData) renderExistingBuilds($("buildSearch") ? $("buildSearch").value : "");
    if (!sel) return;
    const has = d.workflows.some((w) => w.id === "default");
    const opts = (has ? [] : [{ id: "default", name: "Default build loop" }]).concat(d.workflows);
    sel.innerHTML = opts.map((w) => '<option value="' + esc(w.id) + '">' + esc(w.name)
      + (w.stageCount ? ' — ' + w.stageCount + ' step' + (w.stageCount === 1 ? '' : 's') : '') + '</option>').join("");
    sel.value = "default";
    // More than one workflow is the whole point of the feature, so say so rather
    // than leaving a lone select that reads as decoration.
    if (opts.length > 1) {
      const hint = $("startHint");
      if (hint && !hint.textContent) hint.textContent = opts.length + " workflows available";
    }
    sel.onchange = () => previewWorkflow(sel.value);
    previewWorkflow(sel.value);
  }).catch(() => {});
  $("startBtn").onclick = async () => {
    const idea = $("idea").value.trim();
    if (!idea) { $("idea").focus(); return; }
    $("startBtn").disabled = true; $("startHint").textContent = "Starting deterministic workflow…";
    if (!kickoffReqId) kickoffReqId = newReqId();
    const wf = ($("workflowPick") && $("workflowPick").value) || "default";
    const ok = await sendIntent("kickoff", { idea, reqId: kickoffReqId, workflowId: wf }, {});
    if (ok) toast("Kickoff accepted — the flow is starting its first stage.");
    else { $("startBtn").disabled = false; $("startHint").textContent = ""; }
  };
  loadExistingBuilds(gen);
}

// Show the pipeline the selected workflow will actually run. Choosing between
// bare names tells the user nothing; the step chips are what make the choice
// meaningful, and they double as confirmation that a custom workflow is real.
function previewWorkflow(id) {
  const host = $("workflowPreview");
  if (!host) return;
  host.innerHTML = '<span class="muted">Loading steps…</span>';
  gfetch("/workflows/" + encodeURIComponent(id)).then((r) => r.json()).then((def) => {
    if (!$("workflowPreview")) return;
    if (!def || def.error) { host.innerHTML = '<span class="muted">' + esc((def && def.error) || "Could not load this workflow.") + '</span>'; return; }
    const steps = Array.isArray(def.steps) ? def.steps : [];
    if (!steps.length) { host.innerHTML = '<span class="muted">This workflow has no steps yet.</span>'; return; }
    host.innerHTML = steps.map((st) => {
      const gate = st.gate ? ' <span class="wf-pick-gate" title="Waits for you">gate</span>' : "";
      return '<span class="wf-pick-step">' + esc(st.label || st.id) + gate + '</span>';
    }).join('<span class="wf-pick-arrow">→</span>');
  }).catch(() => {
    if ($("workflowPreview")) host.innerHTML = '<span class="muted">Could not load this workflow.</span>';
  });
}

function renderWorking(s) {
  let brief = "";
  if (s.research && s.research.commentId) {
    brief = '<div class="brief" id="brief"><span class="muted">Loading research brief…</span></div>';
  }
  const title = s.title ? s.title : "your idea";
  // A working/error panel has no human gate, so surface a recovery action after
  // a generous timeout. Redispatch keeps earlier bounded capability hashes valid,
  // allowing an agent that was still working to submit without losing its asset.
  const STALE_MS = 15 * 60 * 1000;
  const ageMs = s.updatedAt ? (Date.now() - Date.parse(s.updatedAt)) : 0;
  const isError = s.status === "error";
  const isVerify = !!s.pending && s.pending.kind === "verify-pr";
  const stalled = !!s.pending && !s.error && ageMs > STALE_MS;
  // verify-pr is a legitimate idle wait (CI running) with no subagent — always
  // surface a Recheck immediately rather than waiting out the stale timer.
  const recover = isError || stalled || isVerify;
  const recoverBlock = recover
    ? '<div class="gate-banner recover">' + svg("gate") +
        (isError ? 'This stage hit an error and is waiting.'
          : isVerify ? 'The PR is finalized — waiting on required checks to finish.'
          : 'This stage has been quiet for a while — it may have stalled.') +
      '</div>' +
      '<div class="row" style="margin-top:12px">' +
        '<button class="btn btn-primary has-icon" id="resumeBtn">' + svg("check") +
          (isVerify ? 'Recheck PR checks' : 'Resume this stage') + '</button>' +
      '</div>'
    : "";
  const stage = activeNodes(s).find((n) => n.key === currentKey(s));
  const workingLabel = s.pipelineVersion === 2
    ? (stage ? stage.label : "Working") + " · working"
    : "Working · round " + esc(s.round || 1);
  $("panel").innerHTML =
    '<div class="card">' +
    panelHead(stage ? stage.icon : "prototype", workingLabel, title) +
    (s.issueUrl ? '<p class="sub">Issue <a class="issue-link" href="#" data-ext="' + esc(s.issueUrl) + '">#' + esc(s.issue) + svg("external") + '</a></p>' : '') +
    '<div class="status-line" role="status" aria-live="polite"><span class="spinner"></span>' + esc(s.statusText || "Working…") + '</div>' +
    (s.pipelineVersion === 2 ? "" : renderSequence(s.sequence)) +
    recoverBlock +
    brief +
    '</div>';
  if (s.research && s.research.commentId) {
    gfetch("/comment/" + s.research.commentId).then((r) => r.json()).then((c) => {
      if (c && c.body && $("brief")) $("brief").innerHTML = mdLite(c.body);
    }).catch(() => {});
  }
  if (recover) {
    const btn = $("resumeBtn");
    if (btn) btn.onclick = async () => {
      btn.disabled = true;
      const ok = await sendIntent("resume", {}, ctxFor(s));
      if (ok) toast(isVerify ? "Rechecking PR checks…" : "Resuming — recovering this stage.");
      else btn.disabled = false;
    };
  }
}

function latestRound(s) {
  if (!s.prototypeRounds || !s.prototypeRounds.length) return null;
  return s.prototypeRounds.reduce((a, b) => (b.round > a.round ? b : a));
}

// Unify structured control-block rounds and options parsed from the prototype
// comment into one { round, options } shape for the previews.
function protoData(s) {
const mapOpt = (o) => {
  // Paths are durable; absolute preview URLs contain the extension's
  // ephemeral port and must be rebuilt after a restart.
  const path = o.path || o.repoPath || null;
  const assetOrigin = ASSET_BASE || location.origin;
  return {
    id: o.id, title: o.title, pitch: o.pitch,
    previewUrl: path ? assetOrigin + "/work/" + path : (o.previewUrl || null),
    repoPath: o.repoPath || path,
  };
};
  const r = latestRound(s);
  if (r && r.options && r.options.length) {
    return {
      round: r.round,
      approved: r.approved || null,
      options: r.options.map(mapOpt),
    };
  }
  const pcs = (s.prototypeComments || []).slice().sort((a, b) => b.round - a.round);
  if (pcs.length) return { round: pcs[0].round, approved: null, options: (pcs[0].options || []).map(mapOpt) };
  return { round: s.round, approved: null, options: [] };
}

function protoSections(options, gated) {
  return options.map((o, i) =>
    '<div class="opt" data-id="' + esc(o.id) + '">' +
    '<div class="preview">' +
    (o.previewUrl
      ? '<iframe class="preview-frame" data-preview-frame="' + i + '" src="' +
        esc(o.previewUrl) + '" title="' + esc(o.title) + '" scrolling="no" ' +
        'sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>'
      : '<div style="padding:16px"><span class="muted">Preview unavailable</span></div>') +
    '</div>' +
    '<div class="meta">' +
    '<div class="t"><span class="badge badge-neutral">' + esc(o.id) + '</span>' + esc(o.title) +
    (gated ? '<span class="pick" data-pick>' + svg("check") + '</span>' : '') + '</div>' +
    '<div class="p">' + esc(o.pitch) + '</div>' +
    '<div class="links">' +
    (o.previewUrl ? '<a href="#" data-ext="' + esc(o.previewUrl) + '">' + svg("external") + 'Open full prototype</a>' : '') +
    (o.repoPath ? '<span class="muted"><code>' + esc(o.repoPath) + '</code></span>' : '') +
    '</div>' +
    (gated ? '<button type="button" class="btn btn-sm select-direction ' +
      (selectedPrototype === o.id ? "btn-primary" : "btn-secondary") + '" data-select="' + esc(o.id) + '">' +
      (selectedPrototype === o.id ? "Selected direction" : "Select this direction") + '</button>' : '') +
    '</div></div>'
  ).join("");
}

// Bind the sandboxed prototype iframes to the height-negotiation protocol. Shared
// by the built-in sign-off screen and the definition-driven option-picker widget.
function wirePrototypeFrames() {
  document.querySelectorAll("[data-preview-frame]").forEach((frame) => {
    frame.addEventListener("load", () => {
      frame.contentWindow.postMessage({ type: "prototype-size-request" }, "*");
    });
  });
  if (!window._prototypeResizeBound) {
    window._prototypeResizeBound = true;
    window.addEventListener("message", (e) => {
      if (!e.data || e.data.type !== "prototype-height") return;
      const frame = Array.from(document.querySelectorAll("[data-preview-frame]"))
        .find((el) => el.contentWindow === e.source);
      if (frame && Number.isFinite(e.data.height)) {
        // Clamp: a sandboxed prototype must not be able to force an
        // arbitrarily tall iframe (layout DoS).
        frame.style.height = Math.min(2400, Math.max(260, Math.ceil(e.data.height))) + "px";
      }
    });
  }
}

// Reflect the current selection across every option card. Kept separate from the
// click wiring so both the built-in screen and the option-picker widget paint the
// same "selected direction" affordance.
function paintOptionSelection(id) {
  selectedPrototype = id;
  document.querySelectorAll(".opt").forEach((option) => {
    const isSelected = option.getAttribute("data-id") === selectedPrototype;
    option.classList.toggle("sel", isSelected);
    const button = option.querySelector("[data-select]");
    if (button) {
      button.classList.toggle("btn-primary", isSelected);
      button.classList.toggle("btn-secondary", !isSelected);
      button.textContent = isSelected ? "Selected direction" : "Select this direction";
    }
  });
}

// Wire the option cards' select buttons. onSelect runs after the visual state is
// painted so a caller can add its own side effects (toast, selected-name label).
function wireOptionCards(onSelect) {
  document.querySelectorAll(".opt").forEach((el) => {
    const id = el.getAttribute("data-id");
    if (id === selectedPrototype) el.classList.add("sel");
    const select = el.querySelector("[data-select]");
    if (!select) return;
    select.onclick = () => { paintOptionSelection(id); if (onSelect) onSelect(id); };
  });
}

// sign-off gate this same panel grows a sticky decision bar (pick a variant +
// directing comments + approve / request-another-round). When readOnly (the
// stage has moved on and the user navigated back), the controls are omitted.
function renderPrototype(s, readOnly) {
  const { round, options } = protoData(s);
  const gated = s.gate === "signoff" && !readOnly;
  if (!selectedPrototype || !options.some((o) => o.id === selectedPrototype)) {
    selectedPrototype = options[0] ? options[0].id : null;
  }
  const previews = protoSections(options, gated);

  const head = readOnly ? reviewBar("Prototype") : "";
  const locked = !!s.pending;
  const banner = gated
    ? (locked ? lockBanner(s) : '<div class="gate-banner">' + svg("gate") + 'Human gate · choose a prototype to advance</div>')
    : "";
  const selOpt = options.find((o) => o.id === selectedPrototype) || options[0];
  const selLabel = selOpt ? (selOpt.id + " · " + selOpt.title) : "—";
  const controls = gated
    ? '<div class="decision">' +
        '<div class="sel-name">' + svg("check") + 'Selected direction: <strong id="selName">' + esc(selLabel) + '</strong></div>' +
        '<label class="field" for="refine">Directing comments — optional when approving, required when requesting another round.</label>' +
        '<textarea class="textarea" id="refine" placeholder="e.g. Keep this direction, but make the month header sticky and add a Today shortcut"' +
        (locked ? " disabled" : "") + '></textarea>' +
        '<div class="row">' +
          '<button class="btn btn-primary has-icon" id="approveBtn"' + (locked ? " disabled" : "") + '>' + svg("check") + 'Approve selected prototype</button>' +
          '<button class="btn btn-secondary" id="refineBtn"' + (locked ? " disabled" : "") + '>Request another round</button>' +
        '</div>' +
        '<p class="hint">Pick a direction above — it sets what you approve or refine.</p>' +
      '</div>'
    : "";

  $("panel").innerHTML =
    '<div class="card">' + head + banner +
    panelHead("prototype", "Prototype · round " + esc(round), s.title || "Prototypes") +
    '<p class="sub">' + options.length + ' option' + (options.length === 1 ? "" : "s") +
    ' · Issue <a class="issue-link" href="#" data-ext="' + esc(s.issueUrl) + '">#' + esc(s.issue) + svg("external") + '</a></p>' +
    (previews ? '<div class="opts">' + previews + '</div>' : '<p class="muted" style="margin-top:16px">No prototype options yet.</p>') +
    controls + '</div>';

  wirePrototypeFrames();

  if (readOnly) wireBack();
  if (!gated) return;

  wireOptionCards((id) => {
    toast("Selected " + id + " as the direction to refine.");
    const selName = $("selName");
    if (selName) {
      const opt = options.find((o) => o.id === selectedPrototype);
      selName.textContent = opt ? (opt.id + " · " + opt.title) : id;
    }
  });

  $("approveBtn").onclick = async () => {
    const id = selectedPrototype || (options[0] && options[0].id);
    if (!id) return;
    const note = ($("refine").value || "").trim();
    $("approveBtn").disabled = true; $("refineBtn").disabled = true;
    const ok = await sendIntent("approve", { optionId: id, notes: note }, ctxFor(s));
    if (ok) toast("Approved " + id + " — advancing to planning.");
    else { $("approveBtn").disabled = false; $("refineBtn").disabled = false; }
  };
  $("refineBtn").onclick = async () => {
    const fb = ($("refine").value || "").trim();
    if (!fb) { $("refine").focus(); toast("Add directing comments to request another round."); return; }
    $("approveBtn").disabled = true; $("refineBtn").disabled = true;
    const ok = await sendIntent("iterate", { feedback: fb }, ctxFor(s));
    if (ok) toast("Feedback sent — starting a new round.");
    else { $("approveBtn").disabled = false; $("refineBtn").disabled = false; }
  };
}

// Fetch an issue comment body and render it (mdLite) into a container by id.
// Load an issue comment's prose into a panel element. Guards against three
// failure modes the old fire-and-forget version ignored: a non-OK HTTP status
// (shown as a retryable error, not an eternal "Loading…"), an empty body, and a
// stale response landing after a newer render reused the same element id (each
// call bumps a per-element generation and a late resolver bails).
function loadComment(commentId, elId, onLoaded) {
  if (commentId == null) return;
  const done = (ok) => { try { if (onLoaded) onLoaded(ok); } catch (e) {} };
  const active = loadComment._active || (loadComment._active = {});
  const gen = (loadComment._gen = (loadComment._gen || 0) + 1);
  active[elId] = gen;
  const fresh = () => active[elId] === gen;
  fetch("/comment/" + commentId, { headers: CAPH })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((c) => {
      if (!fresh()) return;
      const el = $(elId);
      if (!el) return;
      const hasBody = !!(c && c.body);
      el.innerHTML = hasBody ? mdLite(c.body) : '<span class="muted">This artifact is empty.</span>';
      done(hasBody);
    })
    .catch(() => {
      if (!fresh()) return;
      const el = $(elId);
      if (!el) { done(false); return; }
      el.innerHTML = '<span class="muted">Could not load this from GitHub. </span>' +
        '<button type="button" class="btn btn-sm btn-secondary" id="' + elId + '_retry">Retry</button>';
      const rb = $(elId + "_retry");
      if (rb) rb.onclick = () => {
        const t = $(elId);
        if (t) t.innerHTML = '<span class="muted">Loading…</span>';
        loadComment(commentId, elId, onLoaded);
      };
      done(false);
    });
}

// A subtle lock banner shown if a child op is mid-flight (pending set) while a
// gate panel is visible — belt-and-suspenders against a double submit.
function lockBanner(s) {
  return s && s.pending
    ? '<div class="gate-banner">' + svg("gate") + 'A stage agent is still working — hold on…</div>'
    : "";
}

// ---- Questionnaire gate ------------------------------------------------------
// The client keeps a per-question answer model so selections survive re-renders
// (each step re-renders the panel in place). Choices are single- or multi-select
// and a free-text note is always available, so a human can pick an option AND
// add nuance. Only one question shows at a time; Back/Next walk the list and the
// final step swaps in Submit, which serializes the model into the ANSWERS prose.
let qModel = null; // { qid: { choices: Set<string>, text: string } }
let qModelKey = null; // structural signature of the questionnaire the model belongs to
let qStep = 0;

// A signature over the questions' structure (not just the comment id): if the
// questionnaire comment is edited while the human is mid-answer — a prompt or a
// choice changes — the retained model would otherwise submit stale, now-invisible
// selections. Any structural change resets the model; identical re-renders keep it.
function qSig(questions) {
  return questions.map((q) => q.id + "|" + q.select + "|" + q.prompt + "|" + (q.choices || []).join("~")).join("\\u00a7");
}
function qEnsureModel(questions) {
  const key = qSig(questions);
  if (qModel && qModelKey === key) return;
  qModel = {};
  for (const qq of questions) qModel[qq.id] = { choices: new Set(), text: "" };
  qModelKey = key;
  qStep = 0;
}

// Serialize one question's picks + free-text note into the answer prose. Shared
// by the built-in questionnaire stepper and the definition-driven question-form
// widget so both produce byte-identical ANSWERS payloads.
function composeAnswer(picks, note) {
  note = (note || "").trim();
  // Quote multiple selections so a choice label that itself contains a comma
  // (e.g. "SQLite, Postgres") can't be misread as two separate picks.
  let sel = "";
  if (picks.length === 1) sel = picks[0];
  else if (picks.length > 1) sel = picks.map((p) => "\\u201c" + p + "\\u201d").join(", ");
  if (sel && note) return sel + " — " + note;
  return sel || note;
}

function qAnswerText(qq) {
  const m = (qModel && qModel[qq.id]) || { choices: new Set(), text: "" };
  return composeAnswer(Array.from(m.choices), m.text);
}

// Render a question's choice rows. 'chosen' is the Set of currently-picked
// labels; 'prefix' namespaces the input ids so the built-in stepper ("qc_") and
// the definition-driven question-form widget ("gwq_") can't collide.
function choiceRowsHtml(qq, chosen, multi, prefix) {
  const inputType = multi ? "checkbox" : "radio";
  return (qq.choices || []).map((c, i) => {
    const cid = prefix + qq.id + "_" + i;
    const on = chosen.has(c);
    return '<label class="choice' + (on ? " on" : "") + '" for="' + cid + '">' +
      '<span class="choice-mark ' + (multi ? "box" : "dot") + (on ? " on" : "") + '">' + (on ? svg("check") : "") + '</span>' +
      '<input class="choice-input" type="' + inputType + '" name="' + prefix + esc(qq.id) + '" id="' + cid + '" data-choice="' + esc(c) + '"' + (on ? " checked" : "") + '>' +
      '<span class="choice-text">' + esc(c) + '</span></label>';
  }).join("");
}

function renderQuestionnaire(s, readOnly) {
  const q = s.questionnaire || null;
  const questions = (q && q.questions) || [];
  const gated = s.gate === "questionnaire" && !readOnly;
  const locked = !!s.pending;
  const head = readOnly ? reviewBar("Plan") : "";
  const banner = gated ? '<div class="gate-banner">' + svg("gate") + 'Human gate · answer to shape the plan</div>' : lockBanner(s);
  const answered = s.answers && s.answers.commentId;

  // Read-only (or no live gate): show the whole questionnaire as a static list so
  // the plan-review screen and history stay reviewable.
  if (!gated || locked || !questions.length) {
    const list = questions.map((qq) =>
      '<div class="qitem"><div class="qprompt"><span class="badge badge-neutral">' + esc(qq.id) +
      '</span> ' + esc(qq.prompt) + '</div>' +
      (qq.choices && qq.choices.length
        ? '<ul class="qchoices-ro">' + qq.choices.map((c) => '<li>' + esc(c) + '</li>').join("") + '</ul>'
        : '') + '</div>'
    ).join("");
    $("panel").innerHTML =
      '<div class="card">' + head + banner +
      panelHead("plan", "Planning · questionnaire", s.title || "Clarifying questions") +
      '<p class="sub">' + questions.length + ' question' + (questions.length === 1 ? "" : "s") +
      (s.issueUrl ? ' · Issue <a class="issue-link" href="#" data-ext="' + esc(s.issueUrl) + '">#' + esc(s.issue) + svg("external") + '</a>' : '') + '</p>' +
      (questions.length ? '<div class="qlist">' + list + '</div>'
        : '<p class="muted" style="margin-top:16px">No questions parsed yet.</p>') +
      (answered ? '<div class="brief" id="answersBrief"><span class="muted">Loading your answers…</span></div>' : '') +
      '</div>';
    if (readOnly) wireBack();
    if (answered) loadComment(s.answers.commentId, "answersBrief");
    return;
  }

  qEnsureModel(questions);
  paintQuestionStep(s, questions);
}

// Renders a single question step and wires its inputs + navigation. Re-invoked
// on every Back/Next so the panel always reflects qStep and the answer model.
// focusStep is set only by Back/Next so keyboard/screen-reader users land on
// the new question instead of the top of the panel; a choice-toggle re-render
// (same step) must NOT steal focus from the control the user just activated.
function paintQuestionStep(s, questions, focusStep, focusChoice) {
  if (qStep < 0) qStep = 0;
  if (qStep > questions.length - 1) qStep = questions.length - 1;
  const qq = questions[qStep];
  const m = qModel[qq.id] || (qModel[qq.id] = { choices: new Set(), text: "" });
  const isLast = qStep === questions.length - 1;
  const multi = qq.select === "multi";

  const choiceRows = choiceRowsHtml(qq, m.choices, multi, "qc_");

  const noteLabel = (qq.choices && qq.choices.length)
    ? (multi ? "Add a note or other option (optional)" : "Other / add a note (optional)")
    : "Your answer";

  const nav =
    '<div class="row qnav">' +
      '<button class="btn btn-secondary" id="qBackBtn"' + (qStep === 0 ? " disabled" : "") + '>' + svg("chevron-left") + 'Back</button>' +
      (isLast
        ? '<button class="btn btn-primary has-icon" id="answersBtn">' + svg("send") + 'Submit answers</button>'
        : '<button class="btn btn-primary has-icon" id="qNextBtn">Next' + svg("chevron-right") + '</button>') +
    '</div>';

  $("panel").innerHTML =
    '<div class="card">' +
      '<div class="gate-banner">' + svg("gate") + 'Human gate · answer to shape the plan</div>' +
      panelHead("plan", "Planning · questionnaire", s.title || "Clarifying questions") +
      '<div class="qprogress"><div class="qprogress-meta"><span>Question ' + (qStep + 1) + ' of ' + questions.length + '</span>' +
        (s.issueUrl ? '<a class="issue-link" href="#" data-ext="' + esc(s.issueUrl) + '">#' + esc(s.issue) + svg("external") + '</a>' : '') + '</div>' +
        '<div class="qbar"><span style="width:' + Math.round(((qStep + 1) / questions.length) * 100) + '%"></span></div></div>' +
      '<div class="qstep">' +
        '<div class="qstep-prompt" id="qStepPrompt" tabindex="-1"><span class="badge badge-neutral">' + esc(qq.id) + '</span> ' + esc(qq.prompt) + '</div>' +
        (choiceRows ? '<div class="choices' + (multi ? " multi" : "") + '">' + choiceRows + '</div>' : '') +
        '<label class="field" for="qtext" style="margin-top:' + (choiceRows ? "16px" : "4px") + '">' + esc(noteLabel) + '</label>' +
        '<textarea class="textarea qa" id="qtext" placeholder="' + (choiceRows ? "Anything to add…" : "Your answer…") + '"></textarea>' +
      '</div>' +
      nav +
      '<p class="hint">Blank answers are fine — the plan agent will use its judgment.</p>' +
    '</div>';

  // Wire choices → answer model.
  (qq.choices || []).forEach((c, i) => {
    const el = $("qc_" + qq.id + "_" + i);
    if (!el) return;
    el.onclick = () => {
      if (multi) {
        if (m.choices.has(c)) m.choices.delete(c); else m.choices.add(c);
      } else {
        m.choices.clear(); m.choices.add(c);
      }
      paintQuestionStep(s, questions, false, i); // re-render to reflect selection, keep focus on this choice
    };
  });

  const note = $("qtext");
  if (note) {
    note.value = m.text || "";
    note.oninput = () => { m.text = note.value; };
  }

  const back = $("qBackBtn");
  if (back) back.onclick = () => { qStep -= 1; paintQuestionStep(s, questions, true); };
  const next = $("qNextBtn");
  if (next) next.onclick = () => { qStep += 1; paintQuestionStep(s, questions, true); };

  // Move focus to the new question when navigating steps (not on a same-step
  // choice re-render), so keyboard/AT users aren't dropped back to the top.
  if (focusStep) { const fp = $("qStepPrompt"); if (fp && fp.focus) fp.focus(); }
  // On a same-step choice toggle, keep keyboard focus on the choice the user just
  // activated instead of dropping it after the panel is rebuilt.
  if (focusChoice != null) { const ci = $("qc_" + qq.id + "_" + focusChoice); if (ci && ci.focus) ci.focus(); }

  const submit = $("answersBtn");
  if (submit) submit.onclick = async () => {
    submit.disabled = true;
    const answers = questions.map((qqq) => ({ id: qqq.id, prompt: qqq.prompt, answer: qAnswerText(qqq) }));
    const ok = await sendIntent("answers", { answers }, ctxFor(s));
    if (ok) { qModel = null; qModelKey = null; qStep = 0; toast("Answers sent — drafting the plan."); }
    else submit.disabled = false;
  };
}

// ---- Plan sequence tracker ---------------------------------------------------
// The plan stage runs three named steps in order: draft → review → synthesis.
// Rendering all three up front (including the ones that have not started) is the
// point: when a run dies, the human can see WHICH step died instead of being
// handed a generic "the panel failed". The data behind this is ephemeral — it
// lives in the canvas server's memory, never on the issue — so it simply
// disappears once the run finishes and the durable evidence takes over.
const SEQ_STEPS = [
  ["draft", "Draft plan", "Turns the research, prototype notes and your answers into numbered clauses."],
  ["review", "Independent review", "A fresh context reads only the evidence packet — no conversation history, no draft author."],
  ["synthesis", "Synthesis", "Merges the review into the draft, then hands you the result."],
];

function fmtDur(ms) {
  if (!(ms >= 0)) return "";
  if (ms < 1000) return Math.round(ms) + "ms";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function seqElapsed(step) {
  if (!step || !step.startedAt) return "";
  const end = step.endedAt ? Date.parse(step.endedAt) : Date.now();
  const start = Date.parse(step.startedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? fmtDur(end - start) : "";
}

function renderSequence(seq) {
  if (!seq || !seq.steps) return "";
  const glyph = { done: "✓", reused: "✓", running: "●", failed: "!" };
  return '<div class="seq" role="list">' + SEQ_STEPS.map(([key, title, blurb], i) => {
    const step = seq.steps[key] || {};
    const state = step.state || "waiting";
    const time = seqElapsed(step);
    const side = [];
    if (step.model) side.push('<span class="seq-model">' + esc(step.model) + '</span>');
    if (time) side.push('<span class="seq-time">' + esc(time) + '</span>');
    return '<div class="seq-step" role="listitem" data-state="' + esc(state) + '">' +
      '<span class="seq-dot" aria-hidden="true">' + (glyph[state] || String(i + 1)) + '</span>' +
      '<div class="seq-main">' +
        '<div class="seq-title">' + esc(title) + '</div>' +
        '<div class="seq-sub">' + esc(step.detail || blurb) + '</div>' +
        (state === "running" ? '<div class="seq-bar"><i></i></div>' : "") +
      '</div>' +
      '<div class="seq-side">' + side.join("") + '</div>' +
      '</div>';
  }).join("") + '</div>';
}

// The gate is reached after the run has ended, so the live tracker is already
// gone. Rebuild the same three steps from the durable panel record: the human
// should see the same shape of thing before and after, and a review that failed
// stays visible at the gate instead of being reduced to a one-line warning.
function sequenceFromPanel(s) {
  const p = s.panel || {};
  if (!p.rev && !p.failed && !p.skipped) return null;
  const clauses = Array.isArray(s.planClauses) ? s.planClauses.length : 0;
  const reviewer = (Array.isArray(p.models) && p.models[0]) || s.panelReviewer || {};
  const findings = (p.reviews || []).reduce((n, r) => n + ((r.risks || []).length + (r.omissions || []).length), 0);
  const reviewed = !p.failed && !p.skipped;
  const review = reviewed
    ? { state: "done", model: reviewer.model, detail: findings ? findings + " finding" + (findings === 1 ? "" : "s") + " raised." : "No blocking findings." }
    : { state: "failed", model: reviewer.model,
        detail: p.failedCode === "review-not-started"
          ? "The host admitted no subagent, so the reviewer never ran."
          : p.skipped ? "Reviews are unavailable on this host." : String(p.failed || "The review did not complete.") };
  return { steps: {
    draft: { state: "done", detail: clauses ? clauses + " clause" + (clauses === 1 ? "" : "s") + " drafted." : "Draft plan posted." },
    review,
    synthesis: reviewed
      ? { state: "done", model: p.synthesisModel || reviewer.model, detail: p.disagreements ? p.disagreements + " finding" + (p.disagreements === 1 ? "" : "s") + " rejected with a recorded reason." : "Review applied to the draft." }
      : { state: "waiting", detail: "Skipped — there was nothing to synthesize." },
  } };
}

// ---- Plan-review gate --------------------------------------------------------
// The human steers at the OUTPUT level: every clause can be pinned (frozen
// byte-for-byte), sent back with an instruction, or dropped. A send-back re-runs
// synthesis only — the review is reused, not re-billed.
function renderProvenance(s) {
  const p = s.panel || {};
  const reviewer = s.panelReviewer ? [s.panelReviewer] : [];
  const models = Array.isArray(p.models) && p.models.length ? p.models : reviewer;
  const bits = [];
  if (models.length) {
    bits.push('<span class="prov-models">' + svg("gate") +
      models.map((m) => '<code>' + esc(m.model || m.id) + '</code>').join('<span class="sep">+</span>') +
      '</span>');
    bits.push('<span class="prov-fresh">fresh context · no prior history</span>');
  }
  if (p.synthesisModel) bits.push('<span class="prov-fresh">synthesis <code>' + esc(p.synthesisModel) + '</code></span>');
  if (p.rev) bits.push('<span class="prov-fresh">rev ' + esc(p.rev) + '</span>');
  if (p.disagreements) bits.push('<span class="prov-fresh">' + esc(p.disagreements) + ' finding' + (p.disagreements === 1 ? '' : 's') + ' rejected</span>');
  if (p.evidenceCommentId) bits.push('<button class="chip" id="evidenceBtn" aria-expanded="false">Full review</button>');
  // With one reviewer there is no quorum to hide behind: an unreviewed plan is
  // stated as such rather than shaded as "degraded".
  if (p.failed) {
    bits.push('<span class="prov-warn">⚠ ' + esc(p.failedCode === "review-not-started"
      ? "The reviewer never started — the host did not admit a subagent for it."
      : "The review failed (" + p.failed + ").") +
      ' This is the unreviewed draft.</span>');
  }
  if (p.skipped) bits.push('<span class="prov-warn">⚠ Review unavailable — this draft was not reviewed.</span>');
  if (!bits.length) return "";
  return '<div class="prov">' + bits.join("") + '</div>' +
    (p.evidenceCommentId ? '<div class="brief" id="evidenceBrief" hidden></div>' : "");
}

function renderClauseList(clauses, quotes, locked) {
  return '<div class="clauses" id="clauseList">' + clauses.map((c, i) => {
    const q = (quotes && quotes[c.id]) || c.quotes || [];
    const dis = locked ? " disabled" : "";
    return '<div class="clause" data-id="' + esc(c.id) + '" data-act="keep">' +
      '<div class="clause-top">' +
        '<span class="clause-num">' + String(i + 1).padStart(2, "0") + '</span>' +
        '<span class="clause-title">' + esc(c.title) + '</span>' +
      '</div>' +
      '<div class="clause-text">' + esc(c.text) + '</div>' +
      '<div class="clause-acts">' +
        '<button class="chip" data-act="pin" aria-pressed="false"' + dis + '>Pin</button>' +
        '<button class="chip" data-act="send-back" aria-pressed="false"' + dis + '>Send back</button>' +
        '<button class="chip" data-act="drop" aria-pressed="false"' + dis + '>Drop</button>' +
        (q.length ? '<button class="chip evi" data-act="evidence" aria-expanded="false">Evidence (' + q.length + ')</button>' : '') +
      '</div>' +
      '<div class="clause-instruct" hidden>' +
        '<textarea class="textarea" rows="2" placeholder="What should change about this clause?"' + dis + '></textarea>' +
      '</div>' +
      (q.length ? '<div class="clause-evidence" hidden>' + q.map((x) =>
        '<div class="quote"><span class="quote-who' + (x.severity ? ' sev-' + esc(x.severity) : '') + '">' +
        esc(x.reviewerId || "panel") + '</span><span>' + esc(x.text) + '</span></div>').join("") + '</div>' : '') +
      '</div>';
  }).join("") + '</div>';
}

// Wire the pin / send-back / drop / evidence chips on a rendered clause list.
// Shared by the built-in plan-review screen and the clause-pins widget; onChange
// (optional) lets a caller recompute its own counts/enablement after each toggle.
function wireClauseList(listEl, decisions, onChange) {
  if (!listEl) return;
  listEl.onclick = (e) => {
    const btn = e.target.closest(".chip");
    if (!btn || btn.disabled) return;
    const row = btn.closest(".clause");
    const act = btn.dataset.act;
    if (act === "evidence") {
      const box = row.querySelector(".clause-evidence");
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", open ? "false" : "true");
      box.hidden = open;
      return;
    }
    const already = btn.getAttribute("aria-pressed") === "true";
    row.querySelectorAll('.chip[aria-pressed]').forEach((b) => b.setAttribute("aria-pressed", "false"));
    const next = already ? "keep" : act;
    if (!already) btn.setAttribute("aria-pressed", "true");
    row.dataset.act = next;
    decisions.set(row.dataset.id, next);
    row.querySelector(".clause-instruct").hidden = next !== "send-back";
    if (next === "send-back") row.querySelector(".clause-instruct textarea").focus();
    if (onChange) onChange();
  };
}

// Collapse a decisions Map into the DECISIONS payload the plan-steer intent
// expects: only clauses actually acted on, each carrying its send-back note.
function clauseDecisionsPayload(listEl, decisions) {
  return [...decisions.entries()]
    .filter((e) => e[1] !== "keep")
    .map((e) => {
      const row = listEl ? listEl.querySelector('.clause[data-id="' + e[0] + '"]') : null;
      const instr = row ? (row.querySelector(".clause-instruct textarea").value || "").trim() : "";
      return { clauseId: e[0], action: e[1], instruction: instr };
    });
}

function renderIndependentReview(s, readOnly) {
  const review = s.review || {};
  const points = Array.isArray(review.points) ? review.points : [];
  const gated = s.gate === "review-points" && !readOnly && !s.pending;
  const missing = points.filter((p) => !p.decision).length;
  const failed = !!review.failed || !!s.reviewError;
  const error = s.reviewError || review.chatError?.message || review.synthesisError;
  const canRedraft = gated && review.draftCommentId &&
    !Object.keys(review.decisions || {}).length &&
    !Object.values(review.threads || {}).some((thread) => thread.length);
  $("panel").innerHTML =
    '<div class="card">' + (readOnly ? reviewBar("Review") : "") +
    (gated ? '<div class="gate-banner">' + svg("gate") + 'Human gate · decide each recommendation before synthesis</div>' : lockBanner(s)) +
    panelHead("plan", "Review · independent model", s.title || "Plan review") +
    '<p class="sub">Draft by ' + esc(review.authorModel || "unknown model") +
      ' · reviewer ' + esc(review.reviewer && review.reviewer.model || s.panelReviewer && s.panelReviewer.model || "unknown") +
      ' · ' + points.length + ' point' + (points.length === 1 ? "" : "s") +
      (review.verdict ? ' · verdict ' + esc(review.verdict) : "") + '</p>' +
    (review.strengths?.length ? '<p class="sub">Strengths: ' + review.strengths.map(esc).join(" · ") + '</p>' : "") +
    (error ? '<p class="prov-warn" role="alert">' + esc(error) + '</p>' : "") +
    (failed && gated ? '<button class="btn btn-secondary" id="reviewRetryBtn">Retry independent review</button>' : "") +
    (canRedraft ? '<details class="review-redraft"><summary>Plan needs a different direction?</summary>' +
      '<label class="field" for="reviewPlanFeedback">Tell the planner what to refocus on</label>' +
      '<textarea class="textarea" id="reviewPlanFeedback" maxlength="2000" placeholder="Focus on the requested product, not the Flow Loop canvas…"></textarea>' +
      '<button class="btn btn-secondary" type="button" id="reviewRedraftBtn">Redraft plan and review</button></details>' : "") +
    (!review.commentId && review.draftCommentId
      ? '<div class="brief" id="draftBrief"><span class="muted">Loading draft plan…</span></div>' : "") +
    (review.commentId && !points.length && !s.reviewError
      ? '<p class="muted">Reviewer recommended no changes. Continue to synthesis.</p>' : "") +
    '<div class="review-points" role="list">' + points.map((point) => {
      const id = esc(point.id);
      const choice = point.decision || "";
      const interactive = gated && !failed && !s.reviewError;
      return '<section class="review-point" role="listitem" data-decision="' + esc(choice) + '" id="point_' + id + '">' +
        '<div class="clause-top"><span class="clause-num">' + id + '</span><strong class="clause-title">' +
          esc(point.kind) + (point.severity ? ' · ' + esc(point.severity) : '') +
          (point.clauseId ? ' · ' + esc(point.clauseId) : '') + '</strong></div>' +
        '<p class="point-evidence">' + esc(point.evidence) + '</p>' +
        '<div class="recommendation"><strong>Recommendation</strong><br>' + esc(point.recommendation) + '</div>' +
        (point.messages && point.messages.length
          ? '<div class="point-thread" aria-label="Earlier reviewer exchange for ' + id + '">' +
            point.messages.map((msg) => '<div class="point-message" data-role="' + esc(msg.role) + '">' +
              '<strong>' + (msg.role === "user" ? "You" : "Reviewer") + '</strong><br>' + esc(msg.text) + '</div>').join("") + '</div>'
          : "") +
        (choice ? '<p class="hint">Decision: <strong>' + esc(choice) + '</strong>' +
          (point.instruction ? ' · ' + esc(point.instruction) : "") + '</p>' : "") +
        (interactive ? '<div class="clause-acts">' +
          '<button class="chip" type="button" id="accept_' + id + '" aria-pressed="' + (choice === "accept") + '">Accept</button>' +
          '<button class="chip" type="button" id="ignore_' + id + '" aria-pressed="' + (choice === "ignore") + '">Ignore</button>' +
          '<button class="chip" type="button" id="modify_' + id + '" aria-expanded="' + (choice === "modify") + '">Modify</button></div>' +
          '<div class="point-edit" id="modifyBox_' + id + '"' + (choice === "modify" ? "" : " hidden") + '>' +
            '<label class="field" for="instruction_' + id + '">What should synthesis change?</label>' +
            '<textarea class="textarea" maxlength="1000" id="instruction_' + id + '">' + esc(point.instruction || "") + '</textarea>' +
            '<button class="btn btn-secondary" type="button" id="saveModify_' + id + '">Save modification</button></div>'
          : "") + '</section>';
    }).join("") + '</div>' +
    (gated && review.commentId && !failed && !s.reviewError
      ? '<div class="decision"><span id="reviewCount">' + missing + ' undecided</span>' +
        '<div class="row"><button class="btn btn-primary" type="button" id="synthesizeBtn"' +
        (missing ? ' disabled' : '') + '>Synthesize final plan</button></div></div>' : "") +
    '</div>';
  if (readOnly) wireBack();
  if (!review.commentId && review.draftCommentId) loadComment(review.draftCommentId, "draftBrief");
  const retry = $("reviewRetryBtn");
  if (retry) retry.onclick = async () => {
    retry.disabled = true;
    if (!await sendIntent("review-retry", {}, ctxFor(s))) retry.disabled = false;
  };
  const redraft = $("reviewRedraftBtn");
  if (redraft) redraft.onclick = async () => {
    const input = $("reviewPlanFeedback");
    const feedback = input.value.trim();
    if (!feedback) { input.focus(); toast("Describe the change to the product plan."); return; }
    redraft.disabled = true;
    if (!await sendIntent("review-redraft", { feedback }, ctxFor(s))) redraft.disabled = false;
  };
  if (!gated || failed || s.reviewError) return;
  points.forEach((point) => {
    const id = point.id;
    const decide = async (decision, instruction = "") => {
      const row = $("point_" + id);
      const editor = $("modifyBox_" + id);
      const modifyButton = $("modify_" + id);
      const wasOpen = !editor.hidden;
      if (decision !== "modify") {
        editor.hidden = true;
        modifyButton.setAttribute("aria-expanded", "false");
      }
      row.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      if (!await sendIntent("review-decision", { pointId: id, decision, instruction }, ctxFor(s))) {
        if (decision !== "modify" && wasOpen) {
          editor.hidden = false;
          modifyButton.setAttribute("aria-expanded", "true");
        }
        row.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      }
    };
    $("accept_" + id).onclick = () => decide("accept");
    $("ignore_" + id).onclick = () => decide("ignore");
    $("modify_" + id).onclick = () => {
      const box = $("modifyBox_" + id);
      box.hidden = false; $("modify_" + id).setAttribute("aria-expanded", "true");
      $("instruction_" + id).focus();
    };
    $("saveModify_" + id).onclick = () => {
      const instruction = $("instruction_" + id).value.trim();
      if (!instruction) { $("instruction_" + id).focus(); toast("Describe the modification."); return; }
      decide("modify", instruction);
    };
  });
  const next = $("synthesizeBtn");
  if (next) next.onclick = async () => {
    next.disabled = true;
    if (!await sendIntent("review-continue", {}, ctxFor(s))) next.disabled = false;
  };
}

function renderPlanReview(s, readOnly) {
  const gated = s.gate === "plan-review" && !readOnly;
  const locked = !!s.pending;
  const head = readOnly ? reviewBar("Plan") : "";
  const banner = gated ? '<div class="gate-banner">' + svg("gate") + 'Human gate · steer the plan clause by clause, then approve</div>' : lockBanner(s);
  const hasPlan = s.plan && s.plan.commentId;
  const clauses = Array.isArray(s.planClauses) ? s.planClauses : [];
  const quotes = (s.panel && s.panel.quotes) || {};
  const failed = !!(s.panel && s.panel.failed);

  // A review that never happened gets its own decision point, ahead of the
  // clause gate. Retrying re-runs step 2 against this same draft (no redraft);
  // continuing is allowed, but only as a deliberate act rather than the default.
  const retryBlock = gated && failed
    ? '<div class="decision" id="reviewRetry">' +
        '<div class="row">' +
          '<button class="btn btn-primary" id="retryReviewBtn"' + (locked ? " disabled" : "") + '>Retry review</button>' +
          (s.pipelineVersion === 3 ? "" : '<button class="btn btn-secondary" id="continueUnreviewedBtn"' + (locked ? " disabled" : "") + '>Continue unreviewed</button>') +
        '</div>' +
        '<p class="hint">Retrying reviews the draft above again — it does not rewrite it.</p>' +
        '</div>'
    : "";

  const controls = gated
    ? '<div class="decision"' + (retryBlock ? ' id="planDecision" hidden' : '') + '>' +
        '<div class="clause-counts" id="clauseCounts"></div>' +
        '<label class="field" for="planFb">Whole-plan changes — optional when approving, required when requesting a full re-review.</label>' +
        '<textarea class="textarea" id="planFb" placeholder="e.g. Split step 3 into migration + backfill, and call out the rollback path"' +
        (locked ? " disabled" : "") + '></textarea>' +
        '<div class="row">' +
          '<button class="btn btn-primary has-icon" id="planOkBtn" disabled>' + svg("check") + 'Approve plan &amp; build</button>' +
          '<button class="btn btn-secondary" id="planSteerBtn" disabled>Re-run with my notes</button>' +
          '<button class="btn btn-secondary" id="planReviseBtn"' + (locked ? " disabled" : "") + '>Request changes</button>' +
        '</div>' +
        (hasPlan ? '' : '<p class="hint">Approve unlocks once the plan artifact is posted.</p>') +
        '</div>'
    : "";

  $("panel").innerHTML =
    '<div class="card">' + head + banner +
    panelHead("plan", s.pipelineVersion >= 2 ? "Synthesize · final plan" : "Planning · plan review", s.title || "Implementation plan") +
    (s.issueUrl ? '<p class="sub">Issue <a class="issue-link" href="#" data-ext="' + esc(s.issueUrl) + '">#' + esc(s.issue) + svg("external") + '</a></p>' : '') +
    (readOnly && s.phaseHistory?.from === 2 && s.review?.commentId
      ? '<button class="btn btn-secondary" type="button" id="historicReviewBtn">View earlier plan-review recommendations</button>' : '') +
    (s.pipelineVersion === 2 ? "" : renderSequence(sequenceFromPanel(s))) +
    renderProvenance(s) +
    (clauses.length ? renderClauseList(clauses, quotes, locked || !gated)
      : hasPlan ? '<div class="brief" id="planBrief"><span class="muted">Loading the plan…</span></div>'
      : '<p class="muted" style="margin-top:16px">No plan artifact yet.</p>') +
    retryBlock + controls + '</div>';

  if (readOnly) wireBack();
  const historicReview = $("historicReviewBtn");
  if (historicReview) historicReview.onclick = () => {
    viewKey = "review";
    render(lastState);
    $("backBtn")?.focus();
  };

  const retryBtn = $("retryReviewBtn");
  if (retryBtn) retryBtn.onclick = async () => {
    retryBtn.disabled = true;
    const ok = await sendIntent("plan-retry-review", {}, ctxFor(s));
    if (ok) toast("Retrying the review on this draft…");
    else retryBtn.disabled = false;
  };
  const contBtn = $("continueUnreviewedBtn");
  if (contBtn) contBtn.onclick = () => {
    const block = $("reviewRetry"); if (block) block.hidden = true;
    const dec = $("planDecision"); if (dec) dec.hidden = false;
    const fb = $("planFb"); if (fb) fb.focus();
  };

  const evBtn = $("evidenceBtn");
  if (evBtn) evBtn.onclick = () => {
    const box = $("evidenceBrief");
    const open = evBtn.getAttribute("aria-expanded") === "true";
    evBtn.setAttribute("aria-expanded", open ? "false" : "true");
    box.hidden = open;
    if (!open && !box.dataset.loaded) {
      box.dataset.loaded = "1";
      box.innerHTML = '<span class="muted">Loading the review…</span>';
      loadComment(s.panel.evidenceCommentId, "evidenceBrief");
    }
  };

  // Fail closed: Approve stays disabled until the plan is actually on screen, so
  // the human can never green-light a plan they were unable to read.
  if (!clauses.length && hasPlan) loadComment(s.plan.commentId, "planBrief", (ok) => {
    if (!gated || locked) return;
    const b = $("planOkBtn"); if (b) b.disabled = !ok;
  });
  if (!gated || locked) return;

  const decisions = new Map();
  const refresh = () => {
    const vals = [...decisions.values()];
    const sent = vals.filter((d) => d === "send-back").length;
    const dropped = vals.filter((d) => d === "drop").length;
    const pinned = vals.filter((d) => d === "pin").length;
    const counts = $("clauseCounts");
    if (counts) counts.textContent = clauses.length ? clauses.length + ' clauses · ' + pinned + ' pinned · ' + sent + ' sent back · ' + dropped + ' dropped' : "";
    const steer = $("planSteerBtn");
    if (steer) steer.disabled = !(sent || dropped);
    // Approving while clauses are still sent back would ship text the human has
    // already rejected, so Approve is held until the re-run lands.
    const ok = $("planOkBtn");
    if (ok && clauses.length) ok.disabled = !!(sent || dropped);
  };
  if (clauses.length) { $("planOkBtn").disabled = false; refresh(); }

  const list = $("clauseList");
  wireClauseList(list, decisions, refresh);

  const setBusy = (v) => {
    for (const id of ["planOkBtn", "planSteerBtn", "planReviseBtn"]) { const b = $(id); if (b) b.disabled = v; }
    if (!v) refresh();
  };

  $("planOkBtn").onclick = async () => {
    if ($("planOkBtn").disabled) return; // fail-closed: plan not loaded / not visible
    const note = ($("planFb").value || "").trim();
    setBusy(true);
    const ok = await sendIntent("plan-ok", { notes: note }, ctxFor(s));
    if (ok) toast("Plan approved — starting the build.");
    else setBusy(false);
  };

  $("planSteerBtn").onclick = async () => {
    const payload = clauseDecisionsPayload(list, decisions);
    const missing = payload.find((d) => d.action === "send-back" && !d.instruction);
    if (missing) {
      const row = list.querySelector('.clause[data-id="' + missing.clauseId + '"]');
      row.querySelector(".clause-instruct textarea").focus();
      toast("Tell the panel what to change about that clause.");
      return;
    }
    setBusy(true);
    const ok = await sendIntent("plan-steer", { decisions: payload }, ctxFor(s));
    if (ok) toast("Re-synthesizing with your notes — the reviews are reused.");
    else setBusy(false);
  };

  $("planReviseBtn").onclick = async () => {
    const fb = ($("planFb").value || "").trim();
    if (!fb) { $("planFb").focus(); toast("Add the changes you want before requesting a revision."); return; }
    setBusy(true);
    const ok = await sendIntent("plan-revise", { feedback: fb }, ctxFor(s));
    if (ok) toast("Sent — the panel will review a new draft.");
    else setBusy(false);
  };
}

// ---- Feedback gate -----------------------------------------------------------
// Colour the aggregate CI state. "unknown" (read failed) and "none" (confirmed
// no checks) are deliberately distinct so a read failure never looks green.
function ciBadge(checks) {
  const state = (checks && checks.state) || "unknown";
  const map = {
    passed: ["badge-sage", "Checks passing"],
    failed: ["badge-rust", "Checks failing"],
    pending: ["badge-amber", "Checks running"],
    none: ["badge-neutral", "No checks reported"],
    unknown: ["badge-neutral", "Checks unknown"],
  };
  const m = map[state] || map.unknown;
  let label = m[1];
  const c = checks && checks.counts;
  if (c && (state === "failed" || state === "pending") && (c.fail || c.pending)) {
    label += " (" + (c.fail ? c.fail + " failing" : c.pending + " running") + ")";
  }
  return '<span class="badge ' + m[0] + '">' + esc(label) + '</span>';
}

// Render a unified-diff patch with per-line colouring. The marker is read from
// the RAW line before escaping, so escaping can never change classification.
function diffHtml(patch) {
  return String(patch).split("\\n").map((raw) => {
    const ch = raw.charAt(0);
    const cls = (raw.slice(0, 2) === "@@") ? "diff-hunk"
      : ch === "+" ? "diff-add"
      : ch === "-" ? "diff-del" : "";
    return '<span class="dl ' + cls + '">' + (esc(raw) || " ") + "</span>";
  }).join("");
}

function fileDiff(f) {
  const stat = [];
  if (f.additions != null) stat.push("+" + f.additions);
  if (f.deletions != null) stat.push("-" + f.deletions);
  const meta = [f.status, stat.join(" ")].filter(Boolean).join(" · ");
  const head = "<summary><code>" + esc(f.path) + "</code>" +
    (meta ? ' <span class="muted">' + esc(meta) + "</span>" : "") + "</summary>";
  let body;
  if (f.noPatch) body = '<p class="muted">No inline diff (binary, too large, or unavailable).</p>';
  else body = '<pre class="diff">' + diffHtml(f.patch) +
    (f.patchTruncated ? '<span class="dl muted">… (diff truncated)</span>' : "") + "</pre>";
  return '<details class="file">' + head + body + "</details>";
}

function renderPrSnapshot(snap) {
  if (!snap || snap.available === false) {
    if (snap && snap.reason === "no-pr") return '<p class="muted">No PR is linked to this issue yet.</p>';
    return '<span class="muted">Could not load the PR from GitHub. </span>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="prRetry">Retry</button>';
  }
  const parts = [];
  if (snap.headMovedFromReview)
    parts.push('<div class="gate-banner recover">' + svg("gate") + 'The PR moved since you last reviewed it — re-review before shipping.</div>');
  else if (snap.stale)
    parts.push('<div class="gate-banner recover">' + svg("gate") + 'The PR changed while loading — Refresh to review the current revision.</div>');
  else if (snap.unpinned)
    parts.push('<div class="gate-banner recover">' + svg("gate") + 'This build has no pinned reviewed revision, so Ship stays locked — request a fresh build to pin the head.</div>');
  if (snap.requiredChecks && !["passed", "absent"].includes(snap.requiredChecks.state))
    parts.push('<div class="gate-banner recover">' + svg("gate") + 'Required checks are not confirmed passing: ' +
      esc(snap.requiredChecks.state) + '.</div>');
  const sum = [];
  if (snap.changedFiles != null) sum.push(snap.changedFiles + " file" + (snap.changedFiles === 1 ? "" : "s") + " changed");
  if (snap.additions != null) sum.push("+" + snap.additions);
  if (snap.deletions != null) sum.push("-" + snap.deletions);
  parts.push('<div class="pr-summary">' + ciBadge(snap.checks) +
    (snap.isDraft ? '<span class="badge badge-neutral">Draft</span>' : "") +
    (sum.length ? '<span class="muted">' + esc(sum.join(" · ")) + "</span>" : "") +
    '<button type="button" class="btn btn-sm btn-secondary" id="prRefresh">Refresh</button></div>');
  if (snap.files && snap.files.length) {
    parts.push('<div class="files">' + snap.files.map(fileDiff).join("") + "</div>");
    if (snap.truncatedFiles)
      parts.push('<p class="muted">Showing the first ' + esc(snap.shownFiles) + ' files. Open the PR on GitHub for the rest.</p>');
  } else {
    parts.push('<p class="muted">No changed files reported.</p>');
  }
  return parts.join("");
}

// Fetch and render the head-pinned PR snapshot into #prReview. Ship is treated as
// fail-closed: it is DISABLED before this resolves, stays disabled on any error or
// non-reviewable snapshot, and is only enabled after a successful snapshot that is
// explicitly available && reviewable. A generation guard discards a stale response
// (e.g. an earlier Refresh landing after a newer one) so it can't flip Ship open.
function loadPrReview(s, gated) {
  const host = $("prReview");
  if (!host) return;
  const gen = ++prReviewGen;
  if (gated) { shipReviewable = false; lastReviewedHeadSha = null; const sb = $("shipBtn"); if (sb) sb.disabled = true; }
  const rewire = () => {
    const rt = $("prRetry"); if (rt) rt.onclick = () => reload();
    const rf = $("prRefresh"); if (rf) rf.onclick = () => reload();
  };
  const reload = () => {
    if (gated) { shipReviewable = false; lastReviewedHeadSha = null; const sb = $("shipBtn"); if (sb) sb.disabled = true; }
    const h = $("prReview"); if (h) h.innerHTML = '<span class="muted">Loading the PR…</span>';
    loadPrReview(s, gated);
  };
  const wantPr = s && s.impl ? s.impl.prNumber : null;
  fetch("/pr", { headers: CAPH })
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((snap) => {
      if (gen !== prReviewGen) return; // a newer load superseded this one
      // Job-identity guard: never paint a snapshot for a different owner/repo/
      // issue/PR than the one this panel is bound to. The active pointer is global
      // and can move under a second canvas instance, and a bare PR number is not
      // unique across repos — so compare the whole identity, not just the number.
      const mismatch = (a, b) => a != null && b != null && String(a) !== String(b);
      if (snap && snap.available !== false && (
        mismatch(snap.prNumber, wantPr) ||
        mismatch(snap.owner, s && s.owner) ||
        mismatch(snap.repo, s && s.repo) ||
        mismatch(snap.issue, s && s.issue))) return;
      // Fail-closed identity for Ship: enabling merge requires the snapshot to
      // POSITIVELY carry the full owner/repo/issue/PR identity matching this
      // panel. A missing field is treated as untrusted (never enables Ship),
      // since the server now always stamps identity on a live /pr snapshot.
      const idComplete = !!(snap && s &&
        String(snap.prNumber) === String(wantPr) &&
        String(snap.owner) === String(s.owner) &&
        String(snap.repo) === String(s.repo) &&
        String(snap.issue) === String(s.issue));
      const h = $("prReview");
      if (!h) return;
      h.innerHTML = renderPrSnapshot(snap);
      rewire();
      if (gated) {
        const council = s.pipelineVersion === 3 ? s.council : null;
        const blockers = (council?.findings || []).some((finding) =>
          finding.category === "security" && ["critical", "high"].includes(finding.severity));
        const councilReady = s.pipelineVersion !== 3 ||
          !!(council?.commentId && !council.failed && council.headSha === snap?.headRefOid &&
            (!blockers || council.waiver?.headSha === snap.headRefOid) &&
            !Object.values(council.decisions || {}).some((decision) => decision.status === "manual-fix") &&
            ["passed", "absent"].includes(snap.requiredChecks?.state));
        const refreshBtn = $("councilRefreshBtn");
        if (s.pipelineVersion === 3 && refreshBtn) {
          refreshBtn.hidden = !(snap?.headRefOid && council?.headSha && snap.headRefOid !== council.headSha &&
            snap.available !== false && idComplete);
        }
        const ok = !!(snap && snap.available !== false && snap.reviewable === true && idComplete && councilReady);
        shipReviewable = ok;
        lastReviewedHeadSha = ok ? (snap.headRefOid || null) : null;
        const ship = $("shipBtn");
        if (ship) ship.disabled = !ok;
      }
    })
    .catch(() => {
      if (gen !== prReviewGen) return;
      if (gated) { shipReviewable = false; lastReviewedHeadSha = null; const sb = $("shipBtn"); if (sb) sb.disabled = true; }
      const h = $("prReview");
      if (!h) return;
      h.innerHTML = '<span class="muted">Could not load the PR from GitHub. </span>' +
        '<button type="button" class="btn btn-sm btn-secondary" id="prRetry">Retry</button>';
      rewire();
    });
}

// The "Try it out" affordance at the feedback gate. Machine verification (CI)
// lives in the PR snapshot; this block is the HANDS-ON path and is portable
// across project types via a preview descriptor the implement agent declares:
//   impl.preview = { kind:"web"|"command"|"none", path?, run?:[], notes? }
// web  → an interactive sandboxed iframe of the built artifact (served from the
//        per-issue asset origin, same as prototypes);
// command/none → run steps + the deterministic branch. Every kind also offers
// the universal "Open PR in a session" path so non-web work (native app, API,
// CLI, library) can be checked out and run however that project runs.
function tryItBlock(s, impl, branch, readOnly) {
  const prNo = impl && impl.prNumber;
  if (!prNo) return "";
  const p = impl && impl.preview ? impl.preview : null;
  const kind = p && p.kind ? p.kind : "none";
  const assetOrigin = ASSET_BASE || location.origin;
  let body = "";
  const webKind = kind === "web";
  if (webKind && p && p.path) {
    const url = assetOrigin + "/work/" + p.path;
    body +=
      '<div class="preview"><iframe class="demo-frame" src="' + esc(url) + '" title="Live demo" ' +
      'sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></div>' +
      '<div class="links" style="margin-top:8px"><a href="#" data-ext="' + esc(url) + '">' +
      svg("external") + 'Open the demo</a></div>';
  } else if (webKind) {
    // A web descriptor missing its path renders honestly, not as an empty block.
    body += '<p class="muted">The interactive demo is not available for this build — ' +
      'review the diff below or open the PR in a session.</p>';
  }
  if (p && Array.isArray(p.run) && p.run.length) {
    body += '<div class="run-steps"><span class="muted">Run it locally:</span><ol>' +
      p.run.map((c) => '<li><code>' + esc(String(c)) + '</code></li>').join("") + '</ol></div>';
  }
  if (p && p.notes) body += '<p class="muted" style="margin-top:10px">' + esc(p.notes) + '</p>';
  body += '<div class="branch">Branch <code>' + esc(branch) + '</code></div>';
  if (!readOnly) {
    body += '<div class="row" style="margin-top:10px">' +
      '<button type="button" class="btn btn-secondary has-icon" id="reviewLocalBtn">' +
      svg("external") + 'Open PR in a session</button></div>';
  }
  const label = webKind ? "Try it out" : "Try it out locally";
  // Demo-freshness caption from state alone (synchronous, re-pin-proof): compare
  // the head the demo was BUILT at (preview.headSha, stamped at Build Ready) to
  // the CURRENT reviewed pin (impl.headSha). They diverge only when the pin
  // advanced without a rebuild — e.g. a SHIP head-adopt or a Finalize that moved
  // the head — in which case the on-disk demo predates the reviewed revision.
  // (headMovedFromReview compares live-tip vs pin, a different axis that goes
  // false right after a re-pin, so it must NOT drive this caption.)
  const builtAt = p && p.headSha ? String(p.headSha) : null;
  const pinnedAt = impl && impl.headSha ? String(impl.headSha) : null;
  const stale = !!(builtAt && pinnedAt && builtAt !== pinnedAt);
  const roundN = esc(impl.round || s.implRound || 1);
  const foot = webKind && p && p.path
    ? '<p class="hint" id="demoNote">' + (stale
        ? "Heads up — the reviewed revision has advanced since this demo was built. " +
          "It shows implement round " + roundN + ", not the current PR head."
        : "This demo is the build from implement round " + roundN + ".") + '</p>'
    : "";
  return '<div class="tryit"><div class="t">' + label + '</div>' + body + foot + '</div>';
}

function renderFeedback(s, readOnly, section = "feedback") {
  const phased = s.pipelineVersion === 3;
  const buildOnly = phased && section === "build";
  const councilOnly = phased && section === "council";
  const showBuild = !phased || buildOnly;
  const showPrReview = !buildOnly && !councilOnly;
  const gated = s.gate === "feedback" && !readOnly && !buildOnly && !councilOnly;
  const locked = !!s.pending;
  const head = readOnly ? reviewBar(buildOnly ? "Build" : councilOnly ? "Council" : phased ? "Feedback" : "Implement") : "";
  const banner = gated ? '<div class="gate-banner">' + svg("gate") + 'Human gate · review the PR, then ship or request changes</div>' : lockBanner(s);
  const impl = s.impl || null;
  const prNo = impl && impl.prNumber;
  const prUrl = impl && impl.prUrl;
  const noPr = !prNo;
  const branch = (impl && impl.branch) || ("agent-loop/issue-" + s.issue);
  const council = s.pipelineVersion === 3 ? s.council : null;
  const findings = Array.isArray(council?.findings) ? council.findings : [];
  const blockers = findings.filter((finding) =>
    finding.category === "security" && ["critical", "high"].includes(finding.severity));
  const decisions = council?.decisions || {};
  const manualFix = Object.values(decisions).some((decision) => decision.status === "manual-fix");
  const summary = council?.summary;
  const history = Array.isArray(s.councilHistory) ? s.councilHistory : [];
  // Per-finding AI-fix tracking survives Council re-review (which replaces
  // the current findings array with fresh ids), so look it up from the
  // archived round that actually requested it, most recent first.
  const aiFixRecord = (id) => {
    for (let i = history.length - 1; i >= 0; i--) {
      const rec = history[i].aiFixByFinding?.[id];
      if (rec) return rec;
    }
    return null;
  };
  const councilLink = (id) => 'https://github.com/' + encodeURIComponent(s.owner) + '/' +
    encodeURIComponent(s.repo) + '/issues/' + encodeURIComponent(s.issue) + '#issuecomment-' + encodeURIComponent(id);
  const detail = (label, value) => value ? '<p><strong>' + label + ':</strong> ' + esc(value) + '</p>' : '';
  const counts = (keys, values) => keys.filter((key) => values?.[key]).map((key) =>
    esc(key) + ' ' + esc(values[key])).join(' · ');
  const findingContext = (finding) => {
    const content = detail("Patch excerpt", finding.snippet) +
      detail("Affected users/data", finding.affected) +
      detail("Prerequisites", finding.prerequisites) +
      (finding.cvss != null ? detail("CVSS estimate", finding.cvss +
        (finding.cvssVector ? ' (' + finding.cvssVersion + ', ' + finding.cvssVector + ')' : '')) : '') +
      detail("CVE", finding.cve) +
      detail("CWE suggestion", finding.cwe) +
      detail("OWASP suggestion", finding.owasp &&
        finding.owasp.edition + ' ' + finding.owasp.category + ' — ' + finding.owasp.rationale) +
      detail("PCI DSS suggestion (not an audit)", finding.pci &&
        'v' + finding.pci.version + ' requirement ' + finding.pci.requirement +
        '; scope: ' + finding.pci.scopeEvidence + '; rationale: ' + finding.pci.rationale) +
      detail("Exploit context", finding.exploit) +
      detail("Regression test", finding.regressionTest) + detail("Trade-off", finding.tradeoff);
    return content ? '<details class="finding-context"><summary>More evidence</summary>' + content + '</details>' : '';
  };
  const councilHtml = !phased || buildOnly ? "" :
    '<section aria-label="Code Council findings">' + (councilOnly ? "" : '<h2>Code Council</h2>') +
    (s.phaseHistory?.council === "not-run"
      ? '<p class="sub">Council was not run for this completed v2 build. Earlier PR feedback remains in issue history.</p>'
      : !summary ? '<p class="sub">Reviewing PR head <code>' + esc(council?.headSha || "not reviewed") +
        '</code>' + (council?.failed ? "" : ' · ' + findings.length + ' findings') + '</p>' : '') +
    (summary ? '<div class="council-overview" aria-label="Council summary">' +
      '<p class="council-totals"><strong>' + findings.length + ' ' +
        (findings.length === 1 ? 'finding' : 'findings') + '</strong><span>' +
        esc(summary.coverage?.reviewedFiles || 0) + ' changed files reviewed</span><code title="PR head ' +
        esc(council?.headSha || "") + '">PR ' + esc((council?.headSha || "").slice(0, 7)) + '</code>' +
        (blockers.length ? '<span class="prov-warn">' + blockers.length + ' blocking security ' +
          (blockers.length === 1 ? 'finding' : 'findings') + '</span>' : '') + '</p>' +
      '<p class="council-scope">AI reviewed PR changes. Test runs and compliance are not verified here.</p>' +
      '<div class="council-counts">' +
        (counts(["critical", "high", "medium", "low"], summary.severityCounts)
          ? '<span><strong>Severity:</strong> ' +
            counts(["critical", "high", "medium", "low"], summary.severityCounts) + '</span>' : '') +
        (counts(["security", "code-quality", "test-coverage", "linting"], summary.categoryCounts)
          ? '<span><strong>Areas:</strong> ' +
            counts(["security", "code-quality", "test-coverage", "linting"], summary.categoryCounts) + '</span>' : '') +
        (!councilOnly && findings.length ? '<span><strong>Decisions:</strong> ' +
          counts(["open", "manual-fix", "accept-risk", "not-applicable"],
            Object.fromEntries(["open", "manual-fix", "accept-risk", "not-applicable"].map((key) =>
              [key, findings.filter((finding) => (decisions[finding.id]?.status || "open") === key).length]))) +
          '</span>' : '') + '</div>' +
      '<details class="council-meta"><summary>Checks at review</summary>' +
      detail("Required", summary.checks?.state === "unknown" ? "unknown — verify before shipping"
        : summary.checks?.state === "absent" ? "none configured at review"
        : summary.checks?.missing?.length ? 'not passing: ' + summary.checks.missing.join(', ')
        : "all required checks passed at review") +
      detail("Reported", (summary.checks?.reported || []).length
        ? summary.checks.reported.map((check) => check.name + ': ' + check.phase).join('; ')
        : "none reported (not run or unavailable)") +
      '</details></div>' : '') +
    (council?.failed ? '<p role="alert" class="prov-warn">' + esc(council.failed) + '</p>' : '') +
    (council?.waiver ? '<p class="prov-warn">Security findings explicitly waived: ' + esc(council.waiver.reason) + '</p>' : '') +
    (manualFix ? '<p class="prov-warn">Manual fixes pending: Ship blocked until a new PR head is reviewed.</p>' : '') +
    (gated ? '<button class="btn btn-secondary" id="councilRefreshBtn" type="button" hidden>Review changed PR head</button>' : '') +
    (council?.commentId ? '<p><a class="issue-link" href="#" data-ext="' + esc(councilLink(council.commentId)) +
      '">Full Council report</a></p>' : '') +
    (history.length ? '<details><summary>Previous Council reviews (' + history.length + ')</summary><ul>' +
      history.map((entry) => '<li><a class="issue-link" href="#" data-ext="' + esc(councilLink(entry.commentId)) +
        '">PR head ' + esc(entry.headSha) + '</a> · ' +
        esc(Object.keys(entry.decisions || {}).length) + ' decision(s)' +
        (Object.keys(entry.decisions || {}).length || entry.aiFix ? '<ul>' +
          Object.entries(entry.decisions || {}).map(([id, decision]) =>
            '<li>' + esc(id) + ': ' + esc(decision.status) + ' — ' + esc(decision.reason) +
            (decision.owner ? ' (owner ' + esc(decision.owner) + ')' : '') +
            (decision.commentId ? ' <a class="issue-link" href="#" data-ext="' +
              esc(councilLink(decision.commentId)) + '">Record</a>' : '') + '</li>').join('') +
          (entry.aiFix ? '<li>AI fix requested for ' + esc(entry.aiFix.findingIds.join(', ')) +
            ' <a class="issue-link" href="#" data-ext="' + esc(councilLink(entry.aiFix.commentId)) +
            '">Request</a></li>' : '') + '</ul>' : '') + '</li>').join('') + '</ul></details>' : '') +
    '<div class="council-findings">' + findings.map((finding) =>
      '<div class="council-finding"><div class="finding-head"><label>' +
      (gated ? '<input type="checkbox" class="fix-choice" value="' + esc(finding.id) +
        '"' + (locked ? " disabled" : "") + '> ' : '') +
      '<strong>' + esc(finding.id) + ' · ' + esc(finding.severity) + ' ' +
      esc(finding.category) + '</strong></label>' +
      '<span class="finding-location">' + esc(finding.file || "PR") +
        (finding.line ? ':' + esc(finding.line) : '') +
        (finding.confidence ? ' · ' + esc(finding.confidence) + ' confidence' : '') + '</span></div>' +
      '<p><strong>Evidence:</strong> ' + esc(finding.evidence) + '</p>' +
      '<p><strong>Impact:</strong> ' + esc(finding.impact) + '</p>' +
      '<p><strong>Fix:</strong> ' + esc(finding.remediation) + '</p>' +
      findingContext(finding) +
      detail("Decision", decisions[finding.id]?.status && decisions[finding.id].status !== "open"
        ? decisions[finding.id].status +
        (decisions[finding.id]?.owner ? ' · owner ' + decisions[finding.id].owner : '') +
        (decisions[finding.id]?.reason ? ' · ' + decisions[finding.id].reason : '') : null) +
      (decisions[finding.id]?.commentId ? '<p><a class="issue-link" href="#" data-ext="' +
        esc(councilLink(decisions[finding.id].commentId)) + '">Decision record</a></p>' : '') +
      (aiFixRecord(finding.id) ? '<p>AI fix requested (round ' + esc(aiFixRecord(finding.id).round) +
        ') <a class="issue-link" href="#" data-ext="' + esc(councilLink(aiFixRecord(finding.id).commentId)) +
        '">Request</a></p>' : '') +
      (gated && !locked ? '<div class="finding-actions">' +
        '<button class="btn btn-secondary ai-fix-one" type="button" data-finding="' + esc(finding.id) +
        '">AI fix this finding</button><details class="finding-decision"><summary>Record decision</summary>' +
        '<div class="finding-decision-fields"><label class="field" for="councilStatus-' + esc(finding.id) +
        '">Decision</label><select class="select" id="councilStatus-' + esc(finding.id) +
        '">' + [["open", "Open"], ["manual-fix", "Manual fix"], ["accept-risk", "Accept risk"],
          ["not-applicable", "Not applicable"]].map(([value, label]) =>
          '<option value="' + value + '"' + ((decisions[finding.id]?.status || "open") === value ? " selected" : "") +
          '>' + label + '</option>').join("") + '</select>' +
        '<label class="field" for="councilOwner-' + esc(finding.id) + '">Owner (manual fix)</label>' +
        '<input class="input" maxlength="100" id="councilOwner-' + esc(finding.id) + '" value="' +
        esc(decisions[finding.id]?.owner || '') + '">' +
        '<label class="field" for="councilReason-' + esc(finding.id) + '">Reason (required, 10–1000 characters)</label>' +
        '<textarea class="textarea" maxlength="1000" id="councilReason-' + esc(finding.id) + '"></textarea>' +
        '<button class="btn btn-secondary councilDecisionBtn" type="button" data-finding="' + esc(finding.id) +
        '">Save decision</button></div></details></div>' : '') + '</div>'
    ).join("") + '</div>' +
    (gated && findings.length ? '<button class="btn btn-secondary" type="button" id="aiFixBtn">AI fix selected</button>' : '') +
    (gated && blockers.length && !council?.waiver
      ? '<label class="field" for="waiverReason">Explicit security waiver reason (10–1000 characters)</label>' +
        '<textarea class="textarea" maxlength="1000" id="waiverReason"></textarea>' +
        '<button class="btn btn-secondary" type="button" id="waiveCouncilBtn">Waive blocking findings</button>'
      : '') + '</section>';

  const prRow = prUrl
    ? '<div class="meta-row">Pull request <a class="issue-link" href="#" data-ext="' + esc(prUrl) + '">#' + esc(prNo) + svg("external") + '</a></div>'
    : (impl && impl.commentId ? '' : '<p class="muted" style="margin-top:16px">No PR linked yet.</p>');
  const reviewLocal = phased && showPrReview && !readOnly && prNo
    ? '<div class="row"><button type="button" class="btn btn-secondary has-icon" id="reviewLocalBtn">' +
      svg("external") + 'Open PR in a session</button></div>' : "";

  const controls = gated
    ? '<div class="decision">' +
        '<label class="field" for="revFb">Requested changes — optional when shipping, required when requesting changes.</label>' +
        '<textarea class="textarea" id="revFb" placeholder="e.g. Add a test for the empty-state, and tighten the aria-live copy"' +
        (locked ? " disabled" : "") + '></textarea>' +
        '<div class="row">' +
          '<button class="btn btn-primary has-icon" id="shipBtn" disabled>' + svg("check") + 'Ship it</button>' +
          '<button class="btn btn-secondary" id="reviseBtn"' + (locked ? " disabled" : "") + '>Request changes</button>' +
        '</div>' +
        (noPr ? '<p class="hint">Ship unlocks once a PR is linked to this issue.</p>' : '') +
        '</div>'
    : "";

  $("panel").innerHTML =
    '<div class="card">' + head + banner +
    panelHead(buildOnly ? "implement" : councilOnly ? "plan" : "implement",
      buildOnly ? "Build · implementation round " + esc(s.implRound || 1)
        : councilOnly ? "Review · Code Council"
        : phased ? "Review · Feedback · round " + esc(s.implRound || 1)
        : "Implement · review round " + esc(s.implRound || 1),
      councilOnly ? "Code Council findings" : s.title || (buildOnly ? "Build ready" : "Review PR")) +
    (s.issueUrl ? '<p class="sub">Issue <a class="issue-link" href="#" data-ext="' + esc(s.issueUrl) + '">#' + esc(s.issue) + svg("external") + '</a></p>' : '') +
    (!councilOnly ? prRow : '') +
    reviewLocal +
    (showBuild && impl && impl.commentId ? '<div class="brief" id="buildBrief"><span class="muted">Loading the build summary…</span></div>' : '') +
    (showBuild && impl ? tryItBlock(s, impl, branch, readOnly) : '') +
    councilHtml +
    (showPrReview && prNo ? '<div class="pr-review" id="prReview"><span class="muted">Loading the PR…</span></div>' : '') +
    controls + '</div>';

  if (readOnly) wireBack();
  if (showBuild && impl && impl.commentId) loadComment(impl.commentId, "buildBrief");
  if (showPrReview && prNo) loadPrReview(s, gated && !locked);
  const refreshCouncil = $("councilRefreshBtn");
  if (refreshCouncil && gated) refreshCouncil.onclick = async () => {
    refreshCouncil.disabled = true;
    if (!await sendIntent("council-refresh", {}, ctxFor(s))) refreshCouncil.disabled = false;
  };
  if (gated && !locked) document.querySelectorAll(".councilDecisionBtn").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-finding");
      const status = $("councilStatus-" + id).value;
      const owner = $("councilOwner-" + id).value.trim();
      const reason = $("councilReason-" + id).value.trim();
      if (reason.length < 10 || (status === "manual-fix" && !owner)) {
        $("councilReason-" + id).focus();
        toast("Add a reason (10+ characters) and an owner for manual fixes.");
        return;
      }
      btn.disabled = true;
      if (!await sendIntent("council-decision", { findingId: id, status, owner, reason }, ctxFor(s))) {
        btn.disabled = false;
      }
    };
  });
  if (gated && !locked) document.querySelectorAll(".ai-fix-one").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-finding");
      btn.disabled = true;
      if (!await sendIntent("ai-fix", { findingIds: [id] }, ctxFor(s))) btn.disabled = false;
    };
  });
  const aiFix = $("aiFixBtn");
  if (aiFix) aiFix.onclick = async () => {
    const findingIds = Array.from(document.querySelectorAll(".fix-choice:checked")).map((input) => input.value);
    if (!findingIds.length) { toast("Select Council findings to fix."); return; }
    aiFix.disabled = true;
    if (!await sendIntent("ai-fix", { findingIds }, ctxFor(s))) aiFix.disabled = false;
  };
  const waive = $("waiveCouncilBtn");
  if (waive) waive.onclick = async () => {
    const reason = $("waiverReason").value.trim();
    if (reason.length < 10) { $("waiverReason").focus(); toast("Explain the security waiver."); return; }
    waive.disabled = true;
    if (!await sendIntent("waive-council", { reason }, ctxFor(s))) waive.disabled = false;
  };
  const rlBtn = $("reviewLocalBtn");
  if (rlBtn && !readOnly) {
    rlBtn.onclick = async () => {
      rlBtn.disabled = true; // guard against a double-fire while the prompt is in flight
      const ok = await sendIntent("review-local", { prNumber: prNo || null }, ctxFor(s));
      if (ok) toast("Opening the PR in a session…");
      // Re-enable either way: REVIEW-LOCAL changes no durable state, so a poll
      // won't re-render this button — and it is idempotent (open_pr_session
      // focuses the existing session), so it must stay repeatable.
      rlBtn.disabled = false;
    };
  }
  if (!gated || locked) return;

  $("shipBtn").onclick = async () => {
    if ($("shipBtn").disabled) return; // fail-closed: PR missing or head moved
    const note = ($("revFb").value || "").trim();
    $("shipBtn").disabled = true; $("reviseBtn").disabled = true;
    const ok = await sendIntent("ship", { prNumber: prNo || null, reviewedHeadSha: lastReviewedHeadSha || (impl && impl.headSha) || null, notes: note }, ctxFor(s));
    if (ok) toast("Shipping — finalizing the PR.");
    else { $("shipBtn").disabled = !shipReviewable; $("reviseBtn").disabled = false; }
  };
  $("reviseBtn").onclick = async () => {
    const fb = ($("revFb").value || "").trim();
    if (!fb) { $("revFb").focus(); toast("Add the changes you want before requesting a revision."); return; }
    $("shipBtn").disabled = true; $("reviseBtn").disabled = true;
    const ok = await sendIntent("revise", { prNumber: prNo || null, feedback: fb }, ctxFor(s));
    if (ok) toast("Sent — revising the PR.");
    else { $("shipBtn").disabled = false; $("reviseBtn").disabled = false; }
  };
}

function renderCouncil(s, readOnly) {
  if (readOnly && s.pipelineVersion === 3 && s.council?.commentId && !s.council.failed) {
    renderFeedback(s, true, "council");
    return;
  }
  $("panel").innerHTML = '<div class="card">' + (readOnly ? reviewBar("Council") : lockBanner(s)) +
    panelHead("plan", "Review · Code Council", s.title || "Independent code review") +
    (s.phaseHistory?.council === "not-run"
      ? '<p>Council was not run for this completed v2 build. No code-review findings are claimed.</p>'
      : s.council?.failed ? '<p class="prov-warn" role="alert">' + esc(s.council.failed) + '</p>'
      : '<p>Reviewing code quality, security, test coverage, and linting against the PR head.</p>') +
    (!readOnly && s.gate === "council-retry"
      ? '<button class="btn btn-primary" type="button" id="councilRetryBtn">Retry Council</button>' : '') + '</div>';
  if (readOnly) wireBack();
  const retry = $("councilRetryBtn");
  if (retry) retry.onclick = async () => {
    retry.disabled = true;
    if (!await sendIntent("council-retry", {}, ctxFor(s))) retry.disabled = false;
  };
}


function renderDone(s, readOnly) {
  const head = readOnly ? reviewBar("Done") : "";
  const impl = s.impl || null;
  const prUrl = impl && impl.prUrl;
  const prNo = impl && impl.prNumber;
  $("panel").innerHTML =
    '<div class="card">' + head +
    '<div class="done-icon">' + svg("done", "icon-lg") + '</div>' +
    panelHead("done", "Shipped", s.title || "Done") +
    '<p class="sub">' + esc(s.statusText || "The build is finalized and ready to merge.") + '</p>' +
    (s.approved ? '<div class="meta-row">Approved prototype <span class="badge badge-sage">' + esc(s.approved) + '</span></div>' : '') +
    (prUrl ? '<div class="meta-row">Pull request <a class="issue-link" href="#" data-ext="' + esc(prUrl) + '">#' + esc(prNo) + svg("external") + '</a></div>' : '') +
    (prNo ? '<div class="pr-review" id="prReview"><span class="muted">Loading the finalized PR…</span></div>' : '') +
    '<p class="muted" style="margin-top:14px">The loop is complete: research → prototype → plan → implement → finalize. ' +
    'The finalized PR is ready for your review and merge.</p>' +
    '<div class="row">' +
    (prUrl ? '<a class="issue-link" href="#" data-ext="' + esc(prUrl) + '">Open PR to merge' + svg("external") + '</a>' : '') +
    '<a class="issue-link" href="#" data-ext="' + esc(s.issueUrl) + '">View issue #' + esc(s.issue) + svg("external") + '</a>' +
    (readOnly ? '' : '<button class="btn btn-secondary has-icon" id="doneLauncherBtn" type="button">' + svg("back") + 'Start another flow</button>') +
    '</div>' +
    '</div>';
  if (readOnly) wireBack();
  else { const b = $("doneLauncherBtn"); if (b) b.onclick = backToLauncher; }
  // Reuse the head-pinned PR snapshot so the human can eyeball the final diff and
  // CI here before merging. Not gated (no Ship button on Done), so it only renders.
  if (prNo) loadPrReview(s, false);
}

// ---- Generic gate (definition-driven, non-built-in gates) --------------------
// The built-in four gates keep their bespoke screens; any other gate an author
// declares is rendered from its widget + action lists. Each widget resolves its
// data from the same read model /state serves and, where the built-in screens
// already solve an interaction, reuses their markup + wiring rather than forking
// it. Every widget contributes to one merged payload sent by the gate's actions,
// so an authored gate that reuses a built-in capability produces a payload the
// backend already understands. A type that genuinely can't be supported degrades
// to a note instead of crashing the gate.
const GENERIC_WIDGETS = {
  "markdown-view": 1, "option-picker": 1, "question-form": 1,
  "clause-pins": 1, "pr-review": 1, textarea: 1, checklist: 1,
};

// The comment id backing a widget's 'source'. Built-in artifact names (research,
// plan, questionnaire…) live at the top level of the read model; an authored
// step's own asset is recorded under its step id in 'artifacts'.
function artifactCommentId(s, source, step) {
  if (source && s[source] && s[source].commentId != null) return s[source].commentId;
  if (source && s.artifacts && s.artifacts[source] && s.artifacts[source].commentId != null) return s.artifacts[source].commentId;
  if (step && s.artifacts && s.artifacts[step.id] && s.artifacts[step.id].commentId != null) return s.artifacts[step.id].commentId;
  return null;
}

function btnClassForStyle(style) {
  return style === "primary" ? "btn btn-primary"
    : style === "ghost" ? "btn btn-ghost btn-sm"
    : "btn btn-secondary";
}

// Live-repaint one question-form question: reuses the built-in choice markup, and
// mirrors its "click the input, re-render, re-wire" cycle so a hidden radio/
// checkbox stays visually in sync via the .choice-mark glyph.
function wireGenericQuestion(qq, set, multi) {
  const paint = () => {
    const cont = $("gwqc_" + qq.id);
    if (cont) cont.innerHTML = choiceRowsHtml(qq, set, multi, "gwq_");
    (qq.choices || []).forEach((c, k) => {
      const el = $("gwq_" + qq.id + "_" + k);
      if (!el) return;
      el.onclick = () => {
        if (multi) { if (set.has(c)) set.delete(c); else set.add(c); }
        else { set.clear(); set.add(c); }
        paint();
      };
    });
  };
  paint();
}

// Build one gate widget as { html, mount, collect }. 'collect' returns the slice
// of the action payload this widget owns; 'mount' wires it after innerHTML lands.
function buildGateWidget(s, step, w, i) {
  if (w.type === "markdown-view") {
    const cid = artifactCommentId(s, w.source, step);
    return {
      html: '<div class="gw"><div class="field">' + esc(w.label || w.source || "Artifact") + '</div>' +
        (cid != null
          ? '<div class="brief" id="gwmd_' + i + '"><span class="muted">Loading…</span></div>'
          : '<p class="muted">No “' + esc(w.source || "") + '” artifact to preview yet.</p>') + '</div>',
      mount: () => { if (cid != null) loadComment(cid, "gwmd_" + i); },
      collect: () => ({}),
    };
  }

  if (w.type === "option-picker") {
    const options = protoData(s).options;
    if (!selectedPrototype || !options.some((o) => o.id === selectedPrototype)) {
      selectedPrototype = options[0] ? options[0].id : null;
    }
    return {
      html: '<div class="gw"><div class="field">' + esc(w.label || w.source || "Options") + '</div>' +
        (options.length ? '<div class="opts">' + protoSections(options, true) + '</div>'
          : '<p class="muted">No prototype options to choose from yet.</p>') + '</div>',
      mount: () => {
        wirePrototypeFrames();
        wireOptionCards((id) => toast("Selected " + id + " as the direction."));
      },
      collect: () => ({ optionId: selectedPrototype || (options[0] && options[0].id) || null }),
    };
  }

  if (w.type === "question-form") {
    const qsrc = (w.source && s[w.source]) || s.questionnaire;
    const questions = (qsrc && qsrc.questions) || [];
    const models = {};
    questions.forEach((qq) => { models[qq.id] = new Set(); });
    const body = questions.length
      ? questions.map((qq) => {
          const multi = qq.select === "multi";
          const noteLabel = (qq.choices && qq.choices.length)
            ? (multi ? "Add a note or other option (optional)" : "Other / add a note (optional)")
            : "Your answer";
          return '<div class="qitem">' +
            '<div class="qprompt"><span class="badge badge-neutral">' + esc(qq.id) + '</span> ' + esc(qq.prompt) + '</div>' +
            '<div class="choices' + (multi ? " multi" : "") + '" id="gwqc_' + esc(qq.id) + '">' +
              choiceRowsHtml(qq, models[qq.id], multi, "gwq_") + '</div>' +
            '<label class="field" for="gwqt_' + esc(qq.id) + '">' + esc(noteLabel) + '</label>' +
            '<textarea class="textarea" id="gwqt_' + esc(qq.id) + '" placeholder="Anything to add…"></textarea>' +
            '</div>';
        }).join("")
      : '<p class="muted">No questions to answer yet.</p>';
    return {
      html: '<div class="gw"><div class="field">' + esc(w.label || w.source || "Questions") + '</div><div class="qlist">' + body + '</div></div>',
      mount: () => { questions.forEach((qq) => wireGenericQuestion(qq, models[qq.id], qq.select === "multi")); },
      collect: () => {
        if (!questions.length) return {};
        return { answers: questions.map((qq) => {
          const noteEl = $("gwqt_" + qq.id);
          return { id: qq.id, prompt: qq.prompt, answer: composeAnswer(Array.from(models[qq.id]), noteEl ? noteEl.value : "") };
        }) };
      },
    };
  }

  if (w.type === "clause-pins") {
    const clauses = Array.isArray(s.planClauses) ? s.planClauses : [];
    const quotes = (s.panel && s.panel.quotes) || {};
    const decisions = new Map();
    return {
      html: '<div class="gw"><div class="field">' + esc(w.label || w.source || "Plan clauses") + '</div>' +
        (clauses.length ? renderClauseList(clauses, quotes, false)
          : '<p class="muted">No plan clauses to steer yet.</p>') + '</div>',
      mount: () => { wireClauseList($("clauseList"), decisions, null); },
      collect: () => ({ decisions: clauseDecisionsPayload($("clauseList"), decisions) }),
    };
  }

  if (w.type === "pr-review") {
    return {
      html: '<div class="gw"><div class="field">Pull request</div>' +
        '<div class="pr-review" id="prReview"><span class="muted">Loading the PR…</span></div></div>',
      mount: () => { loadPrReview(s, false); },
      collect: () => ({}),
    };
  }

  if (w.type === "textarea") {
    const key = w.id;
    return {
      html: '<div class="gw"><label class="field" for="gwnote_' + esc(key) + '">' + esc(w.label || "Notes") + '</label>' +
        '<textarea class="textarea" id="gwnote_' + esc(key) + '" placeholder="' + esc(w.placeholder || "") + '"></textarea></div>',
      mount: () => {},
      collect: () => { const el = $("gwnote_" + key); const o = {}; o[key] = el ? (el.value || "").trim() : ""; return o; },
    };
  }

  if (w.type === "checklist") {
    const key = w.id;
    const items = w.items || [];
    const rows = items.map((it, k) =>
      '<label class="choice" for="gwchk_' + esc(key) + '_' + k + '">' +
      '<input class="choice-input" type="checkbox" id="gwchk_' + esc(key) + '_' + k + '" data-item="' + esc(it) + '" />' +
      '<span class="choice-mark box"></span><span class="choice-text">' + esc(it) + '</span></label>').join("");
    return {
      html: '<div class="gw"><div class="field">' + esc(w.label || key) + '</div><div class="choices">' + rows + '</div></div>',
      mount: () => {
        items.forEach((it, k) => {
          const el = $("gwchk_" + key + "_" + k);
          if (!el) return;
          el.onclick = () => {
            const label = el.closest ? el.closest(".choice") : null;
            const on = !!el.checked;
            if (label) {
              label.classList.toggle("on", on);
              const mark = label.querySelector(".choice-mark");
              if (mark) { mark.classList.toggle("on", on); mark.innerHTML = on ? svg("check") : ""; }
            }
          };
        });
      },
      collect: () => {
        const picked = [];
        items.forEach((it, k) => { const el = $("gwchk_" + key + "_" + k); if (el && el.checked) picked.push(it); });
        const o = {}; o[key] = picked; return o;
      },
    };
  }

  // A type we can't back with the read model degrades to a note, never a crash.
  return {
    html: '<div class="gw"><p class="muted">Widget “' + esc(w.type) + '” isn’t supported here yet.</p></div>',
    mount: () => {},
    collect: () => ({}),
  };
}

function renderGenericGate(s, step) {
  const gate = step.gate;
  const widgets = (gate.widgets || []).map((w, i) => buildGateWidget(s, step, w, i));
  const widgetHtml = widgets.map((x) => x.html).join("");

  const actionsHtml = (gate.actions || []).map((a, i) =>
    '<button class="' + btnClassForStyle(a.style) + '" id="gwact_' + i + '" type="button">' + esc(a.label) + '</button>').join("");

  $("panel").innerHTML =
    '<div class="card">' +
    '<div class="gate-banner">' + svg("gate") + esc(step.status && step.status.waiting ? step.status.waiting : "Your input is needed to continue.") + '</div>' +
    panelHead(step.icon || "gate", "Gate · " + esc(step.label || step.stage), gate.title || step.label || "Review") +
    (step.description ? '<p class="sub">' + esc(step.description) + '</p>' : '') +
    (s.issueUrl ? '<p class="sub">Issue <a class="issue-link" href="#" data-ext="' + esc(s.issueUrl) + '">#' + esc(s.issue) + svg("external") + '</a></p>' : '') +
    '<div class="gw-widgets">' + widgetHtml + '</div>' +
    '<div class="decision"><div class="row">' + actionsHtml + '</div></div>' +
    '</div>';

  // A widget that throws while wiring must not take the whole gate down with it.
  widgets.forEach((x) => { try { x.mount(); } catch (e) {} });

  (gate.actions || []).forEach((a, i) => {
    const btn = $("gwact_" + i);
    if (!btn) return;
    btn.onclick = async () => {
      let data = {};
      widgets.forEach((x) => { try { data = Object.assign(data, x.collect() || {}); } catch (e) {} });
      const buttons = (gate.actions || []).map((_, k) => $("gwact_" + k)).filter(Boolean);
      buttons.forEach((b) => { b.disabled = true; });
      const ok = await sendIntent(a.id, data, ctxFor(s));
      if (ok) { if (a.status) toast(a.status); }
      else buttons.forEach((b) => { b.disabled = false; });
    };
  });
}

// ============================================================================
// Workflows configuration page
// ============================================================================
// A full-panel editor for the workflow definitions the runtime interprets. Every
// dropdown is built from the primitives registry served by /workflows (never
// hardcoded here) so a new rule/widget/field type shows up without a webview
// change. WF.def is the single source of truth — inputs write to it live, and the
// editor repaints only on structural edits, so the poll can't drop keystrokes.

function toggleWorkflows() {
  if (workflowsOpen) {
    workflowsOpen = false; WF.mounted = false;
    const sw = $("stripWrap"); if (sw) sw.hidden = false;
    render(lastState || { active: false });
    return;
  }
  mountWorkflows();
}

function mountWorkflows() {
  workflowsOpen = true; WF.mounted = true; WF.view = "list"; WF.conflict = false; WF.renameId = null; WF.listError = null;
  const sw = $("stripWrap"); if (sw) sw.hidden = true;
  const cb = $("connbar"); if (cb) cb.hidden = true;
  const db = $("defbar"); if (db) db.hidden = true;
  $("panel").innerHTML = '<div class="card"><span class="muted">Loading workflows…</span></div>';
  loadWorkflowIndex();
}

function loadWorkflowIndex(then) {
  gfetch("/workflows").then((r) => r.json()).then((d) => {
    WF.list = (d && Array.isArray(d.workflows)) ? d.workflows : [];
    WF.prims = (d && d.prims) || (d && d.primitives) || WF.prims;
    WF.listError = null;
    if (then) then(); else paintWorkflows();
  }).catch((e) => {
    WF.listError = (e && e.message) || "Couldn’t load workflows.";
    if (WF.view === "list") paintWorkflows();
  });
}

function paintWorkflows() {
  if (!WF.mounted) return;
  if (WF.view === "editor" && WF.def) paintWorkflowEditor();
  else paintWorkflowList();
}

function wfCloseBar() {
  return '<div class="wf-bar"><button class="btn btn-ghost btn-sm has-icon" id="wfClose">' + svg("back") + 'Back to flow</button>' +
    '<span class="badge badge-neutral">Flow builder</span></div>';
}

function paintWorkflowList() {
  const rows = WF.list.map((w) => {
    const isDefault = w.id === "default";
    const renaming = WF.renameId === w.id;
    const nameCell = renaming
      ? '<input class="input wf-rename" id="wfRenameInput" value="' + esc(WF.renameVal) + '" />'
      : '<button class="wf-open" data-wf-act="open" data-id="' + esc(w.id) + '"><span class="wf-name">' + esc(w.name) + '</span>' +
        '<span class="wf-sub"><code>' + esc(w.id) + '</code> · rev ' + esc(w.rev) + ' · ' + esc(w.stageCount) + ' step' + (w.stageCount === 1 ? '' : 's') + '</span></button>';
    const acts = renaming
      ? '<button class="btn btn-primary btn-sm" data-wf-act="rename-save" data-id="' + esc(w.id) + '">Save</button>' +
        '<button class="btn btn-ghost btn-sm" data-wf-act="rename-cancel">Cancel</button>'
      : '<button class="icon-button sm" title="Duplicate" data-wf-act="dup" data-id="' + esc(w.id) + '">' + svg("copy", "icon-sm") + '</button>' +
        '<button class="icon-button sm" title="Rename" data-wf-act="rename" data-id="' + esc(w.id) + '" data-name="' + esc(w.name) + '">' + svg("pencil", "icon-sm") + '</button>' +
        (isDefault ? '' : '<button class="icon-button sm" title="Delete" data-wf-act="del" data-id="' + esc(w.id) + '">' + svg("trash", "icon-sm") + '</button>');
    return '<div class="wf-row">' + nameCell + '<div class="wf-row-acts">' + acts + '</div></div>';
  }).join("");

  $("panel").innerHTML =
    '<div class="card" id="wfPage">' + wfCloseBar() +
    panelHead("gear", "Flow builder", "Workflows") +
    '<p class="sub">Author the pipelines the loop can run. The <code>default</code> loop ships with the canvas and can’t be deleted.</p>' +
    (WF.listError ? '<div class="wf-alert">' + svg("alert", "icon-sm") + '<span>' + esc(WF.listError) + '</span></div>' : '') +
    '<div class="row" style="margin-top:16px"><button class="btn btn-primary has-icon" data-wf-act="new">' + svg("plus") + 'New workflow</button>' +
    '<button class="btn btn-ghost btn-sm has-icon" data-wf-act="refresh">Refresh</button></div>' +
    '<div class="wf-list">' + (rows || '<p class="muted" style="margin-top:16px">No workflows yet.</p>') + '</div>' +
    '</div>';

  $("wfClose").onclick = toggleWorkflows;
  wireWfActions($("wfPage"));
  if (WF.renameId) { const inp = $("wfRenameInput"); if (inp) { inp.oninput = () => { WF.renameVal = inp.value; }; inp.focus(); } }
}

// Delegated click handling for both list and editor. Keeps the many dynamic rows
// wire-free; every actionable control carries data-wf-act.
function wireWfActions(root) {
  if (!root) return;
  root.onclick = (e) => {
    const el = e.target.closest && e.target.closest("[data-wf-act]");
    if (!el || !root.contains(el)) return;
    const act = el.getAttribute("data-wf-act");
    const id = el.getAttribute("data-id");
    const j = el.getAttribute("data-j");
    handleWfAction(act, { id, j: j == null ? null : Number(j), el });
  };
}

function handleWfAction(act, ctx) {
  switch (act) {
    case "new": return wfNew();
    case "refresh": return loadWorkflowIndex();
    case "open": return wfOpenEditor(ctx.id);
    case "dup": return wfDuplicate(ctx.id);
    case "del": return wfDelete(ctx.id);
    case "rename": WF.renameId = ctx.id; WF.renameVal = ctx.el.getAttribute("data-name") || ""; return paintWorkflowList();
    case "rename-cancel": WF.renameId = null; return paintWorkflowList();
    case "rename-save": return wfRenameSave(ctx.id);
    case "back-list": WF.view = "list"; WF.def = null; WF.conflict = false; return loadWorkflowIndex();
    case "save": return wfSave();
    case "reload": return wfOpenEditor(WF.def.id);
    case "sel-step": WF.sel = ctx.j; return paintWorkflowEditor();
    case "add-step": return wfAddStep();
    case "del-step": return wfDelStep(ctx.j);
    case "up-step": return wfMoveStep(ctx.j, -1);
    case "down-step": return wfMoveStep(ctx.j, 1);
    case "add-field": return wfPushRow("fields", { name: "", type: (WF.prims.fieldTypeNames || ["text"])[0], required: true });
    case "del-field": return wfDelRow("fields", ctx.j);
    case "add-rule": return wfPushRow("validate", { rule: (WF.prims.ruleNames || ["required"])[0] });
    case "del-rule": return wfDelRow("validate", ctx.j);
    case "add-widget": return wfPushGate("widgets", { type: (WF.prims.gateWidgetNames || ["textarea"])[0] });
    case "del-widget": return wfDelGate("widgets", ctx.j);
    case "add-action": return wfPushGate("actions", { id: "", label: "", style: "secondary", outcome: "advance" });
    case "del-action": return wfDelGate("actions", ctx.j);
    default: return;
  }
}

function curStep() { return WF.def.steps[WF.sel] || WF.def.steps[0]; }

function wfPushRow(coll, row) {
  const st = curStep();
  if (coll === "fields") { st.artifact = st.artifact || { fields: [] }; st.artifact.fields.push(row); }
  else st.validate = (st.validate || []).concat([row]);
  afterStructuralEdit();
}
function wfDelRow(coll, j) {
  const st = curStep();
  if (coll === "fields") st.artifact.fields.splice(j, 1); else st.validate.splice(j, 1);
  afterStructuralEdit();
}
function wfPushGate(coll, row) {
  const st = curStep();
  st.gate = st.gate || { id: "", title: "", widgets: [], actions: [] };
  st.gate[coll] = (st.gate[coll] || []).concat([row]);
  afterStructuralEdit();
}
function wfDelGate(coll, j) {
  const st = curStep();
  if (st.gate && st.gate[coll]) st.gate[coll].splice(j, 1);
  afterStructuralEdit();
}

function wfAddStep() {
  const n = WF.def.steps.length + 1;
  const id = "step-" + n;
  WF.def.steps.push({
    id, stage: id, group: id, label: "Step " + n, icon: "loop", description: "",
    produce: { by: "none", capability: "none", contract: "", heading: "" },
    artifact: { fields: [] }, validate: [], status: { working: "Working…", waiting: "" }, next: null,
  });
  WF.sel = WF.def.steps.length - 1;
  afterStructuralEdit();
}
function wfDelStep(j) {
  if (WF.def.steps.length <= 1) { toast("A workflow needs at least one step."); return; }
  WF.def.steps.splice(j, 1);
  if (WF.sel >= WF.def.steps.length) WF.sel = WF.def.steps.length - 1;
  afterStructuralEdit();
}
function wfMoveStep(j, dir) {
  const to = j + dir;
  if (to < 0 || to >= WF.def.steps.length) return;
  const arr = WF.def.steps;
  const t = arr[j]; arr[j] = arr[to]; arr[to] = t;
  if (WF.sel === j) WF.sel = to; else if (WF.sel === to) WF.sel = j;
  afterStructuralEdit();
}

function afterStructuralEdit() { WF.conflict = false; paintWorkflowEditor(); scheduleValidate(); }

function wfNew() {
  const starter = {
    name: "New workflow", description: "", entry: "step-1",
    steps: [{
      id: "step-1", stage: "step-1", group: "step-1", label: "Step 1", icon: "loop", description: "",
      produce: { by: "none", capability: "none", contract: "", heading: "" },
      artifact: { fields: [] }, validate: [], status: { working: "Working…", waiting: "" }, next: null,
    }],
  };
  post("/workflows", starter).then((saved) => {
    WF.def = saved; WF.rev = saved.rev; WF.sel = 0; WF.view = "editor"; WF.conflict = false; WF.errors = [];
    paintWorkflowEditor(); scheduleValidate();
  }).catch((e) => toast((e && e.message) || "Couldn’t create workflow."));
}

function wfOpenEditor(id) {
  gfetch("/workflows/" + encodeURIComponent(id)).then((r) => r.json()).then((def) => {
    if (!def || def.error) throw new Error((def && def.error) || "not found");
    WF.def = def; WF.rev = def.rev; WF.sel = 0; WF.view = "editor"; WF.conflict = false; WF.errors = [];
    paintWorkflowEditor(); scheduleValidate();
  }).catch((e) => toast((e && e.message) || "Couldn’t open workflow."));
}

function wfDuplicate(id) {
  post("/workflows/" + encodeURIComponent(id) + "/duplicate", {}).then((def) => {
    toast("Duplicated."); loadWorkflowIndex(() => wfOpenEditor(def.id));
  }).catch((e) => toast((e && e.message) || "Couldn’t duplicate."));
}

function wfDelete(id) {
  gfetch("/workflows/" + encodeURIComponent(id), { method: "DELETE" }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok || (d && d.ok === false)) throw new Error((d && d.error) || ("HTTP " + r.status));
    toast("Deleted."); loadWorkflowIndex();
  }).catch((e) => toast((e && e.message) || "Couldn’t delete."));
}

function wfRenameSave(id) {
  const name = (WF.renameVal || "").trim();
  if (!name) { toast("Name is required."); return; }
  gfetch("/workflows/" + encodeURIComponent(id)).then((r) => r.json()).then((def) => {
    const body = Object.assign({}, def, { name, expectedRev: def.rev });
    return post("/workflows/" + encodeURIComponent(id), body, "PUT");
  }).then(() => { WF.renameId = null; toast("Renamed."); loadWorkflowIndex(); })
    .catch((e) => toast((e && e.message) || "Couldn’t rename."));
}

function wfSave() {
  if (WF.saving || WF.errors.length) return;
  WF.saving = true;
  const btn = $("wfSave"); if (btn) btn.disabled = true;
  const body = Object.assign({}, WF.def, { expectedRev: WF.rev });
  post("/workflows/" + encodeURIComponent(WF.def.id), body, "PUT").then((saved) => {
    WF.saving = false; WF.def = saved; WF.rev = saved.rev; WF.conflict = false; WF.errors = [];
    toast("Saved · rev " + saved.rev);
    paintWorkflowEditor(); scheduleValidate();
  }).catch((e) => {
    WF.saving = false;
    const msg = (e && e.message) || "Save failed.";
    if (/changed on disk/i.test(msg)) { WF.conflict = true; paintWorkflowEditor(); }
    else { toast(msg); if (btn) btn.disabled = false; }
  });
}

function scheduleValidate() {
  if (WF.vtimer) clearTimeout(WF.vtimer);
  WF.vtimer = setTimeout(runValidate, 400);
}
function runValidate() {
  if (!WF.def) return;
  const snapshot = WF.def;
  // The validate endpoint returns { ok:false, errors } (HTTP 200) for an invalid
  // definition, so read the body directly rather than via post() — post() throws
  // on ok:false, which would swallow the very errors we need to display.
  gfetch("/workflows/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  }).then((r) => r.json()).then((d) => {
    if (WF.def !== snapshot) return; // a structural edit superseded this run
    WF.errors = (d && Array.isArray(d.errors)) ? d.errors : [];
    paintWfErrors();
  }).catch(() => {});
}

// Only the errors panel + Save button are touched here, never the whole editor,
// so validation running mid-keystroke can't steal focus.
function paintWfErrors() {
  const box = $("wfErrors");
  if (box) box.innerHTML = wfErrorsHtml();
  const btn = $("wfSave");
  if (btn) btn.disabled = WF.saving || WF.errors.length > 0;
}
function wfErrorsHtml() {
  if (!WF.errors.length) return '<div class="wf-valid">' + svg("check", "icon-sm") + '<span>Definition is valid.</span></div>';
  return '<div class="wf-invalid"><div class="wf-invalid-h">' + svg("alert", "icon-sm") + WF.errors.length + ' problem' + (WF.errors.length === 1 ? '' : 's') + ' to fix</div>' +
    '<ul>' + WF.errors.map((er) => '<li><code>' + esc(er.path || "root") + '</code> ' + esc(er.message) + '</li>').join("") + '</ul></div>';
}

function paintWorkflowEditor() {
  if (!WF.mounted || !WF.def) return;
  const def = WF.def;
  const stepIds = def.steps.map((st) => st.id);
  const st = curStep();
  const P = WF.prims || {};

  const stepListHtml = def.steps.map((step, i) => {
    const sel = i === WF.sel ? ' sel' : '';
    return '<div class="wf-step-item' + sel + '">' +
      '<button class="wf-step-open" data-wf-act="sel-step" data-j="' + i + '">' +
        '<span class="wf-step-name">' + esc(step.label || step.id) + '</span>' +
        '<span class="wf-step-sub"><code>' + esc(step.id) + '</code> · ' + esc(step.phase ? step.phase + ' / ' : '') + esc(step.stage) + '</span></button>' +
      '<div class="wf-step-move">' +
        '<button class="icon-button sm" title="Move up" data-wf-act="up-step" data-j="' + i + '"' + (i === 0 ? ' disabled' : '') + '>' + svg("up", "icon-sm") + '</button>' +
        '<button class="icon-button sm" title="Move down" data-wf-act="down-step" data-j="' + i + '"' + (i === def.steps.length - 1 ? ' disabled' : '') + '>' + svg("down", "icon-sm") + '</button>' +
        '<button class="icon-button sm" title="Remove step" data-wf-act="del-step" data-j="' + i + '">' + svg("trash", "icon-sm") + '</button>' +
      '</div></div>';
  }).join("");

  const conflictBanner = WF.conflict
    ? '<div class="wf-alert">' + svg("alert", "icon-sm") + '<span>This workflow changed on disk. Reload before saving.</span>' +
      '<button class="btn btn-secondary btn-sm" data-wf-act="reload">Reload</button></div>'
    : '';

  $("panel").innerHTML =
    '<div class="card" id="wfPage">' + wfCloseBar() +
    '<div class="wf-edit-head">' +
      '<button class="btn btn-ghost btn-sm has-icon" data-wf-act="back-list">' + svg("back") + 'All workflows</button>' +
      '<div class="wf-edit-title"><code>' + esc(def.id) + '</code> · rev ' + esc(def.rev) + '</div>' +
      '<button class="btn btn-primary btn-sm" id="wfSave" data-wf-act="save"' + (WF.errors.length ? ' disabled' : '') + '>Save</button>' +
    '</div>' +
    conflictBanner +
    '<div class="wf-preview-wrap">' + wfStepperPreview(def) + '</div>' +
    '<div id="wfErrors">' + wfErrorsHtml() + '</div>' +
    '<div class="wf-def-fields">' +
      wfField("Name", '<input class="input" data-wf="def.name" value="' + esc(def.name) + '" />') +
      wfField("Description", '<textarea class="textarea wf-short" data-wf="def.description">' + esc(def.description) + '</textarea>') +
      wfField("Entry step", '<select class="select" data-wf="def.entry">' + wfOptions(stepIds, def.entry) + '</select>') +
    '</div>' +
    '<div class="wf-cols">' +
      '<div class="wf-steplist"><div class="wf-steplist-h">Steps<button class="icon-button sm" title="Add step" data-wf-act="add-step">' + svg("plus", "icon-sm") + '</button></div>' + stepListHtml + '</div>' +
      '<div class="wf-stepdetail">' + wfStepDetail(st, stepIds, P) + '</div>' +
    '</div>' +
    '</div>';

  const page = $("wfPage");
  page.onclick = null; // reset before rewiring
  $("wfClose").onclick = toggleWorkflows;
  wireWfActions(page);
  wireWfInputs(page);
  paintWfErrors();
}

function wfField(label, control) {
  return '<div class="wf-f"><label class="field">' + esc(label) + '</label>' + control + '</div>';
}

function wfOptions(values, cur) {
  return (values || []).map((v) => {
    const val = (v && typeof v === "object") ? v.value : v;
    const lab = (v && typeof v === "object") ? v.label : v;
    return '<option value="' + esc(val) + '"' + (String(val) === String(cur) ? ' selected' : '') + '>' + esc(lab) + '</option>';
  }).join("");
}

function wfStepperPreview(def) {
  const seen = {}; const groups = [];
  (def.steps || []).forEach((st) => { if (!seen[st.stage]) { seen[st.stage] = 1; groups.push(st); } });
  const parts = groups.map((st, i) =>
    '<div class="step"><span class="step-circle">' + svg(st.icon || "loop") + '</span><span class="step-label">' + esc(st.phase ? st.phase + " / " : "") + esc(st.label || st.stage) + '</span></div>' +
    (i < groups.length - 1 ? '<span class="step-line"></span>' : ''));
  return '<div class="stepper wf-stepper-preview">' + parts.join("") + '</div>';
}

function wfStepDetail(st, stepIds, P) {
  const fieldTypes = P.fieldTypeNames || [];
  const rules = P.ruleNames || [];
  const ruleOperands = P.ruleOperands || {};
  const gateWidgetNames = P.gateWidgetNames || [];
  const gateWidgets = P.gateWidgets || {};
  const caps = P.capabilityNames || [];
  const producers = P.producerNames || [];
  const outcomes = P.outcomeKinds || [];

  // Identity
  let html = '<div class="wf-section"><div class="wf-section-h">Identity</div>' +
    '<div class="wf-grid">' +
      wfField("id", '<input class="input" data-wf="step.id" value="' + esc(st.id) + '" />') +
      wfField("label", '<input class="input" data-wf="step.label" value="' + esc(st.label) + '" />') +
      wfField("phase (optional)", '<input class="input" data-wf="step.phase" value="' + esc(st.phase || "") + '" />') +
      wfField("stage", '<input class="input" data-wf="step.stage" value="' + esc(st.stage) + '" />') +
      wfField("icon", '<input class="input" data-wf="step.icon" value="' + esc(st.icon) + '" />') +
    '</div>' +
    wfField("description", '<textarea class="textarea wf-short" data-wf="step.description">' + esc(st.description) + '</textarea>') +
    '</div>';

  // Produce
  const pr = st.produce || {};
  html += '<div class="wf-section"><div class="wf-section-h">Produce</div>' +
    '<div class="wf-grid">' +
      wfField("by", '<select class="select" data-wf="produce.by">' + wfOptions(producers, pr.by) + '</select>') +
      wfField("capability", '<select class="select" data-wf="produce.capability">' + wfOptions(caps, pr.capability) + '</select>') +
      wfField("heading", '<input class="input" data-wf="produce.heading" value="' + esc(pr.heading || "") + '" />') +
    '</div>' +
    wfField("contract", '<textarea class="textarea" data-wf="produce.contract">' + esc(pr.contract || "") + '</textarea>') +
    '<p class="wf-hint">Variables: ' + CONTRACT_VARS.map((v) => '<code>{{' + esc(v) + '}}</code>').join(" ") + '</p>' +
    '</div>';

  // Artifact fields
  const fields = (st.artifact && st.artifact.fields) || [];
  const fieldRows = fields.map((f, j) =>
    '<div class="wf-rrow">' +
      '<input class="input wf-mini" data-wf="field" data-j="' + j + '" data-f="name" value="' + esc(f.name) + '" placeholder="name" />' +
      '<select class="select wf-mini" data-wf="field" data-j="' + j + '" data-f="type">' + wfOptions(fieldTypes, f.type) + '</select>' +
      '<label class="wf-chk"><input type="checkbox" data-wf="field" data-j="' + j + '" data-f="required"' + (f.required === false ? '' : ' checked') + ' /> required</label>' +
      '<button class="icon-button sm" title="Remove" data-wf-act="del-field" data-j="' + j + '">' + svg("x", "icon-sm") + '</button>' +
    '</div>').join("");
  html += '<div class="wf-section"><div class="wf-section-h">Artifact fields<button class="icon-button sm" title="Add field" data-wf-act="add-field">' + svg("plus", "icon-sm") + '</button></div>' +
    (fieldRows || '<p class="muted wf-empty">No fields.</p>') + '</div>';

  // Validation rules
  const rulesArr = st.validate || [];
  const ruleRows = rulesArr.map((r, j) => {
    const needs = ruleOperands[r.rule] || [];
    const operandInputs = needs.map((need) =>
      '<input class="input wf-mini" data-wf="rule" data-j="' + j + '" data-f="' + esc(need) + '" value="' + esc(r[need] == null ? "" : r[need]) + '" placeholder="' + esc(need) + '" />').join("");
    return '<div class="wf-rrow">' +
      '<select class="select wf-mini" data-wf="rule" data-j="' + j + '" data-f="rule" data-struct="1">' + wfOptions(rules, r.rule) + '</select>' +
      operandInputs +
      '<button class="icon-button sm" title="Remove" data-wf-act="del-rule" data-j="' + j + '">' + svg("x", "icon-sm") + '</button>' +
    '</div>';
  }).join("");
  html += '<div class="wf-section"><div class="wf-section-h">Validation<button class="icon-button sm" title="Add rule" data-wf-act="add-rule">' + svg("plus", "icon-sm") + '</button></div>' +
    (ruleRows || '<p class="muted wf-empty">No rules.</p>') + '</div>';

  // Repeat
  const hasRepeat = !!st.repeat;
  html += '<div class="wf-section"><div class="wf-section-h">Repeat</div>' +
    '<label class="wf-chk"><input type="checkbox" data-wf="repeat.enabled" data-struct="1"' + (hasRepeat ? ' checked' : '') + ' /> this step can repeat</label>' +
    (hasRepeat ? wfField("counter name", '<input class="input" data-wf="repeat.counter" value="' + esc(st.repeat.counter || "") + '" />') : '') +
    '</div>';

  // Status
  const status = st.status || {};
  html += '<div class="wf-section"><div class="wf-section-h">Status</div>' +
    '<div class="wf-grid">' +
      wfField("working", '<input class="input" data-wf="status.working" value="' + esc(status.working || "") + '" />') +
      wfField("waiting", '<input class="input" data-wf="status.waiting" value="' + esc(status.waiting || "") + '" />') +
    '</div></div>';

  // Gate
  const hasGate = !!st.gate;
  html += '<div class="wf-section"><div class="wf-section-h">Gate</div>' +
    '<label class="wf-chk"><input type="checkbox" data-wf="gate.enabled" data-struct="1"' + (hasGate ? ' checked' : '') + ' /> open a human gate after this step</label>';
  if (hasGate) {
    const g = st.gate;
    html += '<div class="wf-grid">' +
        wfField("gate id", '<input class="input" data-wf="gate.id" value="' + esc(g.id || "") + '" />') +
        wfField("title", '<input class="input" data-wf="gate.title" value="' + esc(g.title || "") + '" />') +
      '</div>';
    // Gate widgets
    const widgets = g.widgets || [];
    const widgetRows = widgets.map((w, j) => {
      const needs = (gateWidgets[w.type] && gateWidgets[w.type].needs) || [];
      const needInputs = needs.map((need) =>
        '<input class="input wf-mini" data-wf="widget" data-j="' + j + '" data-f="' + esc(need) + '" value="' + esc(w[need] == null ? "" : w[need]) + '" placeholder="' + esc(need) + '" />').join("");
      return '<div class="wf-rrow">' +
        '<select class="select wf-mini" data-wf="widget" data-j="' + j + '" data-f="type" data-struct="1">' + wfOptions(gateWidgetNames, w.type) + '</select>' +
        needInputs +
        '<button class="icon-button sm" title="Remove" data-wf-act="del-widget" data-j="' + j + '">' + svg("x", "icon-sm") + '</button>' +
      '</div>';
    }).join("");
    html += '<div class="wf-sub-h">Widgets<button class="icon-button sm" title="Add widget" data-wf-act="add-widget">' + svg("plus", "icon-sm") + '</button></div>' +
      (widgetRows || '<p class="muted wf-empty">No widgets.</p>');
    // Gate actions
    const actions = g.actions || [];
    const actionRows = actions.map((a, j) => {
      const parsedGoto = String(a.outcome || "").indexOf("goto:") === 0;
      const outcomeVal = parsedGoto ? "goto" : a.outcome;
      const gotoSel = parsedGoto
        ? '<select class="select wf-mini" data-wf="action" data-j="' + j + '" data-f="gototarget">' + wfOptions(stepIds, String(a.outcome).slice(5)) + '</select>'
        : '';
      return '<div class="wf-rrow wf-action">' +
        '<input class="input wf-mini" data-wf="action" data-j="' + j + '" data-f="id" value="' + esc(a.id) + '" placeholder="id" />' +
        '<input class="input wf-mini" data-wf="action" data-j="' + j + '" data-f="label" value="' + esc(a.label) + '" placeholder="label" />' +
        '<select class="select wf-mini" data-wf="action" data-j="' + j + '" data-f="style">' + wfOptions(["primary", "secondary", "ghost"], a.style) + '</select>' +
        '<select class="select wf-mini" data-wf="action" data-j="' + j + '" data-f="outcome" data-struct="1">' + wfOptions(outcomes, outcomeVal) + '</select>' +
        gotoSel +
        '<button class="icon-button sm" title="Remove" data-wf-act="del-action" data-j="' + j + '">' + svg("x", "icon-sm") + '</button>' +
      '</div>';
    }).join("");
    html += '<div class="wf-sub-h">Actions<button class="icon-button sm" title="Add action" data-wf-act="add-action">' + svg("plus", "icon-sm") + '</button></div>' +
      (actionRows || '<p class="muted wf-empty">No actions.</p>');
  }
  html += '</div>';

  // Next
  const nextOpts = [{ value: "", label: "(none — terminal)" }].concat(stepIds.map((id) => ({ value: id, label: id })));
  html += '<div class="wf-section"><div class="wf-section-h">Transition</div>' +
    wfField("next", '<select class="select" data-wf="next">' + wfOptions(nextOpts, st.next || "") + '</select>') +
    '</div>';

  return html;
}

// Live-binds every editor input to WF.def. Structural changes (a select that
// re-shapes the form, or a checkbox that adds/removes a section) repaint the
// editor; plain edits just update the model and re-validate.
function wireWfInputs(root) {
  if (!root) return;
  const apply = (t) => {
    const key = t.getAttribute("data-wf");
    if (!key) return false;
    const struct = t.getAttribute("data-struct") === "1";
    const j = t.getAttribute("data-j");
    const f = t.getAttribute("data-f");
    const val = t.type === "checkbox" ? t.checked : t.value;
    applyWfEdit(key, { j: j == null ? null : Number(j), f, val });
    return struct;
  };
  root.oninput = (e) => {
    const t = e.target;
    if (!t || !t.getAttribute || !t.getAttribute("data-wf")) return;
    if (t.getAttribute("data-struct") === "1") return; // handled on change
    apply(t); scheduleValidate();
  };
  root.onchange = (e) => {
    const t = e.target;
    if (!t || !t.getAttribute || !t.getAttribute("data-wf")) return;
    const struct = apply(t);
    if (struct) { paintWorkflowEditor(); scheduleValidate(); }
    else scheduleValidate();
  };
}

function applyWfEdit(key, ctx) {
  const def = WF.def;
  const st = curStep();
  const val = ctx.val;
  switch (key) {
    case "def.name": def.name = val; break;
    case "def.description": def.description = val; break;
    case "def.entry": def.entry = val; break;
    case "step.id": st.id = val; break;
    case "step.label": st.label = val; break;
    case "step.phase": if (val.trim()) st.phase = val.trim(); else delete st.phase; break;
    case "step.stage": st.stage = val; break;
    case "step.icon": st.icon = val; break;
    case "step.description": st.description = val; break;
    case "produce.by": st.produce.by = val; break;
    case "produce.capability": st.produce.capability = val; break;
    case "produce.heading": st.produce.heading = val; break;
    case "produce.contract": st.produce.contract = val; break;
    case "status.working": st.status.working = val; break;
    case "status.waiting": st.status.waiting = val; break;
    case "next": st.next = val || null; break;
    case "field": {
      const f = st.artifact.fields[ctx.j];
      if (ctx.f === "required") f.required = !!val; else f[ctx.f] = val;
      break;
    }
    case "rule": {
      const r = st.validate[ctx.j];
      if (ctx.f === "rule") {
        // Reset operands to only those the new rule declares.
        const needs = (WF.prims.ruleOperands || {})[val] || [];
        const fresh = { rule: val };
        needs.forEach((n) => { fresh[n] = r[n] != null ? r[n] : ""; });
        st.validate[ctx.j] = fresh;
      } else r[ctx.f] = val;
      break;
    }
    case "repeat.enabled":
      if (val) st.repeat = st.repeat || { counter: st.id, label: "" };
      else delete st.repeat;
      break;
    case "repeat.counter": if (st.repeat) st.repeat.counter = val; break;
    case "gate.enabled":
      if (val) st.gate = st.gate || { id: st.id, title: st.label || st.id, widgets: [], actions: [] };
      else st.gate = null;
      break;
    case "gate.id": st.gate.id = val; break;
    case "gate.title": st.gate.title = val; break;
    case "widget": {
      const w = st.gate.widgets[ctx.j];
      if (ctx.f === "type") st.gate.widgets[ctx.j] = { type: val };
      else w[ctx.f] = val;
      break;
    }
    case "action": {
      const a = st.gate.actions[ctx.j];
      if (ctx.f === "outcome") a.outcome = (val === "goto") ? "goto:" + (st.next || (WF.def.steps[0] && WF.def.steps[0].id) || "") : val;
      else if (ctx.f === "gototarget") a.outcome = "goto:" + val;
      else a[ctx.f] = val;
      break;
    }
    default: break;
  }
}

function renderConn(errored, haveLast) {
  const bar = $("connbar");
  if (!bar) return;
  if (errored) {
    bar.hidden = false;
    bar.style.cssText = "margin:10px 0 0;padding:9px 14px;border-radius:10px;font-size:13px;" +
      "display:flex;align-items:center;gap:8px;background:var(--warning-tint);" +
      "color:var(--warning-text);border:1px solid var(--warning)";
    const msg = haveLast
      ? "Can\\u2019t reach GitHub right now \\u2014 showing the last known state. Retrying automatically\\u2026"
      : "Can\\u2019t reach GitHub right now. Retrying automatically\\u2026";
    bar.innerHTML = svg("alert", "icon-sm") + "<span>" + msg + "</span>";
  } else {
    bar.hidden = true;
    bar.innerHTML = "";
  }
}

function render(s) {
  // Poll-survival: once the Workflows page is mounted, the /state poll and SSE
  // refreshes must not repaint over it. The page owns #panel until it's closed.
  if (workflowsOpen) { if (!WF.mounted) mountWorkflows(); return; }
  // On a read failure, buildState() returns a synthetic fallback (stage research)
  // with an error set. Rendering that would make an in-flight job appear to regress,
  // so keep showing the last GOOD state and just overlay a connectivity banner.
  const errored = !!(s && s.error);
  if (!errored) lastGoodState = s;
  // Only reuse the last good state if it's the SAME job — otherwise an active-issue
  // switch mid-outage would show the wrong issue's panel.
  const sameJob = lastGoodState && s && lastGoodState.owner === s.owner &&
    lastGoodState.repo === s.repo && String(lastGoodState.issue) === String(s.issue);
  const usingLast = errored && !!sameJob;
  const view = usingLast ? lastGoodState : s;
  lastState = view;
  if (view.active) idleBuildGen++;
  // Once a job is active, retire the kickoff nonce so a future new idea gets a
  // fresh reqId and can't accidentally adopt this issue. Retries while still
  // idle keep reusing the same nonce (it's only cleared on an active state).
  if (view.active && kickoffReqId) kickoffReqId = null;
  updateAppbar(view);
  renderConn(errored, usingLast);
  renderDefError(view);
  if (viewKey && viewKey === currentKey(view)) viewKey = null;
  // The stepper describes a build in progress. On the launcher there is no build,
  // so showing a pipeline implies one is running — and worse, implies that fixed
  // pipeline is the only one on offer, right next to the workflow picker.
  const sw = $("stripWrap");
  if (sw) sw.hidden = !view.active;
  if (view.active) renderStrip(view);
  if (viewKey) { renderReview(view, viewKey); return; }
  if (!view.active) { renderIdle(); return; }
  if (view.status === "done") { renderDone(view, false); return; }
  if (view.gate === "signoff") { renderPrototype(view, false); return; }
  if (view.gate === "questionnaire") { renderQuestionnaire(view, false); return; }
  if (view.gate === "review-points") { renderIndependentReview(view, false); return; }
  if (view.gate === "plan-review") { renderPlanReview(view, false); return; }
  if (view.gate === "council-retry") { renderCouncil(view, false); return; }
  if (view.gate === "feedback") { renderFeedback(view, false); return; }
  // A gate the built-ins don't cover is rendered generically from the definition.
  if (view.gate && view.definition) {
    const gstep = stepForIssueLabelClient(view.definition, view.stage, view.gate);
    if (gstep && gstep.gate) { renderGenericGate(view, gstep); return; }
  }
  if (currentKey(view) === "prototype") { renderPrototype(view, false); return; }
  renderWorking(view);
}

// The active run's workflow snapshot is missing/edited/invalid — surface it so a
// broken build shows a reason rather than a blank or misleading panel. Rendered
// into its own node so a panel repaint below can't drop it.
function renderDefError(s) {
  const bar = $("defbar");
  if (!bar) return;
  if (s && s.active && s.definitionError) {
    bar.hidden = false;
    bar.style.cssText = "margin:10px 0 0;padding:9px 14px;border-radius:10px;font-size:13px;" +
      "display:flex;align-items:center;gap:8px;background:var(--danger-tint);" +
      "color:var(--danger-text);border:1px solid var(--danger-text)";
    bar.innerHTML = svg("alert", "icon-sm") + "<span>Workflow definition problem: " + esc(s.definitionError) + "</span>";
  } else {
    bar.hidden = true;
    bar.innerHTML = "";
  }
}

function reviewBar(label) {
  return '<div class="reviewbar"><button class="btn btn-ghost btn-sm has-icon" id="backBtn">' + svg("back") + 'Back to current stage</button>' +
    '<span class="badge badge-neutral">Reviewing · ' + esc(label) + '</span></div>';
}
function wireBack() {
  const b = $("backBtn");
  if (b) b.onclick = () => {
    viewKey = null;
    phaseUIKey = null;
    render(lastState);
    Array.from($("strip").querySelectorAll(".phase-tab.selected"))[0]?.focus();
  };
}

// Read-only view of a completed (or in-progress) stage, reached via the strip.
function renderReview(s, key) {
  if (key === "research") {
    $("panel").innerHTML =
      '<div class="card">' + reviewBar("Research") +
      panelHead("research", "Research", "Research brief") +
      '<p class="sub">Prior art, native vs. custom trade-offs, and the recommended direction.</p>' +
      (s.research && s.research.commentId
        ? '<div class="brief" id="brief"><span class="muted">Loading research brief…</span></div>'
        : '<p class="muted" style="margin-top:16px">No research artifact yet.</p>') +
      '</div>';
    wireBack();
    if (s.research && s.research.commentId) {
      gfetch("/comment/" + s.research.commentId).then((r) => r.json()).then((c) => {
        if (c && c.body && $("brief")) $("brief").innerHTML = mdLite(c.body);
      }).catch(() => {});
    }
    return;
  }

  if (key === "prototype") {
    renderPrototype(s, true);
    return;
  }

  if (key === "plan" || key === "draft") {
    // Read-only plan review: prefer the plan artifact, else the questionnaire/answers.
    if (s.pipelineVersion >= 2 && s.review?.draftCommentId) {
      $("panel").innerHTML = '<div class="card">' + reviewBar("Plan") +
        panelHead("plan", "Plan · draft", s.title || "Draft plan") +
        '<div class="brief" id="draftBrief"><span class="muted">Loading draft plan…</span></div></div>';
      wireBack();
      loadComment(s.review.draftCommentId, "draftBrief");
      return;
    }
    if (s.plan && s.plan.commentId) { renderPlanReview(s, true); return; }
    renderQuestionnaire(s, true);
    return;
  }

  if (key === "review") { renderIndependentReview(s, true); return; }
  if (key === "synthesis" || key === "synthesize") { renderPlanReview(s, true); return; }

  if (key === "implement" || key === "build") {
    renderFeedback(s, true, s.pipelineVersion === 3 ? "build" : "feedback");
    return;
  }
  if (key === "feedback") { renderFeedback(s, true); return; }
  if (key === "council") { renderCouncil(s, true); return; }

  if (key === "finalize") {
    $("panel").innerHTML =
      '<div class="card">' + reviewBar("Audit") +
      panelHead("finalize", "Audit", s.title || "Audit") +
      '<p class="sub">Final PR readiness check — confirming it is mergeable (branch, draft state, required checks). Not a formal compliance audit.</p>' +
      (s.finalized && s.finalized.commentId
        ? '<div class="brief" id="finBrief"><span class="muted">Loading the finalize summary…</span></div>'
        : (s.impl && s.impl.prUrl
            ? '<div class="meta-row">Pull request <a class="issue-link" href="#" data-ext="' + esc(s.impl.prUrl) + '">#' + esc(s.impl.prNumber) + svg("external") + '</a></div>'
            : '<p class="muted" style="margin-top:16px">No finalize artifact yet.</p>')) +
      '</div>';
    wireBack();
    if (s.finalized && s.finalized.commentId) loadComment(s.finalized.commentId, "finBrief");
    return;
  }

  if (key === "done") {
    renderDone(s, true);
    return;
  }

  viewKey = null;
  render(s);
}

async function refresh() {
  try {
    const s = await fetch("/state", { cache: "no-store", headers: CAPH }).then((r) => r.json());
    const sig = JSON.stringify(s);
    if (sig !== last) { last = sig; render(s); }
  } catch (e) { /* keep last view */ }
}

refresh();
setInterval(refresh, 4000);
try {
  const es = new EventSource(capUrl("/events"));
  es.addEventListener("refresh", () => refresh());
} catch (e) {}
</script>
</body>
</html>`;
}
