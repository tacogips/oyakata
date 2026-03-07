import { describe, expect, test } from "vitest";
import { composeExecutionPrompt } from "./prompt-composition";
import type { NodePayload, WorkflowJson, WorkflowNodeRef } from "./types";

function makeWorkflow(): WorkflowJson {
  return {
    workflowId: "wf",
    description: "Ship a release safely.",
    defaults: { maxLoopIterations: 3, nodeTimeoutMs: 120000 },
    prompts: {
      oyakataPromptTemplate: "Plan {{topic}} carefully.",
      workerSystemPromptTemplate: "Execute {{topic}} precisely.",
    },
    managerNodeId: "oyakata-manager",
    subWorkflows: [
      {
        id: "main",
        description: "Main delivery path",
        managerNodeId: "main-oyakata",
        inputNodeId: "workflow-input",
        outputNodeId: "workflow-output",
        nodeIds: ["main-oyakata", "workflow-input", "implement", "workflow-output"],
        inputSources: [{ type: "human-input" }],
      },
    ],
    nodes: [
      { id: "oyakata-manager", nodeFile: "node-oyakata-manager.json", kind: "root-manager", completion: { type: "none" } },
      { id: "main-oyakata", nodeFile: "node-main-oyakata.json", kind: "sub-manager", completion: { type: "none" } },
      { id: "workflow-input", nodeFile: "node-workflow-input.json", kind: "input", completion: { type: "none" } },
      { id: "implement", nodeFile: "node-implement.json", kind: "task", completion: { type: "none" } },
      { id: "workflow-output", nodeFile: "node-workflow-output.json", kind: "output", completion: { type: "none" } },
    ],
    edges: [{ from: "workflow-input", to: "implement", when: "always" }],
    loops: [],
    branching: { mode: "fan-out" },
  };
}

function makeNode(overrides: Partial<NodePayload> = {}): NodePayload {
  return {
    id: "implement",
    model: "tacogips/codex-agent",
    promptTemplate: "Implement the release step.",
    variables: {},
    ...overrides,
  };
}

function makeNodePayloads(): Readonly<Record<string, NodePayload>> {
  return {
    "oyakata-manager": {
      id: "oyakata-manager",
      model: "tacogips/codex-agent",
      promptTemplate: "Plan the overall workflow.",
      variables: {},
    },
    "main-oyakata": {
      id: "main-oyakata",
      model: "tacogips/codex-agent",
      promptTemplate: "Translate the parent instruction into child workflow work.",
      variables: {},
    },
    "workflow-input": {
      id: "workflow-input",
      model: "tacogips/codex-agent",
      promptTemplate: "Normalize the received instruction into workflow input.",
      variables: {},
    },
    implement: makeNode(),
    "workflow-output": {
      id: "workflow-output",
      model: "tacogips/codex-agent",
      promptTemplate: "Assemble the final workflow output.",
      variables: {},
      output: {
        description: "Return the completed release package summary.",
      },
    },
  };
}

function makeNodeRef(overrides: Partial<WorkflowNodeRef> = {}): WorkflowNodeRef {
  return {
    id: "implement",
    nodeFile: "node-implement.json",
    kind: "task",
    completion: { type: "none" },
    ...overrides,
  };
}

