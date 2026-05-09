import type { WorkflowJson } from "./types";
import type { WorkflowSessionState } from "./session";
import {
  err,
  ok,
  type Result,
  type UpstreamOutputRef,
  type UpstreamInput,
} from "./engine-types";
import { buildMergedContinuationTimeline } from "./history-continuation";
import { readOutputPayloadArtifact } from "./engine-output-candidate";

function buildUpstreamOutputRefs(
  session: WorkflowSessionState,
  nodeId: string,
): readonly UpstreamOutputRef[] {
  const matchingCommunications = session.communications.filter(
    (communication) =>
      communication.status === "delivered" && communication.toNodeId === nodeId,
  );
  if (matchingCommunications.length === 0) {
    return [];
  }

  return matchingCommunications
    .map((communication) => {
      const execution = session.nodeExecutions.find(
        (candidate) => candidate.nodeExecId === communication.sourceNodeExecId,
      );
      return {
        fromNodeId: communication.fromNodeId,
        transitionWhen: communication.transitionWhen,
        status: execution?.status ?? communication.status,
        communicationId: communication.communicationId,
        ...communication.payloadRef,
      };
    })
    .filter((entry): entry is UpstreamOutputRef => entry !== undefined);
}

function buildMergedUpstreamOutputRefs(
  session: WorkflowSessionState,
  nodeId: string,
  continuationSnapshots: ReadonlyMap<string, WorkflowSessionState> | undefined,
): Result<readonly UpstreamOutputRef[], string> {
  const localRefs = buildUpstreamOutputRefs(session, nodeId);
  if (
    continuationSnapshots === undefined ||
    session.historyImports === undefined ||
    session.historyImports.length === 0
  ) {
    return ok(localRefs);
  }

  const timelineResult = buildMergedContinuationTimeline(
    continuationSnapshots,
    session.sessionId,
  );
  if (!timelineResult.ok) {
    return err(
      `merged continuation timeline resolution failed: ${timelineResult.error.message}`,
    );
  }
  const timeline = timelineResult.value;
  const importedExecKeys = new Set(
    timeline
      .filter(
        (entry) => entry.persistedWorkflowExecutionId !== session.sessionId,
      )
      .map(
        (entry) => `${entry.persistedWorkflowExecutionId}:${entry.stepRunId}`,
      ),
  );
  const positionByOwnerExec = new Map<string, number>();
  timeline.forEach((entry, index) => {
    positionByOwnerExec.set(
      `${entry.persistedWorkflowExecutionId}:${entry.stepRunId}`,
      index,
    );
  });

  const importedRefs: UpstreamOutputRef[] = [];
  for (const snapshot of continuationSnapshots.values()) {
    if (snapshot.sessionId === session.sessionId) {
      continue;
    }
    for (const communication of snapshot.communications) {
      if (
        communication.status !== "delivered" ||
        communication.toNodeId !== nodeId ||
        !importedExecKeys.has(
          `${snapshot.sessionId}:${communication.sourceNodeExecId}`,
        )
      ) {
        continue;
      }
      const payloadRef = communication.payloadRef;
      if (payloadRef.kind === "manager-message") {
        continue;
      }
      const execution = snapshot.nodeExecutions.find(
        (candidate) => candidate.nodeExecId === communication.sourceNodeExecId,
      );
      importedRefs.push({
        fromNodeId: communication.fromNodeId,
        transitionWhen: communication.transitionWhen,
        status: execution?.status ?? communication.status,
        communicationId: communication.communicationId,
        ...payloadRef,
      });
    }
  }

  importedRefs.sort((left, right) => {
    const leftPos =
      positionByOwnerExec.get(
        `${left.workflowExecutionId}:${left.nodeExecId}`,
      ) ?? -1;
    const rightPos =
      positionByOwnerExec.get(
        `${right.workflowExecutionId}:${right.nodeExecId}`,
      ) ?? -1;
    if (leftPos !== rightPos) {
      return leftPos - rightPos;
    }
    return left.communicationId.localeCompare(right.communicationId);
  });

  return ok([...importedRefs, ...localRefs]);
}

export async function buildUpstreamInputs(
  workflow: WorkflowJson,
  session: WorkflowSessionState,
  nodeId: string,
  continuationSnapshots: ReadonlyMap<string, WorkflowSessionState> | undefined,
): Promise<Result<readonly UpstreamInput[], string>> {
  const upstreamTargetNoun = workflow.steps !== undefined ? "step" : "node";
  const refsResult = buildMergedUpstreamOutputRefs(
    session,
    nodeId,
    continuationSnapshots,
  );
  if (!refsResult.ok) {
    return err(refsResult.error);
  }
  const refs = refsResult.value;
  if (refs.length === 0) {
    return ok([]);
  }

  const loaded: UpstreamInput[] = [];
  for (const ref of refs) {
    const output = await readOutputPayloadArtifact(ref.artifactDir);
    if (!output.ok) {
      return err(
        `failed to resolve upstream communication '${ref.communicationId}' for ${upstreamTargetNoun} '${nodeId}': ${output.error}`,
      );
    }
    loaded.push({
      ...ref,
      output: output.value.payload,
      outputRaw: output.value.raw,
    });
  }

  return ok(loaded);
}
