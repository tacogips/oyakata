import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { MockNodeScenario } from "../workflow/adapter";
import { runWorkflow } from "../workflow/engine";
import { loadWorkflowFromDisk } from "../workflow/load";
import { isSafeWorkflowName, resolveEffectiveRoots } from "../workflow/paths";
import { computeWorkflowRevisionFromFiles } from "../workflow/revision";
import { createSessionId } from "../workflow/session";
import { saveWorkflowToDisk } from "../workflow/save";
import { listSessions, loadSession, saveSession, type SessionStoreOptions } from "../workflow/session-store";
import type { LoadOptions } from "../workflow/types";
import { validateWorkflowBundleDetailed } from "../workflow/validate";
import { deriveWorkflowVisualization } from "../workflow/visualization";

export interface ApiContext extends LoadOptions, SessionStoreOptions {
  readonly readOnly?: boolean;
  readonly noExec?: boolean;
  readonly fixedWorkflowName?: string;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}

function remapNodePayloadsForValidation(bundleObj: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const workflow = bundleObj["workflow"];
  const nodePayloads = bundleObj["nodePayloads"];
  if (
    typeof workflow !== "object" ||
    workflow === null ||
    !Array.isArray((workflow as { nodes?: unknown }).nodes) ||
    typeof nodePayloads !== "object" ||
    nodePayloads === null ||
    Array.isArray(nodePayloads)
  ) {
    return {};
  }

  const payloadMap = nodePayloads as Readonly<Record<string, unknown>>;
  const remapped: Record<string, unknown> = { ...payloadMap };
  for (const entry of (workflow as { nodes: Array<Record<string, unknown>> }).nodes) {
    const nodeId = typeof entry["id"] === "string" ? entry["id"] : undefined;
    const nodeFile = typeof entry["nodeFile"] === "string" ? entry["nodeFile"] : undefined;
    if (!nodeId || !nodeFile) {
      continue;
    }
    const payload = payloadMap[nodeFile] ?? payloadMap[nodeId];
    if (payload !== undefined) {
      remapped[nodeFile] = payload;
    }
  }

  return remapped;
}

