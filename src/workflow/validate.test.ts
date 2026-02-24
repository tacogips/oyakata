import { describe, expect, test } from "vitest";
import { validateWorkflowBundle } from "./validate";

function makeValidRaw(): {
  workflow: unknown;
  workflowVis: unknown;
  nodePayloads: Record<string, unknown>;
} {
  return {
    workflow: {
      workflowId: "demo",
      description: "demo",
      defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
      managerNodeId: "oyakata-manager",
      subWorkflows: [],
      nodes: [
        { id: "oyakata-manager", kind: "manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
        { id: "worker-1", kind: "task", nodeFile: "node-worker-1.json", completion: { type: "none" } },
      ],
      edges: [{ from: "oyakata-manager", to: "worker-1", when: "always" }],
      loops: [],
      branching: { mode: "fan-out" },
    },
    workflowVis: {
      nodes: [
        { id: "oyakata-manager", x: 10, y: 10, width: 100, height: 80 },
        { id: "worker-1", x: 200, y: 10, width: 100, height: 80 },
      ],
    },
    nodePayloads: {
      "node-oyakata-manager.json": {
        id: "oyakata-manager",
        model: "tacogips/codex-agent",
        promptTemplate: "manager",
        variables: {},
      },
      "node-worker-1.json": {
        id: "worker-1",
        model: "tacogips/claude-code-agent",
        promptTemplate: "worker",
        variables: {},
      },
    },
  };
}

describe("validateWorkflowBundle", () => {
  test("accepts canonical valid payload", () => {
    const result = validateWorkflowBundle(makeValidRaw());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.workflow.workflowId).toBe("demo");
    expect(result.value.workflow.nodes).toHaveLength(2);
  });

  test("normalizes legacy prompt and variable fields", () => {
    const raw = makeValidRaw();
    raw.nodePayloads["node-worker-1.json"] = {
      id: "worker-1",
      model: "tacogips/claude-code-agent",
      prompt: "legacy prompt",
      variable: { name: "legacy" },
    };

    const result = validateWorkflowBundle(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.nodePayloads["worker-1"]?.promptTemplate).toBe("legacy prompt");
    expect(result.value.nodePayloads["worker-1"]?.variables).toEqual({ name: "legacy" });
  });

  test("reports semantic errors for missing manager and bad node ids", () => {
    const raw = makeValidRaw();
    raw.workflow = {
      ...(raw.workflow as Record<string, unknown>),
      managerNodeId: "missing-manager",
      nodes: [{ id: "BadID", nodeFile: "node-BadID.json", kind: "manager", completion: { type: "none" } }],
      edges: [],
    };

    const result = validateWorkflowBundle(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const messages = result.error.map((entry) => `${entry.path}:${entry.message}`).join("\n");
    expect(messages).toContain("workflow.nodes[0].id:must match ^[a-z0-9][a-z0-9-]{1,63}$");
    expect(messages).toContain("workflow.managerNodeId:must reference an existing node id");
  });
});
