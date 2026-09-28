# Flow Loop canvas (project extension)

Flow Loop is a human-in-the-loop build loop backed by a GitHub issue: you design the
workflow, agents work it stage by stage, and it stops for your approval at every
gate. The issue, comments, labels, and one control-block comment are the durable
state. The extension owns
orchestration; agents only generate assets and submit them back through the
existing canvas action.

## Workflows

The pipeline is **data, not code**. A workflow definition declares the steps a
flow runs, and the coordinator interprets it. New flows group stages into phases:

`Plan (Research → Prototype → Draft → Synthesize) → Build → Review (Council → Feedback) → Audit → Done`

**Draft** includes the existing clarification questionnaire and plan draft.
**Synthesize** independently reviews that draft with a model from a different
family, automatically applies actionable recommendations, records review
evidence and disagreements, then pauses for approval of the final plan.
**Build** produces the PR. **Council** opens a PR checkout-backed review session
with the linked issue, issue discussion, PR description/discussion, checks, and
repository code. Its reviewer examines the pinned PR head for code quality,
security vulnerabilities, test coverage and lint issues; findings must refer
to changed files. The session returns structured findings to the bound canvas
action, which validates them against the same PR head and records an issue-backed
report before entering Feedback. A missing or failed session cannot approve the
PR; retry starts another review, and older in-flight factory reviews can finish.
Council requires complete patches for at most 40 files, with a 16,000-character
limit per file and 120,000 characters total; over-budget reviews fail rather
than silently truncating evidence.
The Build view shows the implementation summary, demo or run steps, and PR link;
Council's stage shows its read-only report. Review → Feedback shows findings,
the current GitHub PR diff/check status, and human decisions. PR checks shown
there are observed statuses, not tests run by Flow Loop's Build stage.
The Council summary's file count means changed PR files reviewed, not verified
test execution or compliance. Check snapshots and supporting evidence expand
on demand.
**Feedback** shows a severity/category count, patch-anchored findings, observed
check snapshot (not proof of test execution by Council), blockers, and next action.
Findings include a model confidence assessment, affected users/data,
prerequisites, exact patch excerpt, regression test, and trade-off when
supported. Security mappings to CWE, OWASP Top 10 edition/category, and
PCI DSS version/requirement are suggestions, **not compliance determinations**;
PCI mapping requires payment-card scope evidence. CVSS scores are estimates
with version and vector, not verified scores. CVE IDs require external
verification. Unsupported details are omitted rather than inferred.
Select findings and use **AI fix selected** to send them to Build, or record
an issue-backed per-finding **Manual fix**, **Accept risk**, or **Not applicable**
decision with reason (and owner for manual fixes). Open reopens a decision.
Manual fixes block Ship until a changed head is reviewed; Feedback offers
**Review changed PR head** when the PR moves. Accepting or
dismissing a critical/high security finding does not bypass the separate
explicit security waiver. Each changed head gets a fresh Council review;
recent previous reports, decisions, and AI fix requests remain linked as
read-only history (older records remain in issue comments). Failing required
checks also block Ship. An empty finding list means no supported findings
in supplied patches, **not** a passing audit. Council failures never silently
approve an unreviewed PR. **Audit** (step id `finalize`, labelled "Finalize"
in already-in-flight runs pinned before this rename) is the final PR
readiness check: it marks a draft PR ready and confirms the PR still points
at the expected branch/base and can merge, then verifies required checks
pass before Done. It is a mergeability check, not a formal compliance audit,
code/secret scan, policy evaluation, or independent Council review — those
are Council's job, above.