describe("composeExecutionPrompt", () => {
  test("includes explicit given data for the execution", () => {
    const prompt = composeExecutionPrompt({
      workflow: makeWorkflow(),
      nodeRef: makeNodeRef(),
      node: makeNode(),
      nodePayloads: makeNodePayloads(),
      runtimeVariables: { topic: "release" },
      basePromptText: "Implement the release step.",
      assembledArguments: {
        task: {
          repository: "oyakata",
          target: "release",
        },
      },
      upstreamInputs: [],
    });

    expect(prompt).toContain("Given data:");
    expect(prompt).toContain('"repository":"oyakata"');
    expect(prompt).toContain('"target":"release"');
  });

  test("exposes top-level human input to the root manager without custom argument bindings", () => {
    const prompt = composeExecutionPrompt({
      workflow: makeWorkflow(),
      nodeRef: makeNodeRef({
        id: "oyakata-manager",
        nodeFile: "node-oyakata-manager.json",
        kind: "root-manager",
      }),
      node: makeNodePayloads()["oyakata-manager"] as NodePayload,
      nodePayloads: makeNodePayloads(),
      runtimeVariables: {
        topic: "release",
        humanInput: {
          request: "ship version 1.2.3",
          constraints: ["run tests", "update changelog"],
        },
      },
      basePromptText: "Plan the overall workflow.",
      assembledArguments: null,
      upstreamInputs: [],
    });

    expect(prompt).toContain("Given data:");
    expect(prompt).toContain("humanInput=");
    expect(prompt).toContain('"request":"ship version 1.2.3"');
    expect(prompt).toContain('"constraints":["run tests","update changelog"]');
  });

  test("recognizes sub-workflow scope for internal nodes declared in nodeIds", () => {
    const prompt = composeExecutionPrompt({
      workflow: makeWorkflow(),
      nodeRef: makeNodeRef(),
      node: makeNode(),
      nodePayloads: makeNodePayloads(),
      runtimeVariables: { topic: "release" },
      basePromptText: "Implement the release step.",
      assembledArguments: null,
      upstreamInputs: [],
    });

    expect(prompt).toContain("Current sub-workflow scope:");
    expect(prompt).toContain("- Sub-workflow: main");
    expect(prompt).toContain("- Owned nodes: main-oyakata, workflow-input, implement, workflow-output");
  });

  test("includes managed child catalog for the root manager", () => {
    const prompt = composeExecutionPrompt({
      workflow: makeWorkflow(),
      nodeRef: makeNodeRef({
        id: "oyakata-manager",
        nodeFile: "node-oyakata-manager.json",
        kind: "root-manager",
      }),
      node: makeNodePayloads()["oyakata-manager"] as NodePayload,
      nodePayloads: makeNodePayloads(),
      runtimeVariables: { topic: "release" },
      basePromptText: "Plan the overall workflow.",
      assembledArguments: null,
      upstreamInputs: [],
    });

    expect(prompt).toContain("Managed children in current scope:");
    expect(prompt).toContain("- Child sub-workflow: main");
    expect(prompt).toContain("handoff=Parent manager output is delivered by mailbox");
    expect(prompt).toContain("expectedReturn=Return the completed release package summary.");
    expect(prompt).not.toContain("- Child node: main-oyakata (sub-manager)");
    expect(prompt).not.toContain("- Child node: workflow-input (input)");
    expect(prompt).not.toContain("- Child node: workflow-output (output)");
  });

  test("includes managed child node catalog for a sub-manager", () => {
    const prompt = composeExecutionPrompt({
      workflow: makeWorkflow(),
      nodeRef: makeNodeRef({
        id: "main-oyakata",
        nodeFile: "node-main-oyakata.json",
        kind: "sub-manager",
      }),
      node: makeNodePayloads()["main-oyakata"] as NodePayload,
      nodePayloads: makeNodePayloads(),
      runtimeVariables: { topic: "release" },
      basePromptText: "Translate the parent instruction into child workflow work.",
      assembledArguments: null,
      upstreamInputs: [],
    });

    expect(prompt).toContain("Managed children in current scope:");
    expect(prompt).toContain("- Child node: workflow-input (input)");
    expect(prompt).toContain("- Child node: implement (task)");
    expect(prompt).toContain("promptSeed=Normalize the received instruction into workflow input.");
    expect(prompt).toContain("promptSeed=Implement the release step.");
  });

  test("renders workflow metadata inside worker system prompts", () => {
    const workflow = makeWorkflow();
    const prompt = composeExecutionPrompt({
      workflow: {
        ...workflow,
        prompts: {
          ...workflow.prompts,
          workerSystemPromptTemplate:
            "Execute workflow={{workflowId}} purpose={{workflowDescription}} node={{nodeId}} kind={{nodeKind}}.",
        },
      },
      nodeRef: makeNodeRef({
        id: "workflow-input",
        nodeFile: "node-workflow-input.json",
        kind: "input",
      }),
      node: makeNodePayloads()["workflow-input"] as NodePayload,
      nodePayloads: makeNodePayloads(),
      runtimeVariables: {},
      basePromptText: "Normalize the received instruction into workflow input.",
      assembledArguments: null,
      upstreamInputs: [],
    });

    expect(prompt).toContain("Execute workflow=wf purpose=Ship a release safely. node=workflow-input kind=input.");
  });

  test("does not allow runtime or node variables to override workflow metadata in prompt templates", () => {
    const workflow = makeWorkflow();
    const prompt = composeExecutionPrompt({
      workflow: {
        ...workflow,
        prompts: {
          ...workflow.prompts,
          workerSystemPromptTemplate:
            "Execute workflow={{workflowId}} purpose={{workflowDescription}} node={{nodeId}} kind={{nodeKind}}.",
        },
      },
      nodeRef: makeNodeRef({
        id: "workflow-input",
        nodeFile: "node-workflow-input.json",
        kind: "input",
      }),
      node: {
        ...(makeNodePayloads()["workflow-input"] as NodePayload),
        variables: {
          workflowId: "spoofed-node-workflow",
          workflowDescription: "spoofed-node-description",
          nodeId: "spoofed-node-id",
          nodeKind: "spoofed-node-kind",
        },
      },
      nodePayloads: makeNodePayloads(),
      runtimeVariables: {
        workflowId: "spoofed-runtime-workflow",
        workflowDescription: "spoofed-runtime-description",
        nodeId: "spoofed-runtime-node",
        nodeKind: "spoofed-runtime-kind",
      },
      basePromptText: "Normalize the received instruction into workflow input.",
      assembledArguments: null,
      upstreamInputs: [],
    });

    expect(prompt).toContain("Execute workflow=wf purpose=Ship a release safely. node=workflow-input kind=input.");
    expect(prompt).not.toContain("spoofed-node");
    expect(prompt).not.toContain("spoofed-runtime");
  });
});
