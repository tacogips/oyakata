import type {
  FrontendMode,
  SessionStatus,
  UiConfigResponse,
} from "../../../src/shared/ui-contract";
import type { SessionPanelState, WorkflowEditorState } from "./editor-state";
import { createEditorActions, type EditorActions } from "./editor-actions";

export interface EditorAppShellData {
  readonly config: UiConfigResponse;
  readonly workflows: readonly string[];
  readonly selectedWorkflowName: string;
  readonly workflowState: WorkflowEditorState;
  readonly sessionPanelState: SessionPanelState;
  readonly selectedSessionPollStatus: SessionStatus | null;
  readonly statusMessage: string;
}

export interface LoadEditorAppShellDataInput {
  readonly selectedWorkflowName: string;
  readonly selectedExecutionId?: string;
  readonly preferredNodeId?: string;
}

export function statusMessageForFrontend(_frontend: FrontendMode): string {
  return "The SolidJS frontend mode is active. The browser editor runs from the checked-in Solid entrypoint and the current ui/dist asset boundary.";
}

export async function loadEditorAppShellData(
  input: LoadEditorAppShellDataInput,
  actions: Pick<EditorActions, "refresh"> = createEditorActions(),
): Promise<EditorAppShellData> {
  const refreshed = await actions.refresh({
    selectedWorkflowName: input.selectedWorkflowName,
    preferredNodeId: input.preferredNodeId ?? "",
    selectedExecutionId: input.selectedExecutionId ?? "",
  });

  return {
    config: refreshed.config,
    workflows: refreshed.workflowPickerState.workflows,
    selectedWorkflowName: refreshed.workflowPickerState.selectedWorkflowName,
    workflowState: refreshed.workflowState,
    sessionPanelState: refreshed.sessionPanelState,
    selectedSessionPollStatus: refreshed.selectedSessionPollStatus,
    statusMessage: statusMessageForFrontend(refreshed.config.frontend),
  };
}
