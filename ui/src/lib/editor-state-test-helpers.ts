import type { WorkflowResponse } from "../../../src/shared/ui-contract";
import {
  workflowEditorStateFromResponse,
  type WorkflowEditorState,
} from "./editor-state";

export function workflowStateFromResponse(
  workflow: WorkflowResponse,
  preferredNodeId: string,
): WorkflowEditorState {
  return workflowEditorStateFromResponse(workflow, preferredNodeId);
}
