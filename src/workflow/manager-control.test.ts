import { describe, expect, test } from "vitest";
import { parseManagerControlPayload } from "./manager-control";
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
        managerNodeId: "a-manager",
        inputNodeId: "a-input",
        outputNodeId: "a-output",
        nodeIds: ["a-manager", "a-input", "a-output"],
        inputSources: [],
      },
    ],
    nodes: [
      { id: "oyakata-manager", nodeFile: "node-oyakata-manager.json", kind: "root-manager", completion: { type: "none" } },
      { id: "a-manager", nodeFile: "node-a-manager.json", kind: "sub-manager", completion: { type: "none" } },
      { id: "a-input", nodeFile: "node-a-input.json", kind: "input", completion: { type: "none" } },
      { id: "a-output", nodeFile: "node-a-output.json", kind: "output", completion: { type: "none" } },
      { id: "step-1", nodeFile: "node-step-1.json", kind: "task", completion: { type: "none" } },
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
        managerNodeId: "oyakata-manager",
        managerKind: "root-manager",
      }),
    ).toBeNull();
  });

  test("parses supported manager control actions", () => {
    const parsed = parseManagerControlPayload(
      {
        managerControl: {
          actions: [
            { type: "start-sub-workflow", subWorkflowId: "sw-a" },
          ],
        },
      },
      makeWorkflow(),
      {
        managerNodeId: "oyakata-manager",
        managerKind: "root-manager",
      },
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.startSubWorkflowIds).toEqual(["sw-a"]);
    expect(parsed?.childInputNodeIds).toEqual([]);
    expect(parsed?.retryNodeIds).toEqual([]);
    expect(parsed?.overridesRootSubWorkflowPlanning).toBe(true);
    expect(parsed?.overridesChildInputPlanning).toBe(true);
  });

  test("parses supported sub-manager child-input and retry actions", () => {
    const parsed = parseManagerControlPayload(
      {
        managerControl: {
          actions: [
            { type: "deliver-to-child-input", inputNodeId: "a-input" },
            { type: "retry-node", nodeId: "a-input" },
          ],
        },
      },
      makeWorkflow(),
      {
        managerNodeId: "a-manager",
        managerKind: "sub-manager",
      },
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.startSubWorkflowIds).toEqual([]);
    expect(parsed?.childInputNodeIds).toEqual(["a-input"]);
    expect(parsed?.retryNodeIds).toEqual(["a-input"]);
    expect(parsed?.overridesRootSubWorkflowPlanning).toBe(true);
    expect(parsed?.overridesChildInputPlanning).toBe(true);
  });

  test("rejects start-sub-workflow outside the root-manager scope", () => {
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
          managerKind: "sub-manager",
        },
      ),
    ).toThrow("only allowed for the root manager");
  });

  test("rejects unknown referenced ids", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "retry-node", nodeId: "missing" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "sub-manager",
        },
      ),
    ).toThrow("does not exist");
  });

  test("rejects child-input dispatch outside the sub-manager owned scope", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "deliver-to-child-input", inputNodeId: "a-input" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "oyakata-manager",
          managerKind: "root-manager",
        },
      ),
    ).toThrow("only allowed for a sub-manager");

    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "deliver-to-child-input", inputNodeId: "oyakata-manager" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "sub-manager",
        },
      ),
    ).toThrow("must exist with kind 'input'");

    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "deliver-to-child-input", inputNodeId: "a-output" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "sub-manager",
        },
      ),
    ).toThrow("must exist with kind 'input'");
  });

  test("rejects sub-manager retries outside the owned sub-workflow scope", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "retry-node", nodeId: "oyakata-manager" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "sub-manager",
        },
      ),
    ).toThrow("must belong to sub-workflow 'sw-a'");
  });

  test("rejects root-manager retries that pierce into a sub-workflow internals", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "retry-node", nodeId: "a-input" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "oyakata-manager",
          managerKind: "root-manager",
        },
      ),
    ).toThrow("must re-invoke that sub-workflow with start-sub-workflow instead");
  });

  test("rejects manager self-retry", () => {
    expect(() =>
      parseManagerControlPayload(
        {
          managerControl: {
            actions: [{ type: "retry-node", nodeId: "a-manager" }],
          },
        },
        makeWorkflow(),
        {
          managerNodeId: "a-manager",
          managerKind: "sub-manager",
        },
      ),
    ).toThrow("cannot target the manager node itself");
  });
});