Existing runs keep their original workflow and gates. In the prior pipeline,
the **Plan** stage drafts clauses and stops. **Review** uses a fresh-context
reviewer from a different model family than the plan author (Claude for GPT
authors, GPT for Claude authors). Its risks, omissions, and suggestions appear
as numbered points. Each point has **Accept**, **Ignore**, or **Modify** and
Modify takes a written instruction for synthesis. Earlier discussion, when
present on an in-flight issue, remains visible as read-only history; new
point discussion is not available. Decisions persist with the issue; all
points must be decided before **Synthesis** runs.
Synthesis applies only accepted or modified points, shows the final plan, and
waits for approval. Reviewer or synthesis failures stay visible at their
respective gates and can be retried without silently approving an unreviewed
plan. The plan author's model must have a known family; an unknown/Auto model
cannot be assumed to have an alternate-family reviewer.
The canvas presents five numbered, square phase tiles with status in sequence.
Its top-right info button reveals the canvas release version and last change
datetime (localized in the webview, with UTC fallback). These identify the
installed canvas code,
not an issue transaction, PR head, or workflow-definition version. Update
`CANVAS_RELEASE` in `webview.mjs` when shipping a changed canvas; keep the
timestamp fixed within a release so reopening cannot masquerade as an update.
Selecting a reached phase
shows its stages in order (for example, Plan: Research → Prototype → Draft →
Synthesize) as numbered stage cells and opens read-only history for completed phases. Tabs support
arrow/Home/End keys; stages remain keyboard-accessible.
A completed, unpinned v2 default run may be explicitly migrated with
`migrate_phase_history` using its bound issue and current transaction number.
This changes its read-only history layout to v3 without dispatching agents,
reopening the PR, or changing existing decisions. Council appears as **Not run**,
not as a successful review; prior plan-review recommendations remain available
from Synthesize. Active and custom workflows cannot use this migration.
Planning work orders include the approved prototype and approval comment.
Independent review receives that selection as evidence and evaluates the
requested product, not the Flow Loop extension that happens to host the run.
Flow Loop code is in scope only when the issue explicitly requests changes to it.
At review sign-off, an undecided, undiscussed draft can be sent back to Plan
with specific feedback; the planner then produces a new draft and a new
independent review. Existing review-point decisions or chat are never silently
discarded by this action.
An undecided review can be rerun explicitly through `rerun_review` when its
evidence is out of scope. The replacement must not mention Flow Loop
orchestration for an issue about another product; prior review comments and
any older discussion remain in issue history.

Builds started under the earlier pipeline retain their original behavior.
The built-in default stored on disk is upgraded only when it matches an
unmodified earlier default; customized defaults and pinned in-flight workflows
are not rewritten.
An explicit `migrate_default` canvas action can upgrade an unpinned legacy
run while it is idle at prototype sign-off, before any plan exists. It checks
the bound issue and control transaction, preserves earlier artifacts, and
records the version change in the control block. Runs beyond that boundary
must finish on their original definition.

Users author their own from the canvas: gear icon → **Flow builder**.

> **Naming.** The canvas is `flow-loop` ("Flow Loop"). Two identifiers are
> deliberately NOT renamed: the `agent-loop` issue label and the
> `AGENT-LOOP-STATE` control block. Those are recorded on issues that already
> exist and are read by every machine that opens them, so renaming them would
> orphan every flow in flight.
>
> Local state DID move, from `~/.agent-loop/` to `~/.flow-loop/`, because nothing
> durable points at it — every path recorded on an issue is relative to the work
> root. `paths.mjs` migrates the old directory on first start; see
> `test/paths.test.mjs`.
>
> **Vocabulary.** A **flow** is one run, launched from the flow launcher. A
> **workflow** is the reusable definition a flow runs, authored in the **flow
> builder**. "Build" is reserved for the software artifact — the branch, the PR,
> the CI run. Definitions are
stored user-globally in `~/.flow-loop/workflows/*.json` and shared across repos.

### The unit is a step, not a stage

A step is one turn of the loop: produce an asset, validate it, then either open a
human gate or move on. `phase` is the optional outer grouping shown in the
pipeline strip; `stage` is the inner display grouping. `issueLabel` is the
issue's durable bookkeeping label, which older runs preserve.

```jsonc
{
  "id": "default", "name": "Default build loop", "rev": 1, "entry": "research",
  "steps": [{
    "id": "research",
    "stage": "research", "group": "research", "label": "Research",
    "produce": { "by": "agent", "capability": "markdown", "heading": "🔎 Research",
                 "contract": "Return artifact { body: markdown research brief }." },
    "artifact": { "fields": [{ "name": "body", "type": "markdown" }] },
    "validate": [{ "rule": "minLength", "field": "body", "value": 10 }],
    "status": { "working": "Researching prior art…" },
    "gate": null,
    "next": "prototype"
  }]
}
```

A definition is data and can never carry executable code. It may only reference
primitives by name, and every referenceable name lives in `workflow-primitives.mjs`:

| Registry | Members |
| --- | --- |
| Producers | `agent`, `panel`, `none` |
| Capabilities | `markdown`, `prototype-files`, `questionnaire`, `plan-clauses`, `implement-pr`, `finalize-pr`, `none` |
| Field types | `markdown`, `text`, `number`, `enum`, `object`, `list`, `file-set`, `pr-ref` |
| Validation rules | `required`, `minLength`, `minItems`, `uniqueField`, `pathMatches`, `fileExists`, `prOpen`, `prBranchMatches`, `prNotDraft`, `questionnaireParses` |
| Gate widgets | `markdown-view`, `option-picker`, `question-form`, `clause-pins`, `pr-review`, `textarea`, `checklist` |
| Gate outcomes | `advance`, `repeat`, `goto:<stepId>`, `panel-retry` |

