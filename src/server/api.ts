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

function renderWebUi(fixedWorkflowName?: string): string {
  const fixed = JSON.stringify(fixedWorkflowName ?? "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>oyakata UI</title>
  <style>
    :root { --bg: #f5f7fb; --panel: #ffffff; --line: #d7dfea; --text: #122034; --muted: #4e6077; --accent: #0f6d83; --ok: #0f7a45; --warn: #8a5f00; --fail: #992b2b; }
    body { margin: 0; background: linear-gradient(180deg, #eaf1f9, #f9fbfe); color: var(--text); font: 14px/1.45 "IBM Plex Sans", "Segoe UI", sans-serif; }
    .wrap { max-width: 980px; margin: 24px auto; padding: 0 16px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    h2 { margin: 0 0 8px; font-size: 16px; }
    label { display: block; margin: 10px 0 4px; color: var(--muted); }
    input, select, textarea, button { font: inherit; }
    input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--line); border-radius: 8px; padding: 8px; background: #fff; color: var(--text); }
    textarea { min-height: 100px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button { border: 0; background: var(--accent); color: white; border-radius: 8px; padding: 9px 14px; cursor: pointer; }
    pre { margin: 0; background: #0d1a2a; color: #d8e3f0; padding: 10px; border-radius: 8px; overflow: auto; max-height: 280px; }
    .status { font-weight: 600; }
    .ok { color: var(--ok); } .warn { color: var(--warn); } .fail { color: var(--fail); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>oyakata Workflow Runner</h1>
      <div class="row">
        <div>
          <label for="workflow">Workflow</label>
          <select id="workflow"></select>
        </div>
        <div>
          <label for="maxSteps">Max Steps (optional pause)</label>
          <input id="maxSteps" type="number" min="1" placeholder="empty = run until done" />
        </div>
      </div>
      <label for="prompt">Prompt Input</label>
      <textarea id="prompt" placeholder="Describe what should be built"></textarea>
      <label for="mockScenario">Mock Scenario JSON (optional)</label>
      <textarea id="mockScenario" placeholder='{"node-id": {"when":{"always":true},"payload":{"k":"v"}}}'></textarea>
      <div style="margin-top:12px;">
        <button id="runButton">Run (Async)</button>
      </div>
    </div>
    <div class="card">
      <h2>Session Progress</h2>
      <div id="sessionLine" class="status"></div>
      <div id="nodeLine" style="margin:8px 0 10px; color:var(--muted)"></div>
      <pre id="sessionJson">{}</pre>
    </div>
  </div>
  <script>
    const fixedWorkflow = ${fixed};
    const workflowEl = document.getElementById("workflow");
    const promptEl = document.getElementById("prompt");
    const scenarioEl = document.getElementById("mockScenario");
    const maxStepsEl = document.getElementById("maxSteps");
    const runButtonEl = document.getElementById("runButton");
    const sessionLineEl = document.getElementById("sessionLine");
    const nodeLineEl = document.getElementById("nodeLine");
    const sessionJsonEl = document.getElementById("sessionJson");
    let pollTimer = null;

    function statusClass(status) {
      if (status === "completed") return "ok";
      if (status === "paused" || status === "running") return "warn";
      return "fail";
    }

    async function loadWorkflows() {
      if (fixedWorkflow) {
        workflowEl.innerHTML = "<option>" + fixedWorkflow + "</option>";
        workflowEl.disabled = true;
        return;
      }
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
