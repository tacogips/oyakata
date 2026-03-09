import { describe, expect, test } from "vitest";

import type { WorkflowResponse } from "../../../src/shared/ui-contract";
import { workflowStateFromResponse } from "./editor-state-test-helpers";
import {
  emptyValidationState,
  syncSelectedNodeVariablesOrThrow,
  workflowStateAfterMutation,
  workflowStateWithNodeVariablesText,
  workflowStateWithSelectedNode,
} from "./editor-editing-state";

function makeWorkflowResponse(): WorkflowResponse {
  return {
    workflowName: "demo",
    revision: "rev-1",
    bundle: {
      workflow: {
        workflowId: "demo",
        description: "demo workflow",
        managerNodeId: "manager",
        defaults: {
          maxLoopIterations: 3,
          nodeTimeoutMs: 1000,
        },
        nodes: [
          {
            id: "manager",
            nodeFile: "node-manager.json",
            kind: "manager",
            completion: {
              type: "none",
            },
          },
          {
            id: "task-1",
            nodeFile: "node-task-1.json",
            kind: "task",
            completion: {
              type: "none",
            },
          },
        ],
        edges: [],
        subWorkflows: [],
        branching: {
          mode: "fan-out",
        },
      },
      workflowVis: {
        nodes: [
          { id: "manager", order: 0 },
          { id: "task-1", order: 1 },
        ],
      },
      nodePayloads: {
        manager: {
          id: "manager",
          model: "gpt-test",
          promptTemplate: "manager",
          variables: {},
        },
        "task-1": {
          id: "task-1",
          model: "gpt-test",
          promptTemplate: "task",
          variables: {
            topic: "demo",
          },
        },
      },
    },
    derivedVisualization: [
      {
        id: "manager",
        order: 0,
        indent: 0,
        color: "default",
      },
      {
        id: "task-1",
        order: 1,
        indent: 0,
        color: "default",
      },
    ],
  };
}

describe("editor-editing-state", () => {
  test("provides an empty validation state", () => {
    expect(emptyValidationState()).toEqual({
      validationIssues: [],
      validationSummary: "",
    });
  });

  test("re-selects node state after mutation when requested", () => {
    const workflowState = workflowStateFromResponse(
      makeWorkflowResponse(),
      "task-1",
    );
    const node = workflowState.editableBundle?.workflow.nodes.find(
      (entry) => entry.id === "task-1",
    );
    if (!node) {
      throw new Error("expected node");
    }

    node.kind = "branch-judge";

    const nextState = workflowStateAfterMutation(workflowState, {
      syncSelectedNode: true,
    });

    expect(nextState.selectedNode?.kind).toBe("branch-judge");
    expect(nextState.editableDerivedVisualization).toHaveLength(2);
  });

  test("updates the selected node and variables text", () => {
    const workflowState = workflowStateFromResponse(
      makeWorkflowResponse(),
      "manager",
    );

    const selectedState = workflowStateWithSelectedNode(
      workflowState,
      "task-1",
    );
    const nextState = workflowStateWithNodeVariablesText(
      selectedState,
      '{\n  "topic": "changed"\n}',
    );

    expect(nextState.selectedNodeId).toBe("task-1");
    expect(nextState.nodeVariablesText).toContain("changed");
  });

  test("syncs selected node variables text back into payloads", () => {
    const workflowState = workflowStateFromResponse(
      makeWorkflowResponse(),
      "task-1",
    );
    const nextState = syncSelectedNodeVariablesOrThrow(
      workflowStateWithNodeVariablesText(
        workflowState,
        '{\n  "topic": "updated"\n}',
      ),
    );

    expect(nextState.selectedNodePayload?.variables).toEqual({
      topic: "updated",
    });
  });

  test("throws when selected node variables text is invalid JSON", () => {
    const workflowState = workflowStateFromResponse(
      makeWorkflowResponse(),
      "task-1",
    );

    expect(() =>
      syncSelectedNodeVariablesOrThrow(
        workflowStateWithNodeVariablesText(workflowState, "{ invalid"),
      ),
    ).toThrow(/JSON Parse error/);
  });
});
