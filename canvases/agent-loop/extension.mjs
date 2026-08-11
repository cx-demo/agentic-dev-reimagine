// Agent Loop canvas — human-in-the-loop, multi-agent build loop.
//
// ROLE: this extension conducts deterministic workflow state transitions. Agents
// receive exact work orders and submit generated assets back through submit_stage.
//
// State is issue-authoritative: the collapsed AGENT-LOOP-STATE control-block
// comment is the machine-readable read model. The webview polls /state (which
// parses that comment) and also listens for SSE `refresh` nudges.

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import {
  startServer, broadcastRefresh, setCapabilities,
} from "./server.mjs";
import { createAgentLoopActions } from "./actions.mjs";
import { planPanelFactoryDefinition, DEFAULT_LIMITS } from "./panel.mjs";

const CANVAS_ID = "agent-loop";

// Live per-step progress for an in-flight review, keyed by opId.
//
// `args` are serialized on the way to a factory run, so a reporter callback
// cannot travel with them. The factory body executes in this process, so the
// reporter is registered here before the run starts and looked up by opId from
// inside the run. Entries are always removed in a `finally`.
const progressByOp = new Map();

// Agent Factories are experimental, so registration is guarded end to end: a
// host without the API keeps the whole loop working and only loses the review.
let planPanel = null;
try {
  const sdk = await import("@github/copilot-sdk/extension");
  if (typeof sdk.defineFactory === "function") {
    planPanel = sdk.defineFactory(planPanelFactoryDefinition(DEFAULT_LIMITS, {
      resolveProgress: (opId) => progressByOp.get(opId) || null,
    }));
  }
} catch {
  planPanel = null;
}

const servers = new Map(); // instanceId -> { server, url, clients:Set }
let session;

function refreshAll(instanceId) {
  if (instanceId && servers.has(instanceId)) broadcastRefresh(servers.get(instanceId));
  else for (const e of servers.values()) broadcastRefresh(e);
}

// ─── Canvas actions (agent/UI → deterministic coordinator) ───────────────────
// NOTE: each action keeps its `handler`. It is passed straight to createCanvas,
// which strips the metadata for the wire and dispatches `canvas.action.invoke`
// in-process. Do NOT strip handlers before handing actions to createCanvas.
const actions = createAgentLoopActions({ servers, refreshAll });

const agentLoopCanvas = createCanvas({
  id: CANVAS_ID,
  displayName: "Agentic Dev Reimagine",
  description: "Human-in-the-loop multi-agent build loop: kickoff → research → prototype → sign-off, backed by a GitHub issue.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" }, repo: { type: "string" }, issue: { type: "number" },
    },
    additionalProperties: false,
  },
  actions,
  open: async (ctx) => {
    const input = (ctx && ctx.input) || {};
    const target = input.owner && input.repo && input.issue
      ? { owner: input.owner, repo: input.repo, issue: input.issue }
      : null;
    let entry = servers.get(ctx.instanceId);
    if (!entry) {
      entry = await startServer({
        instanceId: ctx.instanceId,
        workingDirectory: ctx.session && ctx.session.workingDirectory,
        ...(target ? { active: target } : {}),
        sendPrompt: async (prompt, kind) => {
          await session.send({ prompt });
          await session.log("Agent Loop work order → agent: " + kind, { ephemeral: true });
        },
        runPanel: planPanel ? runPlanPanel : undefined,
      });
      servers.set(ctx.instanceId, entry);
    }
    if (target) await entry.setActive(target.owner, target.repo, target.issue);
    return { title: "Agent Loop", url: entry.url };
  },
  onClose: async (ctx) => {
    const entry = servers.get(ctx.instanceId);
    if (entry) {
      servers.delete(ctx.instanceId);
      for (const c of entry.clients) { try { c.end(); } catch {} }
      await new Promise((resolve) => entry.server.close(() => resolve()));
      if (entry.assetServer) await new Promise((resolve) => entry.assetServer.close(() => resolve()));
    }
  },
});

session = await joinSession({
  canvases: [agentLoopCanvas],
  ...(planPanel ? { factories: [planPanel] } : {}),
});

// A bare status is not diagnosable. A reached limit arrives as `failure.kind`
// (maxAiCredits, maxTotalSubagents, timeoutSeconds), and dropping it is what
// turned an exhausted credit budget into a blank "error" that had to be traced
// by hand. Name the cause, and keep the run id so the run can be resumed with a
// raised limit instead of restarted.
function describeFailure(envelope, spawned) {
  const bits = [String(envelope.status || "failed")];
  const kind = envelope.failure && envelope.failure.kind;
  if (kind) {
    const value = envelope.failure.value;
    bits.push(`- limit ${kind}${value === undefined ? "" : `=${value}`} reached`);
  } else if (spawned === 0) {
    bits.push(
      "- the host admitted no subagent, so the review never started"
      + " (a review spawns subagents, which requires an active agent turn; ask the agent to run it)",
    );
  } else if (envelope.error) {
    bits.push(`- ${String(envelope.error).slice(0, 300)}`);
  }
  if (envelope.runId) bits.push(`(run ${envelope.runId})`);
  return bits.join(" ");
}

// How many subagents the run actually admitted.
//
// This is the ONLY surviving evidence that separates "the host refused to start
// the reviewer" from "the reviewer produced an unusable review". The SDK
// swallows a spawn refusal — `prepareSubagent` throws, the error is discarded,
// and `ctx.agent` resolves null — so without this count a host-side refusal is
// reported as the model's fault. The run envelope does not carry it; the run
// detail does.
async function spawnCount(runId) {
  if (!runId || typeof session?.factory?.getRunDetail !== "function") return null;
  try {
    const detail = await session.factory.getRunDetail(runId);
    const n = detail?.consumed?.subagents ?? detail?.totalSpawnedAgentCount;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

// The review runs as a factory so its subagents get genuinely fresh contexts.
// A non-completed run is an error here: the coordinator decides whether that
// degrades or fails, and it must never mistake an empty envelope for a review.
//
// NOTE: the registration key on joinSession is `factories`, but the runtime
// accessor is the singular `session.factory`. They do not match, and the
// plural is a private field, so reaching for it fails at call time rather
// than at startup.
async function runPlanPanel(args, onProgress) {
  const opId = String((args && args.opId) || "");
  if (opId && typeof onProgress === "function") progressByOp.set(opId, onProgress);
  let envelope;
  try {
    envelope = await session.factory.run(planPanel, { args, limits: DEFAULT_LIMITS });
  } finally {
    if (opId) progressByOp.delete(opId);
  }
  if (!envelope || envelope.status !== "completed") {
    if (!envelope) throw new Error("plan review run failed");
    const spawned = await spawnCount(envelope.runId);
    const err = new Error(`plan review run ${describeFailure(envelope, spawned)}`);
    if (spawned === 0) err.code = "review-not-started";
    throw err;
  }
  const result = envelope.result;
  if (!result || typeof result !== "object") throw new Error("plan review returned no result");
  return result;
}

// Both halves of the API must be present. Checking only `defineFactory` proves
// a factory can be *described*, not that it can be *run*, which reports the
// panel as available and then fails mid-plan instead of degrading up front.
const panelAvailable = !!planPanel && typeof session?.factory?.run === "function";
setCapabilities({ panelAvailable });

await session.log(
  panelAvailable ? "Agent Loop canvas extension ready (plan panel enabled)." : "Agent Loop canvas extension ready (plan panel unavailable).",
  { ephemeral: true },
);
