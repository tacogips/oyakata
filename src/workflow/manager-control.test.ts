import { describe, expect, test } from "vitest";
import {
  assertCommunicationInManagerScope,
  parseManagerControlActions,
  parseManagerControlPayload,
} from "./manager-control";
import type { WorkflowJson } from "./types";

function makeWorkflow(): WorkflowJson {
  return {
    workflowId: "wf",
    description: "wf",
    defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
    managerNodeId: "divedra-manager",
    subWorkflows: [
      {
        id: "sw-a",
        description: "A",
        managerNodeId: "a-manager",
        inputNodeId: "a-input",
        outputNodeId: "a-output",
        nodeIds: ["a-manager", "a-input", "a-output"],
        inputSources: [],
      },
    ],
    nodes: [
      {
        id: "divedra-manager",
        nodeFile: "node-divedra-manager.json",
        kind: "root-manager",
        completion: { type: "none" },
      },
      {
        id: "a-manager",
        nodeFile: "node-a-manager.json",
        kind: "subworkflow-manager",
        completion: { type: "none" },
      },
      {
        id: "a-input",
        nodeFile: "node-a-input.json",
        kind: "input",
        completion: { type: "none" },
        execution: {
          mode: "optional",
          decisionBy: "owning-manager",
        },
      },
      {
        id: "a-output",
        nodeFile: "node-a-output.json",
        kind: "output",
        completion: { type: "none" },
      },
      {
        id: "step-1",
        nodeFile: "node-step-1.json",
        kind: "task",
        completion: { type: "none" },
        execution: {
          mode: "optional",
          decisionBy: "owning-manager",
        },
      },
    ],
    edges: [],
    loops: [],
    branching: { mode: "fan-out" },
  };
}

function makeRoleWorkflow(): WorkflowJson {
  return {
    workflowId: "wf-role",
    description: "role workflow",
    defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
    managerNodeId: "divedra-manager",
    workflowCalls: [
      {
        id: "call-review",
        workflowId: "review-target",
        callerNodeId: "step-1",
        resultNodeId: "step-2",
      },
    ],
    subWorkflows: [],
    nodes: [
      {
        id: "divedra-manager",
        nodeFile: "node-divedra-manager.json",
        role: "manager",
      },
      {
        id: "step-1",
        nodeFile: "node-step-1.json",
        role: "worker",
        execution: {
          mode: "optional",
          decisionBy: "owning-manager",
        },
      },
      {
        id: "step-2",
        nodeFile: "node-step-2.json",
        role: "worker",
      },
    ],
    edges: [],
    loops: [],
    branching: { mode: "fan-out" },
  };
}

