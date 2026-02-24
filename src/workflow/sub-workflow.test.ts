import { describe, expect, test } from "vitest";
import { planManagerSubWorkflowInputs } from "./sub-workflow";
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

function makeSession(overrides: Partial<WorkflowSessionState> = {}): WorkflowSessionState {
  return {
    sessionId: "sess-abc12345",
    workflowName: "wf",
    workflowId: "wf",
    status: "running",
    startedAt: "2026-02-24T00:00:00.000Z",
    queue: ["oyakata-manager"],
    nodeExecutionCounter: 0,
    nodeExecutionCounts: {},
    loopIterationCounts: {},
    restartCounts: {},
    restartEvents: [],
    transitions: [],
    nodeExecutions: [],
    runtimeVariables: {},
    ...overrides,
  };
}

describe("planManagerSubWorkflowInputs", () => {
  test("starts sub-workflow whose human-input source is available", () => {
    const workflow = makeWorkflow();
    const session = makeSession({
      runtimeVariables: { humanInput: { topic: "x" } },
    });
    const planned = planManagerSubWorkflowInputs({ workflow, session });
    expect(planned).toEqual(["a-input"]);
  });

  test("starts dependent sub-workflow only after source sub-workflow output succeeded", () => {
    const workflow = makeWorkflow();
    const session = makeSession({
      runtimeVariables: { humanInput: { topic: "x" } },
      nodeExecutions: [
        {
          nodeId: "a-input",
          nodeExecId: "exec-000001",
          status: "succeeded",
          artifactDir: "/tmp/a-input",
          startedAt: "2026-02-24T00:00:00.000Z",
          endedAt: "2026-02-24T00:00:01.000Z",
        },
        {
          nodeId: "a-output",
          nodeExecId: "exec-000002",
          status: "succeeded",
          artifactDir: "/tmp/a-output",
          startedAt: "2026-02-24T00:00:02.000Z",
          endedAt: "2026-02-24T00:00:03.000Z",
        },
      ],
    });
    const planned = planManagerSubWorkflowInputs({ workflow, session });
    expect(planned).toEqual(["b-input"]);
  });
});
