import { describe, expect, test, vi } from "vitest";
import type { EditorAppShellData } from "./editor-app-controller";
import {
  applyEditorSessionUpdate,
  cancelSelectedEditorSession,
  executeEditorWorkflow,
  pollSelectedEditorSession,
  refreshEditorSessions,
  selectEditorSession,
} from "./editor-session-controller";
import {
  emptySessionPanelState,
  emptyWorkflowEditorState,
} from "./editor-state";

function makeAppData(): EditorAppShellData {
  return {
    config: {
      fixedWorkflowName: null,
      readOnly: false,
      noExec: false,
      frontend: "solid-dist",
    },
    workflows: ["alpha"],
    selectedWorkflowName: "alpha",
    workflowState: emptyWorkflowEditorState(),
    sessionPanelState: emptySessionPanelState(),
    selectedSessionPollStatus: null,
    statusMessage: "status",
  };
}

describe("editor-session-controller", () => {
  test("applies session updates without rebuilding unrelated shell state", () => {
    const appData = makeAppData();
    const updated = applyEditorSessionUpdate(appData, {
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-9",
        selectedSession: null,
      },
      selectedSessionPollStatus: "running",
      infoMessage: "ignored by shell patching",
    });

    expect(updated).toEqual({
      ...appData,
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-9",
        selectedSession: null,
      },
      selectedSessionPollStatus: "running",
    });
  });

  test("delegates refresh/select/execute/cancel flows through the shared action boundary", async () => {
    const refreshSessionsMock = vi.fn(async () => ({
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-refresh",
        selectedSession: null,
      },
      selectedSessionPollStatus: "running" as const,
      infoMessage: "refreshed",
    }));
    const selectSessionMock = vi.fn(async () => ({
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-select",
        selectedSession: null,
      },
      selectedSessionPollStatus: "completed" as const,
    }));
    const executeWorkflowMock = vi.fn(async () => ({
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-run",
        selectedSession: null,
      },
      selectedSessionPollStatus: "running" as const,
      infoMessage: "started",
    }));
    const cancelWorkflowExecutionMock = vi.fn(async () => ({
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-run",
        selectedSession: null,
      },
      selectedSessionPollStatus: "cancelled" as const,
      infoMessage: "cancelled",
    }));

    await expect(
      refreshEditorSessions(
        { workflowName: "alpha", selectedExecutionId: "exec-refresh" },
        { refreshSessions: refreshSessionsMock },
      ),
    ).resolves.toEqual({
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-refresh",
        selectedSession: null,
      },
      selectedSessionPollStatus: "running",
      infoMessage: "refreshed",
    });

    await expect(
      selectEditorSession(
        { workflowName: "alpha", workflowExecutionId: "exec-select" },
        { selectSession: selectSessionMock },
      ),
    ).resolves.toEqual({
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-select",
        selectedSession: null,
      },
      selectedSessionPollStatus: "completed",
    });

    await expect(
      executeEditorWorkflow(
        {
          workflowName: "alpha",
          request: { async: true, runtimeVariables: { topic: "demo" } },
        },
        { executeWorkflow: executeWorkflowMock },
      ),
    ).resolves.toEqual({
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-run",
        selectedSession: null,
      },
      selectedSessionPollStatus: "running",
      infoMessage: "started",
    });

    await expect(
      cancelSelectedEditorSession(
        { workflowName: "alpha", workflowExecutionId: "exec-run" },
        { cancelWorkflowExecution: cancelWorkflowExecutionMock },
      ),
    ).resolves.toEqual({
      sessionPanelState: {
        sessions: [],
        selectedExecutionId: "exec-run",
        selectedSession: null,
      },
      selectedSessionPollStatus: "cancelled",
      infoMessage: "cancelled",
    });
  });

  test("treats stale polling requests as a no-op", async () => {
    const selectSessionMock = vi.fn();

    await expect(
      pollSelectedEditorSession(
        {
          workflowName: "alpha",
          selectedExecutionId: "exec-current",
          workflowExecutionId: "exec-other",
        },
        { selectSession: selectSessionMock },
      ),
    ).resolves.toEqual({ kind: "stale-selection" });
    expect(selectSessionMock).not.toHaveBeenCalled();
  });

  test("returns retry instructions for transient polling failures", async () => {
    const selectSessionMock = vi.fn(async () => {
      throw new Error("network failed");
    });

    await expect(
      pollSelectedEditorSession(
        {
          workflowName: "alpha",
          selectedExecutionId: "exec-7",
          workflowExecutionId: "exec-7",
        },
        { selectSession: selectSessionMock },
      ),
    ).resolves.toEqual({
      kind: "retry",
      errorMessage: "network failed",
    });
    expect(selectSessionMock).toHaveBeenCalledWith({
      workflowName: "alpha",
      workflowExecutionId: "exec-7",
      allowPollingOnSelectedSession: true,
    });
  });
});
