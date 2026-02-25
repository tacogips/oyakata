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

  test("accepts typed subWorkflows and subWorkflowConversations", () => {
    const raw = makeValidRaw();
    raw.workflow = {
      ...(raw.workflow as Record<string, unknown>),
      nodes: [
        { id: "oyakata-manager", kind: "manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
        { id: "sw1-input", kind: "input", nodeFile: "node-sw1-input.json", completion: { type: "none" } },
        { id: "sw1-output", kind: "output", nodeFile: "node-sw1-output.json", completion: { type: "none" } },
        { id: "sw2-input", kind: "input", nodeFile: "node-sw2-input.json", completion: { type: "none" } },
        { id: "sw2-output", kind: "output", nodeFile: "node-sw2-output.json", completion: { type: "none" } },
      ],
      edges: [
        { from: "oyakata-manager", to: "sw1-input", when: "always" },
        { from: "sw1-output", to: "sw2-input", when: "always" },
      ],
      subWorkflows: [
        {
          id: "sw1",
          description: "first",
          inputNodeId: "sw1-input",
          outputNodeId: "sw1-output",
          inputSources: [{ type: "human-input" }],
        },
        {
          id: "sw2",
          description: "second",
          inputNodeId: "sw2-input",
          outputNodeId: "sw2-output",
          inputSources: [{ type: "sub-workflow-output", subWorkflowId: "sw1" }],
        },
      ],
      subWorkflowConversations: [
        {
          id: "conv-1",
          participants: ["sw1", "sw2"],
          maxTurns: 4,
          stopWhen: "done",
        },
      ],
    };
    raw.workflowVis = {
      nodes: [
        { id: "oyakata-manager", x: 10, y: 10, width: 100, height: 80 },
        { id: "sw1-input", x: 120, y: 10, width: 100, height: 80 },
        { id: "sw1-output", x: 230, y: 10, width: 100, height: 80 },
        { id: "sw2-input", x: 340, y: 10, width: 100, height: 80 },
        { id: "sw2-output", x: 450, y: 10, width: 100, height: 80 },
      ],
    };
    raw.nodePayloads = {
      "node-oyakata-manager.json": {
        id: "oyakata-manager",
        model: "tacogips/codex-agent",
        promptTemplate: "manager",
        variables: {},
      },
      "node-sw1-input.json": {
        id: "sw1-input",
        model: "tacogips/codex-agent",
        promptTemplate: "in1",
        variables: {},
      },
      "node-sw1-output.json": {
        id: "sw1-output",
        model: "tacogips/codex-agent",
        promptTemplate: "out1",
        variables: {},
      },
      "node-sw2-input.json": {
        id: "sw2-input",
        model: "tacogips/codex-agent",
        promptTemplate: "in2",
        variables: {},
      },
      "node-sw2-output.json": {
        id: "sw2-output",
        model: "tacogips/codex-agent",
        promptTemplate: "out2",
        variables: {},
      },
    };

    const result = validateWorkflowBundle(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.workflow.subWorkflows).toHaveLength(2);
    expect(result.value.workflow.subWorkflowConversations?.[0]?.id).toBe("conv-1");
  });

  test("rejects unsupported inert sub-workflow conversation policy and selection policy", () => {
    const raw = makeValidRaw();
    raw.workflow = {
      ...(raw.workflow as Record<string, unknown>),
      subWorkflows: [
        {
          id: "sw1",
          description: "first",
          inputNodeId: "oyakata-manager",
          outputNodeId: "worker-1",
          inputSources: [
            {
              type: "human-input",
              selectionPolicy: { mode: "latest-any" },
            },
          ],
        },
      ],
      subWorkflowConversations: [
        {
          id: "conv-1",
          participants: ["sw1", "sw1"],
          maxTurns: 1,
          stopWhen: "done",
          conversationPolicy: { turnPolicy: "round-robin" },
        },
      ],
    };

    const result = validateWorkflowBundle(raw);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const messages = result.error.map((entry) => `${entry.path}:${entry.message}`).join("\n");
    expect(messages).toContain("workflow.subWorkflows[0].inputSources[0].selectionPolicy:is currently unsupported");
    expect(messages).toContain(
      "workflow.subWorkflowConversations[0].conversationPolicy:is currently unsupported",
    );
  });

  test("normalizes legacy sub-workflow aliases inputs and participantsIds", () => {
    const raw = makeValidRaw();
    raw.workflow = {
      ...(raw.workflow as Record<string, unknown>),
      nodes: [
        { id: "oyakata-manager", kind: "manager", nodeFile: "node-oyakata-manager.json", completion: { type: "none" } },
        { id: "sw1-input", kind: "input", nodeFile: "node-sw1-input.json", completion: { type: "none" } },
        { id: "sw1-output", kind: "output", nodeFile: "node-sw1-output.json", completion: { type: "none" } },
        { id: "sw2-input", kind: "input", nodeFile: "node-sw2-input.json", completion: { type: "none" } },
        { id: "sw2-output", kind: "output", nodeFile: "node-sw2-output.json", completion: { type: "none" } },
      ],
      edges: [],
      subWorkflows: [
        {
          id: "sw1",
          description: "first",
          inputNodeId: "sw1-input",
          outputNodeId: "sw1-output",
          inputs: [{ type: "human-input" }],
        },
        {
          id: "sw2",
          description: "second",
          inputNodeId: "sw2-input",
          outputNodeId: "sw2-output",
          inputSources: [{ type: "sub-workflow-output", subWorkflowId: "sw1" }],
        },
      ],
      subWorkflowConversations: [
        {
          id: "conv-legacy",
          participantsIds: ["sw1", "sw2"],
          maxTurns: 2,
          stopWhen: "done",
        },
      ],
    };
    raw.workflowVis = {
      nodes: [
        { id: "oyakata-manager", x: 10, y: 10, width: 100, height: 80 },
        { id: "sw1-input", x: 120, y: 10, width: 100, height: 80 },
        { id: "sw1-output", x: 230, y: 10, width: 100, height: 80 },
        { id: "sw2-input", x: 340, y: 10, width: 100, height: 80 },
        { id: "sw2-output", x: 450, y: 10, width: 100, height: 80 },
      ],
    };
    raw.nodePayloads = {
      "node-oyakata-manager.json": {
        id: "oyakata-manager",
        model: "tacogips/codex-agent",
        promptTemplate: "manager",
        variables: {},
      },
      "node-sw1-input.json": {
        id: "sw1-input",
        model: "tacogips/codex-agent",
        promptTemplate: "in1",
        variables: {},
      },
      "node-sw1-output.json": {
        id: "sw1-output",
        model: "tacogips/codex-agent",
        promptTemplate: "out1",
        variables: {},
      },
      "node-sw2-input.json": {
        id: "sw2-input",
        model: "tacogips/codex-agent",
        promptTemplate: "in2",
        variables: {},
      },
      "node-sw2-output.json": {
        id: "sw2-output",
        model: "tacogips/codex-agent",
        promptTemplate: "out2",
        variables: {},
      },
    };

    const result = validateWorkflowBundle(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.workflow.subWorkflows[0]?.inputSources[0]?.type).toBe("human-input");
    expect(result.value.workflow.subWorkflowConversations?.[0]?.participants).toEqual(["sw1", "sw2"]);
  });
});
