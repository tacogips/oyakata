import type {
  ExecuteWorkflowRequest,
  SessionStatus,
} from "../../../src/shared/ui-contract";
import { toErrorMessage } from "./editor-support";
import {
  createEditorActions,
  type EditorActions,
  type SessionActionState,
} from "./editor-actions";
import type { EditorAppShellData } from "./editor-app-controller";
import type { SessionPanelState } from "./editor-state";

export interface EditorSessionUpdate {
  readonly sessionPanelState: SessionPanelState;
  readonly selectedSessionPollStatus: SessionStatus | null;
  readonly infoMessage?: string;
}

export type PollSelectedSessionResult =
  | { readonly kind: "updated"; readonly update: EditorSessionUpdate }
  | { readonly kind: "stale-selection" }
  | { readonly kind: "retry"; readonly errorMessage: string };

export interface RefreshEditorSessionsInput {
  readonly workflowName: string;
  readonly selectedExecutionId: string;
}

export interface SelectEditorSessionInput {
  readonly workflowName: string;
  readonly workflowExecutionId: string;
}

export interface ExecuteEditorWorkflowInput {
  readonly workflowName: string;
  readonly request: ExecuteWorkflowRequest;
}

export interface CancelSelectedEditorSessionInput {
  readonly workflowName: string;
  readonly workflowExecutionId: string;
}

export interface PollSelectedEditorSessionInput {
  readonly workflowName: string;
  readonly selectedExecutionId: string;
  readonly workflowExecutionId: string;
}

function sessionUpdateFromActionState(
  state: SessionActionState,
): EditorSessionUpdate {
  return {
    sessionPanelState: state.sessionPanelState,
    selectedSessionPollStatus: state.selectedSessionPollStatus,
    ...(state.infoMessage === undefined
      ? {}
      : { infoMessage: state.infoMessage }),
  };
}

export function applyEditorSessionUpdate(
  appData: EditorAppShellData,
  update: EditorSessionUpdate,
): EditorAppShellData {
  return {
    ...appData,
    sessionPanelState: update.sessionPanelState,
    selectedSessionPollStatus: update.selectedSessionPollStatus,
  };
}

export async function refreshEditorSessions(
  input: RefreshEditorSessionsInput,
  actions: Pick<EditorActions, "refreshSessions"> = createEditorActions(),
): Promise<EditorSessionUpdate> {
  return sessionUpdateFromActionState(
    await actions.refreshSessions({
      workflowName: input.workflowName,
      selectedExecutionId: input.selectedExecutionId,
    }),
  );
}

export async function selectEditorSession(
  input: SelectEditorSessionInput,
  actions: Pick<EditorActions, "selectSession"> = createEditorActions(),
): Promise<EditorSessionUpdate> {
  return sessionUpdateFromActionState(
    await actions.selectSession({
      workflowName: input.workflowName,
      workflowExecutionId: input.workflowExecutionId,
    }),
  );
}

export async function executeEditorWorkflow(
  input: ExecuteEditorWorkflowInput,
  actions: Pick<EditorActions, "executeWorkflow"> = createEditorActions(),
): Promise<EditorSessionUpdate> {
  return sessionUpdateFromActionState(
    await actions.executeWorkflow({
      workflowName: input.workflowName,
      request: input.request,
    }),
  );
}

export async function cancelSelectedEditorSession(
  input: CancelSelectedEditorSessionInput,
  actions: Pick<
    EditorActions,
    "cancelWorkflowExecution"
  > = createEditorActions(),
): Promise<EditorSessionUpdate> {
  return sessionUpdateFromActionState(
    await actions.cancelWorkflowExecution({
      workflowName: input.workflowName,
      workflowExecutionId: input.workflowExecutionId,
    }),
  );
}

export async function pollSelectedEditorSession(
  input: PollSelectedEditorSessionInput,
  actions: Pick<EditorActions, "selectSession"> = createEditorActions(),
): Promise<PollSelectedSessionResult> {
  if (
    input.workflowName.length === 0 ||
    input.selectedExecutionId !== input.workflowExecutionId
  ) {
    return { kind: "stale-selection" };
  }

  try {
    return {
      kind: "updated",
      update: sessionUpdateFromActionState(
        await actions.selectSession({
          workflowName: input.workflowName,
          workflowExecutionId: input.workflowExecutionId,
          allowPollingOnSelectedSession: true,
        }),
      ),
    };
  } catch (error: unknown) {
    return {
      kind: "retry",
      errorMessage: toErrorMessage(error),
    };
  }
}
