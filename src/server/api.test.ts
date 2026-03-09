import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { handleApiRequest, resolveDefaultUiDistRoot } from "./api";
import { createWorkflowTemplate } from "../workflow/create";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oyakata-api-test-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function makeDefaultTemplateScenario(stage = "design"): Readonly<Record<string, unknown>> {
  return {
    "oyakata-manager": { provider: "scenario-mock", when: { always: true }, payload: { stage } },
    "main-oyakata": { provider: "scenario-mock", when: { always: true }, payload: { stage: "dispatch" } },
    "workflow-input": { provider: "scenario-mock", when: { always: true }, payload: { stage: "implement" } },
    "workflow-output": { provider: "scenario-mock", when: { always: true }, payload: { stage: "review" } },
  };
}

describe("handleApiRequest", () => {
  test("serves web UI and health endpoint", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const uiRes = await handleApiRequest(new Request("http://localhost/"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      uiDistRoot: path.join(root, "missing-ui-dist"),
    });
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get("content-type")).toContain("text/html");
    const uiText = await uiRes.text();
    expect(uiText).toContain("oyakata Vertical Workflow Editor");
    expect(uiText).toContain("Vertical Workflow");
    expect(uiText).toContain("Workflow Structure");
    expect(uiText).toContain("Create Workflow");
    expect(uiText).toContain("New Workflow");
    expect(uiText).toContain("Validate Workflow");
    expect(uiText).toContain("modeBanner");
    expect(uiText).toContain("Read-only mode disables create and save actions.");
    expect(uiText).toContain("Execution is disabled, so run and cancel actions are unavailable.");
    expect(uiText).toContain("derive from model (legacy)");
    expect(uiText).toContain("placeholder=\"gpt-5 / claude-sonnet-4-5 / claude-opus-4-1\"");
    expect(uiText).toContain('backendPill.textContent = payload && payload.executionBackend ? payload.executionBackend : "legacy backend";');
    expect(uiText).toContain("Add Node");
    expect(uiText).toContain("Refresh Sessions");
    expect(uiText).toContain("Cancel Selected Session");
    expect(uiText).toContain("root-manager");
    expect(uiText).toContain("Member Nodes");
    expect(uiText).toContain("Block Type");
    expect(uiText).toContain("loop-body");
    expect(uiText).toContain("branch-block");
    expect(uiText).toContain("Nodes already owned by another group stay unavailable here");
    expect(uiText).toContain("function availableSubWorkflowManagerNodes(currentSubWorkflowId)");
    expect(uiText).toContain("subWorkflowManagerNodeOptions(subWorkflow.id)");
    expect(uiText).toContain("function subWorkflowBoundaryNodeOptions(kind, subWorkflow)");
    expect(uiText).toContain("function subWorkflowNodeOwnerId(nodeId)");
    expect(uiText).toContain("function nodeReservedByOtherSubWorkflow(nodeId, currentSubWorkflowId)");
    expect(uiText).toContain("function normalizeAllSubWorkflowNodeIds()");
    expect(uiText).toContain("function normalizeSubWorkflowInputSourceFields(source)");
    expect(uiText).toContain("function workflowReferenceOptions()");
    expect(uiText).toContain("function subWorkflowReferenceOptions(currentSubWorkflowId)");
    expect(uiText).toContain("function colorForSubWorkflow(subWorkflow)");
    expect(uiText).toContain('if (color.startsWith("branch:")) return "branch";');
    expect(uiText).toContain('if (kind === "branch") return "var(--branch-scope)";');
    expect(uiText).toContain('subWorkflow.block = { type: nextValue };');
    expect(uiText).toContain('subWorkflow.block = existingLoopId ? { type: "loop-body", loopId: existingLoopId } : { type: "loop-body" };');
    expect(uiText).toContain("nodeKindOptionsForNode(node)");
    expect(uiText).toContain("function syncNodeKindsFromStructure()");
    expect(uiText).toContain("function nextSubWorkflowId()");
    expect(uiText).toContain('while (state.bundle.workflow.subWorkflows.some((subWorkflow) => subWorkflow.id === subWorkflowId))');
    expect(uiText).toContain('workflowManagerNode.kind = "root-manager"');
    expect(uiText).toContain('subWorkflowManagerNode.kind = "sub-manager"');
    expect(uiText).toContain('inputNode.kind = "input"');
    expect(uiText).toContain('outputNode.kind = "output"');
    expect(uiText).toContain("function refreshDerivedVisualization()");
    expect(uiText).toContain("refreshDerivedVisualization();");
    expect(uiText).toContain("Workflow Ref");
    expect(uiText).toContain("Human-input sources do not need workflow, node, or sub-workflow references.");
    expect(uiText).toContain("Workflow-output sources require a workflow reference.");
    expect(uiText).toContain("The workflow manager node is kept as root-manager so execution entry stays valid.");
    expect(uiText).toContain("This node is assigned as a sub-workflow input boundary, so its kind stays locked to input.");
    expect(uiText).toContain("This node is assigned as a sub-workflow output boundary, so its kind stays locked to output.");
    expect(uiText).toContain("Add a dedicated sub-manager node before creating another group.");
    expect(uiText).toContain("Manager, input, and output boundaries must be separate nodes.");
    expect(uiText).toContain("if (!trimmed || trimmed === subWorkflow.id)");
    expect(uiText).toContain("Group membership changed locally");
    expect(uiText).toContain("subWorkflow.managerNodeId === nodeId");
    expect(uiText).not.toContain('workflowNodeOptionsByKinds(["root-manager", "sub-manager", "manager"])');
    expect(uiText).not.toContain("(use workflow manager)");
    expect(uiText).not.toContain("Nodes JSON");

    const healthRes = await handleApiRequest(new Request("http://localhost/healthz"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(healthRes.status).toBe(200);
  });

  test("lists no workflows when the workflow root does not exist yet", async () => {
    const root = await makeTempDir();
    const missingWorkflowRoot = path.join(root, "missing-workflows");

    const listRes = await handleApiRequest(new Request("http://localhost/api/workflows"), {
      workflowRoot: missingWorkflowRoot,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });

    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { workflows: string[] };
    expect(listJson.workflows).toEqual([]);
  });

  test("renders browser UI capability hints for fixed, read-only, and no-exec modes", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const uiRes = await handleApiRequest(new Request("http://localhost/"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      fixedWorkflowName: "demo",
      readOnly: true,
      noExec: true,
      uiDistRoot: path.join(root, "missing-ui-dist"),
    });

    expect(uiRes.status).toBe(200);
    const uiText = await uiRes.text();
    expect(uiText).toContain('const fixedWorkflow = uiConfig.fixedWorkflowName;');
    expect(uiText).toContain('const readOnlyMode = uiConfig.readOnly === true;');
    expect(uiText).toContain('const noExecMode = uiConfig.noExec === true;');
    expect(uiText).toContain("function hasLoadedWorkflow()");
    expect(uiText).toContain("function isValidWorkflowNameInput(value)");
    expect(uiText).toContain("createWorkflowButtonEl.disabled = !isValidWorkflowNameInput(newWorkflowNameEl.value.trim());");
    expect(uiText).toContain("workflowDescriptionEl.disabled = readOnlyMode;");
    expect(uiText).toContain("reloadButtonEl.disabled = !hasLoadedWorkflow();");
    expect(uiText).toContain("validateButtonEl.disabled = !hasLoadedWorkflow();");
    expect(uiText).toContain("addNodeButtonEl.disabled = readOnlyMode || !hasLoadedWorkflow();");
    expect(uiText).toContain("nodeExecutionBackendEl.disabled = readOnlyMode || !hasLoadedWorkflow();");
    expect(uiText).toContain("promptEl.disabled = noExecMode || !hasLoadedWorkflow();");
    expect(uiText).toContain("scenarioEl.disabled = noExecMode || !hasLoadedWorkflow();");
    expect(uiText).toContain("maxStepsEl.disabled = noExecMode || !hasLoadedWorkflow();");
    expect(uiText).toContain("runButtonEl.disabled = noExecMode || !hasLoadedWorkflow();");
    expect(uiText).toContain("refreshSessionsButtonEl.disabled = !workflowEl.value;");
    expect(uiText).toContain("cancelSessionButtonEl.disabled = noExecMode || !selectedSessionCanCancel();");
    expect(uiText).toContain("Select or create a workflow to inspect executions.");
    expect(uiText).toContain("input.disabled = readOnlyMode || locked.has(option.value) || disabled.has(option.value);");
    expect(uiText).toContain("Fixed workflow mode is active.");
    expect(uiText).toContain("Read-only mode disables create and save actions.");
    expect(uiText).toContain("Execution is disabled, so run and cancel actions are unavailable.");
    expect(uiText).toContain("Read-only mode does not allow saving");
    expect(uiText).toContain("execution is disabled in no-exec mode");
    expect(uiText).toContain("Workflow names must start with a letter or number and use only letters, numbers, '-' or '_'");
    expect(uiText).toContain("workflowDescriptionEl.focus();");
    expect(uiText).toContain("const previousSelectedSessionId = state.selectedSessionId;");
    expect(uiText).toContain("previousSelectedSessionId !== state.selectedSessionId");
    expect(uiText).toContain("let polledSessionId = null;");
    expect(uiText).toContain("if (polledSessionId && polledSessionId !== state.selectedSessionId)");
    expect(uiText).toContain("if (polledSessionId !== sessionId || state.selectedSessionId !== sessionId)");
    expect(uiText).toContain('loadSessions(undefined, { refreshSelectedDetails: true }).catch((error) => {');
    expect(uiText).toContain('loadSessions(state.selectedSessionId, { refreshSelectedDetails: true }).catch((error) => {');
  });

  test("returns UI bootstrap config with legacy frontend mode when no built UI exists", async () => {
    const root = await makeTempDir();

    const res = await handleApiRequest(new Request("http://localhost/api/ui-config"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      fixedWorkflowName: "demo",
      readOnly: true,
      noExec: true,
      uiDistRoot: path.join(root, "missing-ui-dist"),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      fixedWorkflowName: "demo",
      readOnly: true,
      noExec: true,
      frontend: "legacy-inline",
    });
  });

  test("resolves default ui/dist relative to the package root instead of cwd", () => {
    const fakeBuiltModuleUrl = new URL("file:///tmp/oyakata-installed/dist/server/api.js").href;
    expect(resolveDefaultUiDistRoot(fakeBuiltModuleUrl)).toBe(path.join("/tmp/oyakata-installed", "ui", "dist"));

    const fakeSourceModuleUrl = new URL("file:///tmp/oyakata-dev/src/server/api.ts").href;
    expect(resolveDefaultUiDistRoot(fakeSourceModuleUrl)).toBe(path.join("/tmp/oyakata-dev", "ui", "dist"));
  });

  test("serves built UI assets when ui/dist output is available", async () => {
    const root = await makeTempDir();
    const uiDistRoot = path.join(root, "ui-dist");
    await mkdir(path.join(uiDistRoot, "assets"), { recursive: true });
    await writeFile(
      path.join(uiDistRoot, "index.html"),
      "<!doctype html><html><body><div id=\"app\">svelte build</div><script src=\"/assets/app.js\"></script></body></html>",
      "utf8",
    );
    await writeFile(path.join(uiDistRoot, "assets", "app.js"), "console.log('svelte asset');", "utf8");
    await writeFile(path.join(uiDistRoot, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8");

    const uiRes = await handleApiRequest(new Request("http://localhost/"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      uiDistRoot,
    });
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get("content-type")).toContain("text/html");
    await expect(uiRes.text()).resolves.toContain("svelte build");

    const assetRes = await handleApiRequest(new Request("http://localhost/assets/app.js"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      uiDistRoot,
    });
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toContain("text/javascript");
    await expect(assetRes.text()).resolves.toContain("svelte asset");

    const iconRes = await handleApiRequest(new Request("http://localhost/favicon.svg"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      uiDistRoot,
    });
    expect(iconRes.status).toBe(200);
    expect(iconRes.headers.get("content-type")).toContain("image/svg+xml");
    await expect(iconRes.text()).resolves.toContain("<svg");

    const configRes = await handleApiRequest(new Request("http://localhost/api/ui-config"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      uiDistRoot,
    });
    await expect(configRes.json()).resolves.toMatchObject({
      frontend: "svelte-dist",
    });
  });

  test("does not serve encoded traversal-like asset paths outside the built UI root", async () => {
    const root = await makeTempDir();
    const uiDistRoot = path.join(root, "ui-dist");
    await mkdir(uiDistRoot, { recursive: true });
    await writeFile(path.join(uiDistRoot, "index.html"), "<!doctype html><html><body>safe</body></html>", "utf8");
    await writeFile(path.join(root, "secret.txt"), "do not expose", "utf8");

    const res = await handleApiRequest(new Request("http://localhost/%2e%2e%2fsecret.txt"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      uiDistRoot,
    });

    expect(res.status).toBe(404);
  });

  test("lists and gets workflows", async () => {
    const root = await makeTempDir();
    const created = await createWorkflowTemplate("demo", { workflowRoot: root });
    expect(created.ok).toBe(true);

    const listRes = await handleApiRequest(new Request("http://localhost/api/workflows"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { workflows: string[] };
    expect(listJson.workflows).toContain("demo");

    const getRes = await handleApiRequest(new Request("http://localhost/api/workflows/demo"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      workflowName: string;
      derivedVisualization: readonly { id: string; indent: number; color: string }[];
    };
    expect(getJson.workflowName).toBe("demo");
    expect(getJson.derivedVisualization.length).toBeGreaterThan(0);
    expect(getJson.derivedVisualization[0]?.id).toBe("oyakata-manager");
    expect(getJson.derivedVisualization[0]?.indent).toBe(0);
    expect(getJson.derivedVisualization.find((entry) => entry.id === "workflow-input")?.color).toBe("group:main");
  });

  test("creates workflows from the API", async () => {
    const root = await makeTempDir();

    const createRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "browser-demo" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as {
      workflowName: string;
      revision: string | null;
      bundle: {
        workflow: { description: string };
        nodePayloads: Record<string, { executionBackend?: string; model: string }>;
      };
    };
    expect(createJson.workflowName).toBe("browser-demo");
    expect(createJson.bundle.workflow.description).toBe("New workflow");
    expect(createJson.bundle.nodePayloads["oyakata-manager"]?.executionBackend).toBe("tacogips/codex-agent");
    expect(createJson.bundle.nodePayloads["oyakata-manager"]?.model).toBe("gpt-5");
    expect(createJson.bundle.nodePayloads["workflow-output"]?.executionBackend).toBe("tacogips/codex-agent");
    expect(createJson.bundle.nodePayloads["workflow-output"]?.model).toBe("gpt-5");
    expect(createJson.revision).toEqual(expect.any(String));

    const duplicateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "browser-demo" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(duplicateRes.status).toBe(409);
  });

  test("rejects invalid workflow names from the API", async () => {
    const root = await makeTempDir();

    const createRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "../bad-name" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );

    expect(createRes.status).toBe(400);
    await expect(createRes.json()).resolves.toMatchObject({
      error: "invalid workflow name '../bad-name'",
    });
  });

  test("rejects browser workflow creation in fixed and read-only serve modes", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const readOnlyRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "blocked-by-readonly" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        readOnly: true,
      },
    );
    expect(readOnlyRes.status).toBe(403);
    await expect(readOnlyRes.json()).resolves.toMatchObject({ error: "read-only mode enabled" });

    const fixedWorkflowRes = await handleApiRequest(
      new Request("http://localhost/api/workflows", {
        method: "POST",
        body: JSON.stringify({ workflowName: "blocked-by-fixed" }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        fixedWorkflowName: "demo",
      },
    );
    expect(fixedWorkflowRes.status).toBe(403);
    await expect(fixedWorkflowRes.json()).resolves.toMatchObject({
      error: "cannot create workflows in fixed workflow mode",
    });
  });

  test("validates and executes workflow", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const validateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", { method: "POST" }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(validateRes.status).toBe(200);
    const validateJson = (await validateRes.json()) as { valid: boolean };
    expect(validateJson.valid).toBe(true);

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
        body: JSON.stringify({
          runtimeVariables: { topic: "x", humanInput: { request: "start demo workflow" } },
          maxSteps: 1,
          mockScenario: makeDefaultTemplateScenario(),
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(executeRes.status).toBe(200);
    const executeJson = (await executeRes.json()) as {
      workflowExecutionId: string;
      sessionId: string;
      status: string;
    };
    expect(executeJson.workflowExecutionId).toBe(executeJson.sessionId);
    expect(executeJson.sessionId).toContain("sess-");
    expect(executeJson.status).toBe("paused");

    const statusRes = await handleApiRequest(
      new Request(`http://localhost/api/workflow-executions/${executeJson.workflowExecutionId}`),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as { workflowExecutionId: string; sessionId: string };
    expect(statusJson.workflowExecutionId).toBe(executeJson.workflowExecutionId);
    expect(statusJson.sessionId).toBe(executeJson.sessionId);

    const cancelRes = await handleApiRequest(
      new Request(`http://localhost/api/workflow-executions/${executeJson.workflowExecutionId}/cancel`, { method: "POST" }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(cancelRes.status).toBe(200);
    const cancelJson = (await cancelRes.json()) as {
      accepted: boolean;
      status: string;
      workflowExecutionId: string;
      sessionId: string;
    };
    expect(cancelJson.accepted).toBe(true);
    expect(cancelJson.status).toBe("cancelled");
    expect(cancelJson.workflowExecutionId).toBe(executeJson.workflowExecutionId);
    expect(cancelJson.sessionId).toBe(executeJson.sessionId);
  });

  test("supports legacy session status and cancel aliases with workflowExecutionId fields", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const context = {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    };

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
        body: JSON.stringify({
          runtimeVariables: { topic: "x", humanInput: { request: "start demo workflow" } },
          maxSteps: 1,
          mockScenario: makeDefaultTemplateScenario(),
        }),
      }),
      context,
    );
    expect(executeRes.status).toBe(200);
    const executeJson = (await executeRes.json()) as {
      workflowExecutionId: string;
      sessionId: string;
      status: string;
    };

    const legacyStatusRes = await handleApiRequest(
      new Request(`http://localhost/api/sessions/${executeJson.sessionId}`),
      context,
    );
    expect(legacyStatusRes.status).toBe(200);
    const legacyStatusJson = (await legacyStatusRes.json()) as {
      workflowExecutionId: string;
      sessionId: string;
      status: string;
    };
    expect(legacyStatusJson.workflowExecutionId).toBe(executeJson.workflowExecutionId);
    expect(legacyStatusJson.sessionId).toBe(executeJson.sessionId);
    expect(legacyStatusJson.status).toBe(executeJson.status);

    const legacyCancelRes = await handleApiRequest(
      new Request(`http://localhost/api/sessions/${executeJson.sessionId}/cancel`, { method: "POST" }),
      context,
    );
    expect(legacyCancelRes.status).toBe(200);
    const legacyCancelJson = (await legacyCancelRes.json()) as {
      accepted: boolean;
      status: string;
      workflowExecutionId: string;
      sessionId: string;
    };
    expect(legacyCancelJson.accepted).toBe(true);
    expect(legacyCancelJson.status).toBe("cancelled");
    expect(legacyCancelJson.workflowExecutionId).toBe(executeJson.workflowExecutionId);
    expect(legacyCancelJson.sessionId).toBe(executeJson.sessionId);
  });

  test("validates an in-memory bundle before save", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const getRes = await handleApiRequest(new Request("http://localhost/api/workflows/demo"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      bundle: {
        workflow: Record<string, unknown>;
        workflowVis: { nodes: Array<{ id: string; order: number }> };
        nodePayloads: Record<string, unknown>;
      };
    };

    const invalidBundle = {
      ...getJson.bundle,
      workflowVis: {
        ...getJson.bundle.workflowVis,
        nodes: [{ id: "oyakata-manager", order: 0 }],
      },
    };

    const validateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", {
        method: "POST",
        body: JSON.stringify({ bundle: invalidBundle }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(validateRes.status).toBe(200);
    const validateJson = (await validateRes.json()) as {
      valid: boolean;
      issues: Array<{ path: string; message: string }>;
    };
    expect(validateJson.valid).toBe(false);
    expect(validateJson.issues.some((issue) => issue.path === "workflowVis.nodes")).toBe(true);
  });

  test("validates a bundle loaded from the GET endpoint", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const getRes = await handleApiRequest(new Request("http://localhost/api/workflows/demo"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      bundle: Record<string, unknown>;
    };

    const validateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", {
        method: "POST",
        body: JSON.stringify({ bundle: getJson.bundle }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(validateRes.status).toBe(200);
    const validateJson = (await validateRes.json()) as {
      valid: boolean;
      issues: Array<{ severity: string; path: string; message: string }>;
    };
    expect(validateJson.valid).toBe(true);
    expect(validateJson.issues.some((issue) => issue.message === "node payload file is missing")).toBe(false);
  });

  test("returns warnings for valid in-memory bundle validation", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const validateRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/validate", {
        method: "POST",
        body: JSON.stringify({
          bundle: {
            workflow: {
              workflowId: "demo",
              description: "demo",
              defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
              managerNodeId: "oyakata-manager",
              subWorkflows: [],
              nodes: [
                {
                  id: "oyakata-manager",
                  kind: "manager",
                  nodeFile: "node-oyakata-manager.json",
                  completion: { type: "none" },
                },
                {
                  id: "worker-1",
                  kind: "task",
                  nodeFile: "node-worker-1.json",
                  completion: { type: "none" },
                },
              ],
              edges: [],
              loops: [],
              branching: { mode: "fan-out" },
            },
            workflowVis: {
              nodes: [
                { id: "oyakata-manager", x: 10, y: 10, width: 100, height: 80 },
                { id: "worker-1", x: 200, y: 10, width: 100, height: 80 },
              ],
              viewport: { x: 0, y: 0, zoom: 1 },
            },
            nodePayloads: {
              "node-oyakata-manager.json": {
                id: "oyakata-manager",
                model: "tacogips/codex-agent",
                promptTemplate: "manager",
                variables: {},
              },
              "node-worker-1.json": {
                id: "worker-1",
                model: "tacogips/codex-agent",
                promptTemplate: "worker",
                variables: {},
              },
            },
          },
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(validateRes.status).toBe(200);
    const validateJson = (await validateRes.json()) as {
      valid: boolean;
      issues: Array<{ severity: string; path: string; message: string }>;
      warnings: Array<{ severity: string; path: string; message: string }>;
    };
    expect(validateJson.valid).toBe(true);
    expect(validateJson.warnings.length).toBeGreaterThan(0);
    expect(validateJson.issues.some((issue) => issue.path === "workflowVis.viewport")).toBe(true);
    expect(validateJson.issues.some((issue) => issue.path === "workflow.defaults.maxLoopIterations")).toBe(true);
  });

  test("executes asynchronously and lists sessions", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });
    const context = {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    };

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
        body: JSON.stringify({ async: true }),
      }),
      context,
    );
    expect(executeRes.status).toBe(202);
    const executeJson = (await executeRes.json()) as {
      workflowExecutionId: string;
      sessionId: string;
      accepted: boolean;
    };
    expect(executeJson.accepted).toBe(true);
    expect(executeJson.workflowExecutionId).toBe(executeJson.sessionId);

    let foundSession = false;
    for (let index = 0; index < 20; index += 1) {
      const statusRes = await handleApiRequest(
        new Request(`http://localhost/api/workflow-executions/${executeJson.workflowExecutionId}`),
        context,
      );
      if (statusRes.status === 200) {
        foundSession = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(foundSession).toBe(true);

    const listRes = await handleApiRequest(new Request("http://localhost/api/sessions"), context);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      sessions: Array<{ workflowExecutionId: string; sessionId: string; workflowName: string; status: string }>;
    };
    expect(
      listJson.sessions.some(
        (session) =>
          session.workflowExecutionId === executeJson.workflowExecutionId && session.sessionId === executeJson.sessionId,
      ),
    ).toBe(true);

    for (let index = 0; index < 40; index += 1) {
      const statusRes = await handleApiRequest(
        new Request(`http://localhost/api/workflow-executions/${executeJson.workflowExecutionId}`),
        context,
      );
      if (statusRes.status !== 200) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const sessionJson = (await statusRes.json()) as { status: string };
      if (["completed", "failed", "cancelled"].includes(sessionJson.status)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  test("reruns a session from a specific node", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", {
        method: "POST",
        body: JSON.stringify({
          runtimeVariables: { humanInput: { request: "start demo workflow" } },
          maxSteps: 1,
          mockScenario: makeDefaultTemplateScenario("manager"),
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(executeRes.status).toBe(200);
    const executeJson = (await executeRes.json()) as { sessionId: string };

    const rerunRes = await handleApiRequest(
      new Request(`http://localhost/api/sessions/${executeJson.sessionId}/rerun`, {
        method: "POST",
        body: JSON.stringify({
          fromNodeId: "workflow-output",
          mockScenario: {
            "workflow-output": {
              provider: "scenario-mock",
              when: { always: true },
              payload: { stage: "test-review" },
            },
          },
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(rerunRes.status).toBe(200);
    const rerunJson = (await rerunRes.json()) as {
      sourceSessionId: string;
      sessionId: string;
      rerunFromNodeId: string;
    };
    expect(rerunJson.sourceSessionId).toBe(executeJson.sessionId);
    expect(rerunJson.sessionId).not.toBe(executeJson.sessionId);
    expect(rerunJson.rerunFromNodeId).toBe("workflow-output");
  });

  test("honors no-exec mode", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const executeRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo/execute", { method: "POST" }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        noExec: true,
      },
    );

    expect(executeRes.status).toBe(403);
  });

  test("updates workflow with revision conflict protection", async () => {
    const root = await makeTempDir();
    await createWorkflowTemplate("demo", { workflowRoot: root });

    const getRes = await handleApiRequest(new Request("http://localhost/api/workflows/demo"), {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      revision: string;
      bundle: {
        workflow: Record<string, unknown>;
        workflowVis: Record<string, unknown>;
        nodePayloads: Record<string, unknown>;
      };
    };

    const updatedWorkflow = {
      ...getJson.bundle.workflow,
      description: "updated description",
    };

    const putRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo", {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: getJson.revision,
          bundle: {
            workflow: updatedWorkflow,
            workflowVis: getJson.bundle.workflowVis,
            nodePayloads: getJson.bundle.nodePayloads,
          },
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as { revision: string };
    expect(putJson.revision).not.toBe(getJson.revision);

    const stalePutRes = await handleApiRequest(
      new Request("http://localhost/api/workflows/demo", {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: getJson.revision,
          bundle: {
            workflow: updatedWorkflow,
            workflowVis: getJson.bundle.workflowVis,
            nodePayloads: getJson.bundle.nodePayloads,
          },
        }),
      }),
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
    );
    expect(stalePutRes.status).toBe(409);
  });
});