describe("parseManagerControlPayload", () => {
  test("returns null when managerControl is absent", () => {
    expect(
      parseManagerControlPayload({ marker: "plain" }, makeWorkflow(), {
        managerNodeId: "divedra-manager",
        managerKind: "root-manager",
      }),
    ).toBeNull();
  });

  test("parses supported manager control actions", () => {
    const parsed = parseManagerControlPayload(
      {
        managerControl: {
          actions: [{ type: "retry-step", stepId: "a-manager" }],
        },
      },
      makeWorkflow(),
      {
        managerNodeId: "divedra-manager",
        managerKind: "root-manager",
      },
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.retryStepIds).toEqual(["a-manager"]);
    expect(parsed?.actions[0]).toEqual({
      type: "retry-step",
      stepId: "a-manager",
    });
    expect(parsed?.replayCommunicationIds).toEqual([]);
  });

  test("accepts role-authored workflow managers as root-manager control scope", () => {
    const baseWorkflow = makeWorkflow();
    const workflow = {
      ...baseWorkflow,
      nodes: baseWorkflow.nodes.map((node) =>
        node.id === "divedra-manager"
          ? {
              id: "divedra-manager",
              nodeFile: "node-divedra-manager.json",
              role: "manager" as const,
            }
          : node,
      ),
    };

    const parsed = parseManagerControlPayload(
      {
        managerControl: {
          actions: [{ type: "planner-note" }],
        },
      },
      workflow,
      {
        managerNodeId: "divedra-manager",
        managerKind: undefined,
        managerRole: "manager",
      },
    );

    expect(parsed?.actions).toEqual([{ type: "planner-note" }]);
  });

  test("rejects removed structural action types in payloads", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [
              { type: "start-sub-workflow", subWorkflowId: "call-review" },
            ],
          },
        },
        makeRoleWorkflow(),
        {
          managerNodeId: "divedra-manager",
          managerKind: undefined,
          managerRole: "manager",
        },
      ),
    ).toThrow("is not supported");
  });

  test("parses subworkflow-manager retry actions", () => {
    const parsed = parseManagerControlPayload(
      {
        managerControl: {
          actions: [{ type: "retry-step", stepId: "a-input" }],
        },
      },
      makeWorkflow(),
      {
        managerNodeId: "a-manager",
        managerKind: "subworkflow-manager",
      },
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.retryStepIds).toEqual(["a-input"]);
    expect(parsed?.replayCommunicationIds).toEqual([]);
  });

  test("parses planner-note and replay-communication action variants", () => {
    const parsed = parseManagerControlActions(
      [
        { type: "planner-note" },
        {
          type: "replay-communication",
          communicationId: "comm-000123",
          reason: "rerun after inspection",
        },
      ],
      makeWorkflow(),
      {
        managerNodeId: "divedra-manager",
        managerKind: "root-manager",
      },
    );

    expect(parsed.actions).toHaveLength(2);
    expect(parsed.retryStepIds).toEqual([]);
    expect(parsed.replayCommunicationIds).toEqual(["comm-000123"]);
  });

  test("trims manager-control identifiers and optional reason text", () => {
    const parsed = parseManagerControlActions(
      [
        { type: "retry-step", stepId: " a-input " },
        {
          type: "replay-communication",
          communicationId: " comm-000123 ",
          reason: " rerun after inspection ",
        },
        {
          type: "skip-optional-step",
          stepId: " step-1 ",
          reason: "   ",
        },
      ],
      makeWorkflow(),
      {
        managerNodeId: "divedra-manager",
        managerKind: "root-manager",
      },
    );

    expect(parsed.retryStepIds).toEqual(["a-input"]);
    expect(parsed.replayCommunicationIds).toEqual(["comm-000123"]);
    expect(parsed.skipOptionalStepIds).toEqual(["step-1"]);
    expect(parsed.actions[1]).toEqual({
      type: "replay-communication",
      communicationId: "comm-000123",
      reason: "rerun after inspection",
    });
    expect(parsed.actions[2]).toEqual({
      type: "skip-optional-step",
      stepId: "step-1",
    });
  });

  test("parses execute-optional-step and skip-optional-step action variants", () => {
    const parsed = parseManagerControlActions(
      [
        { type: "execute-optional-step", stepId: "step-1" },
        {
          type: "skip-optional-step",
          stepId: "step-1",
          reason: "not needed this run",
        },
      ],
      makeWorkflow(),
      {
        managerNodeId: "divedra-manager",
        managerKind: "root-manager",
      },
    );

    expect(parsed.executeOptionalStepIds).toEqual(["step-1"]);
    expect(parsed.skipOptionalStepIds).toEqual(["step-1"]);
  });

  test("rejects removal-bound retry-node and optional-node action types", () => {
    expect(() =>
      parseManagerControlActions(
        [{ type: "retry-node", nodeId: "a-manager" }],
        makeWorkflow(),
        {
          managerNodeId: "divedra-manager",
          managerKind: "root-manager",
        },
      ),
    ).toThrow("is not supported");

    expect(() =>
      parseManagerControlActions(
        [{ type: "execute-optional-node", nodeId: "step-1" }],
        makeWorkflow(),
        {
          managerNodeId: "divedra-manager",
          managerKind: "root-manager",
        },
      ),
    ).toThrow("is not supported");
  });

  test("rejects start-sub-workflow as an unsupported action type", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "start-sub-workflow", subWorkflowId: "sw-a" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "subworkflow-manager",
        },
      ),
    ).toThrow("is not supported");
  });

  test("rejects unknown referenced ids", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "retry-step", stepId: "missing" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "subworkflow-manager",
        },
      ),
    ).toThrow("does not exist");
  });

  test("rejects replay-communication with a non-string reason", () => {
    expect(() =>
      parseManagerControlActions(
        [
          {
            type: "replay-communication",
            communicationId: "comm-000001",
            reason: 123,
          },
        ],
        makeWorkflow(),
        {
          managerNodeId: "divedra-manager",
          managerKind: "root-manager",
        },
      ),
    ).toThrow("reason must be a string");
  });

  test("rejects whitespace-only control identifiers", () => {
    expect(() =>
      parseManagerControlActions(
        [{ type: "retry-step", stepId: "   " }],
        makeWorkflow(),
        {
          managerNodeId: "divedra-manager",
          managerKind: "root-manager",
        },
      ),
    ).toThrow("stepId must be a non-empty string");

    expect(() =>
      parseManagerControlActions(
        [{ type: "replay-communication", communicationId: "   " }],
        makeWorkflow(),
        {
          managerNodeId: "divedra-manager",
          managerKind: "root-manager",
        },
      ),
    ).toThrow("communicationId must be a non-empty string");
  });

  test("rejects deliver-to-child-input as an unsupported action type", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [
              { type: "deliver-to-child-input", inputNodeId: "a-input" },
            ],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "divedra-manager",
          managerKind: "root-manager",
        },
      ),
    ).toThrow("is not supported");
  });

  test("rejects subworkflow-manager retries outside the owned sub-workflow scope", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "retry-step", stepId: "divedra-manager" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "subworkflow-manager",
        },
      ),
    ).toThrow("must belong to sub-workflow 'sw-a'");
  });

  test("accepts root-manager retry-step for nodes inside a structural sub-workflow", () => {
    const parsed = parseManagerControlPayload(
      {
        managerControl: {
          actions: [{ type: "retry-step", stepId: "a-input" }],
        },
      },
      makeWorkflow(),
      {
        managerNodeId: "divedra-manager",
        managerKind: "root-manager",
      },
    );
    expect(parsed?.retryStepIds).toEqual(["a-input"]);
  });

  test("rejects manager self-retry", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "retry-step", stepId: "a-manager" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "subworkflow-manager",
        },
      ),
    ).toThrow("cannot target the manager node itself");
  });

  test("rejects optional-node decisions for non-optional or out-of-scope nodes", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [
              { type: "execute-optional-step", stepId: "a-output" },
            ],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "subworkflow-manager",
        },
      ),
    ).toThrow("workflow execution.mode 'optional'");

    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "skip-optional-step", stepId: "a-input" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "divedra-manager",
          managerKind: "root-manager",
        },
      ),
    ).toThrow("use the owning subworkflow-manager instead");
  });

  test("enforces communication replay scope with legacy boundary fallback", () => {
    const workflow = makeWorkflow();

    expect(() =>
      assertCommunicationInManagerScope(
        {
          workflowId: "wf",
          workflowExecutionId: "sess-1",
          communicationId: "comm-legacy-sub",
          fromNodeId: "a-manager",
          toNodeId: "a-input",
          routingScope: "intra-sub-workflow",
          sourceNodeExecId: "exec-1",
          payloadRef: {
            workflowId: "wf",
            workflowExecutionId: "sess-1",
            outputNodeId: "a-manager",
            nodeExecId: "exec-1",
            artifactDir: "/tmp/out",
          },
          deliveryKind: "edge-transition",
          transitionWhen: "legacy",
          status: "delivered",
          deliveryAttemptIds: ["attempt-000001"],
          activeDeliveryAttemptId: "attempt-000001",
          createdAt: "2026-03-15T00:00:00.000Z",
          artifactDir: "/tmp/comm",
        },
        workflow,
        {
          managerNodeId: "a-manager",
          managerKind: "subworkflow-manager",
        },
        "test replay",
      ),
    ).not.toThrow();

    expect(() =>
      assertCommunicationInManagerScope(
        {
          workflowId: "wf",
          workflowExecutionId: "sess-1",
          communicationId: "comm-root",
          fromNodeId: "divedra-manager",
          toNodeId: "step-1",
          routingScope: "intra-sub-workflow",
          sourceNodeExecId: "exec-2",
          payloadRef: {
            workflowId: "wf",
            workflowExecutionId: "sess-1",
            outputNodeId: "divedra-manager",
            nodeExecId: "exec-2",
            artifactDir: "/tmp/out",
          },
          deliveryKind: "edge-transition",
          transitionWhen: "root",
          status: "delivered",
          deliveryAttemptIds: ["attempt-000001"],
          activeDeliveryAttemptId: "attempt-000001",
          createdAt: "2026-03-15T00:01:00.000Z",
          artifactDir: "/tmp/comm",
        },
        workflow,
        {
          managerNodeId: "a-manager",
          managerKind: "subworkflow-manager",
        },
        "test replay",
      ),
    ).toThrow("must stay within sub-workflow 'sw-a'");

    expect(() =>
      assertCommunicationInManagerScope(
        {
          workflowId: "wf",
          workflowExecutionId: "sess-1",
          communicationId: "comm-sub",
          fromNodeId: "a-manager",
          toNodeId: "a-input",
          routingScope: "intra-sub-workflow",
          sourceNodeExecId: "exec-3",
          payloadRef: {
            workflowId: "wf",
            workflowExecutionId: "sess-1",
            outputNodeId: "a-manager",
            nodeExecId: "exec-3",
            artifactDir: "/tmp/out",
          },
          deliveryKind: "edge-transition",
          transitionWhen: "sub",
          status: "delivered",
          deliveryAttemptIds: ["attempt-000001"],
          activeDeliveryAttemptId: "attempt-000001",
          createdAt: "2026-03-15T00:02:00.000Z",
          artifactDir: "/tmp/comm",
        },
        workflow,
        {
          managerNodeId: "divedra-manager",
          managerKind: "root-manager",
        },
        "test replay",
      ),
    ).toThrow("outside root-manager scope");
  });
});
