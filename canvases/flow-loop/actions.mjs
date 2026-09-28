import { ACTIVE_FILE, DATA_ROOT, WORK_ROOT } from "./server.mjs";
import { COUNCIL_SCHEMA } from "./council.mjs";

export function createAgentLoopActions({ servers, refreshAll }) {
  return [
    {
      name: "refresh",
      description: "Nudge the Flow Loop canvas to re-read issue state after a transition.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        refreshAll(ctx && ctx.instanceId);
        return { ok: true };
      },
    },
    {
      name: "get_state",
      description: "Return the current Flow Loop read model for this canvas instance.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const entry = servers.get(ctx && ctx.instanceId);
        return entry ? entry.buildState() : { active: false };
      },
    },
    {
      name: "get_config",
      description: "Return the fixed on-disk paths used by Flow Loop.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ dataRoot: DATA_ROOT, activeFile: ACTIVE_FILE, workRoot: WORK_ROOT }),
    },
    {
      name: "set_active",
      description: "Bind this canvas instance to a Flow Loop issue and return its fresh read model.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issue: { type: "number" },
        },
        required: ["owner", "repo", "issue"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const { owner, repo, issue } = (ctx && ctx.input) || {};
        if (!owner || !repo || !issue) {
          return { ok: false, error: "owner, repo and issue are all required" };
        }
        const entry = servers.get(ctx && ctx.instanceId);
        if (!entry) return { ok: false, error: "Flow Loop instance is not active" };
        await entry.setActive(owner, repo, issue);
        refreshAll(ctx && ctx.instanceId);
        return { ok: true, state: await entry.buildState() };
      },
    },
    {
      name: "migrate_default",
      description: "Migrate the bound issue from the legacy default to the new review/synthesis pipeline, only at idle prototype sign-off.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issue: { type: "number" },
          expectedTxn: { type: "number" },
        },
        required: ["owner", "repo", "issue", "expectedTxn"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const entry = servers.get(ctx && ctx.instanceId);
        if (!entry || !entry.coordinator) return { ok: false, error: "Flow Loop instance is not active" };
        const out = await entry.coordinator.migrateDefault((ctx && ctx.input) || {});
        refreshAll(ctx && ctx.instanceId);
        return out;
      },
    },
    {
      name: "migrate_phase_history",
      description: "Show a completed v2 default run in phased history without inventing a Council review or reopening its PR.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issue: { type: "number" },
          expectedTxn: { type: "number" },
        },
        required: ["owner", "repo", "issue", "expectedTxn"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const entry = servers.get(ctx && ctx.instanceId);
        if (!entry || !entry.coordinator) return { ok: false, error: "Flow Loop instance is not active" };
        const out = await entry.coordinator.migratePhaseHistory((ctx && ctx.input) || {});
        refreshAll(ctx && ctx.instanceId);
        return out;
      },
    },
    {
      name: "review_redraft",
      description: "Request a fresh product-focused plan and review from a review gate before any point decisions or discussion.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issue: { type: "number" },
          controlCommentId: { type: "number" },
          expectedTxn: { type: "number" },
          feedback: { type: "string" },
        },
        required: ["owner", "repo", "issue", "controlCommentId", "expectedTxn", "feedback"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const entry = servers.get(ctx && ctx.instanceId);
        if (!entry || !entry.coordinator) return { ok: false, error: "Flow Loop instance is not active" };
        const input = (ctx && ctx.input) || {};
        const active = await entry.buildState();
        if (!active.active || active.owner !== input.owner || active.repo !== input.repo || active.issue !== input.issue) {
          return { ok: false, error: "review redraft target is not bound to this canvas" };
        }
        const out = await entry.coordinator.handleIntent({
          kind: "review-redraft", owner: input.owner, repo: input.repo, issue: input.issue,
          controlCommentId: input.controlCommentId, expectedTxn: input.expectedTxn,
          data: { feedback: input.feedback },
        });
        refreshAll(ctx && ctx.instanceId);
        return out;
      },
    },
    {
      name: "rerun_review",
      description: "Replace an undecided review with a fresh task-scoped review; prior comments remain in issue history.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issue: { type: "number" },
          controlCommentId: { type: "number" },
          expectedTxn: { type: "number" },
          reason: { type: "string" },
        },
        required: ["owner", "repo", "issue", "controlCommentId", "expectedTxn", "reason"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const entry = servers.get(ctx && ctx.instanceId);
        if (!entry || !entry.coordinator) return { ok: false, error: "Flow Loop instance is not active" };
        const input = (ctx && ctx.input) || {};
        const active = await entry.buildState();
        if (!active.active || active.owner !== input.owner || active.repo !== input.repo || active.issue !== input.issue) {
          return { ok: false, error: "review rerun target is not bound to this canvas" };
        }
        const out = await entry.coordinator.handleIntent({
          kind: "review-rerun", owner: input.owner, repo: input.repo, issue: input.issue,
          controlCommentId: input.controlCommentId, expectedTxn: input.expectedTxn,
          data: { reason: input.reason },
        });
        refreshAll(ctx && ctx.instanceId);
        return out;
      },
    },
    {
      // Review and synthesis need subagents and an active turn.
      // Running it here -- inside the agent's tool call -- is what supplies
      // that turn; a webview click cannot, so the coordinator routes UI-origin
      // triggers back through the agent to this action.
      name: "resume_panel",
      description: "Run pending Flow Loop review or synthesis inside an active agent turn.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issue: { type: "number" },
        },
        required: ["owner", "repo", "issue"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const entry = servers.get(ctx && ctx.instanceId);
        if (!entry || !entry.coordinator) return { ok: false, error: "Flow Loop instance is not active" };
        const out = await entry.coordinator.resumePanel((ctx && ctx.input) || {});
        refreshAll(ctx && ctx.instanceId);
        return out;
      },
    },
    {
      name: "submit_stage",
      description: "Submit a generated stage asset for this Flow Loop canvas instance.",
      inputSchema: {
        type: "object",
        properties: {
          opId: { type: "string" },
          submissionToken: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          issue: { type: "number" },
          artifact: { type: "object" },
        },
        required: ["opId", "submissionToken", "artifact"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const entry = servers.get(ctx && ctx.instanceId);
        if (!entry || !entry.coordinator) {
          return { ok: false, error: "Flow Loop instance is not active" };
        }
        const out = await entry.coordinator.submitStage((ctx && ctx.input) || {});
        refreshAll(ctx && ctx.instanceId);
        return out;
      },
    },
    {
      name: "submit_council",
      description: "Submit read-only PR session findings for the pinned Council operation and head.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" }, repo: { type: "string" }, issue: { type: "number" },
          opId: { type: "string" }, submissionToken: { type: "string" },
          prNumber: { type: "number" }, headSha: { type: "string" },
          findings: COUNCIL_SCHEMA.properties.findings,
        },
        required: ["owner", "repo", "issue", "opId", "submissionToken", "prNumber", "headSha", "findings"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const entry = servers.get(ctx && ctx.instanceId);
        if (!entry || !entry.coordinator) return { ok: false, error: "Flow Loop instance is not active" };
        const out = await entry.coordinator.submitCouncil((ctx && ctx.input) || {});
        refreshAll(ctx && ctx.instanceId);
        return out;
      },
    },
    {
      name: "council_session_failed",
      description: "Report that a PR review session could not start or complete.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" }, repo: { type: "string" }, issue: { type: "number" },
          opId: { type: "string" }, submissionToken: { type: "string" }, reason: { type: "string" },
        },
        required: ["owner", "repo", "issue", "opId", "submissionToken", "reason"],
        additionalProperties: false,
      },
      handler: async (ctx) => {
        const entry = servers.get(ctx && ctx.instanceId);
        if (!entry || !entry.coordinator) return { ok: false, error: "Flow Loop instance is not active" };
        const out = await entry.coordinator.failCouncilSession((ctx && ctx.input) || {});
        refreshAll(ctx && ctx.instanceId);
        return out;
      },
    },
  ];
}
