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

// Agent Factories are experimental, so registration is guarded end to end: a
// host without the API keeps the whole loop working and only loses the panel.
let planPanel = null;
try {
  const sdk = await import("@github/copilot-sdk/extension");
  if (typeof sdk.defineFactory === "function") {
    planPanel = sdk.defineFactory(planPanelFactoryDefinition());
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

// The panel runs as a factory so its subagents get genuinely fresh contexts.
// A non-completed run is an error here: the coordinator decides whether that
// degrades or fails, and it must never mistake an empty envelope for a review.
async function runPlanPanel(args) {
  const envelope = await session.factories.run(planPanel, { args, limits: DEFAULT_LIMITS });
  if (!envelope || envelope.status !== "completed") {
    throw new Error(`plan panel run ${envelope ? envelope.status : "failed"}`);
  }
  const result = envelope.result;
  if (!result || typeof result !== "object") throw new Error("plan panel returned no result");
  return result;
}

setCapabilities({ panelAvailable: !!planPanel });

await session.log(
  planPanel ? "Agent Loop canvas extension ready (plan panel enabled)." : "Agent Loop canvas extension ready (plan panel unavailable).",
  { ephemeral: true },
);
