import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { runWorkflow } from "./engine";
import { resolveRuntimeDbPath } from "./runtime-db";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oyakata-runtime-db-test-"));
  tempDirs.push(directory);
  return directory;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function createWorkflowFixture(root: string, workflowName: string): Promise<void> {
  const workflowDir = path.join(root, workflowName);
  await mkdir(workflowDir, { recursive: true });

  await writeJson(path.join(workflowDir, "workflow.json"), {
    workflowId: workflowName,
    description: "fixture",
    defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
    managerNodeId: "oyakata-manager",
    subWorkflows: [],
    nodes: [
      { id: "oyakata-manager", kind: "manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
      { id: "step-1", kind: "task", nodeFile: "node-step-1.json", completion: { type: "none" } },
    ],
    edges: [{ from: "oyakata-manager", to: "step-1", when: "always" }],
    loops: [],
    branching: { mode: "fan-out" },
  });

  await writeJson(path.join(workflowDir, "workflow-vis.json"), {
    nodes: [
      { id: "oyakata-manager", order: 0 },
      { id: "step-1", order: 1 },
    ],
  });

  await writeJson(path.join(workflowDir, "node-oyakata-manager.json"), {
    id: "oyakata-manager",
    model: "tacogips/codex-agent",
    promptTemplate: "manager {{topic}}",
    variables: { topic: "A" },
  });
  await writeJson(path.join(workflowDir, "node-step-1.json"), {
    id: "step-1",
    model: "tacogips/claude-code-agent",
    promptTemplate: "step {{topic}}",
    variables: {},
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime-db", () => {
  test("writes session and node execution index rows to sqlite", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "sqlite-index");

    const options = {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      cwd: root,
    };

    const result = await runWorkflow("sqlite-index", options);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const dbPath = resolveRuntimeDbPath(options);
    const db = new Database(dbPath, { readonly: true });
    try {
      const sessionCount = db.query("SELECT count(*) as count FROM sessions").get() as { count: number };
      const nodeCount = db.query("SELECT count(*) as count FROM node_executions").get() as { count: number };
      const logCount = db.query("SELECT count(*) as count FROM node_logs").get() as { count: number };
      expect(sessionCount.count).toBeGreaterThanOrEqual(1);
      expect(nodeCount.count).toBeGreaterThanOrEqual(2);
      expect(logCount.count).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });
});
