import { describe, expect, test, vi } from "vitest";
import type { EditorActions, RefreshedEditorState } from "./editor-actions";
import {
  loadEditorAppShellData,
  statusMessageForFrontend,
} from "./editor-app-controller";
import {
  emptySessionPanelState,
  emptyWorkflowEditorState,
} from "./editor-state";

function makeRefreshResult(): RefreshedEditorState {
  return {
    config: {
      fixedWorkflowName: null,
      readOnly: false,
      noExec: false,
      frontend: "solid-dist",
    },
    workflowPickerState: {
      workflows: ["alpha", "beta"],
      selectedWorkflowName: "beta",
    },
    workflowState: emptyWorkflowEditorState(),
    sessionPanelState: emptySessionPanelState(),
    selectedSessionPollStatus: null,
  };
}

describe("editor-app-controller", () => {
  test("returns Solid-only copy for the active frontend mode", () => {
    expect(statusMessageForFrontend("solid-dist")).toContain(
      "SolidJS frontend mode is active",
    );
    expect(statusMessageForFrontend("solid-dist")).toContain(
      "checked-in Solid entrypoint",
    );
  });

  test("loads shell data through the shared editor refresh action", async () => {
    const refresh = vi.fn(async () => makeRefreshResult());

    const result = await loadEditorAppShellData(
      { selectedWorkflowName: "alpha", preferredNodeId: "node-2" },
      { refresh } satisfies Pick<EditorActions, "refresh">,
    );

    expect(refresh).toHaveBeenCalledWith({
      selectedWorkflowName: "alpha",
      preferredNodeId: "node-2",
      selectedExecutionId: "",
    });
    expect(result.config.frontend).toBe("solid-dist");
    expect(result.workflows).toEqual(["alpha", "beta"]);
    expect(result.selectedWorkflowName).toBe("beta");
    expect(result.workflowState).toEqual(emptyWorkflowEditorState());
    expect(result.sessionPanelState).toEqual(emptySessionPanelState());
    expect(result.selectedSessionPollStatus).toBeNull();
    expect(result.statusMessage).toContain("SolidJS frontend mode is active");
    expect(result.statusMessage).toContain("checked-in Solid entrypoint");
  });
});
