import path from "node:path";
import {
  DEFAULT_ARTIFACT_ROOT,
  DEFAULT_WORKFLOW_ROOT,
  type EffectiveRoots,
  type LoadOptions,
} from "./types";

function resolveRootPath(root: string, cwd: string): string {
  return path.isAbsolute(root) ? root : path.resolve(cwd, root);
}

export function resolveEffectiveRoots(options: LoadOptions = {}): EffectiveRoots {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const workflowRoot =
    options.workflowRoot ?? env["OYAKATA_WORKFLOW_ROOT"] ?? DEFAULT_WORKFLOW_ROOT;
  const artifactRoot =
    options.artifactRoot ?? env["OYAKATA_ARTIFACT_ROOT"] ?? DEFAULT_ARTIFACT_ROOT;

  return {
    workflowRoot: resolveRootPath(workflowRoot, cwd),
    artifactRoot: resolveRootPath(artifactRoot, cwd),
  };
}

export function isSafeWorkflowName(workflowName: string): boolean {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/.test(workflowName)) {
    return false;
  }
  return !workflowName.includes("..");
}