function renderWebUi(fixedWorkflowName?: string): string {
  const fixed = JSON.stringify(fixedWorkflowName ?? "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>oyakata UI</title>
  <style>
    :root {
      --bg0: #eef5ea;
      --bg1: #fbf7ed;
      --panel: rgba(255, 255, 255, 0.92);
      --line: #cad3c7;
      --text: #173222;
      --muted: #567160;
      --accent: #8b3d16;
      --accent-soft: #f4d9bf;
      --ok: #21633d;
      --warn: #8a5f00;
      --fail: #992b2b;
      --default-scope: #cfdacb;
      --group-scope: #c7dfcf;
      --loop-scope: #f0d4b6;
    }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.9), transparent 34%),
        linear-gradient(180deg, var(--bg0), var(--bg1));
      color: var(--text);
      font: 14px/1.45 "IBM Plex Sans", "Segoe UI", sans-serif;
    }
    .wrap { max-width: 1260px; margin: 24px auto 48px; padding: 0 16px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      margin-bottom: 16px;
      box-shadow: 0 14px 40px rgba(28, 53, 38, 0.07);
      backdrop-filter: blur(8px);
    }
    .layout { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; align-items: start; }
    .stack { display: grid; gap: 16px; }
    .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; }
    .toolbar > div { flex: 1 1 220px; }
    h1 { margin: 0 0 12px; font-size: 24px; letter-spacing: -0.02em; }
    h2 { margin: 0 0 8px; font-size: 16px; }
    label { display: block; margin: 10px 0 4px; color: var(--muted); }
    input, select, textarea, button { font: inherit; }
    input, select, textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.96);
      color: var(--text);
    }
    textarea { min-height: 110px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .row.three { grid-template-columns: repeat(3, 1fr); }
    button {
      border: 0;
      background: var(--accent);
      color: white;
      border-radius: 999px;
      padding: 10px 16px;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease;
    }
    button:hover { transform: translateY(-1px); }
    button.secondary { background: #315d46; }
    button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
    button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    pre { margin: 0; background: #112117; color: #deeadb; padding: 12px; border-radius: 12px; overflow: auto; max-height: 280px; }
    .status { font-weight: 600; }
    .ok { color: var(--ok); } .warn { color: var(--warn); } .fail { color: var(--fail); }
    .muted { color: var(--muted); }
    .workflow-board { display: grid; gap: 12px; }
    .workflow-row {
      position: relative;
      padding-left: calc(18px + var(--indent, 0) * 28px);
    }
    .workflow-row::before {
      content: "";
      position: absolute;
      left: calc(8px + var(--indent, 0) * 28px);
      top: 0;
      bottom: 0;
      width: 2px;
      border-radius: 999px;
      background: var(--scope-color, var(--default-scope));
      opacity: 0.85;
    }
    .workflow-item {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 12px;
      align-items: start;
    }
    .reorder { display: grid; gap: 6px; margin-top: 8px; }
    .reorder button { padding: 6px 10px; min-width: 54px; }
    .node-card {
      border: 1px solid var(--line);
      border-left: 8px solid var(--scope-color, var(--default-scope));
      border-radius: 16px;
      padding: 14px 16px;
      background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(247,250,246,0.94));
    }
    .node-card.selected { box-shadow: 0 0 0 2px rgba(139,61,22,0.22); }
    .node-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
    .node-title { font-size: 15px; font-weight: 700; }
    .node-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      background: rgba(18, 41, 28, 0.06);
      color: var(--text);
    }
    .scope-pill.default { background: rgba(23,50,34,0.08); }
    .scope-pill.group { background: var(--group-scope); }
    .scope-pill.loop { background: var(--loop-scope); }
    .node-desc { margin-top: 10px; color: var(--muted); font-size: 13px; }
    .editor-note { font-size: 12px; color: var(--muted); margin-top: 8px; }
    .empty { color: var(--muted); border: 1px dashed var(--line); border-radius: 14px; padding: 14px; }
    .issues { display: grid; gap: 8px; }
    .issue {
      width: 100%;
      text-align: left;
      border-radius: 14px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.82);
      color: var(--text);
    }
    .issue.error { border-color: rgba(153,43,43,0.35); }
    .issue.warning { border-color: rgba(138,95,0,0.35); }
    .issue-path { font-size: 12px; color: var(--muted); }
    .issue-message { font-weight: 600; margin-top: 4px; }
    .split { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    .collection { display: grid; gap: 12px; margin-top: 14px; }
    .collection-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .collection-list { display: grid; gap: 10px; }
    .collection-item {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: rgba(255,255,255,0.84);
    }
    .collection-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .collection-empty {
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 14px;
      padding: 12px;
    }
    .checkbox-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px;
    }
    .checkbox-chip {
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 8px 10px;
      background: rgba(255,255,255,0.88);
    }
    .checkbox-chip.locked {
      background: rgba(199,223,207,0.5);
    }
    .checkbox-chip input {
      width: auto;
      margin: 0;
    }
    .mini-label { display: block; margin: 0 0 4px; font-size: 12px; color: var(--muted); }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .row { grid-template-columns: 1fr; }
      .row.three { grid-template-columns: 1fr; }
      .split { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>oyakata Vertical Workflow Editor</h1>
      <div class="toolbar">
        <div>
          <label for="workflow">Workflow</label>
          <select id="workflow"></select>
        </div>
        <div>
          <label for="workflowDescription">Workflow Description</label>
          <textarea id="workflowDescription" placeholder="Describe what this workflow does"></textarea>
        </div>
      </div>
      <div class="toolbar" style="margin-top:12px;">
        <button id="reloadButton" class="ghost">Reload</button>
        <button id="validateButton" class="ghost">Validate Workflow</button>
        <button id="saveButton">Save Workflow</button>
        <div id="editorStatus" class="status muted"></div>
      </div>
    </div>
    <div class="layout">
      <div class="stack">
        <div class="card">
          <h2>Vertical Workflow</h2>
          <div class="editor-note">Nodes are rendered as ordered cards. Indent and scope color are derived from loop and sub-workflow structure.</div>
          <div id="workflowBoard" class="workflow-board" style="margin-top:14px;"></div>
        </div>
        <div class="card">
          <h2>Runner</h2>
          <div class="row">
            <div>
              <label for="prompt">Prompt Input</label>
              <textarea id="prompt" placeholder="Describe what should be built"></textarea>
            </div>
            <div>
              <label for="mockScenario">Mock Scenario JSON (optional)</label>
              <textarea id="mockScenario" placeholder='{"node-id": {"when":{"always":true},"payload":{"k":"v"}}}'></textarea>
            </div>
          </div>
          <div class="row">
            <div>
          <label for="maxSteps">Max Steps (optional pause)</label>
          <input id="maxSteps" type="number" min="1" placeholder="empty = run until done" />
        </div>
          </div>
          <div style="margin-top:12px;">
            <button id="runButton" class="secondary">Run (Async)</button>
          </div>
        </div>
        <div class="card">
          <h2>Session Progress</h2>
          <div id="sessionLine" class="status"></div>
          <div id="nodeLine" style="margin:8px 0 10px; color:var(--muted)"></div>
          <pre id="sessionJson">{}</pre>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <h2>Workflow Structure</h2>
          <div class="row">
            <div>
              <label for="workflowMaxLoopIterations">Default Max Loop Iterations</label>
              <input id="workflowMaxLoopIterations" type="number" min="1" />
            </div>
            <div>
              <label for="workflowNodeTimeoutMs">Default Node Timeout (ms)</label>
              <input id="workflowNodeTimeoutMs" type="number" min="1" />
            </div>
          </div>
          <div class="collection">
            <div class="collection-header">
              <h2 style="margin:0;">Nodes</h2>
              <button id="addNodeButton" class="ghost" type="button">Add Node</button>
            </div>
            <div id="workflowNodesList" class="collection-list"></div>
          </div>
          <div class="split">
            <div class="collection">
              <div class="collection-header">
                <h2 style="margin:0;">Edges</h2>
                <button id="addEdgeButton" class="ghost" type="button">Add Edge</button>
              </div>
              <div id="workflowEdgesList" class="collection-list"></div>
            </div>
            <div class="collection">
              <div class="collection-header">
                <h2 style="margin:0;">Sub-workflows</h2>
                <button id="addSubWorkflowButton" class="ghost" type="button">Add Group</button>
              </div>
              <div id="workflowSubWorkflowsList" class="collection-list"></div>
            </div>
          </div>
          <div class="collection">
            <div class="collection-header">
              <h2 style="margin:0;">Loops</h2>
              <button id="addLoopButton" class="ghost" type="button">Add Loop</button>
            </div>
            <div id="workflowLoopsList" class="collection-list"></div>
          </div>
          <div class="editor-note">This replaces canvas editing. Structure is edited as vertical-order-aware row forms, then saved back as normalized workflow files.</div>
        </div>
        <div class="card">
          <h2>Node Properties</h2>
          <div id="selectedNodeLabel" class="muted">Select a node card to edit its payload.</div>
          <label for="nodeExecutionBackend">Execution Backend</label>
          <select id="nodeExecutionBackend">
            <option value="">derive from model</option>
            <option value="tacogips/codex-agent">tacogips/codex-agent</option>
            <option value="tacogips/claude-code-agent">tacogips/claude-code-agent</option>
            <option value="official/openai-sdk">official/openai-sdk</option>
            <option value="official/anthropic-sdk">official/anthropic-sdk</option>
          </select>
          <div id="nodeBackendHint" class="editor-note">
            Leave backend empty only when model is a tacogips CLI-wrapper identifier. Official SDK backends require a provider model name such as gpt-5 or claude-sonnet-4-5.
          </div>
          <label for="nodeModel">Model</label>
          <input id="nodeModel" type="text" placeholder="tacogips/codex-agent or gpt-5 / claude-sonnet-4-5" />
          <label for="nodePromptTemplate">Prompt Template</label>
          <textarea id="nodePromptTemplate" placeholder="Prompt template"></textarea>
          <label for="nodeVariables">Variables JSON</label>
          <textarea id="nodeVariables" placeholder='{"key":"value"}'></textarea>
          <div class="editor-note">Saving writes normalized workflow JSON plus vertical order only. Derived indent/color are not persisted.</div>
        </div>
        <div class="card">
          <h2>Validation</h2>
          <div id="validationSummary" class="muted">Run validation before save to inspect ordering, loop, and grouping issues.</div>
          <div id="issueList" class="issues" style="margin-top:12px;"></div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const fixedWorkflow = ${fixed};
    const workflowEl = document.getElementById("workflow");
    const workflowDescriptionEl = document.getElementById("workflowDescription");
    const workflowBoardEl = document.getElementById("workflowBoard");
    const reloadButtonEl = document.getElementById("reloadButton");
    const validateButtonEl = document.getElementById("validateButton");
    const saveButtonEl = document.getElementById("saveButton");
    const editorStatusEl = document.getElementById("editorStatus");
    const validationSummaryEl = document.getElementById("validationSummary");
    const issueListEl = document.getElementById("issueList");
    const workflowMaxLoopIterationsEl = document.getElementById("workflowMaxLoopIterations");
    const workflowNodeTimeoutMsEl = document.getElementById("workflowNodeTimeoutMs");
    const workflowNodesListEl = document.getElementById("workflowNodesList");
    const workflowEdgesListEl = document.getElementById("workflowEdgesList");
    const workflowSubWorkflowsListEl = document.getElementById("workflowSubWorkflowsList");
    const workflowLoopsListEl = document.getElementById("workflowLoopsList");
    const addNodeButtonEl = document.getElementById("addNodeButton");
    const addEdgeButtonEl = document.getElementById("addEdgeButton");
    const addSubWorkflowButtonEl = document.getElementById("addSubWorkflowButton");
    const addLoopButtonEl = document.getElementById("addLoopButton");
    const selectedNodeLabelEl = document.getElementById("selectedNodeLabel");
    const nodeExecutionBackendEl = document.getElementById("nodeExecutionBackend");
    const nodeBackendHintEl = document.getElementById("nodeBackendHint");
    const nodeModelEl = document.getElementById("nodeModel");
    const nodePromptTemplateEl = document.getElementById("nodePromptTemplate");
    const nodeVariablesEl = document.getElementById("nodeVariables");
    const promptEl = document.getElementById("prompt");
    const scenarioEl = document.getElementById("mockScenario");
    const maxStepsEl = document.getElementById("maxSteps");
    const runButtonEl = document.getElementById("runButton");
    const sessionLineEl = document.getElementById("sessionLine");
    const nodeLineEl = document.getElementById("nodeLine");
    const sessionJsonEl = document.getElementById("sessionJson");
    const state = {
      revision: null,
      bundle: null,
      derivedVisualization: [],
      selectedNodeId: null,
      issues: [],
    };
    let pollTimer = null;

    function statusClass(status) {
      if (status === "completed") return "ok";
      if (status === "paused" || status === "running") return "warn";
      return "fail";
    }

    function scopeType(color) {
      if (typeof color !== "string") return "default";
      if (color.startsWith("loop:")) return "loop";
      if (color.startsWith("group:")) return "group";
      return "default";
    }

    function scopeLabel(color) {
      const kind = scopeType(color);
      if (kind === "loop") return "loop " + color.slice("loop:".length);
      if (kind === "group") return "group " + color.slice("group:".length);
      return "top-level";
    }

    function scopeColor(kind) {
      if (kind === "loop") return "var(--loop-scope)";
      if (kind === "group") return "var(--group-scope)";
      return "var(--default-scope)";
    }

    function deriveVisualization(bundle) {
      if (!bundle || !bundle.workflowVis || !Array.isArray(bundle.workflowVis.nodes)) {
        return [];
      }

      const orderedVisNodes = [...bundle.workflowVis.nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const orderByNodeId = new Map();
      orderedVisNodes.forEach((node) => {
        orderByNodeId.set(node.id, node.order);
      });

      function compareIntervals(a, b) {
        const spanA = a.endOrder - a.startOrder;
        const spanB = b.endOrder - b.startOrder;
        return spanA - spanB || a.startOrder - b.startOrder || a.id.localeCompare(b.id);
      }

      function collectScopesForOrder(order, intervals) {
        return intervals
          .filter((entry) => entry.startOrder <= order && order <= entry.endOrder)
          .sort(compareIntervals);
      }

      const groupIntervals = Array.isArray(bundle.workflow.subWorkflows)
        ? bundle.workflow.subWorkflows
            .map((subWorkflow) => {
              const inputOrder = orderByNodeId.get(subWorkflow.inputNodeId);
              const outputOrder = orderByNodeId.get(subWorkflow.outputNodeId);
              if (typeof inputOrder !== "number" || typeof outputOrder !== "number" || inputOrder > outputOrder) {
                return null;
              }
              return {
                id: subWorkflow.id,
                startOrder: inputOrder,
                endOrder: outputOrder,
              };
            })
            .filter((entry) => entry !== null)
            .sort(compareIntervals)
        : [];

      const loopIntervals = Array.isArray(bundle.workflow.loops)
        ? bundle.workflow.loops
            .map((loop) => {
              const judgeOrder = orderByNodeId.get(loop.judgeNodeId);
              if (typeof judgeOrder !== "number") {
                return null;
              }
              const continueTargetOrders = (Array.isArray(bundle.workflow.edges) ? bundle.workflow.edges : [])
                .filter((edge) => edge.from === loop.judgeNodeId && edge.when === loop.continueWhen)
                .map((edge) => orderByNodeId.get(edge.to))
                .filter((value) => typeof value === "number" && value <= judgeOrder);
              if (continueTargetOrders.length === 0) {
                return null;
              }
              return {
                id: loop.id,
                startOrder: Math.min(...continueTargetOrders),
                endOrder: judgeOrder,
              };
            })
            .filter((entry) => entry !== null)
            .sort(compareIntervals)
        : [];

      return orderedVisNodes.map((node) => {
        const groupScopes = collectScopesForOrder(node.order, groupIntervals);
        const loopScopes = collectScopesForOrder(node.order, loopIntervals);
        return {
          id: node.id,
          order: node.order,
          indent: groupScopes.length + loopScopes.length,
          color:
            loopScopes.length > 0
              ? "loop:" + loopScopes[0].id
              : groupScopes.length > 0
                ? "group:" + groupScopes[0].id
                : "default",
        };
      });
    }

    function normalizeWorkflowVis() {
      if (!state.bundle || !state.bundle.workflowVis || !Array.isArray(state.bundle.workflowVis.nodes)) {
        return;
      }
      const sorted = [...state.bundle.workflowVis.nodes]
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map((entry, index) => ({ id: entry.id, order: index }));
      state.bundle.workflowVis.nodes = sorted;
      refreshDerivedVisualization();
    }

    function refreshDerivedVisualization() {
      state.derivedVisualization = state.bundle ? deriveVisualization(state.bundle) : [];
    }

    function getWorkflowNode(nodeId) {
      if (!state.bundle) return null;
      return (state.bundle.workflow.nodes || []).find((node) => node.id === nodeId) || null;
    }

    function getNodePayload(nodeId) {
      if (!state.bundle || !state.bundle.nodePayloads) return null;
      return state.bundle.nodePayloads[nodeId] || null;
    }

    function setEditorStatus(text, className) {
      editorStatusEl.textContent = text || "";
      editorStatusEl.className = "status " + (className || "muted");
    }

    function defaultNodeFile(nodeId) {
      return "node-" + nodeId + ".json";
    }

    function cloneValue(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function workflowNodeOptions() {
      if (!state.bundle || !Array.isArray(state.bundle.workflow.nodes)) {
        return [];
      }
      return state.bundle.workflow.nodes.map((node) => ({ value: node.id, label: node.id }));
    }

    function workflowNodeOptionsByKind(kind) {
      if (!state.bundle || !Array.isArray(state.bundle.workflow.nodes)) {
        return [];
      }
      return state.bundle.workflow.nodes
        .filter((node) => node.kind === kind)
        .map((node) => ({ value: node.id, label: node.id }));
    }

    function workflowNodeOptionsByKinds(kinds) {
      if (!state.bundle || !Array.isArray(state.bundle.workflow.nodes)) {
        return [];
      }
      const acceptedKinds = new Set(Array.isArray(kinds) ? kinds : [kinds]);
      return state.bundle.workflow.nodes
        .filter((node) => acceptedKinds.has(node.kind || "task"))
        .map((node) => ({ value: node.id, label: node.id + " (" + (node.kind || "task") + ")" }));
    }

    function subWorkflowNodeOwnerId(nodeId) {
      if (!state.bundle) {
        return undefined;
      }
      const owner = state.bundle.workflow.subWorkflows.find((subWorkflow) => (
        Array.isArray(subWorkflow.nodeIds) && subWorkflow.nodeIds.includes(nodeId)
      ));
      return owner ? owner.id : undefined;
    }

    function nodeReservedByOtherSubWorkflow(nodeId, currentSubWorkflowId) {
      const usage = subWorkflowUsageForNode(nodeId);
      return (
        usage.managerOf.some((subWorkflowId) => subWorkflowId !== currentSubWorkflowId) ||
        usage.inputOf.some((subWorkflowId) => subWorkflowId !== currentSubWorkflowId) ||
        usage.outputOf.some((subWorkflowId) => subWorkflowId !== currentSubWorkflowId)
      );
    }

    function availableSubWorkflowManagerNodes(currentSubWorkflowId) {
      if (!state.bundle || !Array.isArray(state.bundle.workflow.nodes)) {
        return [];
      }
      return state.bundle.workflow.nodes.filter((node) => {
        const usage = subWorkflowUsageForNode(node.id);
        const kind = node.kind || "task";
        const managesOtherSubWorkflow = usage.managerOf.some((subWorkflowId) => subWorkflowId !== currentSubWorkflowId);
        const usedAsBoundaryElsewhere = nodeReservedByOtherSubWorkflow(node.id, currentSubWorkflowId);
        if (usage.isWorkflowManager || managesOtherSubWorkflow || usedAsBoundaryElsewhere) {
          return false;
        }
        return kind !== "root-manager";
      });
    }

    function subWorkflowManagerNodeOptions(currentSubWorkflowId) {
      return availableSubWorkflowManagerNodes(currentSubWorkflowId)
        .map((node) => ({ value: node.id, label: node.id + " (" + (node.kind || "task") + ")" }));
    }

    function firstWorkflowNodeOptionByKind(kind, options) {
      if (!state.bundle || !Array.isArray(state.bundle.workflow.nodes)) {
        return null;
      }
      const preferUnused = !options || options.preferUnused !== false;
      const usedNodeIds =
        preferUnused
          ? new Set(
              (state.bundle.workflow.subWorkflows || []).flatMap((subWorkflow) => {
                const nodeIds = [];
                if (subWorkflow.inputNodeId) {
                  nodeIds.push(subWorkflow.inputNodeId);
                }
                if (subWorkflow.outputNodeId) {
                  nodeIds.push(subWorkflow.outputNodeId);
                }
                return nodeIds;
              }),
            )
          : new Set();
      return state.bundle.workflow.nodes.find((node) => node.kind === kind && !usedNodeIds.has(node.id)) || null;
    }

    function firstUnusedSubWorkflowManagerNodeOption() {
      if (!state.bundle) {
        return null;
      }
      const usedManagerIds = new Set(
        (state.bundle.workflow.subWorkflows || [])
          .map((subWorkflow) => subWorkflow.managerNodeId)
          .filter((value) => typeof value === "string" && value.length > 0),
      );
      return availableSubWorkflowManagerNodes().find((node) => !usedManagerIds.has(node.id)) || null;
    }

    function normalizeNodeIdList(values) {
      return (Array.isArray(values) ? values : [])
        .filter((value, index, all) => typeof value === "string" && value.length > 0 && all.indexOf(value) === index);
    }

    function collectRequiredSubWorkflowNodeIds(subWorkflow) {
      return normalizeNodeIdList([
        subWorkflow.managerNodeId,
        subWorkflow.inputNodeId,
        subWorkflow.outputNodeId,
      ]);
    }

    function normalizeSubWorkflowNodeIds(subWorkflow) {
      subWorkflow.nodeIds = normalizeNodeIdList([
        ...(Array.isArray(subWorkflow.nodeIds) ? subWorkflow.nodeIds : []),
        ...collectRequiredSubWorkflowNodeIds(subWorkflow),
      ]);
      return subWorkflow.nodeIds;
    }

    function normalizeAllSubWorkflowNodeIds() {
      if (!state.bundle || !Array.isArray(state.bundle.workflow.subWorkflows)) {
        return;
      }
      state.bundle.workflow.subWorkflows.forEach((subWorkflow) => {
        normalizeSubWorkflowNodeIds(subWorkflow);
      });
    }

    function subWorkflowUsageForNode(nodeId) {
      if (!state.bundle) {
        return {
          isWorkflowManager: false,
          managerOf: [],
          inputOf: [],
          outputOf: [],
        };
      }
      return {
        isWorkflowManager: state.bundle.workflow.managerNodeId === nodeId,
        managerOf: state.bundle.workflow.subWorkflows
          .filter((subWorkflow) => subWorkflow.managerNodeId === nodeId)
          .map((subWorkflow) => subWorkflow.id),
        inputOf: state.bundle.workflow.subWorkflows
          .filter((subWorkflow) => subWorkflow.inputNodeId === nodeId)
          .map((subWorkflow) => subWorkflow.id),
        outputOf: state.bundle.workflow.subWorkflows
          .filter((subWorkflow) => subWorkflow.outputNodeId === nodeId)
          .map((subWorkflow) => subWorkflow.id),
      };
    }

    function subWorkflowBoundaryNodeOptions(kind, subWorkflow) {
      if (!state.bundle || !subWorkflow) {
        return [];
      }
      const currentNodeId =
        kind === "input"
          ? subWorkflow.inputNodeId
          : kind === "output"
            ? subWorkflow.outputNodeId
            : subWorkflow.managerNodeId;
      const blockedBoundaryNodeIds = new Set(
        [subWorkflow.managerNodeId, subWorkflow.inputNodeId, subWorkflow.outputNodeId]
          .filter((nodeId) => typeof nodeId === "string" && nodeId.length > 0 && nodeId !== currentNodeId),
      );
      return state.bundle.workflow.nodes
        .filter((node) => (node.kind || "task") === kind)
        .filter((node) => node.id === currentNodeId || !nodeReservedByOtherSubWorkflow(node.id, subWorkflow.id))
        .filter((node) => node.id === currentNodeId || !blockedBoundaryNodeIds.has(node.id))
        .map((node) => ({ value: node.id, label: node.id + " (" + (node.kind || "task") + ")" }));
    }

    function nodeKindOptionsForNode(node) {
      const usage = subWorkflowUsageForNode(node.id);
      if (usage.isWorkflowManager) {
        return [
          { value: "root-manager", label: "root-manager" },
          { value: "manager", label: "manager (legacy)" },
        ];
      }
      if (usage.managerOf.length > 0) {
        return [
          { value: "sub-manager", label: "sub-manager" },
          { value: "manager", label: "manager (legacy)" },
        ];
      }
      if (usage.inputOf.length > 0) {
        return [{ value: "input", label: "input" }];
      }
      if (usage.outputOf.length > 0) {
        return [{ value: "output", label: "output" }];
      }
      return [
        { value: "sub-manager", label: "sub-manager" },
        { value: "manager", label: "manager (legacy)" },
        { value: "task", label: "task" },
        { value: "input", label: "input" },
        { value: "output", label: "output" },
        { value: "branch-judge", label: "branch-judge" },
        { value: "loop-judge", label: "loop-judge" },
      ];
    }

    function nodeKindHintForNode(node) {
      const usage = subWorkflowUsageForNode(node.id);
      if (usage.isWorkflowManager) {
        return "The workflow manager node is kept as root-manager so execution entry stays valid.";
      }
      if (usage.managerOf.length > 0) {
        return "This node is assigned as a sub-workflow manager, so its kind stays locked to sub-manager.";
      }
      if (usage.inputOf.length > 0) {
        return "This node is assigned as a sub-workflow input boundary, so its kind stays locked to input.";
      }
      if (usage.outputOf.length > 0) {
        return "This node is assigned as a sub-workflow output boundary, so its kind stays locked to output.";
      }
      return "Changing kind can affect validation, routing, and nested workflow visualization.";
    }

    function replaceSubWorkflowBoundaryNode(subWorkflow, key, nextValue) {
      const previousValue = subWorkflow[key];
      const normalizedNextValue = nextValue || undefined;
      subWorkflow[key] = normalizedNextValue;
      if (Array.isArray(subWorkflow.nodeIds) && previousValue && previousValue !== normalizedNextValue) {
        subWorkflow.nodeIds = subWorkflow.nodeIds
          .map((nodeId) => (nodeId === previousValue ? normalizedNextValue : nodeId))
          .filter((nodeId) => typeof nodeId === "string" && nodeId.length > 0);
      }
      normalizeSubWorkflowNodeIds(subWorkflow);
    }

    function normalizeSubWorkflowInputSourceFields(source) {
      if (!source || typeof source !== "object") {
        return;
      }
      if (source.type !== "workflow-output") {
        delete source.workflowId;
      }
      if (source.type !== "node-output") {
        delete source.nodeId;
      }
      if (source.type !== "sub-workflow-output") {
        delete source.subWorkflowId;
      }
    }

    function workflowReferenceOptions() {
      const currentWorkflowName = workflowEl.value;
      if (!currentWorkflowName) {
        return [];
      }
      return [{ value: currentWorkflowName, label: currentWorkflowName + " (current)" }];
    }

    function subWorkflowReferenceOptions(currentSubWorkflowId) {
      if (!state.bundle || !Array.isArray(state.bundle.workflow.subWorkflows)) {
        return [];
      }
      return state.bundle.workflow.subWorkflows
        .filter((subWorkflow) => subWorkflow.id !== currentSubWorkflowId)
        .map((subWorkflow) => ({ value: subWorkflow.id, label: subWorkflow.id }));
    }

    function syncNodeKindsFromStructure() {
      if (!state.bundle || !Array.isArray(state.bundle.workflow.nodes)) {
        return;
      }
      const nodeById = new Map(state.bundle.workflow.nodes.map((node) => [node.id, node]));
      const workflowManagerNode = nodeById.get(state.bundle.workflow.managerNodeId);
      if (
        workflowManagerNode &&
        workflowManagerNode.kind !== "root-manager" &&
        workflowManagerNode.kind !== "manager"
      ) {
        workflowManagerNode.kind = "root-manager";
      }
      state.bundle.workflow.subWorkflows.forEach((subWorkflow) => {
        const subWorkflowManagerNode =
          subWorkflow.managerNodeId === undefined ? undefined : nodeById.get(subWorkflow.managerNodeId);
        if (
          subWorkflowManagerNode &&
          subWorkflow.managerNodeId !== state.bundle.workflow.managerNodeId &&
          subWorkflowManagerNode.kind !== "sub-manager" &&
          subWorkflowManagerNode.kind !== "manager"
        ) {
          subWorkflowManagerNode.kind = "sub-manager";
        }
        const inputNode = nodeById.get(subWorkflow.inputNodeId);
        if (inputNode && inputNode.kind !== "input") {
          inputNode.kind = "input";
        }
        const outputNode = nodeById.get(subWorkflow.outputNodeId);
        if (outputNode && outputNode.kind !== "output") {
          outputNode.kind = "output";
        }
      });
    }

    function renameSubWorkflowReferences(oldId, nextId) {
      if (!state.bundle || !oldId || !nextId || oldId === nextId) {
        return;
      }
      state.bundle.workflow.subWorkflows.forEach((subWorkflow) => {
        if (!Array.isArray(subWorkflow.inputSources)) {
          return;
        }
        subWorkflow.inputSources.forEach((source) => {
          if (source.subWorkflowId === oldId) {
            source.subWorkflowId = nextId;
          }
        });
      });
      (state.bundle.workflow.subWorkflowConversations || []).forEach((conversation) => {
        if (!Array.isArray(conversation.participants)) {
          return;
        }
        conversation.participants = conversation.participants.map((participant) => (
          participant === oldId ? nextId : participant
        ));
      });
    }

    function removeSubWorkflowReferences(subWorkflowId) {
      if (!state.bundle || !subWorkflowId) {
        return;
      }
      state.bundle.workflow.subWorkflows.forEach((subWorkflow) => {
        if (!Array.isArray(subWorkflow.inputSources)) {
          return;
        }
        subWorkflow.inputSources.forEach((source) => {
          if (source.subWorkflowId === subWorkflowId) {
            source.type = "human-input";
            delete source.subWorkflowId;
            delete source.nodeId;
          }
        });
      });
      state.bundle.workflow.subWorkflowConversations = (state.bundle.workflow.subWorkflowConversations || [])
        .map((conversation) => ({
          ...conversation,
          participants: Array.isArray(conversation.participants)
            ? conversation.participants.filter((participant) => participant !== subWorkflowId)
            : [],
        }))
        .filter((conversation) => new Set(conversation.participants || []).size >= 2);
    }

    function createLabeledField(labelText, inputEl) {
      const wrap = document.createElement("div");
      const label = document.createElement("label");
      label.className = "mini-label";
      label.textContent = labelText;
      wrap.appendChild(label);
      wrap.appendChild(inputEl);
      return wrap;
    }

    function createTextInput(value, onInput, placeholder) {
      const input = document.createElement("input");
      input.type = "text";
      input.value = value || "";
      if (placeholder) {
        input.placeholder = placeholder;
      }
      input.addEventListener("input", () => onInput(input.value));
      return input;
    }

    function createNumberInput(value, onInput, min) {
      const input = document.createElement("input");
      input.type = "number";
      input.value = value === undefined || value === null ? "" : String(value);
      if (typeof min === "number") {
        input.min = String(min);
      }
      input.addEventListener("input", () => onInput(input.value));
      return input;
    }

    function createSelectInput(options, value, onInput) {
      const select = document.createElement("select");
      options.forEach((option) => {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        select.appendChild(el);
      });
      if (!options.some((option) => option.value === value) && value) {
        const custom = document.createElement("option");
        custom.value = value;
        custom.textContent = value;
        select.appendChild(custom);
      }
      select.value = value || (options[0] ? options[0].value : "");
      select.addEventListener("change", () => onInput(select.value));
      return select;
    }

    function createCheckboxList(options, selectedValues, lockedValues, disabledValues, onInput) {
      const selected = new Set(normalizeNodeIdList(selectedValues));
      const locked = new Set(normalizeNodeIdList(lockedValues));
      const disabled = new Set(normalizeNodeIdList(disabledValues));
      const wrap = document.createElement("div");
      wrap.className = "checkbox-list";
      options.forEach((option) => {
        const label = document.createElement("label");
        label.className =
          "checkbox-chip" +
          (locked.has(option.value) ? " locked" : "") +
          (disabled.has(option.value) ? " locked" : "");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = selected.has(option.value) || locked.has(option.value);
        input.disabled = locked.has(option.value) || disabled.has(option.value);
        input.addEventListener("change", () => {
          const nextSelected = options
            .filter((entry) => {
              if (locked.has(entry.value)) {
                return true;
              }
              if (disabled.has(entry.value)) {
                return selected.has(entry.value);
              }
              const checkbox = wrap.querySelector('input[data-node-id="' + entry.value + '"]');
              return checkbox && checkbox.checked;
            })
            .map((entry) => entry.value);
          onInput(nextSelected);
        });
        input.dataset.nodeId = option.value;
        label.appendChild(input);
        const text = document.createElement("span");
        text.textContent = option.label;
        label.appendChild(text);
        wrap.appendChild(label);
      });
      return wrap;
    }

    function ensureNodePayload(nodeId) {
      if (!state.bundle) return null;
      if (!state.bundle.nodePayloads[nodeId]) {
        state.bundle.nodePayloads[nodeId] = {
          id: nodeId,
          model: "tacogips/codex-agent",
          promptTemplate: "",
          variables: {},
        };
      }
      return state.bundle.nodePayloads[nodeId];
    }

    function renameNodeReferences(oldId, nextId) {
      if (!state.bundle || oldId === nextId || !nextId) {
        return;
      }
      state.bundle.workflow.nodes.forEach((node) => {
        if (node.id === oldId) {
          node.id = nextId;
          node.nodeFile = defaultNodeFile(nextId);
        }
      });
      if (state.bundle.workflow.managerNodeId === oldId) {
        state.bundle.workflow.managerNodeId = nextId;
      }
      state.bundle.workflow.edges.forEach((edge) => {
        if (edge.from === oldId) edge.from = nextId;
        if (edge.to === oldId) edge.to = nextId;
      });
      state.bundle.workflow.subWorkflows.forEach((subWorkflow) => {
        if (subWorkflow.managerNodeId === oldId) subWorkflow.managerNodeId = nextId;
        if (subWorkflow.inputNodeId === oldId) subWorkflow.inputNodeId = nextId;
        if (subWorkflow.outputNodeId === oldId) subWorkflow.outputNodeId = nextId;
        if (Array.isArray(subWorkflow.nodeIds)) {
          subWorkflow.nodeIds = subWorkflow.nodeIds.map((nodeId) => (nodeId === oldId ? nextId : nodeId));
        }
        if (Array.isArray(subWorkflow.inputSources)) {
          subWorkflow.inputSources.forEach((source) => {
            if (source.nodeId === oldId) {
              source.nodeId = nextId;
            }
          });
        }
      });
      (state.bundle.workflow.loops || []).forEach((loop) => {
        if (loop.judgeNodeId === oldId) loop.judgeNodeId = nextId;
      });
      state.bundle.workflowVis.nodes.forEach((node) => {
        if (node.id === oldId) {
          node.id = nextId;
        }
      });
      const payload = state.bundle.nodePayloads[oldId];
      if (payload) {
        state.bundle.nodePayloads[nextId] = {
          ...payload,
          id: nextId,
        };
        delete state.bundle.nodePayloads[oldId];
      } else {
        ensureNodePayload(nextId);
      }
      if (state.selectedNodeId === oldId) {
        state.selectedNodeId = nextId;
      }
    }

    function removeNode(nodeId) {
      if (!state.bundle) return;
      if (state.bundle.workflow.managerNodeId === nodeId) {
        setEditorStatus("The manager node cannot be removed from the workflow editor.", "fail");
        return;
      }
      const removedSubWorkflowIds = state.bundle.workflow.subWorkflows
        .filter((subWorkflow) => subWorkflow.inputNodeId === nodeId || subWorkflow.outputNodeId === nodeId)
        .map((subWorkflow) => subWorkflow.id);
      state.bundle.workflow.nodes = state.bundle.workflow.nodes.filter((node) => node.id !== nodeId);
      state.bundle.workflow.edges = state.bundle.workflow.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
      state.bundle.workflow.subWorkflows = state.bundle.workflow.subWorkflows.filter(
        (subWorkflow) => subWorkflow.inputNodeId !== nodeId && subWorkflow.outputNodeId !== nodeId,
      );
      removedSubWorkflowIds.forEach((subWorkflowId) => {
        removeSubWorkflowReferences(subWorkflowId);
      });
      state.bundle.workflow.subWorkflows.forEach((subWorkflow) => {
        if (subWorkflow.managerNodeId === nodeId) {
          delete subWorkflow.managerNodeId;
        }
        if (Array.isArray(subWorkflow.nodeIds)) {
          subWorkflow.nodeIds = subWorkflow.nodeIds.filter((entry) => entry !== nodeId);
        }
      });
      state.bundle.workflow.loops = (state.bundle.workflow.loops || []).filter((loop) => loop.judgeNodeId !== nodeId);
      state.bundle.workflowVis.nodes = state.bundle.workflowVis.nodes.filter((entry) => entry.id !== nodeId);
      delete state.bundle.nodePayloads[nodeId];
      if (state.selectedNodeId === nodeId) {
        state.selectedNodeId = state.bundle.workflow.nodes[0] ? state.bundle.workflow.nodes[0].id : null;
      }
      reconcileWorkflowVisWithNodes();
      renderStructureEditors();
      renderWorkflowBoard();
      renderNodeEditor();
      setEditorStatus("Node removed locally", "warn");
    }

    function makeClientIssue(path, message) {
      return { severity: "error", path, message };
    }

    function focusIssue(path) {
      if (typeof path !== "string") {
        return;
      }
      if (path.startsWith("workflow.defaults.maxLoopIterations")) {
        workflowMaxLoopIterationsEl.focus();
        return;
      }
      if (path.startsWith("workflow.defaults.nodeTimeoutMs")) {
        workflowNodeTimeoutMsEl.focus();
        return;
      }
      if (path.startsWith("workflow.nodes")) {
        workflowNodesListEl.focus();
        return;
      }
      if (path.startsWith("workflow.edges")) {
        workflowEdgesListEl.focus();
        return;
      }
      if (path.startsWith("workflow.subWorkflows")) {
        workflowSubWorkflowsListEl.focus();
        return;
      }
      if (path.startsWith("workflow.loops")) {
        workflowLoopsListEl.focus();
        return;
      }
      if (path.startsWith("workflowVis")) {
        workflowBoardEl.focus();
        return;
      }
      if (path.startsWith("nodePayloads")) {
        if (path.includes(".executionBackend")) {
          nodeExecutionBackendEl.focus();
          return;
        }
        if (path.includes(".model")) {
          nodeModelEl.focus();
          return;
        }
        if (path.includes(".variables")) {
          nodeVariablesEl.focus();
          return;
        }
        nodePromptTemplateEl.focus();
      }
    }

    function renderIssues() {
      issueListEl.innerHTML = "";
      const issues = Array.isArray(state.issues) ? state.issues : [];
      if (issues.length === 0) {
        issueListEl.innerHTML = '<div class="empty">No validation issues.</div>';
        validationSummaryEl.textContent = "No validation issues.";
        return;
      }
      const errorCount = issues.filter((issue) => issue.severity === "error").length;
      const warningCount = issues.filter((issue) => issue.severity === "warning").length;
      validationSummaryEl.textContent =
        "Errors: " + errorCount + " Warnings: " + warningCount + ". Click an issue to jump to the relevant control.";
      issues.forEach((issue) => {
        const button = document.createElement("button");
        button.className = "issue " + (issue.severity || "warning");
        button.addEventListener("click", () => focusIssue(issue.path));

        const pathEl = document.createElement("div");
        pathEl.className = "issue-path";
        pathEl.textContent = "[" + (issue.severity || "warning") + "] " + (issue.path || "unknown");

        const messageEl = document.createElement("div");
        messageEl.className = "issue-message";
        messageEl.textContent = issue.message || "Unknown issue";

        button.appendChild(pathEl);
        button.appendChild(messageEl);
        issueListEl.appendChild(button);
      });
    }

    function setIssues(issues) {
      state.issues = Array.isArray(issues) ? issues : [];
      renderIssues();
    }

    function clearIssues() {
      setIssues([]);
    }

    function syncWorkflowDescription() {
      if (!state.bundle) return;
      state.bundle.workflow.description = workflowDescriptionEl.value;
    }

    function renderStructureEditors() {
      if (!state.bundle) {
        workflowMaxLoopIterationsEl.value = "";
        workflowNodeTimeoutMsEl.value = "";
        workflowNodesListEl.innerHTML = "";
        workflowEdgesListEl.innerHTML = "";
        workflowSubWorkflowsListEl.innerHTML = "";
        workflowLoopsListEl.innerHTML = "";
        return;
      }
      normalizeAllSubWorkflowNodeIds();
      syncNodeKindsFromStructure();
      workflowMaxLoopIterationsEl.value = String(state.bundle.workflow.defaults.maxLoopIterations || "");
      workflowNodeTimeoutMsEl.value = String(state.bundle.workflow.defaults.nodeTimeoutMs || "");
      renderNodeStructureEditor();
      renderEdgeStructureEditor();
      renderSubWorkflowStructureEditor();
      renderLoopStructureEditor();
    }

    function reconcileWorkflowVisWithNodes() {
      if (!state.bundle || !Array.isArray(state.bundle.workflow.nodes)) {
        return;
      }
      const orderedVisNodes = Array.isArray(state.bundle.workflowVis && state.bundle.workflowVis.nodes)
        ? [...state.bundle.workflowVis.nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        : [];
      const orderById = new Map();
      orderedVisNodes.forEach((entry) => {
        orderById.set(entry.id, entry.order);
      });
      const nodeIds = state.bundle.workflow.nodes.map((node) => node.id);
      const nodeIndexById = new Map();
      nodeIds.forEach((nodeId, index) => {
        nodeIndexById.set(nodeId, index);
      });
      const normalized = nodeIds
        .filter((nodeId, index, values) => values.indexOf(nodeId) === index)
        .sort((left, right) => {
          const leftOrder = orderById.has(left) ? orderById.get(left) : Number.MAX_SAFE_INTEGER;
          const rightOrder = orderById.has(right) ? orderById.get(right) : Number.MAX_SAFE_INTEGER;
          const leftIndex = nodeIndexById.get(left) ?? Number.MAX_SAFE_INTEGER;
          const rightIndex = nodeIndexById.get(right) ?? Number.MAX_SAFE_INTEGER;
          return leftOrder - rightOrder || leftIndex - rightIndex || left.localeCompare(right);
        })
        .map((id, order) => ({ id, order }));
      state.bundle.workflowVis.nodes = normalized;
      normalizeWorkflowVis();
    }

    function renderNodeEditor() {
      const nodeId = state.selectedNodeId;
      const workflowNode = nodeId ? getWorkflowNode(nodeId) : null;
      const payload = nodeId ? getNodePayload(nodeId) : null;
      if (!workflowNode || !payload) {
        selectedNodeLabelEl.textContent = "Select a node card to edit its payload.";
        nodeExecutionBackendEl.value = "";
        nodeModelEl.value = "tacogips/codex-agent";
        nodePromptTemplateEl.value = "";
        nodeVariablesEl.value = "{}";
        renderNodeBackendHint();
        return;
      }
      selectedNodeLabelEl.textContent = workflowNode.id + " (" + (workflowNode.kind || "task") + ")";
      nodeExecutionBackendEl.value = payload.executionBackend || "";
      nodeModelEl.value = payload.model || "tacogips/codex-agent";
      nodePromptTemplateEl.value = payload.promptTemplate || "";
      nodeVariablesEl.value = JSON.stringify(payload.variables || {}, null, 2);
      renderNodeBackendHint();
    }

    function renderNodeBackendHint() {
      if (!nodeBackendHintEl) return;
      const backend = nodeExecutionBackendEl.value;
      if (!backend) {
        nodeBackendHintEl.textContent =
          "Backend is derived from model. Use tacogips/codex-agent or tacogips/claude-code-agent here, or choose an explicit backend below.";
        return;
      }
      if (backend === "official/openai-sdk") {
        nodeBackendHintEl.textContent =
          "official/openai-sdk expects a provider model name such as gpt-5. Do not use tacogips/codex-agent or tacogips/claude-code-agent as the model.";
        return;
      }
      if (backend === "official/anthropic-sdk") {
        nodeBackendHintEl.textContent =
          "official/anthropic-sdk expects a provider model name such as claude-sonnet-4-5. Do not use tacogips/codex-agent or tacogips/claude-code-agent as the model.";
        return;
      }
      nodeBackendHintEl.textContent =
        backend + " sends requests through the tacogips CLI-wrapper service. Set model to whatever that backend expects.";
    }

    function isCliWrapperModel(modelValue) {
      return modelValue === "tacogips/codex-agent" || modelValue === "tacogips/claude-code-agent";
    }

    function syncNodeModelForBackendChange() {
      const backend = nodeExecutionBackendEl.value;
      const modelValue = nodeModelEl.value.trim();
      if (!backend) {
        nodeModelEl.placeholder = "tacogips/codex-agent or tacogips/claude-code-agent";
        if (!modelValue) {
          nodeModelEl.value = "tacogips/codex-agent";
        }
        return;
      }
      if (backend === "official/openai-sdk") {
        nodeModelEl.placeholder = "gpt-5";
        if (!modelValue || isCliWrapperModel(modelValue)) {
          nodeModelEl.value = "gpt-5";
        }
        return;
      }
      if (backend === "official/anthropic-sdk") {
        nodeModelEl.placeholder = "claude-sonnet-4-5";
        if (!modelValue || isCliWrapperModel(modelValue)) {
          nodeModelEl.value = "claude-sonnet-4-5";
        }
        return;
      }
      nodeModelEl.placeholder = backend;
      if (!modelValue) {
        nodeModelEl.value = backend;
      }
    }

    function updateSelectedPayload() {
      if (!state.bundle || !state.selectedNodeId) return;
      const payload = ensureNodePayload(state.selectedNodeId);
      if (!payload) return;
      if (nodeExecutionBackendEl.value) {
        payload.executionBackend = nodeExecutionBackendEl.value;
      } else {
        delete payload.executionBackend;
      }
      payload.model = nodeModelEl.value.trim();
      payload.promptTemplate = nodePromptTemplateEl.value;
      renderNodeBackendHint();
      try {
        payload.variables = JSON.parse(nodeVariablesEl.value || "{}");
        setEditorStatus("Node changes staged locally", "warn");
      } catch {
        setEditorStatus("Variables JSON is invalid", "fail");
      }
    }

    function renderNodeStructureEditor() {
      workflowNodesListEl.innerHTML = "";
      const nodes = Array.isArray(state.bundle && state.bundle.workflow.nodes) ? state.bundle.workflow.nodes : [];
      if (nodes.length === 0) {
        workflowNodesListEl.innerHTML = '<div class="collection-empty">No nodes defined.</div>';
        return;
      }
      nodes.forEach((node) => {
        ensureNodePayload(node.id);
        const item = document.createElement("div");
        item.className = "collection-item";

        const grid = document.createElement("div");
        grid.className = "row three";
        const idInput = createTextInput(node.id, (nextValue) => {
          const trimmed = nextValue.trim();
          if (!trimmed || trimmed === node.id) {
            return;
          }
          renameNodeReferences(node.id, trimmed);
          reconcileWorkflowVisWithNodes();
          renderStructureEditors();
          renderWorkflowBoard();
          renderNodeEditor();
          setEditorStatus("Node id changed locally", "warn");
        }, "node-id");
        const kindOptions = nodeKindOptionsForNode(node);
        const kindSelect = createSelectInput(kindOptions, node.kind || "task", (nextValue) => {
          node.kind = nextValue;
          setEditorStatus("Node kind changed locally", "warn");
          renderStructureEditors();
          renderWorkflowBoard();
          renderNodeEditor();
        });
        const completionSelect = createSelectInput([
          { value: "none", label: "none" },
          { value: "checklist", label: "checklist" },
          { value: "score-threshold", label: "score-threshold" },
          { value: "validator-result", label: "validator-result" },
        ], (node.completion && node.completion.type) || "none", (nextValue) => {
          node.completion = {
            ...(node.completion || {}),
            type: nextValue,
          };
          setEditorStatus("Completion rule changed locally", "warn");
        });
        grid.appendChild(createLabeledField("Node ID", idInput));
        grid.appendChild(createLabeledField("Kind", kindSelect));
        grid.appendChild(createLabeledField("Completion", completionSelect));
        item.appendChild(grid);
        const kindHint = document.createElement("div");
        kindHint.className = "editor-note";
        kindHint.textContent = nodeKindHintForNode(node);
        item.appendChild(kindHint);

        const meta = document.createElement("div");
        meta.className = "collection-actions";
        const nodeFile = document.createElement("span");
        nodeFile.className = "pill";
        nodeFile.textContent = defaultNodeFile(node.id);
        const selectButton = document.createElement("button");
        selectButton.type = "button";
        selectButton.className = "ghost";
        selectButton.textContent = state.selectedNodeId === node.id ? "Selected" : "Edit Payload";
        selectButton.addEventListener("click", () => {
          state.selectedNodeId = node.id;
          renderWorkflowBoard();
          renderNodeEditor();
          renderStructureEditors();
        });
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "ghost";
        removeButton.textContent = "Remove";
        removeButton.disabled = state.bundle.workflow.managerNodeId === node.id;
        removeButton.addEventListener("click", () => removeNode(node.id));
        meta.appendChild(nodeFile);
        meta.appendChild(selectButton);
        meta.appendChild(removeButton);
        item.appendChild(meta);

        workflowNodesListEl.appendChild(item);
      });
    }

    function renderEdgeStructureEditor() {
      workflowEdgesListEl.innerHTML = "";
      const edges = Array.isArray(state.bundle && state.bundle.workflow.edges) ? state.bundle.workflow.edges : [];
      if (edges.length === 0) {
        workflowEdgesListEl.innerHTML = '<div class="collection-empty">No edges defined.</div>';
        return;
      }
      edges.forEach((edge, index) => {
        const item = document.createElement("div");
        item.className = "collection-item";
        const grid = document.createElement("div");
        grid.className = "row three";
        grid.appendChild(createLabeledField("From", createSelectInput(workflowNodeOptions(), edge.from, (nextValue) => {
          edge.from = nextValue;
          setEditorStatus("Edge routing changed locally", "warn");
        })));
        grid.appendChild(createLabeledField("To", createSelectInput(workflowNodeOptions(), edge.to, (nextValue) => {
          edge.to = nextValue;
          setEditorStatus("Edge routing changed locally", "warn");
        })));
        grid.appendChild(createLabeledField("When", createTextInput(edge.when, (nextValue) => {
          edge.when = nextValue;
          setEditorStatus("Edge routing changed locally", "warn");
        }, "always")));
        item.appendChild(grid);

        const actions = document.createElement("div");
        actions.className = "collection-actions";
        actions.appendChild(createLabeledField("Priority", createNumberInput(edge.priority, (nextValue) => {
          edge.priority = nextValue === "" ? undefined : Number(nextValue);
          setEditorStatus("Edge routing changed locally", "warn");
        }, 0)));
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "ghost";
        removeButton.textContent = "Remove";
        removeButton.addEventListener("click", () => {
          state.bundle.workflow.edges.splice(index, 1);
          renderStructureEditors();
          setEditorStatus("Edge removed locally", "warn");
        });
        actions.appendChild(removeButton);
        item.appendChild(actions);
        workflowEdgesListEl.appendChild(item);
      });
    }

    function renderSubWorkflowStructureEditor() {
      workflowSubWorkflowsListEl.innerHTML = "";
      const subWorkflows = Array.isArray(state.bundle && state.bundle.workflow.subWorkflows)
        ? state.bundle.workflow.subWorkflows
        : [];
      if (subWorkflows.length === 0) {
        workflowSubWorkflowsListEl.innerHTML = '<div class="collection-empty">No groups defined.</div>';
        return;
      }
      subWorkflows.forEach((subWorkflow, index) => {
        const item = document.createElement("div");
        item.className = "collection-item";

        const grid = document.createElement("div");
        grid.className = "row";
        grid.appendChild(createLabeledField("Group ID", createTextInput(subWorkflow.id, (nextValue) => {
          const trimmed = nextValue.trim();
          if (!trimmed || trimmed === subWorkflow.id) {
            return;
          }
          const previousId = subWorkflow.id;
          subWorkflow.id = trimmed;
          renameSubWorkflowReferences(previousId, subWorkflow.id);
          setEditorStatus("Group definition changed locally", "warn");
          renderStructureEditors();
          renderWorkflowBoard();
        }, "main-group")));
        grid.appendChild(createLabeledField("Description", createTextInput(subWorkflow.description, (nextValue) => {
          subWorkflow.description = nextValue;
          setEditorStatus("Group definition changed locally", "warn");
        }, "Main group")));
        item.appendChild(grid);

        const row = document.createElement("div");
        row.className = "row";
        row.appendChild(createLabeledField("Manager Node", createSelectInput(
          [{ value: "", label: "(use workflow manager)" }, ...subWorkflowManagerNodeOptions(subWorkflow.id)],
          subWorkflow.managerNodeId || "",
          (nextValue) => {
            replaceSubWorkflowBoundaryNode(subWorkflow, "managerNodeId", nextValue || undefined);
            setEditorStatus("Group boundaries changed locally", "warn");
            renderStructureEditors();
            renderWorkflowBoard();
          },
        )));
        row.appendChild(createLabeledField("Input Node", createSelectInput(subWorkflowBoundaryNodeOptions("input", subWorkflow), subWorkflow.inputNodeId, (nextValue) => {
          replaceSubWorkflowBoundaryNode(subWorkflow, "inputNodeId", nextValue);
          setEditorStatus("Group boundaries changed locally", "warn");
          renderStructureEditors();
          renderWorkflowBoard();
        })));
        row.appendChild(createLabeledField("Output Node", createSelectInput(subWorkflowBoundaryNodeOptions("output", subWorkflow), subWorkflow.outputNodeId, (nextValue) => {
          replaceSubWorkflowBoundaryNode(subWorkflow, "outputNodeId", nextValue);
          setEditorStatus("Group boundaries changed locally", "warn");
          renderStructureEditors();
          renderWorkflowBoard();
        })));
        item.appendChild(row);

        const memberOptions = workflowNodeOptionsByKinds(
          (state.bundle && Array.isArray(state.bundle.workflow.nodes))
            ? state.bundle.workflow.nodes.map((node) => node.kind || "task")
            : [],
        );
        item.appendChild(createLabeledField("Member Nodes", createCheckboxList(
          memberOptions,
          subWorkflow.nodeIds,
          collectRequiredSubWorkflowNodeIds(subWorkflow),
          memberOptions
            .map((option) => option.value)
            .filter((nodeId) => {
              const ownerId = subWorkflowNodeOwnerId(nodeId);
              return ownerId !== undefined && ownerId !== subWorkflow.id;
            }),
          (nextValues) => {
            subWorkflow.nodeIds = normalizeNodeIdList(nextValues);
            normalizeSubWorkflowNodeIds(subWorkflow);
            setEditorStatus("Group membership changed locally", "warn");
            renderStructureEditors();
            renderWorkflowBoard();
          },
        )));
        const memberHint = document.createElement("div");
        memberHint.className = "editor-note";
        memberHint.textContent = "Boundary nodes are kept selected automatically. Nodes already owned by another group stay unavailable here so membership and routing do not become ambiguous.";
        item.appendChild(memberHint);

        const source = Array.isArray(subWorkflow.inputSources) && subWorkflow.inputSources[0]
          ? subWorkflow.inputSources[0]
          : { type: "human-input" };
        if (!Array.isArray(subWorkflow.inputSources) || subWorkflow.inputSources.length === 0) {
          subWorkflow.inputSources = [source];
        }
        normalizeSubWorkflowInputSourceFields(source);
        const sourceRow = document.createElement("div");
        sourceRow.className = "row three";
        sourceRow.appendChild(createLabeledField("Input Source", createSelectInput([
          { value: "human-input", label: "human-input" },
          { value: "workflow-output", label: "workflow-output" },
          { value: "node-output", label: "node-output" },
          { value: "sub-workflow-output", label: "sub-workflow-output" },
        ], source.type, (nextValue) => {
          source.type = nextValue;
          normalizeSubWorkflowInputSourceFields(source);
          setEditorStatus("Group inputs changed locally", "warn");
          renderStructureEditors();
        })));
        sourceRow.appendChild(createLabeledField(
          source.type === "workflow-output" ? "Workflow Ref" : "Node Ref",
          source.type === "workflow-output"
            ? createSelectInput(
                [{ value: "", label: "(select workflow)" }, ...workflowReferenceOptions()],
                source.workflowId || "",
                (nextValue) => {
                  source.workflowId = nextValue || undefined;
                  setEditorStatus("Group inputs changed locally", "warn");
                },
              )
            : createSelectInput(
                [{ value: "", label: source.type === "human-input" ? "(not used)" : "(select node)" }, ...workflowNodeOptions()],
                source.nodeId || "",
                (nextValue) => {
                  source.nodeId = nextValue || undefined;
                  setEditorStatus("Group inputs changed locally", "warn");
                },
              ),
        ));
        sourceRow.appendChild(createLabeledField(
          "Sub-workflow Ref",
          createSelectInput(
            [{ value: "", label: source.type === "sub-workflow-output" ? "(select sub-workflow)" : "(not used)" }, ...subWorkflowReferenceOptions(subWorkflow.id)],
            source.subWorkflowId || "",
            (nextValue) => {
              source.subWorkflowId = nextValue || undefined;
              setEditorStatus("Group inputs changed locally", "warn");
            },
          ),
        ));
        item.appendChild(sourceRow);
        const sourceHint = document.createElement("div");
        sourceHint.className = "editor-note";
        sourceHint.textContent =
          source.type === "human-input"
            ? "Human-input sources do not need workflow, node, or sub-workflow references."
            : source.type === "workflow-output"
              ? "Workflow-output sources require a workflow reference."
              : source.type === "node-output"
                ? "Node-output sources require a node reference."
                : "Sub-workflow-output sources require a sub-workflow reference.";
        item.appendChild(sourceHint);
        const boundaryHint = document.createElement("div");
        boundaryHint.className = "editor-note";
        boundaryHint.textContent =
          "Manager, input, and output boundaries must be separate nodes. The editor hides conflicting choices so mailbox routing stays unambiguous.";
        item.appendChild(boundaryHint);

        const actions = document.createElement("div");
        actions.className = "collection-actions";
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "ghost";
        removeButton.textContent = "Remove";
        removeButton.addEventListener("click", () => {
          removeSubWorkflowReferences(subWorkflow.id);
          state.bundle.workflow.subWorkflows.splice(index, 1);
          renderStructureEditors();
          renderWorkflowBoard();
          setEditorStatus("Group removed locally", "warn");
        });
        actions.appendChild(removeButton);
        item.appendChild(actions);
        workflowSubWorkflowsListEl.appendChild(item);
      });
    }

    function renderLoopStructureEditor() {
      workflowLoopsListEl.innerHTML = "";
      const loops = Array.isArray(state.bundle && state.bundle.workflow.loops) ? state.bundle.workflow.loops : [];
      if (loops.length === 0) {
        workflowLoopsListEl.innerHTML = '<div class="collection-empty">No loops defined.</div>';
        return;
      }
      loops.forEach((loop, index) => {
        const item = document.createElement("div");
        item.className = "collection-item";
        const grid = document.createElement("div");
        grid.className = "row";
        grid.appendChild(createLabeledField("Loop ID", createTextInput(loop.id, (nextValue) => {
          loop.id = nextValue.trim();
          setEditorStatus("Loop changed locally", "warn");
          renderWorkflowBoard();
        }, "main-loop")));
        grid.appendChild(createLabeledField("Judge Node", createSelectInput(
          workflowNodeOptionsByKind("loop-judge"),
          loop.judgeNodeId,
          (nextValue) => {
            loop.judgeNodeId = nextValue;
            setEditorStatus("Loop changed locally", "warn");
            renderWorkflowBoard();
          },
        )));
        item.appendChild(grid);

        const detailRow = document.createElement("div");
        detailRow.className = "row three";
        detailRow.appendChild(createLabeledField("Continue When", createTextInput(loop.continueWhen, (nextValue) => {
          loop.continueWhen = nextValue;
          setEditorStatus("Loop changed locally", "warn");
          renderWorkflowBoard();
        }, "retry")));
        detailRow.appendChild(createLabeledField("Exit When", createTextInput(loop.exitWhen, (nextValue) => {
          loop.exitWhen = nextValue;
          setEditorStatus("Loop changed locally", "warn");
          renderWorkflowBoard();
        }, "done")));
        detailRow.appendChild(createLabeledField("Max Iterations", createNumberInput(loop.maxIterations, (nextValue) => {
          loop.maxIterations = nextValue === "" ? undefined : Number(nextValue);
          setEditorStatus("Loop changed locally", "warn");
        }, 1)));
        item.appendChild(detailRow);

        const actions = document.createElement("div");
        actions.className = "collection-actions";
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "ghost";
        removeButton.textContent = "Remove";
        removeButton.addEventListener("click", () => {
          state.bundle.workflow.loops.splice(index, 1);
          renderStructureEditors();
          renderWorkflowBoard();
          setEditorStatus("Loop removed locally", "warn");
        });
        actions.appendChild(removeButton);
        item.appendChild(actions);
        workflowLoopsListEl.appendChild(item);
      });
    }

    function addNode() {
      if (!state.bundle) return;
      let counter = state.bundle.workflow.nodes.length + 1;
      let nodeId = "worker-" + counter;
      while (state.bundle.workflow.nodes.some((node) => node.id === nodeId)) {
        counter += 1;
        nodeId = "worker-" + counter;
      }
      state.bundle.workflow.nodes.push({
        id: nodeId,
        kind: "task",
        nodeFile: defaultNodeFile(nodeId),
        completion: { type: "none" },
      });
      ensureNodePayload(nodeId);
      state.bundle.workflowVis.nodes.push({ id: nodeId, order: state.bundle.workflowVis.nodes.length });
      state.selectedNodeId = nodeId;
      reconcileWorkflowVisWithNodes();
      renderStructureEditors();
      renderWorkflowBoard();
      renderNodeEditor();
      setEditorStatus("Node added locally", "warn");
    }

    function addEdge() {
      if (!state.bundle || state.bundle.workflow.nodes.length < 2) return;
      const ordered = [...state.bundle.workflowVis.nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const fromId = ordered[0] ? ordered[0].id : state.bundle.workflow.nodes[0].id;
      const toId = ordered[1] ? ordered[1].id : state.bundle.workflow.nodes[1].id;
      state.bundle.workflow.edges.push({ from: fromId, to: toId, when: "always" });
      renderStructureEditors();
      setEditorStatus("Edge added locally", "warn");
    }

    function nextSubWorkflowId() {
      if (!state.bundle) {
        return "group-1";
      }
      let counter = state.bundle.workflow.subWorkflows.length + 1;
      let subWorkflowId = "group-" + counter;
      while (state.bundle.workflow.subWorkflows.some((subWorkflow) => subWorkflow.id === subWorkflowId)) {
        counter += 1;
        subWorkflowId = "group-" + counter;
      }
      return subWorkflowId;
    }

    function addSubWorkflow() {
      if (!state.bundle) return;
      const inputNode = firstWorkflowNodeOptionByKind("input");
      const outputNode = firstWorkflowNodeOptionByKind("output");
      const managerNode = firstUnusedSubWorkflowManagerNodeOption();
      state.bundle.workflow.subWorkflows.push({
        id: nextSubWorkflowId(),
        description: "New group",
        managerNodeId: managerNode ? managerNode.id : undefined,
        inputNodeId: inputNode ? inputNode.id : "",
        outputNodeId: outputNode ? outputNode.id : "",
        nodeIds: normalizeNodeIdList([
          managerNode ? managerNode.id : undefined,
          inputNode ? inputNode.id : "",
          outputNode ? outputNode.id : "",
        ]),
        inputSources: [{ type: "human-input" }],
      });
      renderStructureEditors();
      renderWorkflowBoard();
      if (!inputNode || !outputNode) {
        setEditorStatus("Group added locally; assign input/output nodes to clear validation errors", "warn");
        return;
      }
      if (!managerNode) {
        setEditorStatus("Group added locally using the workflow manager; assign a dedicated manager node if needed", "warn");
        return;
      }
      setEditorStatus("Group added locally", "warn");
    }

    function addLoop() {
      if (!state.bundle) return;
      const judgeNode = state.bundle.workflow.nodes.find((node) => node.kind === "loop-judge");
      state.bundle.workflow.loops = Array.isArray(state.bundle.workflow.loops) ? state.bundle.workflow.loops : [];
      state.bundle.workflow.loops.push({
        id: "loop-" + (state.bundle.workflow.loops.length + 1),
        judgeNodeId: judgeNode ? judgeNode.id : "",
        continueWhen: "retry",
        exitWhen: "done",
      });
      renderStructureEditors();
      renderWorkflowBoard();
      setEditorStatus("Loop added locally", "warn");
    }

    function applyStructureEditors() {
      if (!state.bundle) {
        return false;
      }

      const issues = [];
      syncWorkflowDescription();
      updateSelectedPayload();
      if (editorStatusEl.className.includes("fail")) {
        return false;
      }

      const maxLoopIterations = Number(workflowMaxLoopIterationsEl.value);
      if (!Number.isInteger(maxLoopIterations) || maxLoopIterations <= 0) {
        issues.push(makeClientIssue("workflow.defaults.maxLoopIterations", "must be a positive integer"));
      }

      const nodeTimeoutMs = Number(workflowNodeTimeoutMsEl.value);
      if (!Number.isInteger(nodeTimeoutMs) || nodeTimeoutMs <= 0) {
        issues.push(makeClientIssue("workflow.defaults.nodeTimeoutMs", "must be a positive integer"));
      }

      if (issues.length > 0) {
        setIssues(issues);
        setEditorStatus("Local editor input is invalid", "fail");
        return false;
      }

      state.bundle.workflow.defaults.maxLoopIterations = maxLoopIterations;
      state.bundle.workflow.defaults.nodeTimeoutMs = nodeTimeoutMs;
      reconcileWorkflowVisWithNodes();
      renderWorkflowBoard();
      renderNodeEditor();
      renderStructureEditors();
      return true;
    }

    function renderWorkflowBoard() {
      workflowBoardEl.innerHTML = "";
      if (!state.bundle) {
        workflowBoardEl.innerHTML = '<div class="empty">Choose a workflow to load its vertical sequence.</div>';
        return;
      }
      refreshDerivedVisualization();
      const entries = [...state.derivedVisualization].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      if (entries.length === 0) {
        workflowBoardEl.innerHTML = '<div class="empty">This workflow has no ordered nodes.</div>';
        return;
      }
      entries.forEach((entry, index) => {
        const workflowNode = getWorkflowNode(entry.id);
        const payload = getNodePayload(entry.id);
        const scopeKind = scopeType(entry.color);
        const row = document.createElement("div");
        row.className = "workflow-row";
        row.style.setProperty("--indent", String(entry.indent));
        row.style.setProperty("--scope-color", scopeColor(scopeKind));

        const item = document.createElement("div");
        item.className = "workflow-item";

        const reorder = document.createElement("div");
        reorder.className = "reorder";
        const upButton = document.createElement("button");
        upButton.className = "ghost";
        upButton.textContent = "Up";
        upButton.disabled = index === 0;
        upButton.addEventListener("click", () => moveNode(entry.id, -1));
        const downButton = document.createElement("button");
        downButton.className = "ghost";
        downButton.textContent = "Down";
        downButton.disabled = index === entries.length - 1;
        downButton.addEventListener("click", () => moveNode(entry.id, 1));
        reorder.appendChild(upButton);
        reorder.appendChild(downButton);

        const card = document.createElement("div");
        card.className = "node-card" + (state.selectedNodeId === entry.id ? " selected" : "");
        card.addEventListener("click", () => {
          state.selectedNodeId = entry.id;
          renderWorkflowBoard();
          renderNodeEditor();
        });

        const head = document.createElement("div");
        head.className = "node-head";
        const titleWrap = document.createElement("div");
        const title = document.createElement("div");
        title.className = "node-title";
        title.textContent = (index + 1) + ". " + entry.id;
        titleWrap.appendChild(title);

        const meta = document.createElement("div");
        meta.className = "node-meta";
        const kindPill = document.createElement("span");
        kindPill.className = "pill";
        kindPill.textContent = workflowNode && workflowNode.kind ? workflowNode.kind : "task";
        const scopePill = document.createElement("span");
        scopePill.className = "pill scope-pill " + scopeKind;
        scopePill.textContent = scopeLabel(entry.color);
        const modelPill = document.createElement("span");
        modelPill.className = "pill";
        modelPill.textContent = payload && payload.model ? payload.model : "unconfigured";
        meta.appendChild(kindPill);
        meta.appendChild(scopePill);
        meta.appendChild(modelPill);

        const actions = document.createElement("button");
        actions.className = "ghost";
        actions.textContent = state.selectedNodeId === entry.id ? "Selected" : "Edit";

        head.appendChild(titleWrap);
        head.appendChild(actions);
        card.appendChild(head);
        card.appendChild(meta);

        const desc = document.createElement("div");
        desc.className = "node-desc";
        desc.textContent = payload && payload.promptTemplate ? payload.promptTemplate : "No prompt template configured.";
        card.appendChild(desc);

        item.appendChild(reorder);
        item.appendChild(card);
        row.appendChild(item);
        workflowBoardEl.appendChild(row);
      });
    }

    function moveNode(nodeId, delta) {
      if (!state.bundle || !Array.isArray(state.bundle.workflowVis.nodes)) return;
      const ordered = [...state.bundle.workflowVis.nodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const index = ordered.findIndex((entry) => entry.id === nodeId);
      const nextIndex = index + delta;
      if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return;
      const current = ordered[index];
      ordered[index] = ordered[nextIndex];
      ordered[nextIndex] = current;
      state.bundle.workflowVis.nodes = ordered.map((entry, order) => ({ id: entry.id, order }));
      normalizeWorkflowVis();
      setEditorStatus("Order updated locally. Save to persist and refresh derived scope layout.", "warn");
      renderWorkflowBoard();
    }

    async function loadWorkflowDetails() {
      const workflowName = workflowEl.value;
      if (!workflowName) return;
      setEditorStatus("Loading workflow...", "warn");
      const res = await fetch("/api/workflows/" + encodeURIComponent(workflowName));
      const data = await res.json();
      if (!res.ok) {
        state.bundle = null;
        state.derivedVisualization = [];
        renderWorkflowBoard();
        renderNodeEditor();
        setEditorStatus(data.error || "failed to load workflow", "fail");
        return;
      }
      state.revision = data.revision || null;
      state.bundle = data.bundle;
      state.derivedVisualization = Array.isArray(data.derivedVisualization) ? data.derivedVisualization : [];
      state.selectedNodeId = state.derivedVisualization[0] ? state.derivedVisualization[0].id : null;
      workflowDescriptionEl.value = state.bundle.workflow.description || "";
      normalizeWorkflowVis();
      renderStructureEditors();
      renderWorkflowBoard();
      renderNodeEditor();
      clearIssues();
      setEditorStatus("Loaded revision " + (state.revision || "unknown"), "ok");
    }

    async function validateWorkflow() {
      if (!state.bundle) return;
      if (!applyStructureEditors()) {
        return;
      }
      setEditorStatus("Validating workflow...", "warn");
      const res = await fetch("/api/workflows/" + encodeURIComponent(workflowEl.value) + "/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle: state.bundle })
      });
      const data = await res.json();
      const issues = Array.isArray(data.issues) ? data.issues : [];
      setIssues(issues);
      const hasErrors = issues.some((issue) => issue.severity === "error");
      if (hasErrors || data.valid === false) {
        setEditorStatus("Validation failed", "fail");
        return;
      }
      if (issues.length > 0) {
        setEditorStatus("Validation passed with warnings", "warn");
        return;
      }
      setEditorStatus("Validation passed", "ok");
    }

    async function saveWorkflow() {
      if (!state.bundle) return;
      if (!applyStructureEditors()) {
        return;
      }
      setEditorStatus("Saving workflow...", "warn");
      const res = await fetch("/api/workflows/" + encodeURIComponent(workflowEl.value), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: state.revision,
          bundle: state.bundle
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setIssues(Array.isArray(data.issues) ? data.issues : []);
        setEditorStatus(data.error || "failed to save workflow", "fail");
        return;
      }
      state.revision = data.revision || null;
      await loadWorkflowDetails();
      clearIssues();
      setEditorStatus("Saved revision " + (state.revision || "unknown"), "ok");
    }

    async function loadWorkflows() {
      if (fixedWorkflow) {
        workflowEl.innerHTML = "<option>" + fixedWorkflow + "</option>";
        workflowEl.disabled = true;
      } else {
        const res = await fetch("/api/workflows");
        const data = await res.json();
        workflowEl.innerHTML = "";
        for (const name of data.workflows || []) {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          workflowEl.appendChild(opt);
        }
      }
      if (workflowEl.options.length > 0) {
        await loadWorkflowDetails();
      }
    }

    function renderSession(session) {
      const status = session.status || "unknown";
      sessionLineEl.className = "status " + statusClass(status);
      sessionLineEl.textContent = "sessionId=" + session.sessionId + " status=" + status + " currentNode=" + (session.currentNodeId || "-");
      const counts = session.nodeExecutionCounts || {};
      const nodes = Object.keys(counts).sort().map((id) => id + ":" + counts[id]).join(", ");
      nodeLineEl.textContent = "node progress: " + (nodes || "-");
      sessionJsonEl.textContent = JSON.stringify(session, null, 2);
    }

    async function pollSession(sessionId) {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
      }
      const tick = async () => {
        const res = await fetch("/api/sessions/" + encodeURIComponent(sessionId));
        if (!res.ok) return;
        const session = await res.json();
        renderSession(session);
        if (session.status === "completed" || session.status === "failed" || session.status === "cancelled") {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };
      await tick();
      pollTimer = setInterval(tick, 1000);
    }

    workflowEl.addEventListener("change", () => {
      loadWorkflowDetails().catch((error) => {
        setEditorStatus(String(error), "fail");
      });
    });
    reloadButtonEl.addEventListener("click", () => {
      loadWorkflowDetails().catch((error) => {
        setEditorStatus(String(error), "fail");
      });
    });
    validateButtonEl.addEventListener("click", () => {
      validateWorkflow().catch((error) => {
        setEditorStatus(String(error), "fail");
      });
    });
    saveButtonEl.addEventListener("click", () => {
      saveWorkflow().catch((error) => {
        setEditorStatus(String(error), "fail");
      });
    });
    workflowDescriptionEl.addEventListener("input", () => {
      syncWorkflowDescription();
      setEditorStatus("Workflow description changed locally", "warn");
    });
    workflowMaxLoopIterationsEl.addEventListener("input", () => setEditorStatus("Workflow defaults changed locally", "warn"));
    workflowNodeTimeoutMsEl.addEventListener("input", () => setEditorStatus("Workflow defaults changed locally", "warn"));
    addNodeButtonEl.addEventListener("click", addNode);
    addEdgeButtonEl.addEventListener("click", addEdge);
    addSubWorkflowButtonEl.addEventListener("click", addSubWorkflow);
    addLoopButtonEl.addEventListener("click", addLoop);
    nodeExecutionBackendEl.addEventListener("change", () => {
      syncNodeModelForBackendChange();
      updateSelectedPayload();
    });
    nodeModelEl.addEventListener("input", updateSelectedPayload);
    nodePromptTemplateEl.addEventListener("input", updateSelectedPayload);
    nodeVariablesEl.addEventListener("input", updateSelectedPayload);

    runButtonEl.addEventListener("click", async () => {
      const workflowName = workflowEl.value;
      if (!workflowName) return;
      const payload = {
        async: true,
        runtimeVariables: {
          userPrompt: promptEl.value,
          prompt: promptEl.value
        }
      };
      if (maxStepsEl.value) payload.maxSteps = Number(maxStepsEl.value);
      const rawScenario = scenarioEl.value.trim();
      if (rawScenario.length > 0) {
        payload.mockScenario = JSON.parse(rawScenario);
      }
      const res = await fetch("/api/workflows/" + encodeURIComponent(workflowName) + "/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        sessionLineEl.className = "status fail";
        sessionLineEl.textContent = data.error || "run failed";
        return;
      }
      await pollSession(data.sessionId);
    });

    loadWorkflows().catch((error) => {
      sessionLineEl.className = "status fail";
      sessionLineEl.textContent = String(error);
      setEditorStatus(String(error), "fail");
    });
  </script>
</body>
</html>`;
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return {};
  }
}

async function listWorkflowNames(options: LoadOptions): Promise<readonly string[]> {
  const roots = resolveEffectiveRoots(options);
  const entries = await readdir(roots.workflowRoot, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workflowPath = path.join(roots.workflowRoot, entry.name, "workflow.json");
    try {
      const details = await stat(workflowPath);
      if (details.isFile()) {
        names.push(entry.name);
      }
    } catch {
      // Skip incomplete directories.
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function routeParts(pathname: string): readonly string[] {
  return pathname.split("/").filter((entry) => entry.length > 0);
}

export async function handleApiRequest(request: Request, context: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  const parts = routeParts(url.pathname);

  if (url.pathname === "/" || url.pathname === "/ui") {
    return html(renderWebUi(context.fixedWorkflowName));
  }

  if (url.pathname === "/healthz") {
    return json({ service: "oyakata-serve", status: "ok" });
  }

  if (parts.length === 2 && parts[0] === "api" && parts[1] === "workflows" && request.method === "GET") {
    const names = await listWorkflowNames(context);
    return json({ workflows: names });
  }

  if (parts.length === 2 && parts[0] === "api" && parts[1] === "sessions" && request.method === "GET") {
    const listed = await listSessions(context);
    if (!listed.ok) {
      return json({ error: listed.error.message }, 500);
    }
    const sessions = await Promise.all(
      listed.value.map(async (sessionId) => {
        const loaded = await loadSession(sessionId, context);
        if (!loaded.ok) {
          return undefined;
        }
        return {
          sessionId: loaded.value.sessionId,
          workflowName: loaded.value.workflowName,
          status: loaded.value.status,
          currentNodeId: loaded.value.currentNodeId ?? null,
          nodeExecutionCounter: loaded.value.nodeExecutionCounter,
          startedAt: loaded.value.startedAt,
          endedAt: loaded.value.endedAt ?? null,
        };
      }),
    );
    return json({ sessions: sessions.filter((entry) => entry !== undefined) });
  }

  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "workflows") {
    const workflowName = parts[2];
    if (workflowName === undefined) {
      return json({ error: "workflow name is required" }, 400);
    }
    if (!isSafeWorkflowName(workflowName)) {
      return json({ error: "invalid workflow name" }, 400);
    }
    if (context.fixedWorkflowName !== undefined && context.fixedWorkflowName !== workflowName) {
      return json({ error: "workflow name not allowed in fixed workflow mode" }, 403);
    }

    if (parts.length === 3 && request.method === "GET") {
      const loaded = await loadWorkflowFromDisk(workflowName, context);
      if (!loaded.ok) {
        return json({ error: loaded.error.message, issues: loaded.error.issues ?? [] }, 404);
      }
      const nodeFiles = loaded.value.bundle.workflow.nodes.map((node) => node.nodeFile);
      const revision = await computeWorkflowRevisionFromFiles(loaded.value.workflowDirectory, nodeFiles);
      return json({
        workflowName: loaded.value.workflowName,
        workflowDirectory: loaded.value.workflowDirectory,
        artifactWorkflowRoot: loaded.value.artifactWorkflowRoot,
        revision: revision.ok ? revision.value : null,
        bundle: loaded.value.bundle,
        derivedVisualization: deriveWorkflowVisualization({
          workflow: loaded.value.bundle.workflow,
          workflowVis: loaded.value.bundle.workflowVis,
        }),
      });
    }

    if (parts.length === 3 && request.method === "PUT") {
      if (context.readOnly === true) {
        return json({ error: "read-only mode enabled" }, 403);
      }

      const body = await parseJsonBody(request);
      const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const bundle = bodyObj["bundle"];
      const expectedRevision =
        typeof bodyObj["expectedRevision"] === "string" ? bodyObj["expectedRevision"] : undefined;

      if (typeof bundle !== "object" || bundle === null) {
        return json({ error: "bundle is required" }, 400);
      }

      const bundleObj = bundle as Record<string, unknown>;
      const workflow = bundleObj["workflow"];
      const workflowVis = bundleObj["workflowVis"];
      const nodePayloadsRaw = bundleObj["nodePayloads"];
      if (typeof workflow !== "object" || workflow === null) {
        return json({ error: "bundle.workflow is required" }, 400);
      }
      if (typeof workflowVis !== "object" || workflowVis === null) {
        return json({ error: "bundle.workflowVis is required" }, 400);
      }
      if (typeof nodePayloadsRaw !== "object" || nodePayloadsRaw === null || Array.isArray(nodePayloadsRaw)) {
        return json({ error: "bundle.nodePayloads is required" }, 400);
      }

      const saveResult = await saveWorkflowToDisk(
        workflowName,
        {
          workflow,
          workflowVis,
          nodePayloads: nodePayloadsRaw as Readonly<Record<string, unknown>>,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        },
        context,
      );
      if (!saveResult.ok) {
        if (saveResult.error.code === "CONFLICT") {
          return json(
            {
              error: saveResult.error.message,
              currentRevision: saveResult.error.currentRevision ?? null,
            },
            409,
          );
        }
        const status = saveResult.error.code === "VALIDATION" || saveResult.error.code === "INVALID_WORKFLOW_NAME" ? 400 : 500;
        return json({ error: saveResult.error.message, issues: saveResult.error.issues ?? [] }, status);
      }

      return json({
        workflowName: saveResult.value.workflowName,
        workflowDirectory: saveResult.value.workflowDirectory,
        revision: saveResult.value.revision,
      });
    }

    if (parts.length === 4 && parts[3] === "validate" && request.method === "POST") {
      const body = await parseJsonBody(request);
      const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const bundle = bodyObj["bundle"];
      if (typeof bundle === "object" && bundle !== null) {
        const bundleObj = bundle as Record<string, unknown>;
        const validation = validateWorkflowBundleDetailed({
          workflow: bundleObj["workflow"],
          workflowVis: bundleObj["workflowVis"],
          nodePayloads: remapNodePayloadsForValidation(bundleObj),
        });
        if (!validation.ok) {
          return json({ valid: false, issues: validation.error }, 200);
        }
        return json({
          valid: true,
          workflowId: validation.value.bundle.workflow.workflowId,
          warnings: validation.value.issues.filter((issue) => issue.severity === "warning"),
          issues: validation.value.issues,
        });
      }

      const loaded = await loadWorkflowFromDisk(workflowName, context);
      if (!loaded.ok) {
        return json({ valid: false, error: loaded.error.message, issues: loaded.error.issues ?? [] }, 200);
      }
      return json({ valid: true, workflowId: loaded.value.bundle.workflow.workflowId, warnings: [] });
    }

    if (parts.length === 4 && parts[3] === "execute" && request.method === "POST") {
      if (context.noExec === true) {
        return json({ error: "execution is disabled (no-exec mode)" }, 403);
      }

      const body = await parseJsonBody(request);
      const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const runtimeVariables =
        typeof bodyObj["runtimeVariables"] === "object" && bodyObj["runtimeVariables"] !== null
          ? (bodyObj["runtimeVariables"] as Readonly<Record<string, unknown>>)
          : {};
      const mockScenario =
        typeof bodyObj["mockScenario"] === "object" &&
        bodyObj["mockScenario"] !== null &&
        !Array.isArray(bodyObj["mockScenario"])
          ? (bodyObj["mockScenario"] as MockNodeScenario)
          : undefined;
      const asyncMode = bodyObj["async"] === true;

      if (asyncMode) {
        const sessionId = createSessionId();
        void runWorkflow(workflowName, {
          ...context,
          sessionId,
          runtimeVariables,
          ...(mockScenario === undefined ? {} : { mockScenario }),
          ...(typeof bodyObj["maxSteps"] === "number" ? { maxSteps: bodyObj["maxSteps"] } : {}),
          ...(typeof bodyObj["maxLoopIterations"] === "number"
            ? { maxLoopIterations: bodyObj["maxLoopIterations"] }
            : {}),
          ...(typeof bodyObj["defaultTimeoutMs"] === "number"
            ? { defaultTimeoutMs: bodyObj["defaultTimeoutMs"] }
            : {}),
          ...(bodyObj["dryRun"] === true ? { dryRun: true } : {}),
        });
        return json({ accepted: true, sessionId, status: "running" }, 202);
      }

      const runResult = await runWorkflow(workflowName, {
        ...context,
        runtimeVariables,
        ...(mockScenario === undefined ? {} : { mockScenario }),
        ...(typeof bodyObj["maxSteps"] === "number" ? { maxSteps: bodyObj["maxSteps"] } : {}),
        ...(typeof bodyObj["maxLoopIterations"] === "number"
          ? { maxLoopIterations: bodyObj["maxLoopIterations"] }
          : {}),
        ...(typeof bodyObj["defaultTimeoutMs"] === "number"
          ? { defaultTimeoutMs: bodyObj["defaultTimeoutMs"] }
          : {}),
        ...(bodyObj["dryRun"] === true ? { dryRun: true } : {}),
      });

      if (!runResult.ok) {
        const status = runResult.error.exitCode === 2 ? 400 : 500;
        return json({ error: runResult.error.message, exitCode: runResult.error.exitCode }, status);
      }

      return json({
        sessionId: runResult.value.session.sessionId,
        status: runResult.value.session.status,
        exitCode: runResult.value.exitCode,
      });
    }
  }

  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "sessions") {
    const sessionId = parts[2];
    if (sessionId === undefined) {
      return json({ error: "session id is required" }, 400);
    }

    if (parts.length === 3 && request.method === "GET") {
      const loaded = await loadSession(sessionId, context);
      if (!loaded.ok) {
        return json({ error: loaded.error.message }, 404);
      }
      return json(loaded.value);
    }

    if (parts.length === 4 && parts[3] === "cancel" && request.method === "POST") {
      if (context.noExec === true) {
        return json({ error: "execution is disabled (no-exec mode)" }, 403);
      }

      const loaded = await loadSession(sessionId, context);
      if (!loaded.ok) {
        return json({ error: loaded.error.message }, 404);
      }

      if (loaded.value.status === "completed" || loaded.value.status === "failed" || loaded.value.status === "cancelled") {
        return json({ accepted: false, status: loaded.value.status });
      }

      const cancelled = {
        ...loaded.value,
        status: "cancelled" as const,
        endedAt: new Date().toISOString(),
        lastError: "cancelled by API request",
      };

      const saved = await saveSession(cancelled, context);
      if (!saved.ok) {
        return json({ error: saved.error.message }, 500);
      }

      return json({ accepted: true, status: "cancelled" });
    }

    if (parts.length === 4 && parts[3] === "rerun" && request.method === "POST") {
      if (context.noExec === true) {
        return json({ error: "execution is disabled (no-exec mode)" }, 403);
      }

      const loaded = await loadSession(sessionId, context);
      if (!loaded.ok) {
        return json({ error: loaded.error.message }, 404);
      }

      const body = await parseJsonBody(request);
      const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const fromNodeId = typeof bodyObj["fromNodeId"] === "string" ? bodyObj["fromNodeId"] : undefined;
      if (fromNodeId === undefined || fromNodeId.length === 0) {
        return json({ error: "fromNodeId is required" }, 400);
      }

      const runtimeVariables =
        typeof bodyObj["runtimeVariables"] === "object" && bodyObj["runtimeVariables"] !== null
          ? (bodyObj["runtimeVariables"] as Readonly<Record<string, unknown>>)
          : {};
      const mockScenario =
        typeof bodyObj["mockScenario"] === "object" &&
        bodyObj["mockScenario"] !== null &&
        !Array.isArray(bodyObj["mockScenario"])
          ? (bodyObj["mockScenario"] as MockNodeScenario)
          : undefined;

      const rerun = await runWorkflow(loaded.value.workflowName, {
        ...context,
        runtimeVariables,
        ...(mockScenario === undefined ? {} : { mockScenario }),
        rerunFromSessionId: loaded.value.sessionId,
        rerunFromNodeId: fromNodeId,
        ...(typeof bodyObj["maxSteps"] === "number" ? { maxSteps: bodyObj["maxSteps"] } : {}),
        ...(typeof bodyObj["maxLoopIterations"] === "number"
          ? { maxLoopIterations: bodyObj["maxLoopIterations"] }
          : {}),
        ...(typeof bodyObj["defaultTimeoutMs"] === "number"
          ? { defaultTimeoutMs: bodyObj["defaultTimeoutMs"] }
          : {}),
        ...(bodyObj["dryRun"] === true ? { dryRun: true } : {}),
      });
      if (!rerun.ok) {
        return json({ error: rerun.error.message, exitCode: rerun.error.exitCode }, 400);
      }

      return json({
        sourceSessionId: loaded.value.sessionId,
        sessionId: rerun.value.session.sessionId,
        status: rerun.value.session.status,
        rerunFromNodeId: fromNodeId,
        exitCode: rerun.value.exitCode,
      });
    }
  }

  if (request.method === "PUT" && context.readOnly === true) {
    return json({ error: "read-only mode enabled" }, 403);
  }

  return json({ error: "not found" }, 404);
}
