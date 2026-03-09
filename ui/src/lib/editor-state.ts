import type {
  WorkflowExecutionStateResponse,
  WorkflowExecutionSummary,
  WorkflowResponse,
} from "../../../src/shared/ui-contract";
import type { DerivedVisNode } from "../../../src/workflow/visualization";
import {
  cloneEditableValue,
  type EditorNodePayload,
  type EditorWorkflowBundle,
  type EditorWorkflowNode,
} from "./editor-workflow";

export interface SelectedNodeState {
  readonly selectedNodeId: string;
  readonly selectedNode: EditorWorkflowNode | null;
  readonly selectedNodePayload: EditorNodePayload | null;
  readonly nodeVariablesText: string;
}

export interface WorkflowEditorState extends SelectedNodeState {
  readonly workflow: WorkflowResponse | null;
  readonly editableBundle: EditorWorkflowBundle | null;
  readonly editableDerivedVisualization: readonly DerivedVisNode[];
}

export interface SessionPanelState {
  readonly sessions: readonly WorkflowExecutionSummary[];
  readonly selectedExecutionId: string;
  readonly selectedSession: WorkflowExecutionStateResponse | null;
}

export function emptySelectedNodeState(): SelectedNodeState {
  return {
    selectedNodeId: "",
    selectedNode: null,
    selectedNodePayload: null,
    nodeVariablesText: "{}",
  };
}

export function emptyWorkflowEditorState(): WorkflowEditorState {
  return {
    workflow: null,
    editableBundle: null,
    editableDerivedVisualization: [],
    ...emptySelectedNodeState(),
  };
}

export function emptySessionPanelState(): SessionPanelState {
  return {
    sessions: [],
    selectedExecutionId: "",
    selectedSession: null,
  };
}

function ensureNodePayload(
  bundle: EditorWorkflowBundle,
  node: EditorWorkflowNode,
): EditorNodePayload {
  const existing =
    bundle.nodePayloads[node.id] ?? bundle.nodePayloads[node.nodeFile];
  if (existing) {
    if (bundle.nodePayloads[node.id] === undefined) {
      bundle.nodePayloads[node.id] = cloneEditableValue(existing);
    }
    return bundle.nodePayloads[node.id]!;
  }

  const created: EditorNodePayload = {
    id: node.id,
    model: "",
    promptTemplate: "",
    variables: {},
  };
  bundle.nodePayloads[node.id] = created;
  return created;
}

export function deriveSelectedNodeState(
  bundle: EditorWorkflowBundle | null | undefined,
  selectedNodeId: string,
): SelectedNodeState {
  if (!bundle || selectedNodeId.length === 0) {
    return emptySelectedNodeState();
  }

  const selectedNode =
    bundle.workflow.nodes.find((entry) => entry.id === selectedNodeId) ?? null;
  if (!selectedNode) {
    return emptySelectedNodeState();
  }

  const selectedNodePayload = ensureNodePayload(bundle, selectedNode);
  return {
    selectedNodeId,
    selectedNode,
    selectedNodePayload,
    nodeVariablesText: JSON.stringify(
      selectedNodePayload.variables ?? {},
      null,
      2,
    ),
  };
}

export function workflowEditorStateFromResponse(
  workflow: WorkflowResponse,
  preferredNodeId: string,
): WorkflowEditorState {
  const editableBundle = cloneEditableValue(workflow.bundle);
  const availableNodeIds = new Set(
    editableBundle.workflow.nodes.map((node) => node.id),
  );
  const selectedNodeId = availableNodeIds.has(preferredNodeId)
    ? preferredNodeId
    : (editableBundle.workflow.nodes[0]?.id ?? "");

  return {
    workflow,
    editableBundle,
    editableDerivedVisualization: [...workflow.derivedVisualization],
    ...deriveSelectedNodeState(editableBundle, selectedNodeId),
  };
}

export function filterWorkflowSessions(
  sessions: readonly WorkflowExecutionSummary[],
  workflowName: string,
): WorkflowExecutionSummary[] {
  return sessions
    .filter((entry) => entry.workflowName === workflowName)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function workflowExecutionSummaryFromState(
  session: WorkflowExecutionStateResponse,
): WorkflowExecutionSummary {
  return {
    workflowExecutionId: session.workflowExecutionId,
    sessionId: session.sessionId,
    workflowName: session.workflowName,
    status: session.status,
    currentNodeId: session.currentNodeId ?? null,
    nodeExecutionCounter: session.nodeExecutionCounter,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
  };
}

export function upsertWorkflowSessionSummary(
  sessions: readonly WorkflowExecutionSummary[],
  selectedSession: WorkflowExecutionStateResponse,
): WorkflowExecutionSummary[] {
  return [
    ...sessions.filter(
      (entry) =>
        entry.workflowExecutionId !== selectedSession.workflowExecutionId,
    ),
  ]
    .concat(workflowExecutionSummaryFromState(selectedSession))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function reconcileSessionPanelState(
  sessions: readonly WorkflowExecutionSummary[],
  selectedExecutionId: string,
  selectedSession: WorkflowExecutionStateResponse | null,
): SessionPanelState {
  const normalizedSelectedSession =
    selectedSession?.workflowExecutionId === selectedExecutionId
      ? selectedSession
      : null;

  if (selectedExecutionId.length === 0) {
    return {
      sessions: [...sessions],
      selectedExecutionId: "",
      selectedSession: null,
    };
  }

  if (
    sessions.some((entry) => entry.workflowExecutionId === selectedExecutionId)
  ) {
    return {
      sessions: [...sessions],
      selectedExecutionId,
      selectedSession: normalizedSelectedSession,
    };
  }

  return {
    sessions: [...sessions],
    selectedExecutionId: "",
    selectedSession: null,
  };
}
