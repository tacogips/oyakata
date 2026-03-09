import type { ValidationIssue } from "../../../src/workflow/types";
import { syncNodeVariablesTextValue } from "./editor-field-updates";
import {
  deriveSelectedNodeState,
  type WorkflowEditorState,
} from "./editor-state";
import {
  deriveEditableVisualization,
  syncSubWorkflowNodeKinds,
} from "./editor-workflow-operations";

export interface ValidationState {
  readonly validationIssues: readonly ValidationIssue[];
  readonly validationSummary: string;
}

export function emptyValidationState(): ValidationState {
  return {
    validationIssues: [],
    validationSummary: "",
  };
}

export function workflowStateAfterMutation(
  workflowState: WorkflowEditorState,
  options?: {
    readonly syncSelectedNode?: boolean;
  },
): WorkflowEditorState {
  if (workflowState.editableBundle === null) {
    return workflowState;
  }

  syncSubWorkflowNodeKinds(workflowState.editableBundle);

  const nextWorkflowState: WorkflowEditorState = {
    ...workflowState,
    editableDerivedVisualization: deriveEditableVisualization(
      workflowState.editableBundle,
    ),
  };

  if (options?.syncSelectedNode !== true) {
    return nextWorkflowState;
  }

  return {
    ...nextWorkflowState,
    ...deriveSelectedNodeState(
      workflowState.editableBundle,
      workflowState.selectedNodeId,
    ),
  };
}

export function workflowStateWithSelectedNode(
  workflowState: WorkflowEditorState,
  selectedNodeId: string,
): WorkflowEditorState {
  return {
    ...workflowState,
    ...deriveSelectedNodeState(workflowState.editableBundle, selectedNodeId),
  };
}

export function workflowStateWithNodeVariablesText(
  workflowState: WorkflowEditorState,
  nodeVariablesText: string,
): WorkflowEditorState {
  return {
    ...workflowState,
    nodeVariablesText,
  };
}

export function syncSelectedNodeVariablesOrThrow(
  workflowState: WorkflowEditorState,
): WorkflowEditorState {
  const result = syncNodeVariablesTextValue(
    workflowState.selectedNodePayload,
    workflowState.nodeVariablesText,
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return workflowStateAfterMutation(workflowState);
}
