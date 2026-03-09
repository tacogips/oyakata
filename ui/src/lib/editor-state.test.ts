import { describe, expect, test } from "vitest";
import type {
  WorkflowExecutionStateResponse,
  WorkflowExecutionSummary,
} from "../../../src/shared/ui-contract";
import {
  reconcileSessionPanelState,
  upsertWorkflowSessionSummary,
  workflowExecutionSummaryFromState,
} from "./editor-state";

function makeSessionSummary(
  overrides: Partial<WorkflowExecutionSummary> = {},
): WorkflowExecutionSummary {
  return {
    workflowExecutionId: "sess-1",
    sessionId: "sess-1",
    workflowName: "demo",
    status: "running",
    currentNodeId: "worker-1",
    nodeExecutionCounter: 1,
    startedAt: "2026-03-09T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function makeSessionState(
  overrides: Partial<WorkflowExecutionStateResponse> = {},
): WorkflowExecutionStateResponse {
  return {
    workflowExecutionId: "sess-1",
    sessionId: "sess-1",
    workflowName: "demo",
    workflowId: "wf-demo",
    status: "running",
    startedAt: "2026-03-09T00:00:00.000Z",
    queue: [],
    nodeExecutionCounter: 1,
    nodeExecutionCounts: {},
    transitions: [],
    nodeExecutions: [],
    communicationCounter: 0,
    communications: [],
    runtimeVariables: {},
    ...overrides,
  };
}

describe("reconcileSessionPanelState", () => {
  test("clears selected session details when no execution is selected", () => {
    const state = reconcileSessionPanelState(
      [makeSessionSummary()],
      "",
      makeSessionState(),
    );

    expect(state.selectedExecutionId).toBe("");
    expect(state.selectedSession).toBeNull();
  });

  test("clears mismatched selected session details while preserving the selected execution id", () => {
    const state = reconcileSessionPanelState(
      [
        makeSessionSummary({
          workflowExecutionId: "sess-2",
          sessionId: "sess-2",
        }),
      ],
      "sess-2",
      makeSessionState(),
    );

    expect(state.selectedExecutionId).toBe("sess-2");
    expect(state.selectedSession).toBeNull();
  });

  test("preserves matching selected session details", () => {
    const selectedSession = makeSessionState({
      workflowExecutionId: "sess-2",
      sessionId: "sess-2",
      status: "paused",
    });

    const state = reconcileSessionPanelState(
      [
        makeSessionSummary({
          workflowExecutionId: "sess-2",
          sessionId: "sess-2",
          status: "paused",
        }),
      ],
      "sess-2",
      selectedSession,
    );

    expect(state.selectedExecutionId).toBe("sess-2");
    expect(state.selectedSession).toBe(selectedSession);
  });
});

describe("workflowExecutionSummaryFromState", () => {
  test("maps execution detail state into summary shape", () => {
    expect(
      workflowExecutionSummaryFromState(
        makeSessionState({
          status: "completed",
          currentNodeId: "worker-2",
          endedAt: "2026-03-09T00:05:00.000Z",
        }),
      ),
    ).toEqual({
      workflowExecutionId: "sess-1",
      sessionId: "sess-1",
      workflowName: "demo",
      status: "completed",
      currentNodeId: "worker-2",
      nodeExecutionCounter: 1,
      startedAt: "2026-03-09T00:00:00.000Z",
      endedAt: "2026-03-09T00:05:00.000Z",
    });
  });
});

describe("upsertWorkflowSessionSummary", () => {
  test("adds the selected execution when the summary list does not have it yet", () => {
    const sessions = upsertWorkflowSessionSummary(
      [
        makeSessionSummary({
          workflowExecutionId: "sess-0",
          sessionId: "sess-0",
          startedAt: "2026-03-08T00:00:00.000Z",
        }),
      ],
      makeSessionState({
        workflowExecutionId: "sess-2",
        sessionId: "sess-2",
        startedAt: "2026-03-09T01:00:00.000Z",
      }),
    );

    expect(sessions.map((session) => session.workflowExecutionId)).toEqual([
      "sess-2",
      "sess-0",
    ]);
  });

  test("replaces a stale summary entry with the fresher selected execution detail", () => {
    const sessions = upsertWorkflowSessionSummary(
      [makeSessionSummary({ status: "running", endedAt: null })],
      makeSessionState({
        status: "cancelled",
        endedAt: "2026-03-09T00:03:00.000Z",
      }),
    );

    expect(sessions).toEqual([
      makeSessionSummary({
        status: "cancelled",
        currentNodeId: null,
        endedAt: "2026-03-09T00:03:00.000Z",
      }),
    ]);
  });
});
