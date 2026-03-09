import type {
  SessionStatus,
  UiConfigResponse,
  WorkflowExecutionStateResponse,
} from "../../../src/shared/ui-contract";
import {
  ApiError,
  createWorkflow,
  listSessions,
  listWorkflows,
  loadWorkflow,
  loadWorkflowExecution,
} from "./api-client";
import {
  emptySessionPanelState,
  emptyWorkflowEditorState,
  filterWorkflowSessions,
  reconcileSessionPanelState,
  upsertWorkflowSessionSummary,
  workflowEditorStateFromResponse,
  type SessionPanelState,
  type WorkflowEditorState,
} from "./editor-state";

export interface WorkflowPickerState {
  readonly workflows: readonly string[];
  readonly selectedWorkflowName: string;
}

export interface LoadedWorkflowEditorData {
  readonly workflowState: WorkflowEditorState;
  readonly sessionPanelState: SessionPanelState;
  readonly selectedSessionPollStatus: SessionStatus | null;
}

export interface LoadedWorkflowSessionPanelData {
  readonly sessionPanelState: SessionPanelState;
  readonly selectedSessionPollStatus: SessionStatus | null;
}

function withoutSelectedExecution(
  sessionPanelState: SessionPanelState,
  workflowExecutionId: string,
): SessionPanelState {
  return {
    sessions: sessionPanelState.sessions.filter(
      (session) => session.workflowExecutionId !== workflowExecutionId,
    ),
    selectedExecutionId: "",
    selectedSession: null,
  };
}

async function loadSelectedWorkflowExecutionState(
  workflowExecutionId: string,
): Promise<WorkflowExecutionStateResponse | null> {
  try {
    return await loadWorkflowExecution(workflowExecutionId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function sessionPanelStateFromSummaries(input: {
  readonly workflowName: string;
  readonly sessions: Parameters<typeof filterWorkflowSessions>[0];
  readonly selectedExecutionId: string;
  readonly selectedSession: WorkflowExecutionStateResponse | null;
}): SessionPanelState {
  const filteredSessions = filterWorkflowSessions(
    input.sessions,
    input.workflowName,
  );
  const nextSessions =
    input.selectedSession === null
      ? filteredSessions
      : upsertWorkflowSessionSummary(filteredSessions, input.selectedSession);
  return reconcileSessionPanelState(
    nextSessions,
    input.selectedExecutionId,
    input.selectedSession,
  );
}

async function refreshSessionPanelData(input: {
  readonly workflowName: string;
  readonly sessions: Parameters<typeof filterWorkflowSessions>[0];
  readonly selectedExecutionId: string;
  readonly allowPollingOnSelectedSession?: boolean;
}): Promise<LoadedWorkflowSessionPanelData> {
  const workflowSessions = filterWorkflowSessions(
    input.sessions,
    input.workflowName,
  );
  if (input.selectedExecutionId.length === 0) {
    return {
      sessionPanelState: reconcileSessionPanelState(workflowSessions, "", null),
      selectedSessionPollStatus: null,
    };
  }

  const loadedSession = await loadSelectedWorkflowExecutionState(
    input.selectedExecutionId,
  );
  if (
    loadedSession === null ||
    loadedSession.workflowName !== input.workflowName
  ) {
    return {
      sessionPanelState: withoutSelectedExecution(
        reconcileSessionPanelState(workflowSessions, "", null),
        input.selectedExecutionId,
      ),
      selectedSessionPollStatus: null,
    };
  }

  const sessionPanelState = sessionPanelStateFromSummaries({
    workflowName: input.workflowName,
    sessions: input.sessions,
    selectedExecutionId: loadedSession.workflowExecutionId,
    selectedSession: loadedSession,
  });

  return {
    sessionPanelState,
    selectedSessionPollStatus:
      input.allowPollingOnSelectedSession === false
        ? null
        : loadedSession.status,
  };
}

export function resolveSelectedWorkflowName(
  config: UiConfigResponse | null,
  workflows: readonly string[],
  currentSelectedWorkflowName: string,
): string {
  if (config?.fixedWorkflowName) {
    return config.fixedWorkflowName;
  }

  return workflows.includes(currentSelectedWorkflowName)
    ? currentSelectedWorkflowName
    : (workflows[0] ?? "");
}

export async function loadWorkflowPickerState(
  config: UiConfigResponse | null,
  currentSelectedWorkflowName: string,
): Promise<WorkflowPickerState> {
  const payload = await listWorkflows();
  return {
    workflows: [...payload.workflows],
    selectedWorkflowName: resolveSelectedWorkflowName(
      config,
      payload.workflows,
      currentSelectedWorkflowName,
    ),
  };
}

export async function loadWorkflowSessionPanelState(input: {
  readonly workflowName: string;
  readonly selectedExecutionId: string;
  readonly allowPollingOnSelectedSession?: boolean;
}): Promise<LoadedWorkflowSessionPanelData> {
  if (input.workflowName.length === 0) {
    return {
      sessionPanelState: emptySessionPanelState(),
      selectedSessionPollStatus: null,
    };
  }

  const payload = await listSessions();
  return refreshSessionPanelData({
    workflowName: input.workflowName,
    sessions: payload.sessions,
    selectedExecutionId: input.selectedExecutionId,
    ...(input.allowPollingOnSelectedSession !== undefined
      ? { allowPollingOnSelectedSession: input.allowPollingOnSelectedSession }
      : {}),
  });
}

export async function loadWorkflowEditorData(input: {
  readonly workflowName: string;
  readonly preferredNodeId: string;
  readonly selectedExecutionId: string;
  readonly allowPollingOnSelectedSession?: boolean;
}): Promise<LoadedWorkflowEditorData> {
  if (input.workflowName.length === 0) {
    return {
      workflowState: emptyWorkflowEditorState(),
      sessionPanelState: emptySessionPanelState(),
      selectedSessionPollStatus: null,
    };
  }

  const [workflow, sessionPayload] = await Promise.all([
    loadWorkflow(input.workflowName),
    listSessions(),
  ]);
  const workflowState = workflowEditorStateFromResponse(
    workflow,
    input.preferredNodeId,
  );
  const sessionPanelData = await refreshSessionPanelData({
    workflowName: input.workflowName,
    sessions: sessionPayload.sessions,
    selectedExecutionId: input.selectedExecutionId,
    ...(input.allowPollingOnSelectedSession !== undefined
      ? { allowPollingOnSelectedSession: input.allowPollingOnSelectedSession }
      : {}),
  });

  return {
    workflowState,
    sessionPanelState: sessionPanelData.sessionPanelState,
    selectedSessionPollStatus: sessionPanelData.selectedSessionPollStatus,
  };
}

export async function createWorkflowEditorData(input: {
  readonly workflowName: string;
  readonly preferredNodeId: string;
}): Promise<{
  readonly workflowName: string;
  readonly workflowState: WorkflowEditorState;
  readonly sessionPanelState: SessionPanelState;
}> {
  const created = await createWorkflow(input.workflowName);
  return {
    workflowName: created.workflowName,
    workflowState: workflowEditorStateFromResponse(
      created,
      input.preferredNodeId,
    ),
    sessionPanelState: emptySessionPanelState(),
  };
}
