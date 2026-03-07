import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "./result";
import { isSafeWorkflowName, resolveEffectiveRoots } from "./paths";
import type { LoadOptions } from "./types";

export interface CreateWorkflowSuccess {
  readonly workflowName: string;
  readonly workflowDirectory: string;
}

export interface CreateWorkflowFailure {
  readonly code: "INVALID_WORKFLOW_NAME" | "ALREADY_EXISTS" | "IO";
  readonly message: string;
}

const TEMPLATE_MODEL = "tacogips/codex-agent";

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function createWorkflowTemplate(
  workflowName: string,
  options: LoadOptions = {},
): Promise<Result<CreateWorkflowSuccess, CreateWorkflowFailure>> {
  if (!isSafeWorkflowName(workflowName)) {
    return err({
      code: "INVALID_WORKFLOW_NAME",
      message: `invalid workflow name '${workflowName}'`,
    });
  }

  const roots = resolveEffectiveRoots(options);
  const workflowDirectory = path.join(roots.workflowRoot, workflowName);

  try {
    await mkdir(roots.workflowRoot, { recursive: true });
    await mkdir(workflowDirectory, { recursive: false });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("EEXIST")) {
      return err({
        code: "ALREADY_EXISTS",
        message: `workflow already exists: ${workflowDirectory}`,
      });
    }
    return err({
      code: "IO",
      message: `failed creating workflow directory '${workflowDirectory}': ${message}`,
    });
  }

  const workflowId = workflowName;
  const managerId = "oyakata-manager";
  const inputId = "workflow-input";
  const outputId = "workflow-output";

  const workflowJson = {
    workflowId,
    description: "New workflow",
    defaults: {
      maxLoopIterations: 3,
      nodeTimeoutMs: 120000,
    },
    managerNodeId: managerId,
    subWorkflows: [
      {
        id: "main",
        description: "Main sub-workflow",
        inputNodeId: inputId,
        outputNodeId: outputId,
        nodeIds: [inputId, outputId],
        inputSources: [{ type: "human-input" }],
      },
    ],
    nodes: [
      { id: managerId, kind: "root-manager", nodeFile: `node-${managerId}.json`, completion: { type: "none" } },
      { id: inputId, kind: "input", nodeFile: `node-${inputId}.json`, completion: { type: "none" } },
      { id: outputId, kind: "output", nodeFile: `node-${outputId}.json`, completion: { type: "none" } },
    ],
    edges: [
      { from: managerId, to: inputId, when: "always" },
      { from: inputId, to: outputId, when: "always" },
    ],
    loops: [],
    branching: { mode: "fan-out" },
  };

  const workflowVis = {
    nodes: [
      { id: managerId, order: 0 },
      { id: inputId, order: 1 },
      { id: outputId, order: 2 },
    ],
    uiMeta: { layout: "vertical" },
  };

  const nodePayloads: Array<{ fileName: string; payload: object }> = [
    {
      fileName: `node-${managerId}.json`,
      payload: {
        id: managerId,
        model: TEMPLATE_MODEL,
        promptTemplate: "Coordinate workflow execution for {{workflowId}}",
        variables: { workflowId },
      },
    },
    {
      fileName: `node-${inputId}.json`,
      payload: {
        id: inputId,
        model: TEMPLATE_MODEL,
        promptTemplate: "Collect human input",
        variables: {},
      },
    },
    {
      fileName: `node-${outputId}.json`,
      payload: {
        id: outputId,
        model: TEMPLATE_MODEL,
        promptTemplate: "Finalize workflow output",
        variables: {},
      },
    },
  ];

  try {
    await writeJson(path.join(workflowDirectory, "workflow.json"), workflowJson);
    await writeJson(path.join(workflowDirectory, "workflow-vis.json"), workflowVis);
    for (const node of nodePayloads) {
      await writeJson(path.join(workflowDirectory, node.fileName), node.payload);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    try {
      await rm(workflowDirectory, { recursive: true, force: true });
    } catch {
      // Preserve the original write failure; the caller only needs one actionable error.
    }
    return err({
      code: "IO",
      message: `failed writing workflow templates: ${message}`,
    });
  }

  return ok({
    workflowName,
    workflowDirectory,
  });
}
