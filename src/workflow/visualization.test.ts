import { describe, expect, test } from "vitest";
import { deriveWorkflowVisualization } from "./visualization";
import type { WorkflowJson, WorkflowVisJson } from "./types";

function makeBaseWorkflow(nodes: readonly string[], edges: readonly { from: string; to: string; when: string }[]): WorkflowJson {
  return {
    workflowId: "wf",
    description: "wf",
    defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
    managerNodeId: "oyakata-manager",
    subWorkflows: [],
    nodes: nodes.map((id) => ({
      id,
      nodeFile: `node-${id}.json`,
      kind: id === "oyakata-manager" ? "manager" : "task",
      completion: { type: "none" },
    })),
    edges,
    loops: [],
    branching: { mode: "fan-out" },
  };
}

function makeVis(nodeIds: readonly string[]): WorkflowVisJson {
  return {
    nodes: nodeIds.map((id, index) => ({ id, order: index })),
  };
}

describe("deriveWorkflowVisualization", () => {
  test("keeps top-level linear chain at base indent", () => {
    const workflow = makeBaseWorkflow(
      ["oyakata-manager", "design", "implement"],
      [
        { from: "oyakata-manager", to: "design", when: "always" },
        { from: "design", to: "implement", when: "always" },
      ],
    );

    const derived = deriveWorkflowVisualization({
      workflow,
      workflowVis: makeVis(["oyakata-manager", "design", "implement"]),
    });

    expect(derived).toEqual([
      { id: "oyakata-manager", order: 0, indent: 0, color: "default" },
      { id: "design", order: 1, indent: 0, color: "default" },
      { id: "implement", order: 2, indent: 0, color: "default" },
    ]);
  });

  test("derives loop color and returns exit target to base depth", () => {
    const workflow = {
      ...makeBaseWorkflow(
        ["oyakata-manager", "implement", "test-review", "done"],
        [
          { from: "oyakata-manager", to: "implement", when: "always" },
          { from: "implement", to: "test-review", when: "always" },
          { from: "test-review", to: "implement", when: "continue_round" },
          { from: "test-review", to: "done", when: "loop_exit" },
        ],
      ),
      nodes: [
        { id: "oyakata-manager", nodeFile: "node-oyakata-manager.json", kind: "manager", completion: { type: "none" } },
        { id: "implement", nodeFile: "node-implement.json", kind: "task", completion: { type: "none" } },
        { id: "test-review", nodeFile: "node-test-review.json", kind: "loop-judge", completion: { type: "none" } },
        { id: "done", nodeFile: "node-done.json", kind: "output", completion: { type: "none" } },
      ],
      loops: [
        {
          id: "main-loop",
          judgeNodeId: "test-review",
          continueWhen: "continue_round",
          exitWhen: "loop_exit",
        },
      ],
    } satisfies WorkflowJson;

    const derived = deriveWorkflowVisualization({
      workflow,
      workflowVis: makeVis(["oyakata-manager", "implement", "test-review", "done"]),
    });

    expect(derived).toEqual([
      { id: "oyakata-manager", order: 0, indent: 0, color: "default" },
      { id: "implement", order: 1, indent: 1, color: "loop:main-loop" },
      { id: "test-review", order: 2, indent: 1, color: "loop:main-loop" },
      { id: "done", order: 3, indent: 0, color: "default" },
    ]);
  });

  test("derives sub-workflow group indent and color", () => {
    const workflow = makeBaseWorkflow(
      ["oyakata-manager", "group-input", "group-output", "done"],
      [
        { from: "oyakata-manager", to: "group-input", when: "always" },
        { from: "group-input", to: "group-output", when: "always" },
        { from: "group-output", to: "done", when: "always" },
      ],
    );
    const grouped = {
      ...workflow,
      nodes: [
        { id: "oyakata-manager", nodeFile: "node-oyakata-manager.json", kind: "manager", completion: { type: "none" } },
        { id: "group-input", nodeFile: "node-group-input.json", kind: "input", completion: { type: "none" } },
        { id: "group-output", nodeFile: "node-group-output.json", kind: "output", completion: { type: "none" } },
        { id: "done", nodeFile: "node-done.json", kind: "output", completion: { type: "none" } },
      ],
      subWorkflows: [
        {
          id: "main-group",
          description: "main",
          inputNodeId: "group-input",
          outputNodeId: "group-output",
          inputSources: [{ type: "human-input" }],
        },
      ],
    } satisfies WorkflowJson;

    const derived = deriveWorkflowVisualization({
      workflow: grouped,
      workflowVis: makeVis(["oyakata-manager", "group-input", "group-output", "done"]),
    });

    expect(derived).toEqual([
      { id: "oyakata-manager", order: 0, indent: 0, color: "default" },
      { id: "group-input", order: 1, indent: 1, color: "group:main-group" },
      { id: "group-output", order: 2, indent: 1, color: "group:main-group" },
      { id: "done", order: 3, indent: 0, color: "default" },
    ]);
  });

  test("nests loop scope inside a sub-workflow group", () => {
    const workflow = {
      ...makeBaseWorkflow(
        ["oyakata-manager", "group-input", "implement", "test-review", "group-output", "done"],
        [
          { from: "oyakata-manager", to: "group-input", when: "always" },
          { from: "group-input", to: "implement", when: "always" },
          { from: "implement", to: "test-review", when: "always" },
          { from: "test-review", to: "implement", when: "continue_round" },
          { from: "test-review", to: "group-output", when: "loop_exit" },
          { from: "group-output", to: "done", when: "always" },
        ],
      ),
      nodes: [
        { id: "oyakata-manager", nodeFile: "node-oyakata-manager.json", kind: "manager", completion: { type: "none" } },
        { id: "group-input", nodeFile: "node-group-input.json", kind: "input", completion: { type: "none" } },
        { id: "implement", nodeFile: "node-implement.json", kind: "task", completion: { type: "none" } },
        { id: "test-review", nodeFile: "node-test-review.json", kind: "loop-judge", completion: { type: "none" } },
        { id: "group-output", nodeFile: "node-group-output.json", kind: "output", completion: { type: "none" } },
        { id: "done", nodeFile: "node-done.json", kind: "output", completion: { type: "none" } },
      ],
      subWorkflows: [
        {
          id: "main-group",
          description: "main",
          inputNodeId: "group-input",
          outputNodeId: "group-output",
          inputSources: [{ type: "human-input" }],
        },
      ],
      loops: [
        {
          id: "main-loop",
          judgeNodeId: "test-review",
          continueWhen: "continue_round",
          exitWhen: "loop_exit",
        },
      ],
    } satisfies WorkflowJson;

    const derived = deriveWorkflowVisualization({
      workflow,
      workflowVis: makeVis(["oyakata-manager", "group-input", "implement", "test-review", "group-output", "done"]),
    });

    expect(derived).toEqual([
      { id: "oyakata-manager", order: 0, indent: 0, color: "default" },
      { id: "group-input", order: 1, indent: 1, color: "group:main-group" },
      { id: "implement", order: 2, indent: 2, color: "loop:main-loop" },
      { id: "test-review", order: 3, indent: 2, color: "loop:main-loop" },
      { id: "group-output", order: 4, indent: 1, color: "group:main-group" },
      { id: "done", order: 5, indent: 0, color: "default" },
    ]);
  });
});
