import { publishWorkflowBusinessFinalExternalOutput } from "../events/external-output";
import { persistExternalMailboxOutputCommunication } from "./engine-communications";
import {
  err,
  ok,
  workflowRunFailure,
  type WorkflowRunFailure,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./engine-types";
import { readOutputPayloadArtifact } from "./engine-output-candidate";
import {
  failTerminalSession,
  nowIso,
  persistCompletedSessionState,
} from "./engine-utils";
import { findLatestPublishedWorkflowResult } from "./engine-node-helpers";
import type { LoadedWorkflow } from "./load";
import type { Result } from "./result";
import type { CommunicationRecord, WorkflowSessionState } from "./session";
import type { WorkflowJson } from "./types";

interface CompleteWorkflowRunInput {
  readonly session: WorkflowSessionState;
  readonly options: WorkflowRunOptions;
  readonly loaded: Pick<LoadedWorkflow, "artifactWorkflowRoot">;
  readonly workflow: WorkflowJson;
  readonly stepAddressedExecution: boolean;
  readonly executionTargetNoun: string;
}

export async function completeWorkflowRun({
  session,
  options,
  loaded,
  workflow,
  stepAddressedExecution,
  executionTargetNoun,
}: CompleteWorkflowRunInput): Promise<
  Result<WorkflowRunResult, WorkflowRunFailure>
> {
  let completed: WorkflowSessionState = {
    ...session,
    status: "completed",
    endedAt: nowIso(),
    queue: [],
  };

  const publishedResultExecution = findLatestPublishedWorkflowResult(
    workflow,
    completed,
  );
  if (publishedResultExecution !== undefined) {
    const publishedTargetId =
      stepAddressedExecution && publishedResultExecution.stepId !== undefined
        ? publishedResultExecution.stepId
        : publishedResultExecution.nodeId;
    const outputPayload = await readOutputPayloadArtifact(
      publishedResultExecution.artifactDir,
    );
    if (!outputPayload.ok) {
      const publicationFailureMessage =
        `failed to publish selected external output for ${executionTargetNoun} '${publishedTargetId}' ` +
        `(${publishedResultExecution.nodeExecId}): ${outputPayload.error}`;
      return await failTerminalSession(
        completed,
        options,
        publicationFailureMessage,
      );
    }
    let externalOutputCommunication: CommunicationRecord;
    try {
      externalOutputCommunication =
        await persistExternalMailboxOutputCommunication({
          artifactWorkflowRoot: loaded.artifactWorkflowRoot,
          runtimeLogOptions: options,
          workflow,
          session: completed,
          execution: publishedResultExecution,
          outputRaw: outputPayload.value.raw,
          communicationCounter: completed.communicationCounter,
          createdAt: completed.endedAt ?? nowIso(),
        });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "unknown external output publication failure";
      return await failTerminalSession(
        completed,
        options,
        `failed to persist external output publication for ${executionTargetNoun} '${publishedTargetId}' (${publishedResultExecution.nodeExecId}): ${message}`,
      );
    }
    completed = {
      ...completed,
      communicationCounter: completed.communicationCounter + 1,
      communications: [
        ...completed.communications,
        externalOutputCommunication,
      ],
    };
    if (options.eventReplyDispatcher !== undefined) {
      try {
        await publishWorkflowBusinessFinalExternalOutput({
          dispatcher: options.eventReplyDispatcher,
          runtimeOptions: options,
          workflowId: workflow.workflowId,
          workflowExecutionId: completed.sessionId,
          runtimeVariables: completed.runtimeVariables,
          publishedNodeId: publishedTargetId,
          publishedNodeExecId: publishedResultExecution.nodeExecId,
          workflowOutputPayload: outputPayload.value.payload,
          createdAt: completed.endedAt ?? nowIso(),
        });
      } catch {
        // Best-effort: outbound provider delivery must not fail terminal completion.
      }
    }
  }

  const persistedCompleted = await persistCompletedSessionState(
    completed,
    options,
  );
  if (!persistedCompleted.ok) {
    return err(workflowRunFailure(1, persistedCompleted.error, completed));
  }
  return ok({ session: completed, exitCode: 0 });
}
