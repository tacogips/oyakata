import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AdapterExecutionError, DeterministicNodeAdapter, ScenarioNodeAdapter } from "./adapter";
import type { NodeAdapter } from "./adapter";
import { runWorkflow } from "./engine";

const tempDirs: string[] = [];
const deterministicAdapter = new DeterministicNodeAdapter();

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
          { id: "oyakata-manager", order: 0 },
          { id: "step-1", order: 1 },
          { id: "done", order: 2 },
        ]
      : [
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
        managerNodeId: "a-manager",
        inputNodeId: "a-input",
        outputNodeId: "a-output",
        nodeIds: ["a-manager", "a-input", "a-output"],
        inputSources: [{ type: "human-input" }],
      },
      {
        id: "sw-b",
        description: "B",
        managerNodeId: "b-manager",
        inputNodeId: "b-input",
        outputNodeId: "b-output",
        nodeIds: ["b-manager", "b-input", "b-output"],
        inputSources: [{ type: "sub-workflow-output", subWorkflowId: "sw-a" }],
      },
    ],
    subWorkflowConversations: [
      {
        id: "conv-1",
        participants: ["sw-a", "sw-b"],
        maxTurns: 3,
        stopWhen: "done",
      },
    ],
    nodes: [
      { id: "oyakata-manager", kind: "root-manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
      { id: "a-manager", kind: "sub-manager", nodeFile: "node-a-manager.json", completion: { type: "none" } },
      { id: "a-input", kind: "input", nodeFile: "node-a-input.json", completion: { type: "none" } },
      { id: "a-output", kind: "output", nodeFile: "node-a-output.json", completion: { type: "none" } },
      { id: "b-manager", kind: "sub-manager", nodeFile: "node-b-manager.json", completion: { type: "none" } },
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
      { id: "oyakata-manager", order: 0 },
      { id: "a-manager", order: 1 },
      { id: "a-input", order: 2 },
      { id: "a-output", order: 3 },
      { id: "b-manager", order: 4 },
      { id: "b-input", order: 5 },
      { id: "b-output", order: 6 },
    ],
  });

  await writeJson(path.join(workflowDir, "node-oyakata-manager.json"), {
    id: "oyakata-manager",
    model: "tacogips/codex-agent",
    promptTemplate: "manager",
    variables: {},
  });
  await writeJson(path.join(workflowDir, "node-a-manager.json"), {
    id: "a-manager",
    model: "tacogips/codex-agent",
    promptTemplate: "a-manager",
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
  await writeJson(path.join(workflowDir, "node-b-manager.json"), {
    id: "b-manager",
    model: "tacogips/codex-agent",
    promptTemplate: "b-manager",
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
    }, deterministicAdapter);

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
        workflowExecutionId: string;
      }[];
      upstreamCommunications: readonly string[];
    };
    expect(inputJson.promptText).toContain("B");
    expect(inputJson.upstreamOutputRefs.length).toBe(1);
    expect(inputJson.upstreamOutputRefs[0]?.fromNodeId).toBe("oyakata-manager");
    expect(inputJson.upstreamOutputRefs[0]?.workflowId).toBe("linear");
    expect(inputJson.upstreamOutputRefs[0]?.workflowExecutionId).toBe(result.value.session.sessionId);
    expect(inputJson.upstreamCommunications).toEqual(["comm-000001"]);

    const communicationMessageRaw = await readFile(
      path.join(
        root,
        "artifacts",
        "linear",
        "executions",
        result.value.session.sessionId,
        "communications",
        "comm-000001",
        "message.json",
      ),
      "utf8",
    );
    const communicationMessageJson = JSON.parse(communicationMessageRaw) as {
      workflowExecutionId: string;
      communicationId: string;
      fromNodeId: string;
      toNodeId: string;
    };
    expect(communicationMessageJson.workflowExecutionId).toBe(result.value.session.sessionId);
    expect(communicationMessageJson.communicationId).toBe("comm-000001");
    expect(communicationMessageJson.fromNodeId).toBe("oyakata-manager");
    expect(communicationMessageJson.toNodeId).toBe("step-1");

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
    }, deterministicAdapter);

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
    }, deterministicAdapter);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(3);
      expect(result.error.message).toContain("input assembly failed");
    }
  });

  test("fails deterministically when an upstream communication output artifact is corrupted", async () => {
    const root = await makeTempDir();
    const workflowName = "corrupt-upstream-output";
    await createWorkflowFixture(root, workflowName, false);

    const options = {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    };

    const paused = await runWorkflow(workflowName, {
      ...options,
      sessionId: "sess-corrupt-upstream",
      maxSteps: 1,
    }, deterministicAdapter);
    expect(paused.ok).toBe(true);
    if (!paused.ok) {
      return;
    }
    expect(paused.value.session.status).toBe("paused");

    const managerExec = paused.value.session.nodeExecutions.find((entry) => entry.nodeId === "oyakata-manager");
    expect(managerExec).toBeDefined();
    if (managerExec === undefined) {
      return;
    }
    await writeFile(path.join(managerExec.artifactDir, "output.json"), "\"corrupted\"\n", "utf8");

    const resumed = await runWorkflow(workflowName, {
      ...options,
      resumeSessionId: paused.value.session.sessionId,
    }, deterministicAdapter);

    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.error.exitCode).toBe(1);
      expect(resumed.error.message).toContain("failed to resolve upstream communication");
      expect(resumed.error.message).toContain("comm-000001");
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
    const stepExecutions = result.value.session.nodeExecutions.filter((entry) => entry.nodeId === "step-1");
    expect(stepExecutions).toHaveLength(3);
    const upstreamCommunications = await Promise.all(
      stepExecutions.map(async (execution) => {
        const inputRaw = await readFile(path.join(execution.artifactDir, "input.json"), "utf8");
        const inputJson = JSON.parse(inputRaw) as { upstreamCommunications: readonly string[] };
        return inputJson.upstreamCommunications;
      }),
    );
    expect(upstreamCommunications).toEqual([["comm-000001"], ["comm-000002"], ["comm-000003"]]);
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
    const sessionId = "sess-restart-fail";

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
        sessionId,
        defaultTimeoutMs: 10,
        maxStuckRestarts: 0,
      },
      stuckAdapter,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.exitCode).toBe(6);
      const timedOutSessionRaw = await readFile(path.join(root, "sessions", `${sessionId}.json`), "utf8");
      const timedOutSession = JSON.parse(timedOutSessionRaw) as {
        communications: readonly { status: string; fromNodeId: string; toNodeId: string }[];
      };
      const timedOutNodeOutgoing = timedOutSession.communications.filter((entry) => entry.fromNodeId === "step-1");
      expect(timedOutNodeOutgoing).toEqual([]);
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

    const first = await runWorkflow("rerun", options, deterministicAdapter);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const rerun = await runWorkflow("rerun", {
      ...options,
      rerunFromSessionId: first.value.session.sessionId,
      rerunFromNodeId: "step-1",
    }, deterministicAdapter);
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
    }, deterministicAdapter);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.session.status).toBe("completed");

    const executionOrder = result.value.session.nodeExecutions.map((entry) => entry.nodeId);
    expect(executionOrder.indexOf("a-manager")).toBeGreaterThan(executionOrder.indexOf("oyakata-manager"));
    expect(executionOrder.indexOf("a-input")).toBeGreaterThan(executionOrder.indexOf("a-manager"));
    expect(executionOrder.indexOf("a-output")).toBeGreaterThan(executionOrder.indexOf("a-input"));
    expect(executionOrder.indexOf("b-manager")).toBeGreaterThan(executionOrder.indexOf("a-output"));
    expect(executionOrder.indexOf("b-input")).toBeGreaterThan(executionOrder.indexOf("a-output"));
    expect(executionOrder.indexOf("b-input")).toBeGreaterThan(executionOrder.indexOf("b-manager"));
    expect(executionOrder.indexOf("b-output")).toBeGreaterThan(executionOrder.indexOf("b-input"));
    expect((result.value.session.conversationTurns ?? []).length).toBeGreaterThan(0);
    expect(result.value.session.conversationTurns?.[0]?.fromSubWorkflowId).toBe("sw-a");
    expect(result.value.session.conversationTurns?.[0]?.toSubWorkflowId).toBe("sw-b");
    expect(result.value.session.conversationTurns?.[0]?.communicationId).toMatch(/^comm-\d{6}$/);

    const bInputExec = result.value.session.nodeExecutions.find((entry) => entry.nodeId === "b-input");
    expect(bInputExec).toBeDefined();
    if (bInputExec === undefined) {
      return;
    }
    const bInputRaw = await readFile(path.join(bInputExec.artifactDir, "input.json"), "utf8");
    const bInputJson = JSON.parse(bInputRaw) as {
      upstreamOutputRefs: readonly { subWorkflowId?: string; outputNodeId: string }[];
      upstreamCommunications: readonly string[];
    };
    expect(bInputJson.upstreamOutputRefs.some((entry) => entry.subWorkflowId === "sw-b")).toBe(true);
    expect(bInputJson.upstreamOutputRefs.some((entry) => entry.outputNodeId === "b-manager")).toBe(true);
    expect(bInputJson.upstreamCommunications.length).toBeGreaterThan(0);

    const aOutputExec = result.value.session.nodeExecutions.find((entry) => entry.nodeId === "a-output");
    expect(aOutputExec).toBeDefined();
    if (aOutputExec === undefined) {
      return;
    }
    const aOutputHandoffRaw = await readFile(path.join(aOutputExec.artifactDir, "handoff.json"), "utf8");
    const aOutputHandoffJson = JSON.parse(aOutputHandoffRaw) as {
      outputRef: { subWorkflowId?: string };
    };
    expect(aOutputHandoffJson.outputRef.subWorkflowId).toBe("sw-a");

    const aOutputCommitMessage = await readFile(path.join(aOutputExec.artifactDir, "commit-message.txt"), "utf8");
    expect(aOutputCommitMessage).toContain("Subworkflow-ID: sw-a");

    const conversationCommunication = result.value.session.communications.find(
      (entry) => entry.deliveryKind === "conversation-turn",
    );
    expect(conversationCommunication).toBeDefined();
    expect(conversationCommunication?.fromSubWorkflowId).toBe("sw-a");
    expect(conversationCommunication?.toSubWorkflowId).toBe("sw-b");
    expect(conversationCommunication?.payloadRef.outputNodeId).toBe("a-output");

    const parentToSubWorkflowCommunication = result.value.session.communications.find(
      (entry) => entry.routingScope === "parent-to-sub-workflow" && entry.toNodeId === "a-manager",
    );
    expect(parentToSubWorkflowCommunication).toBeDefined();
  });

  test("does not duplicate a sub-workflow manager handoff when a normal edge already targets that manager", async () => {
    const root = await makeTempDir();
    const workflowName = "subworkflow-dedup-manager-handoff";
    await createSubWorkflowRuntimeFixture(root, workflowName);

    const workflowPath = path.join(root, workflowName, "workflow.json");
    const workflowRaw = await readFile(workflowPath, "utf8");
    const workflowJson = JSON.parse(workflowRaw) as {
      edges: Array<{ from: string; to: string; when: string }>;
    };
    workflowJson.edges.unshift({ from: "oyakata-manager", to: "a-manager", when: "always" });
    await writeJson(workflowPath, workflowJson);

    const result = await runWorkflow(workflowName, {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
      maxSteps: 1,
      runtimeVariables: {
        humanInput: { topic: "demo" },
      },
    }, deterministicAdapter);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.session.status).toBe("paused");

    const rootToAManagerCommunications = result.value.session.communications.filter(
      (entry) => entry.fromNodeId === "oyakata-manager" && entry.toNodeId === "a-manager",
    );

    expect(rootToAManagerCommunications).toHaveLength(1);
    expect(rootToAManagerCommunications[0]?.routingScope).toBe("intra-sub-workflow");
  });

  test("fails deterministically when a conversation sender output artifact is corrupted", async () => {
    const root = await makeTempDir();
    const workflowName = "subworkflow-corrupt-conversation";
    await createSubWorkflowRuntimeFixture(root, workflowName);

    const options = {
      workflowRoot: root,
      artifactRoot: path.join(root, "artifacts"),
      sessionStoreRoot: path.join(root, "sessions"),
    };

    const paused = await runWorkflow(workflowName, {
      ...options,
      sessionId: "sess-corrupt-conversation",
      runtimeVariables: {
        humanInput: { topic: "demo" },
      },
      maxSteps: 4,
    }, deterministicAdapter);
    expect(paused.ok).toBe(true);
    if (!paused.ok) {
      return;
    }
    expect(paused.value.session.status).toBe("paused");

    const senderExec = paused.value.session.nodeExecutions.find((entry) => entry.nodeId === "a-output");
    expect(senderExec).toBeDefined();
    if (senderExec === undefined) {
      return;
    }
    await writeFile(path.join(senderExec.artifactDir, "output.json"), "\"corrupted\"\n", "utf8");

    const resumed = await runWorkflow(workflowName, {
      ...options,
      resumeSessionId: paused.value.session.sessionId,
    }, deterministicAdapter);

    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.error.exitCode).toBe(1);
      expect(resumed.error.message).toContain("failed to resolve upstream communication");
      expect(resumed.error.message).toContain("comm-");
      expect(resumed.error.message).toContain("oyakata-manager");
      expect(resumed.error.message).toContain("a-output");
    }
  });

  test("replays multi-turn sub-workflow conversations through manager mailboxes", async () => {
    const root = await makeTempDir();
    const workflowName = "subworkflow-multi-turn-conversation";
    await createSubWorkflowRuntimeFixture(root, workflowName);

    const result = await runWorkflow(
      workflowName,
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        sessionId: "sess-multi-turn-conversation",
        runtimeVariables: { humanInput: { topic: "ping-pong" } },
      },
      deterministicAdapter,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const conversationTurns = result.value.session.conversationTurns ?? [];
    expect(conversationTurns).toHaveLength(3);
    expect(conversationTurns.map((entry) => `${entry.fromSubWorkflowId}->${entry.toSubWorkflowId}`)).toEqual([
      "sw-a->sw-b",
      "sw-b->sw-a",
      "sw-a->sw-b",
    ]);

    const aInputExecutions = result.value.session.nodeExecutions.filter((entry) => entry.nodeId === "a-input");
    const bInputExecutions = result.value.session.nodeExecutions.filter((entry) => entry.nodeId === "b-input");
    expect(aInputExecutions).toHaveLength(2);
    expect(bInputExecutions).toHaveLength(2);
  });

  test("sub-manager forwards its own output to the child input", async () => {
    const root = await makeTempDir();
    const workflowName = "subworkflow-manager-forwarding";
    await createSubWorkflowRuntimeFixture(root, workflowName);
    await writeJson(path.join(root, workflowName, "node-b-input.json"), {
      id: "b-input",
      model: "tacogips/codex-agent",
      promptTemplate: "b-input",
      variables: {},
      argumentsTemplate: { routed: { marker: "" } },
      argumentBindings: [
        {
          targetPath: "routed.marker",
          source: "node-output",
          sourceRef: "b-manager",
          sourcePath: "output.payload.marker",
          required: true,
        },
      ],
    });

    const result = await runWorkflow(
      workflowName,
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        sessionId: "sess-manager-forwarding",
        runtimeVariables: { humanInput: { topic: "ping-pong" } },
      },
      new ScenarioNodeAdapter({
        "a-output": { payload: { marker: "from-a-output" } },
        "b-manager": { payload: { marker: "from-b-manager" } },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const bInputExecutions = result.value.session.nodeExecutions.filter((entry) => entry.nodeId === "b-input");
    expect(bInputExecutions.length).toBeGreaterThan(0);
    const firstBInputExecution = bInputExecutions[0];
    expect(firstBInputExecution).toBeDefined();
    if (firstBInputExecution === undefined) {
      return;
    }

    const inputRaw = await readFile(path.join(firstBInputExecution.artifactDir, "input.json"), "utf8");
    const inputJson = JSON.parse(inputRaw) as {
      arguments: { routed: { marker: string } };
    };
    expect(inputJson.arguments.routed.marker).toBe("from-b-manager");
  });

  test("exposes conversation routing metadata in transcript bindings", async () => {
    const root = await makeTempDir();
    const workflowName = "subworkflow-transcript-metadata";
    await createSubWorkflowRuntimeFixture(root, workflowName);
    await writeJson(path.join(root, workflowName, "node-b-manager.json"), {
      id: "b-manager",
      model: "tacogips/codex-agent",
      promptTemplate: "b-manager",
      variables: {},
      argumentsTemplate: {},
      argumentBindings: [
        {
          targetPath: "transcript",
          source: "conversation-transcript",
        },
      ],
    });

    const result = await runWorkflow(
      workflowName,
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        sessionId: "sess-transcript-metadata",
        runtimeVariables: { humanInput: { topic: "ping-pong" } },
      },
      deterministicAdapter,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const bManagerExecutions = result.value.session.nodeExecutions.filter((entry) => entry.nodeId === "b-manager");
    expect(bManagerExecutions.length).toBeGreaterThan(0);
    const bManagerExec = bManagerExecutions[0];
    expect(bManagerExec).toBeDefined();
    if (bManagerExec === undefined) {
      return;
    }

    const inputRaw = await readFile(path.join(bManagerExec.artifactDir, "input.json"), "utf8");
    const inputJson = JSON.parse(inputRaw) as {
      arguments: {
        transcript: readonly {
          fromManagerNodeId: string;
          toManagerNodeId: string;
          communicationId: string;
        }[];
      };
    };

    expect(inputJson.arguments.transcript.length).toBeGreaterThan(0);
    expect(inputJson.arguments.transcript[0]?.fromManagerNodeId).toBe("a-manager");
    expect(inputJson.arguments.transcript[0]?.toManagerNodeId).toBe("b-manager");
    expect(inputJson.arguments.transcript[0]?.communicationId).toMatch(/^comm-\d{6}$/);
  });

  test("routes conversation turns into a sub-workflow that reuses the root manager", async () => {
    const root = await makeTempDir();
    const workflowName = "subworkflow-root-manager-conversation";
    await createSubWorkflowRuntimeFixture(root, workflowName);

    const workflowPath = path.join(root, workflowName, "workflow.json");
    const workflowJson = JSON.parse(await readFile(workflowPath, "utf8")) as {
      subWorkflows: Array<Record<string, unknown>>;
      nodes: Array<{ id: string }>;
    };
    workflowJson.subWorkflows[1] = {
      ...workflowJson.subWorkflows[1],
      managerNodeId: undefined,
      nodeIds: ["b-input", "b-output"],
    };
    workflowJson.nodes = workflowJson.nodes.filter((node) => node.id !== "b-manager");
    await writeJson(workflowPath, workflowJson);

    const workflowVisPath = path.join(root, workflowName, "workflow-vis.json");
    const workflowVisJson = JSON.parse(await readFile(workflowVisPath, "utf8")) as {
      nodes: Array<{ id: string; order: number }>;
    };
    workflowVisJson.nodes = workflowVisJson.nodes
      .filter((node) => node.id !== "b-manager")
      .map((node, index) => ({ ...node, order: index }));
    await writeJson(workflowVisPath, workflowVisJson);

    const result = await runWorkflow(
      workflowName,
      {
        workflowRoot: root,
        artifactRoot: path.join(root, "artifacts"),
        sessionStoreRoot: path.join(root, "sessions"),
        sessionId: "sess-root-manager-conversation",
        runtimeVariables: { humanInput: { topic: "ping-pong" } },
      },
      deterministicAdapter,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const bInputExecutions = result.value.session.nodeExecutions.filter((entry) => entry.nodeId === "b-input");
    expect(bInputExecutions).toHaveLength(2);

    const toBConversationTurns = (result.value.session.conversationTurns ?? []).filter(
      (entry) => entry.toSubWorkflowId === "sw-b",
    );
    expect(toBConversationTurns.length).toBeGreaterThan(0);
    expect(toBConversationTurns[0]?.toManagerNodeId).toBe("oyakata-manager");

    const forwardedToBInput = result.value.session.communications.filter(
      (entry) =>
        entry.fromNodeId === "oyakata-manager" &&
        entry.toNodeId === "b-input" &&
        entry.toSubWorkflowId === "sw-b",
    );
    expect(forwardedToBInput.length).toBeGreaterThan(0);
  });
});
