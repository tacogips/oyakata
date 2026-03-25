import { describe, expect, test, vi } from "vitest";
import type { LoadedWorkflow } from "../workflow/load";
import type { NodePayload } from "../workflow/types";
import {
  OPEN_TUI_MAIN_PANE_LAYOUT,
  OPEN_TUI_SELECTOR_PANE_LAYOUT,
  buildWorkflowRunStatusContent,
  buildTuiRuntimeVariables,
  describeTuiWorkflowInputSyntax,
  deriveEditorTextFromRuntimeVariables,
  detectWorkflowInputMode,
  filterWorkflowNames,
  focusOpenTuiTarget,
  formatJsonEditorText,
  isOpenTuiHelpKey,
  isOpenTuiRefreshKey,
  resolveBlurredSelectRedrawTarget,
  resolveHistoryPaneNavigationMode,
  resolveOpenTuiPaneChrome,
  resolveWorkflowPreviewIndent,
  resolveSelectedWorkflowName,
} from "./opentui-screen";

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

describe("filterWorkflowNames", () => {
  test("returns all workflows when the filter is empty", () => {
    expect(filterWorkflowNames(["alpha", "beta"], "")).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("matches workflow names by case-insensitive substring", () => {
    expect(
      filterWorkflowNames(["Alpha", "beta", "release-flow"], "LEA"),
    ).toEqual(["release-flow"]);
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
        editorText: '{"request":"retry"}',
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
    expect(formatJsonEditorText('{"a":1,"b":[2]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    );
  });
});

describe("describeTuiWorkflowInputSyntax", () => {
  test("treats text mode as non-json input", () => {
    expect(describeTuiWorkflowInputSyntax("hello", "text")).toEqual({
      status: "not-applicable",
      summary: "plain text",
    });
  });

  test("accepts an empty json editor buffer as an empty object", () => {
    expect(describeTuiWorkflowInputSyntax("   ", "json")).toEqual({
      status: "valid-empty",
      summary: "empty buffer -> {}",
    });
  });

  test("reports valid json input", () => {
    expect(
      describeTuiWorkflowInputSyntax('{"request":"hello"}', "json"),
    ).toEqual({
      status: "valid",
      summary: "valid JSON",
    });
  });

  test("reports invalid json input with location context when available", () => {
    const syntax = describeTuiWorkflowInputSyntax('{"request":}', "json");
    expect(syntax.status).toBe("invalid");
    expect(syntax.summary).toContain("invalid JSON");
  });
});

describe("isOpenTuiRefreshKey", () => {
  test("matches shifted r without control/meta modifiers", () => {
    expect(
      isOpenTuiRefreshKey({
        name: "r",
        shift: true,
        ctrl: false,
        meta: false,
      }),
    ).toBe(true);
  });

  test("rejects plain r and modified variants", () => {
    expect(
      isOpenTuiRefreshKey({
        name: "r",
        shift: false,
        ctrl: false,
        meta: false,
      }),
    ).toBe(false);
    expect(
      isOpenTuiRefreshKey({
        name: "r",
        shift: true,
        ctrl: true,
        meta: false,
      }),
    ).toBe(false);
    expect(
      isOpenTuiRefreshKey({
        name: "r",
        shift: true,
        ctrl: false,
        meta: true,
      }),
    ).toBe(false);
  });
});

describe("isOpenTuiHelpKey", () => {
  test("matches question-mark help key variants", () => {
    expect(
      isOpenTuiHelpKey({
        name: "?",
        shift: false,
        ctrl: false,
        meta: false,
      }),
    ).toBe(true);
    expect(
      isOpenTuiHelpKey({
        name: "/",
        shift: true,
        ctrl: false,
        meta: false,
      }),
    ).toBe(true);
  });

  test("rejects modified or plain slash keys", () => {
    expect(
      isOpenTuiHelpKey({
        name: "/",
        shift: false,
        ctrl: false,
        meta: false,
      }),
    ).toBe(false);
    expect(
      isOpenTuiHelpKey({
        name: "?",
        shift: false,
        ctrl: true,
        meta: false,
      }),
    ).toBe(false);
  });
});

describe("OpenTui pane layout", () => {
  test("uses explicit selector pane widths that sum to the full row", () => {
    expect(OPEN_TUI_SELECTOR_PANE_LAYOUT.workflows.width).toBe("30%");
    expect(OPEN_TUI_SELECTOR_PANE_LAYOUT.timeline.width).toBe("35%");
    expect(OPEN_TUI_SELECTOR_PANE_LAYOUT.details.width).toBe("35%");
    expect(OPEN_TUI_SELECTOR_PANE_LAYOUT.workflows.minWidth).toBeGreaterThan(2);
  });

  test("uses explicit main pane widths with non-collapsing minima for navigation panes", () => {
    expect(OPEN_TUI_MAIN_PANE_LAYOUT.workflows.width).toBe("20%");
    expect(OPEN_TUI_MAIN_PANE_LAYOUT.sessions.width).toBe("28%");
    expect(OPEN_TUI_MAIN_PANE_LAYOUT.nodes.width).toBe("22%");
    expect(OPEN_TUI_MAIN_PANE_LAYOUT.details.width).toBe("30%");
    expect(OPEN_TUI_MAIN_PANE_LAYOUT.workflows.minWidth).toBeGreaterThan(2);
    expect(OPEN_TUI_MAIN_PANE_LAYOUT.sessions.minWidth).toBeGreaterThan(2);
    expect(OPEN_TUI_MAIN_PANE_LAYOUT.nodes.minWidth).toBeGreaterThan(2);
  });
});

describe("resolveBlurredSelectRedrawTarget", () => {
  test("returns the selected row content when the logical selection is visible", () => {
    expect(
      resolveBlurredSelectRedrawTarget({
        fontHeight: 1,
        linesPerItem: 3,
        maxVisibleItems: 4,
        selectedOption: {
          name: "selected row",
          description: "detail text",
        },
        scrollOffset: 2,
        showDescription: true,
        selectedIndex: 3,
      }),
    ).toEqual({
      descriptionY: 4,
      name: "  selected row",
      nameY: 3,
    });
  });

  test("returns undefined when the logical selection is outside the visible window", () => {
    expect(
      resolveBlurredSelectRedrawTarget({
        fontHeight: 1,
        linesPerItem: 2,
        maxVisibleItems: 3,
        selectedOption: {
          name: "hidden row",
          description: "",
        },
        scrollOffset: 4,
        showDescription: false,
        selectedIndex: 2,
      }),
    ).toBeUndefined();
  });
});

describe("resolveHistoryPaneNavigationMode", () => {
  test("treats detail summary as list navigation", () => {
    expect(
      resolveHistoryPaneNavigationMode({
        detailMode: "summary",
        focusPane: "detail",
      }),
    ).toBe("list");
  });

  test("treats non-summary detail views as scroll navigation", () => {
    expect(
      resolveHistoryPaneNavigationMode({
        detailMode: "inbox",
        focusPane: "detail",
      }),
    ).toBe("scroll");
  });

  test("treats the input pane as typing, not pane navigation", () => {
    expect(
      resolveHistoryPaneNavigationMode({
        detailMode: "summary",
        focusPane: "input",
      }),
    ).toBe("typing");
  });
});

describe("resolveOpenTuiPaneChrome", () => {
  test("marks node detail as active after history focus moves from nodes to detail", () => {
    const chrome = resolveOpenTuiPaneChrome({
      focusPane: "detail",
      hasRuntimeSession: true,
      inputMode: "json",
      inputSyntaxStatus: "valid",
      screenMode: "history",
    });

    expect(chrome.detail.title).toBe(" >> node detail << ");
    expect(chrome.detail.borderColor).toBe("#4fd1ff");
    expect(chrome.node.title).toBe(" Nodes ");
    expect(chrome.node.borderColor).toBe("#5b6670");
  });

  test("uses the select-a-run node title until a session is loaded", () => {
    const chrome = resolveOpenTuiPaneChrome({
      focusPane: "sessions",
      hasRuntimeSession: false,
      inputMode: "text",
      inputSyntaxStatus: "not-applicable",
      screenMode: "history",
    });

    expect(chrome.node.title).toBe(" Nodes (select a run) ");
  });
});

describe("focusOpenTuiTarget", () => {
  test("invokes the renderable focus lifecycle for keyboard-driven pane changes", () => {
    const target = {
      focus: vi.fn(),
    };

    focusOpenTuiTarget(target);

    expect(target.focus).toHaveBeenCalledTimes(1);
  });
});

describe("resolveWorkflowPreviewIndent", () => {
  test("keeps the root manager at indent zero", () => {
    expect(
      resolveWorkflowPreviewIndent({
        derivedIndent: 3,
        inSubworkflowScope: true,
        kind: "root-manager",
      }),
    ).toBe(0);
  });

  test("adds one indent level for nodes inside a subworkflow scope", () => {
    expect(
      resolveWorkflowPreviewIndent({
        derivedIndent: 1,
        inSubworkflowScope: true,
        kind: "subworkflow-manager",
      }),
    ).toBe(2);
  });

  test("keeps root-level non-subworkflow nodes at their derived indent", () => {
    expect(
      resolveWorkflowPreviewIndent({
        derivedIndent: 0,
        inSubworkflowScope: false,
        kind: "task",
      }),
    ).toBe(0);
  });
});

describe("buildWorkflowRunStatusContent", () => {
  test("shows a pre-launch hint before any session exists", () => {
    const loaded = makeLoadedWorkflow({
      id: "workflow-input",
      model: "input-model",
      promptTemplate: "Read free text",
      variables: {},
    });

    expect(
      buildWorkflowRunStatusContent({
        loadedWorkflow: loaded,
        runtimeSessionView: undefined,
      }),
    ).toContain("No run started yet.");
  });

  test("shows running state and final workflow output when available", () => {
    const loaded = makeLoadedWorkflow({
      id: "workflow-input",
      model: "input-model",
      promptTemplate: "Read free text",
      variables: {},
    });

    expect(
      buildWorkflowRunStatusContent({
        loadedWorkflow: loaded,
        runtimeSessionView: {
          session: {
            sessionId: "sess-demo",
            workflowName: "demo",
            workflowId: "demo",
            status: "completed",
            startedAt: "2026-03-24T00:00:00.000Z",
            endedAt: "2026-03-24T00:01:00.000Z",
            queue: [],
            currentNodeId: "workflow-output",
            nodeExecutionCounter: 1,
            nodeExecutionCounts: { "workflow-output": 1 },
            transitions: [],
            nodeExecutions: [
              {
                nodeId: "workflow-output",
                nodeExecId: "exec-1",
                status: "succeeded",
                artifactDir: "/tmp/demo",
                startedAt: "2026-03-24T00:00:10.000Z",
                endedAt: "2026-03-24T00:00:20.000Z",
              },
            ],
            communicationCounter: 0,
            communications: [],
            runtimeVariables: {
              workflowOutput: { summary: "done" },
            },
          },
          nodeExecutions: [
            {
              sessionId: "sess-demo",
              nodeExecId: "exec-1",
              nodeId: "workflow-output",
              status: "succeeded",
              artifactDir: "/tmp/demo",
              startedAt: "2026-03-24T00:00:10.000Z",
              endedAt: "2026-03-24T00:00:20.000Z",
              attempt: null,
              outputAttemptCount: null,
              outputValidationErrors: null,
              backendSessionMode: null,
              backendSessionId: null,
              restartedFromNodeExecId: null,
              inputHash: "in",
              outputHash: "out",
              inputJson: "{}",
              outputJson: '{"summary":"done"}',
              createdAt: "2026-03-24T00:00:20.000Z",
            },
          ],
          nodeLogs: [
            {
              id: 1,
              sessionId: "sess-demo",
              nodeExecId: "exec-1",
              nodeId: "workflow-output",
              level: "info",
              message: "completed",
              payloadJson: null,
              at: "2026-03-24T00:00:20.000Z",
            },
          ],
        },
      }),
    ).toContain("Final result:");
  });
});
