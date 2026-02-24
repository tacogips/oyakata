import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AdapterExecutionError } from "./adapter";
import type { NodeAdapter } from "./adapter";
import { runWorkflow } from "./engine";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oyakata-engine-test-"));
  tempDirs.push(directory);
  return directory;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createWorkflowFixture(root: string, workflowName: string, withLoop: boolean): Promise<void> {
  const workflowDir = path.join(root, workflowName);
  await mkdir(workflowDir, { recursive: true });

  const nodes = withLoop
    ? [
        { id: "oyakata-manager", kind: "manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
        { id: "step-1", kind: "loop-judge", nodeFile: "node-step-1.json", completion: { type: "none" } },
        { id: "done", kind: "output", nodeFile: "node-done.json", completion: { type: "none" } },
      ]
    : [
        { id: "oyakata-manager", kind: "manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
        { id: "step-1", kind: "task", nodeFile: "node-step-1.json", completion: { type: "none" } },
      ];

  const edges = withLoop
    ? [
        { from: "oyakata-manager", to: "step-1", when: "always" },
        { from: "step-1", to: "step-1", when: "continue_round" },
        { from: "step-1", to: "done", when: "loop_exit" },
      ]
    : [{ from: "oyakata-manager", to: "step-1", when: "always" }];

  await writeJson(path.join(workflowDir, "workflow.json"), {
    workflowId: workflowName,
    description: "fixture",
    defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
    managerNodeId: "oyakata-manager",
    subWorkflows: [],
    nodes,
    edges,
    loops: withLoop
      ? [
          {
            id: "main-loop",
            judgeNodeId: "step-1",
            continueWhen: "continue_round",
            exitWhen: "loop_exit",
          },
        ]
      : [],
    branching: { mode: "fan-out" },
  });

  await writeJson(path.join(workflowDir, "workflow-vis.json"), {
    nodes: withLoop
      ? [
          { id: "oyakata-manager", x: 0, y: 0, width: 100, height: 100 },
          { id: "step-1", x: 200, y: 0, width: 100, height: 100 },
          { id: "done", x: 400, y: 0, width: 100, height: 100 },
        ]
      : [
          { id: "oyakata-manager", x: 0, y: 0, width: 100, height: 100 },
          { id: "step-1", x: 200, y: 0, width: 100, height: 100 },
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

  if (withLoop) {
    await writeJson(path.join(workflowDir, "node-done.json"), {
      id: "done",
      model: "tacogips/claude-code-agent",
      promptTemplate: "done",
      variables: {},
    });
  }
}

async function createSubWorkflowRuntimeFixture(root: string, workflowName: string): Promise<void> {
  const workflowDir = path.join(root, workflowName);
  await mkdir(workflowDir, { recursive: true });

  await writeJson(path.join(workflowDir, "workflow.json"), {
    workflowId: workflowName,
    description: "sub-workflow fixture",
    defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
    managerNodeId: "oyakata-manager",
    subWorkflows: [
      {
        id: "sw-a",
        description: "A",
        inputNodeId: "a-input",
        outputNodeId: "a-output",
        inputSources: [{ type: "human-input" }],
      },
      {
        id: "sw-b",
        description: "B",
        inputNodeId: "b-input",
        outputNodeId: "b-output",
        inputSources: [{ type: "sub-workflow-output", subWorkflowId: "sw-a" }],
      },
    ],
    nodes: [
      { id: "oyakata-manager", kind: "manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
      { id: "a-input", kind: "input", nodeFile: "node-a-input.json", completion: { type: "none" } },
      { id: "a-output", kind: "output", nodeFile: "node-a-output.json", completion: { type: "none" } },
      { id: "b-input", kind: "input", nodeFile: "node-b-input.json", completion: { type: "none" } },
      { id: "b-output", kind: "output", nodeFile: "node-b-output.json", completion: { type: "none" } },
    ],
    edges: [
      { from: "a-input", to: "a-output", when: "always" },
      { from: "a-output", to: "oyakata-manager", when: "always" },
      { from: "b-input", to: "b-output", when: "always" },
      { from: "b-output", to: "oyakata-manager", when: "always" },
    ],
    loops: [],
    branching: { mode: "fan-out" },
  });

  await writeJson(path.join(workflowDir, "workflow-vis.json"), {
    nodes: [
      { id: "oyakata-manager", x: 0, y: 0, width: 100, height: 100 },
      { id: "a-input", x: 120, y: 0, width: 100, height: 100 },
      { id: "a-output", x: 240, y: 0, width: 100, height: 100 },
      { id: "b-input", x: 360, y: 0, width: 100, height: 100 },
      { id: "b-output", x: 480, y: 0, width: 100, height: 100 },
    ],
  });

  await writeJson(path.join(workflowDir, "node-oyakata-manager.json"), {
    id: "oyakata-manager",
    model: "tacogips/codex-agent",
    promptTemplate: "manager",
    variables: {},
  });
  await writeJson(path.join(workflowDir, "node-a-input.json"), {
    id: "a-input",
    model: "tacogips/codex-agent",
    promptTemplate: "a-input",
    variables: {},
  });
  await writeJson(path.join(workflowDir, "node-a-output.json"), {
    id: "a-output",
    model: "tacogips/codex-agent",
    promptTemplate: "a-output",
    variables: {},
  });
  await writeJson(path.join(workflowDir, "node-b-input.json"), {
    id: "b-input",
    model: "tacogips/codex-agent",
    promptTemplate: "b-input",
    variables: {},
  });
  await writeJson(path.join(workflowDir, "node-b-output.json"), {
    id: "b-output",
    model: "tacogips/codex-agent",
    promptTemplate: "b-output",
    variables: {},
  });
}

describe("runWorkflow", () => {
  test("executes linear workflow and writes artifacts", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "linear", false);

    const result = await runWorkflow("linear", {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      runtimeVariables: { topic: "B" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.exitCode).toBe(0);
    expect(result.value.session.status).toBe("completed");
    expect(result.value.session.nodeExecutions.length).toBe(2);

    const step1Exec = result.value.session.nodeExecutions.find((entry) => entry.nodeId === "step-1");
    expect(step1Exec).toBeDefined();
    if (step1Exec === undefined) {
      return;
    }
    const inputRaw = await readFile(path.join(step1Exec.artifactDir, "input.json"), "utf8");
    const inputJson = JSON.parse(inputRaw) as {
      promptText: string;
      upstreamOutputRefs: readonly {
        fromNodeId: string;
        workflowId: string;
      }[];
    };
    expect(inputJson.promptText).toContain("B");
    expect(inputJson.upstreamOutputRefs.length).toBe(1);
    expect(inputJson.upstreamOutputRefs[0]?.fromNodeId).toBe("oyakata-manager");
    expect(inputJson.upstreamOutputRefs[0]?.workflowId).toBe("linear");

    const handoffRaw = await readFile(path.join(step1Exec.artifactDir, "handoff.json"), "utf8");
    const handoffJson = JSON.parse(handoffRaw) as {
      inputHash: string;
      outputHash: string;
      nextNodes: readonly string[];
      outputRef: { outputNodeId: string; nodeExecId: string };
    };
    expect(handoffJson.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(handoffJson.outputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(handoffJson.outputRef.outputNodeId).toBe("step-1");
    expect(handoffJson.outputRef.nodeExecId).toBe(step1Exec.nodeExecId);
    expect(handoffJson.nextNodes).toEqual([]);

    const commitMessage = await readFile(path.join(step1Exec.artifactDir, "commit-message.txt"), "utf8");
    expect(commitMessage).toContain("Node-ID: step-1");
    expect(commitMessage).toContain(`Run-ID: ${result.value.session.sessionId}`);
  });

  test("assembles node arguments from runtime variables and upstream outputs", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "assembled-input", false);

    await writeJson(path.join(root, "assembled-input", "node-step-1.json"), {
      id: "step-1",
      model: "tacogips/claude-code-agent",
      promptTemplate: "step {{topic}}",
      variables: {},
      argumentsTemplate: { task: { topic: "", managerNode: "" } },
      argumentBindings: [
        {
          targetPath: "task.topic",
          source: "variables",
          sourcePath: "topic",
          required: true,
        },
        {
          targetPath: "task.managerNode",
          source: "node-output",
          sourceRef: "oyakata-manager",
          sourcePath: "output.payload.nodeId",
          required: true,
        },
      ],
    });

    const result = await runWorkflow("assembled-input", {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      runtimeVariables: { topic: "B" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const step1Exec = result.value.session.nodeExecutions.find((entry) => entry.nodeId === "step-1");
    expect(step1Exec).toBeDefined();
    if (step1Exec === undefined) {
      return;
    }

    const inputRaw = await readFile(path.join(step1Exec.artifactDir, "input.json"), "utf8");
    const inputJson = JSON.parse(inputRaw) as {
      arguments: { task: { topic: string; managerNode: string } } | null;
    };
    expect(inputJson.arguments).toEqual({
      task: {
        topic: "B",
        managerNode: "oyakata-manager",
      },
    });
  });

  test("fails deterministically when required argument binding source is missing", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "missing-required-binding", false);

    await writeJson(path.join(root, "missing-required-binding", "node-step-1.json"), {
      id: "step-1",
      model: "tacogips/claude-code-agent",
      promptTemplate: "step {{topic}}",
      variables: {},
      argumentsTemplate: {},
      argumentBindings: [
        {
          targetPath: "task.userInput",
          source: "human-input",
          sourcePath: "response",
          required: true,
        },
      ],
    });

    const result = await runWorkflow("missing-required-binding", {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      runtimeVariables: { topic: "B" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(3);
      expect(result.error.message).toContain("input assembly failed");
    }
  });

  test("uses loop semantics to force exit when max loop iterations are reached", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "looped", true);

    const result = await runWorkflow("looped", {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      maxLoopIterations: 2,
      mockScenario: {
        "step-1": {
          when: { continue_round: true, loop_exit: false },
          payload: {},
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.session.status).toBe("completed");
    expect(result.value.session.loopIterationCounts?.["main-loop"]).toBe(2);
    expect(result.value.session.nodeExecutions.filter((entry) => entry.nodeId === "step-1")).toHaveLength(3);
  });

  test("supports dry-run without adapter execution", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "dry-run", false);

    const result = await runWorkflow("dry-run", {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.session.status).toBe("completed");
    const managerExec = result.value.session.nodeExecutions.find((entry) => entry.nodeId === "oyakata-manager");
    expect(managerExec).toBeDefined();
    const outputRaw = await readFile(path.join(managerExec!.artifactDir, "output.json"), "utf8");
    const outputJson = JSON.parse(outputRaw) as { provider: string };
    expect(outputJson.provider).toBe("dry-run");
  });

  test("restarts stuck node and completes when retry succeeds", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "restart-success", false);

    let firstStepAttempt = true;
    const flakyAdapter: NodeAdapter = {
      async execute(input) {
        if (input.nodeId === "step-1" && firstStepAttempt) {
          firstStepAttempt = false;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return {
          provider: "test-adapter",
          model: input.node.model,
          promptText: "ok",
          completionPassed: true,
          when: { always: true },
          payload: { nodeId: input.nodeId },
        };
      },
    };

    const result = await runWorkflow(
      "restart-success",
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        defaultTimeoutMs: 10,
        maxStuckRestarts: 1,
        stuckRestartBackoffMs: 0,
      },
      flakyAdapter,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.session.status).toBe("completed");
    expect((result.value.session.restartEvents ?? []).length).toBe(1);
    expect((result.value.session.restartCounts ?? {})["step-1"]).toBe(1);
    const stepExecutions = result.value.session.nodeExecutions.filter((entry) => entry.nodeId === "step-1");
    expect(stepExecutions).toHaveLength(2);
    expect(stepExecutions[0]?.status).toBe("timed_out");
    expect(stepExecutions[1]?.status).toBe("succeeded");
  });

  test("fails with timeout when stuck restart budget is exhausted", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "restart-fail", false);

    const stuckAdapter: NodeAdapter = {
      async execute(input) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          provider: "test-adapter",
          model: input.node.model,
          promptText: "late",
          completionPassed: true,
          when: { always: true },
          payload: {},
        };
      },
    };

    const result = await runWorkflow(
      "restart-fail",
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        defaultTimeoutMs: 10,
        maxStuckRestarts: 0,
      },
      stuckAdapter,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(6);
    }
  });

  test("treats policy-blocked adapter failure as failed execution", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "policy-blocked", false);

    const blockedAdapter: NodeAdapter = {
      async execute(_input) {
        throw new AdapterExecutionError("policy_blocked", "blocked by provider policy");
      },
    };

    const result = await runWorkflow(
      "policy-blocked",
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
      },
      blockedAdapter,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(5);
    }
  });

  test("supports scenario mocks for deterministic branching outputs", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "scenario", false);

    const result = await runWorkflow("scenario", {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      mockScenario: {
        "oyakata-manager": {
          provider: "scenario-mock",
          when: { always: true },
          payload: { stage: "design" },
        },
        "step-1": {
          provider: "scenario-mock",
          when: { always: true },
          payload: { stage: "test-review" },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.session.status).toBe("completed");
    const stepExec = result.value.session.nodeExecutions.find((entry) => entry.nodeId === "step-1");
    expect(stepExec).toBeDefined();
    if (stepExec === undefined) {
      return;
    }
    const outputRaw = await readFile(path.join(stepExec.artifactDir, "output.json"), "utf8");
    const outputJson = JSON.parse(outputRaw) as { provider: string; payload: { stage: string } };
    expect(outputJson.provider).toBe("scenario-mock");
    expect(outputJson.payload.stage).toBe("test-review");
  });

  test("can rerun from a specific node based on a prior session", async () => {
    const root = await makeTempDir();
    await createWorkflowFixture(root, "rerun", false);
    const options = {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    };

    const first = await runWorkflow("rerun", options);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const rerun = await runWorkflow("rerun", {
      ...options,
      rerunFromSessionId: first.value.session.sessionId,
      rerunFromNodeId: "step-1",
    });
    expect(rerun.ok).toBe(true);
    if (!rerun.ok) {
      return;
    }

    expect(rerun.value.session.sessionId).not.toBe(first.value.session.sessionId);
    expect(rerun.value.session.nodeExecutions).toHaveLength(1);
    expect(rerun.value.session.nodeExecutions[0]?.nodeId).toBe("step-1");
    expect(rerun.value.session.startedAt.length).toBeGreaterThan(0);
  });

  test("manager schedules sub-workflow inputs based on inputSources dependencies", async () => {
    const root = await makeTempDir();
    await createSubWorkflowRuntimeFixture(root, "subworkflow-runtime");

    const result = await runWorkflow("subworkflow-runtime", {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      runtimeVariables: {
        humanInput: { topic: "demo" },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.session.status).toBe("completed");

    const executionOrder = result.value.session.nodeExecutions.map((entry) => entry.nodeId);
    expect(executionOrder.indexOf("a-output")).toBeGreaterThan(executionOrder.indexOf("a-input"));
    expect(executionOrder.indexOf("b-input")).toBeGreaterThan(executionOrder.indexOf("a-output"));
    expect(executionOrder.indexOf("b-output")).toBeGreaterThan(executionOrder.indexOf("b-input"));
  });
});
