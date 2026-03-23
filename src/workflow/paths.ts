import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_WORKFLOW_ROOT,
  ROOT_DATA_FILES_SUBDIR,
  ROOT_DATA_WORKFLOW_SUBDIR,
  type EffectiveRoots,
  type LoadOptions,
} from "./types";

function resolveRootPath(root: string, cwd: string): string {
  return path.isAbsolute(root) ? root : path.resolve(cwd, root);
}

function resolveNearestWorkflowProjectRoot(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".divedra");
    try {
      if (statSync(candidate).isDirectory()) {
        return current;
      }
    } catch {
      // Keep walking upward when `.divedra` is absent or unreadable.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }
    current = parent;
  }
}

export function resolveRootDataDir(options: LoadOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const rootDataDir =
    options.rootDataDir ??
    env["DIVEDRA_ARTIFACT_DIR"] ??
    env["DIVEDRA_ROOT_DATA_DIR"] ??
    env["DIVEDRA_RUNTIME_ROOT"] ??
    computeDefaultRootDataDir(cwd);
  return resolveRootPath(rootDataDir, cwd);
}

export function resolveAttachmentRoot(options: LoadOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const rootDataDir = resolveRootDataDir(options);
  const attachmentRoot =
    env["DIVEDRA_ATTACHMENT_ROOT"] !== undefined &&
    env["DIVEDRA_ATTACHMENT_ROOT"] !== ""
      ? resolveRootPath(env["DIVEDRA_ATTACHMENT_ROOT"], cwd)
      : path.join(rootDataDir, ROOT_DATA_FILES_SUBDIR);
  return attachmentRoot;
}

export function resolveEffectiveRoots(
  options: LoadOptions = {},
): EffectiveRoots {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = resolveNearestWorkflowProjectRoot(cwd);
  const rootDataDir = resolveRootDataDir(options);

  const workflowRoot =
    options.workflowRoot ??
    env["DIVEDRA_WORKFLOW_ROOT"] ??
    path.join(projectRoot, DEFAULT_WORKFLOW_ROOT);
  const artifactRoot =
    options.artifactRoot ??
    env["DIVEDRA_ARTIFACT_ROOT"] ??
    path.join(rootDataDir, ROOT_DATA_WORKFLOW_SUBDIR);
  const attachmentRoot =
    env["DIVEDRA_ATTACHMENT_ROOT"] !== undefined &&
    env["DIVEDRA_ATTACHMENT_ROOT"] !== ""
      ? resolveRootPath(env["DIVEDRA_ATTACHMENT_ROOT"], cwd)
      : path.join(rootDataDir, ROOT_DATA_FILES_SUBDIR);

  return {
    workflowRoot: resolveRootPath(workflowRoot, cwd),
    artifactRoot: resolveRootPath(artifactRoot, cwd),
    rootDataDir,
    attachmentRoot,
  };
}
/**
 * Encodes an absolute filesystem path for use under `~/.divedra/project/<encoded>/divedra-artifact`.
 * Path segments (split on `/` and `\\`) are joined with `__`, and characters
 * that are problematic in portable directory names are normalized to `_`.
 */
export function encodeProjectPathForDivedraScope(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  const segments = normalized
    .split(/[/\\]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "_"));
  if (segments.length === 0) {
    return "root";
  }
  return segments.join("__");
}

/**
 * Default root data directory when no env override is set:
 * `~/.divedra/project/<encode(cwd)>/divedra-artifact`
 */
export function computeDefaultRootDataDir(cwd: string): string {
  const encoded = encodeProjectPathForDivedraScope(cwd);
  return path.join(os.homedir(), ".divedra", "project", encoded, "divedra-artifact");
}

export function isSafeWorkflowName(workflowName: string): boolean {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/.test(workflowName)) {
    return false;
  }
  return !workflowName.includes("..");
}
