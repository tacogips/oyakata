import { describe, expect, test } from "vitest";
import { executeConversationRound } from "./conversation";
import type { WorkflowSessionState } from "./session";
import type { WorkflowJson } from "./types";

function makeWorkflow(): WorkflowJson {
  return {
    workflowId: "wf",
    description: "wf",
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
    subWorkflowConversations: [
      {
        id: "conv-1",
        participants: ["sw-a", "sw-b"],
        maxTurns: 3,
        stopWhen: "done",
      },
    ],
    nodes: [
      { id: "oyakata-manager", nodeFile: "node-oyakata-manager.json", kind: "manager", completion: { type: "none" } },
      { id: "a-input", nodeFile: "node-a-input.json", kind: "input", completion: { type: "none" } },
      { id: "a-output", nodeFile: "node-a-output.json", kind: "output", completion: { type: "none" } },
      { id: "b-input", nodeFile: "node-b-input.json", kind: "input", completion: { type: "none" } },
      { id: "b-output", nodeFile: "node-b-output.json", kind: "output", completion: { type: "none" } },
    ],
    edges: [],
    loops: [],
    branching: { mode: "fan-out" },
  };
}

function makeSession(): WorkflowSessionState {
  return {
    sessionId: "sess-abc12345",
    workflowName: "wf",
    workflowId: "wf",
    status: "running",
    startedAt: "2026-02-24T00:00:00.000Z",
    queue: [],
    nodeExecutionCounter: 0,
    nodeExecutionCounts: {},
    loopIterationCounts: {},
    restartCounts: {},
    restartEvents: [],
    transitions: [],
    nodeExecutions: [
      {
        nodeId: "a-output",
        nodeExecId: "exec-000001",
        status: "succeeded",
        artifactDir: "/tmp/a-output/exec-000001",
        startedAt: "2026-02-24T00:00:00.000Z",
        endedAt: "2026-02-24T00:00:01.000Z",
      },
    ],
    conversationTurns: [],
    runtimeVariables: {},
  };
}

describe("executeConversationRound", () => {
  test("routes a turn from latest sender output to next participant", async () => {
    const result = await executeConversationRound({
      workflow: makeWorkflow(),
      sessionId: "sess-abc12345",
      session: makeSession(),
    });

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.fromSubWorkflowId).toBe("sw-a");
    expect(result.turns[0]?.toSubWorkflowId).toBe("sw-b");
    expect(result.turns[0]?.outputRef["nodeExecId"]).toBe("exec-000001");
  });

  test("stops when stopWhen condition evaluates true", async () => {
    const workflow = {
      ...makeWorkflow(),
      subWorkflowConversations: [
        {
          id: "conv-1",
          participants: ["sw-a", "sw-b"],
          maxTurns: 3,
          stopWhen: "has_sender_output",
        },
      ],
    };

    const result = await executeConversationRound({
      workflow,
      sessionId: "sess-abc12345",
      session: makeSession(),
    });

    expect(result.status).toBe("stopped");
    expect(result.turns).toHaveLength(0);
  });
});