Contracts may interpolate `{{owner}}`, `{{repo}}`, `{{issue}}`, `{{round}}`,
`{{branch}}`, `{{base}}`, `{{prTitle}}`, `{{protoBase}}`, `{{protoDir}}`,
`{{implDemoPath}}`, `{{reviewerModel}}`, `{{issueUrl}}` and `{{instanceId}}`.
Those values are derived by the coordinator, never by the definition — which is
what stops an authored workflow from pointing an agent at a path the validator
will not then check.

Validation rejects dangling `next`/`goto` targets, unreachable steps, duplicate
ids, unknown primitives, a `repeat` outcome on a step with no counter, and a
workflow with no terminal step. A build that could strand itself never starts.

### A run is pinned to the definition it started under

At kickoff the full definition is written to its own collapsed
`AGENT-LOOP-WORKFLOW` comment, and the control block stores only a reference:

```json
"workflow": { "id": "spike-review", "rev": 4, "hash": "sha256:…", "commentId": 12345 }
```

The definition is too big to inline — the control block has a 48KB budget it
shares with artifacts. Because the snapshot is an ordinary comment that anyone
with write access can edit, the hash is checked on every read: a snapshot that
was edited, deleted or is structurally invalid stops the run rather than
redirecting it. Editing a definition therefore only affects new builds.

Issues with no `workflow` reference — every build that predates this — run the
built-in default, which reproduces the original hardcoded pipeline exactly.

## Flow

Human buttons POST structured `/intent` JSON. The coordinator validates the live
control block, writes `AL-IN`/`AL-OUT`/`AL-SYS` comments, updates the control
block, reconciles labels, mints `opId`/submission capabilities, and sends exact
self-contained work orders with `session.send`.

The idle launcher also reads `GET /issues`, which returns the five most recently
updated open Agent Loop issues from the canvas session's repository. Selecting
one sends `open-existing`; code validates its label and canonical control block,
then binds that canvas instance without changing workflow state or waking an
agent.

Agents must not mutate Agent Loop issue state. A work order tells them what to
read, what asset to produce, and to call:

```json
{ "opId": "...", "submissionToken": "...", "artifact": { } }
```

via `submit_stage` on the already-open canvas instance.

Each newly opened canvas starts unbound at the launcher, even when `active.json`
points to a previous workflow. Selecting or starting a build binds only that
canvas server, so another canvas cannot retarget an existing window.

Agents inherit the user's repository credentials and therefore remain a trusted
asset generator. The coordinator rejects workflow markers and control fields in
submitted artifacts, but it cannot prevent a deliberately rogue agent from
using those credentials outside the supplied work order.

## Files

| File | Role |
| --- | --- |
| `extension.mjs` | Canvas declaration, read-only actions, `submit_stage`, and work-order delivery. |
| `workflow.mjs` | Deterministic coordinator: interprets the active definition, renders control/comments, transitions, validation, queues, recovery, and work-order contracts. |
| `workflow-def.mjs` | Definition schema, normalization, referential validation, canonical hashing, and the built-in default pipeline. |
| `workflow-primitives.mjs` | The registries a definition may reference: field types, validation rules, capabilities, gate widgets, outcomes. |
| `workflow-store.mjs` | CRUD over `~/.flow-loop/workflows/`, atomic writes, `rev` bumping, default seeding. |
| `server.mjs` | Loopback HTTP backend: `/state`, `/issues`, `/intent`, `/events`, `/comment`, `/pr`, `/open`, `/workflows*`, and asset serving. `/prompt` is not registered. |
| `github.mjs` | `gh` read/mutation helpers using argv/stdin, parsers, label reconciliation, PR reads, and the control-block and workflow-snapshot comment formats. |
| `webview.mjs` | UI panels, the workflow editor, and structured intent payloads. |
| `pr.mjs` | Pure PR review snapshot/check/diff helpers. |

Prototype and demo assets are served from `~\.flow-loop\work\<owner>\<repo>\<issue>\...` and are hash/containment validated before state advances.

## Tests

No runner, no dependencies — each suite is a script:

```
for f in test/*.test.mjs; do node "$f"; done
```

`test/golden.test.mjs` is a frozen fixture of the legacy pipeline: every work
order, control-block transition and label set for a full pass. It proves
existing builds still run without adopting the new review gates. A diff there
means legacy agent-visible or issue-visible behaviour changed —
refresh it deliberately with `node test/golden.test.mjs --update`, never casually.

`test/custom-workflow.test.mjs` is its counterpart: a definition nobody hardcoded,
run end to end through gates, repeats, backward jumps and a terminal step.
`test/review-stages.test.mjs` exercises the independent reviewer, point
decisions, synthesis, legacy discussion recovery, and model-family routing.
