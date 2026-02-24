import { readFile } from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "./result";
import { isSafeWorkflowName, resolveEffectiveRoots } from "./paths";
import { validateWorkflowBundle } from "./validate";
import type { LoadOptions, NormalizedWorkflowBundle, ValidationIssue } from "./types";

export interface LoadedWorkflow {
  readonly workflowName: string;
  readonly workflowDirectory: string;
  readonly artifactWorkflowRoot: string;
  readonly bundle: NormalizedWorkflowBundle;
}

export interface LoadFailure {
  readonly code: "INVALID_WORKFLOW_NAME" | "NOT_FOUND" | "IO" | "VALIDATION";
  readonly message: string;
  readonly issues?: readonly ValidationIssue[];
}

async function readJsonFile(filePath: string): Promise<Result<unknown, LoadFailure>> {
  try {
    const raw = await readFile(filePath, "utf8");
    return ok(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("ENOENT")) {
      return err({
        code: "NOT_FOUND",
        message: `required file was not found: ${filePath}`,
      });
    }
    return err({
      code: "IO",
      message: `failed reading JSON file '${filePath}': ${message}`,
    });
  }
}

export async function loadWorkflowFromDisk(
  workflowName: string,
  options: LoadOptions = {},
): Promise<Result<LoadedWorkflow, LoadFailure>> {
  if (!isSafeWorkflowName(workflowName)) {
    return err({
      code: "INVALID_WORKFLOW_NAME",
      message: `invalid workflow name '${workflowName}'`,
    });
  }

  const roots = resolveEffectiveRoots(options);
  const workflowDirectory = path.join(roots.workflowRoot, workflowName);

  const workflowPath = path.join(workflowDirectory, "workflow.json");
  const workflowVisPath = path.join(workflowDirectory, "workflow-vis.json");

  const workflowRaw = await readJsonFile(workflowPath);
  if (!workflowRaw.ok) {
    return err(workflowRaw.error);
  }

  const workflowVisRaw = await readJsonFile(workflowVisPath);
  if (!workflowVisRaw.ok) {
    return err(workflowVisRaw.error);
  }

  if (
    typeof workflowRaw.value !== "object" ||
    workflowRaw.value === null ||
    !Array.isArray((workflowRaw.value as { nodes?: unknown }).nodes)
  ) {
    return err({
      code: "VALIDATION",
      message: "workflow.json is missing nodes[]",
      issues: [{ severity: "error", path: "workflow.nodes", message: "must be an array" }],
    });
  }

  const workflowNodes = (workflowRaw.value as { nodes: Array<{ nodeFile?: unknown }> }).nodes;
  const nodePayloads: Record<string, unknown> = {};

  for (const node of workflowNodes) {
    if (typeof node.nodeFile !== "string") {
      continue;
    }
    const nodeFilePath = path.join(workflowDirectory, node.nodeFile);
    const nodeRaw = await readJsonFile(nodeFilePath);
    if (!nodeRaw.ok) {
      return err(nodeRaw.error);
    }
    nodePayloads[node.nodeFile] = nodeRaw.value;
  }

  const validation = validateWorkflowBundle({
    workflow: workflowRaw.value,
    workflowVis: workflowVisRaw.value,
    nodePayloads,
  });

  if (!validation.ok) {
    return err({
      code: "VALIDATION",
      message: "workflow validation failed",
      issues: validation.error,
    });
  }

  return ok({
    workflowName,
    workflowDirectory,
    artifactWorkflowRoot: path.join(roots.artifactRoot, validation.value.workflow.workflowId),
    bundle: validation.value,
  });
}
