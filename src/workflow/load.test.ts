import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadWorkflowFromDisk } from "./load";
import { resolveEffectiveRoots } from "./paths";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oyakata-load-test-"));
  tempDirs.push(directory);
  return directory;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveEffectiveRoots", () => {
  test("uses option > env > default priority", () => {
    const fromEnv = resolveEffectiveRoots({
      env: {
        OYAKATA_WORKFLOW_ROOT: "env-workflows",
        OYAKATA_ARTIFACT_ROOT: "env-artifacts",
      },
      cwd: "/tmp/project",
    });
    expect(fromEnv.workflowRoot).toBe("/tmp/project/env-workflows");
    expect(fromEnv.artifactRoot).toBe("/tmp/project/env-artifacts");

    const fromOption = resolveEffectiveRoots({
      workflowRoot: "flag-workflows",
      artifactRoot: "flag-artifacts",
      env: {
        OYAKATA_WORKFLOW_ROOT: "env-workflows",
        OYAKATA_ARTIFACT_ROOT: "env-artifacts",
      },
      cwd: "/tmp/project",
    });
    expect(fromOption.workflowRoot).toBe("/tmp/project/flag-workflows");
    expect(fromOption.artifactRoot).toBe("/tmp/project/flag-artifacts");
  });
});

describe("loadWorkflowFromDisk", () => {
  test("loads and validates workflow directory", async () => {
    const root = await makeTempDir();
    const workflowName = "sample-workflow";
    const workflowDirectory = path.join(root, workflowName);
    await mkdir(workflowDirectory, { recursive: true });

    await writeJson(path.join(workflowDirectory, "workflow.json"), {
      workflowId: "sample-workflow",
      description: "sample",
      defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
      managerNodeId: "oyakata-manager",
      subWorkflows: [],
      nodes: [
        { id: "oyakata-manager", kind: "manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
      ],
      edges: [],
      loops: [],
      branching: { mode: "fan-out" },
    });

    await writeJson(path.join(workflowDirectory, "workflow-vis.json"), {
      nodes: [{ id: "oyakata-manager", order: 0 }],
    });

    await writeJson(path.join(workflowDirectory, "node-oyakata-manager.json"), {
      id: "oyakata-manager",
      model: "tacogips/codex-agent",
      promptTemplate: "manager",
      variables: {},
    });

    const result = await loadWorkflowFromDisk(workflowName, {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.bundle.workflow.workflowId).toBe("sample-workflow");
    expect(result.value.artifactWorkflowRoot).toContain(path.join("artifacts", "sample-workflow"));
  });

  test("returns validation error when files are invalid", async () => {
    const root = await makeTempDir();
    const workflowName = "broken-workflow";
    const workflowDirectory = path.join(root, workflowName);
    await mkdir(workflowDirectory, { recursive: true });

    await writeJson(path.join(workflowDirectory, "workflow.json"), {
      workflowId: "broken-workflow",
      description: "broken",
      defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
      managerNodeId: "missing",
      subWorkflows: [],
      nodes: [],
      edges: [],
      branching: { mode: "fan-out" },
    });

    await writeJson(path.join(workflowDirectory, "workflow-vis.json"), { nodes: [] });

    const result = await loadWorkflowFromDisk(workflowName, { workflowRoot: root });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("VALIDATION");
  });

  test("auto-generates vertical ordering when workflow-vis.json is missing", async () => {
    const root = await makeTempDir();
    const workflowName = "missing-vis";
    const workflowDirectory = path.join(root, workflowName);
    await mkdir(workflowDirectory, { recursive: true });

    await writeJson(path.join(workflowDirectory, "workflow.json"), {
      workflowId: "missing-vis",
      description: "sample",
      defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
      managerNodeId: "oyakata-manager",
      subWorkflows: [],
      nodes: [
        { id: "oyakata-manager", kind: "manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
        { id: "worker-1", kind: "task", nodeFile: "node-worker-1.json", completion: { type: "none" } },
      ],
      edges: [],
      loops: [],
      branching: { mode: "fan-out" },
    });

    await writeJson(path.join(workflowDirectory, "node-oyakata-manager.json"), {
      id: "oyakata-manager",
      model: "tacogips/codex-agent",
      promptTemplate: "manager",
      variables: {},
    });
    await writeJson(path.join(workflowDirectory, "node-worker-1.json"), {
      id: "worker-1",
      model: "tacogips/codex-agent",
      promptTemplate: "worker",
      variables: {},
    });

    const result = await loadWorkflowFromDisk(workflowName, {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.bundle.workflowVis.nodes).toEqual([
      { id: "oyakata-manager", order: 0 },
      { id: "worker-1", order: 1 },
    ]);
    expect(result.value.bundle.workflowVis.uiMeta).toEqual({
      layout: "vertical",
      autoGenerated: true,
    });
  });
});
