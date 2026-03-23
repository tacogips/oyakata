import { describe, expect, test } from "vitest";
import type { LoadedWorkflow } from "../workflow/load";
import type { NodePayload } from "../workflow/types";
import {
  buildTuiRuntimeVariables,
  deriveEditorTextFromRuntimeVariables,
  detectWorkflowInputMode,
  formatJsonEditorText,
  resolveSelectedWorkflowName,
} from "./neo-blessed-screen";

function makeLoadedWorkflow(inputNodePayload: NodePayload): LoadedWorkflow {
  return {
    workflowName: "demo",
    workflowDirectory: "/tmp/demo",
    artifactWorkflowRoot: "/tmp/artifacts/demo",
    bundle: {
      workflow: {
        workflowId: "demo",
        description: "demo workflow",
        defaults: {
          maxLoopIterations: 3,
          nodeTimeoutMs: 120_000,
        },
        managerNodeId: "divedra-manager",
        subWorkflows: [
          {
            id: "delivery",
            description: "delivery",
            managerNodeId: "divedra-manager",
            inputNodeId: "workflow-input",
            outputNodeId: "workflow-output",
            nodeIds: ["workflow-input", "workflow-output"],
            inputSources: [{ type: "human-input" }],
            block: { type: "plain" },
          },
        ],
        nodes: [
          {
            id: "divedra-manager",
            kind: "root-manager",
            nodeFile: "node-divedra-manager.json",
            completion: { type: "none" },
          },
          {
            id: "workflow-input",
            kind: "input",
            nodeFile: "node-workflow-input.json",
            completion: { type: "none" },
          },
          {
            id: "workflow-output",
            kind: "output",
            nodeFile: "node-workflow-output.json",
            completion: { type: "none" },
          },
        ],
        edges: [],
        loops: [],
        branching: { mode: "fan-out" },
      },
      workflowVis: {
        nodes: [
          { id: "divedra-manager", order: 0 },
          { id: "workflow-input", order: 1 },
          { id: "workflow-output", order: 2 },
        ],
      },
      nodePayloads: {
        "node-divedra-manager.json": {
          id: "divedra-manager",
          model: "manager-model",
          promptTemplate: "Manage the workflow",
          variables: {},
        },
        "node-workflow-input.json": inputNodePayload,
        "node-workflow-output.json": {
          id: "workflow-output",
          model: "output-model",
          promptTemplate: "Return output",
          variables: {},
        },
      },
    },
  };
}

describe("resolveSelectedWorkflowName", () => {
  test("returns selected workflow when index is in range", () => {
    expect(resolveSelectedWorkflowName(1, ["a", "b", "c"])).toBe("b");
  });

  test("returns undefined when index is out of range", () => {
    expect(resolveSelectedWorkflowName(-1, ["a"])).toBeUndefined();
    expect(resolveSelectedWorkflowName(3, ["a", "b"])).toBeUndefined();
  });
});

describe("detectWorkflowInputMode", () => {
  test("detects json mode when the input node binds structured human-input fields", () => {
    const loaded = makeLoadedWorkflow({
      id: "workflow-input",
      model: "input-model",
      promptTemplate: "Normalize the structured request",
      variables: {},
      argumentsTemplate: {
        request: {},
      },
      argumentBindings: [
        {
          targetPath: "request.title",
          source: "human-input",
          sourcePath: "title",
        },
      ],
    });

    expect(detectWorkflowInputMode(loaded)).toEqual({
      mode: "json",
      reason:
        "detected structured human-input bindings or JSON-oriented input prompts",
    });
  });

  test("defaults to text mode when the workflow definition gives no structured-input hint", () => {
    const loaded = makeLoadedWorkflow({
      id: "workflow-input",
      model: "input-model",
      promptTemplate: "Read the latest human input and summarize it.",
      variables: {},
    });

    expect(detectWorkflowInputMode(loaded).mode).toBe("text");
  });
});

describe("buildTuiRuntimeVariables", () => {
  test("builds text-oriented runtime variables for workflow execution", () => {
    expect(
      buildTuiRuntimeVariables({
        editorText: "ship the patch",
        mode: "text",
        purpose: "run",
      }),
    ).toEqual({
      humanInput: "ship the patch",
      prompt: "ship the patch",
      userPrompt: "ship the patch",
    });
  });

  test("builds json-oriented runtime variables for rerun execution", () => {
    expect(
      buildTuiRuntimeVariables({
        editorText: "{\"request\":\"retry\"}",
        managerSessionId: "mgrsess-exec-000001",
        mode: "json",
        purpose: "rerun",
      }),
    ).toEqual({
      humanInput: { request: "retry" },
      promptJson: { request: "retry" },
      userPromptJson: { request: "retry" },
      rerunPrompt: { request: "retry" },
      rerunManagerSessionId: "mgrsess-exec-000001",
    });
  });
});

describe("deriveEditorTextFromRuntimeVariables", () => {
  test("returns raw text for text-mode values", () => {
    expect(
      deriveEditorTextFromRuntimeVariables(
        { humanInput: { text: "hello" } },
        "text",
      ),
    ).toBe("hello");
  });

  test("returns formatted json for structured values", () => {
    expect(
      deriveEditorTextFromRuntimeVariables(
        { humanInput: { request: "hello" } },
        "json",
      ),
    ).toBe('{\n  "request": "hello"\n}');
  });

  test("prefers promptJson when reopening json-oriented runtime state", () => {
    expect(
      deriveEditorTextFromRuntimeVariables(
        {
          humanInput: "fallback text",
          promptJson: { request: "hello" },
        },
        "json",
      ),
    ).toBe('{\n  "request": "hello"\n}');
  });
});

describe("formatJsonEditorText", () => {
  test("formats valid json and normalizes whitespace", () => {
    expect(formatJsonEditorText("{\"a\":1,\"b\":[2]}")).toBe(
      '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    );
  });
});
